import { getAll, get, put, del, getSetting, uid } from '../db.js';
import {
  parseSubtitles, mergeCues, splitSentences, compareDictation, missedWords, generateText, translatePhrase, GEN_KINDS,
} from '../dictation.js';
import { LEVELS } from '../scenarios.js';
import { situationById } from '../trip.js';
import { logMinutes, makeCard } from '../stats.js';
import { speak, stopSpeaking, canSpeak, getRate } from '../speech.js';
import { esc, $, $$, toast } from '../ui.js';

const SEG_CAP_MS = 2 * 60_000; // довші паузи на одному фрагменті не зараховуємо
const GOOD = 0.9;              // фрагмент вважається «почутим» від 90% слів
const TOPICS = [
  'airport announcements and a gate change', 'ordering at a busy diner', 'small talk about the weather and weekend plans',
  'checking into a hotel with a problem', 'a friend telling a funny travel story', 'a podcast host talking about American road trips',
  'renting a car and the insurance options', 'a coworker complaining about remote work',
];

export async function render(root) {
  const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
  const d = id ? await get('dictations', id) : null;
  if (!d) return renderList(root);
  if (d.needsMarking) return renderMarking(root, d);
  return renderSession(root, d);
}

const accuracy = (d) => {
  const r = Object.values(d.results || {});
  return r.length ? r.reduce((a, x) => a + x.score, 0) / r.length : null;
};
const pct = (x) => `${Math.round(x * 100)}%`;

// ---------- Список і створення ----------

