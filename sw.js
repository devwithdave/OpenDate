/**
 * OpenDate - Service Worker for PWA Offline Caching
 * Caches static core assets for instant boot and offline resilience.
 */

const CACHE_NAME = 'opendate-v13';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icons/share.svg',
  './icons/block.svg',
  './css/style.css',
  './nostr.bundle.js',
  './qrcode.min.js',
  './options.js',
  './options.json',
  './js/db.js',
  './js/crypto.js',
  './js/geo.js',
  './js/relay.js',
  './js/media.js',
  './js/dealbreakers.js',
  './js/chat.js',
  './js/moderation.js',
  './js/app.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CORE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only cache GET requests
  if (event.request.method !== 'GET') return;

  // Let public relays and Blossom API calls pass through over network
  const url = event.request.url;
  if (url.startsWith('ws://') || url.startsWith('wss://') || url.includes('/upload')) {
    return;
  }

  // Network-first for options config so user taxonomy changes update immediately on refresh
  if (url.includes('options.json') || url.includes('options.js')) {
    event.respondWith(
      fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
        }
        return networkResponse;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      return fetch(event.request).then((networkResponse) => {
        // Cache new local static assets dynamically
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      });
    }).catch(() => {
      // Offline fallback only for HTML navigation requests
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html');
      }
      return new Response('', { status: 503, statusText: 'Offline asset unavailable' });
    })
  );
});
