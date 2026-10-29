import { getAll, getSetting, putMany } from '../db.js';
import { SITUATIONS } from '../trip.js';
import { SCENARIOS } from '../scenarios.js';
import { makeCard } from '../stats.js';
import { startConversation } from './talk.js';
import { speak, canSpeak } from '../speech.js';
import { esc, $, $$, toast } from '../ui.js';

// Готовність ситуації: розмова з розбором, фрази в картках, диктант на тему.
function readiness(s, { convs, known, dictations }) {
  const talked = convs.some((c) => c.scenario?.id === s.scenario && c.analysis);
  const phrasesIn = s.phrases.filter((p) => known.has(p.en.trim().toLowerCase())).length;
  const dictated = dictations.some((d) => d.trip === s.id && Object.keys(d.results || {}).length);
  const score = (talked ? 1 : 0) + phrasesIn / s.phrases.length + (dictated ? 1 : 0);
  return { talked, phrasesIn, dictated, score };
}

export async function render(root) {
  const [convs, cards, dictations, tripDate, apiKey, reverse] = await Promise.all([
    getAll('conversations'), getAll('cards'), getAll('dictations'),
    getSetting('tripDate', '2027-09-01'), getSetting('apiKey', ''), getSetting('reverseDefault', true),
  ]);
  const known = new Set(cards.map((c) => c.en.trim().toLowerCase()));
  const ctx = { convs, known, dictations };
  const states = Object.fromEntries(SITUATIONS.map((s) => [s.id, readiness(s, ctx)]));
  const total = Math.round((Object.values(states).reduce((a, r) => a + r.score, 0) / (SITUATIONS.length * 3)) * 100);
  const daysLeft = Math.max(0, Math.ceil((new Date(tripDate) - new Date()) / 86_400_000));
  const month = new Date().getMonth() + 1;
  const stage3 = (month >= 7 && month <= 8) || daysLeft <= 60;
  const open = new URLSearchParams(location.hash.split('?')[1] || '').get('s');

  root.innerHTML = `
    <h1>🧳 Подорож до США</h1>
    <p class="muted">${stage3
      ? 'Зараз головний етап підготовки до поїздки: пройди кожну ситуацію хоча б раз, спершу звичайно, потім «зі складністю».'
      : 'Основна підготовка до поїздки — у липні–серпні, але розмовник і культурні поради корисні вже зараз.'}</p>

    <div class="card">
      <div class="row"><strong>Готовність до поїздки</strong><span class="spacer"></span><strong>${total}%</strong><span class="muted small">· до поїздки ${daysLeft} дн.</span></div>
      <div class="meter" style="margin-top:8px"><div style="width:${total}%"></div></div>
      <p class="muted small" style="margin:8px 0 0">По кожній ситуації: 🎭 розмова з розбором, 📒 фрази в картках, 🎧 диктант на тему.</p>
      <div class="row" style="margin-top:10px">
        <button class="primary" id="random" ${apiKey ? '' : 'disabled'}>⚡ Випадкова ситуація зі складністю</button>
        ${apiKey ? '' : '<a href="#/settings" class="small">Потрібен ключ Claude API →</a>'}
      </div>
    </div>

    <div class="situations">
      ${SITUATIONS.map((s) => {
        const r = states[s.id];
        return `
        <details class="card situation" id="s-${s.id}" ${open === s.id ? 'open' : ''}>
          <summary>
            <span class="sit-title">${s.icon} ${esc(s.title)}</span>
            <span class="badges">
              <span class="badge ${r.talked ? 'on' : ''}" title="Розмова з розбором">🎭</span>
              <span class="badge ${r.phrasesIn === s.phrases.length ? 'on' : r.phrasesIn ? 'part' : ''}" title="Фрази в картках">📒 ${r.phrasesIn}/${s.phrases.length}</span>
              <span class="badge ${r.dictated ? 'on' : ''}" title="Диктант">🎧</span>
            </span>
          </summary>
          <div class="row" style="margin:12px 0">
            <button class="primary" data-talk="${s.id}" ${apiKey ? '' : 'disabled'}>🎭 Розмова</button>
            <button data-twist="${s.id}" ${apiKey ? '' : 'disabled'}>⚡ Зі складністю</button>
            <a class="btn" href="#/dictation?trip=${s.id}">🎧 Диктант</a>
          </div>
          <h3>Що варто знати</h3>
          <ul class="tips">${s.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
          <div class="row" style="margin-top:12px"><h3 style="margin:0">Розмовник</h3><span class="spacer"></span>
            ${r.phrasesIn < s.phrases.length ? `<button class="icon-btn" data-add="${s.id}">+ Усі фрази в картки (${s.phrases.length - r.phrasesIn})</button>` : '<span class="tag">усі в картках ✓</span>'}
          </div>
          <ul class="card-list compact phrasebook">
            ${s.phrases.map((p) => `<li>
              <div style="flex:1;min-width:0"><div class="en">${esc(p.en)}</div><div class="muted small">${esc(p.ua)}</div></div>
              ${canSpeak() ? `<button class="ghost icon-btn" data-say="${esc(p.en)}" aria-label="Озвучити">🔊</button>` : ''}
              ${known.has(p.en.trim().toLowerCase()) ? '<span class="tag">✓</span>' : ''}
            </li>`).join('')}
          </ul>
        </details>`;
      }).join('')}
    </div>
    <p class="muted small">Порада: у голосовому режимі з прихованим текстом ШІ ситуації найбільше схожі на справжні. Спробуй особливо «Дзвінок телефоном».</p>`;

  // Роутер після рендеру прокручує сторінку вгору, тож до розгорнутої ситуації переходимо трохи згодом.
  if (open) setTimeout(() => $(`#s-${open}`)?.scrollIntoView({ block: 'start' }), 50);

  const scenarioOf = (sid) => SCENARIOS.find((x) => x.id === SITUATIONS.find((s) => s.id === sid).scenario);
  $$('[data-talk]').forEach((b) => b.addEventListener('click', () => startConversation(scenarioOf(b.dataset.talk), { trip: b.dataset.talk })));
  $$('[data-twist]').forEach((b) => b.addEventListener('click', () => startConversation(scenarioOf(b.dataset.twist), { trip: b.dataset.twist, twist: true })));
  $('#random').addEventListener('click', () => {
    const s = SITUATIONS[Math.floor(Math.random() * SITUATIONS.length)];
    startConversation(scenarioOf(s.id), { trip: s.id, twist: true });
  });
  $$('[data-say]').forEach((b) => b.addEventListener('click', () => speak(b.dataset.say)));
  $$('[data-add]').forEach((b) => b.addEventListener('click', async () => {
    const s = SITUATIONS.find((x) => x.id === b.dataset.add);
    const fresh = s.phrases.filter((p) => !known.has(p.en.trim().toLowerCase()));
    await putMany('cards', fresh.map((p) => makeCard({ ...p, tag: s.id === 'smalltalk' ? 'small-talk' : 'travel', source: 'trip', reverse })));
    toast(`Додано фраз: ${fresh.length}`);
    const target = `#/trip?s=${s.id}`; // після перемальовування ця ситуація лишиться розгорнутою
    if (location.hash === target) render(root);
    else location.hash = target;
  }));
}
