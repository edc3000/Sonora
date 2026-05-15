# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Sonora AI Radio — a local-first personal AI radio. Node.js HTTP/WS server + PWA frontend. Pulls a user's NetEase Cloud Music (NCM) data, builds an LLM prompt with taste/context, asks an OpenAI-compatible model for a queue + host script, synthesizes the host audio via StepFun/Fish TTS, and streams playback state to the browser over WebSocket. Requires Node 18+ (uses native `fetch`, `node:test`, ESM).

## Commands

```bash
npm start            # node server/main.js — serves http://localhost:8080
npm run dev          # same entry point, no watcher
npm test             # node --test (runs tests/*.test.js)
node --test tests/intro.test.js                                          # single test file
node --test --test-name-pattern="selectIntroForTrack" tests/intro.test.js # single test by name
```

The server binds to `127.0.0.1:8080` and immediately calls `ensureRadio()` on startup, so it will hit external services (NCM, OpenAI, TTS) on launch if configured. All external services degrade gracefully — see "Graceful degradation" below.

## Architecture

### Single-process orchestration in `server/main.js`

`main.js` is the **only** entry point and the single source of orchestration. It wires every module by hand (no DI container) and owns the queue/playback state machine. The major closures it exports through `deps`:

- `runShow()` — main "build a fresh show" path: routes intent → builds context → calls LLM → hydrates tracks via NCM → synthesizes first intro's TTS → writes to state → broadcasts.
- `ensureRadio()` — idempotent: called on startup and on `/api/radio/ensure`. Trims to `TARGET_QUEUE_SIZE`, runs a show if empty, refills if `<= MIN_QUEUE_SIZE`.
- `nextTrack()` / `previousTrack()` — move between track/queue/history arrays, lazy-hydrate audio + TTS on demand.
- `refillQueue()` / `warmQueueTts()` — background top-ups, both guarded by single-flight promise locks (`refillPromise`, `warmQueuePromise`) so concurrent callers coalesce.
- `streamTrackAudio()` — proxies NCM audio with Range support, refreshes the stream URL once on failure.

Anything that mutates state goes through `state.update((current) => {...})` and then `hub.broadcast(...)`. Don't write to `state.snapshot` directly.

### Request → playback pipeline

```
HTTP /api/chat or /api/radio/ensure
  └─ routeIntent()           server/router.js — keyword-based control/music/agent split
      └─ ContextBuilder.build()  server/context.js — assembles persona + taste + env + memory
          └─ AgentBrain.compute() server/agent.js — calls OpenAI-compatible LLM, falls back locally
              └─ ncm.hydrateTrack()   server/adapters/ncm.js — fills url/lyric/cover from NCM
                  └─ selectIntroForTrack() server/intro.js — picks/repairs intro text
                      └─ TtsPipeline.synthesize() server/tts.js — StepFun/Fish, content-hash cached
                          └─ StateStore.update()  server/state.js — JSON file at state.db
                              └─ WebSocketHub.broadcast() server/ws.js — pushes to /stream clients
```

### State persistence

- `state.db` is **not SQLite** — it's a single JSON file written via `fs.writeFile`. `StateStore.update()` serializes writes through `this.writeQueue`. Initial schema is in `server/state.js`.
- `cache/tts/<sha>.mp3` — TTS results keyed by content hash + voice; reused across restarts.
- `user/ncm-session.json` — NCM auth cookie + last profile.
- `user/active-user.json` — currently activated NCM userId.
- `user/users/<uid>/{taste.md,routines.md,mood-rules.md,playlists.json,likelist.json,taste_stats.json,profile.json,sync-status.json}` — per-user data written by `taste.js` after NCM sync; read by `context.js` when building the LLM prompt.

When working with user data, always go through `getActiveNcmUserDir(config.userDir)` — it falls back to `config.userDir` (legacy single-user mode) when no NCM user is active, and `readUserText()` in `main.js`/`context.js` reads the active dir first and falls back to the root `user/` dir.

### TTS style versioning

`tts.styleVersion()` is checked on every cached intro (`hasFreshIntroTts`) — if it doesn't match, the intro is re-synthesized. Changing voice/model env vars implicitly invalidates cached intros for affected tracks. Don't rely on a cached `introTtsUrl` without going through `hasFreshIntroTts()`.

### Intro selection (`server/intro.js`)

There are stored intros from the LLM but `selectIntroForTrack()` can override them — it rewrites generic/template-y outputs (e.g. "fits the vibe without stealing focus", "gives the intro a real image") with a story-linked fallback built from lyrics/album/year. The `tests/intro.test.js` suite is the spec for what counts as a bad intro. If you add new intro phrasing patterns, update both the rejection regex in `intro.js` and the tests.

### Adapters (`server/adapters/`)

- `ncm.js` — NetEase Cloud Music API client. Hits `NCM_BASE_URL` (a self-hosted [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) instance). When `NCM_BASE_URL` is unset, returns built-in sample tracks (`local-*` ids) so the player still works.
- `weather.js`, `calendar.js`, `upnp.js` — **placeholder adapters**. They're wired into the context/control flow but return stub data. Replace these with real implementations rather than introducing parallel adapter modules.

### Config (`server/config.js`)

`config` is mutable and gets patched in place by `applyRuntimeConfig()` when settings are saved via `POST /api/settings`. The `.env` file is rewritten with the new values, `process.env` is updated, and `config.*` fields are re-read. Code that captures `config.openai.apiKey` at module load (rather than reading it through the `config` reference at call time) will see stale values after a settings save — `AgentBrain` and `TtsPipeline` already handle this by reading `this.openai` / `this.tts` on each call but `main.js` patches `ncm.baseUrl` explicitly in the `saveSettings` callback because `ncm` cached the URL.

Legacy env vars (`STEP_API_KEY`, `STEPFUN_API_KEY`, `FISH_API_KEY`, `STEP_TTS_*`, `FISH_*`) are honored as fallbacks — don't remove them without checking `config.js`.

### Frontend (`public/`)

Plain ESM in `public/app.js` — no bundler, no framework. `index.html` loads it as `<script type="module">`. WebSocket events from `/stream` drive the UI. `sw.js` is the PWA Service Worker. When iterating on frontend, edit these files directly; there's no build step.

## Graceful degradation (important for testing without keys)

- No `NCM_BASE_URL` → built-in sample tracks, search returns empty.
- No `OPENAI_*` → `AgentBrain.fallback()` picks tracks from the candidate pool using time-of-day rules.
- No `TTS_*` → `synthesize()` returns `{ url: "" }`, frontend uses browser `speechSynthesis`.

This means `npm start` works on a fresh checkout with no `.env`. Don't add hard requirements on external services without preserving a fallback path.

## Prompts

`prompts/dj-persona.md` is the system prompt for the LLM. The frontend can't edit it; it's read from disk on every `ContextBuilder.build()` call, so prompt iteration is just edit-and-reload (no restart needed).
