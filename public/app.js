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
const INTRO_MUSIC_START_SECONDS = 5;
let lastSpokenIntroKey = "";
let lastAudioWarning = "";
const radio = {
  introKey: "",
  segueKey: "",
  transitioning: false,
  primedIntro: null,
  transcriptCues: [],
  transcriptDuration: 0,
  transcriptTime: 0,
  introAudioDuration: 0,
  programPhase: "idle",
  pendingIntroSeek: null,
  isProgramPlaying: false,
  isSeeking: false,
  audioRecoveryKey: "",
  seekReleaseTimer: null,
  musicStartTimer: null,
  coverRefreshKey: "",
  progressPointerActive: false,
  progressPointerHandled: false
};
let lastTranscriptKey = "";
let lastTranscriptCue = -1;

class AmbientEngine {
  constructor() {
    this.context = null;
    this.nodes = [];
  }

  ensureContext() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return null;
    if (!this.context) this.context = new AudioContextCtor();
    if (this.context.state === "suspended") this.context.resume();
    return this.context;
  }

  start() {
    if (this.nodes.length) return;
    if (!this.ensureContext()) return;
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
    await toggleProgramPlayback();
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
  audio.addEventListener("error", () => handleAudioFailure(state.now?.track, "audio error"));
  audio.addEventListener("play", () => {
    if (radio.programPhase === "track") radio.isProgramPlaying = true;
    updatePlayButton();
  });
  audio.addEventListener("pause", () => {
    if (radio.programPhase === "track" && !radio.isSeeking) radio.isProgramPlaying = false;
    updatePlayButton();
  });
  audio.addEventListener("timeupdate", () => {
    if (!state.now?.track || !isMediaPlaying(audio) || radio.isSeeking) return;
    state.now.progress = currentPlaybackProgress();
    renderProgress();
    updateTranscriptProgress();
  });
  hostAudio.addEventListener("play", () => {
    if (isHostPhaseActive()) radio.isProgramPlaying = true;
    updatePlayButton();
  });
  hostAudio.addEventListener("pause", () => {
    if (isHostPhaseActive() && !radio.isSeeking && !isMediaPlaying(audio)) radio.isProgramPlaying = false;
    updatePlayButton();
  });
  hostAudio.addEventListener("timeupdate", () => {
    if (!isHostPhaseActive() || radio.isSeeking) return;
    radio.transcriptTime = introPlaybackTime();
    if (radio.transcriptTime >= musicStartOffset() && !isMediaPlaying(audio)) {
      startTrackPlaybackAtProgramProgress(radio.transcriptTime, { notify: false });
    }
    renderProgress();
    updateTranscriptProgress();
  });
  hostAudio.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(hostAudio.duration) && hostAudio.duration > 0) {
      radio.introAudioDuration = hostAudio.duration;
      renderProgress();
      updateTranscriptProgress();
    }
  });
  audio.addEventListener("loadedmetadata", () => {
    renderProgress();
    updateTranscriptProgress();
  });
  const progressTarget = refs.progress.closest(".progress-row") || refs.progress;
  progressTarget.addEventListener("pointerdown", (event) => seekFromProgressPointer(event, { start: true }), { capture: true });
  progressTarget.addEventListener("pointermove", (event) => seekFromProgressPointer(event), { capture: true });
  progressTarget.addEventListener("pointerup", (event) => seekFromProgressPointer(event, { commit: true, end: true }), { capture: true });
  progressTarget.addEventListener("pointercancel", (event) => seekFromProgressPointer(event, { cancel: true }), { capture: true });
  progressTarget.addEventListener("mousedown", (event) => seekFromProgressPointer(event, { start: true }), { capture: true });
  window.addEventListener("mousemove", (event) => seekFromProgressPointer(event), { capture: true });
  window.addEventListener("mouseup", (event) => seekFromProgressPointer(event, { commit: true, end: true }), { capture: true });
  refs.progress.addEventListener("input", () => {
    if (radio.progressPointerActive || radio.progressPointerHandled) return;
    seekFromProgressControl({ commit: false });
  });
  refs.progress.addEventListener("change", () => {
    if (radio.progressPointerHandled) {
      radio.progressPointerHandled = false;
      return;
    }
    seekFromProgressControl({ commit: true });
  });
  refs.progress.addEventListener("keydown", (event) => {
    if (event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const progress = event.key === "Home" ? 0 : programDuration();
    refs.progress.value = String(progress);
    seekToProgramTime(progress, { commit: true }).catch(() => logEvent("seek failed"));
  });
  $("reloadTaste").addEventListener("click", loadTaste);
  $("saveTaste").addEventListener("click", saveTaste);
}

