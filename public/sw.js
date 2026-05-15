const CACHE = "sonora-v62";
const ASSETS = ["/", "/index.html", "/styles.css?v=62", "/app.js?v=62", "/manifest.json", "/assets/album-sonora.png"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/tts/") || url.pathname === "/stream") return;
  const appShellAsset = event.request.mode === "navigate"
    || url.pathname === "/"
    || url.pathname === "/index.html"
    || url.pathname === "/styles.css"
    || url.pathname === "/app.js"
    || url.pathname === "/sw.js";
  if (appShellAsset) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
