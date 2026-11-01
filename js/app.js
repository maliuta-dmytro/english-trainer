import { $$, toast } from './ui.js';
import { loadSpeechSettings } from './speech.js';
import { initSync, syncNow } from './sync.js';
import * as home from './views/home.js';
import * as review from './views/review.js';
import * as cards from './views/cards.js';
import * as settings from './views/settings.js';
import * as talk from './views/talk.js';
import * as journal from './views/journal.js';
import * as progress from './views/progress.js';
import * as dictation from './views/dictation.js';
import * as fluency from './views/fluency.js';
import * as grammar from './views/grammar.js';
import * as trip from './views/trip.js';
import * as retell from './views/retell.js';

const routes = { '': home, home, review, cards, settings, talk, journal, progress, dictation, fluency, grammar, trip, retell };
// Підрозділи, що підсвічують свій пункт меню.
const NAV_PARENT = { dictation: 'retell', fluency: 'talk', trip: 'talk', review: 'cards', journal: 'progress', grammar: 'progress' };
const app = document.getElementById('app');
let cleanup = null;
let renderId = 0;

async function render() {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0];
  const view = routes[name] || home;
  const id = ++renderId;
  if (cleanup) { const c = cleanup; cleanup = null; await c(); }
  const navName = NAV_PARENT[name] || name || 'home';
  $$('[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === navName));
  app.innerHTML = '';
  const c = await view.render(app);
  if (id === renderId) cleanup = c || null;
  else if (c) await c();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
// Облік часу має зберегтися, навіть якщо вкладку закрили посеред сесії.
window.addEventListener('pagehide', () => { if (cleanup) cleanup(); });
loadSpeechSettings();
render();

// ---------- Синхронізація між пристроями ----------
const syncBtn = document.getElementById('sync-btn');
window.addEventListener('sync-state', ({ detail }) => {
  syncBtn.hidden = detail.status === 'off';
  syncBtn.dataset.state = detail.status;
  syncBtn.title = detail.message || { syncing: 'Синхронізую…', idle: 'Синхронізовано', 'needs-login': 'Натисни, щоб увійти й синхронізувати' }[detail.status] || 'Синхронізація';
});
syncBtn.addEventListener('click', async () => {
  try {
    const res = await syncNow({ interactive: true });
    if (!res.skipped) toast(res.changes ? `Синхронізовано: оновлено записів ${res.changes}` : 'Усе синхронізовано');
  } catch (err) {
    toast(err.message);
  }
});
// Прийшли зміни з іншого пристрою — оновлюємо екран, якщо це не активна сесія (повторення, розмова, переказ…).
window.addEventListener('synced', () => {
  const inSession = /[?&]id=/.test(location.hash) || location.hash.startsWith('#/review');
  if (!inSession) render();
});
initSync();

// Просимо браузер не видаляти локальні дані при нестачі місця.
navigator.storage?.persist?.();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
