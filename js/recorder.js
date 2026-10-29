// Запис голосу з мікрофона (MediaRecorder), звуковий сигнал і блокування згасання екрана.

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export const canRecord = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

const MIC_ERRORS = {
  NotAllowedError: 'Немає доступу до мікрофона. Дозволь його в адресному рядку браузера.',
  NotFoundError: 'Мікрофон не знайдено.',
  NotReadableError: 'Мікрофон зайнятий іншою програмою.',
};

/** Відкриває мікрофон один раз на сесію; кожен раунд — окремий запис. */
export async function openMic() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    throw new Error(MIC_ERRORS[err.name] || `Мікрофон недоступний: ${err.message}`);
  }
  const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  let rec = null;
  let chunks = [];

  return {
    start() {
      chunks = [];
      rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.start(1000);
    },
    /** Зупиняє запис і повертає Blob. */
    stop() {
      return new Promise((resolve) => {
        if (!rec || rec.state === 'inactive') { resolve(null); return; }
        rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
        rec.stop();
      });
    },
    release() {
      if (rec && rec.state !== 'inactive') rec.stop();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/**
 * Chrome записує WebM без тривалості (duration = Infinity), і плеєр не вміє перемотувати.
 * Обхід: стрибок у далекий кінець змушує браузер прочитати файл і обчислити тривалість.
 */
export function fixDuration(audio) {
  audio.addEventListener('loadedmetadata', () => {
    if (audio.duration !== Infinity) return;
    const reset = () => {
      audio.removeEventListener('timeupdate', reset);
      audio.currentTime = 0;
    };
    audio.addEventListener('timeupdate', reset);
    audio.currentTime = 1e101;
  }, { once: true });
}

let audioCtx;
/** Короткий сигнал кінця раунду (два тони). */
export function beep() {
  try {
    audioCtx ??= new AudioContext();
    const now = audioCtx.currentTime;
    [[880, 0], [660, 0.18]].forEach(([freq, at]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.16);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.18);
    });
  } catch { /* звук не критичний */ }
}

/** Не дає екрану телефона згаснути під час раунду. Повертає функцію звільнення. */
export async function keepAwake() {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    return () => lock?.release().catch(() => {});
  } catch {
    return () => {};
  }
}

// Слова-паразити. «like», «actually» тощо не рахуємо: вони часто вжиті доречно, і без контексту це шум.
// Розпізнавач мовлення інколи сам викидає «um/uh», тож число — орієнтир, а не точний підрахунок.
const FILLERS = /\b(um+|uh+|er+|erm|hmm+|you know|i mean|basically)\b/gi;
export const countFillers = (text) => (text.match(FILLERS) || []).length;
export const countWords = (text) => (text.match(/[\p{L}']+/gu) || []).length;
