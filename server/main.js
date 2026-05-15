import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { config, readRuntimeSettings, saveRuntimeSettings } from "./config.js";
import { StateStore } from "./state.js";
import { NeteaseCloudMusicApi } from "./adapters/ncm.js";
import { AgentBrain } from "./agent.js";
import { ContextBuilder } from "./context.js";
import { RadioScheduler } from "./scheduler.js";
import { TtsPipeline } from "./tts.js";
import { WebSocketHub } from "./ws.js";
import { createHandler } from "./http.js";
import { selectIntroForTrack } from "./intro.js";
import {
  activateNcmUser,
  deactivateNcmUser,
  getActiveNcmUser,
  getActiveNcmUserDir,
  getNcmUserDir,
  isNcmUserInitialized,
  loadNcmSession,
  readNcmUserSyncStatus,
  saveNcmSession,
  syncNcmTaste
} from "./taste.js";

const state = new StateStore(config.statePath);
await state.load();

const ncm = new NeteaseCloudMusicApi(config.ncm);
const ncmSession = await loadNcmSession(config.userDir);
if (ncmSession.cookie) ncm.setCookie(ncmSession.cookie);
const context = new ContextBuilder({
  promptsDir: config.promptsDir,
  userDir: config.userDir,
  getUserDir: () => getActiveNcmUserDir(config.userDir),
  stateStore: state
});
const agent = new AgentBrain({ openai: config.openai, ncm });
const tts = new TtsPipeline({ cacheDir: config.ttsCacheDir, tts: config.tts });
const hub = new WebSocketHub();
const MIN_QUEUE_SIZE = 4;
const TARGET_QUEUE_SIZE = 5;
const TARGET_SET_SIZE = TARGET_QUEUE_SIZE + 1;
let refillPromise = null;
let warmQueuePromise = null;
let prepareCurrentPromise = null;

await repairStoredIntros();

async function readTaste() {
  const activeUserDir = await getActiveNcmUserDir(config.userDir);
  const [taste, routines, moodRules, playlists, profile, syncStatus] = await Promise.all([
    readUserText(activeUserDir, "taste.md"),
    readUserText(activeUserDir, "routines.md"),
    readUserText(activeUserDir, "mood-rules.md"),
    readUserJsonText(activeUserDir, "playlists.json"),
    readUserJsonText(activeUserDir, "profile.json"),
    readUserJsonText(activeUserDir, "sync-status.json")
  ]);
  return {
    taste,
    routines,
    moodRules,
    playlists: JSON.parse(playlists || "{}"),
    profile: JSON.parse(profile || "{}"),
    syncStatus: JSON.parse(syncStatus || "{}")
  };
}

async function importTaste(body) {
  const activeUserDir = await getActiveNcmUserDir(config.userDir);
  await fs.mkdir(activeUserDir, { recursive: true });
  const writes = [];
  if (typeof body.taste === "string") writes.push(fs.writeFile(path.join(activeUserDir, "taste.md"), body.taste));
  if (typeof body.routines === "string") writes.push(fs.writeFile(path.join(activeUserDir, "routines.md"), body.routines));
  if (typeof body.moodRules === "string") writes.push(fs.writeFile(path.join(activeUserDir, "mood-rules.md"), body.moodRules));
  if (body.playlists) writes.push(fs.writeFile(path.join(activeUserDir, "playlists.json"), JSON.stringify(body.playlists, null, 2)));
  await Promise.all(writes);
}

async function createNcmLoginQr() {
  return ncm.createLoginQr();
}

async function checkNcmLoginQr(key) {
  if (!key) throw new Error("Missing QR login key");
  const status = await ncm.checkLoginQr(key);
  if (status.code === 803 && status.cookie) {
    ncm.setCookie(status.cookie);
    const profile = await ncm.profile(status.cookie).catch(() => null);
    await saveNcmSession(config.userDir, { cookie: status.cookie, profile });
    if (!profile?.userId) return { ...status, profile, initialized: false };
    const { dataDir } = await activateNcmUser(config.userDir, profile);
    const initialized = await isNcmUserInitialized(config.userDir, profile.userId);
    const syncStatus = initialized ? await readNcmUserSyncStatus(config.userDir, profile.userId) : null;
    return {
      ...status,
      profile,
      initialized,
      syncStatus,
      dataDir: path.relative(config.userDir, dataDir)
    };
  }
  return status;
}

