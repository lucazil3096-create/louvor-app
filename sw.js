// Import Firebase Messaging SW (for background push)
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAFmRh89lSPlI9h589w2z7_M0etFYhbQyM",
  authDomain: "louvor-app-a7264.firebaseapp.com",
  projectId: "louvor-app-a7264",
  storageBucket: "louvor-app-a7264.firebasestorage.app",
  messagingSenderId: "599364196472",
  appId: "1:599364196472:web:3fecfe67cfa7f38c81758d"
});

var messaging = firebase.messaging();

// Handle background push messages from FCM
messaging.onBackgroundMessage(function(payload) {
  var title = payload.notification ? payload.notification.title : (payload.data ? payload.data.title : 'Aos Pés da Cruz');
  var body = payload.notification ? payload.notification.body : (payload.data ? payload.data.body : '');
  var options = {
    body: body,
    icon: './icon-192x192.png',
    badge: './icon-192x192.png',
    vibrate: [200, 100, 200],
    tag: payload.data ? payload.data.tag : 'general',
    data: { url: './' }
  };
  return self.registration.showNotification(title, options);
});

// Handle notification click - open/focus the app
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.indexOf('louvor-app') !== -1 || clientList[i].url.indexOf('aospesdacruz') !== -1) {
          return clientList[i].focus();
        }
      }
      return self.clients.openWindow(event.notification.data && event.notification.data.url ? event.notification.data.url : './');
    })
  );
});

var CACHE_NAME = 'aospesdacruz-v2';
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
  var url = event.request.url;
  // Skip ALL Firebase/Google API calls (Storage, Firestore, etc)
  if (url.indexOf('firebasestorage') !== -1 ||
      url.indexOf('firestore') !== -1 ||
      url.indexOf('googleapis.com') !== -1 ||
      url.indexOf('gstatic.com') !== -1) {
    return;
  }
  event.respondWith(
    fetch(event.request).then(function(response) {
      if (response.status === 200) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
      }
      return response;
    }).catch(function() {
      return caches.match(event.request);
    })
  );
});
