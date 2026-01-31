const CACHE_NAME = "mafia42-pwa-v3b-3";
const ASSETS = [
  "./",
  "./index.html",
  "./host.html",
  "./display.html",
  "./manifest.json",
  "./css/theme.css",
  "./css/components.css",
  "./css/layout.css",
  "./css/effects.css",
  "./js/host.js",
  "./js/display.js",
  "./js/util.js",
  "./js/nightResolve.js",
  "./src/constants.js",
  "./src/gameState.js",
  "./src/phase.js",
  "./src/journalist.js",
  "./src/vote.js",
  "./src/execution.js",
  "./src/win.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => (k!==CACHE_NAME)?caches.delete(k):null)))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(()=>{});
      return res;
    }).catch(()=>cached))
  );
});