async function loadNow() {
  const now = await getJson("/api/now");
  if (!now.track || (now.queue?.length || 0) <= 4) {
    logEvent("station ensure");
    renderNow(await postJson("/api/radio/ensure", { trigger: "open" }));
    return;
  }
  renderNow(now);
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
  const previousTrackId = state.now?.track?.id;
  state.now = now;
  const track = now.track;
  if (track?.id && String(track.id) !== String(previousTrackId || "")) {
    radio.introAudioDuration = 0;
    radio.transcriptTime = 0;
    radio.pendingIntroSeek = null;
  }
  const primed = isPrimedIntroFor(now);
  const preserveHostAudio = Boolean(options.preserveHostAudio || primed);
  const suppressSequence = Boolean(options.suppressSequence || primed);
  if (!options.preservePhase) {
    if (now.status === "speaking") radio.programPhase = "intro";
    else if (now.status === "playing") radio.programPhase = "track";
    else if (!track) radio.programPhase = "idle";
  }
  radio.isProgramPlaying = now.status === "speaking" || now.status === "playing"
    ? radio.isProgramPlaying || isProgramActuallyPlaying()
    : false;
  const hostCopy = englishCopy(now.host, "Sonora will shape the next segue from time, weather, taste, and recent plays.");
  refs.hostState.textContent = now.status || "idle";
  refs.hostLine.textContent = hostCopy || "Waiting for a trigger.";
  refs.reasonText.textContent = "";
  refs.segueText.textContent = "";
  refs.trackTitle.textContent = track?.title || "No track yet";
  refs.trackArtist.textContent = track?.artist || "Sonora Host";
  refs.trackCover.src = track?.cover || "/assets/album-sonora.png";
  refreshVisibleTrackMetadata(track);
  refs.duration.textContent = formatTime(track?.duration || 0);
  updatePlayButton();
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
  updatePlayButton();
}

function needsCoverRefresh(track) {
  return Boolean(track?.id)
    && !String(track.id).startsWith("local-")
    && (!track.cover || track.cover === "/assets/album-sonora.png");
}

