// Клієнт Gemini API (Interactions API, REST). Інтерфейс збігається з claude.js:
// streamReply → { text, usage, model }, structured → { data, usage, model }.
// Історію розмови щоразу передаємо повністю й не зберігаємо на сервері (store: false).
import { getSetting } from './db.js';
import { ClaudeError as AIError } from './claude.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

export const MODELS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash — найкраща якість', price: { in: 0.75, out: 3.75, cacheRead: 0.075, cacheWrite: 0.75 } },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite — найшвидша', price: { in: 0.3, out: 2.5, cacheRead: 0.03, cacheWrite: 0.3 } },
];
export const DEFAULT_MODEL = MODELS[0].id;

async function setup() {
  const key = await getSetting('geminiKey', '');
  if (!key) throw new AIError('Додай ключ Gemini API у «Налаштуваннях».');
  return { key, model: await getSetting('geminiModel', DEFAULT_MODEL) };
}

// Повідомлення у форматі Claude ({role, content}) → кроки Interactions API.
const toSteps = (messages) => messages.map((m) => ({
  type: m.role === 'assistant' ? 'model_output' : 'user_input',
  content: [{ type: 'text', text: m.content }],
}));

// Usage у тих самих полях, що й у Claude, щоб costOf і облік працювали однаково.
// Токени «роздумів» тарифікуються як вихідні.
function toUsage(u = {}) {
  const cached = u.total_cached_tokens || 0;
  return {
    input_tokens: Math.max(0, (u.total_input_tokens || 0) - cached),
    output_tokens: (u.total_output_tokens || 0) + (u.total_thought_tokens || 0),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

const outputText = (interaction) => (interaction?.steps || [])
  .filter((s) => s.type === 'model_output')
  .flatMap((s) => s.content || [])
  .filter((c) => c.type === 'text')
  .map((c) => c.text)
  .join('');

function friendlyError(status, err = {}) {
  const msg = err.message || '';
  if (/api key not valid|API_KEY_INVALID/i.test(msg) || (status === 400 && /key/i.test(msg))) {
    return new AIError('Ключ Gemini API не прийнято. Перевір його в «Налаштуваннях».');
  }
  if (status === 429 || err.status === 'RESOURCE_EXHAUSTED') {
    return new AIError('Вичерпано ліміт запитів Gemini (на безкоштовному рівні він обмежений). Зачекай хвилину або спробуй пізніше.');
  }
  if (status === 403 || err.status === 'PERMISSION_DENIED') return new AIError(`Gemini відмовив у доступі: ${msg}`);
  if (status === 404) return new AIError(`Модель Gemini недоступна для цього ключа: ${msg}`);
  return new AIError(`Помилка Gemini API (${status || err.code || '?'}): ${msg || 'невідома помилка'}`);
}

async function post(body, { stream = false, signal } = {}) {
  const { key } = await setup();
  let res;
  try {
    res = await fetch(stream ? `${ENDPOINT}?alt=sse` : ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ ...body, stream, store: false }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new AIError('Немає з\'єднання з Gemini API.');
  }
  if (!res.ok) {
    // Google інколи загортає помилку в масив: [{ error: {...} }]
    const data = await res.json().catch(() => ({}));
    throw friendlyError(res.status, (Array.isArray(data) ? data[0] : data)?.error);
  }
  return res;
}

function checkFinal(interaction) {
  if (!interaction) return;
  if (interaction.status === 'incomplete') throw new AIError('Відповідь Gemini обірвалася (ліміт довжини). Спробуй ще раз.');
  if (interaction.status === 'failed') throw new AIError('Gemini не зміг відповісти на цю репліку. Спробуй сформулювати інакше.');
}

// Стрімінг SSE: події step.delta несуть текст, interaction.completed — фінальний стан і usage.
export async function streamReply({ system, messages, onText, signal }) {
  const { model } = await setup();
  const res = await post({
    model,
    system_instruction: system,
    input: toSteps(messages),
    // Розмова: швидкі живі відповіді важливіші за глибокі роздуми.
    generation_config: { thinking_level: 'low', max_output_tokens: 4096 },
  }, { stream: true, signal });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let final = null;
  const handle = (block) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    if (ev.event_type === 'step.delta' && ev.delta?.type === 'text' && ev.delta.text) {
      text += ev.delta.text;
      onText(ev.delta.text);
    } else if (ev.event_type === 'interaction.completed') {
      final = ev.interaction;
    } else if (ev.event_type === 'error' || ev.error) {
      throw friendlyError(ev.error?.code, ev.error);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop();
    blocks.forEach(handle);
  }
  if (buffer.trim()) handle(buffer);
  checkFinal(final);
  return { text: text || outputText(final), usage: toUsage(final?.usage), model };
}

// ---------- Синтез мовлення (TTS) ----------

export const TTS_MODEL = 'gemini-3.8-flash-tts';
export const TTS_VOICES = [
  ['Achird', 'дружній'], ['Sulafat', 'теплий'], ['Zubenelgenubi', 'невимушений'], ['Puck', 'бадьорий'],
  ['Kore', 'впевнений'], ['Charon', 'інформативний'], ['Aoede', 'легкий'], ['Callirrhoe', 'спокійний'],
  ['Iapetus', 'чіткий'], ['Erinome', 'чіткий'], ['Despina', 'плавний'], ['Algieba', 'плавний'],
  ['Leda', 'молодий'], ['Zephyr', 'яскравий'], ['Autonoe', 'яскравий'], ['Laomedeia', 'бадьорий'],
  ['Sadachbia', 'жвавий'], ['Fenrir', 'емоційний'], ['Orus', 'впевнений'], ['Alnilam', 'впевнений'],
  ['Schedar', 'рівний'], ['Gacrux', 'зрілий'], ['Pulcherrima', 'напористий'], ['Vindemiatrix', 'лагідний'],
  ['Achernar', 'м\'який'], ['Umbriel', 'невимушений'], ['Enceladus', 'з придихом'], ['Algenib', 'хрипкуватий'],
  ['Rasalgethi', 'інформативний'], ['Sadaltager', 'обізнаний'],
];
export const DEFAULT_VOICE = 'Achird';

const base64ToBlob = (b64, type) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
};

// Текст → WAV (24 кГц, моно). Текст передається дослівно, як транскрипт.
export async function synthesize(text, voice = DEFAULT_VOICE) {
  const res = await post({
    model: TTS_MODEL,
    input: toSteps([{ role: 'user', content: text }]),
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] },
  });
  const interaction = await res.json();
  checkFinal(interaction);
  const audio = (interaction.steps || [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content || [])
    .filter((c) => c.type === 'audio' && c.data)
    .at(-1);
  if (!audio) throw new AIError('Gemini не повернув аудіо.');
  return base64ToBlob(audio.data, audio.mime_type || 'audio/wav');
}

