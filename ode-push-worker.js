/* ═══════════════════════════════════════════════════════════
   ODE-PUSH WORKER — Proxy IA + Notifications Push
   Commune de Sainte-Ode
   
   Variables Cloudflare (Settings → Variables) :
   - GROQ_KEY          Secret   → clé Groq gsk_...
   - GEMINI_KEY        Secret   → clé Gemini AIza...
   - ADMIN_SECRET      Secret   → mot de passe admin (Ode-Push6680)
   - VAPID_PUBLIC_KEY  Plaintext
   - VAPID_PRIVATE_KEY Secret
   - VAPID_EMAIL       Plaintext → mailto:info@sainte-ode.be
   
   Binding KV : SUBS → ODE_SUBSCRIPTIONS
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

/* ══════════════════════════════════════════════════════════
   PROXY GROQ / GEMINI — POST /llm
   ══════════════════════════════════════════════════════════ */

async function proxyGroq(body, env) {
  const msgs = [
    { role: 'system', content: body.systemPrompt || '' },
    ...(body.messages || [])
  ];
  return fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + env.GROQ_KEY
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: msgs,
      max_tokens: body.maxTokens || 600,
      temperature: 0.4
    })
  });
}

async function proxyGemini(body, env) {
  const contents = (body.messages || []).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  return fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + env.GEMINI_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: body.systemPrompt || '' }] },
        contents,
        generationConfig: { maxOutputTokens: body.maxTokens || 1200, temperature: 0.4 }
      })
    }
  );
}

/* ══════════════════════════════════════════════════════════
   TOKENS ADMIN
   ══════════════════════════════════════════════════════════ */

const _adminTokens = new Map();

function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isValidToken(token) {
  const exp = _adminTokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { _adminTokens.delete(token); return false; }
  return true;
}

/* ══════════════════════════════════════════════════════════
   WEB PUSH — Chiffrement RFC 8291 (aes128gcm)
   ══════════════════════════════════════════════════════════ */

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

/* HKDF helper : extract + expand en une passe via Web Crypto */
async function hkdf(salt, ikm, info, byteLength) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', ikm, 'HKDF', false, ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    keyMaterial,
    byteLength * 8
  );
}

async function makeVapidJwt(endpoint, env) {
  const origin   = new URL(endpoint).origin;
  const now      = Math.floor(Date.now() / 1000);
  const enc      = new TextEncoder();
  const header   = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload  = b64u(enc.encode(JSON.stringify({ aud: origin, exp: now + 43200, sub: env.VAPID_EMAIL })));
  const sigInput = header + '.' + payload;
  const key      = await crypto.subtle.importKey(
    'raw', b64uDecode(env.VAPID_PRIVATE_KEY),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(sigInput)
  );
  return sigInput + '.' + b64u(sig);
}

/* Chiffrement correct RFC 8291 :
   1. ECDH  → sharedSecret
   2. HKDF(auth, sharedSecret, "WebPush: info\0" || clientPub || serverPub) → PRK
   3. HKDF(salt, PRK, "Content-Encoding: aes128gcm\0") → CEK (16 bytes)
   4. HKDF(salt, PRK, "Content-Encoding: nonce\0")     → NONCE (12 bytes)
   5. AES-128-GCM(CEK, NONCE, plaintext + 0x02)
   6. Header : salt(16) + rs(4 BE) + idlen(1) + serverPub(65)
*/
async function sendPush(subscription, payloadStr, env) {
  const { endpoint, keys } = subscription;
  const enc = new TextEncoder();

  /* Décodage des clés du client */
  const clientPubBuf = b64uDecode(keys.p256dh); // 65 bytes
  const authBuf      = b64uDecode(keys.auth);   // 16 bytes

  /* Paire de clés serveur éphémère */
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const serverPubRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverKeyPair.publicKey)
  ); // 65 bytes

  /* Importer la clé publique client */
  const clientPubKey = await crypto.subtle.importKey(
    'raw', clientPubBuf, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  /* Secret partagé ECDH */
  const sharedSecretBuf = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPubKey }, serverKeyPair.privateKey, 256
  );

  /* Salt aléatoire 16 bytes */
  const salt = crypto.getRandomValues(new Uint8Array(16));

  /* PRK = HKDF(salt=auth, ikm=sharedSecret, info="WebPush: info\0" + clientPub + serverPub) */
  const keyInfoLabel = enc.encode('WebPush: info\0');
  const keyInfo = new Uint8Array(
    keyInfoLabel.length + clientPubBuf.byteLength + serverPubRaw.length
  );
  keyInfo.set(keyInfoLabel, 0);
  keyInfo.set(new Uint8Array(clientPubBuf), keyInfoLabel.length);
  keyInfo.set(serverPubRaw, keyInfoLabel.length + clientPubBuf.byteLength);

  const prkBuf = await hkdf(authBuf, sharedSecretBuf, keyInfo, 32);

  /* CEK (16 bytes) et NONCE (12 bytes) */
  const cekBuf   = await hkdf(salt, prkBuf, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonceBuf = await hkdf(salt, prkBuf, enc.encode('Content-Encoding: nonce\0'), 12);

  /* Importer CEK */
  const cek = await crypto.subtle.importKey('raw', cekBuf, { name: 'AES-GCM' }, false, ['encrypt']);

  /* Plaintext padded : contenu + 0x02 (délimiteur RFC 8291) */
  const plaintext = enc.encode(payloadStr);
  const padded    = new Uint8Array(plaintext.length + 1);
  padded.set(plaintext);
  padded[plaintext.length] = 2;

  /* Chiffrement AES-128-GCM */
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceBuf }, cek, padded)
  );

  /* Header : salt(16) + record_size(4 BE = 4096) + keyid_len(1 = 65) + serverPub(65) */
  const rs     = 4096;
  const header = new Uint8Array(16 + 4 + 1 + serverPubRaw.length);
  header.set(salt, 0);
  header[16] = (rs >>> 24) & 0xff;
  header[17] = (rs >>> 16) & 0xff;
  header[18] = (rs >>> 8)  & 0xff;
  header[19] =  rs         & 0xff;
  header[20] = serverPubRaw.length; // 65
  header.set(serverPubRaw, 21);

  /* Corps final */
  const body = new Uint8Array(header.length + ciphertext.length);
  body.set(header, 0);
  body.set(ciphertext, header.length);

  /* VAPID JWT */
  const jwt = await makeVapidJwt(endpoint, env);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Authorization':    `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
      'TTL':              '86400'
    },
    body
  });

  return resp.status;
}