async function readNcmStatus() {
  let [session, active] = await Promise.all([
    loadNcmSession(config.userDir),
    getActiveNcmUser(config.userDir)
  ]);
  if (!active?.userId && session.profile?.userId) {
    const activated = await activateNcmUser(config.userDir, session.profile);
    active = activated.active;
  } else if (
    active?.userId
    && session.profile?.userId
    && String(active.userId) === String(session.profile.userId)
    && !(await isNcmUserInitialized(config.userDir, active.userId))
  ) {
    const activated = await activateNcmUser(config.userDir, session.profile);
    active = activated.active;
  }
  const activeUserDir = active?.userId ? getNcmUserDir(config.userDir, active.userId) : config.userDir;
  const [profile, syncStatus] = await Promise.all([
    fs.readFile(path.join(activeUserDir, "profile.json"), "utf8").then(JSON.parse).catch(() => null),
    fs.readFile(path.join(activeUserDir, "sync-status.json"), "utf8").then(JSON.parse).catch(() => null)
  ]);
  return {
    configured: ncm.configured,
    loggedIn: Boolean(session.cookie || ncm.cookie),
    profile: profile || session.profile || null,
    syncStatus
  };
}

async function logoutNcm() {
  ncm.setCookie("");
  await Promise.all([
    saveNcmSession(config.userDir, { cookie: "", profile: null }),
    deactivateNcmUser(config.userDir)
  ]);
  return readNcmStatus();
}

async function syncNcmProfileAndTaste() {
  return syncNcmTaste({ ncm, userDir: config.userDir, openai: config.openai });
}

async function readUserText(activeUserDir, filename) {
  const activePath = path.join(activeUserDir, filename);
  const rootPath = path.join(config.userDir, filename);
  return fs.readFile(activePath, "utf8").catch(() => fs.readFile(rootPath, "utf8").catch(() => ""));
}

async function readUserJsonText(activeUserDir, filename) {
  const text = await readUserText(activeUserDir, filename);
  return text || "{}";
}

async function runShow({ input = "", trigger = "user", route = null } = {}) {
  await state.appendMessage({ role: "user", content: input || `[${trigger}]` });
  hub.broadcast("host-speaking", { say: "I am organizing the context and queue." });

  const { decision, preparedQueue } = await buildPreparedQueue({ input, trigger, route });
  const [track] = preparedQueue;

  await state.update((current) => {
    const [, ...rest] = preparedQueue;
    current.now = {
      ...current.now,
      status: track?.intro ? "speaking" : "playing",
      host: track?.intro || decision.say,
      introId: track ? crypto.randomUUID() : "",
      reason: decision.reason,
      segue: decision.segue,
      track: track || current.now.track,
      queue: rest,
      history: [],
      progress: 0,
      ttsUrl: track?.introTtsUrl || "",
      ttsProvider: track?.introTtsProvider || "",
      ttsError: track?.introTtsError || ""
    };
    if (track) current.plays.unshift({
      id: crypto.randomUUID(),
      playedAt: new Date().toISOString(),
      title: track.title,
      artist: track.artist
    });
    current.plays = current.plays.slice(0, 120);
    current.messages.unshift({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      role: "assistant",
      content: decision.say
    });
    current.messages = current.messages.slice(0, 80);
    return current;
  });

  const now = state.snapshot.now;
  hub.broadcast("host-speaking", { say: now.host, ttsUrl: now.ttsUrl });
  hub.broadcast("now-playing", now);
  hub.broadcast("queue-updated", { queue: now.queue });
  warmQueueTts({ limit: 2 });
  return now;
}

