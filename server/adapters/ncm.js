const fallbackSongs = [
  {
    id: "local-1",
    title: "Aruarian Dance",
    artist: "Nujabes",
    source: "local",
    url: "",
    cover: "/assets/album-sonora.png",
    duration: 244
  },
  {
    id: "local-2",
    title: "Merry Christmas Mr. Lawrence",
    artist: "Ryuichi Sakamoto",
    source: "local",
    url: "",
    cover: "/assets/album-sonora.png",
    duration: 282
  },
  {
    id: "local-3",
    title: "Burgundy Red",
    artist: "Sunset Rollercoaster",
    source: "local",
    url: "",
    cover: "/assets/album-sonora.png",
    duration: 251
  },
  {
    id: "local-4",
    title: "Garden",
    artist: "Fujii Kaze",
    source: "local",
    url: "",
    cover: "/assets/album-sonora.png",
    duration: 229
  }
];

export class NeteaseCloudMusicApi {
  constructor({ baseUrl = "" } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.cookie = "";
  }

  setCookie(cookie = "") {
    this.cookie = String(cookie || "");
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  async createLoginQr() {
    if (!this.baseUrl) throw new Error("NCM_BASE_URL is not configured");
    const keyData = await this.fetchJson("/login/qr/key", { timestamp: Date.now() });
    const key = keyData.data?.unikey || keyData.unikey;
    if (!key) throw new Error("NCM login QR key missing");
    const qrData = await this.fetchJson("/login/qr/create", {
      key,
      qrimg: true,
      timestamp: Date.now()
    });
    return {
      key,
      qrurl: qrData.data?.qrurl || qrData.qrurl || "",
      qrimg: qrData.data?.qrimg || qrData.qrimg || ""
    };
  }

  async checkLoginQr(key) {
    if (!this.baseUrl) throw new Error("NCM_BASE_URL is not configured");
    return this.fetchJson("/login/qr/check", { key, timestamp: Date.now() });
  }

  async loginStatus(cookie = this.cookie) {
    if (!this.baseUrl) throw new Error("NCM_BASE_URL is not configured");
    const url = this.url("/login/status", { timestamp: Date.now() });
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie })
    });
    if (!response.ok) throw new Error(`NCM request failed: ${response.status}`);
    return response.json();
  }

  async profile(cookie = this.cookie) {
    const status = await this.loginStatus(cookie).catch(() => null);
    const profile = status?.data?.profile || status?.profile;
    if (profile) return profile;

    const account = await this.fetchJson("/user/account", {}, { cookie }).catch(() => null);
    return account?.profile || account?.data?.profile || null;
  }

  async userPlaylists(uid, { limit = 1000, offset = 0, cookie = this.cookie } = {}) {
    if (!uid) throw new Error("Missing NCM uid");
    const data = await this.fetchJson("/user/playlist", { uid, limit, offset }, { cookie });
    return data.playlist || data.data?.playlist || [];
  }

  async playlistTrackPage(id, { limit = 1000, offset = 0, cookie = this.cookie } = {}) {
    if (!id) throw new Error("Missing NCM playlist id");
    return this.fetchJson("/playlist/track/all", { id, limit, offset }, { cookie });
  }

  async search(keyword) {
    if (!this.baseUrl) {
      const needle = String(keyword || "").toLowerCase();
      return fallbackSongs.filter((song) => `${song.title} ${song.artist}`.toLowerCase().includes(needle)).slice(0, 8);
    }
    const data = await this.fetchJson("/search", { keywords: keyword });
    return (data.result?.songs || []).map((song) => ({
      id: String(song.id),
      title: song.name,
      artist: song.artists?.map((artist) => artist.name).join(" / ") || "Unknown",
      source: "netease",
      url: "",
      cover: song.album?.picUrl || "/assets/album-sonora.png",
      duration: Math.round((song.duration || 240000) / 1000)
    }));
  }

  async similarSongs(id) {
    if (!this.baseUrl || !id || String(id).startsWith("local-")) return [];
    const data = await this.fetchJson("/simi/song", { id });
    return (data.songs || []).map((song) => this.mapSong(song, { source: "netease:simi", seed: { type: "song", id } }));
  }

  async artistTopSongs(id) {
    if (!this.baseUrl || !id) return [];
    const data = await this.fetchJson("/artist/top/song", { id });
    const songs = data.songs || data.hotSongs || [];
    return songs.map((song) => this.mapSong(song, { source: "netease:artist-top", seed: { type: "artist", id } }));
  }

  async songUrl(id) {
    if (!this.baseUrl || String(id).startsWith("local-")) return "";
    const attempts = [
      ["/song/url/v1", { id, level: "exhigh" }],
      ["/song/url/v1", { id, level: "higher" }],
      ["/song/url", { id, br: 320000 }]
    ];
    for (const [endpoint, params] of attempts) {
      const data = await this.fetchJson(endpoint, params).catch(() => null);
      const url = data?.data?.[0]?.url;
      if (url) return url;
    }
    return "";
  }

  async songDetail(id) {
    if (!this.baseUrl || !id || String(id).startsWith("local-")) return null;
    const data = await this.fetchJson("/song/detail", { ids: String(id) });
    const song = data.songs?.[0] || data.data?.songs?.[0] || null;
    return song ? this.mapSong(song) : null;
  }

  async lyric(id) {
    if (!this.baseUrl || String(id).startsWith("local-")) return "";
    const data = await this.fetchJson("/lyric", { id });
    return data.lrc?.lyric || "";
  }

  async recommend(seed = {}) {
    if (!this.baseUrl) return fallbackSongs;
    try {
      const data = await this.fetchJson("/recommend/songs");
      return (data.data?.dailySongs || []).slice(0, 12).map((song) => ({
        id: String(song.id),
        title: song.name,
        artist: song.ar?.map((artist) => artist.name).join(" / ") || "Unknown",
        source: "netease",
        url: "",
        cover: song.al?.picUrl || "/assets/album-sonora.png",
        duration: Math.round((song.dt || 240000) / 1000),
        seed
      }));
    } catch {
      return fallbackSongs;
    }
  }

  mapSong(song, extra = {}) {
    const artists = song.ar || song.artists || [];
    const album = song.al || song.album || {};
    return {
      id: String(song.id),
      title: song.name,
      artist: artists.map((artist) => artist.name).join(" / ") || "Unknown",
      source: extra.source || "netease",
      url: "",
      cover: album.picUrl || "/assets/album-sonora.png",
      duration: Math.round((song.dt || song.duration || 240000) / 1000),
      popularity: song.pop,
      seed: extra.seed
    };
  }

  async hydrateTrack(track) {
    if (!track) return null;
    const candidates = track.id ? [track] : await this.search(`${track.title || ""} ${track.artist || ""}`.trim());
    const resolved = candidates[0] || track;
    const [detail, url, lyricText] = await Promise.all([
      resolved.id ? this.songDetail(resolved.id).catch(() => null) : Promise.resolve(null),
      track.url || resolved.url || this.songUrl(resolved.id),
      track.lyric ? Promise.resolve(track.lyric) : this.lyric(resolved.id).catch(() => "")
    ]);
    const cover = firstRealCover(detail?.cover, resolved.cover, track.cover);
    return {
      ...(detail || {}),
      ...resolved,
      ...track,
      id: resolved.id || track.id || crypto.randomUUID(),
      url: url || "",
      cover,
      duration: Number(detail?.duration || resolved.duration || track.duration || 240),
      lyric: undefined,
      lyricLines: Array.isArray(track.lyricLines) && track.lyricLines.length
        ? track.lyricLines
        : parseLrc(lyricText)
    };
  }

  url(endpoint, params = {}, { cookie = this.cookie } = {}) {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    }
    if (cookie && !url.searchParams.has("cookie")) url.searchParams.set("cookie", cookie);
    return url;
  }

  async fetchJson(endpoint, params = {}, options = {}) {
    if (!this.baseUrl) throw new Error("NCM_BASE_URL is not configured");
    return fetchJson(this.url(endpoint, params, options), options.fetchOptions);
  }
}

