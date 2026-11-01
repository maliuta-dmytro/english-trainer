import { getAll, get, put, del, getSetting, uid } from '../db.js';
import { transcribe, timecode, parseTimecode } from '../gemini.js';
import { hasKey, NO_KEY_HTML, costOf } from '../ai.js';
import { parseSubtitles } from '../dictation.js';
import { filePlayer, youtubePlayer, youtubeId } from '../player.js';
import {
  LENGTHS, MAX_MARKERS_SOFT, MAX_NEW_CARDS, CAUSE_LABELS, inRange, sentenceAt, speechRate,
  estimateDifficulty, difficultyWarning, analyzeRetell, cardProposals, saveResults,
} from '../retell.js';
import { wordCount } from '../coach.js';
import { logMinutes } from '../stats.js';
import { createListener, canListen, stopSpeaking } from '../speech.js';
import { resolveChannel, listVideos, fmtDuration } from '../youtube.js';
import { esc, $, $$, toast, tagLabel, plural } from '../ui.js';

const STEPS = [['listen', 'Слухання'], ['retell', 'Переказ'], ['feedback', 'Розбір'], ['cards', 'Картки']];
const RATES = [0.75, 0.85, 1, 1.25];
const VERDICT = { full: 'повне розуміння', partial: 'часткове розуміння', superficial: 'поверхове розуміння' };
const RETELL_CAP_MS = 15 * 60_000;

export async function render(root) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const r = params.get('id') ? await get('retells', params.get('id')) : null;
  if (r) return renderSession(root, r);
  if (params.get('channel')) return renderChannel(root, params.get('channel'));
  return renderList(root, params.get('video'));
}

// ---------- Мої канали ----------

const CHANNEL_TTL = 6 * 3600_000;   // список відео оновлюється сам, якщо кешу понад 6 годин
const DURATION_FILTERS = [
  ['short', 'до 20 хв', (s) => s <= 20 * 60],
  ['mid', '20–60 хв', (s) => s > 20 * 60 && s <= 3600],
  ['long', 'понад годину', (s) => s > 3600],
  ['all', 'усі', () => true],
];

function channelsBlock(channels, ytKey) {
  return `
    <div class="card">
      <h2>Мої канали</h2>
      ${ytKey ? '' : '<p class="small notice card" style="padding:10px 14px">Щоб гортати відео каналів, додай ключ YouTube Data API: <a href="#/settings">«⚙ Налаштування» → YouTube</a>.</p>'}
      ${channels.length ? `<div class="channels">${channels.map((c) => `
        <a class="channel" href="#/retell?channel=${c.id}">
          ${c.thumb ? `<img src="${esc(c.thumb)}" alt="" width="40" height="40" loading="lazy">` : '<span class="ch-ph">▶</span>'}
          <span><strong>${esc(c.title)}</strong><span class="muted small">${esc(c.handle || '')}</span></span>
        </a>`).join('')}</div>` : '<p class="muted small" style="margin-top:0">Додай улюблені канали (TED, подкасти, інтерв\'ю), щоб обирати відео з них без копіювання посилань.</p>'}
      <form class="row" id="add-ch" style="margin-top:12px">
        <input type="text" id="ch-url" placeholder="https://www.youtube.com/@TED" style="flex:1;min-width:200px" ${ytKey ? '' : 'disabled'}>
        <button type="submit" ${ytKey ? '' : 'disabled'}>+ Додати канал</button>
      </form>
    </div>`;
}

async function addChannel(input) {
  const ch = await resolveChannel(input);
  const existing = await get('channels', ch.id);
  if (existing) return existing;
  const row = { ...ch, added: Date.now(), videos: [], next: null, fetchedAt: 0 };
  await put('channels', row);
  return row;
}

