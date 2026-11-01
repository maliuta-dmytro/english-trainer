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
