const state = {
  now: null,
  settingsOpen: false,
  playing: false,
  tick: null,
  transitionTimer: null,
  scriptTick: null,
  ncmLoginTimer: null,
  ncmLoggedIn: false,
  voices: []
};

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const hostAudio = $("hostAudio") || new Audio();
const silentAudioSrc = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";
let lastSpokenIntroKey = "";
let lastAudioWarning = "";
const radio = {
  introKey: "",
  segueKey: "",
  transitioning: false,
  primedIntro: null,
  transcriptCues: [],
  transcriptDuration: 0,
  transcriptTime: 0
};
let lastTranscriptKey = "";
let lastTranscriptCue = -1;

class AmbientEngine {
  constructor() {
    this.context = null;
    this.nodes = [];
  }

  ensureContext() {
    if (!this.context) this.context = new AudioContext();
    if (this.context.state === "suspended") this.context.resume();
  }

  start() {
    if (this.nodes.length) return;
    this.ensureContext();
    const master = this.context.createGain();
    master.gain.value = 0.035;
    master.connect(this.context.destination);

    [164.81, 220, 329.63].forEach((frequency, index) => {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = index === 1 ? "triangle" : "sine";
      oscillator.frequency.value = frequency;
      gain.gain.value = index === 1 ? 0.42 : 0.28;
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start();
      this.nodes.push(oscillator, gain);
    });

    this.nodes.push(master);
  }

  stop() {
    for (const node of this.nodes) {
      if (typeof node.stop === "function") {
        try {
          node.stop();
        } catch {
          // Already stopped.
        }
      }
      if (typeof node.disconnect === "function") node.disconnect();
    }
    this.nodes = [];
  }
}

const ambient = new AmbientEngine();

const refs = {
  hostState: $("hostState"),
  hostLine: $("hostLine"),
  eventLog: $("eventLog"),
  socketBadge: $("socketBadge"),
  trackCover: $("trackCover"),
  userAvatar: $("userAvatar"),
  trackTitle: $("trackTitle"),
  trackArtist: $("trackArtist"),
  progress: $("progress"),
  elapsed: $("elapsed"),
  duration: $("duration"),
  playBtn: $("playBtn"),
  nextBtn: $("nextBtn"),
  hostScript: $("hostScript"),
  reasonText: $("reasonText"),
  segueText: $("segueText"),
  queueList: $("queueList"),
  queueCount: $("queueCount"),
  planList: $("planList"),
  debugStatus: $("debugStatus"),
  debugTrack: $("debugTrack"),
  debugTts: $("debugTts"),
  debugVolume: $("debugVolume"),
  ncmLoginBtn: $("ncmLoginBtn"),
  ncmLoginModal: $("ncmLoginModal"),
  ncmQrImage: $("ncmQrImage"),
  ncmQrPlaceholder: $("ncmQrPlaceholder"),
  ncmLoginStatus: $("ncmLoginStatus"),
  ncmAvatar: $("ncmAvatar"),
  ncmName: $("ncmName"),
  ncmSyncLine: $("ncmSyncLine")
};
const hostIdentity = document.querySelector(".host-identity");

const pixelFont = {
  "0": ["111", "101", "101", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "010", "010", "111"],
  "2": ["111", "001", "001", "111", "100", "100", "111"],
  "3": ["111", "001", "001", "111", "001", "001", "111"],
  "4": ["101", "101", "101", "111", "001", "001", "001"],
  "5": ["111", "100", "100", "111", "001", "001", "111"],
  "6": ["111", "100", "100", "111", "101", "101", "111"],
  "7": ["111", "001", "001", "010", "010", "010", "010"],
  "8": ["111", "101", "101", "111", "101", "101", "111"],
  "9": ["111", "101", "101", "111", "001", "001", "111"],
  ":": ["0", "1", "1", "0", "1", "1", "0"]
};

const logoFont = {
  S: ["01110", "10001", "10000", "01110", "00001", "10001", "01110"],
  o: ["0000", "0000", "1110", "1001", "1001", "1001", "1110"],
  n: ["0000", "0000", "1110", "1001", "1001", "1001", "1001"],
  r: ["0000", "0000", "1011", "1100", "1000", "1000", "1000"],
  a: ["0000", "0000", "1110", "0001", "1111", "1001", "1111"]
};

let renderedTime = "";

init();

