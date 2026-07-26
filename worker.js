/* ═══════════════════════════════════════════════════════════
   ODEBOT WORKER — Proxy IA (Groq + Gemini) + Push Notifications
   Variables : GROQ_KEY, GEMINI_KEY, ADMIN_SECRET,
               VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL
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

/* ── Helpers compteurs KV simples (entiers) ── */
async function statInc(env, key, amount = 1) {
  try {
    const val = await env.SUBS.get('stats:' + key);
    const next = (parseInt(val) || 0) + amount;
    await env.SUBS.put('stats:' + key, String(next));
  } catch(e) {}
}

async function statGet(env, key) {
  try {
    const val = await env.SUBS.get('stats:' + key);
    return parseInt(val) || 0;
  } catch(e) { return 0; }
}

/* ── Helper compteurs KV JSON (objets clé→valeur) ── */
async function jsonInc(env, kvKey, field) {
  try {
    const raw = await env.SUBS.get(kvKey);
    const obj = raw ? JSON.parse(raw) : {};
    obj[field] = (obj[field] || 0) + 1;
    await env.SUBS.put(kvKey, JSON.stringify(obj));
  } catch(e) {}
}

async function jsonGet(env, kvKey) {
  try {
    const raw = await env.SUBS.get(kvKey);
    return raw ? JSON.parse(raw) : {};
  } catch(e) { return {}; }
}

async function proxyGroq(body, env) {
  const msgs = [{ role: 'system', content: body.systemPrompt || '' }, ...(body.messages || [])];
  return fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.GROQ_KEY },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: msgs, max_tokens: body.maxTokens || 1500, temperature: 0.4 })
  });
}

async function proxyGemini(body, env) {
  const contents = (body.messages || []).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }]
  }));
  return fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + env.GEMINI_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: body.systemPrompt || '' }] },
      contents,
      generationConfig: { maxOutputTokens: body.maxTokens || 1500, temperature: 0.4 }
    })
  });
}

function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function createToken(env) {
  const token = generateToken();
  const exp   = Date.now() + 4 * 60 * 60 * 1000;
  await env.SUBS.put('admin_token:' + token, String(exp), { expirationTtl: 4 * 60 * 60 });
  return token;
}

async function isValidToken(token, env) {
  if (!token) return false;
  const val = await env.SUBS.get('admin_token:' + token);
  if (!val) return false;
  if (Date.now() > parseInt(val)) {
    await env.SUBS.delete('admin_token:' + token);
    return false;
  }
  return true;
}

function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer ?? buf)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64uDecode(str) {
  const s = str.replace(/-/g,'+').replace(/_/g,'/');
  const bin = atob(s);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function concat(...arrays) {
  const total = arrays.reduce((n,a) => n + (a.byteLength ?? a.length), 0);
  const out   = new Uint8Array(total);
  let   off   = 0;
  for (const arr of arrays) {
    const u = arr instanceof ArrayBuffer ? new Uint8Array(arr) : new Uint8Array(arr.buffer ?? arr);
    out.set(u, off); off += u.length;
  }
  return out;
}

async function makeVapidJwt(endpoint, env) {
  const origin  = new URL(endpoint).origin;
  const now     = Math.floor(Date.now() / 1000);
  const header  = b64u(new TextEncoder().encode(JSON.stringify({ typ:'JWT', alg:'ES256' })));
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ aud:origin, exp:now+43200, sub:env.VAPID_EMAIL })));
  const sigInput = header + '.' + payload;
  const privRaw = new Uint8Array(b64uDecode(env.VAPID_PRIVATE_KEY));
  const pubRaw  = new Uint8Array(b64uDecode(env.VAPID_PUBLIC_KEY));
  const x = b64u(pubRaw.slice(1, 33).buffer);
  const y = b64u(pubRaw.slice(33, 65).buffer);
  const d = b64u(privRaw.buffer);
  const jwk = { kty:'EC', crv:'P-256', x, y, d, key_ops:['sign'] };
  const key  = await crypto.subtle.importKey('jwk', jwk, { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']);
  const sig  = await crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, key, new TextEncoder().encode(sigInput));
  return sigInput + '.' + b64u(sig);
}

