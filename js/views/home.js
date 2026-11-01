import { getAll, getSetting, setSetting, del } from '../db.js';
import { isMature } from '../srs.js';
import {
  STREAMS, MANUAL_ACTIVITIES, activityLabel, buildQueue, streak, dayKey, logMinutes,
  dailyMinutes, sumStreams,
} from '../stats.js';
import { recommendedTopic } from './grammar.js';
import { statTile } from '../icons.js';
import { esc, $, $$, toast, tagLabel, plural, ERRORS_WORD } from '../ui.js';

// Денні плани з брифу; хвилини орієнтовні. [назва, хвилини, потік, дія]
const PLANS = {
  20: [['SRS-картки', 7, 'focus', 'review'], ['Диктант', 6, 'input', 'dictation'], ['Говоріння з ШІ', 7, 'output', 'talk']],
  40: [['SRS-картки', 10, 'focus', 'review'], ['Диктант (інтенсивне слухання)', 10, 'input', 'dictation'], ['Говоріння з ШІ', 12, 'output', 'talk'], ['Серіал / подкаст', 8, 'input', 'log']],
  60: [['SRS-картки', 10, 'focus', 'review'], ['Диктант (інтенсивне слухання)', 15, 'input', 'dictation'], ['Серіал / подкаст', 15, 'input', 'log'], ['Говоріння з ШІ', 15, 'output', 'talk'], ['Fluency 4/3/2 (коротко)', 5, 'fluency', 'fluency']],
};

const ACTIONS = {
  review: '<a class="btn icon-btn" href="#/review">Почати</a>',
  talk: '<a class="btn icon-btn" href="#/talk">Почати</a>',
  dictation: '<a class="btn icon-btn" href="#/dictation">Почати</a>',
  fluency: '<a class="btn icon-btn" href="#/fluency">Почати</a>',
  log: '<button class="icon-btn" data-goto-log>Записати</button>',
};

const MODULES = [
  { href: '#/review', title: 'SRS-картки', desc: 'Активне пригадування фраз укр → англ', ready: true },
  { href: '#/talk', title: 'Розмова з ШІ', desc: 'Рольові діалоги, підказки для самовиправлення, розбір', ready: true },
  { href: '#/journal', title: 'Журнал помилок', desc: 'Помилки за категоріями → автокартки', ready: true },
  { href: '#/progress', title: 'Прогрес', desc: 'Чотири потоки, години до мети, прогноз повторень', ready: true },
  { href: '#/dictation', title: 'Диктант', desc: 'Інтенсивне слухання з підсвіткою розбіжностей', ready: true },
  { href: '#/fluency', title: 'Fluency 4/3/2', desc: 'Та сама історія за 4, 3 і 2 хвилини, із записом голосу', ready: true },
  { href: '#/grammar', title: 'Граматичні міні-уроки', desc: 'Під найчастіші помилки з журналу', ready: true },
  { href: '#/trip', title: '🧳 Подорож до США', desc: '11 ситуацій: розмова, розмовник, поради, диктант, готовність', ready: true },
];

function stageHint(daysLeft, now = new Date()) {
  if (daysLeft <= 0) return 'Час поїздки! Have a great trip 🇺🇸';
  if (daysLeft <= 30) return 'Поїздка вже скоро. Повторюй туристичні сценарії й підтримуй форму короткими сесіями.';
  const m = now.getMonth() + 1;
  if (m >= 4 && m <= 6) return 'Етап 2 (квітень–червень): дискусії, аргументація, ідіоми, гумор.';
  if (m >= 7 && m <= 8) return 'Етап 3 (липень–серпень): туристичні сценарії — кордон, готель, ресторан, авто, small talk.';
  return 'Етап 1 (до березня): обсяг слухання, регулярне говоріння, звикання до темпу.';
}

// Розподіляє сьогоднішні хвилини потоку між пунктами плану з тим самим потоком, по черзі.
function planProgress(plan, todayByStream) {
  const left = { ...todayByStream };
  return plan.map(([title, target, stream, action]) => {
    const done = Math.min(target, left[stream] || 0);
    left[stream] = (left[stream] || 0) - done;
    return { title, target, stream, action, done };
  });
}