async function buildPreparedQueue({ input = "", trigger = "auto", route = null, ttsMode = "first" } = {}) {
  const searchResults = input ? await ncm.search(input).catch(() => []) : [];
  const packet = await context.build({ input, trigger, toolResults: { route, searchResults } });
  const decision = await agent.compute(packet);
  const selected = fillQueueFromTasteSeeds(decision.play || [], packet.fragments);
  const queue = [];
  for (const track of selected) {
    queue.push(await withTimeout(ncm.hydrateTrack(track), 10000, track));
  }
  return {
    decision,
    preparedQueue: await prepareRadioTracks(queue, decision, { ttsMode })
  };
}

async function ensureRadio({ trigger = "open" } = {}) {
  const now = state.snapshot.now;
  const hasTrack = Boolean(now.track);
  const queueSize = now.queue?.length || 0;
  if (queueSize > TARGET_QUEUE_SIZE) {
    await trimQueueToTarget();
  }
  if (!hasTrack) {
    return runShow({
      input: "Start Sonora as a personal radio station. Build a ready-to-play queue from the user's taste, current time, and recent listening context.",
      trigger
    });
  }
  if (now.track?.intro && !hasFreshIntroTts(now.track)) {
    await refreshCurrentIntroTts(now.track);
  }
  if (queueSize <= MIN_QUEUE_SIZE) {
    await refillQueue({ trigger });
  }
  return state.snapshot.now;
}

async function trimQueueToTarget() {
  await state.update((current) => {
    current.now.queue = (current.now.queue || []).slice(0, TARGET_QUEUE_SIZE);
    return current;
  });
  hub.broadcast("queue-updated", { queue: state.snapshot.now.queue });
  hub.broadcast("now-playing", state.snapshot.now);
}

async function refillQueue({ trigger = "auto-refill" } = {}) {
  if (refillPromise) return refillPromise;
  refillPromise = refillQueueNow({ trigger }).finally(() => {
    refillPromise = null;
  });
  return refillPromise;
}

async function refillQueueNow({ trigger = "auto-refill" } = {}) {
  const before = state.snapshot.now;
  const existing = new Set([
    before.track,
    ...(before.queue || []),
    ...(before.history || [])
  ].filter(Boolean).map(trackKey));
  const needed = Math.max(0, TARGET_QUEUE_SIZE - (before.queue?.length || 0));
  if (!needed) return before;

  const { decision, preparedQueue } = await buildPreparedQueue({
    input: "Continue the current Sonora radio set with taste-aligned songs. Avoid repeats from the current track, upcoming queue, and recent plays. Keep the flow coherent for a private radio station.",
    trigger,
    ttsMode: "none"
  });
  const candidates = preparedQueue
    .filter((track) => {
      const key = trackKey(track);
      if (!key || existing.has(key)) return false;
      existing.add(key);
      return true;
    });

  if (!candidates.length) return state.snapshot.now;

  let appendedCount = 0;
  await state.update((current) => {
    const liveExisting = new Set([
      current.now.track,
      ...(current.now.queue || []),
      ...(current.now.history || [])
    ].filter(Boolean).map(trackKey));
    const liveNeeded = Math.max(0, TARGET_QUEUE_SIZE - (current.now.queue?.length || 0));
    const additions = candidates
      .filter((track) => {
        const key = trackKey(track);
        if (!key || liveExisting.has(key)) return false;
        liveExisting.add(key);
        return true;
      })
      .slice(0, liveNeeded);

    appendedCount = additions.length;
    if (!appendedCount) return current;

    current.now.queue = [...(current.now.queue || []), ...additions].slice(0, TARGET_QUEUE_SIZE);
    current.now.reason = current.now.reason || decision.reason;
    current.now.segue = decision.segue || current.now.segue;
    current.messages.unshift({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      role: "assistant",
      content: `Auto-refilled ${appendedCount} tracks for the station.`
    });
    current.messages = current.messages.slice(0, 80);
    return current;
  });
  if (!appendedCount) return state.snapshot.now;
  hub.broadcast("queue-updated", { queue: state.snapshot.now.queue });
  hub.broadcast("now-playing", state.snapshot.now);
  warmQueueTts({ limit: 2 });
  return state.snapshot.now;
}

function trackKey(track = {}) {
  if (!track) return "";
  return String(track.id || `${track.title || ""}::${track.artist || ""}`).toLowerCase();
}

