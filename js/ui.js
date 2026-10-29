// Дрібні хелпери для DOM.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Українські форми множини: plural(5, ['помилка', 'помилки', 'помилок']) → «5 помилок».
export function plural(n, [one, few, many]) {
  const m10 = n % 10;
  const m100 = n % 100;
  const form = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${form}`;
}
export const ERRORS_WORD = ['помилка', 'помилки', 'помилок'];

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// Категорії для карток і (згодом) журналу помилок — з пріоритетних тем брифу.
export const TAGS = [
  ['vocab', 'Лексика'],
  ['collocation', 'Колокації'],
  ['phrasal', 'Фразові дієслова'],
  ['idiom', 'Ідіоми'],
  ['articles', 'Артиклі'],
  ['tenses', 'Часи (Perfect / Past)'],
  ['conditionals', 'Умовні речення'],
  ['modals', 'Модальні припущення'],
  ['word-order', 'Порядок слів / запитання'],
  ['prepositions', 'Прийменники'],
  ['c1-grammar', 'C1: інверсія, cleft, пасив'],
  ['travel', 'Подорож'],
  ['small-talk', 'Small talk'],
  ['other', 'Інше'],
];

// Категорії помилок для журналу — підмножина тегів (без тематичних travel / small-talk).
export const ERROR_CATEGORIES = TAGS.map(([k]) => k).filter((k) => k !== 'travel' && k !== 'small-talk');
export const tagLabel = (id) => (TAGS.find(([k]) => k === id) || [id, id])[1];
export const tagOptions = (selected) =>
  TAGS.map(([k, v]) => `<option value="${k}"${k === selected ? ' selected' : ''}>${esc(v)}</option>`).join('');
