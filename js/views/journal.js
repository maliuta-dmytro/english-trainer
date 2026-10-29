import { getAll, put } from '../db.js';
import { makeCard } from '../stats.js';
import { GRAMMAR_TOPICS } from '../grammar.js';
import { esc, $, $$, toast, tagLabel, ERROR_CATEGORIES } from '../ui.js';

const WEEK = 7 * 86_400_000;
const WEEKS = 4;

// Частота помилок на 100 слів — чесніша метрика, ніж кількість: більше практики дає більше помилок.
export function weeklyRates(errors, convs, now = Date.now()) {
  const words = new Array(WEEKS).fill(0);
  for (const c of convs) {
    const w = Math.floor((now - c.created) / WEEK);
    if (w < WEEKS && c.userWords) words[w] += c.userWords;
  }
  const byCat = {};
  for (const e of errors) {
    const w = Math.floor((now - e.ts) / WEEK);
    if (w >= WEEKS) continue;
    (byCat[e.category] ??= new Array(WEEKS).fill(0))[w]++;
  }
  const rate = (n, w) => (words[w] ? (n / words[w]) * 100 : null);
  const total = new Array(WEEKS).fill(0);
  for (const counts of Object.values(byCat)) counts.forEach((n, w) => { total[w] += n; });
  return {
    words,
    total: total.map(rate),
    cats: Object.entries(byCat)
      .map(([cat, counts]) => ({ cat, counts, rates: counts.map(rate), sum: counts.reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.sum - a.sum),
  };
}

export const fmt = (r) => (r === null ? '—' : r.toFixed(1));

export function trend(rates) {
  const [now, prev] = rates;
  if (now === null || prev === null) return '';
  if (now < prev * 0.85) return '<span class="trend down" title="менше помилок, ніж тиждень тому">▼</span>';
  if (now > prev * 1.15) return '<span class="trend up" title="більше помилок, ніж тиждень тому">▲</span>';
  return '<span class="trend flat" title="без суттєвих змін">●</span>';
}

export async function render(root) {
  let filter = '';
  const [errors, convs] = await Promise.all([getAll('errors'), getAll('conversations')]);
  errors.sort((a, b) => b.ts - a.ts);
  const analyzed = convs.filter((c) => c.analysis);
  const stats = weeklyRates(errors, analyzed);

  if (!errors.length) {
    root.innerHTML = `
      <h1>Журнал помилок</h1>
      <div class="card empty">
        <p>${analyzed.length ? 'У розібраних розмовах помилок не знайдено. Так тримати!' : 'Журнал поки що порожній.'}</p>
        <p class="muted small">Після кожної розмови з ШІ помилки потрапляють сюди з категорією. Так видно, яка тема «болить» найбільше і як змінюється частота помилок.</p>
        <a class="btn primary" href="#/talk">Почати розмову</a>
      </div>`;
    return;
  }

  const top = stats.cats[0];
  root.innerHTML = `
    <h1>Журнал помилок</h1>
    <div class="grid grid-3" style="margin-bottom:16px">
      <div class="stat"><div class="num">${errors.length}</div><div class="label">помилок у журналі · розмов: ${analyzed.length}</div></div>
      <div class="stat"><div class="num">${fmt(stats.total[0])} ${trend(stats.total)}</div><div class="label">помилок на 100 слів за 7 днів (тиждень тому: ${fmt(stats.total[1])})</div></div>
      <div class="stat"><div class="num" style="font-size:1.2rem;padding:6px 0">${top ? esc(tagLabel(top.cat)) : '—'}</div><div class="label">найчастіша тема за 4 тижні</div></div>
    </div>

    <div class="card">
      <h2>Теми <span class="muted small">· помилок на 100 слів, від поточного тижня до 3 тижнів тому</span></h2>
      <div class="table-wrap">
        <table class="rates">
          <thead><tr><th>Тема</th><th>Цей тиждень</th><th>−1</th><th>−2</th><th>−3</th><th></th><th></th></tr></thead>
          <tbody>
            ${stats.cats.map((c) => `<tr>
              <td><button class="linklike" data-filter="${c.cat}">${esc(tagLabel(c.cat))}</button> <span class="muted small">(${c.sum})</span></td>
              ${c.rates.map((r) => `<td>${fmt(r)}</td>`).join('')}
              <td>${trend(c.rates)}</td>
              <td>${GRAMMAR_TOPICS.includes(c.cat) ? `<a href="#/grammar?topic=${c.cat}" class="small">урок →</a>` : ''}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="muted small" style="margin:10px 0 0">Найчастіші теми автоматично стають фокусом наступних розмов. Під граматичні теми є <a href="#/grammar">міні-уроки</a> на 15 хвилин.</p>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <h2 style="margin:0">Помилки</h2>
        <span class="spacer"></span>
        <select id="j-filter" style="width:auto">
          <option value="">Усі теми</option>
          ${ERROR_CATEGORIES.filter((k) => errors.some((e) => e.category === k)).map((k) => `<option value="${k}">${esc(tagLabel(k))}</option>`).join('')}
        </select>
      </div>
      <div id="j-list"></div>
    </div>`;

  async function drawList() {
    const cards = new Map((await getAll('cards')).map((c) => [c.id, c]));
    const known = new Set([...cards.values()].map((c) => c.en.trim().toLowerCase()));
    const shown = errors.filter((e) => !filter || e.category === filter).slice(0, 100);
    $('#j-list').innerHTML = `<ul class="fix-list">${shown.map((e) => `
      <li>
        <div class="was">${esc(e.original)}</div>
        <div class="now">${esc(e.corrected)}</div>
        <div class="small muted row">
          <span>${esc(e.explanation)}</span>
          <span class="tag">${esc(tagLabel(e.category))}</span>
          <span>${new Date(e.ts).toLocaleDateString('uk-UA')}</span>
          <a href="#/talk?id=${e.convId}">розмова</a>
          ${(e.cardId && cards.has(e.cardId)) || known.has(e.corrected.trim().toLowerCase())
            ? '<span class="tag">у картках</span>'
            : `<button class="icon-btn" data-card="${e.id}">+ у картки</button>`}
        </div>
      </li>`).join('')}</ul>`;

    $$('[data-card]', $('#j-list')).forEach((b) => b.addEventListener('click', async () => {
      const e = errors.find((x) => x.id === b.dataset.card);
      const card = makeCard({ en: e.corrected, ua: '', context: `Було: ${e.original}`, tag: e.category, source: 'journal', reverse: false });
      // Перекладу для старих записів може не бути — просимо вписати.
      const ua = prompt('Як це звучить українською? (це буде питанням картки)', '');
      if (!ua) return;
      card.ua = ua.trim();
      await put('cards', card);
      e.cardId = card.id;
      await put('errors', e);
      toast('Картку створено');
      drawList();
    }));
  }

  $('#j-filter').addEventListener('change', (ev) => { filter = ev.target.value; drawList(); });
  $$('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.filter;
    $('#j-filter').value = filter;
    drawList();
    $('#j-list').scrollIntoView({ behavior: 'smooth' });
  }));
  await drawList();
}
