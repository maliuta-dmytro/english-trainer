import { getAll, put, putMany, del, getSetting } from '../db.js';
import { makeCard, buildQueue } from '../stats.js';
import { formatInterval } from '../srs.js';
import { STARTER } from '../starter.js';
import { esc, $, toast, tagLabel, tagOptions, TAGS } from '../ui.js';

const TAG_IDS = new Set(TAGS.map(([k]) => k));

// Рядок: english | українська | контекст | тег  (також табуляція — для вставки з Excel/Sheets)
function parseBulk(text, reverse) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(line.includes('\t') ? '\t' : '|').map((s) => s.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    const tag = TAG_IDS.has(parts[3]) ? parts[3] : 'vocab';
    out.push(makeCard({ en: parts[0], ua: parts[1], context: parts[2] || '', tag, reverse }));
  }
  return out;
}

// Звідки картка — показуємо біля кожної, щоб пам'ятати, де трапилась фраза.
const SOURCES = {
  manual: 'додано вручну', starter: 'стартовий набір', conversation: 'з розмови з ШІ', retell: 'зі «Слухай і перекажи»',
  dictation: 'з диктанту', grammar: 'з граматичного уроку', journal: 'з журналу помилок', trip: 'з розмовника поїздки', book: 'з книжок',
};
const sourceLabel = (c) => (c.source === 'book' && c.bookTitle
  ? `📖 <a href="#/books?id=${c.bookId}">${esc(c.bookTitle)}</a>${c.page ? `, с. ${c.page}` : ''}`
  : esc(SOURCES[c.source] || ''));

function nextDueLabel(card) {
  const s = card.srs.ua_en;
  if (card.suspended) return 'призупинено';
  if (s.state === 'new') return 'нова';
  const ms = s.due - Date.now();
  return ms <= 0 ? 'до повторення' : `через ${formatInterval(ms)}`;
}