function fillQueueFromTasteSeeds(tracks = [], fragments = {}) {
  const selected = [];
  const used = new Set([
    state.snapshot.now.track,
    ...(state.snapshot.now.queue || []),
    ...(state.snapshot.now.history || [])
  ].filter(Boolean).map(trackKey));

  const add = (track) => {
    const key = trackKey(track);
    if (!track?.title || !track?.artist || !key || used.has(key)) return;
    selected.push(track);
    used.add(key);
  };

  for (const track of tracks) {
    if (selected.length >= TARGET_SET_SIZE) break;
    add(track);
  }

  for (const seed of fragments.musicTaste?.songSeeds || []) {
    if (selected.length >= TARGET_SET_SIZE) break;
    add({
      id: String(seed.id || ""),
      title: seed.title,
      artist: seed.artist,
      album: seed.album,
      publish_date: seed.publish_date,
      source: "netease:liked-seed",
      url: "",
      cover: "/assets/album-sonora.png",
      duration: seed.duration || 240,
      popularity: seed.popularity
    });
  }

  return selected.slice(0, TARGET_SET_SIZE);
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

async function nextTrack() {
  if (!(state.snapshot.now.queue || []).length) {
    await refillQueue({ trigger: "empty-next" });
  }
  await state.update((current) => {
    const [next, ...rest] = current.now.queue;
    if (next) {
      if (current.now.track) current.now.history = [current.now.track, ...(current.now.history || [])].slice(0, 20);
      current.now.track = next;
      current.now.queue = rest;
      current.now.progress = 0;
      current.now.status = "speaking";
      applySelectedIntro(next, { index: 0, reason: current.now.reason });
      current.now.host = next.intro;
      current.now.introId = crypto.randomUUID();
      current.now.ttsUrl = hasFreshIntroTts(next) ? next.introTtsUrl : "";
      current.now.ttsProvider = hasFreshIntroTts(next) ? next.introTtsProvider : "";
      current.now.ttsError = hasFreshIntroTts(next) ? next.introTtsError : "";
      current.plays.unshift({
        id: crypto.randomUUID(),
        playedAt: new Date().toISOString(),
        title: next.title,
        artist: next.artist
      });
    } else {
      current.now.status = current.now.track ? "paused" : "idle";
      current.now.host = current.now.track
        ? "The queue is empty. Ask Sonora for another set and I will build the next run."
        : "There is no track loaded yet. Start a radio set first.";
      current.now.introId = "";
      current.now.ttsUrl = "";
      current.now.ttsProvider = "";
      current.now.ttsError = "";
    }
    return current;
  });
  hub.broadcast("track-ended", state.snapshot.now);
  hub.broadcast("now-playing", state.snapshot.now);
  prepareCurrentTrack().catch((error) => console.warn(`Prepare current failed: ${error.message}`));
  const remaining = state.snapshot.now.queue?.length || 0;
  if (remaining <= MIN_QUEUE_SIZE) {
    refillQueue({ trigger: "low-watermark" }).catch((error) => console.warn(`Queue refill failed: ${error.message}`));
  }
  warmQueueTts({ limit: 2 });
  return state.snapshot.now;
}

async function previousTrack() {
  await state.update((current) => {
    const [previous, ...history] = current.now.history || [];
    if (previous) {
      if (current.now.track) current.now.queue = [current.now.track, ...(current.now.queue || [])];
      current.now.history = history;
      current.now.track = previous;
      current.now.progress = 0;
      current.now.status = "speaking";
      applySelectedIntro(previous, { index: 0, reason: current.now.reason });
      current.now.host = previous.intro;
      current.now.introId = crypto.randomUUID();
      current.now.ttsUrl = hasFreshIntroTts(previous) ? previous.introTtsUrl : "";
      current.now.ttsProvider = hasFreshIntroTts(previous) ? previous.introTtsProvider : "";
      current.now.ttsError = hasFreshIntroTts(previous) ? previous.introTtsError : "";
    } else {
      current.now.status = current.now.track ? "paused" : "idle";
      current.now.host = current.now.track
        ? "There is no previous track in this session yet."
        : "There is no track loaded yet. Start a radio set first.";
      current.now.introId = "";
      current.now.ttsUrl = "";
      current.now.ttsProvider = "";
      current.now.ttsError = "";
    }
    return current;
  });
  hub.broadcast("now-playing", state.snapshot.now);
  hub.broadcast("queue-updated", { queue: state.snapshot.now.queue });
  prepareCurrentTrack().catch((error) => console.warn(`Prepare current failed: ${error.message}`));
  warmQueueTts({ limit: 2 });
  return state.snapshot.now;
}

async function refreshCurrentTrackAudio() {
  const currentTrack = state.snapshot.now.track;
  if (!currentTrack) return state.snapshot.now;
  const refreshed = await ncm.hydrateTrack({
    ...currentTrack,
    url: "",
    lyricLines: currentTrack.lyricLines || []
  }).catch(() => null);
  if (!refreshed?.url) return state.snapshot.now;
  await state.update((current) => {
    if (String(current.now.track?.id || "") !== String(currentTrack.id || "")) return current;
    current.now.track = {
      ...current.now.track,
      ...refreshed,
      introTtsUrl: current.now.track.introTtsUrl || refreshed.introTtsUrl || "",
      introTtsProvider: current.now.track.introTtsProvider || refreshed.introTtsProvider || "",
      introTtsError: current.now.track.introTtsError || refreshed.introTtsError || "",
      introTtsStyle: current.now.track.introTtsStyle || refreshed.introTtsStyle || ""
    };
    applySelectedIntro(current.now.track, { index: 0, reason: current.now.reason });
    if (current.now.status === "speaking") current.now.host = current.now.track.intro;
    return current;
  });
  hub.broadcast("now-playing", state.snapshot.now);
  return state.snapshot.now;
}

async function streamTrackAudio(id, request, response) {
  const track = findTrackById(id);
  if (!track) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Track not found");
    return;
  }

  let url = track.url || "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!url || attempt > 0) {
      url = await ncm.songUrl(track.id).catch(() => "");
      if (url) await patchTrackAudioUrl(track.id, url);
    }
    if (!url) continue;

    const upstream = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 Sonora/0.1",
        "referer": "https://music.163.com/",
        "accept-encoding": "identity",
        connection: "keep-alive",
        ...(request.headers.range ? { range: request.headers.range } : {})
      }
    }).catch(() => null);
    if (!upstream?.ok || !upstream.body) {
      url = "";
      continue;
    }

    const headers = {
      "content-type": upstream.headers.get("content-type") || "audio/mpeg",
      "cache-control": "no-store",
      "accept-ranges": upstream.headers.get("accept-ranges") || "bytes"
    };
    for (const header of ["content-length", "content-range"]) {
      const value = upstream.headers.get(header);
      if (value) headers[header] = value;
    }
    response.writeHead(upstream.status === 206 ? 206 : 200, headers);
    Readable.fromWeb(upstream.body).pipe(response);
    return;
  }

  response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
  response.end("Audio URL unavailable");
}

