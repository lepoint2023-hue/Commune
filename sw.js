/* ═══════════════════════════════════════════════════════════
   SERVICE WORKER — Commune de Sainte-Ode
   Gestion des notifications push + cache PWA
   ═══════════════════════════════════════════════════════════ */

const CACHE_NAME = 'ode-v1';
const ASSETS = [
  '/Commune/',
  '/Commune/index.html',
  '/Commune/module4-prompt.js',
  '/Commune/module6-api.js',
  '/Commune/module-voice.js',
  '/Commune/manifest.json'
  /* blason et jonquille chargés dynamiquement — pas mis en cache pour éviter les 404 */
];

/* ── Installation : mise en cache des ressources ── */
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(ASSETS).catch(function(err) {
        console.warn('[SW] Cache partiel:', err);
      });
    })
  );
  self.skipWaiting();
});

/* ── Activation : suppression des anciens caches ── */
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

/* ── Fetch : réseau en priorité, cache en fallback ── */
self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(function() {
      return caches.match(e.request);
    })
  );
});

/* ── Push : affichage de la notification ── */
self.addEventListener('push', function(e) {
  let data = { title: 'Commune de Sainte-Ode', body: 'Nouveau message de la commune.' };
  try {
    if (e.data) data = e.data.json();
  } catch(err) {
    if (e.data) data.body = e.data.text();
  }

  const options = {
    body:    data.body,
    icon:    '/Commune/blason-sainte-ode.jpg',
    badge:   '/Commune/blason-sainte-ode.jpg',
    vibrate: [100, 50, 100],
    data:    { url: data.url || '/Commune/' },
    actions: [
      { action: 'open',    title: 'Ouvrir' },
      { action: 'dismiss', title: 'Fermer' }
    ]
  };

  e.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

/* ── Clic sur notification ── */
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  if (e.action === 'dismiss') return;
  const target = e.notification.data?.url || '/Commune/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (const client of list) {
        if (client.url.includes('/Commune/') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});
