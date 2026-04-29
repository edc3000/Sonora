import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export class TtsPipeline {
  constructor({ cacheDir, tts = {} }) {
    this.cacheDir = cacheDir;
    this.tts = tts;
  }

  async synthesize(text, options = {}) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) return browserSpeech("empty text");

    const provider = this.resolveProvider();
    if (provider === "browser-speech") return browserSpeech("no TTS URL configured");
    if (provider === "unsupported") return browserSpeech(`Unsupported TTS_URL: ${this.tts.url}`);

    const missing = this.missingConfig();
    if (missing.length) return browserSpeech(`Missing TTS config: ${missing.join(", ")}`);

    const voiceId = options.voiceId || this.tts.voiceId || "";
    const instruction = options.instruction || "";
    await fs.mkdir(this.cacheDir, { recursive: true });
    const hash = crypto.createHash("sha256")
      .update(JSON.stringify({
        provider,
        url: this.tts.url,
        model: this.modelForProvider(provider),
        voiceId,
        instruction,
        text: normalizedText
      }))
      .digest("hex")
      .slice(0, 24);
    const filePath = path.join(this.cacheDir, `${hash}.mp3`);

    try {
      const stat = await fs.stat(filePath);
      if (stat.size) return ttsResult({ filePath, hash, provider, voiceId, cached: true });
    } catch {
      // Cache miss.
    }

    try {
      const body = await this.fetchAudio(provider, normalizedText, { voiceId, instruction });
      if (!body.length) return browserSpeech(`${provider} returned empty audio`);
      await fs.writeFile(filePath, body);
      return ttsResult({ filePath, hash, provider, voiceId, cached: false });
    } catch (error) {
      console.warn(`${provider} TTS failed: ${error.message}`);
      return browserSpeech(error.message);
    }
  }

  optionsForTrack(track) {
    const provider = this.resolveProvider();
    return {
      provider,
      voiceId: this.tts.englishMaleVoiceId || this.tts.voiceId,
      instruction: instructionForTrack(track)
    };
  }

  voiceForTrack(track) {
    return this.optionsForTrack(track).voiceId || "";
  }

  resolveProvider() {
    const url = String(this.tts.url || "").trim();
    if (!url) return "browser-speech";
    return detectProvider(url);
  }

  missingConfig() {
    const missing = [];
    if (!this.tts.url) missing.push("TTS_URL");
    if (!this.tts.apiKey) missing.push("TTS_API_KEY");
    if (!this.tts.modelId) missing.push("TTS_MODEL_ID");
    if (!this.tts.voiceId) missing.push("TTS_VOICE_ID");
    return missing;
  }

  modelForProvider(provider) {
    return provider === "browser-speech" ? "" : this.tts.modelId || "";
  }

  async fetchAudio(provider, text, options) {
    if (provider === "step") return this.fetchStepAudio(text, options);
    if (provider === "fish") return this.fetchFishAudio(text, options);
    throw new Error(`Unsupported TTS provider: ${provider}`);
  }

  async fetchStepAudio(text, { voiceId = "", instruction = "" } = {}) {
    const response = await fetch(this.tts.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.tts.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.tts.modelId,
        voice: voiceId || this.tts.voiceId,
        input: text,
        instruction
      })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Step request failed ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async fetchFishAudio(text, { voiceId = "" } = {}) {
    const response = await fetch(this.tts.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.tts.apiKey}`,
        model: this.tts.modelId,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        text,
        reference_id: voiceId || this.tts.voiceId,
        format: "mp3",
        normalize: true,
        latency: "normal",
        temperature: 0.6,
        top_p: 0.7,
        repetition_penalty: 1.15,
        chunk_length: 200
      })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Fish request failed ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

function detectProvider(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (host.includes("stepfun.com") || pathname.endsWith("/audio/speech")) return "step";
    if (host.includes("fish.audio") || pathname.endsWith("/tts")) return "fish";
    return "unsupported";
  } catch {
    return "unsupported";
  }
}

function instructionForTrack(track = {}) {
  const title = track.title ? `“${track.title}”` : "the next song";
  const artist = track.artist ? ` by ${track.artist}` : "";
  return `Warm male English radio host. Speak only in English with a calm, intimate music-program tone. Make it feel like a real radio introduction for ${title}${artist}: specific, knowledgeable, human, and under 18 seconds.`;
}

function ttsResult({ filePath, hash, provider, voiceId, cached }) {
  return {
    path: filePath,
    url: `/tts/${hash}.mp3`,
    cached,
    provider,
    voiceId: voiceId || "default",
    error: ""
  };
}

function browserSpeech(error = "") {
  return {
    path: "",
    url: "",
    cached: false,
    provider: "browser-speech",
    error
  };
}

function isCantoneseTrack(track = {}) {
  const text = `${track.title || ""} ${track.artist || ""} ${track.album || ""}`.toLowerCase();
  if (/(粤|粵|廣東|广东|cantonese|cantopop|\(yue\)|（粤）|（粵）|粤语|粵語)/i.test(text)) return true;

  const cantoneseArtists = [
    "陈奕迅", "陳奕迅", "eason chan", "张敬轩", "張敬軒", "hins cheung",
    "谢安琪", "謝安琪", "kay tse", "容祖儿", "容祖兒", "joey yung",
    "杨千嬅", "楊千嬅", "miriam yeung", "郑秀文", "鄭秀文", "sammi cheng",
    "王菲", "faye wong", "林忆莲", "林憶蓮", "sandy lam", "卢巧音", "盧巧音",
    "卫兰", "衛蘭", "janice vidal", "麦浚龙", "麥浚龍", "juno mak",
    "方皓玟", "charmaine fong", "my little airport", "dear jane", "rubberband",
    "古巨基", "leo ku", "张学友", "張學友", "jacky cheung", "林家谦", "林家謙",
    "terence lam", "陈柏宇", "陳柏宇", "jason chan", "薛凯琪", "薛凱琪",
    "周柏豪", "pakho chau", "林二汶", "at17", "twins", "beyond", "黄耀明", "黃耀明"
  ];
  if (cantoneseArtists.some((artist) => text.includes(artist.toLowerCase()))) return true;

  const traditionalOrCantoneseChars = text.match(/[嘅咗佢哋唔啲喺冇嚟嚿嗰俾畀諗睇聽講會愛無裡裏風開點]/g) || [];
  return traditionalOrCantoneseChars.length >= 2;
}
