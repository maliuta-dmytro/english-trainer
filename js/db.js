// Тонка обгортка над IndexedDB. Усі дані живуть локально в браузері.
import { toast } from './ui.js';

const DB_NAME = 'english-trainer';
const DB_VERSION = 8;

// cards         — фрази з розкладом повторень по обох напрямках
// sessions      — облік часу по чотирьох потоках (input / output / focus / fluency)
// meta          — налаштування й службові значення
// conversations — розмови з ШІ разом із розбором
// errors        — журнал помилок (з розборів), по одній помилці на запис
// dictations    — диктанти: фрагменти, прогрес і результати
// media         — аудіо/відео для диктантів і записи 4/3/2 (Blob), окремо, щоб списки читались швидко
// fluency       — сесії 4/3/2: тема, раунди, слова за хвилину
// lessons       — граматичні міні-уроки: зміст, відповіді, перевірка
// tts           — кеш озвучених голосом Gemini фраз (Blob), щоб не витрачати ліміт повторно
// retells       — сесії «Слухай і перекажи»: матеріал, фрагмент, позначки, переказ, розбір
// channels      — збережені YouTube-канали й кеш списку їхніх відео
let dbPromise;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cards')) {
        const s = db.createObjectStore('cards', { keyPath: 'id' });
        s.createIndex('created', 'created');
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('errors')) {
        const s = db.createObjectStore('errors', { keyPath: 'id' });
        s.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('dictations')) {
        db.createObjectStore('dictations', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('media')) {
        db.createObjectStore('media', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('fluency')) {
        db.createObjectStore('fluency', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('lessons')) {
        db.createObjectStore('lessons', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('tts')) {
        db.createObjectStore('tts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('channels')) {
        db.createObjectStore('channels', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('retells')) {
        db.createObjectStore('retells', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Інша вкладка відкрила новішу версію застосунку й хоче оновити базу:
      // звільняємо з'єднання й перезавантажуємось, щоб і ця вкладка отримала нову версію.
      db.onversionchange = () => {
        db.close();
        location.reload();
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // Оновлення бази чекає, поки закриються старі вкладки (наприклад, зі старою версією без onversionchange).
    req.onblocked = () => toast('Застосунок оновився. Закрий або перезавантаж інші вкладки English Trainer, щоб завершити оновлення.');
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
export const get = (store, id) => tx(store, 'readonly', (s) => s.get(id));
export const put = (store, obj) => tx(store, 'readwrite', (s) => s.put(obj));
export const del = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));

export async function putMany(store, items) {
  return tx(store, 'readwrite', (s) => { for (const it of items) s.put(it); });
}

export async function getSetting(key, fallback) {
  const row = await get('meta', key);
  return row === undefined ? fallback : row.value;
}

export const setSetting = (key, value) => put('meta', { key, value });

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Ключі API ніколи не потрапляють у бекап і не відновлюються з нього.
const SECRET_KEYS = new Set(['apiKey', 'geminiKey', 'youtubeKey']);

// Повний бекап у JSON; імпорт замінює записи з тими самими id і додає нові.
export async function exportAll() {
  // Медіафайли в бекап не потрапляють (завеликі) — після відновлення їх додають знову.
  const [cards, sessions, meta, conversations, errors, dictations, fluency, lessons, retells, channels] = await Promise.all(
    ['cards', 'sessions', 'meta', 'conversations', 'errors', 'dictations', 'fluency', 'lessons', 'retells', 'channels'].map(getAll),
  );
  return {
    app: 'english-trainer',
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    cards,
    sessions,
    conversations,
    errors,
    dictations,
    fluency,
    lessons,
    retells,
    channels,
    meta: meta.filter((m) => !SECRET_KEYS.has(m.key)),
  };
}

export async function importAll(data) {
  if (!data || data.app !== 'english-trainer') throw new Error('Це не бекап English Trainer');
  await putMany('cards', data.cards || []);
  await putMany('sessions', data.sessions || []);
  await putMany('conversations', data.conversations || []);
  await putMany('errors', data.errors || []);
  await putMany('dictations', data.dictations || []);
  await putMany('fluency', data.fluency || []);
  await putMany('lessons', data.lessons || []);
  await putMany('retells', data.retells || []);
  await putMany('channels', data.channels || []);
  await putMany('meta', (data.meta || []).filter((m) => !SECRET_KEYS.has(m.key)));
  return { cards: (data.cards || []).length, sessions: (data.sessions || []).length };
}