function firstRealCover(...covers) {
  return covers.find((cover) => cover && cover !== "/assets/album-sonora.png") || "/assets/album-sonora.png";
}

function parseLrc(lyric = "") {
  const lines = [];
  for (const rawLine of String(lyric || "").split(/\r?\n/)) {
    const stamps = [...rawLine.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = rawLine
      .replace(/\[[^\]]+\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || /^\s*(作词|作曲|编曲|制作人|监制|出品|发行|OP|SP|ISRC|纯音乐)/i.test(text)) continue;
    for (const stamp of stamps) {
      const minutes = Number(stamp[1] || 0);
      const seconds = Number(stamp[2] || 0);
      const fractionRaw = stamp[3] || "0";
      const fraction = Number(fractionRaw.padEnd(3, "0").slice(0, 3)) / 1000;
      lines.push({
        time: Math.max(0, minutes * 60 + seconds + fraction),
        text
      });
    }
  }
  return lines
    .sort((a, b) => a.time - b.time)
    .filter((line, index, all) => index === 0 || line.text !== all[index - 1].text || Math.abs(line.time - all[index - 1].time) > 1)
    .slice(0, 140);
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const response = await fetch(url, {
    ...(options || {}),
    signal: options?.signal || controller.signal
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`NCM request failed: ${response.status}`);
  return response.json();
}