function findTrackById(id) {
  const key = String(id || "");
  if (!key) return null;
  const now = state.snapshot.now;
  const tracks = [
    now.track,
    ...(now.queue || []),
    ...(now.history || [])
  ].filter(Boolean);
  return tracks.find((track) => String(track.id || "") === key) || null;
}

async function patchTrackAudioUrl(id, url) {
  const key = String(id || "");
  if (!key || !url) return;
  await state.update((current) => {
    const patch = (track) => (
      track && String(track.id || "") === key
        ? { ...track, url }
        : track
    );
    current.now.track = patch(current.now.track);
    current.now.queue = (current.now.queue || []).map(patch);
    current.now.history = (current.now.history || []).map(patch);
    return current;
  });
}

function hasFreshIntroTts(track = {}) {
  return Boolean(track?.introTtsUrl && track?.introTtsStyle === tts.styleVersion());
}

function applySelectedIntro(track, options = {}) {
  if (!track) return "";
  const intro = selectIntroForTrack(track, options);
  if (intro && intro !== track.intro) {
    track.intro = intro;
    track.introTtsUrl = "";
    track.introTtsProvider = "";
    track.introTtsError = "";
    track.introTtsStyle = "";
  }
  return track.intro || intro || "";
}

async function repairStoredIntros() {
  let changed = false;
  await state.update((current) => {
    const reason = current.now.reason || "";
    const currentIntro = current.now.track?.intro || "";
    if (current.now.track) {
      applySelectedIntro(current.now.track, { index: 0, reason });
      if (current.now.track.intro !== currentIntro) {
        changed = true;
        if (current.now.host === currentIntro || current.now.status === "speaking") {
          current.now.host = current.now.track.intro;
          current.now.introId = crypto.randomUUID();
          current.now.ttsUrl = "";
          current.now.ttsProvider = "";
          current.now.ttsError = "";
        }
      }
    }
    current.now.queue = (current.now.queue || []).map((track, index) => {
      const before = track?.intro || "";
      applySelectedIntro(track, { index: index + 1, reason });
      if (track?.intro !== before) changed = true;
      return track;
    });
    current.now.history = (current.now.history || []).map((track, index) => {
      const before = track?.intro || "";
      applySelectedIntro(track, { index: index + 1, reason });
      if (track?.intro !== before) changed = true;
      return track;
    });
    return current;
  });
  return changed;
}