async function renderList(root) {
  const [list, apiKey, level] = await Promise.all([getAll('dictations'), getSetting('apiKey', ''), getSetting('talkLevel', 'B2')]);
  // Перехід із туристичного режиму: #/dictation?trip=hotel — тема ситуації вже підставлена.
  const trip = situationById(new URLSearchParams(location.hash.split('?')[1] || '').get('trip'));
  list.sort((a, b) => b.created - a.created);

  const missCounts = {};
  for (const d of list) for (const r of Object.values(d.results || {})) for (const w of r.missed || []) missCounts[w] = (missCounts[w] || 0) + 1;
  const topMissed = Object.entries(missCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);

  root.innerHTML = `
    <h1>Диктант</h1>
    <p class="muted">Інтенсивне слухання: слухаєш фрагмент 5–15 секунд, записуєш почуте й бачиш, що пропустив. Так тренується розпізнавання швидкого мовлення: «gonna», злиті слова, «ковтання» звуків.</p>

    <div class="card">
      <div class="seg" role="tablist" style="margin-bottom:12px">
        <button class="icon-btn primary" data-tab="ai" role="tab">✨ Текст від ШІ</button>
        <button class="icon-btn" data-tab="file" role="tab">📁 Свій файл</button>
      </div>

      <form id="f-ai">
        <p class="muted small" style="margin-top:0">Claude пише живий текст на твою тему, а браузер його озвучує. Найшвидший старт, але синтетичний голос звучить рівніше за живу людину, тож для справжнього темпу краще брати свої файли.</p>
        ${apiKey ? '' : '<p class="notice card small" style="padding:10px 14px">Потрібен ключ Claude API. <a href="#/settings">Додати →</a></p>'}
        ${trip ? `<p class="small">🧳 Диктант для ситуації «${trip.icon} ${esc(trip.title)}» з туристичного режиму.</p>` : ''}
        <div class="field"><label for="ai-topic">Тема</label><input type="text" id="ai-topic" placeholder="${esc(TOPICS[0])}" value="${trip ? esc(trip.dictation) : ''}"></div>
        <div class="row" style="margin:-4px 0 12px">${TOPICS.slice(1, 6).map((t) => `<button type="button" class="icon-btn chip small" data-topic="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <div class="row">
          <div><label for="ai-kind">Формат</label><select id="ai-kind">${GEN_KINDS.map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
          <div><label for="ai-level">Рівень</label><select id="ai-level">${LEVELS.map(([k]) => `<option${k === level ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
          <div><label for="ai-len">Речень</label><select id="ai-len"><option>8</option><option selected>12</option><option>16</option></select></div>
          <span class="spacer"></span>
          <button type="submit" class="primary" style="margin-top:18px" ${apiKey && canSpeak() ? '' : 'disabled'}>Створити диктант</button>
        </div>
      </form>

      <form id="f-file" hidden>
        <p class="muted small" style="margin-top:0">Аудіо або відео (серіал, подкаст, YouTube) + текст. Найзручніше — субтитри <code>.srt</code>/<code>.vtt</code>: фрагменти наріжуться за таймкодами. Якщо є лише звичайний текст, ти розмітиш речення пробілом під час прослуховування.</p>
        <div class="field"><label for="file-media">Аудіо або відео</label><input type="file" id="file-media" accept="audio/*,video/*" required></div>
        <div class="field"><label for="file-subs">Субтитри або текст (файл)</label><input type="file" id="file-subs" accept=".srt,.vtt,.txt,text/plain"></div>
        <div class="field"><label for="file-text">…або встав текст / субтитри сюди</label><textarea id="file-text" placeholder="1&#10;00:00:01,200 --> 00:00:03,900&#10;Hey, are you gonna be around later?"></textarea></div>
        <div class="field"><label for="file-title">Назва</label><input type="text" id="file-title" placeholder="Friends S01E01, 05:00–08:00"></div>
        <button type="submit" class="primary">Створити диктант</button>
      </form>
    </div>

    ${topMissed.length ? `<div class="card">
      <h2>Що найчастіше не чую</h2>
      <p class="muted small" style="margin-top:-4px">Слова, які ти пропускав у диктантах. Часто це короткі службові слова, що «ковтаються» у швидкому мовленні.</p>
      <div class="row">${topMissed.map(([w, n]) => `<span class="tag">${esc(w)} · ${n}</span>`).join('')}</div>
    </div>` : ''}

    <h2>Мої диктанти</h2>
    <div class="card">
      ${list.length ? `<ul class="card-list">${list.map((d) => {
        const done = Object.keys(d.results || {}).length;
        const acc = accuracy(d);
        return `<li>
          <div style="flex:1;min-width:0">
            <a href="#/dictation?id=${d.id}"><strong>${d.source === 'ai' ? '✨' : d.isVideo ? '🎬' : '🎧'} ${esc(d.title)}</strong></a>
            <div class="meta">${new Date(d.created).toLocaleDateString('uk-UA')} · ${d.needsMarking ? '<span class="tag">потрібна розмітка</span>' : `фрагментів ${done}/${d.segments.length}`}${acc !== null ? ` · точність ${pct(acc)}` : ''}</div>
          </div>
          <button class="ghost icon-btn danger" data-del="${d.id}" aria-label="Видалити">✕</button>
        </li>`;
      }).join('')}</ul>` : '<p class="muted" style="margin:0">Поки що немає диктантів.</p>'}
    </div>`;

  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-tab]').forEach((x) => x.classList.toggle('primary', x === b));
    $('#f-ai').hidden = b.dataset.tab !== 'ai';
    $('#f-file').hidden = b.dataset.tab !== 'file';
  }));
  $$('[data-topic]').forEach((b) => b.addEventListener('click', () => { $('#ai-topic').value = b.dataset.topic; }));
  $('#file-media').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f && !$('#file-title').value) $('#file-title').value = f.name.replace(/\.[^.]+$/, '');
  });

  $('#f-ai').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#f-ai button[type=submit]');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Пишу текст…';
    try {
      const topic = $('#ai-topic').value.trim() || TOPICS[0];
      const res = await generateText({ topic, level: $('#ai-level').value, kind: $('#ai-kind').value, sentences: Number($('#ai-len').value) });
      const d = {
        id: uid(), created: Date.now(), source: 'ai', title: res.title, trip: trip?.id ?? null,
        segments: res.sentences.map((text) => ({ text })), results: {}, pos: 0, activeMs: 0, loggedMs: 0,
      };
      await put('dictations', d);
      location.hash = `#/dictation?id=${d.id}`;
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Створити диктант';
    }
  });

  $('#f-file').addEventListener('submit', async (e) => {
    e.preventDefault();
    const media = $('#file-media').files[0];
    const subsFile = $('#file-subs').files[0];
    const raw = subsFile ? await subsFile.text() : $('#file-text').value;
    if (!media) return;
    if (!raw.trim()) { toast('Додай субтитри або текст'); return; }
    const isSubs = raw.includes('-->');
    const segments = isSubs ? mergeCues(parseSubtitles(raw)) : splitSentences(raw).map((text) => ({ text }));
    if (!segments.length) { toast('Не вдалося знайти текст у субтитрах'); return; }
    const mediaId = uid();
    await put('media', { id: mediaId, blob: media });
    const d = {
      id: uid(), created: Date.now(), source: 'file', title: $('#file-title').value.trim() || media.name,
      mediaId, isVideo: media.type.startsWith('video'), segments, needsMarking: !isSubs, offset: 0,
      results: {}, pos: 0, activeMs: 0, loggedMs: 0,
    };
    await put('dictations', d);
    location.hash = `#/dictation?id=${d.id}`;
  });

  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const d = list.find((x) => x.id === b.dataset.del);
    if (!confirm(`Видалити диктант «${d.title}»${d.mediaId ? ' разом із файлом' : ''}?`)) return;
    if (d.mediaId) await del('media', d.mediaId);
    await del('dictations', d.id);
    render(root);
  }));
}

