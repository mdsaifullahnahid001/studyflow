/**
 * ============================================================
 * StudyFlow PWA — Service Worker (sw.js)
 * ============================================================
 * Handles:
 *  - Precaching of app shell assets
 *  - Runtime caching strategies per asset type
 *  - Background sync for offline Firestore writes
 *  - Push notification support for Pomodoro reminders
 *  - Cache versioning and stale-entry cleanup
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
 * All paths are relative to the service worker scope (root).
 */
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json',

  /* ── External CDN libraries ── */
  // Dexie (IndexedDB wrapper)
  'https://cdn.jsdelivr.net/npm/dexie@3/dist/dexie.min.js',
  // Chart.js
  'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js',
  // SortableJS
  'https://cdn.jsdelivr.net/npm/sortablejs@1/Sortable.min.js',
  // html2canvas
  'https://cdn.jsdelivr.net/npm/html2canvas@1/dist/html2canvas.min.js',
  // jsPDF
  'https://cdn.jsdelivr.net/npm/jspdf@2/dist/jspdf.umd.min.js',
  // Tesseract.js core (worker is loaded lazily — not precached)
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',

  /* ── Offline fallback page ── */
  '/offline.html',
];

// CDN origins that should always be served from cache when offline
const CDN_ORIGINS = [
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

// Firebase domains — network-first, never block on miss
const FIREBASE_ORIGINS = [
  'https://firestore.googleapis.com',
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://www.googleapis.com',
];


// ─── Install ────────────────────────────────────────────────
/**
 * Pre-cache the app shell.
 * skipWaiting() makes the new SW take over immediately without
 * waiting for existing tabs to close.
 */
self.addEventListener('install', (event) => {
  console.log(`[SW] Installing ${APP_VERSION}`);

  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) => {
      console.log('[SW] Precaching app shell…');
      // addAll() will reject if ANY request fails.
      // We wrap individual failures so a single broken CDN
      // URL doesn't abort the entire install.
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
/**
 * Delete caches that belong to older versions of this SW.
 * clients.claim() lets the new SW control already-open tabs.
 */
self.addEventListener('activate', (event) => {
  console.log(`[SW] Activating ${APP_VERSION}`);

  const CURRENT_CACHES = [CACHE_STATIC, CACHE_DYNAMIC, CACHE_IMAGES];

  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => !CURRENT_CACHES.includes(name))
          .map((name) => {
            console.log('[SW] Deleting stale cache:', name);
            return caches.delete(name);
          })
      )
    ).then(() => self.clients.claim())
  );
});


// ─── Fetch ──────────────────────────────────────────────────
/**
 * Route fetch requests to the appropriate caching strategy.
 *
 * Strategy matrix:
 *  ┌─────────────────────────────┬───────────────────────────┐
 *  │ Request type                │ Strategy                  │
 *  ├─────────────────────────────┼───────────────────────────┤
 *  │ Firebase API                │ Network-only              │
 *  │ HTML navigation             │ Network-first             │
 *  │ CDN JS/CSS                  │ Cache-first (long TTL)    │
 *  │ Images (local + CDN)        │ Cache-first               │
 *  │ Everything else (dynamic)   │ Stale-while-revalidate    │
 *  └─────────────────────────────┴───────────────────────────┘
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ── 1. Skip non-GET & browser extension requests ──
  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // ── 2. Firebase — always network-only ──
  if (FIREBASE_ORIGINS.some((o) => request.url.startsWith(o))) {
    event.respondWith(networkOnly(request));
    return;
  }

  // ── 3. HTML navigation — network-first with offline fallback ──
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstWithFallback(request, '/offline.html'));
    return;
  }

  // ── 4. CDN libraries — cache-first ──
  if (CDN_ORIGINS.some((o) => request.url.startsWith(o))) {
    event.respondWith(cacheFirst(request, CACHE_STATIC));
    return;
  }

  // ── 5. Local images — cache-first into image cache ──
  if (request.destination === 'image') {
    event.respondWith(cacheFirst(request, CACHE_IMAGES));
    return;
  }

  // ── 6. Local static assets (JS, CSS, fonts) — cache-first ──
  if (['script', 'style', 'font'].includes(request.destination)) {
    event.respondWith(cacheFirst(request, CACHE_STATIC));
    return;
  }

  // ── 7. Everything else — stale-while-revalidate ──
  event.respondWith(staleWhileRevalidate(request, CACHE_DYNAMIC));
});


// ─── Caching Strategy Helpers ───────────────────────────────

/**
 * Network-only — for Firebase and sensitive API calls.
 * Returns a generic error response if offline.
 */
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(
      JSON.stringify({ error: 'Offline — Firebase unavailable.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Network-first — try network, fall back to cache, then fallbackUrl.
 * Used for HTML navigation so users always get fresh markup.
 */
async function networkFirstWithFallback(request, fallbackUrl) {
  try {
    const networkResponse = await fetch(request);
    // Cache successful navigations for offline use
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Last resort: return the offline fallback page
    const fallback = await caches.match(fallbackUrl);
    return fallback || new Response('<h1>Offline</h1>', {
      headers: { 'Content-Type': 'text/html' },
    });
  }
}

/**
 * Cache-first — serve from cache immediately; fetch & update if missing.
 * Best for versioned/hashed assets that rarely change.
 */
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
  } catch {
    // Return a 503 if the asset can't be fetched offline
    return new Response('Offline and not cached.', { status: 503 });
  }
}

/**
 * Stale-while-revalidate — serve from cache immediately AND
 * kick off a background network fetch to refresh the entry.
 * Great for API responses and dynamic content.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache      = await caches.open(cacheName);
  const cached     = await cache.match(request);

  // Background refresh (don't await)
  const networkFetch = fetch(request).then((networkResponse) => {
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  }).catch(() => { /* silently ignore offline */ });

  return cached || networkFetch;
}


