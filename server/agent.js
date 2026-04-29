export class AgentBrain {
  constructor({ openai = {}, ncm }) {
    this.openai = openai;
    this.ncm = ncm;
  }

  async compute(contextPacket) {
    const candidatePool = await this.buildCandidatePool(contextPacket.fragments);
    const enrichedPacket = enrichContextPacket(contextPacket, candidatePool);
    const raw = await withTimeout(this.callProvider(enrichedPacket), 18000, null).catch(() => null);
    const parsed = raw ? parseAgentJson(raw) : null;
    const result = parsed || await this.fallback(enrichedPacket.fragments);
    return completeQueue(normalizeResult(result), candidatePool);
  }

  async callProvider({ messages }) {
    if (!this.openai.baseUrl || !this.openai.apiKey) return null;
    const response = await fetch(chatCompletionsUrl(this.openai), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.openai.apiKey}`
      },
      body: JSON.stringify({
        model: this.openai.model,
        messages,
        temperature: 0.7,
        response_format: { type: "json_object" }
      })
    });
    if (!response.ok) throw new Error(`LLM request failed: ${response.status}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }

  async fallback(fragments) {
    const hour = new Date().getHours();
    const recent = new Set((fragments.memory?.recentPlays || []).slice(0, 6).map((play) => `${play.title}-${play.artist}`));
    const recommended = await this.searchPlayableCandidates(fragments);
    const play = recommended.filter((song) => !recent.has(`${song.title}-${song.artist}`)).slice(0, 6);
    const slot = hour < 10 ? "morning" : hour < 18 ? "workday" : "night";
    const weather = fragments.environment.weather.label || "local";
    return {
      say: `The ${slot} signal is live. The weather reads ${weather}; I will start with something clear enough to hold the room without stealing focus.`,
      play,
      reason: "Selected for the current time, weather, and recent play history: clear melody, low friction, and enough pulse to keep working.",
      segue: "Let this one level out the room first; the next section can bring in a little more motion."
    };
  }

  async searchPlayableCandidates(fragments) {
    if (Array.isArray(fragments.toolResults?.candidatePool) && fragments.toolResults.candidatePool.length) {
      return fragments.toolResults.candidatePool;
    }
    const input = String(fragments.currentInput || "").trim();
    const favorites = fragments.playlists?.favorites || [];
    const work = fragments.playlists?.work || [];
    const knownArtists = [...favorites, ...work]
      .flatMap((song) => String(song.artist || "").split(/[\/,，&]/))
      .map((artist) => artist.trim())
      .filter(Boolean);
    const mentionedArtists = knownArtists.filter((artist) => input.toLowerCase().includes(artist.toLowerCase()));
    const seeds = [
      ...mentionedArtists,
      ...work.map((song) => `${song.title} ${song.artist}`),
      ...favorites.map((song) => `${song.title} ${song.artist}`),
      extractSearchTerms(input),
      "Nujabes",
      "Sunset Rollercoaster"
    ].filter(Boolean);

    for (const seed of seeds) {
      const candidates = await withTimeout(this.ncm.search(seed), 6000, []).catch(() => []);
      const publicCandidates = candidates.filter((song) => !String(song.id || "").startsWith("local-"));
      if (publicCandidates.length) return publicCandidates;
    }

    return withTimeout(this.ncm.recommend({
      mood: fragments.memory?.prefs?.mood,
      hour: new Date().getHours()
    }), 6000, []);
  }

  async buildCandidatePool(fragments) {
    const candidates = [];
    const input = String(fragments.currentInput || "").trim();
    const recent = new Set((fragments.memory?.recentPlays || []).slice(0, 12).map((play) => keyFor(play.title, play.artist)));
    const topArtistNames = new Set((fragments.musicTaste?.topArtists || []).slice(0, 20).map((item) => item.artist));

    const add = (song, score, reason) => {
      if (!song?.title || !song?.artist) return;
      const key = String(song.id || keyFor(song.title, song.artist));
      const duplicate = candidates.find((item) => String(item.id || keyFor(item.title, item.artist)) === key);
      const adjustedScore = score
        + artistAffinity(song.artist, topArtistNames)
        - (recent.has(keyFor(song.title, song.artist)) ? 35 : 0);
      if (duplicate) {
        duplicate.score = Math.max(duplicate.score || 0, adjustedScore);
        if (reason && !duplicate.reasons?.includes(reason)) duplicate.reasons = [...(duplicate.reasons || []), reason];
        return;
      }
      candidates.push({
        ...song,
        score: adjustedScore,
        reasons: reason ? [reason] : []
      });
    };

    for (const song of fragments.toolResults?.searchResults || []) add(song, 72, "matched the user's request");

    const searchTerm = extractSearchTerms(input);
    if (searchTerm) {
      for (const song of await withTimeout(this.ncm.search(searchTerm), 6000, []).catch(() => [])) add(song, 76, `search seed: ${searchTerm}`);
    }

    const songSeeds = prioritizeSongSeeds(fragments.musicTaste?.songSeeds || [], input).slice(0, 8);
    const artistSeeds = prioritizeArtistSeeds(fragments.musicTaste?.artistSeeds || [], input).slice(0, 6);
    const [similarGroups, artistTopGroups, artistSearchGroups, daily] = await Promise.all([
      Promise.all(songSeeds.map(async (seed) => ({
        seed,
        songs: await withTimeout(this.ncm.similarSongs(seed.id), 6000, []).catch(() => [])
      }))),
      Promise.all(artistSeeds.map(async (artist) => ({
        artist,
        songs: await withTimeout(this.ncm.artistTopSongs(artist.id), 6000, []).catch(() => [])
      }))),
      Promise.all(artistSeeds.slice(0, 4).map(async (artist) => ({
        artist,
        songs: await withTimeout(this.ncm.search(`${artist.name} ${searchTerm}`.trim()), 6000, []).catch(() => [])
      }))),
      withTimeout(this.ncm.recommend({
        mood: fragments.memory?.prefs?.mood,
        hour: new Date().getHours()
      }), 6000, []).catch(() => [])
    ]);

    for (const group of similarGroups) {
      for (const song of group.songs.slice(0, 8)) add(song, 86, `similar to liked song: ${group.seed.title}`);
    }

    for (const group of artistTopGroups) {
      for (const song of group.songs.slice(0, 8)) add(song, 70, `top song from liked artist: ${group.artist.name}`);
    }

    for (const group of artistSearchGroups) {
      for (const song of group.songs.slice(0, 5)) add(song, 64, `artist search seed: ${group.artist.name}`);
    }

    for (const song of daily.slice(0, 12)) add(song, 52, "daily recommendation");

    for (const seed of songSeeds.slice(0, 12)) {
      add({
        id: seed.id,
        title: seed.title,
        artist: seed.artist,
        source: "netease:liked-seed",
        url: "",
        cover: "/assets/album-sonora.png",
        duration: seed.duration || 240,
        popularity: seed.popularity
      }, 45, "familiar liked-song seed");
    }

    return candidates
      .filter((song) => !String(song.id || "").startsWith("local-") || !this.ncm.configured)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 60);
  }
}

