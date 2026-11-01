// Облік часу по чотирьох потоках Нейшна, серія днів і черга повторень.
import { getAll, put, uid, getSetting } from './db.js';
import { newSchedule } from './srs.js';

export const STREAMS = [
  { id: 'input', label: 'Input (розуміння)', short: 'Input', color: 'var(--input)' },
  { id: 'output', label: 'Output (говоріння)', short: 'Output', color: 'var(--output)' },
  { id: 'focus', label: 'Свідома робота', short: 'Свідома', color: 'var(--focus)' },
  { id: 'fluency', label: 'Fluency (швидкість)', short: 'Fluency', color: 'var(--fluency)' },
];

// Активності для ручного обліку часу поза застосунком (серіали, подкасти, живі розмови…).
export const MANUAL_ACTIVITIES = [
  { id: 'series', stream: 'input', label: 'Серіал / фільм' },
  { id: 'podcast', stream: 'input', label: 'Подкаст / YouTube' },
  { id: 'reading', stream: 'input', label: 'Читання' },
  { id: 'speaking', stream: 'output', label: 'Розмова з людиною' },
  { id: 'writing', stream: 'output', label: 'Письмо' },
  { id: 'grammar', stream: 'focus', label: 'Граматика / підручник' },
  { id: 'shadowing', stream: 'fluency', label: 'Shadowing / швидке читання' },
];
export const activityLabel = (id) => MANUAL_ACTIVITIES.find((a) => a.id === id)?.label
  ?? { srs: 'Картки', conversation: 'Розмова з ШІ', dictation: 'Диктант', fluency: 'Fluency 4/3/2', grammar: 'Граматичний урок', retell: 'Слухай і перекажи' }[id] ?? id;

// Мета брифу: 200–300 годин активної практики для B2 → C1.
export const GOAL_HOURS = 250;

export const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function logMinutes(stream, minutes, activity, manual = false) {
  const rounded = Math.round(minutes * 10) / 10;
  if (rounded <= 0) return;
  await put('sessions', { id: uid(), date: dayKey(), ts: Date.now(), stream, minutes: rounded, activity, manual });
}

const emptyStreams = () => Object.fromEntries(STREAMS.map((s) => [s.id, 0]));

// Хвилини по потоках за кожен із останніх `days` днів (від найстаршого до сьогодні).
export function dailyMinutes(sessions, days = 14) {
  const out = [];
  const t = new Date();
  t.setHours(12, 0, 0, 0);
  t.setDate(t.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    out.push({ date: dayKey(t), weekday: t.getDay(), ...emptyStreams() });
    t.setDate(t.getDate() + 1);
  }
  const byDate = new Map(out.map((d) => [d.date, d]));
  for (const s of sessions) {
    const d = byDate.get(s.date);
    if (d && s.stream in d) d[s.stream] += s.minutes;
  }
  return out;
}

export function sumStreams(rows) {
  const total = emptyStreams();
  for (const r of rows) for (const s of STREAMS) total[s.id] += r[s.id];
  return total;
}

export function longestStreak(sessions) {
  const days = [...new Set(sessions.map((s) => s.date))].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of days) {
    const cur = new Date(`${d}T12:00:00`);
    run = prev && Math.round((cur - prev) / 86_400_000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = cur;
  }
  return best;
}

// Скільки повторень припадає на кожен із наступних днів (день 0 включає прострочені).
export function dueForecast(cards, days = 7, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const counts = new Array(days).fill(0);
  for (const card of cards) {
    if (card.suspended) continue;
    for (const dir of directions(card)) {
      const s = card.srs[dir];
      if (s.state === 'new') continue;
      const day = Math.max(0, Math.floor((s.due - start) / 86_400_000));
      if (day < days) counts[day]++;
    }
  }
  return counts;
}

export async function weekMinutes() {
  const since = Date.now() - 7 * 86_400_000;
  const totals = Object.fromEntries(STREAMS.map((s) => [s.id, 0]));
  for (const s of await getAll('sessions')) if (s.ts >= since) totals[s.stream] = (totals[s.stream] || 0) + s.minutes;
  return totals;
}

export async function todayMinutes() {
  const today = dayKey();
  return (await getAll('sessions')).filter((s) => s.date === today).reduce((sum, s) => sum + s.minutes, 0);
}

// Серія: поспіль дні з будь-якою практикою; сьогодні ще може бути порожнім.
export async function streak() {
  const days = new Set((await getAll('sessions')).map((s) => s.date));
  let n = 0;
  const t = new Date();
  if (!days.has(dayKey(t))) t.setDate(t.getDate() - 1);
  while (days.has(dayKey(t))) { n++; t.setDate(t.getDate() - 1); }
  return n;
}

// Черга на зараз: прострочені повтори + нові в межах денного ліміту.
export async function buildQueue(now = Date.now()) {
  const cards = await getAll('cards');
  const newLimit = await getSetting('newPerDay', 15);
  const today = dayKey(now);
  const newDoneToday = await getSetting(`newDone:${today}`, 0);

  const due = [];
  const fresh = [];
  for (const card of cards) {
    if (card.suspended) continue;
    for (const dir of directions(card)) {
      const s = card.srs[dir];
      if (s.state === 'new') fresh.push({ card, dir });
      else if (s.due <= now) due.push({ card, dir });
    }
  }
  due.sort((a, b) => a.card.srs[a.dir].due - b.card.srs[b.dir].due);
  // Спочатку основний напрямок (укр → англ), потім зворотний; старіші картки першими.
  fresh.sort((a, b) => (a.dir === b.dir ? a.card.created - b.card.created : a.dir === 'ua_en' ? -1 : 1));
  const newSlots = Math.max(0, newLimit - newDoneToday);
  return { due, fresh: fresh.slice(0, newSlots), newSlots, totalNew: fresh.length };
}

// Найближча картка в навчанні (на випадок, коли черга порожня, а кроки по хвилинах ще не минули).
export async function nextLearningAhead(now = Date.now(), windowMs = 20 * 60_000) {
  let best = null;
  for (const card of await getAll('cards')) {
    if (card.suspended) continue;
    for (const dir of directions(card)) {
      const s = card.srs[dir];
      if ((s.state === 'learning' || s.state === 'relearning') && s.due > now && s.due - now <= windowMs) {
        if (!best || s.due < best.card.srs[best.dir].due) best = { card, dir };
      }
    }
  }
  return best;
}

export const directions = (card) => (card.reverse ? ['ua_en', 'en_ua'] : ['ua_en']);

export function makeCard({ en, ua, context = '', tag = 'vocab', source = 'manual', reverse = true, ...extra }) {
  const now = Date.now();
  return {
    ...extra, // звідки фраза, напр. bookId, bookTitle, page
    id: uid(),
    en: en.trim(),
    ua: ua.trim(),
    context: context.trim(),
    tag,
    source,
    reverse,
    created: now,
    srs: { ua_en: newSchedule(now), en_ua: newSchedule(now) },
  };
}
