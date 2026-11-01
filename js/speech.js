// Мовлення: синтез (природні голоси Gemini або голоси браузера) і розпізнавання (Web Speech API).
// Розпізнавання повноцінно працює в Chrome і Edge; аудіо обробляє сервіс розпізнавання браузера.
import { getSetting, get, put, getAll, del } from './db.js';
import { synthesize, DEFAULT_VOICE } from './gemini.js';
import { toast } from './ui.js';

let voice;
let voiceName = '';
let rate = 1;
let engine = 'browser';          // 'browser' | 'gemini'
let geminiVoice = DEFAULT_VOICE;
let geminiDownUntil = 0;         // після помилки Gemini хвилину озвучуємо голосом браузера
let playToken = 0;               // зростає при зупинці — скасовує все, що ще в черзі
const audioEl = typeof Audio !== 'undefined' ? new Audio() : null;
if (audioEl) audioEl.preservesPitch = true;

const TTS_CACHE_MAX = 400;
let ttsWrites = 0;

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const us = voices.filter((v) => v.lang === 'en-US' || v.lang === 'en_US');
  voice = voices.find((v) => v.name === voiceName)
    || us.find((v) => /natural|online|google/i.test(v.name)) || us[0] || voices.find((v) => v.lang.startsWith('en'));
}

if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

const hasBrowserVoice = () => 'speechSynthesis' in window;
export const canSpeak = () => hasBrowserVoice() || engine === 'gemini';

// Читає налаштування голосу й темпу; викликається на старті та після збереження налаштувань.
export async function loadSpeechSettings() {
  voiceName = await getSetting('ttsVoice', '');
  rate = await getSetting('ttsRate', 1);
  geminiVoice = await getSetting('geminiVoice', DEFAULT_VOICE);
  engine = (await getSetting('ttsEngine', 'browser')) === 'gemini' && (await getSetting('geminiKey', '')) ? 'gemini' : 'browser';
  geminiDownUntil = 0;
  if (hasBrowserVoice()) pickVoice();
}

export const getEngine = () => engine;
const useGemini = () => engine === 'gemini' && Date.now() > geminiDownUntil;

function geminiFailed(err) {
  geminiDownUntil = Date.now() + 60_000;
  toast(`Голос Gemini тимчасово недоступний: ${err.message} Поки що звучить голос браузера.`);
}

// Озвучена фраза береться з кешу; нова — синтезується й зберігається, щоб не витрачати ліміт повторно.
async function geminiAudio(text) {
  const id = `${geminiVoice}|${text}`;
  const cached = await get('tts', id).catch(() => null);
  if (cached) return cached.blob;
  const blob = await synthesize(text, geminiVoice);
  put('tts', { id, blob, ts: Date.now() }).then(() => { if (++ttsWrites % 25 === 0) pruneTtsCache(); }).catch(() => {});
  return blob;
}

async function pruneTtsCache() {
  const all = await getAll('tts');
  if (all.length <= TTS_CACHE_MAX) return;
  all.sort((a, b) => a.ts - b.ts);
  for (const row of all.slice(0, all.length - TTS_CACHE_MAX)) await del('tts', row.id);
}

// Програє Blob; завершується, коли аудіо дограло або озвучення зупинили.
function playBlob(blob, r, token) {
  return new Promise((resolve) => {
    if (token !== playToken || !audioEl) { resolve(); return; }
    const url = URL.createObjectURL(blob);
    const done = () => { URL.revokeObjectURL(url); resolve(); };
    audioEl.onended = done;
    audioEl.onerror = done;
    audioEl.onpause = () => { if (token !== playToken) done(); };
    audioEl.src = url;
    audioEl.playbackRate = r;
    audioEl.play().catch(done);
  });
}

