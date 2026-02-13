var CACHE_NAME = 'aospesdacruz-v1';
var urlsToCache = [
  './',
  './index.html',
  './icon-192x192.png',
  './icon-512x512.png',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(urlsToCache);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n !== CACHE_NAME; })
             .map(function(n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event) {
  // Always go network-first for Firebase/API calls
  if (event.request.url.indexOf('firestore') !== -1 ||
      event.request.url.indexOf('googleapis.com/google') !== -1) {
    return;
  }
  event.respondWith(
    fetch(event.request).then(function(response) {
      // Update cache with fresh version
      if (response.status === 200) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
      }
      return response;
    }).catch(function() {
      // Offline - serve from cache
      return caches.match(event.request);
    })
  );
});