// ─── Background Sync ────────────────────────────────────────
/**
 * 'studyflow-sync' is registered in script.js whenever a write
 * to Firestore fails due to being offline.
 * When connectivity returns the browser fires this event and
 * script.js flushes the Dexie offline queue to Firestore.
 */
self.addEventListener('sync', (event) => {
  if (event.tag === 'studyflow-sync') {
    console.log('[SW] Background sync triggered — flushing offline queue…');
    event.waitUntil(
      // Broadcast to all clients so script.js can process the queue
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) =>
          client.postMessage({ type: 'BACKGROUND_SYNC' })
        );
      })
    );
  }
});


// ─── Push Notifications ─────────────────────────────────────
/**
 * Handles push events sent from the server or triggered locally
 * by the Pomodoro timer via script.js → registration.showNotification().
 *
 * Payload shape expected (JSON):
 * {
 *   title:   string,
 *   body:    string,
 *   icon?:   string,   // defaults to /icons/icon-192.png
 *   tag?:    string,   // e.g. 'pomodoro-break'
 *   data?:   object
 * }
 */
self.addEventListener('push', (event) => {
  let payload = {
    title: 'StudyFlow',
    body:  'Time to focus! 📚',
    icon:  '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag:   'studyflow-general',
  };

  if (event.data) {
    try {
      Object.assign(payload, event.data.json());
    } catch {
      payload.body = event.data.text();
    }
  }

  const options = {
    body:    payload.body,
    icon:    payload.icon  || '/icons/icon-192.png',
    badge:   payload.badge || '/icons/badge-72.png',
    tag:     payload.tag   || 'studyflow',
    vibrate: [200, 100, 200],
    data:    payload.data  || {},
    actions: [
      { action: 'open',    title: '📖 Open App' },
      { action: 'dismiss', title: '✖ Dismiss'   },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, options)
  );
});

/**
 * Handle notification click actions.
 * 'open'    → focus or open the PWA window.
 * 'dismiss' → close the notification silently.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  // Focus an existing tab or open a new one
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const appClient = clients.find((c) => c.url.includes(self.location.origin));
        if (appClient) return appClient.focus();
        return self.clients.openWindow('/');
      })
  );
});


// ─── Message Handler ────────────────────────────────────────
/**
 * Listen for messages from the main thread (script.js).
 *
 * Supported message types:
 *  SKIP_WAITING  — force the waiting SW to activate immediately.
 *  CACHE_URLS    — dynamically cache a list of URLs at runtime.
 *  CLEAR_CACHE   — wipe a specific named cache (e.g. on logout).
 */
self.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};

  switch (type) {
    case 'SKIP_WAITING':
      console.log('[SW] Received SKIP_WAITING — activating now.');
      self.skipWaiting();
      break;

    case 'CACHE_URLS':
      if (Array.isArray(payload?.urls)) {
        caches.open(CACHE_DYNAMIC).then((cache) => {
          payload.urls.forEach((url) =>
            cache.add(url).catch((e) =>
              console.warn('[SW] Runtime cache miss:', url, e)
            )
          );
        });
      }
      break;

    case 'CLEAR_CACHE': {
      const target = payload?.cacheName;
      if (target) {
        caches.delete(target).then(() =>
          console.log('[SW] Cache cleared:', target)
        );
      }
      break;
    }

    default:
      // Unknown message — ignore silently
      break;
  }
});
