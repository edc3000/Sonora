import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sendToMainDevice } from "./adapters/upnp.js";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".ico": "image/x-icon"
};

export function createHandler(deps) {
  return async function handle(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname.startsWith("/api/")) return handleApi(request, response, url, deps);
      if (url.pathname.startsWith("/tts/")) return serveTts(request, response, url, deps);
      return serveStatic(request, response, url, deps.publicDir);
    } catch (error) {
      sendJson(response, 500, { error: error.message || "Internal server error" });
    }
  };
}

async function handleApi(request, response, url, deps) {
  if (request.method === "GET" && url.pathname === "/api/now") {
    return sendJson(response, 200, deps.state.snapshot.now);
  }
  if (request.method === "GET" && url.pathname === "/api/player/audio") {
    return deps.streamTrackAudio(url.searchParams.get("id"), request, response);
  }
  if (request.method === "GET" && url.pathname === "/api/taste") {
    return sendJson(response, 200, await deps.readTaste());
  }
  if (request.method === "GET" && url.pathname === "/api/ncm/status") {
    return sendJson(response, 200, await deps.readNcmStatus());
  }
  if (request.method === "GET" && url.pathname === "/api/settings") {
    return sendJson(response, 200, await deps.readSettings());
  }
  if (request.method === "POST" && url.pathname === "/api/settings") {
    const body = await readBody(request);
    return sendJson(response, 200, await deps.saveSettings(body));
  }
  if (request.method === "POST" && url.pathname === "/api/ncm/login/qr/create") {
    return sendJson(response, 200, await deps.createNcmLoginQr());
  }
  if (request.method === "GET" && url.pathname === "/api/ncm/login/qr/check") {
    return sendJson(response, 200, await deps.checkNcmLoginQr(url.searchParams.get("key")));
  }
  if (request.method === "POST" && url.pathname === "/api/ncm/logout") {
    return sendJson(response, 200, await deps.logoutNcm());
  }
  if (request.method === "POST" && url.pathname === "/api/ncm/sync") {
    return sendJson(response, 200, await deps.syncNcmProfileAndTaste());
  }
  if (request.method === "GET" && url.pathname === "/api/plan/today") {
    return sendJson(response, 200, { plan: deps.state.snapshot.plan });
  }
  if (request.method === "POST" && url.pathname === "/api/radio/ensure") {
    const body = await readBody(request);
    return sendJson(response, 200, await deps.ensureRadio({ trigger: body.trigger || "open" }));
  }
  if (request.method === "POST" && url.pathname === "/api/chat") {
    const body = await readBody(request);
    const result = await deps.handleChat({ message: body.message || "", trigger: "user" });
    return sendJson(response, 200, {
      now: result.now,
      reply: result.reply || "",
      actions: (result.actions || []).map(({ name, result: outcome }) => ({ name, ok: outcome?.ok !== false }))
    });
  }
  if (request.method === "POST" && url.pathname === "/api/player/play") {
    const body = await readBody(request);
    await deps.state.update((state) => {
      state.now.status = state.now.track ? "playing" : "idle";
      if (Number.isFinite(Number(body.progress))) {
        state.now.progress = clampProgress(Number(body.progress), state.now.track?.duration);
      }
      return state;
    });
    deps.broadcast("now-playing", deps.state.snapshot.now);
    await sendToMainDevice("play", deps.state.snapshot.now);
    return sendJson(response, 200, deps.state.snapshot.now);
  }
  if (request.method === "POST" && url.pathname === "/api/player/pause") {
    const body = await readBody(request);
    await deps.state.update((state) => {
      state.now.status = "paused";
      if (Number.isFinite(Number(body.progress))) {
        state.now.progress = clampProgress(Number(body.progress), state.now.track?.duration);
      }
      return state;
    });
    deps.broadcast("now-playing", deps.state.snapshot.now);
    await sendToMainDevice("pause");
    return sendJson(response, 200, deps.state.snapshot.now);
  }
  if (request.method === "POST" && url.pathname === "/api/player/seek") {
    const body = await readBody(request);
    await deps.state.update((state) => {
      if (Number.isFinite(Number(body.progress))) {
        state.now.progress = clampProgress(Number(body.progress), state.now.track?.duration);
      }
      if (["idle", "paused", "playing", "speaking"].includes(body.status)) {
        state.now.status = body.status;
      }
      return state;
    });
    if (!body.silent) deps.broadcast("now-playing", deps.state.snapshot.now);
    return sendJson(response, 200, deps.state.snapshot.now);
  }
  if (request.method === "POST" && url.pathname === "/api/player/refresh-audio") {
    return sendJson(response, 200, await deps.refreshCurrentTrackAudio());
  }
  if (request.method === "POST" && url.pathname === "/api/player/next") {
    return sendJson(response, 200, await deps.nextTrack());
  }
  if (request.method === "POST" && url.pathname === "/api/player/prev") {
    return sendJson(response, 200, await deps.previousTrack());
  }
  if (request.method === "POST" && url.pathname === "/api/taste/import") {
    const body = await readBody(request);
    await deps.importTaste(body);
    return sendJson(response, 200, await deps.readTaste());
  }
  sendJson(response, 404, { error: "Not found" });
}

async function serveStatic(request, response, url, publicDir) {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return sendJson(response, 403, { error: "Forbidden" });
  try {
    const body = await fs.readFile(filePath);
    const headers = { "content-type": mime[path.extname(filePath)] || "application/octet-stream" };
    if (requested === "/sw.js") headers["cache-control"] = "no-store";
    if (requested === "/index.html") headers["cache-control"] = "no-cache";
    response.writeHead(200, headers);
    response.end(body);
  } catch {
    const body = await fs.readFile(path.join(publicDir, "index.html"));
    response.writeHead(200, { "content-type": mime[".html"], "cache-control": "no-cache" });
    response.end(body);
  }
}

async function serveTts(request, response, url, deps) {
  const name = path.basename(url.pathname);
  const filePath = path.join(deps.ttsCacheDir, name);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.size) {
      response.writeHead(204);
      response.end();
      return;
    }
    const headers = {
      "content-type": "audio/mpeg",
      "cache-control": "public, max-age=31536000",
      "accept-ranges": "bytes"
    };
    const range = parseByteRange(request.headers.range, stat.size);
    if (range === "invalid") {
      response.writeHead(416, { ...headers, "content-range": `bytes */${stat.size}` });
      response.end();
      return;
    }
    if (range) {
      response.writeHead(206, {
        ...headers,
        "content-length": String(range.end - range.start + 1),
        "content-range": `bytes ${range.start}-${range.end}/${stat.size}`
      });
      createReadStream(filePath, { start: range.start, end: range.end }).pipe(response);
      return;
    }
    response.writeHead(200, { ...headers, "content-length": String(stat.size) });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(204);
    response.end();
  }
}

function parseByteRange(header, size) {
  if (!header) return null;
  const match = String(header).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return "invalid";
  let start = match[1] === "" ? NaN : Number(match[1]);
  let end = match[2] === "" ? NaN : Number(match[2]);

  if (!Number.isFinite(start) && Number.isFinite(end)) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = size - 1;
  }

  if (
    !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || end < start
    || start >= size
  ) {
    return "invalid";
  }

  return { start, end: Math.min(end, size - 1) };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function clampProgress(progress, duration = 0) {
  const max = Math.max(0, Number(duration || 0));
  return Math.min(max || Infinity, Math.max(0, progress));
}