async function sendPush(subscription, payloadStr, env) {
  const { endpoint, keys } = subscription;
  const authSecret  = b64uDecode(keys.auth);
  const receiverPub = b64uDecode(keys.p256dh);
  const senderKP  = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']);
  const senderPub = await crypto.subtle.exportKey('raw', senderKP.publicKey);
  const recvKey   = await crypto.subtle.importKey('raw', receiverPub, { name:'ECDH', namedCurve:'P-256' }, true, []);
  const shared    = await crypto.subtle.deriveBits({ name:'ECDH', public:recvKey }, senderKP.privateKey, 256);
  const enc      = new TextEncoder();
  const infoAuth = concat(enc.encode('WebPush: info\x00'), new Uint8Array(receiverPub), new Uint8Array(senderPub));
  const ikm      = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const prkBits  = await crypto.subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt:authSecret, info:infoAuth }, ikm, 256);
  const prk      = await crypto.subtle.importKey('raw', prkBits, 'HKDF', false, ['deriveBits']);
  const salt    = crypto.getRandomValues(new Uint8Array(16));
  const cekBits = await crypto.subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt, info:enc.encode('Content-Encoding: aes128gcm\x00') }, prk, 128);
  const cek     = await crypto.subtle.importKey('raw', cekBits, { name:'AES-GCM' }, false, ['encrypt']);
  const nonce   = new Uint8Array(await crypto.subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt, info:enc.encode('Content-Encoding: nonce\x00') }, prk, 96));
  const plain  = enc.encode(payloadStr);
  const padded = new Uint8Array(plain.length + 2);
  padded.set(plain); padded[plain.length] = 0x02;
  const cipher = await crypto.subtle.encrypt({ name:'AES-GCM', iv:nonce }, cek, padded);
  const rs  = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, padded.byteLength + 16 + 1, false);
  const body = concat(salt, rs, new Uint8Array([senderPub.byteLength]), new Uint8Array(senderPub), new Uint8Array(cipher));
  const jwt  = await makeVapidJwt(endpoint, env);
  const resp = await fetch(endpoint, {
    method:'POST',
    headers: { 'Content-Type':'application/octet-stream', 'Content-Encoding':'aes128gcm', 'Authorization':`vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`, 'TTL':'86400' },
    body
  });
  return resp.status;
}

/* ══════════════════════════════════════════════════════
   ANTI-DOUBLON SIGNALEMENTS
   Clé KV : report:{village}:{categorie}:{date}
   Seuil  : 3 signalements identiques en 48h → bloqué
   TTL    : 48h (172800 secondes)
   ══════════════════════════════════════════════════════ */
const REPORT_SEUIL = 3;
const REPORT_TTL   = 172800;

