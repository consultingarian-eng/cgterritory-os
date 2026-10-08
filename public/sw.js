/* Service worker — installability + field-friendly offline caching.
 *
 * Strategy (deliberately conservative for an auth-gated data app):
 *   • non-GET, /api/*, and auth pages          → network only (never cached)
 *   • navigations (HTML)                        → network first, fall back to a
 *                                                 cached shell/login when offline
 *   • static assets + map data (css/js/img/     → stale-while-revalidate, so the
 *     fonts/geojson/json, same-origin + CDN)      board still opens with spotty
 *                                                 signal in the field
 *
 * Cached responses are the user's own copy on their own device; bumping CACHE
 * on deploy retires the previous set, and "Sign out" (signOut in app.js)
 * deletes every cache, the Do-Not-Knock list included.
 */
const CACHE = 'cgterritory-v54';

// Small set of always-public assets worth precaching so the install completes
// even before the user is authenticated.
const PRECACHE = [
  '/manifest.webmanifest',
  '/logo.svg',
  '/logo.png',
  '/favicon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];
// Map data and vendor files live in a cache that survives version bumps (the
// ZIP polygons are 2 MB and rarely change; app.js versions their URLs with
// DATA_V) and fill on first use, so nothing downloads the polygons a second
// time at install. Only the small vendor files are precached — auth-gated,
// so with the session cookie, and only when the response is the real file:
// a redirect to /login in this cache would load as leaflet.js.
const DATA_CACHE = 'cgterritory-data-v2';
const SHELL = ['/vendor/leaflet/leaflet.js?v=1.9.4', '/vendor/leaflet/leaflet.css?v=1.9.4'];
const realAsset = (r) => r && r.ok && !r.redirected && r.type === 'basic';
const isDataPath = (p) => p.startsWith('/data/') || p.startsWith('/vendor/');
const CDN_OK = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com|unpkg\.com)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .catch(() => {})           // never let one 404 block installation
      .then(() => caches.open(DATA_CACHE))
      .then((c) => Promise.allSettled(SHELL.map((u) => fetch(new Request(u, { credentials: 'same-origin' })).then((r) => realAsset(r) ? c.put(u, r) : null))))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isStaticAsset(url) {
  return /\.(css|js|mjs|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|json|geojson)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // mutations: straight to network

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Auth + API: always live, never cached.
  if (sameOrigin && (url.pathname.startsWith('/api/') ||
                     url.pathname === '/login' ||
                     url.pathname === '/set-password')) {
    return;
  }

  // Page navigations: network first, cached fallback only when truly offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/login')))
    );
    return;
  }

  // Map tiles and other third-party hosts: straight through — caching them as
  // opaque responses filled 100 MB of quota in one session and got everything
  // else evicted. Only fonts and the on-demand spreadsheet parser are kept.
  if (!sameOrigin && !CDN_OK.test(url.hostname)) return;

  // Static assets + map data: stale-while-revalidate.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(sameOrigin && isDataPath(url.pathname) ? DATA_CACHE : CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const network = fetch(req)
            .then((res) => {
              // cache real same-origin files and CDN opaque responses — never a
              // redirect to /login standing in for an asset
              // (the spreadsheet parser is fetched with CORS for its integrity check)
              if (res && ((sameOrigin && realAsset(res)) || (!sameOrigin && (res.type === 'opaque' || (res.type === 'cors' && res.ok))))) cache.put(req, res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
  }
});
