/* ═══════════════════════════════════════════════════════════
   SERVICE WORKER — Ode PWA · Commune de Sainte-Ode
   Gère : cache offline + notifications push
   ═══════════════════════════════════════════════════════════ */

const CACHE_NAME = 'ode-v1';
const CACHE_FILES = [
  '/',
  '/index.html',
  '/module4-prompt.js',
  '/module6-api.js',
  '/module-voice.js',
  '/manifest.json'
];

/* ── Installation : mise en cache des fichiers principaux ── */
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CACHE_FILES);
    })
  );
  self.skipWaiting();
});

/* ── Activation : nettoyage des anciens caches ── */
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k)   { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

/* ── Fetch : réseau d'abord, cache en fallback ── */
self.addEventListener('fetch', function(e) {
  /* Ne pas intercepter les appels API */
  if (e.request.url.includes('workers.dev') ||
      e.request.url.includes('groq.com') ||
      e.request.url.includes('googleapis.com')) {
    return;
  }
  e.respondWith(
    fetch(e.request).catch(function() {
      return caches.match(e.request);
    })
  );
});

/* ══════════════════════════════════════════════════════════
   NOTIFICATIONS PUSH
   ══════════════════════════════════════════════════════════ */

/* ── Réception d'une notification push ── */
self.addEventListener('push', function(e) {
  let data = { title: 'Commune de Sainte-Ode', body: '', icon: '/icon-192.png', url: '/' };

  if (e.data) {
    try { Object.assign(data, e.data.json()); }
    catch(err) { data.body = e.data.text(); }
  }

  const options = {
    body:            data.body,
    icon:            data.icon || '/icon-192.png',
    badge:           '/icon-192.png',
    vibrate:         [200, 100, 200, 100, 400], /* pattern sonnerie urgence */
    requireInteraction: true,                   /* reste visible jusqu'au tap */
    tag:             'ode-alerte',              /* remplace la précédente */
    renotify:        true,
    data:            { url: data.url || '/' },
    actions: [
      { action: 'open',    title: '📖 Voir le détail' },
      { action: 'dismiss', title: '✕ Fermer' }
    ]
  };

  e.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

/* ── Clic sur la notification ── */
self.addEventListener('notificationclick', function(e) {
  e.notification.close();

  if (e.action === 'dismiss') return;

  const url = e.notification.data?.url || '/';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      /* Si l'app est déjà ouverte → focus */
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      /* Sinon → ouvrir */
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

/* ── Abonnement envoyé depuis index.html ── */
self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