async function checkSignalement(env, village, categorie) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
  const date = new Date().toISOString().slice(0, 10);
  const kvKey = `report:${norm(village)}:${norm(categorie)}:${date}`;
  try {
    const val   = await env.SUBS.get(kvKey);
    const count = parseInt(val) || 0;
    if (count >= REPORT_SEUIL) return { blocked: true, count };
    await env.SUBS.put(kvKey, String(count + 1), { expirationTtl: REPORT_TTL });
    return { blocked: false, count: count + 1 };
  } catch(e) {
    return { blocked: false, count: 1 };
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const path = new URL(request.url).pathname;

    /* ── POST /llm — proxy IA + rate limiting ── */
    if (path === '/llm' && request.method === 'POST') {
      try {
        const ip      = request.headers.get('CF-Connecting-IP') || 'unknown';
        const hour    = new Date().toISOString().slice(0, 13);
        const rlKey   = `rl:${ip}:${hour}`;
        const rlVal   = await env.SUBS.get(rlKey);
        const rlCount = parseInt(rlVal) || 0;
        if (rlCount >= 30) return json({ error: 'Trop de requêtes. Réessayez dans une heure.' }, 429);
        await env.SUBS.put(rlKey, String(rlCount + 1), { expirationTtl: 3600 });
      } catch(e) {}

      try {
        const body = await request.json();
        const prov = body.provider || 'groq';
        let resp   = prov === 'groq' ? await proxyGroq(body, env) : await proxyGemini(body, env);
        if (resp.status === 429) resp = prov === 'groq' ? await proxyGemini(body, env) : await proxyGroq(body, env);
        const data = await resp.json();
        if (resp.status === 200 || resp.status === 201) await statInc(env, 'questions');
        return new Response(JSON.stringify(data), { status:resp.status, headers:{...CORS,'Content-Type':'application/json'} });
      } catch(e) { return json({ error:e.message }, 500); }
    }

    /* ── POST /stat-context — langue + heure + jour + installations ── */
    if (path === '/stat-context' && request.method === 'POST') {
      try {
        const body = await request.json();

        /* Installation PWA confirmée */
        if (body.install === true) {
          await statInc(env, 'installs');
          return json({ ok: true });
        }

        const lang    = (body.lang  || 'fr').slice(0, 5);
        const hour    = String(parseInt(body.hour) || 0).padStart(2, '0');
        const date    = (body.date  || new Date().toISOString().slice(0,10)).slice(0, 10);
        const weekday = String(parseInt(body.weekday) || 0);

        await Promise.all([
          jsonInc(env, 'stats:langs',    lang),
          jsonInc(env, 'stats:hours',    hour),
          jsonInc(env, 'stats:days',     date),
          jsonInc(env, 'stats:weekdays', weekday),
        ]);
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/vapid-public-key' && request.method === 'GET') {
      return json({ publicKey: env.VAPID_PUBLIC_KEY });
    }

    if (path === '/auth' && request.method === 'POST') {
      try {
        const { password } = await request.json();
        if (password !== env.ADMIN_SECRET) return json({ error:'Unauthorized' }, 401);
        const token = await createToken(env);
        return json({ token });
      } catch(e) { return json({ error:e.message }, 500); }
    }

    if (path === '/subscribe' && request.method === 'POST') {
      try {
        const sub = await request.json();
        if (!sub?.endpoint) return json({ error:'Invalid subscription' }, 400);
        const id = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint)));
        await env.SUBS.put(id, JSON.stringify(sub), { expirationTtl:60*60*24*365 });
        return json({ ok:true, id });
      } catch(e) { return json({ error:e.message }, 500); }
    }

    if (path === '/unsubscribe' && request.method === 'DELETE') {
      try {
        const { endpoint } = await request.json();
        const id = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
        await env.SUBS.delete(id);
        return json({ ok:true });
      } catch(e) { return json({ error:e.message }, 500); }
    }

    if (path === '/notify' && request.method === 'POST') {
      const token = (request.headers.get('Authorization') || '').replace('Bearer ','');
      if (!await isValidToken(token, env)) return json({ error:'Unauthorized' }, 401);
      try {
        const { title, body, url:notifUrl, theme } = await request.json();
        if (!body) return json({ error:'body required' }, 400);
        const payload = JSON.stringify({ title:title||'Commune de Sainte-Ode', body, icon:'/Commune/icon-192.png', url:notifUrl||'/Commune/' });
        const { keys } = await env.SUBS.list({ prefix:'' });
        const subKeys = keys.filter(k =>
          !k.name.startsWith('admin_token:') &&
          !k.name.startsWith('stats:') &&
          !k.name.startsWith('report:') &&
          !k.name.startsWith('rl:')
        );
        const results = { sent:0, failed:0, removed:0 };
        await Promise.all(subKeys.map(async ({ name }) => {
          const raw = await env.SUBS.get(name);
          if (!raw) return;
          try {
            const status = await sendPush(JSON.parse(raw), payload, env);
            if (status === 200 || status === 201) results.sent++;
            else if (status === 404 || status === 410) { await env.SUBS.delete(name); results.removed++; }
            else { console.error('[push] status', status); results.failed++; }
          } catch(e) { console.error('[push]', e.message); results.failed++; }
        }));
        if (results.sent > 0) {
          await statInc(env, 'notifs_sent', results.sent);
          /* Compteur par thème */
          if (theme) await jsonInc(env, 'stats:notifs_cats', theme);
        }
        return json({ ok:true, ...results });
      } catch(e) { return json({ error:e.message }, 500); }
    }

    /* ── POST /topic — compteur sujet global ── */
    if (path === '/topic' && request.method === 'POST') {
      try {
        const { svcId } = await request.json();
        if (!svcId) return json({ error: 'svcId required' }, 400);
        await jsonInc(env, 'stats:topics', svcId);
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    /* ── POST /stats-reset-topics — remise à zéro topics (admin) ── */
    if (path === '/stats-reset-topics' && request.method === 'POST') {
      const token = (request.headers.get('Authorization') || '').replace('Bearer ','');
      if (!await isValidToken(token, env)) return json({ error:'Unauthorized' }, 401);
      try {
        await env.SUBS.delete('stats:topics');
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    /* ── POST /signalement — anti-doublon + compteurs stats ── */
    if (path === '/signalement' && request.method === 'POST') {
      try {
        const body      = await request.json();
        const village   = (body.village   || 'inconnu').slice(0, 50);
        const categorie = (body.categorie || 'général').slice(0, 50);

        const { blocked, count } = await checkSignalement(env, village, categorie);

        /* Comptabilisé dans tous les cas (bloqué ou non) */
        await Promise.all([
          statInc(env, 'signalements'),
          jsonInc(env, 'stats:signalements_cats', categorie),
        ]);

        if (blocked) {
          return json({
            ok: false, blocked: true, count,
            message: `Ce problème a déjà été signalé ${REPORT_SEUIL} fois aujourd'hui. La commune en est informée — inutile de renvoyer un message.`
          });
        }
        return json({ ok: true, blocked: false, count });
      } catch(e) { return json({ error:e.message }, 500); }
    }

    if (path === '/stats' && request.method === 'GET') {
      const token = (request.headers.get('Authorization') || '').replace('Bearer ','');
      if (!await isValidToken(token, env)) return json({ error:'Unauthorized' }, 401);
      const { keys } = await env.SUBS.list({ prefix:'' });
      const subCount = keys.filter(k =>
        !k.name.startsWith('admin_token:') &&
        !k.name.startsWith('stats:') &&
        !k.name.startsWith('report:') &&
        !k.name.startsWith('rl:')
      ).length;
      return json({ subscribers: subCount });
    }

    /* ── GET /stats-full — toutes les stats (admin) ── */
    if (path === '/stats-full' && request.method === 'GET') {
      const token = (request.headers.get('Authorization') || '').replace('Bearer ','');
      if (!await isValidToken(token, env)) return json({ error:'Unauthorized' }, 401);
      const { keys } = await env.SUBS.list({ prefix:'' });
      const subCount = keys.filter(k =>
        !k.name.startsWith('admin_token:') &&
        !k.name.startsWith('stats:') &&
        !k.name.startsWith('report:') &&
        !k.name.startsWith('rl:')
      ).length;
      const [questions, notifs_sent, signalements, installs,
             topics, langs, hours, days, weekdays, signalements_cats, notifs_cats] = await Promise.all([
        statGet(env, 'questions'),
        statGet(env, 'notifs_sent'),
        statGet(env, 'signalements'),
        statGet(env, 'installs'),
        jsonGet(env, 'stats:topics'),
        jsonGet(env, 'stats:langs'),
        jsonGet(env, 'stats:hours'),
        jsonGet(env, 'stats:days'),
        jsonGet(env, 'stats:weekdays'),
        jsonGet(env, 'stats:signalements_cats'),
        jsonGet(env, 'stats:notifs_cats'),
      ]);
      return json({ subscribers: subCount, questions, notifs_sent, signalements, installs,
                    topics, langs, hours, days, weekdays, signalements_cats, notifs_cats });
    }

    /* ── GET /test-keys — diagnostic des deux clés API ── */
    if (path === '/test-keys' && request.method === 'GET') {
      const testBody = { systemPrompt: 'Tu es un assistant.', messages: [{ role: 'user', content: 'Dis juste: OK' }], maxTokens: 10 };

      let groqStatus = 'inconnu', groqOk = false, groqDetail = '';
      try {
        const r = await proxyGroq(testBody, env);
        groqStatus = r.status;
        const d = await r.json();
        groqOk = !!d?.choices?.[0]?.message?.content;
        if (!groqOk) groqDetail = JSON.stringify(d).slice(0, 300);
      } catch(e) { groqDetail = e.message; }

      let geminiStatus = 'inconnu', geminiOk = false, geminiDetail = '';
      try {
        const r = await proxyGemini(testBody, env);
        geminiStatus = r.status;
        const d = await r.json();
        geminiOk = !!d?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!geminiOk) geminiDetail = JSON.stringify(d).slice(0, 300);
      } catch(e) { geminiDetail = e.message; }

      return json({
        groq:   { status: groqStatus,   ok: groqOk,   detail: groqDetail   },
        gemini: { status: geminiStatus, ok: geminiOk, detail: geminiDetail }
      });
    }

    return json({ error:'Not found' }, 404);
  }
};
