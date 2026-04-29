import fs from "node:fs/promises";
import path from "node:path";

export async function loadNcmSession(userDir) {
  const session = await readJson(path.join(userDir, "ncm-session.json"), null);
  return session || {};
}

export async function saveNcmSession(userDir, session) {
  await fs.mkdir(userDir, { recursive: true });
  const safe = {
    cookie: session.cookie || "",
    profile: normalizeProfile(session.profile),
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(path.join(userDir, "ncm-session.json"), `${JSON.stringify(safe, null, 2)}\n`);
  return safe;
}

export function getNcmUserDir(userDir, userId) {
  const safeUserId = String(userId || "").replace(/[^\w-]/g, "");
  if (!safeUserId) throw new Error("Missing Netease Cloud Music user id");
  return path.join(userDir, "users", safeUserId);
}

export async function getActiveNcmUser(userDir) {
  return readJson(path.join(userDir, "active-user.json"), null);
}

export async function getActiveNcmUserDir(userDir) {
  const active = await getActiveNcmUser(userDir);
  if (!active?.userId) return userDir;
  return getNcmUserDir(userDir, active.userId);
}

export async function activateNcmUser(userDir, profile) {
  const normalized = normalizeProfile(profile);
  if (!normalized?.userId) throw new Error("Unable to activate NCM user without user id");
  const dataDir = getNcmUserDir(userDir, normalized.userId);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "profile.json"), `${JSON.stringify(normalized, null, 2)}\n`);
  await migrateLegacyNcmData(userDir, normalized, dataDir);
  const active = {
    userId: normalized.userId,
    nickname: normalized.nickname,
    avatarUrl: normalized.avatarUrl,
    dataDir: path.relative(userDir, dataDir),
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(path.join(userDir, "active-user.json"), `${JSON.stringify(active, null, 2)}\n`);
  return { active, dataDir, profile: normalized };
}

export async function deactivateNcmUser(userDir) {
  await fs.mkdir(userDir, { recursive: true });
  await fs.writeFile(path.join(userDir, "active-user.json"), "{}\n");
}

async function migrateLegacyNcmData(userDir, profile, dataDir) {
  if (await isNcmUserInitialized(userDir, profile.userId)) return;
  const legacyProfile = await readJson(path.join(userDir, "profile.json"), null);
  const legacySync = await readJson(path.join(userDir, "sync-status.json"), null);
  const legacyUserId = legacySync?.profile?.userId || legacyProfile?.userId;
  if (legacyUserId && String(legacyUserId) !== String(profile.userId)) return;

  const legacyFiles = [
    "profile.json",
    "playlists.json",
    "likelist_raw.json",
    "likelist.json",
    "taste_stats.json",
    "taste.md",
    "sync-status.json"
  ];

  for (const filename of legacyFiles) {
    const source = path.join(userDir, filename);
    const target = path.join(dataDir, filename);
    if (await exists(source)) await fs.copyFile(source, target);
  }
}

export async function isNcmUserInitialized(userDir, userId) {
  const dataDir = getNcmUserDir(userDir, userId);
  const [taste, syncStatus] = await Promise.all([
    exists(path.join(dataDir, "taste.md")),
    exists(path.join(dataDir, "sync-status.json"))
  ]);
  return taste && syncStatus;
}

export async function readNcmUserSyncStatus(userDir, userId) {
  if (!userId) return null;
  return readJson(path.join(getNcmUserDir(userDir, userId), "sync-status.json"), null);
}