/* ══════════════════════════════════════════════════════════
   ROUTER PRINCIPAL
   ══════════════════════════════════════════════════════════ */
export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url  = new URL(request.url);
    const path = url.pathname;

    /* ── POST /llm — Proxy IA Groq/Gemini ── */
    if (path === '/llm' && request.method === 'POST') {
      try {
        const body     = await request.json();
        const provider = body.provider || 'groq';
        let resp = provider === 'groq'
          ? await proxyGroq(body, env)
          : await proxyGemini(body, env);
        /* Fallback automatique sur 429 */
        if (resp.status === 429) {
          resp = provider === 'groq'
            ? await proxyGemini(body, env)
            : await proxyGroq(body, env);
        }
        const data = await resp.json();
        return new Response(JSON.stringify(data), {
          status: resp.status,
          headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    /* ── GET /vapid-public-key ── */
    if (path === '/vapid-public-key' && request.method === 'GET') {
      return json({ publicKey: env.VAPID_PUBLIC_KEY });
    }

    /* ── POST /auth ── */
    if (path === '/auth' && request.method === 'POST') {
      try {
        const { password } = await request.json();
        if (password !== env.ADMIN_SECRET) return json({ error: 'Unauthorized' }, 401);
        const token = generateToken();
        _adminTokens.set(token, Date.now() + 2 * 60 * 60 * 1000); /* 2h */
        return json({ token });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    /* ── POST /subscribe ── */
    if (path === '/subscribe' && request.method === 'POST') {
      try {
        const sub = await request.json();
        if (!sub?.endpoint) return json({ error: 'Invalid subscription' }, 400);
        const id = b64u(await crypto.subtle.digest(
          'SHA-256', new TextEncoder().encode(sub.endpoint)
        ));
        await env.SUBS.put(id, JSON.stringify(sub), { expirationTtl: 60 * 60 * 24 * 365 });
        return json({ ok: true, id });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    /* ── DELETE /unsubscribe ── */
    if (path === '/unsubscribe' && request.method === 'DELETE') {
      try {
        const { endpoint } = await request.json();
        const id = b64u(await crypto.subtle.digest(
          'SHA-256', new TextEncoder().encode(endpoint)
        ));
        await env.SUBS.delete(id);
        return json({ ok: true });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    /* ── POST /notify — envoyer alerte (token requis) ── */
    if (path === '/notify' && request.method === 'POST') {
      const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
      if (!isValidToken(token)) return json({ error: 'Unauthorized' }, 401);
      try {
        const { title, body, url: notifUrl } = await request.json();
        if (!body) return json({ error: 'body required' }, 400);
        const payload = JSON.stringify({
          title: title || 'Commune de Sainte-Ode',
          body,
          icon: '/Commune/icon-192.png',
          url:  notifUrl || '/Commune/'
        });
        const { keys } = await env.SUBS.list();
        const results  = { sent: 0, failed: 0, removed: 0 };
        await Promise.all(keys.map(async ({ name }) => {
          const raw = await env.SUBS.get(name);
          if (!raw) return;
          try {
            const status = await sendPush(JSON.parse(raw), payload, env);
            if (status === 200 || status === 201) results.sent++;
            else if (status === 404 || status === 410) {
              await env.SUBS.delete(name);
              results.removed++;
            } else {
              results.failed++;
            }
          } catch (e) {
            console.error('sendPush error:', e.message);
            results.failed++;
          }
        }));
        return json({ ok: true, ...results });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    /* ── GET /stats ── */
    if (path === '/stats' && request.method === 'GET') {
      const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
      if (!isValidToken(token)) return json({ error: 'Unauthorized' }, 401);
      const { keys } = await env.SUBS.list();
      return json({ subscribers: keys.length });
    }

    return json({ error: 'Not found' }, 404);
  }
};
