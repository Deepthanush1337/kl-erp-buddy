/* ============ KL ERP Buddy — app-shell service worker ============
   Same-origin GETs: stale-while-revalidate (respond from cache, refresh the
   cache in the background). Navigations: network-first, falling back to the
   cached index.html when offline. Cross-origin traffic (the API, CDNs) and
   non-GET requests are never intercepted — default network passthrough. */

const CACHE = "kl-erp-v4";

// Relative paths resolve against this script's URL, so the cache stays
// scope-correct when the app is served from a subpath (e.g. /klu/).
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "styles.css",
  "config.js",
  "courses.json",
  "manifest.json",
  "icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// Purge superseded shell caches, then take control of open pages right away.
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith("kl-erp-") && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // POST etc.: default network passthrough
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API_BASE, CDNs: passthrough

  // Navigations: network-first so deploys show up immediately; offline falls
  // back to the cached shell.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("index.html", copy));
          }
          return res;
        })
        .catch(() => caches.match("index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  // Other same-origin GETs (app.js, styles.css, …): cache-first, revalidate
  // in the background so the next load picks up fresh copies.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
