/**
 * Service Worker — caches MediaPipe WASM models + static assets.
 *
 * Strategy:
 *   - MediaPipe CDN resources: cache-first (immutable versioned URLs)
 *   - Static app files: stale-while-revalidate (always fresh on reload)
 *   - API routes (/api/*): network-only (never cache)
 *
 * After the first visit, the app loads in ~0.5s instead of ~10s.
 */

const CACHE_VERSION  = 'ar-mirror-v2';
const STATIC_CACHE   = CACHE_VERSION + '-static';
const MODEL_CACHE    = CACHE_VERSION + '-models';

// App shell — served from our own server
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/src/app.js',
  '/src/pose_tracker.js',
  '/src/segmentation.js',
  '/src/cloth_renderer.js',
  '/src/analytics.js',
  '/src/one_euro_filter.js',
  '/assets/garments/shirt_white.png',
  '/assets/garments/hoodie_black.png',
  '/assets/garments/jacket_navy.png',
  '/assets/garments/shirt_stripe.png',
  '/garments.json',
];

// CDN domains that contain model weights — cache forever (URLs are versioned)
const MODEL_ORIGINS = [
  'cdn.jsdelivr.net',
];

// ─── Install: pre-cache app shell ─────────────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Pre-cache failed (ok in dev):', err))
  );
});

// ─── Activate: clean up old caches ────────────────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== MODEL_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch: routing strategy ───────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 1. API calls — always network, never cache
  if (url.pathname.startsWith('/api/')) return;

  // 2. MediaPipe CDN models — cache-first, cache on miss
  if (MODEL_ORIGINS.includes(url.hostname)) {
    e.respondWith(cacheFirst(e.request, MODEL_CACHE));
    return;
  }

  // 3. Our own static files — stale-while-revalidate
  if (url.origin === self.location.origin) {
    e.respondWith(staleWhileRevalidate(e.request, STATIC_CACHE));
    return;
  }

  // 4. Everything else — network
});

// ─── Strategies ────────────────────────────────────────────────────────────
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request, { mode: 'cors' });
    if (response.ok || response.type === 'opaque') {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    return new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  const fetchPr  = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || await fetchPr || new Response('Offline', { status: 503 });
}