// ---------- Транскрипція аудіо, відео й YouTube ----------

const INLINE_MAX = 14 * 1024 * 1024; // base64 додає третину, а ліміт запиту 20 МБ
const UPLOAD_ENDPOINT = 'https://generativelanguage.googleapis.com/upload/v1beta/files';

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// Великі файли — через Files API (resumable upload). Google видаляє їх сам через 48 годин.
async function uploadFile(blob, mime) {
  const { key } = await setup();
  let start;
  try {
    start = await fetch(UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(blob.size),
        'X-Goog-Upload-Header-Content-Type': mime,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'english-trainer-audio' } }),
    });
  } catch {
    throw new AIError('Не вдалося почати завантаження файлу в Gemini. Перевір інтернет.');
  }
  if (!start.ok) {
    const data = await start.json().catch(() => ({}));
    throw friendlyError(start.status, (Array.isArray(data) ? data[0] : data)?.error);
  }
  const url = start.headers.get('x-goog-upload-url');
  if (!url) throw new AIError('Браузер не отримав адресу для завантаження великого файлу. Візьми коротший файл (до 14 МБ) або додай субтитри.');
  const up = await fetch(url, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: blob,
  });
  if (!up.ok) throw friendlyError(up.status, (await up.json().catch(() => ({})))?.error);
  let file = (await up.json()).file;
  // Відео й довгі файли якийсь час обробляються — чекаємо стану ACTIVE.
  for (let i = 0; file?.state === 'PROCESSING' && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`, { headers: { 'x-goog-api-key': key } });
    file = await res.json();
  }
  if (!file?.uri || file.state === 'FAILED') throw new AIError('Gemini не зміг обробити файл.');
  return file;
}

// «MM:SS», «H:MM:SS» або «MM:SS.s» → секунди.
export function parseTimecode(s) {
  const parts = String(s).trim().split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export const timecode = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};

const TRANSCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['segments'],
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'text'],
        properties: {
          start: { type: 'string', description: 'Start time MM:SS (or H:MM:SS) from the beginning of the whole recording.' },
          end: { type: 'string', description: 'End time in the same format.' },
          text: { type: 'string', description: 'Verbatim speech of one sentence or short utterance.' },
        },
      },
    },
  },
};

/**
 * Транскрипт фрагмента [start, end] (секунди) з таймкодами.
 * Джерело: blob (аудіо/відео) або youtubeUrl. Повертає [{start, end, text}] у секундах.
 */
export async function transcribe({ blob, mime, youtubeUrl, start, end }) {
  const { model } = await setup();
  let media;
  if (youtubeUrl) {
    media = { type: 'video', uri: youtubeUrl };
  } else {
    const kind = mime.startsWith('video') ? 'video' : 'audio';
    media = blob.size <= INLINE_MAX
      ? { type: kind, data: await blobToBase64(blob), mime_type: mime }
      : { type: kind, uri: (await uploadFile(blob, mime)).uri, mime_type: mime };
  }
  const prompt = `Transcribe the spoken English in this recording verbatim, only from ${timecode(start)} to ${timecode(end)}.
Split it into segments of one sentence or one short utterance each.
Timestamps are MM:SS (or H:MM:SS) measured from the very beginning of the whole recording, not from ${timecode(start)}.
Write words exactly as spoken, including reduced forms like "gonna" or "wanna". No speaker names, no descriptions of sounds or music.`;
  const res = await post({
    model,
    input: [{ type: 'user_input', content: [media, { type: 'text', text: prompt }] }],
    generation_config: { thinking_level: 'low', max_output_tokens: 16000 },
    response_format: { type: 'text', mime_type: 'application/json', schema: TRANSCRIPT_SCHEMA },
  });
  const interaction = await res.json();
  checkFinal(interaction);
  let data;
  try { data = JSON.parse(outputText(interaction)); } catch { throw new AIError('Gemini повернув транскрипт у неочікуваному форматі. Спробуй ще раз.'); }
  const segments = (data.segments || [])
    .map((s) => ({ start: parseTimecode(s.start), end: parseTimecode(s.end), text: String(s.text || '').trim() }))
    .filter((s) => s.text && s.start !== null && s.end !== null && s.end >= s.start)
    .sort((a, b) => a.start - b.start);
  if (!segments.length) throw new AIError('У цьому фрагменті Gemini не знайшов мовлення. Перевір час початку.');
  return { segments, usage: toUsage(interaction.usage), model };
}

// Один запит зі структурованою JSON-відповіддю за схемою.
export async function structured({ system, prompt, schema, effort = 'medium' }) {
  const { model } = await setup();
  const res = await post({
    model,
    system_instruction: system,
    input: toSteps([{ role: 'user', content: prompt }]),
    generation_config: { thinking_level: effort === 'low' ? 'low' : 'medium', max_output_tokens: 32000 },
    response_format: { type: 'text', mime_type: 'application/json', schema },
  });
  const interaction = await res.json();
  checkFinal(interaction);
  const raw = outputText(interaction);
  try {
    return { data: JSON.parse(raw), usage: toUsage(interaction.usage), model };
  } catch {
    throw new AIError('Gemini повернув відповідь у неочікуваному форматі. Спробуй ще раз.');
  }
}
