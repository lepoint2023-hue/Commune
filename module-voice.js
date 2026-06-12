'use strict';

const STT_LANG = {
  fr: 'fr-BE', nl: 'nl-BE', en: 'en-GB',
  de: 'de-DE', es: 'es-ES', ar: 'ar-SA',
};

const PREFERRED_VOICES = {
  fr: ['Google Belgique', 'Google Belgian French', 'fr-BE', 'Google français', 'Amélie', 'Marie', 'Audrey', 'Virginie'],
  nl: ['Google Nederlands',        'Ellen',    'Xander'                            ],
  en: ['Google UK English Female', 'Samantha', 'Karen',    'Moira',    'Serena'   ],
  de: ['Google Deutsch',           'Anna',     'Petra'                             ],
  es: ['Google español',           'Monica',   'Paulina'                           ],
  ar: ['Google العربية',           'Maged'                                         ],
};

const FEMALE_HINTS = [
  'female','femme','woman',
  'amélie','marie','audrey','virginie',
  'karen','samantha','moira','serena','hazel','susan','victoria',
  'anna','petra','anna',
  'monica','paulina',
  'ellen','denise','zira','allison','ava',
];

const VLABELS = {
  idle:      { fr:'Appuyez pour parler',           nl:'Druk om te spreken',              en:'Press to speak',               de:'Drücken zum Sprechen',          es:'Presione para hablar',       ar:'اضغط للتحدث'         },
  listening: { fr:'Je vous écoute…',               nl:'Ik luister…',                     en:"I'm listening…",               de:'Ich höre zu…',                  es:'Le escucho…',                ar:'أستمع إليك…'          },
  thinking:  { fr:'Je réfléchis…',                 nl:'Ik denk na…',                     en:'Thinking…',                    de:'Ich denke…',                    es:'Pensando…',                  ar:'أفكر…'                },
  speaking:  { fr:'Je vous réponds…',              nl:'Ik antwoord…',                    en:'Speaking…',                    de:'Ich spreche…',                  es:'Respondiendo…',              ar:'أتحدث…'               },
  error_stt: { fr:'Micro non disponible',          nl:'Microfoon niet beschikbaar',      en:'Microphone unavailable',       de:'Mikrofon nicht verfügbar',      es:'Micrófono no disponible',    ar:'الميكروفون غير متاح'  },
  unavail:   { fr:'Voix non dispo sur cet appareil', nl:'Stem niet beschikbaar',         en:'Voice not available',          de:'Stimme nicht verfügbar',        es:'Voz no disponible',          ar:'الصوت غير متاح'       },
};

const _voiceCache = {};

let _voiceOpen   = false;
let _recognition = null;
let _voiceState  = 'idle';
let _loopEnabled = false;
let _speaking    = false;
let _greetingDone = false; /* salutation jouée une seule fois par session */

const GREETINGS = {
  fr: "Bonjour, je suis Ode, votre assistante communale. Je vous écoute.",
  nl: "Goedag, ik ben Ode, uw gemeentelijke assistent. Ik luister.",
  en: "Hello, I'm Ode, your municipal assistant. I'm listening.",
  de: "Guten Tag, ich bin Ode, Ihre Gemeindeassistentin. Ich höre zu.",
  es: "Hola, soy Ode, su asistente municipal. Le escucho.",
  ar: "مرحباً، أنا Ode، مساعدتك البلدية. أستمع إليك.",
};

function _lang() { return (typeof lang === 'string' && lang) ? lang : 'fr'; }

function _label(key) {
  const l = _lang();
  return (VLABELS[key] || VLABELS.idle)[l] || (VLABELS[key] || VLABELS.idle).fr;
}