async function renderChannel(root, id) {
  const ch = await get('channels', id);
  if (!ch) { location.hash = '#/retell'; return; }
  const used = new Set((await getAll('retells')).filter((r) => r.youtubeId).map((r) => r.youtubeId));
  let filter = (await getSetting('channelFilter', 'short'));
  let loading = false;

  const refresh = async (more = false) => {
    if (loading) return;
    loading = true;
    draw('Завантажую відео…');
    try {
      const { videos, next } = await listVideos(ch.uploads, more ? ch.next : '');
      const known = new Map(ch.videos.map((v) => [v.id, v]));
      videos.forEach((v) => known.set(v.id, v));
      ch.videos = [...known.values()].sort((a, b) => b.published.localeCompare(a.published));
      if (more || !ch.next) ch.next = next;
      ch.fetchedAt = Date.now();
      await put('channels', ch);
    } catch (err) {
      toast(err.message);
    }
    loading = false;
    draw();
  };

  function draw(status = '') {
    const test = DURATION_FILTERS.find(([k]) => k === filter)[2];
    // Shorts (до хвилини) для переказу не підходять — не показуємо.
    const all = ch.videos.filter((v) => v.duration > 60);
    const shown = all.filter((v) => test(v.duration));
    root.innerHTML = `
      <a href="#/retell" class="muted small">← Слухання</a>
      <div class="row" style="margin:6px 0 12px">
        ${ch.thumb ? `<img src="${esc(ch.thumb)}" alt="" width="48" height="48" class="ch-avatar">` : ''}
        <div style="flex:1;min-width:0"><h1 style="margin:0">${esc(ch.title)}</h1><span class="muted small">${esc(ch.handle || '')}</span></div>
        <button class="icon-btn" id="refresh" ${loading ? 'disabled' : ''}>⟳ Оновити</button>
        <button class="ghost icon-btn danger" id="remove" title="Прибрати канал" aria-label="Прибрати канал">✕</button>
      </div>
      <div class="seg" style="margin-bottom:14px">${DURATION_FILTERS.map(([k, label, fn]) => `
        <button type="button" class="icon-btn${k === filter ? ' primary' : ''}" data-f="${k}">${label} · ${all.filter((v) => fn(v.duration)).length}</button>`).join('')}</div>
      ${status ? `<p class="muted small">${esc(status)}</p>` : ''}
      ${shown.length ? `<div class="videos">${shown.map((v) => `
        <article class="video">
          <div class="thumb"><img src="${esc(v.thumb)}" alt="" loading="lazy"><span class="dur">${fmtDuration(v.duration)}</span></div>
          <div class="v-body">
            <div class="v-title">${esc(v.title)}</div>
            <div class="row small muted" style="gap:6px">
              <span>${new Date(v.published).toLocaleDateString('uk-UA')}</span>
              ${v.captions ? '<span class="tag">субтитри</span>' : ''}
              ${used.has(v.id) ? '<span class="tag on">використано</span>' : ''}
            </div>
            <a class="btn primary icon-btn" href="#/retell?video=${v.id}&ch=${ch.id}">🎧 Перекажи</a>
          </div>
        </article>`).join('')}</div>`
        : `<p class="muted">${all.length ? 'У цьому фільтрі відео немає. Спробуй інший або завантаж ще.' : loading ? '' : 'Відео ще не завантажено.'}</p>`}
      ${ch.next ? `<div class="row" style="justify-content:center;margin-top:16px"><button id="more" ${loading ? 'disabled' : ''}>Показати старіші відео</button></div>` : ''}`;

    $$('[data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; put('meta', { key: 'channelFilter', value: filter }); draw(); }));
    $('#refresh').addEventListener('click', () => refresh());
    $('#more')?.addEventListener('click', () => refresh(true));
    $('#remove').addEventListener('click', async () => {
      if (!confirm(`Прибрати канал «${ch.title}» зі списку?`)) return;
      await del('channels', ch.id);
      location.hash = '#/retell';
    });
  }

  draw();
  if (!ch.videos.length || Date.now() - ch.fetchedAt > CHANNEL_TTL) refresh();
}

// ---------- Список матеріалів і додавання ----------

const STATUS = { listen: 'слухання', retell: 'переказ', feedback: 'розбір', cards: 'картки', done: 'завершено' };

async function renderList(root, prefillVideo = null) {
  const [list, geminiKey, aiKey, channels, ytKey] = await Promise.all([
    getAll('retells'), getSetting('geminiKey', ''), hasKey(), getAll('channels'), getSetting('youtubeKey', ''),
  ]);
  list.sort((a, b) => b.created - a.created);
  channels.sort((a, b) => a.title.localeCompare(b.title));
  // Відео, обране на сторінці каналу: беремо назву й тривалість із кешу каналу.
  const picked = prefillVideo && channels.flatMap((c) => c.videos.map((v) => ({ ...v, channel: c.title }))).find((v) => v.id === prefillVideo);

  root.innerHTML = `
    <div class="row" style="margin-bottom:8px">
      <h1 style="margin:0">Слухай і перекажи</h1><span class="spacer"></span>
      <a class="btn" href="#/dictation">🎧 Диктант</a>
    </div>
    <p class="muted">Слухаєш 2–5 хвилин подкасту чи відео, позначаєш незрозумілі місця, переказуєш без транскрипту й отримуєш розбір: що зрозумів, що пропустив і як сказати краще. Нові слова й виправлення стають картками.</p>
    ${aiKey ? '' : `<div class="card notice">${NO_KEY_HTML}</div>`}

    ${prefillVideo ? '' : channelsBlock(channels, ytKey)}

    <form class="card${picked ? ' recommend' : ''}" id="new">
      <h2>${picked ? 'Обери фрагмент' : 'Новий матеріал'}</h2>
      ${picked ? `<div class="picked">
        <img src="${esc(picked.thumb)}" alt="" loading="lazy">
        <div><strong>${esc(picked.title)}</strong><div class="muted small">${esc(picked.channel)} · ${fmtDuration(picked.duration)}${picked.captions ? ' · є субтитри' : ''}</div>
        <div class="small" style="margin-top:4px">${picked.duration > 20 * 60 ? 'Довге відео: обери цікавий відрізок (наприклад, з середини розмови).' : 'Можна почати з початку.'}</div></div>
      </div>` : ''}
      <div class="seg" role="tablist" style="margin-bottom:14px">
        <label class="check seg-opt"><input type="radio" name="src" value="youtube" checked> ▶ YouTube</label>
        <label class="check seg-opt"><input type="radio" name="src" value="file"> 📁 Свій файл</label>
      </div>
      <div class="field" data-src="youtube"><label for="n-url">Посилання на публічне відео YouTube</label>
        <input type="text" id="n-url" placeholder="https://www.youtube.com/watch?v=…"></div>
      <div class="field" data-src="file" hidden><label for="n-file">Аудіо або відео (подкаст, епізод серіалу)</label>
        <input type="file" id="n-file" accept="audio/*,video/*"></div>

      <label>Транскрипт</label>
      <div class="seg" style="margin-bottom:10px">
        <label class="check seg-opt"><input type="radio" name="tr" value="gemini" checked> ✨ Автотранскрипція Gemini</label>
        <label class="check seg-opt"><input type="radio" name="tr" value="subs"> Субтитри .srt / .vtt</label>
      </div>
      <p class="muted small" data-tr="gemini">${geminiKey
        ? 'Gemini розпізнає мовлення обраного фрагмента з таймкодами (безкоштовний рівень).'
        : '<strong>Потрібен ключ Gemini</strong> («⚙ Налаштування» → «Штучний інтелект»), навіть якщо розбір робить Claude.'}</p>
      <div data-tr="subs" hidden>
        <div class="field"><input type="file" id="n-subs" accept=".srt,.vtt,text/plain"></div>
        <div class="field"><textarea id="n-subs-text" placeholder="…або встав субтитри сюди"></textarea></div>
      </div>

      <div class="row">
        <div><label for="n-start">Початок фрагмента</label><input type="text" id="n-start" value="0:00" style="width:110px" inputmode="numeric"></div>
        <div><label for="n-len">Тривалість</label>
          <select id="n-len" style="width:auto">${LENGTHS.map((m) => `<option value="${m}"${m === 3 ? ' selected' : ''}>${m} хв</option>`).join('')}</select></div>
        <div style="flex:1;min-width:180px"><label for="n-title">Назва</label><input type="text" id="n-title" placeholder="The Daily, епізод про…"></div>
      </div>
      <div class="row" style="margin-top:14px"><button type="submit" class="primary" id="n-go">Підготувати фрагмент</button><span class="muted small" id="n-status"></span></div>
    </form>

    <h2>Мої матеріали</h2>
    <div class="card">
      ${list.length ? `<ul class="card-list">${list.map((r) => `
        <li>
          <div style="flex:1;min-width:0">
            <a href="#/retell?id=${r.id}"><strong>${r.source === 'youtube' ? '▶' : '🎧'} ${esc(r.title)}</strong></a>
            <div class="meta">${new Date(r.created).toLocaleDateString('uk-UA')} · ${timecode(r.range.start)}–${timecode(r.range.end)}
              · <span class="tag">${STATUS[r.step] || r.step}</span>${r.feedback ? ` · розуміння ${r.feedback.comprehension.score}%` : ''}</div>
          </div>
          <button class="ghost icon-btn danger" data-del="${r.id}" aria-label="Видалити">✕</button>
        </li>`).join('')}</ul>` : '<p class="muted" style="margin:0">Тут з\'являться твої матеріали.</p>'}
    </div>`;

  const sync = () => {
    const src = $('input[name=src]:checked').value;
    const tr = $('input[name=tr]:checked').value;
    $$('[data-src]').forEach((el) => { el.hidden = el.dataset.src !== src; });
    $$('[data-tr]').forEach((el) => { el.hidden = el.dataset.tr !== tr; });
  };
  $$('input[name=src], input[name=tr]').forEach((i) => i.addEventListener('change', sync));
  if (picked || prefillVideo) {
    $('#n-url').value = `https://www.youtube.com/watch?v=${prefillVideo}`;
    if (picked) $('#n-title').value = picked.title;
    $('#n-start').focus();
    $('#n-start').select();
  }
  $('#add-ch')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button');
    btn.disabled = true;
    try {
      const ch = await addChannel($('#ch-url').value);
      location.hash = `#/retell?channel=${ch.id}`;
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
  $('#n-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f && !$('#n-title').value) $('#n-title').value = f.name.replace(/\.[^.]+$/, '');
  });

  $('#new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#n-go');
    const status = $('#n-status');
    const src = $('input[name=src]:checked').value;
    const tr = $('input[name=tr]:checked').value;
    const start = parseTimecode($('#n-start').value || '0');
    if (start === null) { toast('Початок вкажи у форматі хв:сек, наприклад 2:30'); return; }
    if (picked && start >= picked.duration - 30) { toast(`Відео триває ${fmtDuration(picked.duration)}: обери раніший початок`); return; }
    const end = Math.min(start + Number($('#n-len').value) * 60, picked?.duration || Infinity);
    const file = $('#n-file').files[0];
    const ytId = youtubeId($('#n-url').value);
    if (src === 'file' && !file) { toast('Обери аудіо- або відеофайл'); return; }
    if (src === 'youtube' && !ytId) { toast('Не схоже на посилання YouTube'); return; }
    if (tr === 'gemini' && !geminiKey) { toast('Для автотранскрипції потрібен ключ Gemini в налаштуваннях'); return; }

    btn.disabled = true;
    try {
      let segments;
      if (tr === 'subs') {
        const raw = $('#n-subs').files[0] ? await $('#n-subs').files[0].text() : $('#n-subs-text').value;
        if (!raw.includes('-->')) throw new Error('Потрібні субтитри з таймкодами (.srt або .vtt).');
        segments = parseSubtitles(raw);
      } else {
        status.textContent = 'Gemini розпізнає мовлення фрагмента… (зазвичай до хвилини)';
        segments = (await transcribe(src === 'youtube'
          ? { youtubeUrl: `https://www.youtube.com/watch?v=${ytId}`, start, end }
          : { blob: file, mime: file.type || 'audio/mpeg', start, end })).segments;
      }
      const segs = inRange(segments, start, end);
      if (!segs.length) throw new Error(`У проміжку ${timecode(start)}–${timecode(end)} немає тексту. Перевір час початку.`);

      const r = {
        id: uid(), created: Date.now(), step: 'listen',
        title: $('#n-title').value.trim() || (file ? file.name : `YouTube ${ytId}`),
        source: src, youtubeId: ytId || null, mediaId: null, isVideo: !!file?.type.startsWith('video'),
        transcriptSource: tr, segments, range: { start, end },
        level: await getSetting('talkLevel', 'B2'),
        difficulty: speechRate(segs), markers: [], usedSubtitles: false,
        retell: { mode: 'text', text: '' }, listenMs: 0, retellMs: 0, loggedMs: { input: 0, output: 0 }, usage: {},
      };
      if (file) {
        r.mediaId = uid();
        await put('media', { id: r.mediaId, blob: file });
      }
      if (await hasKey()) {
        status.textContent = 'Оцінюю складність…';
        try {
          const d = await estimateDifficulty(segs);
          r.difficulty = { ...r.difficulty, cefr: d.cefr, hardWords: d.hard_words, note: d.note };
        } catch { /* складність — не критично */ }
      }
      await put('retells', r);
      location.hash = `#/retell?id=${r.id}`;
    } catch (err) {
      toast(err.message);
      status.textContent = '';
      btn.disabled = false;
    }
  });

  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const r = list.find((x) => x.id === b.dataset.del);
    if (!confirm(`Видалити «${r.title}»?`)) return;
    if (r.mediaId) await del('media', r.mediaId);
    await del('retells', r.id);
    render(root);
  }));
}