async function init() {
  loadSpeechVoices();
  renderPixelBrand();
  updateClock();
  setInterval(updateClock, 1000);
  bindSettings();
  bindThemeSwitch();
  bindHeroMatrixBump();
  bindControls();
  await Promise.all([loadNow(), loadPlan(), loadTaste(), loadNcmStatus()]);
  connectStream();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function loadSpeechVoices() {
  if (!("speechSynthesis" in window)) return;
  const update = () => {
    state.voices = window.speechSynthesis.getVoices();
  };
  update();
  window.speechSynthesis.onvoiceschanged = update;
}

function bindThemeSwitch() {
  const saved = localStorage.getItem("sonora-theme") || "dark";
  setTheme(saved);
  document.querySelectorAll("[data-theme-button]").forEach((button) => {
    button.addEventListener("click", () => setTheme(button.dataset.themeButton));
  });
}

function bindHeroMatrixBump() {
  const hero = document.querySelector(".hero-clock");
  const field = document.querySelector(".matrix-field");
  if (!hero || !field) return;
  let dots = [];
  let activePoint = null;
  let frame = 0;

  const build = () => {
    const rect = hero.getBoundingClientRect();
    const spacing = 16;
    const cols = Math.ceil(rect.width / spacing) + 1;
    const rows = Math.ceil(rect.height / spacing) + 1;
    const items = [];
    const html = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = col * spacing;
        const y = row * spacing;
        items.push({ x, y });
        html.push(`<i class="matrix-dot" style="left:${x}px;top:${y}px"></i>`);
      }
    }
    field.innerHTML = html.join("");
    const nodes = Array.from(field.children);
    dots = items.map((dot, index) => ({ ...dot, node: nodes[index] }));
    applyBump();
  };

  const applyBump = () => {
    frame = 0;
    const radius = 138;
    const strength = 36;
    for (const dot of dots) {
      if (!activePoint) {
        dot.node.style.transform = "translate(-50%, -50%)";
        dot.node.style.opacity = "";
        continue;
      }
      const dx = dot.x - activePoint.x;
      const dy = dot.y - activePoint.y;
      const distance = Math.hypot(dx, dy);
      if (distance >= radius) {
        dot.node.style.transform = "translate(-50%, -50%)";
        dot.node.style.opacity = "";
        continue;
      }
      const t = 1 - distance / radius;
      const dome = Math.sin(t * Math.PI * 0.5);
      const nx = distance ? dx / distance : 0;
      const ny = distance ? dy / distance : 0;
      const lift = dome * dome;
      const move = strength * lift;
      const scale = 1 + lift * 1.7;
      dot.node.style.transform = `translate(calc(-50% + ${nx * move}px), calc(-50% + ${ny * move}px)) scale(${scale})`;
      dot.node.style.opacity = String(0.42 + lift * 0.58);
    }
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(applyBump);
  };

  hero.addEventListener("pointermove", (event) => {
    const rect = hero.getBoundingClientRect();
    activePoint = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
    schedule();
  });
  hero.addEventListener("pointerleave", () => {
    activePoint = null;
    schedule();
  });

  build();
  new ResizeObserver(build).observe(hero);
}

function setTheme(theme) {
  document.body.dataset.theme = theme === "light" ? "light" : "dark";
  localStorage.setItem("sonora-theme", document.body.dataset.theme);
  document.querySelectorAll("[data-theme-button]").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeButton === document.body.dataset.theme);
  });
}

function bindSettings() {
  const drawer = $("settingsDrawer");
  const open = () => {
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
  };
  const close = () => {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  };
  $("openSettings").addEventListener("click", open);
  $("closeSettings").addEventListener("click", close);
  $("closeSettingsBackdrop").addEventListener("click", close);
  document.querySelectorAll(".drawer-tab").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.settingsTab;
      document.querySelectorAll(".drawer-tab").forEach((item) => item.classList.toggle("active", item === button));
      document.querySelectorAll(".drawer-view").forEach((view) => view.classList.toggle("active", view.id === `settings-${tab}`));
    });
  });
}

function bindControls() {
  $("chatForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("chatInput");
    const message = input.value.trim();
    input.value = "";
    ambient.ensureContext();
    primeHostAudio();
    setBusy(true);
    try {
      const next = await postJson("/api/chat", { message });
      renderNow(next);
    } finally {
      setBusy(false);
    }
  });

  refs.playBtn.addEventListener("click", async () => {
    ambient.ensureContext();
    primeHostAudio();
    if (!state.now?.track) {
      const next = await postJson("/api/radio/ensure", { trigger: "play" });
      renderNow(next);
      return;
    }
    const endpoint = state.now.status === "playing" ? "/api/player/pause" : "/api/player/play";
    renderNow(await postJson(endpoint, { progress: currentPlaybackProgress() }));
  });

  refs.nextBtn.addEventListener("click", async () => {
    await switchTrack("/api/player/next", state.now?.queue?.[0]);
  });

  refs.ncmLoginBtn.addEventListener("click", () => state.ncmLoggedIn ? logoutNcm() : startNcmLogin());
  $("retryNcmLogin").addEventListener("click", startNcmLogin);
  $("syncNcmTaste").addEventListener("click", syncNcmTaste);
  $("closeNcmLogin").addEventListener("click", closeNcmLogin);
  $("dismissNcmLogin").addEventListener("click", closeNcmLogin);

  $("prevBtn").addEventListener("click", async () => {
    await switchTrack("/api/player/prev", state.now?.history?.[0]);
  });

  audio.addEventListener("ended", () => handleTrackEnded());
  audio.addEventListener("error", () => showAudioWarning(state.now?.track, "audio error"));
  audio.addEventListener("timeupdate", () => {
    if (!state.now?.track || state.now.status !== "playing") return;
    state.now.progress = currentPlaybackProgress();
    renderProgress();
    updateTranscriptProgress();
  });
  refs.progress.addEventListener("input", () => seekFromProgressControl({ commit: false }));
  refs.progress.addEventListener("change", () => seekFromProgressControl({ commit: true }));
  $("reloadTaste").addEventListener("click", loadTaste);
  $("saveTaste").addEventListener("click", saveTaste);
}

