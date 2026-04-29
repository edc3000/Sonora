import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { StateStore } from "./state.js";
import { NeteaseCloudMusicApi } from "./adapters/ncm.js";
import { AgentBrain } from "./agent.js";
import { ContextBuilder } from "./context.js";
import { RadioScheduler } from "./scheduler.js";
import { TtsPipeline } from "./tts.js";
import { WebSocketHub } from "./ws.js";
import { createHandler } from "./http.js";
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

  const searchResults = input ? await ncm.search(input).catch(() => []) : [];
  const packet = await context.build({ input, trigger, toolResults: { route, searchResults } });
  const decision = await agent.compute(packet);
  const queue = [];
  for (const track of decision.play) {
    queue.push(await ncm.hydrateTrack(track));
  }
  const preparedQueue = await prepareRadioTracks(queue, decision);
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
  return now;
}

async function nextTrack() {
  let trackToPrepare = null;
  await state.update((current) => {
    const [next, ...rest] = current.now.queue;
    if (next) {
      if (current.now.track) current.now.history = [current.now.track, ...(current.now.history || [])].slice(0, 20);
      current.now.track = next;
      current.now.queue = rest;
      current.now.progress = 0;
      current.now.status = "speaking";
      next.intro = next.intro || introForTrack(next, { index: 0, reason: current.now.reason });
      current.now.host = next.intro;
      current.now.introId = crypto.randomUUID();
      current.now.ttsUrl = next.introTtsUrl || "";
      current.now.ttsProvider = next.introTtsProvider || "";
      current.now.ttsError = next.introTtsError || "";
      trackToPrepare = next;
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
  if (trackToPrepare && (!trackToPrepare.introTtsUrl || !trackToPrepare.lyricLines?.length)) {
    if (!trackToPrepare.lyricLines?.length) {
      trackToPrepare = await ncm.hydrateTrack(trackToPrepare);
      await state.update((current) => {
        if (String(current.now.track?.id) === String(trackToPrepare.id)) {
          current.now.track = { ...current.now.track, ...trackToPrepare };
        }
        return current;
      });
    }
    if (trackToPrepare && !trackToPrepare.introTtsUrl) {
      const speech = await tts.synthesize(trackToPrepare.intro, tts.optionsForTrack(trackToPrepare));
      await state.update((current) => {
        if (String(current.now.track?.id) === String(trackToPrepare.id)) {
          current.now.track.introTtsUrl = speech.url;
          current.now.track.introTtsProvider = speech.provider;
          current.now.track.introTtsError = speech.error || "";
          current.now.ttsUrl = speech.url;
          current.now.ttsProvider = speech.provider;
          current.now.ttsError = speech.error || "";
        }
        return current;
      });
    }
  }
  hub.broadcast("track-ended", state.snapshot.now);
  hub.broadcast("now-playing", state.snapshot.now);
  return state.snapshot.now;
}

async function previousTrack() {
  let trackToPrepare = null;
  await state.update((current) => {
    const [previous, ...history] = current.now.history || [];
    if (previous) {
      if (current.now.track) current.now.queue = [current.now.track, ...(current.now.queue || [])];
      current.now.history = history;
      current.now.track = previous;
      current.now.progress = 0;
      current.now.status = "speaking";
      previous.intro = previous.intro || introForTrack(previous, { index: 0, reason: current.now.reason });
      current.now.host = previous.intro;
      current.now.introId = crypto.randomUUID();
      current.now.ttsUrl = previous.introTtsUrl || "";
      current.now.ttsProvider = previous.introTtsProvider || "";
      current.now.ttsError = previous.introTtsError || "";
      trackToPrepare = previous;
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
  if (trackToPrepare && (!trackToPrepare.introTtsUrl || !trackToPrepare.lyricLines?.length)) {
    if (!trackToPrepare.lyricLines?.length) {
      trackToPrepare = await ncm.hydrateTrack(trackToPrepare);
      await state.update((current) => {
        if (String(current.now.track?.id) === String(trackToPrepare.id)) {
          current.now.track = { ...current.now.track, ...trackToPrepare };
        }
        return current;
      });
    }
    if (trackToPrepare && !trackToPrepare.introTtsUrl) {
      const speech = await tts.synthesize(trackToPrepare.intro, tts.optionsForTrack(trackToPrepare));
      await state.update((current) => {
        if (String(current.now.track?.id) === String(trackToPrepare.id)) {
          current.now.track.introTtsUrl = speech.url;
          current.now.track.introTtsProvider = speech.provider;
          current.now.track.introTtsError = speech.error || "";
          current.now.ttsUrl = speech.url;
          current.now.ttsProvider = speech.provider;
          current.now.ttsError = speech.error || "";
        }
        return current;
      });
    }
  }
  hub.broadcast("now-playing", state.snapshot.now);
  hub.broadcast("queue-updated", { queue: state.snapshot.now.queue });
  return state.snapshot.now;
}

async function prepareRadioTracks(tracks, decision) {
  return Promise.all(tracks.map(async (track, index) => {
    const intro = introForTrack(track, { index, reason: decision.reason });
    const speech = intro ? await tts.synthesize(intro, tts.optionsForTrack(track)) : { url: "" };
    return {
      ...track,
      intro,
      introTtsUrl: speech.url,
      introTtsProvider: speech.provider,
      introTtsError: speech.error || ""
    };
  }));
}

function introForTrack(track, { index = 0, reason = "" } = {}) {
  if (!track?.title) return "";
  const title = track.title;
  const artist = track.artist || "this artist";
  const reasons = Array.isArray(track.reasons) ? track.reasons.join("; ") : "";
  const context = englishTrackContext(track);
  const placement = index === 0 ? "We are opening with" : "Coming up next";
  const fit = reason || reasons
    ? "It matches the emotional thread of this set without pulling too much focus."
    : "It gives the room a little shape without getting in the way.";
  return `${placement} ${title} by ${artist}. ${context} ${fit}`.replace(/\s+/g, " ").trim().slice(0, 500);
}

function englishTrackContext(track = {}) {
  const text = `${track.title || ""} ${track.artist || ""} ${track.album || ""}`.toLowerCase();
  if (/the chairs|椅子/.test(text)) {
    return "The Chairs bring that soft Taiwanese indie-pop glow: close harmonies, unhurried guitars, and a melody that feels hand-drawn.";
  }
  if (/周柏豪|pakho/.test(text) && /卫兰|衛蘭|janice/.test(text)) {
    return "It is a Cantonese pop duet built on restraint, where two familiar voices trade tenderness instead of drama.";
  }
  if (/周柏豪|pakho/.test(text)) {
    return "Pakho Chau is at his best in this kind of late-night Cantopop ballad, keeping the feeling controlled but unmistakably present.";
  }
  if (/陈奕迅|陳奕迅|eason/.test(text)) {
    return "Eason Chan turns a pop song into a small piece of theatre, letting the lyric land through phrasing more than volume.";
  }
  if (/容祖儿|容祖兒|joey/.test(text)) {
    return "Joey Yung carries the song with a polished Cantopop clarity, making the hook feel graceful rather than oversized.";
  }
  if (/杨千嬅|楊千嬅|miriam/.test(text)) {
    return "Miriam Yeung brings that bright, bruised Hong Kong-pop character: direct, resilient, and quietly cinematic.";
  }
  if (/张敬轩|張敬軒|hins/.test(text)) {
    return "Hins Cheung leans into the song with the precision of a classic Cantopop balladeer, measured but emotionally open.";
  }
  if (/dear jane|rubberband|beyond/.test(text)) {
    return "It sits in the Hong Kong band tradition, with guitars carrying the emotion as much as the vocal line.";
  }
  if (isCantoneseTrack(track)) {
    return "This is Cantopop in its intimate mode: melodic, lyrical, and built for the small private weather of the day.";
  }
  return "It has the kind of melodic detail that rewards close listening while still leaving space for whatever you are doing.";
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
  readTaste,
  importTaste,
  createNcmLoginQr,
  checkNcmLoginQr,
  readNcmStatus,
  logoutNcm,
  syncNcmProfileAndTaste,
  runShow,
  nextTrack,
  previousTrack,
  broadcast: (type, payload) => hub.broadcast(type, payload)
};

const server = http.createServer(createHandler(deps));
server.on("upgrade", (request, socket) => {
  if (request.url === "/stream") hub.handleUpgrade(request, socket);
  else socket.destroy();
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Sonora AI Radio listening on http://localhost:${config.port}`);
});
