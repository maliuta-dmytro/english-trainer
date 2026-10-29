import { $$ } from './ui.js';
import { loadSpeechSettings } from './speech.js';
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

const routes = { '': home, home, review, cards, settings, talk, journal, progress, dictation, fluency, grammar, trip };
const app = document.getElementById('app');
let cleanup = null;
let renderId = 0;

async function render() {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0];
  const view = routes[name] || home;
  const id = ++renderId;
  if (cleanup) { const c = cleanup; cleanup = null; await c(); }
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (name || 'home')));
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

// Просимо браузер не видаляти локальні дані при нестачі місця.
navigator.storage?.persist?.();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
