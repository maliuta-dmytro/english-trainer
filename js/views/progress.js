import { getAll, getSetting } from '../db.js';
import { isMature } from '../srs.js';
import {
  STREAMS, GOAL_HOURS, dailyMinutes, sumStreams, streak, longestStreak, dueForecast, directions,
} from '../stats.js';
import { stackedColumns, columns, legend } from '../charts.js';
import { statTile } from '../icons.js';
import { weeklyRates, wordSources, fmt, trend } from './journal.js';
import { esc, $, tagLabel } from '../ui.js';

const WEEKDAYS = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const ADVICE = {
  input: 'Додай слухання: <a href="#/dictation">диктант</a> або серіал чи подкаст із субтитрами, хоча б 15 хв.',
  output: 'Сьогодні варто <a href="#/talk">поговорити з ШІ</a>: навіть 10 хвилин розмови дають багато.',
  focus: '<a href="#/review">Повтори картки</a>: це найкоротший шлях закріпити фрази з розмов.',
  fluency: 'Спробуй <a href="#/fluency">4/3/2</a>: та сама знайома історія тричі, щоразу швидше.',
};

const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} год ${Math.round(m % 60)} хв` : `${Math.round(m)} хв`);

export async function render(root) {
  const [sessions, cards, errors, convs, tripDate, days] = await Promise.all([
    getAll('sessions'), getAll('cards'), getAll('errors'), getAll('conversations'),
    getSetting('tripDate', '2027-09-01'), streak(),
  ]);

  const allMin = sessions.reduce((a, s) => a + s.minutes, 0);
  const hours = allMin / 60;
  const last14 = dailyMinutes(sessions, 14);
  const prev7 = sumStreams(last14.slice(0, 7));
  const week = sumStreams(last14.slice(7));
  const weekTotal = total(week);
  const prevTotal = total(prev7);
  const pace = total(sumStreams(last14)) / 14; // хв на день
  const daysLeft = Math.max(0, Math.ceil((new Date(tripDate) - new Date()) / 86_400_000));
  const projected = hours + (pace * daysLeft) / 60;
  const neededPerDay = daysLeft ? Math.max(0, ((GOAL_HOURS - hours) * 60) / daysLeft) : 0;

  const mainSched = cards.map((c) => c.srs.ua_en);
  const mature = mainSched.filter(isMature).length;
  const fresh = mainSched.filter((s) => s.state === 'new').length;
  const active = cards.length - mature - fresh;
  const forecast = dueForecast(cards);
  const reviewsTotal = cards.reduce((n, c) => n + directions(c).length, 0);

  const errStats = weeklyRates(errors, await wordSources());
  const weekShares = STREAMS.map((s) => ({ ...s, min: week[s.id], pct: weekTotal ? (week[s.id] / weekTotal) * 100 : 0 }));
  const weakest = [...weekShares].sort((a, b) => a.pct - b.pct)[0];
  const delta = weekTotal - prevTotal;

  root.innerHTML = `
    <h1>Прогрес</h1>

    <div class="card hero-card">
      <div class="muted small">Активна практика за весь час</div>
      <div class="hero">${hours < 10 ? hours.toFixed(1) : Math.round(hours)}<span class="hero-unit"> год</span></div>
      <div class="meter" aria-label="${Math.round(hours)} з ${GOAL_HOURS} годин"><div style="width:${Math.min(100, (hours / GOAL_HOURS) * 100)}%"></div></div>
      <p class="small" style="margin:8px 0 0">Мета ≈ ${GOAL_HOURS} год активної практики для переходу B2 → C1 (за брифом 200–300 год).
        ${pace > 0
          ? (projected >= GOAL_HOURS
            ? `За поточного темпу (${Math.round(pace)} хв/день за 2 тижні) до поїздки набереться ≈ <strong>${Math.round(projected)} год</strong>, тож мету досягнеш ✓`
            : `За поточного темпу (${Math.round(pace)} хв/день) до поїздки набереться ≈ <strong>${Math.round(projected)} год</strong>. Щоб вийти на ${GOAL_HOURS}, потрібно ≈ <strong>${Math.ceil(neededPerDay)} хв/день</strong>.`)
          : `Щоб набрати ${GOAL_HOURS} год за ${daysLeft} днів, потрібно ≈ <strong>${Math.ceil(neededPerDay)} хв/день</strong>.`}</p>
    </div>

    <div class="grid grid-3" style="margin-bottom:16px">
      ${statTile('clock', fmtMin(weekTotal), `за 7 днів${prevTotal || weekTotal ? ` · <span class="${delta >= 0 ? 'delta-up' : 'delta-down'}">${delta >= 0 ? '▲' : '▼'} ${fmtMin(Math.abs(delta))}</span> до попередніх 7` : ''}`)}
      ${statTile('flame', days, `днів поспіль · рекорд ${longestStreak(sessions)}`)}
      ${statTile('layers', `${mature}<span class="muted" style="font-size:1rem"> / ${active} / ${fresh}</span>`, 'фраз: вивчено / вчаться / нові')}
      ${statTile('alert', fmt(errStats.total[0]), `<a href="#/journal">помилок на 100 слів</a> за 7 днів ${trend(errStats.total)}`)}
    </div>

    <div class="card">
      <h2>Хвилини за 14 днів</h2>
      ${legend(STREAMS)}
      <div id="ch-days"></div>
      <details class="small"><summary>Таблиця</summary>
        <div class="table-wrap"><table class="rates">
          <thead><tr><th>День</th>${STREAMS.map((s) => `<th>${esc(s.short)}</th>`).join('')}<th>Разом</th></tr></thead>
          <tbody>${[...last14].reverse().map((d) => `<tr><td>${d.date}</td>${STREAMS.map((s) => `<td>${Math.round(d[s.id])}</td>`).join('')}<td>${Math.round(total(Object.fromEntries(STREAMS.map((s) => [s.id, d[s.id]]))))}</td></tr>`).join('')}</tbody>
        </table></div>
      </details>
    </div>

    <div class="card">
      <h2>Баланс потоків за 7 днів <span class="muted small">· мета ≈ 25% кожен</span></h2>
      <div class="balance">
        ${weekShares.map((s) => `
          <div class="balance-row">
            <span class="row" style="gap:6px"><span class="dot" style="background:${s.color}"></span>${esc(s.label)}</span>
            <div class="balance-track"><div style="width:${s.pct}%;background:${s.color}"></div><i class="target" style="left:25%" title="мета 25%"></i></div>
            <span class="small">${Math.round(s.pct)}% <span class="muted">· ${fmtMin(s.min)}</span></span>
          </div>`).join('')}
      </div>
      <p class="small" style="margin:12px 0 0">${weekTotal < 30
        ? '<span class="muted">Замало даних за тиждень для висновків: позаймайся кілька днів, і тут з\'явиться порада.</span>'
        : weakest.pct < 15
          ? `💡 Найменше уваги отримує «${esc(weakest.label)}» (${Math.round(weakest.pct)}%). ${ADVICE[weakest.id]}`
          : '✓ Потоки збалансовані. Так тримати!'}</p>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h2>Повторення на 7 днів</h2>
        <p class="muted small" style="margin-top:-4px">Без нових карток · усього в розкладі ${reviewsTotal}</p>
        <div id="ch-forecast"></div>
      </div>
      <div class="card">
        <h2>Найчастіші помилки <span class="muted small">· 4 тижні</span></h2>
        ${errStats.cats.length
          ? `<ul class="card-list compact">${errStats.cats.slice(0, 5).map((c) => `
              <li><span style="flex:1">${esc(tagLabel(c.cat))}</span>
                <span class="muted small">${c.sum} · ${fmt(c.rates[0])}/100 сл.</span> ${trend(c.rates)}</li>`).join('')}</ul>
             <p class="small" style="margin:8px 0 0"><a href="#/journal">Відкрити журнал →</a> · <a href="#/grammar">Граматичні уроки →</a></p>`
          : '<p class="muted small">Ще немає розібраних розмов. <a href="#/talk">Почати розмову →</a></p>'}
      </div>
    </div>`;

  const todayKey = last14.at(-1).date;
  stackedColumns($('#ch-days'), {
    rows: last14.map((d) => ({ ...d, label: d.date === todayKey ? 'сьог' : String(Number(d.date.slice(8))), highlight: d.date === todayKey })),
    series: STREAMS,
    ariaLabel: 'Хвилини практики за останні 14 днів по чотирьох потоках',
    tip: (d) => {
      const sum = STREAMS.reduce((a, s) => a + d[s.id], 0);
      return `<strong>${WEEKDAYS[d.weekday]}, ${new Date(`${d.date}T12:00`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' })}</strong> · ${Math.round(sum)} хв
        ${STREAMS.filter((s) => d[s.id] > 0).map((s) => `<div class="tip-row"><i style="background:${s.color}"></i>${esc(s.short)}<b>${Math.round(d[s.id])}</b></div>`).join('')}`;
    },
  });

  const labels = forecast.map((_, i) => {
    if (i === 0) return 'сьог';
    const d = new Date();
    d.setDate(d.getDate() + i);
    return WEEKDAYS[d.getDay()];
  });
  columns($('#ch-forecast'), {
    values: forecast,
    labels,
    color: 'var(--accent)',
    ariaLabel: 'Кількість повторень карток на наступні 7 днів',
    tip: (i) => `<strong>${labels[i] === 'сьог' ? 'Сьогодні (разом із простроченими)' : labels[i]}</strong> · ${forecast[i]} повторень`,
  });
}