// Голос браузера, що чекає на кінець фрази (для черги речень).
function browserSay(text, r, token) {
  return new Promise((resolve) => {
    if (token !== playToken || !hasBrowserVoice()) { resolve(); return; }
    const u = utterance(text, r);
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

export const getRate = () => rate;
export function setRate(r) { rate = r; }

export function englishVoices() {
  if (!canSpeak()) return [];
  return speechSynthesis.getVoices()
    .filter((v) => v.lang.startsWith('en'))
    .sort((a, b) => (a.lang === 'en-US' ? 0 : 1) - (b.lang === 'en-US' ? 0 : 1) || a.name.localeCompare(b.name));
}

function utterance(text, r = rate) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  if (voice) u.voice = voice;
  u.rate = r;
  return u;
}

export function speak(text, r = rate) {
  if (!canSpeak()) return;
  stopSpeaking();
  const token = playToken;
  if (useGemini()) {
    geminiAudio(text)
      .then((blob) => playBlob(blob, r, token))
      .catch((err) => { geminiFailed(err); browserSay(text, r, token); });
    return;
  }
  browserSay(text, r, token);
}

export function stopSpeaking() {
  playToken++;
  if (audioEl && !audioEl.paused) audioEl.pause();
  if (hasBrowserVoice()) speechSynthesis.cancel();
}

/**
 * Озвучує текст, що надходить потоком: кожне завершене речення одразу ставиться в чергу,
 * тож голос починає звучати ще до кінця відповіді. Рядок-підказку «💡…» не озвучує.
 */
export function createSpeaker() {
  let buffer = '';
  let closed = !canSpeak();      // більше не приймаємо текст (кінець відповіді або підказка 💡)
  const token = playToken;
  let queue = Promise.resolve(); // речення звучать строго по черзі
  const say = (chunk) => {
    const t = chunk.trim();
    if (!t || closed) return;
    // Синтез наступного речення стартує одразу, поки попереднє ще звучить.
    const audio = useGemini() ? geminiAudio(t).catch((err) => { geminiFailed(err); return null; }) : Promise.resolve(null);
    queue = queue.then(async () => {
      const blob = await audio;
      if (token !== playToken) return;
      if (blob) await playBlob(blob, rate, token);
      else await browserSay(t, rate, token);
    });
  };
  return {
    feed(delta) {
      if (closed) return;
      buffer += delta;
      const hintAt = buffer.indexOf('💡');
      if (hintAt !== -1) {
        say(buffer.slice(0, hintAt));
        buffer = '';
        closed = true;
        return;
      }
      // Відрізаємо завершені речення: знак кінця речення + пробіл або новий рядок.
      const m = buffer.match(/^[\s\S]*[.!?…](?=\s)|^[\s\S]*\n/);
      if (m) {
        say(m[0]);
        buffer = buffer.slice(m[0].length);
      }
    },
    finish() {
      say(buffer);
      buffer = '';
      closed = true;
    },
    cancel() {
      closed = true;
      stopSpeaking();
    },
  };
}

const recognitionClass = () => window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = () => !!recognitionClass();

const ERRORS = {
  'not-allowed': 'Немає доступу до мікрофона. Дозволь його в адресному рядку браузера.',
  'service-not-allowed': 'Браузер заборонив розпізнавання мовлення.',
  'audio-capture': 'Мікрофон не знайдено.',
  network: 'Для розпізнавання мовлення потрібен інтернет.',
  'language-not-supported': 'Браузер не підтримує розпізнавання англійської.',
};

/**
 * Слухач мікрофона: говориш скільки треба, зупиняєш кнопкою.
 * Якщо браузер сам обриває сесію на паузі, слухач перезапускається, а текст накопичується.
 * onText(finalText, interimText) — для живого показу; onStop(text) — після зупинки.
 */
export function createListener({ onText, onStop, onError }) {
  const Recognition = recognitionClass();
  if (!Recognition) return null;
  let rec = null;
  let finalText = '';
  let wanted = false;

  const begin = () => {
    rec = new Recognition();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let sessionFinal = '';
    rec.onresult = (e) => {
      let interim = '';
      sessionFinal = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) sessionFinal += r[0].transcript;
        else interim += r[0].transcript;
      }
      onText?.(join(finalText, sessionFinal), interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      wanted = false;
      onError?.(ERRORS[e.error] || `Помилка розпізнавання: ${e.error}`);
    };
    rec.onend = () => {
      finalText = join(finalText, sessionFinal);
      if (wanted) { begin(); return; }
      rec = null;
      onStop?.(finalText.trim());
    };
    rec.start();
  };

  return {
    start() {
      if (wanted) return;
      stopSpeaking(); // щоб мікрофон не записав голос співрозмовника
      finalText = '';
      wanted = true;
      begin();
    },
    stop() {
      wanted = false;
      rec?.stop();
    },
    abort() {
      wanted = false;
      onStop = null;
      rec?.abort();
    },
    get listening() { return wanted; },
  };
}

const join = (a, b) => [a.trim(), b.trim()].filter(Boolean).join(' ');