async function refreshCurrentIntroTts(track) {
  const speech = await tts.synthesize(track.intro, tts.optionsForTrack(track));
  await state.update((current) => {
    if (String(current.now.track?.id || "") !== String(track.id || "")) return current;
    current.now.track = {
      ...current.now.track,
      introTtsUrl: speech.url,
      introTtsProvider: speech.provider,
      introTtsError: speech.error || "",
      introTtsStyle: speech.url ? tts.styleVersion() : ""
    };
    current.now.ttsUrl = speech.url;
    current.now.ttsProvider = speech.provider;
    current.now.ttsError = speech.error || "";
    return current;
  });
  hub.broadcast("now-playing", state.snapshot.now);
  return state.snapshot.now;
}

async function prepareRadioTracks(tracks, decision, { ttsMode = "first" } = {}) {
  return Promise.all(tracks.map(async (track, index) => {
    const intro = selectIntroForTrack(track, { index, reason: decision.reason });
    const shouldSynthesize = intro && (ttsMode === "all" || (ttsMode === "first" && index === 0));
    const speech = shouldSynthesize ? await tts.synthesize(intro, tts.optionsForTrack(track)) : { url: "" };
    return {
      ...track,
      intro,
      introTtsUrl: speech.url,
      introTtsProvider: speech.provider,
      introTtsError: speech.error || "",
      introTtsStyle: speech.url ? tts.styleVersion() : ""
    };
  }));
}

function prepareCurrentTrack() {
  if (prepareCurrentPromise) return prepareCurrentPromise;
  prepareCurrentPromise = prepareCurrentTrackNow().finally(() => {
    prepareCurrentPromise = null;
  });
  return prepareCurrentPromise;
}

async function prepareCurrentTrackNow() {
  const startTrack = state.snapshot.now.track;
  if (!startTrack) return;
  const trackId = String(startTrack.id || "");
  let working = startTrack;

  if (!working.lyricLines?.length || !working.url) {
    const hydrated = await ncm.hydrateTrack(working).catch(() => null);
    if (hydrated && String(state.snapshot.now.track?.id || "") === trackId) {
      await state.update((current) => {
        if (String(current.now.track?.id || "") !== trackId) return current;
        current.now.track = { ...current.now.track, ...hydrated };
        applySelectedIntro(current.now.track, { index: 0, reason: current.now.reason });
        if (current.now.status === "speaking") current.now.host = current.now.track.intro;
        return current;
      });
      working = state.snapshot.now.track;
      hub.broadcast("now-playing", state.snapshot.now);
    }
  }

  if (!working || String(state.snapshot.now.track?.id || "") !== trackId) return;
  if (hasFreshIntroTts(working)) return;

  const speech = await tts.synthesize(working.intro, tts.optionsForTrack(working));
  if (String(state.snapshot.now.track?.id || "") !== trackId) return;
  await state.update((current) => {
    if (String(current.now.track?.id || "") !== trackId) return current;
    current.now.track = {
      ...current.now.track,
      introTtsUrl: speech.url,
      introTtsProvider: speech.provider,
      introTtsError: speech.error || "",
      introTtsStyle: speech.url ? tts.styleVersion() : ""
    };
    current.now.ttsUrl = speech.url;
    current.now.ttsProvider = speech.provider;
    current.now.ttsError = speech.error || "";
    return current;
  });
  hub.broadcast("now-playing", state.snapshot.now);
}

