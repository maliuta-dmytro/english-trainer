// Мовлення через браузер: синтез (американські голоси) і розпізнавання (Web Speech API).
// Розпізнавання повноцінно працює в Chrome і Edge; аудіо обробляє сервіс розпізнавання браузера.
import { getSetting } from './db.js';

let voice;
let voiceName = '';
let rate = 1;

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

export const canSpeak = () => 'speechSynthesis' in window;

// Читає налаштування голосу й темпу; викликається на старті та після збереження налаштувань.
export async function loadSpeechSettings() {
  voiceName = await getSetting('ttsVoice', '');
  rate = await getSetting('ttsRate', 1);
  if (canSpeak()) pickVoice();
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
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance(text, r));
}

export function stopSpeaking() {
  if (canSpeak()) speechSynthesis.cancel();
}

/**
 * Озвучує текст, що надходить потоком: кожне завершене речення одразу ставиться в чергу,
 * тож голос починає звучати ще до кінця відповіді. Рядок-підказку «💡…» не озвучує.
 */
export function createSpeaker() {
  let buffer = '';
  let stopped = !canSpeak();
  const say = (chunk) => {
    const t = chunk.trim();
    if (t && !stopped) speechSynthesis.speak(utterance(t));
  };
  return {
    feed(delta) {
      if (stopped) return;
      buffer += delta;
      const hintAt = buffer.indexOf('💡');
      if (hintAt !== -1) {
        say(buffer.slice(0, hintAt));
        buffer = '';
        stopped = true;
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
      stopped = true;
    },
    cancel() {
      stopped = true;
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
