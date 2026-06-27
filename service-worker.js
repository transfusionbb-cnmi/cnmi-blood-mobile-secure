const CACHE_NAME = 'cnmi-blood-mobile-v1.0.0';
const LOCAL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './js/offline-backend.js',
  './js/offline-tools.js',
  './assets/icons/android-chrome-192x192.png',
  './assets/icons/android-chrome-512x512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-32x32.png',
  './assets/icons/favicon-16x16.png',
  './assets/vendor/bootstrap.min.css',
  './assets/vendor/bootstrap.bundle.min.js',
  './assets/vendor/JsBarcode.all.min.js',
  './assets/vendor/xlsx.full.min.js'
];
const EXTERNAL_ASSETS = [
  'https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(LOCAL_ASSETS);
    await Promise.allSettled(EXTERNAL_ASSETS.map(async url => {
      const response = await fetch(url, { mode: 'no-cors', cache: 'reload' });
      await cache.put(url, response);
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const cached = await caches.match(event.request, { ignoreSearch: false });
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      const cache = await caches.open(CACHE_NAME);
      if (response && (response.ok || response.type === 'opaque')) cache.put(event.request, response.clone());
      return response;
    } catch (err) {
      if (event.request.mode === 'navigate') return (await caches.match('./index.html')) || Response.error();
      throw err;
    }
  })());
});