function warmQueueTts({ limit = 2 } = {}) {
  if (warmQueuePromise) return warmQueuePromise;
  warmQueuePromise = warmQueueTtsNow({ limit }).finally(() => {
    warmQueuePromise = null;
  });
  return warmQueuePromise;
}

async function warmQueueTtsNow({ limit = 2 } = {}) {
  const targets = (state.snapshot.now.queue || [])
    .filter((track) => track?.intro && !hasFreshIntroTts(track))
    .slice(0, limit);
  if (!targets.length) return state.snapshot.now;

  let changed = false;
  for (const target of targets) {
    const key = trackKey(target);
    const speech = await tts.synthesize(target.intro, tts.optionsForTrack(target));
    await state.update((current) => {
      const queueIndex = (current.now.queue || []).findIndex((track) => trackKey(track) === key);
      if (queueIndex >= 0 && !hasFreshIntroTts(current.now.queue[queueIndex])) {
        current.now.queue[queueIndex] = {
          ...current.now.queue[queueIndex],
          introTtsUrl: speech.url,
          introTtsProvider: speech.provider,
          introTtsError: speech.error || "",
          introTtsStyle: speech.url ? tts.styleVersion() : ""
        };
        changed = true;
      }
      if (trackKey(current.now.track) === key && !hasFreshIntroTts(current.now.track)) {
        current.now.track = {
          ...current.now.track,
          introTtsUrl: speech.url,
          introTtsProvider: speech.provider,
          introTtsError: speech.error || "",
          introTtsStyle: speech.url ? tts.styleVersion() : ""
        };
        current.now.ttsUrl = speech.url;
        current.now.ttsProvider = speech.provider;
        current.now.ttsError = speech.error || "";
        changed = true;
      }
      return current;
    });
  }
  if (changed) {
    hub.broadcast("queue-updated", { queue: state.snapshot.now.queue });
    hub.broadcast("now-playing", state.snapshot.now);
  }
  return state.snapshot.now;
}

const scheduler = new RadioScheduler({
  runShow,
  broadcast: (type, payload) => {
    if (type === "plan-updated" && payload.plan) {
      state.update((current) => {
        current.plan = payload.plan;
        return current;
      }).then(() => hub.broadcast(type, payload));
      return;
    }
    hub.broadcast(type, payload);
  }
});
scheduler.start();

const deps = {
  state,
  publicDir: config.publicDir,
  ttsCacheDir: config.ttsCacheDir,
  readSettings: () => readRuntimeSettings(),
  saveSettings: (input) => {
    const settings = saveRuntimeSettings(input);
    ncm.baseUrl = config.ncm.baseUrl.replace(/\/$/, "");
    return settings;
  },
  readTaste,
  importTaste,
  createNcmLoginQr,
  checkNcmLoginQr,
  readNcmStatus,
  logoutNcm,
  syncNcmProfileAndTaste,
  ensureRadio,
  runShow,
  nextTrack,
  previousTrack,
  refreshCurrentTrackAudio,
  streamTrackAudio,
  broadcast: (type, payload) => hub.broadcast(type, payload)
};

const server = http.createServer(createHandler(deps));
server.on("upgrade", (request, socket) => {
  if (request.url === "/stream") hub.handleUpgrade(request, socket);
  else socket.destroy();
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Sonora AI Radio listening on http://localhost:${config.port}`);
  ensureRadio({ trigger: "startup" }).catch((error) => {
    console.warn(`Startup radio ensure failed: ${error.message}`);
  });
});