/* ── Convertisseur nombres → français belge (pour TTS) ── */
function _numBE(n) {
  if (n < 0 || n > 9999) return String(n);
  var U = ['','un','deux','trois','quatre','cinq','six','sept','huit','neuf',
           'dix','onze','douze','treize','quatorze','quinze','seize',
           'dix-sept','dix-huit','dix-neuf'];
  var T = ['','','vingt','trente','quarante','cinquante','soixante',
           'septante','quatre-vingt','nonante'];
  var r = '', m = n;
  if (m >= 1000) {
    var k = Math.floor(m/1000);
    r += (k===1 ? 'mille' : U[k]+' mille') + ' '; m %= 1000;
  }
  if (m >= 100) {
    var h = Math.floor(m/100);
    r += (h===1 ? 'cent' : U[h]+' cent') + (m%100 ? ' ' : ''); m %= 100;
  }
  if (m >= 20) {
    var t = Math.floor(m/10), u = m%10;
    r += T[t] + (u ? (u===1 ? ' et un' : '-'+U[u]) : '');
  } else if (m > 0) {
    r += U[m];
  }
  return r.trim() || 'zéro';
}

function _plain(text) {
  return text
    /* Emojis et symboles Unicode */
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu,   '')
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
    .replace(/[\u{FE00}-\u{FEFF}]/gu,   '')
    /* Caractères spéciaux courants */
    .replace(/[📞✉🔥💧🌳🏗️🚗🏥⛽💡🗑️💬🐾👮🆘☠️📵⚠️✅❌👍👎📞]/g, '')
    .replace(/\u26a0|\u2705|\u274c|\u2764|\u2022/g, '')
    /* Markdown */
    .replace(/\*\*(.*?)\*\*/g,            '$1')
    .replace(/\*(.*?)\*/g,                '$1')
    .replace(/\*/g,                         '')  /* astérisques isolés restants */
    .replace(/\[([^\]]+)\]\([^)]+\)/g,   '$1')
    .replace(/https?:\/\/[^\s<"]+/g,     '')
    .replace(/<[^>]+>/g,                 ' ')
    .replace(/^[-•]\s/gm,               '')
    .replace(/#{1,6}\s/g,               '')
    .replace(/\n{2,}/g,                 '. ')
    .replace(/\n/g,                     ' ')
    .replace(/\s{2,}/g,                 ' ')
    /* Symboles parlés incorrectement */
    .replace(/&amp;/g, 'et')
    .replace(/&/g,     'et')
    /* ── Nombres belges ── */
    /* 1. Formes en toutes lettres (générées par l'IA en fr-FR) */
    .replace(/soixante[- ]et[- ]onze/gi,  'septante et un')
    .replace(/soixante[- ]dix[- ]sept/gi, 'septante-sept')
    .replace(/soixante[- ]dix[- ]huit/gi, 'septante-huit')
    .replace(/soixante[- ]dix[- ]neuf/gi, 'septante-neuf')
    .replace(/soixante[- ]dix[- ]six/gi,  'septante-six')
    .replace(/soixante[- ]dix[- ]cinq/gi, 'septante-cinq')
    .replace(/soixante[- ]dix[- ]quatre/gi,'septante-quatre')
    .replace(/soixante[- ]dix[- ]trois/gi,'septante-trois')
    .replace(/soixante[- ]dix[- ]deux/gi, 'septante-deux')
    .replace(/soixante[- ]dix/gi,          'septante')
    .replace(/quatre[- ]vingt[- ]dix[- ]neuf/gi,  'nonante-neuf')
    .replace(/quatre[- ]vingt[- ]dix[- ]huit/gi,  'nonante-huit')
    .replace(/quatre[- ]vingt[- ]dix[- ]sept/gi,  'nonante-sept')
    .replace(/quatre[- ]vingt[- ]dix[- ]six/gi,   'nonante-six')
    .replace(/quatre[- ]vingt[- ]dix[- ]cinq/gi,  'nonante-cinq')
    .replace(/quatre[- ]vingt[- ]dix[- ]quatre/gi,'nonante-quatre')
    .replace(/quatre[- ]vingt[- ]dix[- ]trois/gi, 'nonante-trois')
    .replace(/quatre[- ]vingt[- ]dix[- ]deux/gi,  'nonante-deux')
    .replace(/quatre[- ]vingt[- ]et[- ]onze/gi,   'nonante et un')
    .replace(/quatre[- ]vingt[- ]dix/gi,           'nonante')
    /* 2. Chiffres arabes — tous les nombres dont les dizaines sont en 70-79 ou 90-99
          Couvre 70 seul ET 370, 1270, 4,70 EUR etc. (pas de \b qui rate les prefixes) */
    .replace(/\d{1,4}/g, function(m) {
      var n = parseInt(m, 10);
      var tens = n % 100;
      if ((tens >= 70 && tens <= 79) || (tens >= 90 && tens <= 99)) {
        return _numBE(n);
      }
      return m;
    })
    /* ── Corrections de prononciation locales ── */
.replace(/\bFays\b/g, 'Failli')        /* Pierre-Yves Fays → "Fayi" comme "zizi", "abris", " */
.replace(/\bRaskin\b/g, 'Raskain')  // "in" comme "vin", "pain", "main"
.replace(/\bRaskin[e]?\b/g, 'Rasquain') // "ain" précédé du k bien marqué sans e
.trim();
}

function _isFemale(voice) {
  const n = (voice.name + ' ' + voice.voiceURI).toLowerCase();
  return FEMALE_HINTS.some(h => n.includes(h));
}

function _pickVoice(l) {
  if (_voiceCache[l]) return _voiceCache[l];

  const all    = window.speechSynthesis.getVoices();
  if (!all.length) return null;

  const inLang = l === 'fr'
    ? all.filter(v => v.lang.toLowerCase().startsWith('fr-be'))
        .concat(all.filter(v => v.lang.toLowerCase().startsWith('fr') && !v.lang.toLowerCase().startsWith('fr-be')))
    : all.filter(v => v.lang.toLowerCase().startsWith(l.toLowerCase()));
  if (!inLang.length) { _voiceCache[l] = all[0]; return all[0]; }

  const preferred = PREFERRED_VOICES[l] || [];
  for (const name of preferred) {
    const hit = inLang.find(v => v.name.toLowerCase().includes(name.toLowerCase()));
    if (hit) { _voiceCache[l] = hit; return hit; }
  }

  const female = inLang.find(v => _isFemale(v));
  if (female) { _voiceCache[l] = female; return female; }

  _voiceCache[l] = inLang[0];
  return inLang[0];
}

function _ensureVoices(cb) {
  if (window.speechSynthesis.getVoices().length > 0) { cb(); return; }
  window.speechSynthesis.addEventListener('voiceschanged', function once() {
    window.speechSynthesis.removeEventListener('voiceschanged', once);
    cb();
  });
}

function _setState(state) {
  _voiceState = state;
  const orb    = document.getElementById('voice-orb');
  const status = document.getElementById('voice-status');
  const micBtn = document.getElementById('voice-mic-btn');
  if (!orb || !status) return;
  orb.className    = 'voice-orb'    + (state !== 'idle' ? ' ' + state : '');
  status.className = 'voice-status' + (state !== 'idle' ? ' ' + state : '');
  status.textContent = _label(state);
  if (micBtn) micBtn.className = 'voice-mic-btn' + (state === 'listening' ? ' listening' : '');
}

function _addTranscript(role, text) {
  const box = document.getElementById('voice-transcript');
  if (!box) return;
  const div = document.createElement('div');
  div.className = role === 'user' ? 'vt-user' : 'vt-bot';

  if (role === 'bot') {
    let safe = text.length > 800 ? text.slice(0, 797) + '…' : text;
    safe = safe.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    safe = safe.replace(
      /(https?:\/\/[^\s&<>"]+)/g,
      '<a href="$1" target="_blank" rel="noopener" style="color:#93c5fd;text-decoration:underline;word-break:break-all">$1</a>'
    );
    safe = safe.replace(
      /(\+32[\s.\-\/]?\d{2,3}[\s.\-\/]?\d{2}[\s.\-\/]?\d{2}[\s.\-\/]?\d{2}|\b0\d{2,3}[\s.\-\/]?\d{2}[\s.\-\/]?\d{2}[\s.\-\/]?\d{2})/g,
      function(p) {
        var tel  = p.replace(/[\s.\-\/]/g, '');
        var intl = tel.startsWith('0') ? '+32' + tel.slice(1) : tel;
        return '<a href="tel:' + intl + '" style="color:#86efac;text-decoration:underline;white-space:nowrap;font-weight:600">📞\u202f' + p + '</a>';
      }
    );
    safe = safe.replace(
      /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g,
      '<a href="mailto:$1" style="color:#93c5fd;text-decoration:underline">✉\u202f$1</a>'
    );
    safe = safe.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/\n/g, '<br>');
    div.innerHTML = safe;
  } else {
    div.textContent = text.length > 200 ? text.slice(0, 197) + '…' : text;
  }

  box.appendChild(div);
  setTimeout(() => { box.scrollTop = box.scrollHeight; }, 0);
}

function _stopSpeaking() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  _speaking = false;
}

function _splitSentences(text) {
  const raw = text.replace(/([.!?:—])\s+/g, '$1\n').split('\n');
  const chunks = [];
  let current = '';
  for (const part of raw) {
    const p = part.trim();
    if (!p) continue;
    if ((current + ' ' + p).length > 220 && current) {
      chunks.push(current.trim());
      current = p;
    } else {
      current = current ? current + ' ' + p : p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

function speakText(rawText, onDone) {
  const clean = _plain(rawText);
  if (!clean) { if (onDone) onDone(); return; }
  _stopSpeaking();

  _ensureVoices(() => {
    if (!window.speechSynthesis) { if (onDone) onDone(); return; }

    if (_voiceOpen) _setState('speaking');
    _speaking = true;

    const stopBtn = document.getElementById('stop-btn');
    if (stopBtn) stopBtn.classList.add('visible');

    const l      = _lang();
    const voice  = _pickVoice(l);
    const chunks = _splitSentences(clean);
    let   idx    = 0;

    function speakNext() {
      if (!_speaking || idx >= chunks.length) {
        _speaking = false;
        if (stopBtn) stopBtn.classList.remove('visible');
        _onSpeakEnd();
        if (onDone) onDone();
        return;
      }

      const utt  = new SpeechSynthesisUtterance(chunks[idx++]);
      utt.lang   = STT_LANG[l] || 'fr-BE';
      utt.rate   = 0.93;
      utt.pitch  = 1.08;
      utt.volume = 1.0;
      if (voice) utt.voice = voice;

      utt.onend = () => setTimeout(speakNext, 120);

      utt.onerror = (e) => {
        if (e.error === 'interrupted') return;
        console.warn('[Ode Voice] TTS chunk', idx, ':', e.error);
        setTimeout(speakNext, 200);
      };

      if (/Android|Chrome/i.test(navigator.userAgent)) {
        let lastCheck = Date.now();
        const ticker = setInterval(function() {
          if (!_speaking) { clearInterval(ticker); return; }
          if (window.speechSynthesis.paused) {
            window.speechSynthesis.resume();
          } else if (!window.speechSynthesis.speaking) {
            clearInterval(ticker);
            setTimeout(speakNext, 100);
          }
        }, 5000);
        const origEnd = utt.onend;
        const origErr = utt.onerror;
        utt.onend   = function() { clearInterval(ticker); origEnd(); };
        utt.onerror = function(e) { clearInterval(ticker); origErr(e); };
      }

      window.speechSynthesis.speak(utt);
    }

    speakNext();
  });
}
function _onSpeakEnd() {
  if (_voiceOpen && _loopEnabled) {
    setTimeout(startListening, 500);
  } else {
    _setState('idle');
  }
}

function stopVoicePlayback() {
  _loopEnabled = false;
  _stopSpeaking();
  const stopBtn = document.getElementById('stop-btn');
  if (stopBtn) stopBtn.classList.remove('visible');
  _setState('idle');
}

function startListening() {
  if (!_voiceOpen) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { _setState('error_stt'); return; }

  _stopSpeaking();
  if (_recognition) { try { _recognition.abort(); } catch (e) {} }

  const l = _lang();
  _recognition                 = new SR();
  _recognition.lang            = STT_LANG[l] || 'fr-BE';
  _recognition.continuous      = false;
  _recognition.interimResults  = false;
  _recognition.maxAlternatives = 1;

  _recognition.onstart = () => _setState('listening');

  _recognition.onresult = async (event) => {
    const transcript = event.results[0]?.[0]?.transcript?.trim();
    if (!transcript) { startListening(); return; }

    _addTranscript('user', transcript);
    _setState('thinking');
    _loopEnabled = true;

    if (typeof addMsg     === 'function') addMsg('user', transcript);
    if (typeof callGemini === 'function') await callGemini(transcript);
  };

  _recognition.onerror = (e) => {
    if (e.error === 'aborted')   return;
    if (e.error === 'no-speech') { if (_voiceOpen) startListening(); return; }
    console.warn('[Ode Voice] STT:', e.error);
    _setState('error_stt');
    setTimeout(() => { if (_voiceOpen) _setState('idle'); }, 2000);
  };

  _recognition.onend = () => {
    if (_voiceOpen && _voiceState === 'listening') setTimeout(startListening, 200);
  };

  _recognition.start();
}

function _stopListening() {
  if (_recognition) { try { _recognition.abort(); } catch (e) {} _recognition = null; }
}

function openVoiceOverlay() {
  const overlay = document.getElementById('voice-overlay');
  if (!overlay) return;
  const box = document.getElementById('voice-transcript');
  if (box) box.innerHTML = '';
  _voiceOpen   = true;
  _loopEnabled = true;
  overlay.classList.add('open');
  _setState('idle');

  if (!_greetingDone) {
    _greetingDone = true;
    _loopEnabled = false; /* évite que _onSpeakEnd lance startListening en double */
    const greeting = GREETINGS[_lang()] || GREETINGS.fr;
    setTimeout(function() {
      speakText(greeting, function() {
        _loopEnabled = true;
        startListening();
      });
    }, 350);
  } else {
    setTimeout(startListening, 350);
  }
}

function closeVoiceOverlay() {
  _voiceOpen   = false;
  _loopEnabled = false;
  _stopListening();
  _stopSpeaking();
  _setState('idle');
  const overlay = document.getElementById('voice-overlay');
  if (overlay) overlay.classList.remove('open');
  const micBtn = document.getElementById('mic-btn');
  if (micBtn) micBtn.classList.remove('listening');
}

function toggleInlineMic() {
  if (_voiceOpen) { closeVoiceOverlay(); }
  else {
    openVoiceOverlay();
    const micBtn = document.getElementById('mic-btn');
    if (micBtn) micBtn.classList.add('listening');
  }
}

function toggleVoiceMic() {
  if (_voiceState === 'listening') { _stopListening(); _setState('idle'); }
  else { startListening(); }
}

(function _watchMessages() {
  function attach() {
    const area = document.getElementById('messages');
    if (!area) { setTimeout(attach, 200); return; }

    new MutationObserver((mutations) => {
      if (!_voiceOpen) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains('msg-row') && !node.classList.contains('user')) {
            const bbl = node.querySelector('.bbl.bot');
            if (bbl) {
              const text = bbl.innerText || bbl.textContent || '';
              if (text.trim()) { _addTranscript('bot', text); speakText(text); }
            }
          }
        }
      }
    }).observe(area, { childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }
})();

function checkStatusOnLoad() {
  if (typeof window.exhaustedUntil !== 'undefined' && Date.now() < window.exhaustedUntil) {
    if (typeof setStatus === 'function') setStatus('quota');
  }
}

window.openVoiceOverlay  = openVoiceOverlay;
window.closeVoiceOverlay = closeVoiceOverlay;
window.toggleVoiceMic    = toggleVoiceMic;
window.toggleInlineMic   = toggleInlineMic;
window.stopVoicePlayback = stopVoicePlayback;
window.checkStatusOnLoad = checkStatusOnLoad;
