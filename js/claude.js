// Клієнт Claude API. SDK підвантажується з CDN лише тоді, коли він справді потрібен,
// щоб решта застосунку (картки, журнал) працювала офлайн.
import { getSetting } from './db.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — найкраща якість', price: { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 } },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — дешевше, теж дуже добре', price: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — найдешевше', price: { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
];
export const DEFAULT_MODEL = MODELS[0].id;

// Серверний fallback на випадок спрацювання класифікаторів безпеки (Opus/Sonnet 5.5 на Claude API).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

let sdkPromise;
const loadSdk = () => (sdkPromise ??= import(SDK_URL).then((m) => m.default));

export class ClaudeError extends Error {}

async function setup() {
  const apiKey = await getSetting('apiKey', '');
  if (!apiKey) throw new ClaudeError('Додай ключ Claude API у «Налаштуваннях».');
  let Anthropic;
  try {
    Anthropic = await loadSdk();
  } catch {
    sdkPromise = null;
    throw new ClaudeError('Не вдалося завантажити Anthropic SDK. Перевір інтернет-з\'єднання.');
  }
  const model = await getSetting('model', DEFAULT_MODEL);
  // Ключ належить самому користувачу й зберігається лише в його браузері — тому прямий виклик з браузера тут прийнятний.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  return { Anthropic, client, model };
}

function requestParams(model, params) {
  if (!FALLBACK_MODELS.has(model)) return { model, ...params };
  return { model, ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
}

function friendlyError(Anthropic, err) {
  if (err instanceof ClaudeError) return err;
  const detail = err?.error?.error?.message || err?.message;
  if (err instanceof Anthropic.AuthenticationError) return new ClaudeError('Ключ API не прийнято. Перевір його в «Налаштуваннях».');
  if (err instanceof Anthropic.PermissionDeniedError) return new ClaudeError('Цей ключ не має доступу до обраної моделі.');
  if (err instanceof Anthropic.RateLimitError) return new ClaudeError('Забагато запитів або вичерпано ліміт. Спробуй за хвилину.');
  if (err instanceof Anthropic.BadRequestError) return new ClaudeError(`Запит відхилено: ${detail}`);
  if (err instanceof Anthropic.APIConnectionError) return new ClaudeError('Немає з\'єднання з Claude API.');
  if (err instanceof Anthropic.APIError) return new ClaudeError(`Помилка Claude API (${err.status ?? '?'}): ${detail}`);
  return new ClaudeError(detail || String(err));
}

const textOf = (message) => message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

// Стрімінг відповіді в розмові. onText отримує кожен новий фрагмент тексту.
export async function streamReply({ system, messages, onText, signal }) {
  const { Anthropic, client, model } = await setup();
  try {
    const stream = client.beta.messages.stream(requestParams(model, {
      max_tokens: 16000,
      system,
      messages,
      // Розмова: швидкі живі відповіді важливіші за глибокі міркування.
      output_config: { effort: 'low' },
      // Автокешування історії: кожна наступна репліка перевикористовує попередній префікс.
      cache_control: { type: 'ephemeral' },
    }), { signal });
    stream.on('text', (delta) => onText(delta));
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new ClaudeError('Модель відмовилася відповідати на цю репліку. Спробуй сформулювати інакше.');
    return { text: textOf(message), usage: message.usage, model };
  } catch (err) {
    if (signal?.aborted) throw err;
    throw friendlyError(Anthropic, err);
  }
}

// Один запит зі структурованою JSON-відповіддю за схемою.
export async function structured({ system, prompt, schema, effort = 'medium' }) {
  const { Anthropic, client, model } = await setup();
  try {
    const stream = client.beta.messages.stream(requestParams(model, {
      max_tokens: 32000,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort, format: { type: 'json_schema', schema } },
    }));
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new ClaudeError('Модель відмовилася робити розбір цієї розмови.');
    if (message.stop_reason === 'max_tokens') throw new ClaudeError('Розбір вийшов задовгим і обірвався. Спробуй ще раз.');
    return { data: JSON.parse(textOf(message)), usage: message.usage, model };
  } catch (err) {
    throw friendlyError(Anthropic, err);
  }
}