async function loadNow() {
  const now = await getJson("/api/now");
  renderNow(now);
  if (!now.track || (now.queue?.length || 0) <= 4) {
    logEvent("station ensure");
    renderNow(await postJson("/api/radio/ensure", { trigger: "open" }));
  }
}

async function loadPlan() {
  const data = await getJson("/api/plan/today");
  renderPlan(data.plan || []);
}

async function loadTaste() {
  const data = await getJson("/api/taste");
  $("tasteText").value = data.taste || "";
  $("routinesText").value = data.routines || "";
  $("moodRulesText").value = data.moodRules || "";
  $("playlistJson").textContent = JSON.stringify(data.playlists || {}, null, 2);
  renderNcmProfile(data.profile, data.syncStatus);
}

async function loadNcmStatus() {
  const data = await getJson("/api/ncm/status").catch((error) => ({
    configured: false,
    error: error.message
  }));
  renderNcmProfile(data.profile, data.syncStatus);
  state.ncmLoggedIn = Boolean(data.loggedIn);
  refs.ncmLoginBtn.textContent = data.loggedIn ? "LOGOUT" : "LOGIN";
  refs.ncmLoginBtn.title = data.configured ? "" : "Set NCM_BASE_URL to enable Netease login";
}

async function saveTaste() {
  let playlists = {};
  try {
    playlists = JSON.parse($("playlistJson").textContent || "{}");
  } catch {
    logEvent("playlist json invalid");
    return;
  }
  await postJson("/api/taste/import", {
    taste: $("tasteText").value,
    routines: $("routinesText").value,
    moodRules: $("moodRulesText").value,
    playlists
  });
  logEvent("taste saved");
}

async function startNcmLogin() {
  openNcmLogin();
  clearInterval(state.ncmLoginTimer);
  refs.ncmQrImage.removeAttribute("src");
  refs.ncmQrImage.hidden = true;
  refs.ncmQrPlaceholder.hidden = false;
  refs.ncmLoginStatus.textContent = "Requesting login QR...";
  try {
    const data = await postJson("/api/ncm/login/qr/create", {});
    refs.ncmQrImage.src = data.qrimg;
    refs.ncmQrImage.hidden = false;
    refs.ncmQrPlaceholder.hidden = true;
    refs.ncmLoginStatus.textContent = "Scan the QR in Netease Cloud Music.";
    pollNcmLogin(data.key);
  } catch (error) {
    refs.ncmLoginStatus.textContent = `Login unavailable: ${error.message}`;
    logEvent("ncm login unavailable");
  }
}

function pollNcmLogin(key) {
  state.ncmLoginTimer = setInterval(async () => {
    try {
      const status = await getJson(`/api/ncm/login/qr/check?key=${encodeURIComponent(key)}`);
      if (status.code === 800) {
        clearInterval(state.ncmLoginTimer);
        refs.ncmLoginStatus.textContent = "QR expired. Request a new one.";
      } else if (status.code === 801) {
        refs.ncmLoginStatus.textContent = "Waiting for scan...";
      } else if (status.code === 802) {
        refs.ncmLoginStatus.textContent = "Scanned. Confirm login on your phone.";
      } else if (status.code === 803) {
        clearInterval(state.ncmLoginTimer);
        refs.ncmLoginStatus.textContent = "Logged in.";
        renderNcmProfile(status.profile);
        closeNcmLogin();
        state.ncmLoggedIn = true;
        refs.ncmLoginBtn.textContent = "LOGOUT";
        if (status.initialized) {
          renderNcmProfile(status.profile, status.syncStatus);
          await loadTaste();
          logEvent("taste loaded");
        } else {
          syncNcmTaste({ background: true });
        }
      } else {
        refs.ncmLoginStatus.textContent = status.message || `Login status ${status.code}`;
      }
    } catch (error) {
      clearInterval(state.ncmLoginTimer);
      refs.ncmLoginStatus.textContent = `Login check failed: ${error.message}`;
    }
  }, 2500);
}