async function refreshVisibleTrackMetadata(track) {
  if (!needsCoverRefresh(track)) return;
  const key = `${track.id}:${track.cover || ""}`;
  if (radio.coverRefreshKey === key) return;
  radio.coverRefreshKey = key;
  try {
    const next = await postJson("/api/player/refresh-audio", {});
    if (String(next.track?.id || "") !== String(track.id || "")) return;
    if (!needsCoverRefresh(next.track)) {
      renderNow(next, {
        preserveHostAudio: true,
        suppressSequence: true,
        preservePhase: true
      });
    }
  } catch {
    // Keep the current track visible; audio recovery will retry if playback fails.
  }
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
    const preservedIntroTime = packet.mode === "intro" && radio.programPhase === "intro"
      ? Number(radio.transcriptTime || 0)
      : 0;
    lastTranscriptKey = packet.key;
    lastTranscriptCue = -1;
    radio.transcriptCues = packet.cues;
    radio.transcriptDuration = packet.duration;
    radio.transcriptTime = preservedIntroTime;
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
  const pausedInIntro = status === "paused" && isHostPhaseActive();
  if (!pausedInIntro && (status === "playing" || status === "paused") && Array.isArray(track.lyricLines) && track.lyricLines.length) {
    const cues = track.lyricLines
      .filter((line) => line?.text && Number.isFinite(Number(line.time)))
      .map((line) => ({
        time: Number(line.time),
        text: line.text,
        label: "Sonora"
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
    : introCueDuration();
  let time = mode === "lyrics"
    ? (state.now?.status === "playing" && Number.isFinite(audio.currentTime) ? audio.currentTime : Number(state.now?.progress || 0))
    : introCueTime();
  if (mode === "intro") {
    time = introCueTime();
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

function isMediaPlaying(element) {
  return Boolean(element && !element.paused && !element.ended);
}

function isProgramActuallyPlaying() {
  return isMediaPlaying(hostAudio) || isMediaPlaying(audio);
}

function isHostPhaseActive() {
  return radio.programPhase === "intro" || radio.programPhase === "overlap";
}

function isProgramRunning() {
  return radio.isProgramPlaying
    || isProgramActuallyPlaying()
    || state.now?.status === "playing"
    || state.now?.status === "speaking";
}

function updatePlayButton() {
  refs.playBtn.textContent = isProgramRunning() ? "Ⅱ" : "▶";
}

function programTimeFromControl() {
  const duration = programDuration();
  const current = Number(refs.progress.value);
  if (Number.isFinite(current)) return Math.min(duration || current, Math.max(0, current));
  return Math.min(duration || Infinity, Math.max(0, currentProgramProgress()));
}

function musicStartOffset() {
  return INTRO_MUSIC_START_SECONDS;
}

function trackProgressForProgramProgress(progress) {
  const target = Math.max(0, Number(progress || 0) - musicStartOffset());
  return Math.min(target, trackDuration() || target);
}

function introActiveAtProgramProgress(progress) {
  return Number(progress || 0) < introDuration();
}

function trackActiveAtProgramProgress(progress) {
  return Number(progress || 0) >= musicStartOffset() && trackProgressForProgramProgress(progress) < (trackDuration() || Infinity);
}

function phaseForProgramProgress(progress) {
  const introActive = introActiveAtProgramProgress(progress);
  const trackActive = trackActiveAtProgramProgress(progress);
  if (introActive && trackActive) return "overlap";
  if (introActive) return "intro";
  if (trackActive) return "track";
  return "track";
}

function clearMusicStartTimer() {
  clearTimeout(radio.musicStartTimer);
  radio.musicStartTimer = null;
}

function hasPlayableAudio(track) {
  return Boolean(track?.url || (track?.id && !String(track.id).startsWith("local-")));
}

function playableAudioSrc(track) {
  if (!track) return "";
  if (track.id && !String(track.id).startsWith("local-")) {
    const version = encodeURIComponent(String(track.url || "").slice(-36));
    return `/api/player/audio?id=${encodeURIComponent(track.id)}&v=${version}`;
  }
  return track.url || "";
}

function configureAudio(track, status, { preserveHostAudio = false } = {}) {
  const source = playableAudioSrc(track);
  if (source && audio.src !== new URL(source, location.href).href) {
    audio.src = source;
  }
  syncAudioProgress(track, state.now?.progress);
  clearInterval(state.tick);
  if (status === "playing") {
    if (hasPlayableAudio(track)) {
      ambient.stop();
      radio.isProgramPlaying = true;
      updatePlayButton();
      audio.play()
        .then(() => {
          radio.audioRecoveryKey = "";
          radio.isProgramPlaying = true;
          updatePlayButton();
        })
        .catch(() => {
          radio.isProgramPlaying = false;
          updatePlayButton();
          handleAudioFailure(track, "audio unavailable");
        });
    } else {
      audio.pause();
      radio.isProgramPlaying = false;
      updatePlayButton();
      ambient.stop();
      handleAudioFailure(track, "missing audio url");
    }
    state.tick = setInterval(() => {
      if (!state.now?.track) return;
      if (hasPlayableAudio(state.now.track) && Number.isFinite(audio.currentTime)) {
        state.now.progress = currentPlaybackProgress();
      } else {
        state.now.progress = Math.min((state.now.progress || 0) + 1, trackDuration() || 0);
      }
      if (currentProgramProgress() >= programDuration() - 0.15) handleTrackEnded();
      renderProgress();
      updateTranscriptProgress();
    }, 1000);
  } else if (status === "speaking") {
    audio.pause();
    if (!preserveHostAudio && radio.programPhase !== "intro") hostAudio.pause();
    ambient.stop();
  } else {
    audio.pause();
    if (radio.programPhase !== "intro") hostAudio.pause();
    radio.isProgramPlaying = false;
    updatePlayButton();
    ambient.stop();
  }
}

async function handleAudioFailure(track, reason) {
  ambient.stop();
  clearInterval(state.tick);
  radio.isProgramPlaying = false;
  updatePlayButton();
  const key = `${reason}:${track?.id || "none"}:${track?.url || ""}`;
  if (radio.audioRecoveryKey !== key && track?.id && !String(track.id).startsWith("local-")) {
    radio.audioRecoveryKey = key;
    refs.debugStatus.textContent = "refreshing audio";
    logEvent("refresh audio url");
    try {
      const next = await postJson("/api/player/refresh-audio", {});
      if (
        String(next.track?.id || "") === String(track.id || "")
        && next.track?.url
      ) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        radio.programPhase = "track";
        radio.isProgramPlaying = true;
        renderNow({ ...next, status: "playing" }, {
          preservePhase: true,
          suppressSequence: true
        });
        return;
      }
    } catch {
      logEvent("audio refresh failed");
    }
  }

  lastAudioWarning = key;
  logEvent(reason);
  refs.debugStatus.textContent = reason;
  if (state.now?.queue?.length) {
    logEvent("skip unplayable");
    await switchTrack("/api/player/next", state.now.queue[0]);
  }
}

async function sequenceRadio(now) {
  if (!now?.track || now.status !== "speaking" || !now.host) return;
  const key = now.introId || `intro:${now.track.id}:${now.host}:${now.ttsUrl || ""}`;
  if (radio.introKey === key) return;
  radio.introKey = key;
  radio.programPhase = "intro";
  radio.isProgramPlaying = true;
  updatePlayButton();
  logEvent("host intro");
  scheduleTrackStart(0);
  await speakText(now.host, now.ttsUrl, { key });
  if (state.now?.track?.id !== now.track.id || state.now.status !== "speaking") return;
  if (!isMediaPlaying(audio) && currentProgramProgress() < musicStartOffset()) {
    scheduleTrackStart(currentProgramProgress());
    return;
  }
  radio.programPhase = "track";
  radio.isProgramPlaying = true;
  renderNow(await postJson("/api/player/play", { progress: currentPlaybackProgress() }), {
    suppressSequence: true,
    preservePhase: true
  });
}

async function toggleProgramPlayback() {
  if (!state.now?.track) return;

  if (state.now?.status !== "paused" && isProgramActuallyPlaying()) {
    const progress = currentProgramProgress();
    radio.isProgramPlaying = false;
    clearMusicStartTimer();
    radio.transcriptTime = Math.min(progress, introDuration());
    hostAudio.pause();
    audio.pause();
    if ("speechSynthesis" in window) window.speechSynthesis.pause();
    renderNow(await postJson("/api/player/pause", { progress: trackProgressForProgramProgress(progress) }), {
      preserveHostAudio: true,
      suppressSequence: true,
      preservePhase: true
    });
    refs.progress.value = String(progress);
    renderProgress();
    updateTranscriptProgress();
    updatePlayButton();
    return;
  }

  const target = programTimeFromControl();
  await resumeProgramFrom(target);
}

async function resumeProgramFrom(progress = 0) {
  playProgramFrom(progress);
}

async function resumeIntroFrom(progress = 0) {
  playProgramFrom(progress);
}

function playProgramFrom(progress = 0) {
  const duration = programDuration();
  const target = Math.min(duration || Number(progress || 0), Math.max(0, Number(progress || 0)));
  const phase = phaseForProgramProgress(target);
  const introActive = introActiveAtProgramProgress(target);
  const trackActive = trackActiveAtProgramProgress(target);

  clearMusicStartTimer();
  radio.programPhase = phase;
  radio.transcriptTime = Math.min(target, introDuration());
  radio.pendingIntroSeek = radio.transcriptTime;
  radio.isProgramPlaying = true;
  state.now.progress = trackProgressForProgramProgress(target);
  refs.progress.value = String(target);

  if (introActive) {
    startHostIntroPlayback(radio.transcriptTime);
  } else {
    hostAudio.pause();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  if (trackActive) {
    startTrackPlaybackAtProgramProgress(target, { notify: !introActive });
  } else {
    audio.pause();
    scheduleTrackStart(target);
  }

  renderTranscript({
    ...state.now,
    status: introActive ? "speaking" : "playing",
    progress: state.now.progress
  });
  renderProgress();
  updateTranscriptProgress();
  updatePlayButton();
}

function startHostIntroPlayback(progress = 0) {
  if (!state.now?.track) return;
  const hostText = state.now.host || state.now.track?.intro || "";
  if (!hostText) return;
  const trackId = String(state.now.track.id || "");
  const key = state.now.introId || `intro:${trackId}:${hostText}:${state.now.ttsUrl || ""}`;
  radio.pendingIntroSeek = Math.max(0, Number(progress || 0));
  seekHostIntro(radio.pendingIntroSeek);
  radio.introKey = "";
  lastSpokenIntroKey = "";
  speakText(hostText, state.now.ttsUrl, { force: true, key })
    .then(() => handleHostIntroEnded(trackId))
    .catch(() => handleHostIntroEnded(trackId));
}

async function handleHostIntroEnded(trackId) {
  if (String(state.now?.track?.id || "") !== String(trackId || "")) return;
  radio.transcriptTime = introDuration();
  if (!radio.isProgramPlaying && !isMediaPlaying(audio)) return;
  if (!isMediaPlaying(audio) && currentProgramProgress() < musicStartOffset()) {
    scheduleTrackStart(currentProgramProgress());
    return;
  }
  radio.programPhase = "track";
  if (isMediaPlaying(audio)) {
    const progress = currentPlaybackProgress();
    state.now.progress = progress;
    try {
      const next = await postJson("/api/player/play", { progress });
      if (String(next.track?.id || "") === String(state.now?.track?.id || "")) {
        renderNow(next, {
          suppressSequence: true,
          preservePhase: true
        });
      }
    } catch {
      logEvent("play sync failed");
    }
  }
  renderProgress();
  updateTranscriptProgress();
  updatePlayButton();
}

function scheduleTrackStart(programProgress = 0) {
  clearMusicStartTimer();
  if (!state.now?.track || !hasPlayableAudio(state.now.track)) return;
  const target = Math.max(0, Number(programProgress || 0));
  const delay = Math.max(0, musicStartOffset() - target);
  if (delay <= 0) {
    startTrackPlaybackAtProgramProgress(target, { notify: false });
    return;
  }
  radio.musicStartTimer = setTimeout(() => {
    startTrackPlaybackAtProgramProgress(musicStartOffset(), { notify: false });
  }, delay * 1000);
}

function startTrackPlaybackAtProgramProgress(programProgress = musicStartOffset(), { notify = false } = {}) {
  if (!state.now?.track || !hasPlayableAudio(state.now.track)) return;
  const trackProgress = trackProgressForProgramProgress(programProgress);
  state.now.progress = trackProgress;
  syncAudioProgress(state.now.track, trackProgress, { force: true });
  if (introActiveAtProgramProgress(programProgress)) {
    radio.programPhase = "overlap";
  } else {
    radio.programPhase = "track";
  }
  audio.play()
    .then(() => {
      radio.audioRecoveryKey = "";
      radio.isProgramPlaying = true;
      updatePlayButton();
    })
    .catch(() => {
      radio.isProgramPlaying = false;
      updatePlayButton();
      handleAudioFailure(state.now.track, "audio unavailable");
    });
  if (notify) {
    postJson("/api/player/play", { progress: trackProgress }).catch(() => logEvent("play sync failed"));
  }
}

function playIntroFrom(progress = 0) {
  playProgramFrom(progress);
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
  scheduleTrackStart(0);
  await introPromise;
  if (state.now?.track?.id === next.track?.id && state.now.status === "speaking") {
    if (!isMediaPlaying(audio) && currentProgramProgress() < musicStartOffset()) {
      scheduleTrackStart(currentProgramProgress());
      return;
    }
    radio.programPhase = "track";
    renderNow(await postJson("/api/player/play", { progress: currentPlaybackProgress() }), {
      suppressSequence: true,
      preservePhase: true
    });
  }
}

function startGestureIntroForTrack(track) {
  if (!track?.intro || !track?.introTtsUrl) return null;
  const key = `gesture:${track.id}:${Date.now()}`;
  radio.primedIntro = {
    trackId: String(track.id),
    key
  };
  radio.programPhase = "intro";
  radio.isProgramPlaying = true;
  updatePlayButton();
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
  clearMusicStartTimer();
  clearInterval(state.tick);
  state.now.progress = trackDuration() || state.now.progress || 0;
  renderProgress();

  const [nextTrack] = state.now.queue || [];
  radio.transitioning = true;
  audio.pause();
  hostAudio.pause();
  ambient.stop();
  logEvent(nextTrack ? "host intro" : "queue refill");
  const next = await postJson("/api/player/next", {});
  radio.transitioning = false;
  renderNow(next);
}

async function speakText(text, ttsUrl = "", { force = false, key = "" } = {}) {
  if (!text) return Promise.resolve();
  if (!force && key && lastSpokenIntroKey === key && radio.pendingIntroSeek == null) return Promise.resolve();
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
    const startAt = Number(radio.pendingIntroSeek ?? 0);
    const sourceUrl = new URL(ttsUrl, location.href);
    sourceUrl.searchParams.set("_sonora_seek", `${Date.now()}-${Math.round(startAt * 100)}`);
    const source = sourceUrl.href;
    let fallbackTimer = null;
    let playbackStarted = false;
    let settled = false;
    const done = (ok, error = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
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
    const applyStartTime = () => {
      const safeStart = Math.max(0, startAt);
      const upper = Number.isFinite(hostAudio.duration) && hostAudio.duration > 0
        ? Math.max(0, hostAudio.duration - 0.05)
        : safeStart;
      try {
        hostAudio.currentTime = Math.min(safeStart, upper);
      } catch {
        // Some TTS streams do not allow immediate seeking.
      }
    };
    const playAfterSeek = () => {
      if (playbackStarted) return;
      playbackStarted = true;
      clearTimeout(fallbackTimer);
      applyStartTime();
      radio.pendingIntroSeek = null;
      hostAudio.addEventListener("ended", onEnded, { once: true });
      hostAudio.play()
        .then(() => {
          applyStartTime();
          radio.isProgramPlaying = true;
          updatePlayButton();
        })
        .catch((error) => {
          radio.isProgramPlaying = false;
          updatePlayButton();
          done(false, `TTS audio blocked: ${error?.message || "play() failed"}`);
        });
    };
    radio.pendingIntroSeek = null;
    hostAudio.addEventListener("error", onError, { once: true });
    if (hostAudio.readyState >= 1) {
      playAfterSeek();
    } else {
      hostAudio.addEventListener("loadedmetadata", playAfterSeek, { once: true });
      fallbackTimer = setTimeout(playAfterSeek, 1200);
    }
    radio.isProgramPlaying = true;
    updatePlayButton();
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
  const duration = programDuration();
  const rawProgress = radio.isSeeking
    ? Number(refs.progress.value || 0)
    : currentProgramProgress();
  const progress = Math.min(duration || rawProgress, Math.max(0, rawProgress));
  refs.elapsed.textContent = formatTime(progress);
  refs.duration.textContent = formatTime(duration);
  refs.progress.min = "0";
  refs.progress.max = duration ? String(duration) : "0";
  refs.progress.step = "0.01";
  if (!radio.isSeeking) refs.progress.value = duration ? String(progress) : "0";
  updatePlayButton();
}

function currentPlaybackProgress() {
  if (hasPlayableAudio(state.now?.track) && Number.isFinite(audio.currentTime) && audio.src) {
    return Math.min(audio.currentTime, trackDuration() || audio.currentTime);
  }
  return Math.min(state.now?.progress || 0, trackDuration() || Infinity);
}

function introDuration() {
  const estimated = estimateSpeechDuration(state.now?.host || state.now?.track?.intro || "");
  return Math.max(0, Number(
    (Number.isFinite(radio.introAudioDuration) && radio.introAudioDuration > 0)
      ? radio.introAudioDuration
      : estimated
  ));
}

function programDuration() {
  return Math.max(introDuration(), musicStartOffset() + trackDuration());
}

function introPlaybackTime() {
  const duration = introDuration();
  const audioTime = hostAudio.src && Number.isFinite(hostAudio.currentTime) ? hostAudio.currentTime : NaN;
  const time = Number.isFinite(audioTime) && (audioTime > 0 || !hostAudio.paused)
    ? audioTime
    : Number(radio.transcriptTime || 0);
  radio.transcriptTime = Math.min(duration || Infinity, Math.max(0, time));
  return radio.transcriptTime;
}

function introCueDuration() {
  const lastCueEnd = (radio.transcriptCues || []).reduce((max, cue) => Math.max(max, Number(cue.end || cue.time || 0)), 0);
  return Math.max(0, Number(radio.transcriptDuration || lastCueEnd || introDuration()));
}

function introCueTime() {
  const actualDuration = introDuration();
  const cueDuration = introCueDuration();
  const actualTime = introPlaybackTime();
  if (!actualDuration || !cueDuration) return actualTime;
  return Math.min(cueDuration, Math.max(0, (actualTime / actualDuration) * cueDuration));
}

function trackDuration() {
  if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return Number(state.now?.track?.duration || 0);
}

function currentProgramProgress() {
  const candidates = [];
  if (isHostPhaseActive() || state.now?.status === "speaking" || isMediaPlaying(hostAudio)) {
    candidates.push(introPlaybackTime());
  }
  if (audio.src && (isMediaPlaying(audio) || radio.programPhase === "track" || radio.programPhase === "overlap")) {
    candidates.push(musicStartOffset() + currentPlaybackProgress());
  }
  if (!candidates.length) {
    const controlValue = Number(refs.progress?.value);
    if (Number.isFinite(controlValue) && controlValue > 0) candidates.push(controlValue);
    else candidates.push(radio.transcriptTime || musicStartOffset() + Number(state.now?.progress || 0));
  }
  return Math.min(programDuration() || Infinity, Math.max(0, ...candidates));
}

function syncAudioProgress(track, progress, { force = false } = {}) {
  if (!hasPlayableAudio(track) || !Number.isFinite(Number(progress))) return;
  const target = Math.min(Math.max(0, Number(progress)), trackDuration() || Number(progress));
  if (!Number.isFinite(target) || (!force && Math.abs((audio.currentTime || 0) - target) < 0.08)) return;
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

function seekHostIntro(progress) {
  const target = Math.min(Math.max(0, Number(progress || 0)), introDuration() || Number(progress || 0));
  radio.transcriptTime = target;
  radio.pendingIntroSeek = target;
  if (!hostAudio.src) return;
  try {
    hostAudio.currentTime = target;
  } catch {
    hostAudio.addEventListener("loadedmetadata", () => {
      try {
        hostAudio.currentTime = target;
      } catch {
        // Some TTS streams do not allow immediate seeking.
      }
    }, { once: true });
  }
}

function progressFromPointerEvent(event) {
  const duration = programDuration();
  if (!duration || !refs.progress) return null;
  const rect = refs.progress.getBoundingClientRect();
  if (!rect.width) return null;
  const thumbInset = Math.min(22, Math.max(12, rect.height || 16));
  const trackLeft = rect.left + thumbInset;
  const trackRight = rect.right - thumbInset;
  const trackWidth = Math.max(1, trackRight - trackLeft);
  const edgeSnap = Math.min(24, Math.max(10, trackWidth * 0.04));
  let ratio = (event.clientX - trackLeft) / trackWidth;
  if (event.clientX <= trackLeft + edgeSnap) ratio = 0;
  if (event.clientX >= trackRight - edgeSnap) ratio = 1;
  return Math.min(duration, Math.max(0, ratio * duration));
}

function seekFromProgressPointer(event, { start = false, commit = false, end = false, cancel = false } = {}) {
  if (cancel) {
    radio.progressPointerActive = false;
    return;
  }
  if (start) {
    if (event.button != null && event.button !== 0) return;
    radio.progressPointerActive = true;
    radio.progressPointerHandled = true;
    try {
      if (event.pointerId != null) (event.currentTarget || refs.progress).setPointerCapture(event.pointerId);
    } catch {
      // Some browser engines do not allow capture on range inputs.
    }
  }
  if (!radio.progressPointerActive) return;
  event.preventDefault();
  event.stopPropagation();
  const progress = progressFromPointerEvent(event);
  if (progress === null) return;
  refs.progress.value = String(progress);
  seekToProgramTime(progress, { commit }).catch(() => logEvent("seek failed"));
  if (end) {
    radio.progressPointerActive = false;
    try {
      if (event.pointerId != null) (event.currentTarget || refs.progress).releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already be released by the browser.
    }
  }
}

async function seekFromProgressControl({ commit = false } = {}) {
  return seekToProgramTime(Number(refs.progress.value || 0), { commit });
}

async function seekToProgramTime(targetProgress, { commit = false } = {}) {
  const duration = programDuration();
  if (!duration) return;
  clearTimeout(radio.seekReleaseTimer);
  radio.isSeeking = true;
  const progress = Math.min(duration, Math.max(0, Number(targetProgress || 0)));
  refs.progress.value = String(progress);
  const introActive = introActiveAtProgramProgress(progress);
  const trackActive = trackActiveAtProgramProgress(progress);
  const trackProgress = trackProgressForProgramProgress(progress);
  const wasRunning = isProgramRunning();

  try {
    radio.programPhase = phaseForProgramProgress(progress);
    radio.transcriptTime = Math.min(progress, introDuration());
    radio.pendingIntroSeek = radio.transcriptTime;
    state.now.progress = trackProgress;

    if (introActive) {
      seekHostIntro(progress);
    } else {
      hostAudio.pause();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    }

    if (trackActive) {
      syncAudioProgress(state.now.track, trackProgress, { force: true });
    } else {
      audio.pause();
    }

    renderTranscript({
      ...state.now,
      status: introActive ? (wasRunning ? "speaking" : "paused") : (wasRunning ? "playing" : "paused"),
      progress: trackProgress
    });
    renderProgress();
    updateTranscriptProgress();

    if (commit) {
      if (wasRunning) {
        playProgramFrom(progress);
      } else {
        clearMusicStartTimer();
        hostAudio.pause();
        audio.pause();
        radio.isProgramPlaying = false;
        const next = await postJson("/api/player/seek", { progress: trackProgress, status: "paused", silent: true });
        if (String(next.track?.id || "") === String(state.now?.track?.id || "")) {
          renderNow({ ...next, status: "paused", progress: trackProgress }, {
            preserveHostAudio: true,
            suppressSequence: true,
            preservePhase: true
          });
          refs.progress.value = String(progress);
        }
      }
    }
  } catch {
    logEvent("seek failed");
  } finally {
    if (commit) {
      radio.isSeeking = false;
      renderProgress();
      updateTranscriptProgress();
      updatePlayButton();
    } else {
      radio.seekReleaseTimer = setTimeout(() => {
        radio.isSeeking = false;
        renderProgress();
        updateTranscriptProgress();
        updatePlayButton();
      }, 450);
    }
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
