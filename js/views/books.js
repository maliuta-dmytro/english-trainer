import { getAll, get, put, del, getSetting } from '../db.js';
import { makeCard, dayKey } from '../stats.js';
import { hasKey } from '../ai.js';
import { translatePhrase } from '../dictation.js';
import { MIN_PER_PAGE, STATUS, addBook, logReading, undoReading, readingSessions, bookPct, bookCards } from '../books.js';
import { esc, $, $$, toast, plural } from '../ui.js';

const PAGES_WORD = ['сторінка', 'сторінки', 'сторінок'];
const CARDS_WORD = ['картка', 'картки', 'карток'];

export async function render(root) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const book = params.get('id') ? await get('books', params.get('id')) : null;
  return book ? renderBook(root, book) : renderList(root);
}

const pagesLine = (b) => (b.totalPages ? `с. ${b.page} з ${b.totalPages} · ${bookPct(b)}%` : `с. ${b.page}`);

// Форма «прочитав сьогодні»: сторінки й хвилини (хвилини підставляються самі, поки їх не змінили вручну).
const logForm = (b, compact = false) => `
  <form class="row log-pages" data-book="${b.id}">
    <input type="number" name="pages" min="1" max="1000" placeholder="сторінок" style="width:${compact ? 100 : 120}px" aria-label="Скільки сторінок прочитано" required>
    <input type="number" name="minutes" min="1" max="600" placeholder="хв" style="width:80px" aria-label="Скільки хвилин">
    <span class="muted small">хв</span>
    <button type="submit" class="primary">Записати</button>
  </form>`;

function wireLogForms(scope, books, after) {
  $$('.log-pages', scope).forEach((f) => {
    let touched = false;
    f.minutes.addEventListener('input', () => { touched = true; });
    f.pages.addEventListener('input', () => { if (!touched) f.minutes.value = f.pages.value ? Number(f.pages.value) * MIN_PER_PAGE : ''; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pages = Number(f.pages.value);
      const minutes = Number(f.minutes.value) || null;
      if (!(pages > 0)) { toast('Вкажи кількість сторінок'); return; }
      const book = books.find((b) => b.id === f.dataset.book);
      const updated = await logReading(book, pages, minutes);
      const read = Math.max(1, updated.page - book.page);
      toast(updated.status === 'done' && book.status !== 'done'
        ? `Книжку дочитано! 🎉 +${plural(read, PAGES_WORD)}`
        : `Записано: ${plural(read, PAGES_WORD)}, ${Math.round(minutes || read * MIN_PER_PAGE)} хв`);
      after();
    });
  });
}

// ---------- Список книжок ----------

async function renderList(root) {
  const [books, sessions] = await Promise.all([getAll('books'), getAll('sessions')]);
  const cards = await getAll('cards');
  const cardCount = (id) => cards.filter((c) => c.bookId === id).length;
  const today = dayKey();
  const todayPages = readingSessions(sessions).filter((s) => s.date === today).reduce((a, s) => a + s.pages, 0);
  const groups = ['reading', 'paused', 'done'].map((st) => [st, books.filter((b) => b.status === st).sort((a, b) => (b.finishedAt || b.created) - (a.finishedAt || a.created))]);

  root.innerHTML = `
    <div class="row" style="margin-bottom:8px">
      <h1 style="margin:0">Книжки</h1>
      <span class="spacer"></span>
      ${todayPages ? `<span class="tag on">сьогодні ${plural(todayPages, PAGES_WORD)}</span>` : ''}
    </div>
    <p class="muted">Записуй, скільки прочитав, і це піде в прогрес як Input. Незнайомі слова й фрази з книжки додавай у картки: біля кожної буде видно книжку й сторінку.</p>

    ${groups.map(([st, list]) => (list.length ? `
      <div class="card">
        <h2>${STATUS[st]} <span class="muted small">· ${list.length}</span></h2>
        <ul class="card-list book-list">
          ${list.map((b) => `
            <li>
              <div style="flex:1;min-width:0">
                <a href="#/books?id=${b.id}" class="en">${esc(b.title)}</a>${b.author ? ` <span class="muted small">· ${esc(b.author)}</span>` : ''}
                <div class="meta">${pagesLine(b)}${cardCount(b.id) ? ` · ${plural(cardCount(b.id), CARDS_WORD)}` : ''}</div>
                ${b.totalPages ? `<div class="meter" style="margin:6px 0 2px"><div style="width:${bookPct(b)}%"></div></div>` : ''}
                ${st === 'reading' ? logForm(b, true) : ''}
              </div>
            </li>`).join('')}
        </ul>
      </div>` : '')).join('')}

    <div class="card">
      <h2>${books.length ? 'Додати книжку' : 'Яку книжку читаєш зараз?'}</h2>
      <form id="book-form" autocomplete="off">
        <div class="grid grid-2">
          <div class="field"><label for="b-title">Назва</label><input type="text" id="b-title" required placeholder="Project Hail Mary"></div>
          <div class="field"><label for="b-author">Автор (необов'язково)</label><input type="text" id="b-author" placeholder="Andy Weir"></div>
        </div>
        <div class="row">
          <div class="field" style="margin:0"><label for="b-total">Сторінок у книжці</label><input type="number" id="b-total" min="1" max="5000" style="width:140px"></div>
          <div class="field" style="margin:0"><label for="b-page">Я зараз на сторінці</label><input type="number" id="b-page" min="0" max="5000" value="0" style="width:140px"></div>
          <span class="spacer"></span>
          <button type="submit" class="primary" style="margin-top:18px">Додати</button>
        </div>
      </form>
    </div>`;

  wireLogForms(root, books, () => renderList(root));
  $('#book-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const total = Number($('#b-total').value) || 0;
    const page = Number($('#b-page').value) || 0;
    if (total && page > total) { toast('Поточна сторінка більша за кількість сторінок'); return; }
    const b = await addBook({ title: $('#b-title').value, author: $('#b-author').value, totalPages: total, page });
    toast(`Додано «${b.title}»`);
    renderList(root);
  });
}

