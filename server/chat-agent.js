import { routeIntent } from "./router.js";

const HISTORY_LIMIT = 14;
const MAX_TOOL_LOOPS = 4;

export class ChatAgent {
  constructor({ openai = {}, deps }) {
    this.openai = openai;
    this.deps = deps;
    this.history = new Map();
  }

  async handle({ message = "", userId = "default" } = {}) {
    const text = String(message || "").trim();
    const speakerKey = String(userId || "default");
    const nowState = () => this.deps.state.snapshot.now;

    if (!text) {
      return { reply: "Type a request, a song name, or a control like 'next track'.", now: nowState(), actions: [] };
    }

    const history = this.getHistory(speakerKey);
    history.push({ role: "user", content: text });

    let result;
    if (this.hasLlm()) {
      try {
        result = await this.handleWithTools(text, history);
      } catch (error) {
        console.warn(`[chat-agent] tool flow failed, falling back: ${error?.message || error}`);
        result = await this.fallbackHandle(text);
      }
    } else {
      result = await this.fallbackHandle(text);
    }

    history.push({ role: "assistant", content: result.reply || "" });
    this.trimHistory(speakerKey);
    return result;
  }

  hasLlm() {
    return Boolean(this.openai?.baseUrl && this.openai?.apiKey && this.openai?.model);
  }

  getHistory(userId) {
    if (!this.history.has(userId)) this.history.set(userId, []);
    return this.history.get(userId);
  }

  trimHistory(userId) {
    const list = this.history.get(userId);
    if (list && list.length > HISTORY_LIMIT) this.history.set(userId, list.slice(-HISTORY_LIMIT));
  }

  resetUser(userId) {
    if (userId) this.history.delete(userId);
  }

  resetAll() {
    this.history.clear();
  }

  async fallbackHandle(text) {
    const route = routeIntent(text, "user");
    if (route.type === "control") {
      if (route.action === "next") {
        const now = await this.deps.nextTrack();
        return { reply: "Skipping to the next track.", now, actions: [{ name: "next_track", result: { ok: true } }] };
      }
      if (route.action === "previous") {
        const now = await this.deps.previousTrack();
        return { reply: "Back to the previous track.", now, actions: [{ name: "prev_track", result: { ok: true } }] };
      }
      if (route.action === "pause") {
        const now = await this.deps.pausePlayback();
        return { reply: "Paused.", now, actions: [{ name: "pause", result: { ok: true } }] };
      }
      const now = await this.deps.resumePlayback();
      return { reply: "Playing.", now, actions: [{ name: "resume", result: { ok: true } }] };
    }
    const now = await this.deps.runShow({ input: text, trigger: "user", route });
    return { reply: "Rebuilt the show around your request.", now, actions: [{ name: "replace_show", result: { ok: true } }] };
  }