// ---------- Медіаплеєр фрагментів ----------

async function mediaPlayer(d) {
  const row = d.mediaId ? await get('media', d.mediaId) : null;
  if (!row) return null;
  const url = URL.createObjectURL(row.blob);
  const el = document.createElement('video');
  el.src = url;
  el.preload = 'auto';
  el.playsInline = true;
  el.className = 'media';
  let stopAt = null;
  let raf = 0;
  const reached = () => {
    if (stopAt !== null && el.currentTime >= stopAt) { el.pause(); stopAt = null; return true; }
    return false;
  };
  // rAF дає точну зупинку, але не працює у фоновій вкладці — тоді спрацьовує timeupdate (~4 рази/с).
  const tick = () => { if (!reached()) raf = requestAnimationFrame(tick); };
  el.addEventListener('timeupdate', reached);
  el.addEventListener('error', () => toast('Браузер не може відтворити цей файл. Спробуй MP3, M4A, MP4 або WebM.'));
  return {
    el,
    play(start, end, rate = 1) {
      cancelAnimationFrame(raf);
      el.playbackRate = rate;
      el.currentTime = Math.max(0, start);
      stopAt = end;
      el.play().catch(() => {});
      raf = requestAnimationFrame(tick);
    },
    stop() { cancelAnimationFrame(raf); el.pause(); stopAt = null; },
    destroy() { cancelAnimationFrame(raf); el.pause(); URL.revokeObjectURL(url); },
  };
}

// ---------- Розмітка простого тексту ----------

