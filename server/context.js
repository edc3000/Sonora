import fs from "node:fs/promises";
import path from "node:path";
import { getCalendarContext } from "./adapters/calendar.js";
import { getWeatherContext } from "./adapters/weather.js";

export class ContextBuilder {
  constructor({ promptsDir, userDir, getUserDir, stateStore }) {
    this.promptsDir = promptsDir;
    this.userDir = userDir;
    this.getUserDir = getUserDir;
    this.stateStore = stateStore;
  }

  async build({ input = "", trigger = "user", toolResults = {} } = {}) {
    const activeUserDir = this.getUserDir ? await this.getUserDir() : this.userDir;
    const [persona, taste, routines, moodRules, playlists, tasteStats, likelist, weather, calendar] = await Promise.all([
      readText(path.join(this.promptsDir, "dj-persona.md")),
      readUserText(activeUserDir, this.userDir, "taste.md"),
      readUserText(activeUserDir, this.userDir, "routines.md"),
      readUserText(activeUserDir, this.userDir, "mood-rules.md"),
      readUserJson(activeUserDir, this.userDir, "playlists.json"),
      readUserJson(activeUserDir, this.userDir, "taste_stats.json"),
      readUserJson(activeUserDir, this.userDir, "likelist.json"),
      getWeatherContext(),
      getCalendarContext()
    ]);

    const state = this.stateStore.snapshot;
    const now = new Date();
    const fragments = {
      system: persona,
      userTaste: taste,
      routines,
      moodRules,
      playlists,
      musicTaste: buildMusicTasteFragment(tasteStats, likelist),
      environment: {
        now: now.toISOString(),
        localTime: now.toLocaleString("en-US", { hour12: false }),
        weather,
        calendar
      },
      memory: {
        recentMessages: state.messages.slice(0, 8),
        recentPlays: state.plays.slice(0, 12),
        prefs: state.prefs,
        currentPlan: state.plan
      },
      currentInput: input,
      toolResults,
      trace: {
        trigger,
        stage: "compute"
      }
    };

    return {
      fragments,
      messages: [
        { role: "system", content: persona },
        { role: "user", content: JSON.stringify(fragments, null, 2) }
      ]
    };
  }
}

function buildMusicTasteFragment(tasteStats = {}, likelist = {}) {
  const songs = Array.isArray(likelist.songs) ? likelist.songs : [];
  const artistSeeds = buildArtistSeeds(songs, tasteStats.top_artists || []);
  const songSeeds = buildSongSeeds(songs, tasteStats.representative_songs || [], artistSeeds);

  return {
    likedSongCount: songs.length || tasteStats.total_songs || 0,
    topArtists: (tasteStats.top_artists || []).slice(0, 30).map((item) => ({
      artist: item.artist,
      song_count: item.song_count,
      representative_songs: (item.representative_songs || []).slice(0, 3)
    })),
    languageDistribution: tasteStats.language_distribution || {},
    decadeDistribution: tasteStats.decade_distribution || {},
    tagDistribution: tasteStats.tag_distribution || {},
    artistSeeds,
    songSeeds
  };
}

function buildArtistSeeds(songs, topArtists) {
  const byName = new Map();
  for (const song of songs) {
    for (const artist of song.artists || []) {
      if (!artist?.name) continue;
      const item = byName.get(artist.name) || {
        id: artist.id,
        name: artist.name,
        liked_count: 0,
        songs: []
      };
      item.liked_count += 1;
      if (item.songs.length < 4) item.songs.push(compactLikedSong(song));
      byName.set(artist.name, item);
    }
  }

  const topNames = new Set(topArtists.slice(0, 40).map((item) => item.artist));
  return [...byName.values()]
    .filter((item) => topNames.has(item.name))
    .sort((a, b) => b.liked_count - a.liked_count)
    .slice(0, 30);
}

function buildSongSeeds(songs, representativeSongs, artistSeeds) {
  const picked = new Map();
  const byId = new Map(songs.map((song) => [String(song.id), song]));
  for (const song of representativeSongs) {
    const full = byId.get(String(song.id));
    if (full) picked.set(String(full.id), compactLikedSong(full));
  }
  for (const artist of artistSeeds.slice(0, 20)) {
    for (const song of artist.songs || []) picked.set(String(song.id), song);
  }
  for (const song of [...songs].sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 80)) {
    picked.set(String(song.id), compactLikedSong(song));
  }
  return [...picked.values()].slice(0, 120);
}

function compactLikedSong(song) {
  return {
    id: String(song.id),
    title: song.name,
    artist: (song.artist_names || []).join(" / "),
    artist_ids: (song.artists || []).map((artist) => artist.id).filter(Boolean),
    album: song.album?.name || "",
    publish_date: song.publish_date || "",
    popularity: song.popularity,
    duration: song.duration_sec
  };
}

async function readText(filePath) {
  return fs.readFile(filePath, "utf8").catch(() => "");
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "{}");
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function readUserText(activeUserDir, fallbackDir, filename) {
  return readText(path.join(activeUserDir, filename))
    .then((text) => text || readText(path.join(fallbackDir, filename)));
}

async function readUserJson(activeUserDir, fallbackDir, filename) {
  const active = await readJson(path.join(activeUserDir, filename));
  if (Object.keys(active).length) return active;
  return readJson(path.join(fallbackDir, filename));
}
