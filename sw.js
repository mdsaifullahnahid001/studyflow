/**
 * ============================================================
 * StudyFlow PWA — Service Worker (sw.js)
 * ============================================================
 */

'use strict';

// ─── Cache Configuration ────────────────────────────────────
const APP_VERSION   = 'v1.0.0';
const CACHE_STATIC  = `studyflow-static-${APP_VERSION}`;
const CACHE_DYNAMIC = `studyflow-dynamic-${APP_VERSION}`;
const CACHE_IMAGES  = `studyflow-images-${APP_VERSION}`;

/**
 * App-shell files to precache on install.
 * Path updated for GitHub Pages subdirectory /studyflow/
 */
const PRECACHE_ASSETS = [
  '/studyflow/',
  '/studyflow/index.html',
  '/studyflow/style.css',
  '/studyflow/script.js',
  '/studyflow/manifest.json',

  /* ── External CDN libraries ── */
  'https://cdn.jsdelivr.net/npm/dexie@3/dist/dexie.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/sortablejs@1/Sortable.min.js',
  'https://cdn.jsdelivr.net/npm/html2canvas@1/dist/html2canvas.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2/dist/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
];

// CDN origins
const CDN_ORIGINS = [
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

const FIREBASE_ORIGINS = [
  'https://firestore.googleapis.com',
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://www.googleapis.com',
];


// ─── Install ────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log(`[SW] Installing ${APP_VERSION}`);
  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) => {
      return Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) =>
            console.warn(`[SW] Precache miss for ${url}:`, err)
          )
        )
      );
    }).then(() => self.skipWaiting())
  );
});


// ─── Activate ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log(`[SW] Activating ${APP_VERSION}`);
  const CURRENT_CACHES = [CACHE_STATIC, CACHE_DYNAMIC, CACHE_IMAGES];
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => !CURRENT_CACHES.includes(name))
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});


// ─── Fetch ──────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  if (FIREBASE_ORIGINS.some((o) => request.url.startsWith(o))) {
    event.respondWith(networkOnly(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstWithFallback(request, '/studyflow/offline.html'));
    return;
  }

  if (CDN_ORIGINS.some((o) => request.url.startsWith(o))) {
    event.respondWith(cacheFirst(request, CACHE_STATIC));
    return;
  }

  if (request.destination === 'image') {
    event.respondWith(cacheFirst(request, CACHE_IMAGES));
    return;
  }

  if (['script', 'style', 'font'].includes(request.destination)) {
    event.respondWith(cacheFirst(request, CACHE_STATIC));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, CACHE_DYNAMIC));
});


// ─── Caching Strategy Helpers ───────────────────────────────
async function networkOnly(request) {
  try { return await fetch(request); }
  catch { return new Response(JSON.stringify({ error: 'Offline' }), { status: 503 }); }
}

async function networkFirstWithFallback(request, fallbackUrl) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    const fallback = await caches.match(fallbackUrl);
    return fallback || new Response('<h1>Offline</h1>', { headers: { 'Content-Type': 'text/html' } });
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch { return new Response('Offline', { status: 503 }); }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkFetch = fetch(request).then((networkResponse) => {
    if (networkResponse.ok) cache.put(request, networkResponse.clone());
    return networkResponse;
  }).catch(() => { });
  return cached || networkFetch;
}

// ─── Background Sync & Push ─────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'studyflow-sync') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'BACKGROUND_SYNC' }));
      })
    );
  }
});

self.addEventListener('push', (event) => {
  let payload = { title: 'StudyFlow', body: 'Time to focus! 📚', icon: '/studyflow/icons/icon-192.png' };
  if (event.data) {
    try { Object.assign(payload, event.data.json()); } catch { payload.body = event.data.text(); }
  }
  const options = {
    body: payload.body,
    icon: payload.icon || '/studyflow/icons/icon-192.png',
    badge: '/studyflow/icons/badge-72.png',
    tag: 'studyflow',
    actions: [{ action: 'open', title: '📖 Open App' }, { action: 'dismiss', title: '✖ Dismiss' }],
  };
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const appClient = clients.find((c) => c.url.includes(self.location.origin));
        if (appClient) return appClient.focus();
        return self.clients.openWindow('/studyflow/');
      })
  );
});

// ─── Message Handler ────────────────────────────────────────
self.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};
  switch (type) {
    case 'SKIP_WAITING': self.skipWaiting(); break;
    case 'CACHE_URLS':
      caches.open(CACHE_DYNAMIC).then((cache) => {
        payload?.urls.forEach((url) => cache.add(url));
      });
      break;
    case 'CLEAR_CACHE':
      if (payload?.cacheName) caches.delete(payload.cacheName);
      break;
  }
});