export async function syncNcmTaste({ ncm, userDir, openai }) {
  await fs.mkdir(userDir, { recursive: true });
  const session = await loadNcmSession(userDir);
  const cookie = session.cookie || ncm.cookie;
  if (!cookie) throw new Error("Netease Cloud Music is not logged in");
  ncm.setCookie(cookie);

  const profile = normalizeProfile(await ncm.profile(cookie));
  if (!profile?.userId) throw new Error("Unable to read Netease Cloud Music profile");
  const { dataDir } = await activateNcmUser(userDir, profile);

  if (await isNcmUserInitialized(userDir, profile.userId)) {
    const syncStatus = await readNcmUserSyncStatus(userDir, profile.userId);
    return {
      ...syncStatus,
      profile,
      initialized: true,
      skipped: true
    };
  }

  const playlists = await ncm.userPlaylists(profile.userId, { cookie });
  await fs.writeFile(path.join(dataDir, "playlists.json"), `${JSON.stringify({ playlist: playlists, code: 200 }, null, 2)}\n`);

  const likedPlaylist = findLikedPlaylist(playlists, profile.userId);
  if (!likedPlaylist?.id) throw new Error("Unable to find liked music playlist");

  const raw = await fetchAllPlaylistTracks(ncm, likedPlaylist, cookie);
  await fs.writeFile(path.join(dataDir, "likelist_raw.json"), `${JSON.stringify(raw, null, 2)}\n`);

  const normalized = normalizeLikelistRaw(raw, {
    sourceFile: path.join("user", "users", String(profile.userId), "likelist_raw.json"),
    playlist: {
      id: likedPlaylist.id,
      name: likedPlaylist.name,
      trackCount: likedPlaylist.trackCount
    }
  });
  await fs.writeFile(path.join(dataDir, "likelist.json"), `${JSON.stringify(normalized, null, 2)}\n`);

  const stats = buildTasteStats(normalized.songs);
  await fs.writeFile(path.join(dataDir, "taste_stats.json"), `${JSON.stringify(stats, null, 2)}\n`);

  const tasteMd = await generateTasteMarkdown({ openai, profile, stats }).catch(() => fallbackTasteMarkdown(profile, stats));
  await fs.writeFile(path.join(dataDir, "taste.md"), `${tasteMd.trim()}\n`);

  const sync = {
    profile,
    likedPlaylist: normalized.meta.playlist,
    songCount: normalized.meta.song_count,
    tasteGenerated: Boolean(tasteMd),
    initialized: true,
    skipped: false,
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(path.join(dataDir, "sync-status.json"), `${JSON.stringify(sync, null, 2)}\n`);
  await saveNcmSession(userDir, { cookie, profile });
  return sync;
}

export function normalizeLikelistRaw(raw, { sourceFile = "likelist_raw.json", playlist = null } = {}) {
  if (!Array.isArray(raw.songs)) throw new Error("Expected raw.songs to be an array");
  const privileges = new Map(
    Array.isArray(raw.privileges) ? raw.privileges.map((item) => [item.id, item]) : []
  );

  return {
    meta: {
      source_file: sourceFile,
      generated_at: new Date().toISOString(),
      raw_code: raw.code,
      song_count: raw.songs.length,
      playlist
    },
    songs: raw.songs.map((song, index) => normalizeSong(song, index, privileges.get(song.id)))
  };
}

export function buildTasteStats(songs) {
  const artistCount = new Map();
  const albumCount = new Map();
  const languageCount = new Map();
  const decadeCount = new Map();
  const tagCount = new Map();

  for (const song of songs) {
    for (const artist of song.artists || []) increment(artistCount, artist.name);
    if (song.album?.name) increment(albumCount, song.album.name);
    increment(languageCount, inferLanguage(song));
    const decade = inferDecade(song.publish_date);
    if (decade) increment(decadeCount, decade);
    for (const tag of collectTags(song)) increment(tagCount, tag);
  }

  const topArtists = topEntries(artistCount, 50).map(([artist, song_count]) => ({
    artist,
    song_count,
    representative_songs: songs
      .filter((song) => (song.artist_names || []).includes(artist))
      .slice(0, 5)
      .map(compactSong)
  }));

  return {
    total_songs: songs.length,
    top_artists: topArtists,
    top_albums: topEntries(albumCount, 30).map(([album, song_count]) => ({ album, song_count })),
    language_distribution: Object.fromEntries(topEntries(languageCount, 12)),
    decade_distribution: Object.fromEntries(topEntries(decadeCount, 12)),
    tag_distribution: Object.fromEntries(topEntries(tagCount, 30)),
    representative_songs: pickRepresentativeSongs(songs, topArtists.map((item) => item.artist)),
    popularity: summarizeNumbers(songs.map((song) => song.popularity).filter(Number.isFinite)),
    duration_sec: summarizeNumbers(songs.map((song) => song.duration_sec).filter(Number.isFinite))
  };
}

async function fetchAllPlaylistTracks(ncm, playlist, cookie) {
  const limit = 1000;
  let offset = 0;
  const songs = [];
  const privileges = [];
  let code = 200;

  while (true) {
    const page = await ncm.playlistTrackPage(playlist.id, { limit, offset, cookie });
    code = page.code ?? code;
    const pageSongs = page.songs || [];
    const pagePrivileges = page.privileges || [];
    songs.push(...pageSongs);
    privileges.push(...pagePrivileges);
    offset += pageSongs.length;
    if (!pageSongs.length || pageSongs.length < limit) break;
    if (playlist.trackCount && offset >= playlist.trackCount) break;
  }

  return {
    songs,
    privileges,
    code,
    playlist: {
      id: playlist.id,
      name: playlist.name,
      trackCount: playlist.trackCount
    }
  };
}

function findLikedPlaylist(playlists, userId) {
  return playlists.find((item) => item.specialType === 5 && item.userId === userId)
    || playlists.find((item) => item.name?.includes("喜欢的音乐"))
    || playlists[0];
}

async function generateTasteMarkdown({ openai, profile, stats }) {
  if (!openai?.baseUrl || !openai?.apiKey) return fallbackTasteMarkdown(profile, stats);
  const baseUrl = openai.baseUrl.replace(/\/$/, "");
  const url = /\/chat\/completions$/.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openai.apiKey}`
    },
    body: JSON.stringify({
      model: openai.model,
      temperature: 0.35,
      messages: [
        {
          role: "system",
          content: [
            "你是一个严谨的私人音乐品味分析师。",
            "你只根据输入统计和代表歌曲总结用户长期听歌偏好。",
            "不要编造不存在的歌手、歌曲、流派或平台数据。",
            "输出必须是 Markdown，标题为 # Taste，不要输出 JSON。"
          ].join("\n")
        },
        {
          role: "user",
          content: buildTastePrompt(profile, stats)
        }
      ]
    })
  });
  if (!response.ok) throw new Error(`Taste LLM request failed: ${response.status}`);
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  return sanitizeTasteMarkdown(text) || fallbackTasteMarkdown(profile, stats);
}

function buildTastePrompt(profile, stats) {
  const compactStats = {
    total_songs: stats.total_songs,
    top_artists: stats.top_artists.slice(0, 35),
    top_albums: stats.top_albums.slice(0, 20),
    language_distribution: stats.language_distribution,
    decade_distribution: stats.decade_distribution,
    tag_distribution: stats.tag_distribution,
    representative_songs: stats.representative_songs.slice(0, 120),
    popularity: stats.popularity,
    duration_sec: stats.duration_sec
  };

  return [
    `用户昵称：${profile?.nickname || "Unknown"}`,
    "",
    "请生成给私人 AI 电台使用的长期偏好说明 taste.md。",
    "",
    "要求：",
    "- 用中文输出。",
    "- 内容要具体、可执行，方便电台选歌和主持。",
    "- 必须包含：喜欢的声音气质、主要风格推断、常见歌手线索、语言/年代倾向、工作/夜晚/放松/通勤推荐策略、应该避免的内容、主持人口吻。",
    "- 对风格判断要给出证据，例如歌手、代表歌曲、年代或语言分布。",
    "- 风格不确定时直接写“可能”或“证据不足”，不要强行下结论。",
    "- 不要输出 taste_profile.json，不要输出代码块。",
    "",
    "输入统计：",
    JSON.stringify(compactStats, null, 2)
  ].join("\n");
}

function fallbackTasteMarkdown(profile, stats) {
  const artists = stats.top_artists.slice(0, 12).map((item) => `${item.artist}(${item.song_count})`).join("、");
  const languages = Object.entries(stats.language_distribution).map(([key, value]) => `${key}: ${value}`).join("、");
  const decades = Object.entries(stats.decade_distribution).map(([key, value]) => `${key}: ${value}`).join("、");
  const songs = stats.representative_songs.slice(0, 12).map((song) => `- ${song.name} - ${song.artist_names.join(" / ")}`).join("\n");

  return `# Taste

用户 ${profile?.nickname || ""} 的网易云喜欢列表共 ${stats.total_songs} 首歌。当前画像由程序统计生成；如果配置了 LLM，会自动替换成更细的音乐品味总结。

## 喜欢的声音气质
- 偏好旋律线清楚、人声辨识度高、情绪表达明确的作品。
- 高频歌手集中度可用于推荐种子，优先选择与常听歌手气质接近的歌曲。
- 推荐时避免只按热度推歌，应结合语言、年代和最近播放历史做去重。

## 常见歌手线索
- 高频歌手：${artists || "暂无"}。

## 语言与年代倾向
- 语言分布：${languages || "暂无"}。
- 年代分布：${decades || "暂无"}。

## 推荐策略
- 工作时：选择节奏稳定、旋律明确、不过分抢注意力的歌。
- 夜晚：选择情绪更私密、空间感更强、铺陈更慢的作品。
- 放松时：从高频歌手的相邻歌手和同专辑作品延展。
- 通勤时：可以提高旋律和节奏存在感，但避免过度刺激。

## 代表歌曲样本
${songs || "- 暂无"}

## 主持人口吻
- 温和、具体、少形容词堆叠。
- 介绍歌曲时说明它为什么适合此刻，而不是泛泛夸歌。`;
}

function normalizeSong(song, index, privilege) {
  const artists = Array.isArray(song.ar) ? song.ar.map(normalizeArtist) : [];
  const aliases = Array.isArray(song.alia) ? song.alia : [];
  const titleParts = [song.name, ...aliases, ...artists.map((artist) => artist.name)].filter(Boolean);

  return compact({
    index,
    id: song.id,
    name: song.name,
    main_title: song.mainTitle,
    additional_title: song.additionalTitle,
    aliases,
    artists,
    artist_names: artists.map((artist) => artist.name),
    album: normalizeAlbum(song.al),
    duration_ms: song.dt,
    duration_sec: Number.isFinite(song.dt) ? Math.round(song.dt / 1000) : null,
    popularity: song.pop,
    fee: song.fee,
    mv_id: song.mv || null,
    cd: song.cd,
    track_no: song.no,
    copyright: song.copyright,
    status: song.st,
    resource_state: song.resourceState,
    publish_time_ms: song.publishTime || null,
    publish_date: toIsoDate(song.publishTime),
    quality: normalizeQuality(song),
    privilege: normalizePrivilege(privilege),
    tags: normalizeTags(song),
    origin_song: song.originSongSimpleData
      ? {
          id: song.originSongSimpleData.songId,
          name: song.originSongSimpleData.name,
          artists: song.originSongSimpleData.artists?.map(normalizeArtist),
          album: normalizeAlbum(song.originSongSimpleData.albumMeta)
        }
      : null,
    search_text: titleParts.join(" - ")
  });
}

function normalizeProfile(profile) {
  if (!profile) return null;
  return compact({
    userId: profile.userId,
    nickname: profile.nickname,
    avatarUrl: profile.avatarUrl,
    signature: profile.signature,
    gender: profile.gender,
    city: profile.city,
    province: profile.province,
    vipType: profile.vipType
  });
}

function normalizeArtist(artist) {
  return compact({
    id: artist.id,
    name: artist.name,
    aliases: artist.alias,
    translated_names: artist.tns
  });
}

function normalizeAlbum(album) {
  if (!album) return null;
  return compact({
    id: album.id,
    name: album.name,
    translated_names: album.tns,
    cover_url: album.picUrl,
    cover_id: album.pic_str || (album.pic ? String(album.pic) : null)
  });
}

function normalizeQuality(song) {
  return compact({
    hr_bitrate: song.hr?.br,
    sq_bitrate: song.sq?.br,
    high_bitrate: song.h?.br,
    medium_bitrate: song.m?.br,
    low_bitrate: song.l?.br
  });
}

function normalizePrivilege(privilege) {
  if (!privilege) return null;
  return compact({
    fee: privilege.fee,
    status: privilege.st,
    playable: privilege.st === 0 && privilege.pl > 0,
    play_bitrate: privilege.pl,
    download_bitrate: privilege.dl,
    max_bitrate: privilege.maxbr,
    play_level: privilege.plLevel,
    download_level: privilege.dlLevel,
    max_level: privilege.maxBrLevel,
    free_trial: privilege.freeTrialPrivilege
      ? {
          resource_consumable: privilege.freeTrialPrivilege.resConsumable,
          user_consumable: privilege.freeTrialPrivilege.userConsumable,
          cannot_listen_reason: privilege.freeTrialPrivilege.cannotListenReason
        }
      : null
  });
}

function normalizeTags(song) {
  return compact({
    display: song.displayTags,
    entertainment: song.entertainmentTags,
    award: song.awardTags,
    mark: song.markTags,
    feature: song.songFeature
  });
}

function compact(value) {
  if (Array.isArray(value)) {
    return value.map(compact).filter((item) => item !== null && item !== undefined);
  }
  if (!value || typeof value !== "object") return value === undefined ? null : value;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, compact(item)])
      .filter(([, item]) => {
        if (item === null || item === undefined || item === "") return false;
        if (Array.isArray(item) && item.length === 0) return false;
        if (typeof item === "object" && Object.keys(item).length === 0) return false;
        return true;
      })
  );
}

function toIsoDate(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function inferLanguage(song) {
  const text = `${song.name || ""} ${(song.artist_names || []).join(" ")} ${song.album?.name || ""}`;
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[a-zA-Z]/.test(text)) return "en";
  return "unknown";
}

function inferDecade(date) {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  return `${Math.floor(year / 10) * 10}s`;
}

function collectTags(song) {
  return Object.values(song.tags || {})
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter(Boolean)
    .map((tag) => typeof tag === "string" ? tag : tag.name || tag.tagName || tag.title)
    .filter(Boolean);
}

function increment(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function topEntries(map, limit) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function compactSong(song) {
  return {
    id: song.id,
    name: song.name,
    artist_names: song.artist_names || [],
    album: song.album?.name || "",
    publish_date: song.publish_date || "",
    popularity: song.popularity
  };
}

function pickRepresentativeSongs(songs, topArtists) {
  const picked = [];
  const seen = new Set();
  for (const artist of topArtists.slice(0, 30)) {
    for (const song of songs) {
      if (picked.length >= 150) return picked;
      if (seen.has(song.id)) continue;
      if ((song.artist_names || []).includes(artist)) {
        picked.push(compactSong(song));
        seen.add(song.id);
        if (picked.filter((item) => item.artist_names.includes(artist)).length >= 3) break;
      }
    }
  }
  return picked;
}

function summarizeNumbers(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / values.length),
    median: sorted[Math.floor(sorted.length / 2)]
  };
}

function sanitizeTasteMarkdown(text) {
  return String(text || "")
    .replace(/^```(?:markdown|md)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
