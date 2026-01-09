const CACHE_NAME = "tommi38-pwa-v1";

const ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/script.js",
  "/icon-192.png",
  "/icon-512.png"
];

// Install
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch (offline fallback)
self.addEventListener("fetch", event => {
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then(res => res || caches.match("/index.html"))
    )
  );
});