async function syncNcmTaste({ background = false } = {}) {
  const syncButton = $("syncNcmTaste");
  syncButton.disabled = true;
  refs.ncmLoginBtn.disabled = true;
  refs.ncmSyncLine.textContent = background
    ? "Initializing in the background..."
    : "Syncing Netease data...";
  logEvent("ncm sync");
  try {
    const result = await postJson("/api/ncm/sync", {});
    renderNcmProfile(result.profile, result);
    await loadTaste();
    closeNcmLogin();
    logEvent(result.skipped ? "taste ready" : "taste initialized");
  } catch (error) {
    refs.ncmSyncLine.textContent = `Sync failed: ${error.message}`;
    logEvent("ncm sync failed");
  } finally {
    syncButton.disabled = false;
    refs.ncmLoginBtn.disabled = false;
    state.ncmLoggedIn = true;
    refs.ncmLoginBtn.textContent = "LOGOUT";
  }
}

async function logoutNcm() {
  clearInterval(state.ncmLoginTimer);
  refs.ncmLoginBtn.disabled = true;
  $("syncNcmTaste").disabled = true;
  try {
    await postJson("/api/ncm/logout", {});
    state.ncmLoggedIn = false;
    refs.ncmLoginBtn.textContent = "LOGIN";
    renderNcmProfile(null, null);
    $("tasteText").value = "";
    $("routinesText").value = "";
    $("moodRulesText").value = "";
    $("playlistJson").textContent = "{}";
    logEvent("ncm logout");
  } finally {
    refs.ncmLoginBtn.disabled = false;
    $("syncNcmTaste").disabled = false;
  }
}

function openNcmLogin() {
  refs.ncmLoginModal.classList.add("open");
  refs.ncmLoginModal.setAttribute("aria-hidden", "false");
}

function closeNcmLogin() {
  clearInterval(state.ncmLoginTimer);
  refs.ncmLoginModal.classList.remove("open");
  refs.ncmLoginModal.setAttribute("aria-hidden", "true");
}