  async handleWithTools(userText, history) {
    const systemMessage = {
      role: "system",
      content: buildSystemPrompt(this.deps.state.snapshot.now)
    };
    const messages = [systemMessage, ...history.slice(-HISTORY_LIMIT)];
    const tools = this.buildTools();
    const actions = [];
    let lastReplyText = "";

    for (let step = 0; step < MAX_TOOL_LOOPS; step += 1) {
      const message = await this.callLlm(messages, tools);
      if (!message) break;
      messages.push(message);

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!toolCalls.length) {
        lastReplyText = String(message.content || "").trim();
        break;
      }

      for (const call of toolCalls) {
        const name = call.function?.name;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await this.dispatchTool(name, args);
        actions.push({ name, args, result });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 1600)
        });
      }
    }

    return {
      reply: lastReplyText || summariseActions(actions, userText),
      now: this.deps.state.snapshot.now,
      actions
    };
  }

  buildTools() {
    return [
      {
        type: "function",
        function: {
          name: "search_and_play_next",
          description: "Search NetEase Cloud Music for the song / artist / album the user named, and INSERT the top matches at the FRONT of the play queue — so they play as the NEXT track(s) after the current song finishes. Use this whenever the user explicitly names something they want to hear. This does NOT interrupt the current track, does NOT replace the queue, and does NOT push the result to the end of the queue.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Artist, song or album name to search for." },
              limit: { type: "integer", description: "How many top results to enqueue. Default 1, max 5.", minimum: 1, maximum: 5 }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "replace_show",
          description: "Rebuild the entire queue and DJ script around a vibe / mood / context (e.g. 'switch to late-night jazz', 'play something for deep work'). ONLY use this when the user asks for a different show, not for a specific song.",
          parameters: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "The mood, vibe, or context that should drive the new show." }
            },
            required: ["prompt"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "next_track",
          description: "Skip to the next track in the queue.",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "prev_track",
          description: "Go back to the previous track in this session.",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "pause",
          description: "Pause playback.",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "resume",
          description: "Resume playback if paused.",
          parameters: { type: "object", properties: {} }
        }
      }
    ];
  }

  async dispatchTool(name, args = {}) {
    try {
      switch (name) {
        case "search_and_play_next": {
          const outcome = await this.deps.searchAndEnqueueNext(args.query || "", { limit: Math.min(5, Number(args.limit) || 1) });
          return {
            ok: outcome.added > 0,
            added: outcome.added,
            skipped: outcome.skipped,
            tracks: (outcome.tracks || []).map((track) => ({ id: track.id, title: track.title, artist: track.artist })),
            note: outcome.added === 0
              ? "no new matches were enqueued — search returned nothing, or every match was already in the queue / history"
              : "tracks inserted at the FRONT of the queue; they will play as the next track(s) after the current one finishes"
          };
        }
        case "replace_show": {
          const now = await this.deps.runShow({ input: args.prompt || "", trigger: "user" });
          return {
            ok: true,
            currentTrack: now.track ? { title: now.track.title, artist: now.track.artist } : null,
            queueLength: (now.queue || []).length
          };
        }
        case "next_track": {
          const now = await this.deps.nextTrack();
          return { ok: true, currentTrack: now.track ? { title: now.track.title, artist: now.track.artist } : null };
        }
        case "prev_track": {
          const now = await this.deps.previousTrack();
          return { ok: true, currentTrack: now.track ? { title: now.track.title, artist: now.track.artist } : null };
        }
        case "pause": {
          const now = await this.deps.pausePlayback();
          return { ok: true, status: now.status };
        }
        case "resume": {
          const now = await this.deps.resumePlayback();
          return { ok: true, status: now.status };
        }
        default:
          return { ok: false, error: `unknown tool: ${name}` };
      }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async callLlm(messages, tools) {
    const url = chatCompletionsUrl(this.openai);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.openai.apiKey}`
      },
      body: JSON.stringify({
        model: this.openai.model,
        messages,
        temperature: 0.5,
        tools,
        tool_choice: "auto"
      })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`LLM tool call failed: ${response.status} ${body.slice(0, 300)}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message || null;
  }
}

function chatCompletionsUrl(openai) {
  const baseUrl = String(openai.baseUrl || "").replace(/\/$/, "");
  if (/\/chat\/completions$/.test(baseUrl)) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

function buildSystemPrompt(now = {}) {
  const current = now.track ? `${now.track.title} — ${now.track.artist}` : "nothing yet";
  return [
    "You are Sonora, a personal AI radio host replying in a tiny terminal chat console.",
    "Reply in the user's language. Keep replies short (1-2 sentences), warm but precise. No emoji, no markdown.",
    "Behavioral rules:",
    "- When the user NAMES a specific song / artist / album they want to hear, ALWAYS call search_and_play_next. NEVER use replace_show for that.",
    "- search_and_play_next inserts at the FRONT of the queue, so the requested song plays as the NEXT track after the current one finishes. It does NOT interrupt playback. Make that clear in your reply (e.g. '当前这首播完就播《X》').",
    "- Use replace_show only when the user wants a different vibe / mood / context for the whole show (e.g. 'switch to late-night jazz', 'change the mood').",
    "- For pause / resume / next / previous track, call the matching control tool, then confirm in one short line.",
    "- For chit-chat, questions about the current song, or anything that does not require changing playback, do NOT call any tool — just reply in text.",
    "- After tool calls succeed, summarise the result in plain language ('已加入下一首：X — Y', 'Switching to the next track').",
    "- If a tool returns ok=false or added=0, tell the user honestly and suggest what they could try next.",
    `Current track: ${current}. Queue length: ${(now.queue || []).length}.`
  ].join("\n");
}

function summariseActions(actions, userText) {
  if (!actions.length) return userText ? "" : "";
  const last = actions[actions.length - 1];
  if (last.name === "search_and_play_next") {
    if (last.result?.added) {
      const names = (last.result.tracks || []).map((t) => `${t.title} — ${t.artist}`).join("; ");
      return `已加入下一首：${names}（当前歌曲播完后立即播放）。`;
    }
    return "No new matches were enqueued. Try a different keyword?";
  }
  if (last.name === "replace_show") return "Rebuilt the show around that.";
  if (last.name === "next_track") return "Skipping to the next track.";
  if (last.name === "prev_track") return "Back to the previous track.";
  if (last.name === "pause") return "Paused.";
  if (last.name === "resume") return "Resuming.";
  return "";
}