export async function render(root) {
  const reverseDefault = await getSetting('reverseDefault', true);
  let editing = null;
  let filterText = '';
  let filterTag = '';
  let filterSource = '';

  const queue = await buildQueue();
  const toReview = queue.due.length + queue.fresh.length;

  root.innerHTML = `
    <div class="row" style="margin-bottom:8px">
      <h1 style="margin:0">Картки</h1>
      <span class="spacer"></span>
      ${toReview ? `<a class="btn primary" href="#/review">Повторити (${toReview})</a>` : ''}
    </div>
    <div class="card">
      <h2 id="form-title">Нова фраза</h2>
      <form id="card-form" autocomplete="off">
        <div class="grid grid-2">
          <div class="field"><label for="f-ua">Українською (що хочу сказати)</label><input type="text" id="f-ua" required></div>
          <div class="field"><label for="f-en">Англійською (природна фраза)</label><input type="text" id="f-en" required></div>
        </div>
        <div class="field"><label for="f-ctx">Контекст: речення, де ти це почув або сказав (необов'язково)</label><input type="text" id="f-ctx"></div>
        <div class="row">
          <div style="min-width:220px"><label for="f-tag">Категорія</label><select id="f-tag">${tagOptions('vocab')}</select></div>
          <label class="check" style="margin-top:18px"><input type="checkbox" id="f-rev" ${reverseDefault ? 'checked' : ''}> також англ → укр</label>
          <span class="spacer"></span>
          <button type="button" class="ghost" id="f-cancel" hidden>Скасувати</button>
          <button type="submit" class="primary" id="f-submit">Додати</button>
        </div>
      </form>
      <details style="margin-top:14px">
        <summary>Масове додавання</summary>
        <p class="muted small" style="margin-top:8px">Один рядок — одна фраза: <code>english | українська | контекст | тег</code>. Контекст і тег необов'язкові. Можна вставити два-чотири стовпці з Google Sheets/Excel.
          Теги: ${TAGS.map(([k]) => `<code>${k}</code>`).join(', ')}.</p>
        <textarea id="bulk" placeholder="For here or to go? | Тут чи з собою? | Two lattes, please. — For here or to go? | travel"></textarea>
        <div class="row" style="margin-top:8px"><button id="bulk-add">Імпортувати рядки</button></div>
      </details>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <input type="search" id="q" placeholder="Пошук…" style="flex:1;min-width:160px">
        <select id="tag-filter" style="width:auto"><option value="">Усі категорії</option>${tagOptions('')}</select>
        <select id="source-filter" style="width:auto"><option value="">Будь-яке джерело</option>${Object.entries(SOURCES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
      </div>
      <div id="list"></div>
    </div>`;

  const form = $('#card-form');

  function resetForm() {
    editing = null;
    form.reset();
    $('#f-rev').checked = reverseDefault;
    $('#form-title').textContent = 'Нова фраза';
    $('#f-submit').textContent = 'Додати';
    $('#f-cancel').hidden = true;
  }

  async function drawList() {
    const cards = (await getAll('cards')).sort((a, b) => b.created - a.created);
    const q = filterText.toLowerCase();
    const shown = cards.filter((c) =>
      (!filterTag || c.tag === filterTag) && (!filterSource || (c.source || 'manual') === filterSource) &&
      (!q || [c.en, c.ua, c.context, c.bookTitle || ''].some((s) => s.toLowerCase().includes(q))));

    const list = $('#list');
    if (!cards.length) {
      list.innerHTML = `
        <div class="empty">
          <p>Поки що немає жодної картки.</p>
          <p class="muted small">Найкраще працюють фрази з твого власного досвіду: те, що почув у серіалі або не зміг сказати в розмові. Для старту можна взяти готовий набір із ${STARTER.length} розмовних і туристичних фраз.</p>
          <button class="primary" id="starter">Додати стартовий набір</button>
        </div>`;
      $('#starter').addEventListener('click', async () => {
        await putMany('cards', STARTER.map((s) => makeCard({ ...s, source: 'starter', reverse: reverseDefault })));
        toast(`Додано ${STARTER.length} фраз`);
        drawList();
      });
      return;
    }
    list.innerHTML = `
      <p class="muted small">${shown.length} з ${cards.length}</p>
      <ul class="card-list">
        ${shown.map((c) => `
          <li data-id="${c.id}">
            <div style="flex:1;min-width:0">
              <div class="en">${esc(c.en)}</div>
              <div>${esc(c.ua)}</div>
              ${c.context ? `<div class="meta"><em>${esc(c.context)}</em></div>` : ''}
              <div class="meta"><span class="tag">${esc(tagLabel(c.tag))}</span>${sourceLabel(c) ? ` · ${sourceLabel(c)}` : ''} ·${nextDueLabel(c)}${c.srs.ua_en.lapses ? ` · помилок: ${c.srs.ua_en.lapses}` : ''}</div>
            </div>
            <button class="ghost icon-btn" data-act="edit" title="Редагувати" aria-label="Редагувати">✎</button>
            <button class="ghost icon-btn danger" data-act="del" title="Видалити" aria-label="Видалити">✕</button>
          </li>`).join('')}
      </ul>`;

    list.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const card = cards.find((c) => c.id === btn.closest('li').dataset.id);
      if (btn.dataset.act === 'del') {
        if (!confirm(`Видалити картку «${card.en}»?`)) return;
        await del('cards', card.id);
        toast('Картку видалено');
        drawList();
      } else {
        editing = card;
        $('#f-ua').value = card.ua;
        $('#f-en').value = card.en;
        $('#f-ctx').value = card.context;
        $('#f-tag').value = card.tag;
        $('#f-rev').checked = card.reverse;
        $('#form-title').textContent = 'Редагування';
        $('#f-submit').textContent = 'Зберегти';
        $('#f-cancel').hidden = false;
        form.scrollIntoView({ behavior: 'smooth' });
        $('#f-ua').focus();
      }
    }));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = {
      ua: $('#f-ua').value, en: $('#f-en').value, context: $('#f-ctx').value,
      tag: $('#f-tag').value, reverse: $('#f-rev').checked,
    };
    if (editing) {
      await put('cards', { ...editing, ...fields, ua: fields.ua.trim(), en: fields.en.trim(), context: fields.context.trim() });
      toast('Збережено');
    } else {
      await put('cards', makeCard(fields));
      toast('Фразу додано');
    }
    const keepTag = fields.tag;
    resetForm();
    $('#f-tag').value = keepTag;
    $('#f-ua').focus();
    drawList();
  });
  $('#f-cancel').addEventListener('click', resetForm);

  $('#bulk-add').addEventListener('click', async () => {
    const cards = parseBulk($('#bulk').value, reverseDefault);
    if (!cards.length) { toast('Не знайдено жодного коректного рядка'); return; }
    await putMany('cards', cards);
    $('#bulk').value = '';
    toast(`Додано ${cards.length} фраз`);
    drawList();
  });

  $('#q').addEventListener('input', (e) => { filterText = e.target.value; drawList(); });
  $('#tag-filter').addEventListener('change', (e) => { filterTag = e.target.value; drawList(); });
  $('#source-filter').addEventListener('change', (e) => { filterSource = e.target.value; drawList(); });

  await drawList();
}