async function renderMarking(root, d) {
  const player = await mediaPlayer(d);
  if (!player) { root.innerHTML = missingMedia(d); return; }
  const sentences = d.segments.map((s) => s.text);
  let marks = [];
  let started = false;

  root.innerHTML = `
    <a href="#/dictation" class="muted small">← Диктанти</a>
    <h1>Розмітка: ${esc(d.title)}</h1>
    <p class="muted">Текст без таймкодів, тож розмітимо його разом. Натисни «Почати» й слухай. Щойно речення, підсвічене нижче, закінчиться, тисни <kbd>пробіл</kbd> або кнопку «Кінець речення». Помилився — «Почати знову».</p>
    <div id="m-media"></div>
    <div class="row" style="margin:10px 0">
      <button class="primary" id="m-start">▶ Почати</button>
      <button id="m-mark" disabled>⏎ Кінець речення</button>
      <button id="m-reset" class="ghost">Почати знову</button>
    </div>
    <ol class="mark-list" id="m-list"></ol>`;
  $('#m-media').appendChild(player.el);
  if (!d.isVideo) player.el.classList.add('audio-only');

  const draw = () => {
    $('#m-list').innerHTML = sentences.map((s, i) => `<li class="${i < marks.length ? 'marked' : i === marks.length && started ? 'current' : ''}">
      ${esc(s)}${i < marks.length ? ` <span class="muted small">${marks[i].toFixed(1)} с</span>` : ''}</li>`).join('');
    $('#m-list .current')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const finish = async () => {
    player.stop();
    let start = 0;
    d.segments = sentences.map((text, i) => {
      const end = marks[i] ?? player.el.duration;
      const seg = { start, end, text };
      start = end;
      return seg;
    });
    d.needsMarking = false;
    await put('dictations', d);
    toast('Розмітку збережено');
    render(root);
  };
  const mark = () => {
    if (!started) return;
    // Час має просунутись: інакше файл не грає або це випадкове подвійне натискання.
    const t = player.el.currentTime;
    if (t <= (marks.at(-1) ?? 0) + 0.3) return;
    marks.push(t);
    if (marks.length >= sentences.length) { finish(); return; }
    draw();
  };
  $('#m-start').addEventListener('click', () => {
    marks = [];
    started = true;
    player.play(0, Infinity, 1);
    $('#m-mark').disabled = false;
    draw();
  });
  $('#m-reset').addEventListener('click', () => { marks = []; started = false; player.stop(); player.el.currentTime = 0; $('#m-mark').disabled = true; draw(); });
  $('#m-mark').addEventListener('click', mark);
  player.el.addEventListener('ended', () => { if (started && marks.length) finish(); });
  const onKey = (e) => { if (e.code === 'Space' && started) { e.preventDefault(); mark(); } };
  document.addEventListener('keydown', onKey);
  draw();
  return () => { document.removeEventListener('keydown', onKey); player.destroy(); };
}

const missingMedia = (d) => `
  <a href="#/dictation" class="muted small">← Диктанти</a>
  <div class="card empty"><h1>${esc(d.title)}</h1>
  <p>Медіафайл не знайдено. Схоже, дані відновлено з бекапу, а файли в бекап не потрапляють. Створи диктант із цим файлом ще раз.</p></div>`;

// ---------- Сесія диктанту ----------

async function renderSession(root, d) {
  const player = d.source === 'file' ? await mediaPlayer(d) : null;
  if (d.source === 'file' && !player) { root.innerHTML = missingMedia(d); return; }
  const apiKey = await getSetting('apiKey', '');
  let pos = Math.min(d.pos || 0, d.segments.length);
  let phase = 'listen'; // listen → checked
  let slow = false;
  let plays = 0;
  let segStart = Date.now();
  let selection = null; // [from, to] індекси слів для картки
  let only = null;      // режим «лише помилкові фрагменти»

  const save = () => put('dictations', d);
  const order = () => only || d.segments.map((_, i) => i);

  root.innerHTML = `
    <div class="row" style="margin-bottom:6px">
      <a href="#/dictation" class="muted small">← Диктанти</a><span class="spacer"></span>
      ${player ? `<label class="check small" style="margin:0"><input type="checkbox" id="s-video" ${d.isVideo ? '' : 'disabled'}> показувати відео</label>` : ''}
    </div>
    <h1 style="margin-bottom:4px">${d.source === 'ai' ? '✨' : '🎧'} ${esc(d.title)}</h1>
    <div id="s-media"></div>
    <div id="s-body"></div>`;
  if (player) {
    $('#s-media').appendChild(player.el);
    player.el.classList.add('audio-only');
    $('#s-video')?.addEventListener('change', (e) => player.el.classList.toggle('audio-only', !e.target.checked));
  }

  const seg = () => d.segments[order()[pos]];

  function play() {
    const s = seg();
    if (!s) return;
    plays++;
    const rate = slow ? 0.75 : 1;
    if (player) player.play(s.start + (d.offset || 0) - 0.1, s.end + (d.offset || 0) + 0.2, rate);
    else speak(s.text, getRate() * rate);
    const c = $('#plays');
    if (c) c.textContent = `прослухано: ${plays}`;
  }

  function draw() {
    const body = $('#s-body');
    const list = order();
    if (pos >= list.length) { drawSummary(); return; }
    const idx = list[pos];
    const s = d.segments[idx];
    const done = list.filter((i) => d.results[i]).length;
    const res = d.results[idx];

    let check = '';
    if (phase === 'checked' && res) {
      const diff = compareDictation(s.text, res.typed);
      const words = s.text.split(/\s+/);
      check = `
        <div class="result">
          <span class="verdict ${res.score >= GOOD ? 'good' : res.score >= 0.6 ? 'warn' : 'bad'}">${pct(res.score)} слів</span>
          <div class="diff">${diff.parts.map((p) => `<span class="${p.type}">${esc(p.word)}</span>`).join(' ')}</div>
          <div class="muted small">Оригінал (натисни на перше й останнє слово фрази, щоб додати її в картки):</div>
          <div class="pick">${words.map((w, i) => `<span data-w="${i}" class="${selection && i >= selection[0] && i <= selection[1] ? 'sel' : ''}">${esc(w)}</span>`).join(' ')}</div>
          <div id="card-form"></div>
        </div>`;
    }

    body.innerHTML = `
      <div class="progress"><div style="width:${(done / list.length) * 100}%"></div></div>
      <div class="row small muted" style="margin-bottom:8px">
        <span>Фрагмент ${pos + 1} з ${list.length}${only ? ' · лише помилкові' : ''}</span><span class="spacer"></span>
        ${player ? `<span class="row" style="gap:4px">зсув субтитрів <button class="icon-btn" data-off="-0.25">−</button><b>${(d.offset || 0).toFixed(2)} с</b><button class="icon-btn" data-off="0.25">+</button></span>` : ''}
      </div>
      <div class="card">
        <div class="row">
          <button class="primary" id="play">▶ Прослухати <kbd>Esc</kbd></button>
          <label class="check" style="margin:0"><input type="checkbox" id="slow" ${slow ? 'checked' : ''}> 🐢 0.75×</label>
          <span class="muted small" id="plays">прослухано: ${plays}</span>
        </div>
        <textarea id="typed" rows="3" placeholder="Запиши все, що почув… Слухай скільки завгодно разів." ${phase === 'checked' ? 'disabled' : ''} style="margin-top:12px">${phase === 'checked' && res ? esc(res.typed) : ''}</textarea>
        <div class="row" style="margin-top:8px">
          ${phase === 'listen'
            ? '<button class="primary" id="check">Перевірити <kbd>Enter</kbd></button><button class="ghost" id="skip">Пропустити</button>'
            : '<button class="primary" id="next">Далі <kbd>Enter</kbd></button><button class="ghost" id="again">Ще раз цей фрагмент</button>'}
        </div>
        ${check}
      </div>
      <p class="muted small">Порада: пиши навіть те, у чому не впевнений. Розмовні форми зараховуються: «gonna» = «going to», «I'm» = «I am».</p>`;

    $('#play').addEventListener('click', play);
    $('#slow').addEventListener('change', (e) => { slow = e.target.checked; });
    $('#check')?.addEventListener('click', checkIt);
    $('#skip')?.addEventListener('click', () => next());
    $('#next')?.addEventListener('click', () => next());
    $('#again')?.addEventListener('click', () => { phase = 'listen'; selection = null; plays = 0; segStart = Date.now(); draw(); play(); });
    $$('[data-off]').forEach((b) => b.addEventListener('click', () => {
      d.offset = Math.round(((d.offset || 0) + Number(b.dataset.off)) * 100) / 100;
      save();
      draw();
      play();
    }));
    $$('[data-w]').forEach((w) => w.addEventListener('click', () => pick(Number(w.dataset.w))));
    if (phase === 'listen') $('#typed').focus();
    drawCardForm();
  }

  function pick(i) {
    if (!selection || selection[0] !== selection[1]) selection = [i, i];
    else selection = [Math.min(selection[0], i), Math.max(selection[0], i)];
    draw();
  }

  function drawCardForm() {
    const box = $('#card-form');
    if (!box || !selection) return;
    const s = seg();
    const phrase = s.text.split(/\s+/).slice(selection[0], selection[1] + 1).join(' ').replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
    box.innerHTML = `
      <form class="row card-mini" id="mini">
        <input type="text" id="c-en" value="${esc(phrase)}" style="flex:1;min-width:160px" aria-label="Фраза англійською">
        <input type="text" id="c-ua" placeholder="переклад українською" style="flex:1;min-width:160px" aria-label="Переклад">
        ${apiKey ? '<button type="button" id="c-tr" title="Перекласти за допомогою ШІ">✨</button>' : ''}
        <button type="submit" class="primary">+ у картки</button>
      </form>`;
    $('#c-ua').focus();
    $('#c-tr')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { $('#c-ua').value = await translatePhrase($('#c-en').value, s.text); } catch (err) { toast(err.message); }
      e.target.disabled = false;
    });
    $('#mini').addEventListener('submit', async (e) => {
      e.preventDefault();
      const en = $('#c-en').value.trim();
      const ua = $('#c-ua').value.trim();
      if (!en || !ua) { toast('Потрібні фраза й переклад'); return; }
      const reverse = await getSetting('reverseDefault', true);
      await put('cards', makeCard({ en, ua, context: s.text, tag: 'vocab', source: 'dictation', reverse }));
      selection = null;
      toast('Фразу додано в картки');
      draw();
    });
  }

  function checkIt() {
    if (phase !== 'listen') return;
    const typed = $('#typed').value.trim();
    if (!typed) { toast('Спершу запиши, що почув'); return; }
    const idx = order()[pos];
    const diff = compareDictation(d.segments[idx].text, typed);
    d.results[idx] = { typed, score: diff.score, missed: missedWords(diff), plays, ts: Date.now() };
    d.activeMs = (d.activeMs || 0) + Math.min(Date.now() - segStart, SEG_CAP_MS);
    phase = 'checked';
    save();
    draw();
  }

  function next() {
    if (phase === 'listen') d.activeMs = (d.activeMs || 0) + Math.min(Date.now() - segStart, SEG_CAP_MS);
    pos++;
    if (!only) d.pos = pos;
    save();
    phase = 'listen';
    selection = null;
    plays = 0;
    segStart = Date.now();
    draw();
    if (pos < order().length) play();
  }

  function drawSummary() {
    const acc = accuracy(d);
    const weak = d.segments.map((_, i) => i).filter((i) => !d.results[i] || d.results[i].score < GOOD);
    const miss = {};
    for (const r of Object.values(d.results)) for (const w of r.missed || []) miss[w] = (miss[w] || 0) + 1;
    const top = Object.entries(miss).sort((a, b) => b[1] - a[1]).slice(0, 12);
    $('#s-body').innerHTML = `
      <div class="card empty">
        <h2>Диктант завершено 🎧</h2>
        <p>${acc !== null ? `Середня точність: <strong>${pct(acc)}</strong> · ` : ''}фрагментів почуто на ${pct(GOOD)}+: ${d.segments.length - weak.length} з ${d.segments.length}</p>
        ${top.length ? `<p class="small muted">Найчастіше пропускав: ${top.map(([w, n]) => `<span class="tag">${esc(w)}${n > 1 ? ` ×${n}` : ''}</span>`).join(' ')}</p>` : ''}
        <div class="row" style="justify-content:center">
          ${weak.length ? `<button class="primary" id="redo">Повторити складні фрагменти (${weak.length})</button>` : ''}
          <button id="restart">Пройти весь диктант знову</button>
          <a class="btn" href="#/dictation">До списку</a>
        </div>
      </div>`;
    $('#redo')?.addEventListener('click', () => { only = weak; pos = 0; phase = 'listen'; plays = 0; segStart = Date.now(); draw(); play(); });
    $('#restart').addEventListener('click', () => { only = null; pos = 0; d.pos = 0; d.results = {}; save(); phase = 'listen'; plays = 0; segStart = Date.now(); draw(); play(); });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); play(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.target.closest?.('#mini')) {
      if (phase === 'listen' && e.target.id === 'typed') { e.preventDefault(); checkIt(); }
      else if (phase === 'checked') { e.preventDefault(); next(); }
    }
  }
  document.addEventListener('keydown', onKey);

  draw();

  return async () => {
    document.removeEventListener('keydown', onKey);
    player?.destroy();
    stopSpeaking();
    const delta = (d.activeMs || 0) - (d.loggedMs || 0);
    if (delta > 0) {
      d.loggedMs = d.activeMs;
      await put('dictations', d);
      await logMinutes('input', delta / 60000, 'dictation');
    }
  };
}
