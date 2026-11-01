import { put, getSetting, setSetting } from '../db.js';
import { review, GRADES, formatInterval } from '../srs.js';
import { buildQueue, nextLearningAhead, logMinutes, dayKey } from '../stats.js';
import { diffWords } from '../diff.js';
import { speak, canSpeak, canListen, createListener } from '../speech.js';
import { esc, $, tagLabel } from '../ui.js';

const MAX_CARD_MS = 60_000; // довше — вважаємо, що відволіклися, і не зараховуємо

// Ховаємо саму фразу в реченні-контексті, щоб він був підказкою, а не відповіддю.
function blankOut(context, phrase) {
  if (!context) return '';
  const core = phrase.replace(/[.?!…]+$/, '').trim();
  const idx = context.toLowerCase().indexOf(core.toLowerCase());
  if (idx === -1 || !core) return null;
  return esc(context.slice(0, idx)) + '<strong>_____</strong>' + esc(context.slice(idx + core.length));
}

export async function render(root) {
  const retention = await getSetting('retention', 0.9);
  const autoSpeak = await getSetting('autoSpeak', true);
  let current = null;
  let listener = null;
  let phase = 'ask'; // ask → answer → busy (поки зберігається оцінка)
  let alive = true;
  let typed = '';
  let suggested = 3;
  let cardStart = 0;
  let activeMs = 0;
  let done = 0;
  let remaining = 0;

  async function next() {
    const q = await buildQueue();
    let item = q.due[0] || q.fresh[0] || null;
    remaining = q.due.length + q.fresh.length;
    if (!item) {
      item = await nextLearningAhead();
      if (item) remaining = 1;
    }
    current = item;
    phase = 'ask';
    typed = '';
    cardStart = Date.now();
    draw();
  }

  function draw() {
    if (!alive) return;
    if (!current) {
      root.innerHTML = `
        <div class="card empty">
          <h1>${done ? 'Готово! 🎉' : 'Немає карток до повторення'}</h1>
          <p class="muted">${done ? `Повторено ${done} карток за ${Math.max(1, Math.round(activeMs / 60000))} хв.` : 'Додай нові фрази або повертайся пізніше.'}</p>
          <div class="row" style="justify-content:center">
            <a class="btn" href="#/">На головну</a>
            <a class="btn primary" href="#/cards">Додати фрази</a>
          </div>
        </div>`;
      return;
    }
    const { card, dir } = current;
    const sched = card.srs[dir];
    const isMain = dir === 'ua_en';
    const pct = Math.round((done / (done + remaining || 1)) * 100);
    const stateBadge = sched.state === 'new' ? '<span class="tag">нова</span>' : sched.state !== 'review' ? '<span class="tag">вивчається</span>' : '';

    let body;
    if (phase === 'ask') {
      const hint = isMain ? blankOut(card.context, card.en) : esc(card.context);
      body = `
        <div class="dir">${isMain ? 'Скажи / напиши англійською' : 'Що це означає?'}</div>
        <div class="prompt">${esc(isMain ? card.ua : card.en)}</div>
        ${hint ? `<div class="context">${hint}</div>` : ''}
        ${!isMain && canSpeak() ? '<button class="ghost icon-btn" id="say">🔊 Послухати</button>' : ''}
        ${isMain
          ? '<input type="text" id="answer" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Твоя відповідь… (можна залишити порожньою)">'
          : ''}
        <div class="row" style="justify-content:center;margin-top:16px">
          ${isMain && canListen() ? '<button id="say-it" title="Сказати відповідь голосом">🎙 Сказати</button>' : ''}
          <button class="primary" id="reveal">Показати відповідь <kbd>Enter</kbd></button>
        </div>
        <div class="muted small" id="mic-msg" style="margin-top:8px"></div>`;
    } else {
      let verdict = '';
      let diffHtml = '';
      if (isMain && typed.trim()) {
        const d = diffWords(card.en, typed);
        verdict = d.exact
          ? '<span class="verdict good">Точно ✓</span>'
          : d.score >= 0.7 ? '<span class="verdict warn">Майже</span>' : '<span class="verdict bad">Не зовсім</span>';
        diffHtml = `<div class="diff">${d.parts.map((p) => `<span class="${p.type}">${esc(p.word)}</span>`).join(' ')}</div>`;
      }
      const answer = isMain ? card.en : card.ua;
      const now = Date.now();
      body = `
        <div class="dir">${esc(isMain ? card.ua : card.en)}</div>
        ${verdict}
        ${diffHtml}
        <div class="answer">${esc(answer)}</div>
        ${card.context ? `<div class="context">${esc(card.context)}</div>` : ''}
        ${card.bookTitle ? `<div class="muted small" style="margin:-4px 0 10px">📖 ${esc(card.bookTitle)}${card.page ? `, с. ${card.page}` : ''}</div>` : ''}
        ${canSpeak() ? '<button class="ghost icon-btn" id="say">🔊 Послухати</button> <button class="ghost icon-btn" id="say-slow">🐢 Повільно</button>' : ''}
        <div class="grades">
          ${GRADES.map(({ g, key, label }) => `
            <button class="g${g}${g === suggested ? ' primary' : ''}" data-grade="${g}">
              ${label} <kbd>${key}</kbd>
              <span class="ivl">${formatInterval(review(sched, g, now, retention).due - now)}</span>
            </button>`).join('')}
        </div>`;
    }

    root.innerHTML = `
      <div class="progress"><div style="width:${pct}%"></div></div>
      <div class="row small muted" style="margin-bottom:8px">
        <span>Повторено: ${done}</span><span>·</span><span>Залишилось: ${remaining}</span>
        <span class="spacer"></span>
        <span class="tag">${esc(tagLabel(card.tag))}</span> ${stateBadge}
      </div>
      <div class="card review-card">${body}</div>
      <p class="muted small" style="text-align:center">Порада: спершу скажи фразу вголос, а потім напиши. Так тренується і пригадування, і вимова.</p>`;

    $('#answer')?.focus();
    $('#reveal')?.addEventListener('click', reveal);
    $('#say')?.addEventListener('click', () => speak(card.en));
    $('#say-slow')?.addEventListener('click', () => speak(card.en, 0.7));
    $('#say-it')?.addEventListener('click', () => {
      const btn = $('#say-it');
      if (listener?.listening) { listener.stop(); return; }
      // Сказав → текст у поле → одразу перевірка, як при Enter.
      listener = createListener({
        onText: (finalText, interim) => { const a = $('#answer'); if (a) a.value = [finalText, interim].filter(Boolean).join(' '); },
        onStop: (text) => {
          btn?.classList.remove('listening');
          if (text && phase === 'ask') { $('#answer').value = text; reveal(); }
          else if (!text && $('#mic-msg')) $('#mic-msg').textContent = 'Нічого не почуто. Спробуй ще раз.';
        },
        onError: (msg) => { btn?.classList.remove('listening'); if ($('#mic-msg')) $('#mic-msg').textContent = msg; },
      });
      listener.start();
      btn.classList.add('listening');
      btn.textContent = '⏹ Готово';
      $('#mic-msg').textContent = 'Слухаю…';
    });
    root.querySelectorAll('[data-grade]').forEach((b) => b.addEventListener('click', () => grade(Number(b.dataset.grade))));
  }

  function reveal() {
    if (!current || phase !== 'ask') return;
    listener?.abort();
    typed = $('#answer')?.value || '';
    const { card, dir } = current;
    if (dir === 'ua_en' && typed.trim()) {
      const d = diffWords(card.en, typed);
      suggested = d.exact ? 3 : d.score >= 0.7 ? 2 : 1;
    } else {
      suggested = 3;
    }
    phase = 'answer';
    draw();
    if (autoSpeak) speak(card.en);
  }

  async function grade(g) {
    if (!current || phase !== 'answer') return;
    phase = 'busy';
    const { card, dir } = current;
    const wasNew = card.srs[dir].state === 'new';
    card.srs[dir] = review(card.srs[dir], g, Date.now(), retention);
    await put('cards', card);
    if (wasNew) {
      const key = `newDone:${dayKey()}`;
      await setSetting(key, (await getSetting(key, 0)) + 1);
    }
    activeMs += Math.min(Date.now() - cardStart, MAX_CARD_MS);
    done++;
    await next();
  }

  function onKey(e) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (phase === 'ask' && e.key === 'Enter') { e.preventDefault(); reveal(); return; }
    if (phase === 'answer') {
      if (e.key === 'Enter') { e.preventDefault(); grade(suggested); }
      else if (['1', '2', '3', '4'].includes(e.key)) grade(Number(e.key));
    }
  }
  document.addEventListener('keydown', onKey);

  await next();

  let logged = false;
  return async () => {
    alive = false;
    listener?.abort();
    document.removeEventListener('keydown', onKey);
    if (logged) return;
    logged = true;
    await logMinutes('focus', activeMs / 60000, 'srs');
  };
}
