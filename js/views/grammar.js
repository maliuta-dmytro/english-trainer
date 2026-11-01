import { getAll, get, put, del, getSetting, setSetting, uid } from '../db.js';
import { GRAMMAR_TOPICS, EXERCISES, errorsByTopic, generateLesson, checkAnswers } from '../grammar.js';
import { costOf, hasKey, NO_KEY_HTML } from '../ai.js';
import { logMinutes, makeCard } from '../stats.js';
import { speak, canSpeak } from '../speech.js';
import { esc, $, $$, toast, tagLabel, plural, ERRORS_WORD } from '../ui.js';

const FOCUS_DAYS = 7;
const IDLE_CAP_MS = 3 * 60_000;

export async function render(root) {
  const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
  const lesson = id ? await get('lessons', id) : null;
  if (lesson) return renderLesson(root, lesson);
  return renderPicker(root);
}

// Рекомендована тема: найбільше помилок за 4 тижні; без помилок — перша з пріоритетних, яку давно не проходили.
export async function recommendedTopic() {
  const [byTopic, lessons] = await Promise.all([errorsByTopic(), getAll('lessons')]);
  const lastLesson = (t) => Math.max(0, ...lessons.filter((l) => l.category === t).map((l) => l.created));
  const withErrors = GRAMMAR_TOPICS.filter((t) => byTopic[t].length).sort((a, b) => byTopic[b].length - byTopic[a].length);
  const pick = withErrors[0] || [...GRAMMAR_TOPICS].sort((a, b) => lastLesson(a) - lastLesson(b))[0];
  return { category: pick, errors: byTopic[pick].length, lastLesson: lastLesson(pick) };
}

// ---------- Вибір теми ----------

async function renderPicker(root) {
  const [byTopic, lessons, apiKey, level, auto, focus] = await Promise.all([
    errorsByTopic(), getAll('lessons'), hasKey(), getSetting('talkLevel', 'B2'), recommendedTopic(), getSetting('lessonFocus', null),
  ]);
  // Перехід із журналу: #/grammar?topic=articles — ця тема стає рекомендованою.
  const asked = new URLSearchParams(location.hash.split('?')[1] || '').get('topic');
  const rec = GRAMMAR_TOPICS.includes(asked) ? { category: asked, errors: byTopic[asked].length } : auto;
  lessons.sort((a, b) => b.created - a.created);
  const last = (t) => lessons.find((l) => l.category === t);

  root.innerHTML = `
    <h1>Граматика</h1>
    <p class="muted">Короткий урок на 15 хвилин під тему, де в тебе найбільше помилок: пояснення, твої власні помилки з розмов і ${EXERCISES} речень, які ти складаєш сам. Неправильні відповіді стають картками, а тема тиждень буде фокусом у розмовах з ШІ.</p>
    ${apiKey ? '' : `<div class="card notice">${NO_KEY_HTML}</div>`}
    ${focus && focus.until > Date.now() ? `<p class="small">🎯 Зараз у фокусі розмов: <strong>${esc(tagLabel(focus.category))}</strong> (до ${new Date(focus.until).toLocaleDateString('uk-UA')}).</p>` : ''}

    <div class="card recommend">
      <div class="muted small">${GRAMMAR_TOPICS.includes(asked) ? 'Обрана тема' : 'Рекомендовано'}</div>
      <h2 style="margin:2px 0 4px">${esc(tagLabel(rec.category))}</h2>
      <p class="small muted" style="margin:0 0 10px">${rec.errors ? `${plural(rec.errors, ERRORS_WORD)} за 4 тижні в журналі.` :'У журналі поки немає помилок цієї теми: це одна з пріоритетних тем для україномовних.'}</p>
      <button class="primary" data-start="${rec.category}" ${apiKey ? '' : 'disabled'}>Почати урок</button>
    </div>

    <div class="card">
      <h2>Усі теми</h2>
      <ul class="card-list">
        ${GRAMMAR_TOPICS.map((t) => {
          const l = last(t);
          return `<li>
            <div style="flex:1;min-width:0"><strong>${esc(tagLabel(t))}</strong>
              <div class="meta">помилок за 4 тижні: ${byTopic[t].length}${l ? ` · останній урок ${new Date(l.created).toLocaleDateString('uk-UA')}${l.score != null ? `, ${l.score}/${EXERCISES}` : ''}` : ''}</div></div>
            <button class="icon-btn" data-start="${t}" ${apiKey ? '' : 'disabled'}>Урок</button>
          </li>`;
        }).join('')}
      </ul>
    </div>

    ${lessons.length ? `<h2>Мої уроки</h2><div class="card"><ul class="card-list">${lessons.map((l) => `
      <li>
        <div style="flex:1;min-width:0"><a href="#/grammar?id=${l.id}"><strong>${esc(l.lesson.title)}</strong></a>
          <div class="meta">${new Date(l.created).toLocaleDateString('uk-UA')} · ${esc(tagLabel(l.category))}${l.score != null ? ` · ${l.score}/${EXERCISES}` : ' · <span class="tag">не завершено</span>'}</div></div>
        <button class="ghost icon-btn danger" data-del="${l.id}" aria-label="Видалити">✕</button>
      </li>`).join('')}</ul></div>` : ''}`;

  $$('[data-start]').forEach((b) => b.addEventListener('click', async () => {
    const category = b.dataset.start;
    $$('[data-start]').forEach((x) => { x.disabled = true; });
    b.textContent = 'Готую урок…';
    try {
      const { data, usage, model } = await generateLesson({ category, level, errors: byTopic[category] });
      const l = { id: uid(), created: Date.now(), category, level, lesson: data, answers: [], check: null, score: null, usage, model, activeMs: 0, loggedMs: 0 };
      await put('lessons', l);
      location.hash = `#/grammar?id=${l.id}`;
    } catch (err) {
      toast(err.message);
      render(root);
    }
  }));
  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Видалити цей урок?')) return;
    await del('lessons', b.dataset.del);
    render(root);
  }));
}

