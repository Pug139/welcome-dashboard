// WELCOME Dashboard – Service Worker
// Bewusst ohne Zwischenspeicher: alle Anfragen gehen direkt ans Netz,
// damit Projekt- und Lagerdaten immer aktuell sind. Seitenaufrufe umgehen
// zusaetzlich den Browser-Cache, damit nach einem Deployment sofort die
// neue Version geladen wird. Der Worker existiert nur, damit sich das
// Dashboard als Web-App installieren laesst.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
  } else {
    e.respondWith(fetch(e.request));
  }
});
