/* ═══════════════════════════════════════════════════════════
   SERVICE WORKER — Commune de Sainte-Ode
   Gestion des notifications push + cache PWA
   ═══════════════════════════════════════════════════════════ */

const CACHE_NAME = 'ode-v5';  /* ← incrémenté pour forcer le rechargement sur tous les appareils */
const ASSETS = [
  '/Commune/',
  '/Commune/index.html',
  '/Commune/module4-prompt.js',
  '/Commune/module6-api.js',
  '/Commune/module-voice.js',
  '/Commune/manifest.json',
  '/Commune/blason-sainte-ode.jpg',
  '/Commune/icon-192.png',
  '/Commune/icon-512.png'
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

/* ── Fetch : réseau en priorité avec timeout, cache en fallback ── */
self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;

  const url = e.request.url;

  /* Toujours réseau pour les appels API externes */
  if (url.includes('workers.dev') || url.includes('googleapis') ||
      url.includes('groq.com') || url.includes('fonts.g')) {
    return;
  }

  e.respondWith(
    fetch(e.request).then(function(response) {
      /* Mettre à jour le cache avec la nouvelle version */
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(e.request, clone);
        });
      }
      return response;
    }).catch(function() {
      return caches.match(e.request);
    })
  );
});

/* ── Push : affichage de la notification ── */
self.addEventListener('push', function(e) {
  let data = { title: 'Commune de Sainte-Ode', body: '', icon: '/Commune/icon-192.png', url: '/Commune/' };
  if (e.data) {
    try { Object.assign(data, e.data.json()); }
    catch(err) { data.body = e.data.text(); }
  }

  /* Envoyer le contenu aux clients ouverts (onglets/app) */
  e.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(clients) {
      clients.forEach(function(client) {
        client.postMessage({ type:'PUSH_RECEIVED', title:data.title, body:data.body, url:data.url });
      });
    }).then(function() {
      return self.registration.showNotification(data.title, {
        body:            data.body,
        icon:            data.icon || '/Commune/icon-192.png',
        badge:           '/Commune/icon-192.png',
        vibrate:         [200, 100, 200, 100, 400],
        requireInteraction: true,
        tag:             'ode-alerte',
        renotify:        true,
        data:            { url: data.url || '/Commune/' },
        actions: [
          { action:'open',    title:'📖 Voir le détail' },
          { action:'dismiss', title:'✕ Fermer' }
        ]
      });
    })
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
