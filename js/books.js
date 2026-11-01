// Книжки: що читаю зараз, сторінки за день (ідуть в облік часу як Input) і слова з книжок у картках.
import { getAll, get, put, del, uid } from './db.js';
import { dayKey } from './stats.js';

// Якщо час не вказано, рахуємо орієнтовно: сторінка художньої книжки англійською ≈ 2 хв для B2.
export const MIN_PER_PAGE = 2;
export const STATUS = { reading: 'Читаю', paused: 'Відкладено', done: 'Прочитано' };

export async function addBook({ title, author = '', totalPages = 0, page = 0 }) {
  const book = {
    id: uid(), title: title.trim(), author: author.trim(), totalPages: Number(totalPages) || 0,
    page: Number(page) || 0, status: 'reading', created: Date.now(), finishedAt: null,
  };
  await put('books', book);
  return book;
}

/**
 * Записує прочитане: сесію читання в облік часу (з кількістю сторінок) і нову поточну сторінку книжки.
 * Повертає оновлену книжку.
 */
export async function logReading(book, pages, minutes) {
  const now = Date.now();
  const to = book.totalPages ? Math.min(book.totalPages, book.page + pages) : book.page + pages;
  const read = Math.max(1, to - book.page); // дочитали до кінця — рахуємо лише сторінки, що лишались
  await put('sessions', {
    id: uid(), date: dayKey(now), ts: now, stream: 'input', activity: 'reading', manual: true,
    minutes: Math.round(Math.min(600, minutes || read * MIN_PER_PAGE) * 10) / 10, pages: read, bookId: book.id, fromPage: book.page, toPage: to,
  });
  const updated = { ...book, page: to, status: book.status === 'paused' ? 'reading' : book.status };
  if (book.totalPages && to >= book.totalPages && book.status !== 'done') {
    updated.status = 'done';
    updated.finishedAt = now;
  }
  await put('books', updated);
  return updated;
}

// Скасовує запис читання: прибирає сесію й повертає сторінку назад, якщо після нього нічого не читали.
export async function undoReading(session) {
  await del('sessions', session.id);
  const book = await get('books', session.bookId);
  if (book && book.page === session.toPage) {
    await put('books', { ...book, page: session.fromPage ?? Math.max(0, book.page - session.pages), status: book.status === 'done' ? 'reading' : book.status, finishedAt: null });
  }
}

export const readingSessions = (sessions) => sessions.filter((s) => s.activity === 'reading' && s.pages > 0);

// Сторінки за кожен із останніх `days` днів (від найстаршого до сьогодні).
export function dailyPages(sessions, days = 14) {
  const t = new Date();
  t.setHours(12, 0, 0, 0);
  t.setDate(t.getDate() - (days - 1));
  const out = [];
  for (let i = 0; i < days; i++) {
    out.push({ date: dayKey(t), weekday: t.getDay(), pages: 0 });
    t.setDate(t.getDate() + 1);
  }
  const byDate = new Map(out.map((d) => [d.date, d]));
  for (const s of readingSessions(sessions)) {
    const d = byDate.get(s.date);
    if (d) d.pages += s.pages;
  }
  return out;
}

export const bookPct = (b) => (b.totalPages ? Math.min(100, Math.round((b.page / b.totalPages) * 100)) : 0);

export async function bookCards(bookId) {
  return (await getAll('cards')).filter((c) => c.bookId === bookId).sort((a, b) => b.created - a.created);
}
