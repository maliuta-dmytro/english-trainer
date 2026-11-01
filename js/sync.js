// Синхронізація між пристроями через прихований службовий каталог Google Drive (appDataFolder).
// Без власного сервера: вхід — Google Identity Services (токен ~1 год), дані — один JSON-файл.
// Злиття по записах: перемагає новіша зміна (поле updated), видалення переносяться слідами з «deleted».
import { getAll, getSetting, setSetting, putRaw, delRaw, SYNCED_STORES, LOCAL_META } from './db.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'english-trainer-sync.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const DEBOUNCE_MS = 30_000;
const TOMBSTONE_TTL = 90 * 86_400_000;
const KEY_PATH = { meta: 'key' }; // в інших сховищах ключ — id

let token = null;
let tokenExp = 0;
let running = false;
let dirty = false;
let timer = 0;
let state = { status: 'off', message: '' };

export class SyncError extends Error {}

function setState(status, message = '') {
  state = { status, message };
  window.dispatchEvent(new CustomEvent('sync-state', { detail: state }));
}
export const syncState = () => state;

export async function syncEnabled() {
  const info = await getSetting('syncInfo', null);
  return !!(info?.enabled && (await getSetting('syncClientId', '')));
}

// ---------- Вхід ----------

let gisReady;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisReady ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => { gisReady = null; reject(new SyncError('Не вдалося завантажити вхід Google. Перевір інтернет.')); };
    document.head.appendChild(s);
  });
  return gisReady;
}

// interactive: можна відкрити вікно входу (лише після натискання кнопки — так вимагає браузер).
async function ensureToken(interactive) {
  if (token && Date.now() < tokenExp - 60_000) return token;
  const saved = await getSetting('syncToken', null);
  if (saved?.token && Date.now() < saved.exp - 60_000) {
    token = saved.token;
    tokenExp = saved.exp;
    return token;
  }
  if (!interactive) return null;
  const clientId = await getSetting('syncClientId', '');
  if (!clientId) throw new SyncError('Спершу встав OAuth Client ID у налаштуваннях синхронізації.');
  await loadGis();
  const firstTime = !(await getSetting('syncInfo', null))?.consented;
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: async (r) => {
        if (r.error) { reject(new SyncError(`Google відхилив вхід: ${r.error_description || r.error}`)); return; }
        token = r.access_token;
        tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        await setSetting('syncToken', { token, exp: tokenExp });
        resolve(token);
      },
      error_callback: (e) => reject(new SyncError(e?.type === 'popup_closed' ? 'Вікно входу закрито.' : `Вхід Google не вдався: ${e?.message || e?.type || 'невідома помилка'}`)),
    });
    client.requestAccessToken({ prompt: firstTime ? 'consent' : '' });
  });
}

async function drive(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    token = null;
    await setSetting('syncToken', null);
    throw new SyncError('Вхід у Google сплив. Натисни «Синхронізувати», щоб увійти знову.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = data.error?.message || '';
    if (/has not been used|is disabled|accessNotConfigured/i.test(msg)) {
      throw new SyncError('Google Drive API не увімкнено в проєкті Google Cloud (APIs & Services → Library → Google Drive API → Enable).');
    }
    throw new SyncError(`Помилка Google Drive (${res.status}): ${msg || 'невідома помилка'}`);
  }
  return res;
}

// ---------- Знімок і злиття ----------

async function snapshot() {
  const stores = {};
  for (const name of SYNCED_STORES) {
    const rows = await getAll(name);
    stores[name] = name === 'meta' ? rows.filter((m) => !LOCAL_META.has(m.key)) : rows;
  }
  const cutoff = Date.now() - TOMBSTONE_TTL;
  const deleted = (await getAll('deleted')).filter((t) => t.ts >= cutoff);
  return { app: 'english-trainer', format: 1, at: Date.now(), stores, deleted };
}

