// Інтервальне повторення на основі FSRS-4.5 (Free Spaced Repetition Scheduler).
// Модель пам'яті: stability (S, днів до падіння пригадування до 90%) і difficulty (D, 1..10).
// Оцінки: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy.

const W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031,
  1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
];
const DECAY = -0.5;
const FACTOR = 19 / 81;
const DAY = 86_400_000;
const MIN = 60_000;
const MAX_INTERVAL_DAYS = 365;

// Короткі кроки для нових карток і після помилки (у межах однієї сесії).
const STEP_AGAIN = 1 * MIN;
const STEP_HARD = 6 * MIN;
const STEP_GOOD_NEW = 10 * MIN;
const STEP_RELEARN = 10 * MIN;

export const GRADES = [
  { g: 1, key: '1', label: 'Не згадав' },
  { g: 2, key: '2', label: 'Важко' },
  { g: 3, key: '3', label: 'Добре' },
  { g: 4, key: '4', label: 'Легко' },
];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function retrievability(elapsedDays, stability) {
  return Math.pow(1 + FACTOR * elapsedDays / stability, DECAY);
}

function intervalDays(stability, retention) {
  const ivl = (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return clamp(Math.round(ivl), 1, MAX_INTERVAL_DAYS);
}

const initDifficulty = (g) => clamp(W[4] - W[5] * (g - 3), 1, 10);
const initStability = (g) => Math.max(W[g - 1], 0.1);

function nextDifficulty(d, g) {
  const next = d - W[6] * (g - 3);
  return clamp(W[7] * initDifficulty(4) + (1 - W[7]) * next, 1, 10);
}

function recallStability(d, s, r, g) {
  const hardPenalty = g === 2 ? W[15] : 1;
  const easyBonus = g === 4 ? W[16] : 1;
  return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hardPenalty * easyBonus);
}

function forgetStability(d, s, r) {
  const next = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]);
  return Math.min(next, s);
}

export function newSchedule(now = Date.now()) {
  return { state: 'new', due: now, stability: 0, difficulty: 0, reps: 0, lapses: 0, lastReview: null };
}

// Повертає новий стан розкладу після оцінки g. Чиста функція, нічого не зберігає.
export function review(sched, g, now = Date.now(), retention = 0.9) {
  const s = { ...sched, reps: sched.reps + 1 };

  if (sched.state === 'new') {
    s.stability = initStability(g);
    s.difficulty = initDifficulty(g);
    if (g === 1) return { ...s, state: 'learning', due: now + STEP_AGAIN, lastReview: now };
    if (g === 2) return { ...s, state: 'learning', due: now + STEP_HARD, lastReview: now };
    // Нову фразу показуємо ще раз у цій же сесії; «Легко» одразу випускає в довгі інтервали.
    if (g === 3) return { ...s, state: 'learning', due: now + STEP_GOOD_NEW, lastReview: now };
    return { ...s, state: 'review', due: now + intervalDays(s.stability, retention) * DAY, lastReview: now };
  }

  const elapsed = sched.lastReview ? Math.max(0, (now - sched.lastReview) / DAY) : 0;
  s.difficulty = nextDifficulty(sched.difficulty, g);

  // Короткострокові повтори в межах дня: стабільність майже не змінюємо.
  if (sched.state === 'learning' || sched.state === 'relearning') {
    if (g === 1) return { ...s, due: now + STEP_AGAIN, lastReview: now };
    if (g === 2) return { ...s, due: now + STEP_HARD, lastReview: now };
    if (g === 4) s.stability = sched.stability * 1.5;
    return { ...s, state: 'review', due: now + intervalDays(s.stability, retention) * DAY, lastReview: now };
  }

  const r = retrievability(elapsed, sched.stability);
  if (g === 1) {
    s.stability = forgetStability(sched.difficulty, sched.stability, r);
    s.lapses = sched.lapses + 1;
    return { ...s, state: 'relearning', due: now + STEP_RELEARN, lastReview: now };
  }
  s.stability = recallStability(sched.difficulty, sched.stability, r, g);
  return { ...s, state: 'review', due: now + intervalDays(s.stability, retention) * DAY, lastReview: now };
}

export function formatInterval(ms) {
  if (ms < 60 * MIN) return `${Math.max(1, Math.round(ms / MIN))} хв`;
  if (ms < DAY) return `${Math.round(ms / (60 * MIN))} год`;
  const d = Math.round(ms / DAY);
  if (d < 30) return `${d} д`;
  if (d < 365) return `${Math.round(d / 30)} міс`;
  return `${(d / 365).toFixed(1)} р`;
}

// Фраза вважається «вивченою», коли інтервал за основним напрямком ≥ 21 дня.
export const isMature = (sched) => sched && sched.state === 'review' && sched.stability >= 21;
