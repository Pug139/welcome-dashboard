// WELCOME Dashboard – Service Worker
// Bewusst ohne Zwischenspeicher: alle Anfragen gehen direkt ans Netz,
// damit Projekt- und Lagerdaten immer aktuell sind. Der Worker existiert
// nur, damit sich das Dashboard als Web-App installieren lässt.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) { e.respondWith(fetch(e.request)); });