// Вливає віддалений знімок у локальну базу. Повертає кількість змінених записів.
export async function mergeRemote(remote) {
  if (remote?.app !== 'english-trainer') throw new SyncError('Файл синхронізації пошкоджено.');
  let count = 0;
  // Сліди видалень з обох боків: інакше видалене тут повернулося б із віддаленої копії.
  const tombs = new Map();
  for (const t of [...(await getAll('deleted')), ...(remote.deleted || [])]) {
    if (!tombs.has(t.id) || tombs.get(t.id).ts < t.ts) tombs.set(t.id, t);
  }
  for (const name of SYNCED_STORES) {
    const keyOf = (r) => r[KEY_PATH[name] || 'id'];
    const local = new Map((await getAll(name)).map((r) => [keyOf(r), r]));
    const incoming = (remote.stores?.[name] || []).filter((r) => {
      if (name === 'meta' && LOCAL_META.has(r.key)) return false;
      const t = tombs.get(`${name}|${keyOf(r)}`);
      if (t && t.ts >= (r.updated || 0)) return false; // запис видалили пізніше за останню зміну
      const mine = local.get(keyOf(r));
      return !mine || (r.updated || 0) > (mine.updated || 0);
    });
    if (incoming.length) { await putRaw(name, incoming); count += incoming.length; }
    // Видалене на іншому пристрої прибираємо, якщо тут його відтоді не змінювали.
    const gone = [...tombs.values()]
      .filter((t) => t.store === name && local.has(t.key) && (local.get(t.key).updated || 0) <= t.ts)
      .map((t) => t.key);
    if (gone.length) { await delRaw(name, gone); count += gone.length; }
  }
  if (tombs.size) await putRaw('deleted', [...tombs.values()]);
  return count;
}

async function findFile() {
  const info = await getSetting('syncInfo', {});
  if (info.fileId) return info.fileId;
  const q = encodeURIComponent(`name='${FILE_NAME}'`);
  const res = await drive(`${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`);
  return (await res.json()).files?.[0]?.id || null;
}

async function upload(fileId, data) {
  const body = JSON.stringify(data);
  if (fileId) {
    await drive(`${UPLOAD}/files/${fileId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    return fileId;
  }
  const boundary = `et${Math.random().toString(36).slice(2)}`;
  const meta = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' });
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const res = await drive(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
  });
  return (await res.json()).id;
}

async function accountEmail() {
  try {
    const res = await drive(`${DRIVE}/about?fields=user(emailAddress)`);
    return (await res.json()).user?.emailAddress || '';
  } catch {
    return '';
  }
}

// ---------- Публічний інтерфейс ----------

/**
 * Повна синхронізація: завантажити віддалене → злити → вивантажити об'єднане.
 * interactive=true дозволяє показати вікно входу (викликати лише з обробника кліку).
 */
export async function syncNow({ interactive = false } = {}) {
  if (running) { dirty = true; return { skipped: true }; }
  running = true;
  dirty = false;
  clearTimeout(timer);
  try {
    if (!(await ensureToken(interactive))) {
      setState('needs-login', 'Потрібно увійти в Google');
      return { needsLogin: true };
    }
    setState('syncing');
    const info = { ...(await getSetting('syncInfo', {})), enabled: true, consented: true };
    let fileId = await findFile();
    let changes = 0;
    if (fileId) {
      try {
        const res = await drive(`${DRIVE}/files/${fileId}?alt=media`);
        changes = await mergeRemote(await res.json());
      } catch (err) {
        if (!/404/.test(err.message)) throw err;
        fileId = null; // файл видалили вручну — створимо заново
      }
    }
    info.fileId = await upload(fileId, await snapshot());
    info.lastSync = Date.now();
    if (!info.email) info.email = await accountEmail();
    await setSetting('syncInfo', info);
    setState('idle', `Синхронізовано о ${new Date(info.lastSync).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}`);
    if (changes) window.dispatchEvent(new CustomEvent('synced', { detail: { changes } }));
    return { changes };
  } catch (err) {
    setState(token ? 'error' : 'needs-login', err.message);
    throw err;
  } finally {
    running = false;
    if (dirty) schedule();
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow().catch(() => {}); }, DEBOUNCE_MS);
}

export async function disableSync() {
  const saved = await getSetting('syncToken', null);
  if (saved?.token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(saved.token, () => {});
  token = null;
  await setSetting('syncToken', null);
  await setSetting('syncInfo', { ...(await getSetting('syncInfo', {})), enabled: false });
  setState('off');
}

// Запуск при відкритті застосунку: тиха синхронізація, якщо вхід ще дійсний; далі — після змін.
export async function initSync() {
  window.addEventListener('db-change', async () => {
    if (await syncEnabled()) { dirty = true; schedule(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && dirty) syncNow().catch(() => {});
    if (document.visibilityState === 'visible') syncEnabled().then((on) => on && syncNow().catch(() => {}));
  });
  if (await syncEnabled()) syncNow().catch(() => {});
}
