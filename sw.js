const CACHE_NAME = 'study-hub-shell-v7';
const appUrl = path => new URL(path, self.registration.scope).toString();
const API_PATH = new URL('api/', self.registration.scope).pathname;
const APP_SHELL = [
  '',
  'index.html',
  'manifest.webmanifest',
  'style.css',
  'api.js',
  'app.js',
  'icon-192.png',
  'icon-512.png'
].map(appUrl);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith(API_PATH)) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(appUrl('index.html'))));
    return;
  }

  event.respondWith(
    fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw new Error(`Offline and no cached copy is available for ${url.pathname}`);
    })
  );
});