function renderNcmProfile(profile, syncStatus = null) {
  refs.ncmAvatar.src = profile?.avatarUrl || "/assets/album-sonora.png";
  refs.userAvatar.src = profile?.avatarUrl || "/assets/album-sonora.png";
  refs.ncmName.textContent = profile?.nickname || "Not connected";
  const updatedAt = syncStatus?.updatedAt ? new Date(syncStatus.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "";
  const count = syncStatus?.songCount || syncStatus?.likedPlaylist?.trackCount;
  refs.ncmSyncLine.textContent = count
    ? `${count} liked songs synced${updatedAt ? ` · ${updatedAt}` : ""}`
    : "Netease Cloud Music is waiting for login.";
}

function connectStream() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/stream`);
  socket.addEventListener("open", () => {
    refs.socketBadge.textContent = "live";
    hostIdentity?.classList.add("live");
    logEvent("stream connected");
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    logEvent(message.type);
    if (message.type === "now-playing" || message.type === "track-ended") renderNow(message.payload);
    if (message.type === "host-speaking") renderHost(message.payload);
    if (message.type === "queue-updated" && state.now) {
      state.now.queue = message.payload.queue || [];
      renderQueue(state.now.queue);
    }
    if (message.type === "plan-updated") renderPlan(message.payload.plan || []);
  });
  socket.addEventListener("close", () => {
    refs.socketBadge.textContent = "offline";
    hostIdentity?.classList.remove("live");
    setTimeout(connectStream, 1500);
  });
}

function renderNow(now, options = {}) {
  state.now = now;
  const track = now.track;
  const primed = isPrimedIntroFor(now);
  const preserveHostAudio = Boolean(options.preserveHostAudio || primed);
  const suppressSequence = Boolean(options.suppressSequence || primed);
  const hostCopy = englishCopy(now.host, "Sonora will shape the next segue from time, weather, taste, and recent plays.");
  refs.hostState.textContent = now.status || "idle";
  refs.hostLine.textContent = hostCopy || "Waiting for a trigger.";
  refs.reasonText.textContent = "";
  refs.segueText.textContent = "";
  refs.trackTitle.textContent = track?.title || "No track yet";
  refs.trackArtist.textContent = track?.artist || "Sonora Host";
  refs.trackCover.src = track?.cover || "/assets/album-sonora.png";
  refs.duration.textContent = formatTime(track?.duration || 0);
  refs.playBtn.textContent = now.status === "playing" ? "Ⅱ" : "▶";
  refs.debugStatus.textContent = now.status || "idle";
  refs.debugTrack.textContent = track ? `${track.title} - ${track.artist}` : "-";
  refs.debugTts.textContent = now.ttsUrl || now.ttsError || now.ttsProvider || "-";
  refs.debugVolume.textContent = String(Math.round(audio.volume * 100));
  renderQueue(now.queue || []);
  syncAudioProgress(track, now.progress);
  renderTranscript(now);
  configureAudio(track, now.status, { preserveHostAudio });
  if (!suppressSequence) sequenceRadio(now);
  renderProgress();
}

function renderHost(payload) {
  if (!payload?.say) return;
  const say = englishCopy(payload.say, "The host is preparing the next set.");
  refs.hostLine.textContent = say;
  renderTranscript({ status: "speaking", host: say, track: state.now?.track || null, introId: `host:${say}` });
}

function renderQueue(queue) {
  refs.queueCount.textContent = String(queue.length);
  refs.queueList.innerHTML = queue.length ? queue.map((track, index) => `
    <li>
      <span class="queue-index">${index === 0 ? "▶" : index + 1}</span>
      <span class="item-title">${escapeHtml(track.title)}</span>
      <span class="item-sub">${escapeHtml(track.artist || "")}</span>
    </li>
  `).join("") : `<li><span class="queue-index">--</span><span class="item-title">Queue is empty</span><span class="item-sub">Waiting for Agent</span></li>`;
}

function renderTranscript(now = {}) {
  const packet = buildTranscriptPacket(now);
  const panel = document.querySelector(".host-panel");
  panel?.classList.toggle("is-speaking", now.status === "speaking");
  panel?.classList.toggle("is-playing", now.status === "playing");

  if (packet.key !== lastTranscriptKey) {
    lastTranscriptKey = packet.key;
    lastTranscriptCue = -1;
    radio.transcriptCues = packet.cues;
    radio.transcriptDuration = packet.duration;
    radio.transcriptTime = 0;
    refs.hostScript.dataset.mode = packet.mode;
    refs.hostScript.innerHTML = `
      <div class="transcript-timeline" aria-hidden="true"><span></span></div>
      <div class="transcript-lines">
        ${packet.cues.map((cue, index) => `
          <article class="transcript-line${index === 0 ? " active" : ""}" data-index="${index}">
            <span>${escapeHtml(cue.label)} • ${formatTime(cue.time)}</span>
            <p>${escapeHtml(cue.text)}</p>
          </article>
        `).join("")}
      </div>
    `;
  }

  clearInterval(state.scriptTick);
  if (packet.cues.length > 1 && (packet.mode === "intro" || packet.mode === "lyrics")) {
    state.scriptTick = setInterval(updateTranscriptProgress, 160);
  }
  updateTranscriptProgress();
}

function buildTranscriptPacket(now = {}) {
  const status = now.status || "idle";
  const track = now.track || {};
  if ((status === "playing" || status === "paused") && Array.isArray(track.lyricLines) && track.lyricLines.length) {
    const cues = track.lyricLines
      .filter((line) => line?.text && Number.isFinite(Number(line.time)))
      .map((line) => ({
        time: Number(line.time),
        text: line.text,
        label: track.title || "Lyrics"
      }));
    return {
      key: `lyrics:${track.id || "none"}:${cues.length}:${track.lyricLines[0]?.text || ""}`,
      mode: "lyrics",
      duration: Number(track.duration || cues.at(-1)?.time || 0),
      cues
    };
  }

  const intro = englishCopy(now.host || track.intro || "", "The host is preparing the next song.");
  const introCues = splitIntroCues(intro);
  const duration = introCues.at(-1)?.end || estimateSpeechDuration(intro);
  return {
    key: `intro:${now.introId || track.id || "none"}:${intro}`,
    mode: status === "playing" ? "recap" : "intro",
    duration,
    cues: introCues.length ? introCues : [{ time: 0, end: 3, text: intro, label: "Sonora" }]
  };
}

function splitIntroCues(text) {
  const sentences = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?。！？]+[.!?。！？]?/g) || [];
  let cursor = 0;
  return sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence) => {
      const duration = estimateSpeechDuration(sentence);
      const cue = {
        time: cursor,
        end: cursor + duration,
        text: sentence,
        label: "Sonora"
      };
      cursor += duration;
      return cue;
    });
}

function estimateSpeechDuration(text) {
  const words = (String(text || "").match(/[A-Za-z0-9'-]+|[\u3400-\u9fff]/g) || []).length;
  return Math.min(Math.max(words * 0.42, 2.1), 8.8);
}

function updateTranscriptProgress() {
  const cues = radio.transcriptCues || [];
  if (!cues.length) return;
  const mode = refs.hostScript.dataset.mode || "intro";
  const duration = mode === "lyrics"
    ? Number(state.now?.track?.duration || radio.transcriptDuration || 0)
    : radio.transcriptDuration;
  let time = mode === "lyrics"
    ? (state.now?.status === "playing" && Number.isFinite(audio.currentTime) ? audio.currentTime : Number(state.now?.progress || 0))
    : 0;
  if (mode === "intro") {
    radio.transcriptTime = Math.min(duration || Infinity, Math.max(0, (radio.transcriptTime || 0) + 0.16));
    time = radio.transcriptTime;
  }
  const activeIndex = activeCueIndex(cues, time);
  const timeline = refs.hostScript.querySelector(".transcript-timeline span");
  if (timeline && duration) {
    timeline.style.width = `${Math.min(100, Math.max(0, (time / duration) * 100))}%`;
  }
  if (activeIndex === lastTranscriptCue) return;
  lastTranscriptCue = activeIndex;
  refs.hostScript.querySelectorAll(".transcript-line").forEach((line, index) => {
    line.classList.toggle("past", index < activeIndex);
    line.classList.toggle("active", index === activeIndex);
    line.classList.toggle("future", index > activeIndex);
  });
  const activeLine = refs.hostScript.querySelector(`.transcript-line[data-index="${activeIndex}"]`);
  const scroller = refs.hostScript.querySelector(".transcript-lines");
  if (activeLine && scroller) {
    const top = activeLine.offsetTop - Math.max(18, scroller.clientHeight * 0.34);
    scroller.scrollTo({ top, behavior: "smooth" });
  }
}

function activeCueIndex(cues, time) {
  let active = 0;
  for (let index = 0; index < cues.length; index += 1) {
    if (time + 0.18 >= cues[index].time) active = index;
    else break;
  }
  return active;
}

function renderPlan(plan) {
  refs.planList.innerHTML = plan.length ? plan.map((item) => `
    <li>
      <span class="time">${escapeHtml(item.time)}</span>
      <span>
        <span class="item-title">${escapeHtml(item.title)}</span>
        <span class="item-sub">${escapeHtml(item.mood || item.status || "")}</span>
      </span>
    </li>
  `).join("") : `<li><span class="time">--</span><span class="item-sub">Today&apos;s plan is warming up</span></li>`;
}

function updateClock() {
  const now = new Date();
  const time = now.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const date = now.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).replace(",", "").toUpperCase();
  const clock = document.querySelector(".dot-time");
  if (time !== renderedTime) {
    renderedTime = time;
    renderPixelClock(clock, time);
  }
  clock.setAttribute("aria-label", `Current time ${time}`);
  $("calendarLine").innerHTML = `<span>${weekday}</span><span>${date}</span>`;
}

function renderPixelClock(node, value) {
  node.innerHTML = value.split("").map((char) => {
    const rows = pixelFont[char] || ["0"];
    const width = rows[0].length;
    const cells = rows.flatMap((row) => row.split("")).map((cell) => `<span class="${cell === "1" ? "on" : ""}"></span>`).join("");
    return `<span class="pixel-char ${char === ":" ? "colon" : ""}" style="--cols:${width}">${cells}</span>`;
  }).join("");
}

function renderPixelBrand() {
  document.querySelectorAll(".pixel-brand, .pixel-host-brand").forEach((node) => {
    renderPixelWord(node, "Sonora");
  });
}

function renderPixelWord(node, value) {
  node.innerHTML = value.split("").map((char) => {
    const rows = logoFont[char] || ["1"];
    const width = rows[0].length;
    const cells = rows.flatMap((row) => row.split("")).map((cell) => `<i class="${cell === "1" ? "on" : ""}"></i>`).join("");
    return `<span class="logo-char" style="--cols:${width}">${cells}</span>`;
  }).join("");
}

function englishCopy(value, fallback) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  return isMostlyCjk(text) ? fallback : text;
}

function isMostlyCjk(text) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return cjk > 0 && latin < Math.max(12, cjk * 1.2);
}

function configureAudio(track, status, { preserveHostAudio = false } = {}) {
  if (track?.url && audio.src !== new URL(track.url, location.href).href) {
    audio.src = track.url;
  }
  syncAudioProgress(track, state.now?.progress);
  clearInterval(state.tick);
  if (status === "playing") {
    if (track?.url) {
      ambient.stop();
      audio.play().catch(() => showAudioWarning(track, "audio unavailable"));
    } else {
      audio.pause();
      ambient.stop();
      showAudioWarning(track, "missing audio url");
    }
    state.tick = setInterval(() => {
      if (!state.now?.track) return;
      if (state.now.track.url && Number.isFinite(audio.currentTime)) {
        state.now.progress = currentPlaybackProgress();
      } else {
        state.now.progress = Math.min((state.now.progress || 0) + 1, state.now.track.duration || 0);
      }
      if (state.now.progress >= (state.now.track.duration || 0)) handleTrackEnded();
      renderProgress();
    }, 1000);
  } else if (status === "speaking") {
    audio.pause();
    if (!preserveHostAudio) hostAudio.pause();
    ambient.stop();
  } else {
    audio.pause();
    hostAudio.pause();
    ambient.stop();
  }
}

function showAudioWarning(track, reason) {
  ambient.stop();
  const key = `${reason}:${track?.id || "none"}:${track?.url || ""}`;
  if (lastAudioWarning === key) return;
  lastAudioWarning = key;
  const message = track
    ? `${track.title} has no playable Netease audio URL. Check NCM API or refresh the queue.`
    : "No playable audio URL is available.";
  refs.hostLine.textContent = message;
  renderTranscript({ status: "idle", host: message, track });
  logEvent(reason);
}

async function sequenceRadio(now) {
  if (!now?.track || now.status !== "speaking" || !now.host) return;
  const key = now.introId || `intro:${now.track.id}:${now.host}:${now.ttsUrl || ""}`;
  if (radio.introKey === key) return;
  radio.introKey = key;
  logEvent("host intro");
  await speakText(now.host, now.ttsUrl, { key });
  if (state.now?.track?.id !== now.track.id || state.now.status !== "speaking") return;
  renderNow(await postJson("/api/player/play", { progress: currentPlaybackProgress() }));
}

async function switchTrack(endpoint, anticipatedTrack) {
  ambient.ensureContext();
  if (!anticipatedTrack?.introTtsUrl) primeHostAudio();
  const introPromise = startGestureIntroForTrack(anticipatedTrack);
  const next = await postJson(endpoint, {});
  const samePrimedTrack = introPromise
    && anticipatedTrack?.id
    && String(next.track?.id || "") === String(anticipatedTrack.id);
  renderNow(next, {
    preserveHostAudio: samePrimedTrack,
    suppressSequence: samePrimedTrack
  });
  if (!samePrimedTrack) return;
  await introPromise;
  if (state.now?.track?.id === next.track?.id && state.now.status === "speaking") {
    renderNow(await postJson("/api/player/play", { progress: currentPlaybackProgress() }));
  }
}

function startGestureIntroForTrack(track) {
  if (!track?.intro || !track?.introTtsUrl) return null;
  const key = `gesture:${track.id}:${Date.now()}`;
  radio.primedIntro = {
    trackId: String(track.id),
    key
  };
  const hostCopy = englishCopy(track.intro, "The host is preparing this track.");
  refs.hostLine.textContent = hostCopy;
  renderTranscript({
    status: "speaking",
    host: hostCopy,
    track,
    introId: key,
    ttsUrl: track.introTtsUrl
  });
  refs.debugTts.textContent = track.introTtsUrl;
  logEvent("host intro");
  const promise = speakText(track.intro, track.introTtsUrl, { force: true, key })
    .finally(() => {
      if (radio.primedIntro?.key === key) radio.primedIntro = null;
    });
  radio.primedIntro.promise = promise;
  return promise;
}

function isPrimedIntroFor(now) {
  return Boolean(
    radio.primedIntro
    && now?.status === "speaking"
    && now.track?.id
    && String(now.track.id) === radio.primedIntro.trackId
  );
}

async function handleTrackEnded() {
  if (!state.now?.track || radio.transitioning) return;
  clearInterval(state.tick);
  state.now.progress = state.now.track.duration || state.now.progress || 0;
  renderProgress();

  const [nextTrack] = state.now.queue || [];
  radio.transitioning = true;
  audio.pause();
  ambient.stop();
  logEvent(nextTrack ? "host intro" : "queue refill");
  const next = await postJson("/api/player/next", {});
  radio.transitioning = false;
  renderNow(next);
}

async function speakText(text, ttsUrl = "", { force = false, key = "" } = {}) {
  if (!text) return Promise.resolve();
  if (!force && key && lastSpokenIntroKey === key) return Promise.resolve();
  if (key) lastSpokenIntroKey = key;
  if (ttsUrl) {
    const result = await playHostAudio(ttsUrl);
    if (result.ok) return;
    refs.debugTts.textContent = result.error || `TTS audio failed: ${ttsUrl}`;
    logEvent(result.error || "tts audio failed");
    await waitForHostText(text);
    return;
  }
  return new Promise((resolve) => {
    const fallbackMs = Math.min(Math.max(text.length * 170, 1800), 12000);
    clearTimeout(state.transitionTimer);
    state.transitionTimer = setTimeout(resolve, fallbackMs);
    if (!("speechSynthesis" in window)) {
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
    const speech = getSpeechProfile(text);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = speech.lang;
    utterance.rate = speech.rate;
    utterance.pitch = speech.pitch;
    utterance.volume = 0.9;
    if (speech.voice) utterance.voice = speech.voice;
    utterance.onend = () => {
      clearTimeout(state.transitionTimer);
      resolve();
    };
    utterance.onerror = () => {
      clearTimeout(state.transitionTimer);
      resolve();
    };
    window.speechSynthesis.speak(utterance);
  });
}

function waitForHostText(text) {
  return new Promise((resolve) => {
    clearTimeout(state.transitionTimer);
    state.transitionTimer = setTimeout(resolve, Math.min(Math.max(text.length * 95, 1600), 7000));
  });
}

function playHostAudio(ttsUrl) {
  return new Promise((resolve) => {
    const source = new URL(ttsUrl, location.href).href;
    const done = (ok, error = "") => {
      hostAudio.removeEventListener("ended", onEnded);
      hostAudio.removeEventListener("error", onError);
      resolve({ ok, error });
    };
    const onEnded = () => done(true);
    const onError = () => done(false, `TTS audio error: ${hostAudio.error?.message || ttsUrl}`);
    hostAudio.pause();
    hostAudio.removeAttribute("src");
    hostAudio.load();
    hostAudio.muted = false;
    hostAudio.volume = 1;
    hostAudio.src = source;
    hostAudio.load();
    try {
      hostAudio.currentTime = 0;
    } catch {
      // Some browsers wait for metadata before allowing a seek.
    }
    hostAudio.addEventListener("ended", onEnded, { once: true });
    hostAudio.addEventListener("error", onError, { once: true });
    hostAudio.play().catch((error) => done(false, `TTS audio blocked: ${error?.message || "play() failed"}`));
  });
}

function primeHostAudio() {
  hostAudio.muted = true;
  hostAudio.src = silentAudioSrc;
  hostAudio.play()
    .then(() => {
      hostAudio.pause();
      hostAudio.currentTime = 0;
      hostAudio.muted = false;
    })
    .catch(() => {
      hostAudio.muted = false;
    });
}

function getSpeechProfile(text) {
  if (!state.voices.length && "speechSynthesis" in window) {
    state.voices = window.speechSynthesis.getVoices();
  }
  const lang = isMostlyCjk(text) ? "zh-CN" : "en-US";
  return {
    lang,
    voice: chooseSpeechVoice(lang),
    rate: lang === "zh-CN" ? 0.9 : 0.88,
    pitch: lang === "zh-CN" ? 0.96 : 0.86
  };
}

function chooseSpeechVoice(lang) {
  const voices = state.voices || [];
  const preferred = lang === "zh-CN"
    ? ["xiaoxiao", "tingting", "meijia", "mei-jia", "sinji", "sin-ji", "google 普通话", "mandarin"]
    : ["samantha", "alex", "daniel", "google us english", "google uk english", "microsoft aria", "aria", "karen", "moira"];
  const sameLang = voices.filter((voice) => voice.lang?.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2)));
  for (const token of preferred) {
    const match = sameLang.find((voice) => voice.name.toLowerCase().includes(token));
    if (match) return match;
  }
  return sameLang[0] || voices[0] || null;
}

function renderProgress() {
  const duration = state.now?.track?.duration || 0;
  const progress = Math.min(state.now?.progress || 0, duration);
  refs.elapsed.textContent = formatTime(progress);
  refs.duration.textContent = formatTime(duration);
  refs.progress.value = duration ? String(Math.round((progress / duration) * 100)) : "0";
}

function currentPlaybackProgress() {
  if (state.now?.track?.url && Number.isFinite(audio.currentTime) && audio.currentTime > 0) {
    return Math.min(audio.currentTime, state.now.track.duration || audio.currentTime);
  }
  return Math.min(state.now?.progress || 0, state.now?.track?.duration || Infinity);
}

function syncAudioProgress(track, progress) {
  if (!track?.url || !Number.isFinite(Number(progress))) return;
  const target = Math.min(Math.max(0, Number(progress)), track.duration || Number(progress));
  if (!Number.isFinite(target) || Math.abs((audio.currentTime || 0) - target) < 0.65) return;
  try {
    audio.currentTime = target;
  } catch {
    audio.addEventListener("loadedmetadata", () => {
      try {
        audio.currentTime = target;
      } catch {
        // Some remote streams do not support seeking immediately.
      }
    }, { once: true });
  }
}

function seekFromProgressControl({ commit = false } = {}) {
  const duration = state.now?.track?.duration || 0;
  if (!duration) return;
  const percent = Math.min(100, Math.max(0, Number(refs.progress.value || 0)));
  const progress = (percent / 100) * duration;
  state.now.progress = progress;
  syncAudioProgress(state.now.track, progress);
  renderProgress();
  updateTranscriptProgress();

  if (commit && state.now.status === "paused") {
    postJson("/api/player/seek", { progress })
      .then((next) => {
        if (String(next.track?.id || "") === String(state.now?.track?.id || "")) {
          renderNow(next, { suppressSequence: true });
        }
      })
      .catch(() => logEvent("seek failed"));
  }
}

function logEvent(text) {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${text}`;
  refs.eventLog.prepend(li);
  while (refs.eventLog.children.length > 7) refs.eventLog.lastElementChild.remove();
}

function setBusy(isBusy) {
  $("chatForm").querySelector("button").disabled = isBusy;
  if (isBusy) logEvent("agent compute");
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}