// ---------- Сесія ----------

async function renderSession(root, r) {
  let player = null;
  let alive = true;
  let listener = null;
  let lastTick = performance.now();
  let retellStart = Date.now();
  let keyHandler = null; // гарячі клавіші поточного кроку
  const save = () => put('retells', r);
  const rel = (t) => timecode(Math.max(0, t - r.range.start));
  const segs = inRange(r.segments, r.range.start, r.range.end);

  async function makePlayer(onTime) {
    destroyPlayer();
    const range = { start: r.range.start, end: r.range.end, onTime };
    if (r.source === 'youtube') return youtubePlayer(r.youtubeId, range);
    const row = await get('media', r.mediaId);
    if (!row) throw new Error('Медіафайл не знайдено (дані відновлено з бекапу?). Додай матеріал заново.');
    return filePlayer(row.blob, { isVideo: r.isVideo, ...range });
  }
  function destroyPlayer() { player?.destroy(); player = null; }

  const stepper = () => `
    <ol class="stepper">${STEPS.map(([k, label], i) => {
      const idx = STEPS.findIndex(([s]) => s === r.step);
      const cls = r.step === 'done' || i < idx ? 'done' : i === idx ? 'current' : '';
      return `<li class="${cls}"><span>${i + 1}</span>${label}</li>`;
    }).join('')}</ol>`;

  const header = () => `
    <a href="#/retell" class="muted small">← Матеріали</a>
    <h1 style="margin:4px 0 6px">${r.source === 'youtube' ? '▶' : '🎧'} ${esc(r.title)}</h1>
    <p class="muted small">Фрагмент ${timecode(r.range.start)}–${timecode(r.range.end)}</p>
    ${stepper()}`;

  function go(step) {
    r.step = step;
    save();
    draw();
  }

  async function draw() {
    if (!alive) return;
    keyHandler = null;
    destroyPlayer();
    listener?.abort();
    window.scrollTo(0, 0);
    if (r.step === 'listen') return drawListen();
    if (r.step === 'retell') return drawRetell();
    if (r.step === 'feedback') return drawFeedback();
    if (r.step === 'cards') return drawCards();
    return drawDone();
  }

  // ---- Крок 1. Слухання ----
  async function drawListen() {
    const d = r.difficulty || {};
    const warn = difficultyWarning(d, r.level);
    root.innerHTML = `${header()}
      <div class="row small" style="margin-bottom:10px">
        ${d.cefr ? `<span class="tag">рівень ≈ ${d.cefr}</span>` : ''}
        ${d.wpm ? `<span class="tag">${d.wpm} слів/хв</span>` : ''}
        ${d.note ? `<span class="muted">${esc(d.note)}</span>` : ''}
      </div>
      ${warn ? `<div class="card notice small" style="padding:10px 14px">${esc(warn)}</div>` : ''}
      <div class="card">
        <div id="player-slot"></div>
        <div class="player-bar">
          <button class="primary icon-btn" id="pp" aria-label="Відтворити або пауза">▶</button>
          <button class="icon-btn" id="back5" title="Назад на 5 с (←)">⟲ 5с</button>
          <span class="seg">${RATES.map((x) => `<button type="button" class="icon-btn${x === 1 ? ' primary' : ''}" data-rate="${x}">${x}×</button>`).join('')}</span>
          <span class="spacer"></span>
          <span class="muted small" id="clock">0:00 / ${rel(r.range.end)}</span>
        </div>
        <div class="progress" style="margin:12px 0 0"><div id="prog" style="width:0%"></div></div>
        <div class="live-sub small" id="sub" hidden></div>
        <div class="row" style="margin-top:14px">
          <button class="mark-btn" id="mark">❓ Не зрозумів <kbd>M</kbd></button>
          <label class="check small" style="margin:0"><input type="checkbox" id="subs-toggle" ${r.usedSubtitles ? 'checked' : ''}> показувати субтитри (буде позначено в статистиці)</label>
        </div>
        <p class="muted small" style="margin:10px 0 0">Транскрипт прихований: слухай уважно, можна скільки завгодно разів. Клавіші: пробіл — пауза, ← — назад на 5 с, M — позначка.</p>
      </div>
      <div class="card">
        <h2>Позначки <span class="muted small" id="mcount"></span></h2>
        <div id="markers"></div>
      </div>
      <div class="row"><span class="spacer"></span><button class="primary" id="next">Далі: переказ →</button></div>`;

    const drawMarkers = () => {
      const box = $('#markers');
      if (!box) return;
      $('#mcount').textContent = r.markers.length ? `· ${r.markers.length}` : '';
      box.innerHTML = r.markers.length
        ? `${r.markers.length >= MAX_MARKERS_SOFT ? '<p class="small notice card" style="padding:8px 12px">Уже багато позначок. Можливо, краще взяти коротший фрагмент або простіший матеріал.</p>' : ''}
          <ul class="card-list compact">${r.markers.map((m, i) => `
            <li>
              <button class="icon-btn" data-replay="${i}" title="Переслухати">▶ ${rel(m.t)}</button>
              <input type="text" data-note="${i}" value="${esc(m.note || '')}" placeholder="що почув / слово (необов'язково)" style="flex:1;min-width:140px">
              <button class="ghost icon-btn danger" data-rm="${i}" aria-label="Видалити позначку">✕</button>
            </li>`).join('')}</ul>`
        : '<p class="muted small" style="margin:0">Натискай «Не зрозумів», щойно чуєш незнайоме слово чи місце, яке не розібрав. Транскрипт цих місць побачиш після переказу.</p>';
      $$('[data-replay]', box).forEach((b) => b.addEventListener('click', () => player?.playFrom(r.markers[b.dataset.replay].t - 3)));
      $$('[data-note]', box).forEach((inp) => inp.addEventListener('input', () => { r.markers[inp.dataset.note].note = inp.value; save(); }));
      $$('[data-rm]', box).forEach((b) => b.addEventListener('click', () => { r.markers.splice(Number(b.dataset.rm), 1); save(); drawMarkers(); }));
    };
    drawMarkers();

    try {
      player = await makePlayer((t) => {
        const now = performance.now();
        if (player?.playing()) r.listenMs += now - lastTick;
        lastTick = now;
        const clock = $('#clock');
        if (!clock) return;
        clock.textContent = `${rel(t)} / ${rel(r.range.end)}`;
        $('#prog').style.width = `${Math.min(100, ((t - r.range.start) / (r.range.end - r.range.start)) * 100)}%`;
        $('#pp').textContent = player?.playing() ? '⏸' : '▶';
        if (r.usedSubtitles) $('#sub').textContent = sentenceAt(segs, t);
      });
    } catch (err) {
      $('#player-slot').innerHTML = `<div class="notice card">${esc(err.message)}</div>`;
      return;
    }
    if (!alive) { destroyPlayer(); return; }
    $('#player-slot').appendChild(player.el);
    if (r.source === 'file' && !r.isVideo) player.el.classList.add('audio-only');

    const mark = () => {
      const t = player.time();
      r.markers.push({ t, sentence: sentenceAt(segs, t), note: '' });
      r.markers.sort((a, b) => a.t - b.t);
      save();
      drawMarkers();
      toast(`Позначено ${rel(t)}`);
    };
    $('#pp').addEventListener('click', () => player.toggle());
    $('#back5').addEventListener('click', () => player.back(5));
    $('#mark').addEventListener('click', mark);
    $$('[data-rate]').forEach((b) => b.addEventListener('click', () => {
      player.setRate(Number(b.dataset.rate));
      $$('[data-rate]').forEach((x) => x.classList.toggle('primary', x === b));
    }));
    $('#subs-toggle').addEventListener('change', (e) => {
      r.usedSubtitles = r.usedSubtitles || e.target.checked;
      $('#sub').hidden = !e.target.checked;
      save();
    });
    $('#sub').hidden = !$('#subs-toggle').checked;
    $('#next').addEventListener('click', () => {
      if (player.progress() < 0.8 && !confirm('Ти прослухав менше 80% фрагмента. Перейти до переказу?')) return;
      retellStart = Date.now();
      go('retell');
    });
    keyHandler = (e) => {
      if (e.target.closest?.('input, textarea, select')) return;
      if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); player.back(5); }
      else if (e.code === 'KeyM') { e.preventDefault(); mark(); }
    };
  }

  // ---- Крок 2. Переказ ----
  function drawRetell() {
    const micOk = canListen();
    root.innerHTML = `${header()}
      <div class="card">
        <h2>Перекажи почуте англійською</h2>
        <p class="muted small">Транскрипт і позначки зараз недоступні: так мозок по-справжньому пропрацьовує матеріал. Рекомендовано 80–200 слів або 1–3 хвилини голосом.</p>
        <details class="small" style="margin-bottom:10px"><summary>Підказка-структура</summary>
          <p>Про що була розмова? Хто говорив? Які 2–3 головні думки? Яка деталь запам'яталась найбільше?</p></details>
        ${micOk ? `<div class="mic-row"><button type="button" class="mic" id="mic" aria-label="Переказати голосом">🎙</button>
          <span class="muted small" id="mic-state">Натисни й переказуй голосом, натисни ще раз, щоб закінчити. Або просто пиши нижче.</span></div>` : ''}
        <textarea id="retell" rows="9" placeholder="The speakers were talking about…">${esc(r.retell.text)}</textarea>
        <div class="row" style="margin-top:8px">
          <span class="muted small" id="wc"></span><span class="spacer"></span>
          <button class="primary" id="analyze">Отримати розбір</button>
        </div>
      </div>`;
    const ta = $('#retell');
    const wc = () => {
      const n = wordCount(ta.value);
      $('#wc').textContent = `${n} слів${n && n < 50 ? ' · спробуй розповісти детальніше' : ''}`;
    };
    wc();
    ta.addEventListener('input', () => { r.retell.text = ta.value; wc(); save(); });
    ta.focus();

    const mic = $('#mic');
    mic?.addEventListener('click', () => {
      if (listener?.listening) { listener.stop(); return; }
      const before = ta.value.trim();
      listener = createListener({
        onText: (f, interim) => { ta.value = [before, f, interim].filter(Boolean).join(' '); wc(); },
        onStop: (text) => {
          mic.classList.remove('listening');
          $('#mic-state').textContent = text ? 'Готово. Можеш доповнити голосом або виправити текст.' : 'Нічого не почуто. Спробуй ще раз.';
          if (text) {
            ta.value = [before, text].filter(Boolean).join(' ');
            r.retell = { mode: 'voice', text: ta.value };
            save();
            wc();
          }
        },
        onError: (msg) => { mic.classList.remove('listening'); $('#mic-state').textContent = msg; },
      });
      listener.start();
      mic.classList.add('listening');
      $('#mic-state').textContent = 'Слухаю… натисни ще раз, коли закінчиш.';
    });

    $('#analyze').addEventListener('click', async () => {
      const text = ta.value.trim();
      if (wordCount(text) < 15) { toast('Перекажи хоча б кілька речень (15+ слів)'); return; }
      if (!(await hasKey())) { toast('Для розбору потрібен ключ ШІ в налаштуваннях'); return; }
      listener?.abort();
      r.retell.text = text;
      r.retellMs += Math.min(Date.now() - retellStart, RETELL_CAP_MS);
      const btn = $('#analyze');
      btn.disabled = true;
      btn.textContent = 'Аналізую переказ…';
      try {
        const { data, usage, model } = await analyzeRetell(r);
        r.feedback = data;
        r.model = model;
        for (const k of Object.keys(usage)) r.usage[k] = (r.usage[k] || 0) + (usage[k] || 0);
        r.userWords = wordCount(text);
        go('feedback');
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = 'Отримати розбір';
      }
    });
  }

  // ---- Крок 3. Розбір ----
  async function drawFeedback() {
    const f = r.feedback;
    const c = f.comprehension;
    const top = f.errors.filter((e) => e.top);
    const rest = f.errors.length - top.length;
    const tBtn = (time) => {
      const t = parseTimecode(time);
      return t === null ? '' : `<button class="icon-btn" data-at="${t}" title="Переслухати">▶ ${rel(t)}</button>`;
    };
    root.innerHTML = `${header()}
      <div class="card score-card">
        <div class="score">${c.score}<span>%</span></div>
        <div style="flex:1;min-width:200px">
          <strong>${VERDICT[c.verdict] || ''}</strong>${r.usedSubtitles ? ' <span class="tag">із субтитрами</span>' : ''}
          <p style="margin:4px 0 0">${esc(c.summary)}</p>
        </div>
      </div>
      <div id="player-slot" class="mini-player"></div>

      <div class="card">
        <h2>Зміст</h2>
        ${f.correct.length ? `<h3>✅ Передано правильно</h3><ul class="points">${f.correct.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
        ${f.inaccurate.length ? `<h3>⚠️ Неточно</h3><ul class="points">${f.inaccurate.map((p) => `
          <li><div>${esc(p.point)}</div><div class="quote">«${esc(p.quote)}» ${tBtn(p.time)}</div></li>`).join('')}</ul>` : ''}
        ${f.missed.length ? `<h3>❌ Пропущено</h3><ul class="points">${f.missed.map((p) => `<li>${esc(p.point)} ${tBtn(p.time)}</li>`).join('')}</ul>` : ''}
      </div>

      <div class="card">
        <h2>Мова</h2>
        ${f.strengths.length ? `<p class="small"><strong>Добре вийшло:</strong> ${f.strengths.map(esc).join(' · ')}</p>` : ''}
        ${top.length ? `<h3>Головне для покращення</h3><ul class="fix-list">${top.map((e, i) => `
          <li>
            <div class="was soft">${esc(e.original)}</div>
            <div class="small">💡 ${esc(e.hint)}</div>
            <div class="reveal" data-reveal="${i}" hidden>
              <div class="now">${esc(e.corrected)}</div>
              <div class="small muted">${esc(e.explanation)} <span class="tag">${esc(tagLabel(e.category))}</span></div>
            </div>
            <button class="icon-btn" data-show="${i}">Спершу спробуй виправити подумки, потім — показати</button>
          </li>`).join('')}</ul>` : '<p class="muted">Суттєвих помилок не знайдено. Чудово!</p>'}
        ${rest > 0 ? `<p class="muted small">Ще ${plural(rest, ['дрібніша помилка', 'дрібніші помилки', 'дрібніших помилок'])} — у журналі помилок.</p>` : ''}
        ${f.natural.length ? `<h3>Як сказав би носій</h3><ul class="fix-list">${f.natural.map((n) => `
          <li><div class="was soft">${esc(n.original)}</div><div class="now">${esc(n.natural)}</div><div class="small muted">${esc(n.note)}</div></li>`).join('')}</ul>` : ''}
        ${f.useful_phrases.length ? `<h3>Корисні фрази з оригіналу</h3><ul class="card-list compact">${f.useful_phrases.map((p) => `
          <li><div style="flex:1;min-width:0"><div class="en">${esc(p.en)}</div><div class="muted small">${esc(p.ua)}</div></div>${tBtn(p.time)}</li>`).join('')}</ul>` : ''}
      </div>

      ${f.markers.length ? `<div class="card">
        <h2>Твої позначки</h2>
        <ul class="card-list compact">${f.markers.map((m) => {
          const src = r.markers[m.index];
          return `<li><div style="flex:1;min-width:0"><div class="en">${esc(m.phrase)} <span class="tag">${CAUSE_LABELS[m.cause] || ''}</span></div>
            <div class="muted small">${esc(m.meaning)}</div>${src ? `<div class="small quote">«${esc(src.sentence)}»</div>` : ''}</div>
            ${src ? tBtn(timecode(src.t)) : ''}</li>`;
        }).join('')}</ul></div>` : ''}

      <details class="card"><summary>Транскрипт фрагмента</summary>
        <div class="transcript">${segs.map((s) => `<p><button class="icon-btn" data-at="${s.start}">${rel(s.start)}</button> ${esc(s.text)}</p>`).join('')}</div>
      </details>
      <div class="row"><span class="muted small">Вартість розбору ≈ $${costOf(r.usage, r.model).toFixed(3)}</span><span class="spacer"></span><button class="primary" id="next">Далі: картки →</button></div>`;

    $$('[data-show]').forEach((b) => b.addEventListener('click', () => {
      $(`[data-reveal="${b.dataset.show}"]`).hidden = false;
      b.remove();
    }));
    $('#next').addEventListener('click', () => go('cards'));
    try {
      player = await makePlayer();
      if (!alive) { destroyPlayer(); return; }
      $('#player-slot').appendChild(player.el);
      if (r.source === 'file' && !r.isVideo) player.el.classList.add('audio-only');
      $$('[data-at]').forEach((b) => b.addEventListener('click', () => player.playFrom(Number(b.dataset.at) - 1)));
    } catch {
      $$('[data-at]').forEach((b) => { b.disabled = true; });
    }
  }

  // ---- Крок 4. Картки ----
  async function drawCards() {
    const proposals = cardProposals(r);
    const known = new Set((await getAll('cards')).map((c) => c.en.trim().toLowerCase()));
    const fresh = proposals.filter((p) => !known.has(p.en.trim().toLowerCase()));
    const KIND = { marker: 'позначене слово', error: 'виправлення', natural: 'природніше', phrase: 'з оригіналу' };
    root.innerHTML = `${header()}
      <div class="card">
        <h2>Картки з цієї сесії</h2>
        <p class="muted small">Обрано перші ${Math.min(MAX_NEW_CARDS, fresh.length)} з ${fresh.length}. Зайве зніми, переклад можна виправити.${proposals.length > fresh.length ? ` ${proposals.length - fresh.length} фраз уже є в картках.` : ''}</p>
        ${fresh.length ? `<ul class="card-list proposals">${fresh.map((p, i) => `
          <li>
            <input type="checkbox" data-pick="${i}" ${i < MAX_NEW_CARDS ? 'checked' : ''} aria-label="Додати картку">
            <div style="flex:1;min-width:0;display:grid;gap:6px">
              <div class="row" style="gap:6px"><span class="tag">${KIND[p.kind]}</span></div>
              <input type="text" data-en="${i}" value="${esc(p.en)}" aria-label="Англійською">
              <input type="text" data-ua="${i}" value="${esc(p.ua)}" aria-label="Українською">
            </div>
          </li>`).join('')}</ul>` : '<p class="muted">Нових карток немає: усе вже у твоїх картках.</p>'}
        <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="primary" id="save">Зберегти й завершити</button></div>
      </div>`;
    $('#save').addEventListener('click', async () => {
      const chosen = fresh
        .map((p, i) => ({ ...p, en: $(`[data-en="${i}"]`).value.trim(), ua: $(`[data-ua="${i}"]`).value.trim() }))
        .filter((_, i) => $(`[data-pick="${i}"]`).checked);
      r.cardsCreated = await saveResults(r, chosen);
      r.completed = Date.now();
      toast(`Збережено карток: ${r.cardsCreated}. Помилки — у журналі.`);
      go('done');
    });
  }

  // ---- Готово ----
  function drawDone() {
    const f = r.feedback;
    root.innerHTML = `${header()}
      <div class="card empty">
        <h2>Сесію завершено 🎉</h2>
        <p>Розуміння: <strong>${f?.comprehension.score ?? '—'}%</strong> · позначок: ${r.markers.length} · нових карток: ${r.cardsCreated ?? 0}
          · слухав ${Math.max(1, Math.round(r.listenMs / 60000))} хв</p>
        <p class="muted small">За 1–2 дні спробуй переказати цей матеріал ще раз: повторний переказ закріплює нові фрази й робить мовлення плавнішим.</p>
        <div class="row" style="justify-content:center">
          <a class="btn primary" href="#/review">Повторити картки</a>
          <button id="again">Переглянути розбір</button>
          <a class="btn" href="#/retell">Новий матеріал</a>
        </div>
      </div>`;
    $('#again').addEventListener('click', () => { r.step = 'feedback'; draw(); });
  }

  const onKey = (e) => keyHandler?.(e);
  document.addEventListener('keydown', onKey);
  await draw();

  return async () => {
    alive = false;
    document.removeEventListener('keydown', onKey);
    listener?.abort();
    destroyPlayer();
    stopSpeaking();
    // Облік часу: слухання → input, переказ → output (лише приріст з минулого разу).
    const inMin = (r.listenMs - (r.loggedMs?.input || 0)) / 60000;
    const outMin = (r.retellMs - (r.loggedMs?.output || 0)) / 60000;
    r.loggedMs = { input: r.listenMs, output: r.retellMs };
    await put('retells', r);
    await logMinutes('input', inMin, 'retell');
    await logMinutes('output', outMin, 'retell');
  };
}
