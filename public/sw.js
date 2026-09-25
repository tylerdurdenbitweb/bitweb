/*
 * BitWeb service worker - makes the node installable and offline-bootable.
 *
 * Strategy:
 *   - precache the app shell ("/", manifest, icons) on install
 *   - navigations: network-first, falling back to the cached shell so the
 *     app boots with zero connectivity (it IS the node - no server needed)
 *   - same-origin static GETs (/assets, /fonts, icons): cache-first with
 *     background refill
 *   - everything else (peer signaling, wss, cross-origin): untouched
 *
 * The chain itself lives in IndexedDB, never in the Cache API.
 * CACHE_VERSION is stamped at build time (scripts/copy-public.mjs replaces
 * __BUILD_ID__ with a content hash of the bundle): every deploy installs a
 * fresh cache namespace and activate() purges the previous one, so a stale
 * service worker can never serve pre-update code after a release.
 */
const CACHE_VERSION = "bitweb-shell-__BUILD_ID__";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./favicon-32.png",
  "./favicon-16.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // signaling / peers pass through

  // Navigations: network-first, cached shell as the fallback. Only a HEALTHY
  // shell may replace the cached one: during a GitHub Pages deploy the site
  // can briefly answer its default 404 page, and caching that as the shell
  // would show a 404 on every later launch (the "iOS shows a 404" bug) -
  // even after the deploy finished. A non-200 answer falls back to the last
  // good shell exactly like an offline fetch does.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put("./index.html", copy));
            return res;
          }
          return caches.match("./index.html").then((hit) => hit || res);
        })
        .catch(() => caches.match("./index.html")),
    );
    return;
  }

  // Never cache the source snapshot - it must always be the freshest build.
  if (url.pathname.endsWith("/bitweb-source.zip")) return;

  // Same-origin statics: cache-first, then network + background refill.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