function chatCompletionsUrl(openai) {
  const baseUrl = openai.baseUrl.replace(/\/$/, "");
  if (/\/chat\/completions$/.test(baseUrl)) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

function withTimeout(promise, ms, fallback) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function extractSearchTerms(input) {
  return input
    .replace(/播放|来一首|听|歌曲?|音乐|推荐|现在|开一段|电台|适合|工作|今晚|轻一点|的|一首/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function enrichContextPacket(contextPacket, candidatePool) {
  const fragments = {
    ...contextPacket.fragments,
    selectionPolicy: {
      rule: "Build the play queue from toolResults.candidatePool whenever possible. Preserve candidate id/source/cover/duration fields. Pick tracks that fit userTaste, currentInput, time, and recentPlays; avoid repeats.",
      queueSize: "6 tracks",
      introRule: "Every selected track must include an intro written in natural English from the start. Write like a real radio host: mention the song and artist, add one specific detail about style, mood, era, scene, lyric feeling, or artist background, and explain why it fits this set. Keep it under 45 words. Do not write Chinese narration; Chinese song and artist names are allowed only as proper nouns."
    },
    toolResults: {
      ...(contextPacket.fragments.toolResults || {}),
      candidatePool: candidatePool.map(compactCandidateForPrompt)
    }
  };

  return {
    fragments,
    messages: [
      contextPacket.messages[0],
      { role: "user", content: JSON.stringify(fragments, null, 2) }
    ]
  };
}

function compactCandidateForPrompt(song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    source: song.source,
    cover: song.cover,
    duration: song.duration,
    intro: song.intro,
    score: Math.round(song.score || 0),
    reasons: song.reasons
  };
}

function completeQueue(result, candidatePool) {
  const selected = [];
  const used = new Set();
  for (const item of result.play || []) {
    const match = findCandidate(item, candidatePool);
    const track = match ? { ...match, ...item, id: match.id, source: match.source, cover: item.cover || match.cover, duration: item.duration || match.duration } : item;
    const key = keyFor(track.title, track.artist);
    if (!used.has(key)) {
      selected.push(track);
      used.add(key);
    }
  }

  for (const candidate of candidatePool) {
    if (selected.length >= 6) break;
    const key = keyFor(candidate.title, candidate.artist);
    if (!used.has(key)) {
      selected.push(candidate);
      used.add(key);
    }
  }

  return {
    ...result,
    play: selected.slice(0, 6),
    reason: result.reason || "Selected from a taste-matched candidate pool built from liked songs, top artists, and current context."
  };
}

function findCandidate(track, candidatePool) {
  if (!track) return null;
  if (track.id) {
    const byId = candidatePool.find((candidate) => String(candidate.id) === String(track.id));
    if (byId) return byId;
  }
  const key = keyFor(track.title, track.artist);
  return candidatePool.find((candidate) => keyFor(candidate.title, candidate.artist) === key) || null;
}

function prioritizeSongSeeds(songSeeds, input) {
  const text = input.toLowerCase();
  return [...songSeeds].sort((a, b) => {
    const aMentioned = text && `${a.title} ${a.artist}`.toLowerCase().includes(text) ? 1 : 0;
    const bMentioned = text && `${b.title} ${b.artist}`.toLowerCase().includes(text) ? 1 : 0;
    return bMentioned - aMentioned || (b.popularity || 0) - (a.popularity || 0);
  });
}

function prioritizeArtistSeeds(artistSeeds, input) {
  const text = input.toLowerCase();
  return [...artistSeeds].sort((a, b) => {
    const aMentioned = text && text.includes(String(a.name || "").toLowerCase()) ? 1 : 0;
    const bMentioned = text && text.includes(String(b.name || "").toLowerCase()) ? 1 : 0;
    return bMentioned - aMentioned || (b.liked_count || 0) - (a.liked_count || 0);
  });
}

function artistAffinity(artistText, topArtistNames) {
  const artist = String(artistText || "").toLowerCase();
  for (const name of topArtistNames) {
    if (artist.includes(String(name).toLowerCase())) return 10;
  }
  return 0;
}

function keyFor(title, artist) {
  return `${String(title || "").trim().toLowerCase()}::${String(artist || "").trim().toLowerCase()}`;
}

function parseAgentJson(raw) {
  const text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.match(/\{[\s\S]*\}/)?.[0] || text;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeResult(result) {
  return {
    say: String(result.say || "I am here. Let the music take over a little of the air.").slice(0, 500),
    play: Array.isArray(result.play) ? result.play.slice(0, 8) : [],
    reason: String(result.reason || "Selected from the current context.").slice(0, 500),
    segue: String(result.segue || "").slice(0, 500)
  };
}