export async function render(root) {
  const [q, days, sessions, cards, tripDate, planLen, rec, lessons] = await Promise.all([
    buildQueue(), streak(), getAll('sessions'), getAll('cards'),
    getSetting('tripDate', '2027-09-01'), getSetting('dailyPlan', 60), recommendedTopic(), getAll('lessons'),
  ]);
  // Граматика 2–3 рази на тиждень: пропонуємо урок, якщо є повторювані помилки й уроку не було 3 дні.
  const lastLesson = Math.max(0, ...lessons.map((l) => l.created));
  const suggestGrammar = rec.errors >= 2 && Date.now() - lastLesson > 3 * 86_400_000;
  const today = dayKey();
  const todaySessions = sessions.filter((s) => s.date === today).sort((a, b) => b.ts - a.ts);
  const todayByStream = sumStreams(dailyMinutes(todaySessions, 1));
  const todayTotal = Object.values(todayByStream).reduce((a, b) => a + b, 0);
  const week = sumStreams(dailyMinutes(sessions, 7));
  const weekTotal = Object.values(week).reduce((a, b) => a + b, 0);
  const daysLeft = Math.max(0, Math.ceil((new Date(tripDate) - new Date()) / 86_400_000));
  // Етап 3 брифу (липень–серпень) або останні 60 днів — туристичний режим виходить на головну.
  const month = new Date().getMonth() + 1;
  const tripSoon = daysLeft > 0 && ((month >= 7 && month <= 8) || daysLeft <= 60);
  const toReview = q.due.length + q.fresh.length;
  const mature = cards.filter((c) => isMature(c.srs.ua_en)).length;
  const items = planProgress(PLANS[planLen], todayByStream);
  const planDone = items.reduce((a, i) => a + i.done, 0);

  root.innerHTML = `
    <h1>Сьогодні</h1>
    <p class="muted">${esc(stageHint(daysLeft))}</p>

    <div class="grid grid-3" style="margin-bottom:16px">
      ${statTile('plane', daysLeft, 'днів до поїздки до США')}
      ${statTile('flame', days, 'днів поспіль')}
      ${statTile('cards', toReview, `карток до повторення · ${q.due.length} повтор, ${q.fresh.length} нових`)}
      ${statTile('check', `${mature}<span class="muted" style="font-size:1rem"> / ${cards.length}</span>`, 'фраз вивчено (інтервал ≥ 21 д)')}
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:6px">
        <h2 style="margin:0">План на день</h2>
        <span class="spacer"></span>
        <div class="row" id="plan-switch">
          ${[20, 40, 60].map((n) => `<button class="${n === planLen ? 'primary' : ''} icon-btn" data-plan="${n}">${n} хв</button>`).join('')}
        </div>
      </div>
      <div class="meter" aria-label="Виконано ${Math.round(planDone)} з ${planLen} хв"><div style="width:${Math.min(100, (planDone / planLen) * 100)}%"></div></div>
      <p class="muted small" style="margin:6px 0 10px">Виконано ${Math.round(planDone)} з ${planLen} хв${todayTotal > planDone ? ` · всього сьогодні ${Math.round(todayTotal)} хв` : ''}${planDone >= planLen ? ' · план виконано ✓' : ''}</p>
      <ul class="plan">
        ${items.map((i) => {
          const s = STREAMS.find((x) => x.id === i.stream);
          const complete = i.done >= i.target;
          return `<li class="${complete ? 'complete' : ''}">
            <span class="dot" style="background:${s.color}" title="${esc(s.label)}"></span>
            <span class="plan-title">${complete ? '✓ ' : ''}${esc(i.title)}<span class="muted small"> · ${esc(s.short)}</span></span>
            <span class="muted small plan-min">${Math.round(i.done)}/${i.target} хв</span>
            ${complete ? '' : ACTIONS[i.action]}
          </li>`;
        }).join('')}
      </ul>
    </div>

    ${tripSoon ? `
      <a class="card module recommend" href="#/trip" style="display:block;margin-bottom:16px">
        <strong>🧳 Підготовка до поїздки</strong>
        <div class="muted small">Етап туристичних сценаріїв: кордон, готель, ресторан, авто, телефон. Пройди кожну ситуацію, зокрема «зі складністю» →</div>
      </a>` : ''}

    ${suggestGrammar ? `
      <a class="card module recommend" href="#/grammar?topic=${rec.category}" style="display:block;margin-bottom:16px">
        <strong>📚 Граматика: ${esc(tagLabel(rec.category))}</strong>
        <div class="muted small">${plural(rec.errors, ERRORS_WORD)} за 4 тижні в журналі. Міні-урок на 15 хвилин зі вправами на твоїх помилках →</div>
      </a>` : ''}

    <div class="card" id="log">
      <h2>Записати час поза застосунком</h2>
      <p class="muted small">Серіали, подкасти й живі розмови теж рахуються: так видно реальний баланс чотирьох потоків.</p>
      <form id="log-form" class="row">
        <select id="log-activity" style="width:auto;flex:1;min-width:180px">
          ${STREAMS.map((s) => `<optgroup label="${esc(s.label)}">${MANUAL_ACTIVITIES.filter((a) => a.stream === s.id)
            .map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('')}</optgroup>`).join('')}
        </select>
        <input type="number" id="log-min" min="1" max="600" value="20" style="width:90px" aria-label="Хвилин">
        <span class="muted small">хв</span>
        <button type="submit" class="primary">Записати</button>
      </form>
      <div class="row" style="margin-top:8px">
        ${[10, 15, 20, 30, 45].map((m) => `<button type="button" class="icon-btn chip" data-min="${m}">${m}</button>`).join('')}
      </div>
      ${todaySessions.length ? `
        <h3 class="small muted" style="margin:16px 0 4px">Сьогодні записано</h3>
        <ul class="card-list compact">
          ${todaySessions.map((s) => `<li>
            <span class="dot" style="background:${STREAMS.find((x) => x.id === s.stream)?.color}"></span>
            <span style="flex:1">${esc(activityLabel(s.activity))}</span>
            <span class="muted small">${s.minutes < 1 ? '<1' : Math.round(s.minutes)} хв · ${new Date(s.ts).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</span>
            ${s.manual ? `<button class="ghost icon-btn danger" data-del="${s.id}" aria-label="Видалити запис">✕</button>` : ''}
          </li>`).join('')}
        </ul>` : ''}
    </div>

    <div class="card">
      <div class="row"><h2 style="margin:0">Чотири потоки за 7 днів</h2><span class="spacer"></span><a href="#/progress" class="small">Детальніше →</a></div>
      <p class="muted small" style="margin:2px 0 10px">мета ≈ 25% кожен · всього ${Math.round(weekTotal)} хв</p>
      <div class="streams">
        ${STREAMS.map((s) => {
          const pct = weekTotal ? Math.round((week[s.id] / weekTotal) * 100) : 0;
          return `<div class="stream-row"><span>${esc(s.label)}</span>
            <div class="bar"><div style="width:${pct}%;background:${s.color}"></div></div>
            <span class="muted small">${pct}%</span></div>`;
        }).join('')}
      </div>
    </div>

    <h2>Модулі</h2>
    <div class="modules">
      ${MODULES.map((m) => m.ready
        ? `<a class="module" href="${m.href}"><strong>${esc(m.title)}</strong><div class="muted small">${esc(m.desc)}</div></a>`
        : `<div class="module disabled"><span class="tag soon">крок ${m.step}</span><strong>${esc(m.title)}</strong><div class="muted small">${esc(m.desc)}</div></div>`).join('')}
    </div>`;

  $$('[data-plan]', $('#plan-switch')).forEach((b) => b.addEventListener('click', async () => {
    await setSetting('dailyPlan', Number(b.dataset.plan));
    render(root);
  }));
  $$('[data-goto-log]').forEach((b) => b.addEventListener('click', () => {
    $('#log').scrollIntoView({ behavior: 'smooth' });
    $('#log-min').focus();
  }));
  $$('[data-min]').forEach((b) => b.addEventListener('click', () => { $('#log-min').value = b.dataset.min; }));
  $('#log-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const activity = MANUAL_ACTIVITIES.find((a) => a.id === $('#log-activity').value);
    const minutes = Number($('#log-min').value);
    if (!(minutes > 0 && minutes <= 600)) { toast('Вкажи від 1 до 600 хвилин'); return; }
    await logMinutes(activity.stream, minutes, activity.id, true);
    toast(`Записано: ${activity.label}, ${minutes} хв`);
    render(root);
  });
  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    await del('sessions', b.dataset.del);
    render(root);
  }));
}
