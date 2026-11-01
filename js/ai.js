// Спільний шар над провайдерами ШІ: модулі застосунку звертаються сюди, а не до claude.js / gemini.js напряму.
import { getSetting } from './db.js';
import * as claude from './claude.js';
import * as gemini from './gemini.js';

export const PROVIDERS = {
  claude: { id: 'claude', name: 'Claude', client: claude, keySetting: 'apiKey', modelSetting: 'model' },
  gemini: { id: 'gemini', name: 'Gemini', client: gemini, keySetting: 'geminiKey', modelSetting: 'geminiModel' },
};

const ALL_MODELS = [...claude.MODELS, ...gemini.MODELS];

export async function currentProvider() {
  return PROVIDERS[await getSetting('provider', 'claude')] || PROVIDERS.claude;
}

// Чи є ключ для обраного провайдера — від цього залежать кнопки розмови, уроків і генерації.
export async function hasKey() {
  const p = await currentProvider();
  return !!(await getSetting(p.keySetting, ''));
}

export async function currentModel() {
  const p = await currentProvider();
  const id = await getSetting(p.modelSetting, p.client.DEFAULT_MODEL);
  return p.client.MODELS.find((m) => m.id === id) || p.client.MODELS[0];
}

export async function streamReply(args) {
  return (await currentProvider()).client.streamReply(args);
}

export async function structured(args) {
  return (await currentProvider()).client.structured(args);
}

// Приблизна вартість у доларах (за цінами платного рівня; на безкоштовному рівні Gemini оплати немає).
export function costOf(usage, modelId) {
  const p = (ALL_MODELS.find((m) => m.id === modelId) || ALL_MODELS[0]).price;
  if (!usage) return 0;
  return ((usage.input_tokens || 0) * p.in
    + (usage.output_tokens || 0) * p.out
    + (usage.cache_read_input_tokens || 0) * p.cacheRead
    + (usage.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
}

export const NO_KEY_HTML = 'Потрібен ключ ШІ (Claude або Gemini). <a href="#/settings">Додати в налаштуваннях →</a>';