// ---------- Сторінка книжки ----------

async function renderBook(root, book) {
  const [sessions, cards, aiKey, reverseDefault] = await Promise.all([
    getAll('sessions'), bookCards(book.id), hasKey(), getSetting('reverseDefault', true),
  ]);
  const history = readingSessions(sessions).filter((s) => s.bookId === book.id).sort((a, b) => b.ts - a.ts);
  const totalPages = history.reduce((a, s) => a + s.pages, 0);
  const totalMin = history.reduce((a, s) => a + s.minutes, 0);
  const lastId = history[0]?.id;

  root.innerHTML = `
    <a href="#/books" class="small">← Усі книжки</a>
    <h1 style="margin:4px 0 2px">${esc(book.title)}</h1>
    <p class="muted" style="margin-top:0">${book.author ? `${esc(book.author)} · ` : ''}${STATUS[book.status]}</p>

    <div class="card">
      <div class="row" style="margin-bottom:6px">
        <strong>${pagesLine(book)}</strong>
        <span class="spacer"></span>
        <span class="muted small">записано ${plural(totalPages, PAGES_WORD)} · ${Math.round(totalMin)} хв</span>
      </div>
      ${book.totalPages ? `<div class="meter"><div style="width:${bookPct(book)}%"></div></div>` : ''}
      ${book.status !== 'done' ? `<h3 class="small muted" style="margin:14px 0 6px">Прочитав сьогодні</h3>${logForm(book)}` : ''}
      ${history.length ? `
        <details style="margin-top:12px"><summary class="small">Історія читання (${history.length})</summary>
          <ul class="card-list compact">
            ${history.map((s) => `<li>
              <span style="flex:1">${new Date(s.ts).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' })}</span>
              <span class="muted small">${plural(s.pages, PAGES_WORD)} → с. ${s.toPage} · ${Math.round(s.minutes)} хв</span>
              ${s.id === lastId ? `<button class="ghost icon-btn danger" data-undo="${s.id}" title="Скасувати останній запис" aria-label="Скасувати запис">✕</button>` : ''}
            </li>`).join('')}
          </ul>
        </details>` : ''}
    </div>

    <div class="card">
      <h2>Слово чи фраза з книжки</h2>
      <form id="word-form" autocomplete="off">
        <div class="grid grid-2">
          <div class="field"><label for="w-en">Англійською</label><input type="text" id="w-en" required placeholder="to be at a loss for words"></div>
          <div class="field"><label for="w-ua">Переклад</label>
            <div class="row" style="flex-wrap:nowrap"><input type="text" id="w-ua" required style="flex:1">
              ${aiKey ? '<button type="button" id="w-tr" title="Перекласти за допомогою ШІ з урахуванням речення">✨</button>' : ''}</div></div>
        </div>
        <div class="field"><label for="w-ctx">Речення з книжки (необов'язково, але дуже допомагає запам'ятати)</label><input type="text" id="w-ctx"></div>
        <div class="row">
          <div class="field" style="margin:0"><label for="w-page">Сторінка</label><input type="number" id="w-page" min="0" max="5000" value="${book.page || ''}" style="width:110px"></div>
          <label class="check" style="margin-top:18px"><input type="checkbox" id="w-rev" ${reverseDefault ? 'checked' : ''}> також англ → укр</label>
          <span class="spacer"></span>
          <button type="submit" class="primary" style="margin-top:18px">+ у картки</button>
        </div>
      </form>
      ${cards.length ? `
        <h3 class="small muted" style="margin:18px 0 4px">Додано з цієї книжки · ${cards.length}</h3>
        <ul class="card-list compact">
          ${cards.map((c) => `<li>
            <div style="flex:1;min-width:0"><span class="en">${esc(c.en)}</span> <span class="muted">— ${esc(c.ua)}</span>
              ${c.context ? `<div class="meta"><em>${esc(c.context)}</em></div>` : ''}</div>
            ${c.page ? `<span class="muted small">с. ${c.page}</span>` : ''}
          </li>`).join('')}
        </ul>` : ''}
    </div>

    <details class="card">
      <summary>Редагувати книжку</summary>
      <form id="edit-form" autocomplete="off" style="margin-top:12px">
        <div class="grid grid-2">
          <div class="field"><label for="e-title">Назва</label><input type="text" id="e-title" required value="${esc(book.title)}"></div>
          <div class="field"><label for="e-author">Автор</label><input type="text" id="e-author" value="${esc(book.author)}"></div>
        </div>
        <div class="row">
          <div class="field" style="margin:0"><label for="e-total">Сторінок у книжці</label><input type="number" id="e-total" min="0" max="5000" value="${book.totalPages || ''}" style="width:130px"></div>
          <div class="field" style="margin:0"><label for="e-page">Поточна сторінка</label><input type="number" id="e-page" min="0" max="5000" value="${book.page}" style="width:130px"></div>
          <div class="field" style="margin:0"><label for="e-status">Статус</label>
            <select id="e-status" style="width:auto">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${k === book.status ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
        </div>
        <div class="row" style="margin-top:12px">
          <button type="button" class="ghost danger" id="e-del">Видалити книжку</button>
          <span class="spacer"></span>
          <button type="submit" class="primary">Зберегти</button>
        </div>
      </form>
    </details>`;

  const again = async () => renderBook(root, await get('books', book.id));
  wireLogForms(root, [book], again);

  $$('[data-undo]').forEach((b) => b.addEventListener('click', async () => {
    await undoReading(history.find((s) => s.id === b.dataset.undo));
    toast('Запис скасовано');
    again();
  }));

  $('#w-tr')?.addEventListener('click', async (e) => {
    const en = $('#w-en').value.trim();
    if (!en) { toast('Спершу впиши слово чи фразу'); return; }
    e.target.disabled = true;
    try { $('#w-ua').value = await translatePhrase(en, $('#w-ctx').value.trim() || en); } catch (err) { toast(err.message); }
    e.target.disabled = false;
  });

  $('#word-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const en = $('#w-en').value.trim();
    const ua = $('#w-ua').value.trim();
    if ((await getAll('cards')).some((c) => c.en.trim().toLowerCase() === en.toLowerCase())) {
      if (!confirm(`Картка «${en}» уже є. Додати ще одну?`)) return;
    }
    await put('cards', makeCard({
      en, ua, context: $('#w-ctx').value, tag: 'vocab', source: 'book', reverse: $('#w-rev').checked,
      bookId: book.id, bookTitle: book.title, page: Number($('#w-page').value) || null,
    }));
    toast('Додано в картки');
    await again();
    $('#w-en').focus();
  });

  $('#edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#e-status').value;
    const updated = {
      ...book, title: $('#e-title').value.trim(), author: $('#e-author').value.trim(),
      totalPages: Number($('#e-total').value) || 0, page: Number($('#e-page').value) || 0, status,
      finishedAt: status === 'done' ? (book.finishedAt || Date.now()) : null,
    };
    await put('books', updated);
    // Назва книжки зберігається і в картках — оновлюємо, щоб джерело показувалось правильно.
    if (updated.title !== book.title) {
      for (const c of cards) await put('cards', { ...c, bookTitle: updated.title });
    }
    toast('Збережено');
    again();
  });

  $('#e-del').addEventListener('click', async () => {
    if (!confirm(`Видалити «${book.title}»? Картки з неї й записаний час залишаться.`)) return;
    await del('books', book.id);
    toast('Книжку видалено');
    location.hash = '#/books';
  });
}
