/* ═══════════════════════════════════════════════════════════
   WORKER PUSH — Notifications Web Push · Commune de Sainte-Ode
   ═══════════════════════════════════════════════════════════

   Variables d'environnement à définir dans Cloudflare :
   ─────────────────────────────────────────────────────
   VAPID_PUBLIC_KEY   → clé publique VAPID (commence par BN...)
   VAPID_PRIVATE_KEY  → clé privée VAPID
   VAPID_EMAIL        → mailto:info@sainte-ode.be
   ADMIN_SECRET       → mot de passe pour envoyer les alertes (inventez-en un)

   KV Namespace à créer dans Cloudflare :
   ─────────────────────────────────────
   Nom : ODE_SUBSCRIPTIONS
   Bindng : SUBS  (à lier à ce Worker)

   ═══════════════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

/* ── Encodage Base64URL ── */
function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/* ── Génération JWT VAPID ── */
async function makeVapidJwt(endpoint, env) {
  const origin  = new URL(endpoint).origin;
  const now     = Math.floor(Date.now() / 1000);
  const header  = b64u(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(new TextEncoder().encode(JSON.stringify({
    aud: origin,
    exp: now + 43200,  /* 12h */
    sub: env.VAPID_EMAIL
  })));

  const sigInput = header + '.' + payload;
  const keyBuf   = b64uDecode(env.VAPID_PRIVATE_KEY);

  const key = await crypto.subtle.importKey(
    'raw', keyBuf,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(sigInput)
  );

  return sigInput + '.' + b64u(sig);
}

/* ── Envoi d'une notification à un abonné ── */
async function sendPush(subscription, payload, env) {
  const { endpoint, keys } = subscription;
  const jwt    = await makeVapidJwt(endpoint, env);
  const pubKey = env.VAPID_PUBLIC_KEY;

  /* Chiffrement ECDH + AES-GCM (Web Push Protocol) */
  const authBuf   = b64uDecode(keys.auth);
  const p256dhBuf = b64uDecode(keys.p256dh);

  const serverKey = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );

  const serverPub  = await crypto.subtle.exportKey('raw', serverKey.publicKey);
  const clientKey  = await crypto.subtle.importKey(
    'raw', p256dhBuf, { name: 'ECDH', namedCurve: 'P-256' }, true, []
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientKey }, serverKey.privateKey, 256
  );

  /* HKDF pour les clés de chiffrement */
  const salt       = crypto.getRandomValues(new Uint8Array(16));
  const ikm        = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
  const prk        = await crypto.subtle.importKey('raw', authBuf, 'HKDF', false, ['deriveBits']);

  const enc = new TextEncoder().encode(payload);
  const padded = new Uint8Array([0, ...enc]);

  const encKey = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt, info: new TextEncoder().encode('Content-Encoding: aes128gcm\0') },
      ikm, 128
    ),
    { name: 'AES-GCM' }, false, ['encrypt']
  );

  const iv         = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, padded);

  /* Header record */
  const header = new Uint8Array([...salt, 0, 0, 0x10, 0x00, serverPub.byteLength, ...new Uint8Array(serverPub)]);
  const body   = new Uint8Array([...header, ...iv, ...new Uint8Array(ciphertext)]);

  const resp = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Authorization':    `vapid t=${jwt},k=${pubKey}`,
      'TTL':              '86400'
    },
    body
  });

  return resp.status;
}

/* ═══════════════════════════════════════════════════════════
   ROUTER PRINCIPAL
   ═══════════════════════════════════════════════════════════ */
export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    /* ── GET /vapid-public-key — clé publique pour le front ── */
    if (path === '/vapid-public-key' && request.method === 'GET') {
      return json({ publicKey: env.VAPID_PUBLIC_KEY });
    }

    /* ── POST /subscribe — enregistrer un abonné ── */
    if (path === '/subscribe' && request.method === 'POST') {
      try {
        const sub = await request.json();
        if (!sub?.endpoint) return json({ error: 'Invalid subscription' }, 400);

        /* Clé = hash de l'endpoint pour éviter les doublons */
        const id = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint)));
        await env.SUBS.put(id, JSON.stringify(sub), { expirationTtl: 60 * 60 * 24 * 365 });

        return json({ ok: true, id });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    /* ── DELETE /unsubscribe — supprimer un abonné ── */
    if (path === '/unsubscribe' && request.method === 'DELETE') {
      try {
        const { endpoint } = await request.json();
        const id = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
        await env.SUBS.delete(id);
        return json({ ok: true });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    /* ── POST /notify — envoyer une alerte (admin uniquement) ── */
    if (path === '/notify' && request.method === 'POST') {
      /* Vérification mot de passe admin */
      const auth = request.headers.get('Authorization') || '';
      if (auth !== 'Bearer ' + env.ADMIN_SECRET) {
        return json({ error: 'Unauthorized' }, 401);
      }

      try {
        const { title, body, url: notifUrl } = await request.json();
        if (!body) return json({ error: 'body required' }, 400);

        const payload = JSON.stringify({
          title: title || 'Commune de Sainte-Ode',
          body,
          icon:  '/icon-192.png',
          url:   notifUrl || '/'
        });

        /* Récupérer tous les abonnés depuis KV */
        const { keys } = await env.SUBS.list();
        const results  = { sent: 0, failed: 0, removed: 0 };

        await Promise.all(keys.map(async function({ name }) {
          const raw = await env.SUBS.get(name);
          if (!raw) return;
          const sub = JSON.parse(raw);
          try {
            const status = await sendPush(sub, payload, env);
            if (status === 201 || status === 200) {
              results.sent++;
            } else if (status === 404 || status === 410) {
              /* Abonné disparu (app désinstallée) → nettoyer */
              await env.SUBS.delete(name);
              results.removed++;
            } else {
              results.failed++;
            }
          } catch (e) {
            results.failed++;
          }
        }));

        return json({ ok: true, ...results });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    /* ── GET /stats — nombre d'abonnés (admin) ── */
    if (path === '/stats' && request.method === 'GET') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== 'Bearer ' + env.ADMIN_SECRET) return json({ error: 'Unauthorized' }, 401);
      const { keys } = await env.SUBS.list();
      return json({ subscribers: keys.length });
    }

    return json({ error: 'Not found' }, 404);
  }
};