// ---------- Урок ----------

async function renderLesson(root, l) {
  const L = l.lesson;
  let lastActivity = Date.now();
  let checking = false;
  const touch = () => {
    const now = Date.now();
    l.activeMs = (l.activeMs || 0) + Math.min(now - lastActivity, IDLE_CAP_MS);
    lastActivity = now;
  };
  const sayBtn = (text) => (canSpeak() ? `<button class="ghost icon-btn say" data-say="${esc(text)}" aria-label="Озвучити">🔊</button>` : '');

  function draw() {
    const res = l.check ? Object.fromEntries(l.check.results.map((r) => [r.index, r])) : null;
    root.innerHTML = `
      <a href="#/grammar" class="muted small">← Граматика</a>
      <h1 style="margin-bottom:4px">${esc(L.title)}</h1>
      <p class="muted small">${esc(tagLabel(l.category))} · ${esc(l.level)}</p>

      <div class="card lesson">
        <p>${esc(L.explanation)}</p>
        <ol class="rules">${L.rules.map((r) => `
          <li><div>${esc(r.rule)}</div>
            <div class="ex">${esc(r.example_en)} ${sayBtn(r.example_en)}</div>
            <div class="muted small">${esc(r.example_ua)}</div></li>`).join('')}</ol>
        ${L.your_errors.length ? `<h3>Твої помилки з розмов</h3>
          <ul class="fix-list">${L.your_errors.map((e) => `<li><div class="was">${esc(e.original)}</div><div class="now">${esc(e.corrected)}</div><div class="small muted">${esc(e.why)}</div></li>`).join('')}</ul>` : ''}
        <p class="small tip">💡 ${esc(L.tip)}</p>
      </div>

      <h2>Вправи <span class="muted small">· склади речення сам</span></h2>
      <form id="ex-form" class="card">
        <ol class="exercises">${L.exercises.map((ex, i) => {
          const r = res?.[i];
          return `<li class="${r ? (r.correct ? 'ok' : 'bad') : ''}">
            <div class="task">${ex.type === 'translate' ? '<span class="tag">переклади</span> ' : ex.type === 'correct' ? '<span class="tag">виправ</span> ' : '<span class="tag">перетвори</span> '}${esc(ex.task)}</div>
            ${ex.source ? `<div class="ex">${esc(ex.source)}</div>` : ''}
            <input type="text" data-i="${i}" value="${esc(l.answers[i] || '')}" autocomplete="off" spellcheck="false" ${l.check ? 'disabled' : ''} placeholder="Твоя відповідь англійською">
            ${r ? `<div class="feedback">${r.correct ? '✓' : '✗'} ${esc(r.feedback)}</div>
              ${r.correct ? '' : `<div class="now">${esc(r.corrected)} ${sayBtn(r.corrected)}</div>`}
              <div class="muted small">Зразок: ${esc(ex.answer)}</div>` : ''}
          </li>`;
        }).join('')}</ol>
        ${l.check
          ? `<div class="result-box">
              <p><strong>${l.score} з ${EXERCISES}</strong> правильно. ${esc(l.check.summary)}</p>
              <p class="muted small">${l.cardsCreated ? `Неправильні речення додано в картки: ${l.cardsCreated}. ` : ''}Тема «${esc(tagLabel(l.category))}» тепер у фокусі розмов з ШІ на ${FOCUS_DAYS} днів. Вартість уроку ≈ $${costOf(l.usage, l.model).toFixed(3)}.</p>
              <div class="row">
                <a class="btn primary" href="#/talk">Застосувати в розмові</a>
                ${l.cardsCreated ? '<a class="btn" href="#/review">Повторити картки</a>' : ''}
                <button type="button" id="redo">Пройти вправи ще раз</button>
              </div>
            </div>`
          : `<div class="row"><span class="muted small" id="filled"></span><span class="spacer"></span><button type="submit" class="primary" id="check">Перевірити</button></div>`}
      </form>`;

    $$('[data-say]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); speak(b.dataset.say); }));
    const updateFilled = () => {
      const n = l.answers.filter((a) => a && a.trim()).length;
      const f = $('#filled');
      if (f) f.textContent = `Заповнено ${n} з ${EXERCISES}`;
    };
    updateFilled();
    let saveTimer;
    $$('[data-i]').forEach((inp) => inp.addEventListener('input', () => {
      l.answers[Number(inp.dataset.i)] = inp.value;
      touch();
      updateFilled();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => put('lessons', l), 600);
    }));
    // Enter переводить до наступного поля, а з останнього — надсилає.
    $$('[data-i]').forEach((inp) => inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = $(`[data-i="${Number(inp.dataset.i) + 1}"]`);
      if (next) next.focus();
      else $('#ex-form').requestSubmit();
    }));
    $('#ex-form').addEventListener('submit', (e) => { e.preventDefault(); check(); });
    $('#redo')?.addEventListener('click', async () => {
      l.answers = [];
      l.check = null;
      l.score = null;
      await put('lessons', l);
      draw();
      $('[data-i="0"]')?.focus();
    });
  }

  async function check() {
    if (checking) return;
    const filled = l.answers.filter((a) => a && a.trim()).length;
    if (filled < EXERCISES && !confirm(`Заповнено ${filled} з ${EXERCISES}. Перевірити так? Порожні вважатимуться помилкою.`)) return;
    checking = true;
    const btn = $('#check');
    btn.disabled = true;
    btn.textContent = 'Перевіряю…';
    touch();
    try {
      const { data, usage } = await checkAnswers({ lesson: L, category: l.category, answers: l.answers });
      for (const k of Object.keys(usage)) if (typeof usage[k] === 'number') l.usage[k] = (l.usage[k] || 0) + usage[k];
      l.check = data;
      l.score = data.results.filter((r) => r.correct).length;
      l.cardsCreated = await cardsFromMistakes(l);
      await setSetting('lessonFocus', { category: l.category, until: Date.now() + FOCUS_DAYS * 86_400_000 });
      await put('lessons', l);
      await logDelta();
      draw();
      $('.result-box')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Перевірити';
    } finally {
      checking = false;
    }
  }

  async function logDelta() {
    const delta = (l.activeMs || 0) - (l.loggedMs || 0);
    if (delta <= 0) return;
    l.loggedMs = l.activeMs;
    await put('lessons', l);
    await logMinutes('focus', delta / 60000, 'grammar');
  }

  draw();

  return async () => {
    touch();
    await put('lessons', l);
    await logDelta();
  };
}

// Неправильні відповіді → картки «укр → англ» (без дублікатів).
async function cardsFromMistakes(l) {
  const known = new Set((await getAll('cards')).map((c) => c.en.trim().toLowerCase()));
  const cards = [];
  for (const r of l.check.results) {
    const ex = l.lesson.exercises[r.index];
    if (r.correct || !ex) continue;
    const en = (r.corrected || ex.answer).trim();
    if (!en || known.has(en.toLowerCase())) continue;
    known.add(en.toLowerCase());
    cards.push(makeCard({ en, ua: ex.ua, context: l.answers[r.index] ? `Було: ${l.answers[r.index]}` : '', tag: l.category, source: 'grammar', reverse: false }));
  }
  for (const c of cards) await put('cards', c);
  return cards.length;
}
