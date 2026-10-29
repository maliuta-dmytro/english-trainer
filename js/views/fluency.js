import { getAll, get, put, del, getSetting, setSetting, uid } from '../db.js';
import { openMic, canRecord, beep, keepAwake, countWords, countFillers, fixDuration } from '../recorder.js';
import { createListener, canListen } from '../speech.js';
import { logMinutes } from '../stats.js';
import { esc, $, $$, toast } from '../ui.js';

// Знайомий матеріал — суть fluency-тренування: нового не вчимо, лише говоримо швидше.
const TOPICS = [
  'Describe your job and a typical workday.',
  'Tell the story of the best trip you have ever had.',
  'Describe your hometown: what should a visitor see there?',
  'Recommend a movie or a series and explain why.',
  'How did you start learning English, and what has worked for you?',
  'Talk about your plans for the trip to the USA.',
  'Tell about a difficult decision you made and how it turned out.',
  'Describe your favorite food and how to make it.',
  'Tell a funny or embarrassing story that happened to you.',
  'What did you do last weekend?',
  'Remote work or office: which do you prefer and why?',
  'Talk about a person who inspired you.',
  'Introduce yourself to a new coworker.',
  'Describe your morning routine.',
];

const MODES = {
  full: { label: '4 / 3 / 2 хв', rounds: [240, 180, 120] },
  short: { label: '2 / 1.5 / 1 хв (для короткого плану)', rounds: [120, 90, 60] },
};

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const wpm = (r) => (r.words && r.seconds >= 10 ? Math.round(r.words / (r.seconds / 60)) : null);

export async function render(root) {
  const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
  const s = id ? await get('fluency', id) : null;
  if (s) return renderResults(root, s);
  return renderPicker(root);
}

// ---------- Вибір теми й архів ----------

async function renderPicker(root) {
  const [list, convs, mode] = await Promise.all([getAll('fluency'), getAll('conversations'), getSetting('fluencyMode', 'full')]);
  list.sort((a, b) => b.created - a.created);
  const lastConv = convs.filter((c) => c.analysis).sort((a, b) => b.created - a.created)[0];
  const topics = lastConv ? [`Retell your recent conversation: ${lastConv.scenario.title}.`, ...TOPICS] : TOPICS;

  const r3 = list.map((x) => wpm(x.rounds[2] || {})).filter(Boolean).reverse(); // від старих до нових
  const avg = (a) => Math.round(a.reduce((s, x) => s + x, 0) / a.length);
  const trend = r3.length >= 4 ? `Темп 3-го раунду: перші сесії ≈ ${avg(r3.slice(0, 3))} сл/хв → останні ≈ ${avg(r3.slice(-3))} сл/хв.` : '';

  root.innerHTML = `
    <h1>Fluency 4/3/2</h1>
    <p class="muted">Розкажи ту саму історію тричі: за 4, потім за 3, потім за 2 хвилини. Нових слів не треба, лише говорити швидше й плавніше. Кожен раунд записується, і ти чуєш, як мовлення стає вільнішим.</p>
    ${canRecord() ? '' : '<div class="card notice">Цей браузер не підтримує запис звуку. Відкрий застосунок у Chrome або Edge.</div>'}

    <div class="card">
      <h2>Тема</h2>
      <p class="muted small" style="margin-top:-4px">Обери те, про що вже можеш говорити: свою історію, тему з розмови з ШІ чи диктанту.</p>
      <div class="topic-list">
        ${topics.map((t, i) => `<label class="topic"><input type="radio" name="topic" value="${esc(t)}" ${i === 0 ? 'checked' : ''}> ${esc(t)}</label>`).join('')}
        <label class="topic"><input type="radio" name="topic" value="__custom"> <input type="text" id="custom-topic" placeholder="Своя тема…" style="flex:1"></label>
      </div>
      <div class="row" style="margin-top:12px">
        <select id="mode" style="width:auto">${Object.entries(MODES).map(([k, m]) => `<option value="${k}"${k === mode ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
        <span class="spacer"></span>
        <button class="primary" id="go" ${canRecord() ? '' : 'disabled'}>🎙 Почати</button>
      </div>
      <p class="muted small" style="margin:10px 0 0">${canListen()
        ? 'Під час запису браузер також розпізнає мовлення, щоб порахувати слова за хвилину (потрібен інтернет).'
        : 'Підрахунок слів за хвилину доступний у Chrome та Edge; тут будуть лише записи.'}</p>
    </div>

    <h2>Архів</h2>
    <div class="card">
      ${trend ? `<p class="small" style="margin-top:0">📈 ${trend}</p>` : ''}
      ${list.length ? `<ul class="card-list">${list.map((x) => `
        <li>
          <div style="flex:1;min-width:0">
            <a href="#/fluency?id=${x.id}"><strong>${esc(x.topic)}</strong></a>
            <div class="meta">${new Date(x.created).toLocaleDateString('uk-UA')} · ${x.rounds.map((r) => wpm(r) ?? '—').join(' → ')} сл/хв</div>
          </div>
          <button class="ghost icon-btn danger" data-del="${x.id}" aria-label="Видалити">✕</button>
        </li>`).join('')}</ul>` : '<p class="muted" style="margin:0">Тут з\'являться твої записи.</p>'}
    </div>`;

  $('#custom-topic').addEventListener('focus', () => { $('input[value="__custom"]').checked = true; });
  $('#go').addEventListener('click', async () => {
    let topic = $('input[name=topic]:checked').value;
    if (topic === '__custom') topic = $('#custom-topic').value.trim();
    if (!topic) { toast('Напиши тему'); return; }
    const modeKey = $('#mode').value;
    await setSetting('fluencyMode', modeKey);
    runSession(root, topic, MODES[modeKey].rounds);
  });
  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const x = list.find((y) => y.id === b.dataset.del);
    if (!confirm('Видалити цю сесію разом із записами?')) return;
    for (const r of x.rounds) if (r.mediaId) await del('media', r.mediaId);
    await del('fluency', x.id);
    render(root);
  }));
}

// ---------- Три раунди ----------

function ring(fraction, warn) {
  const C = 2 * Math.PI * 54;
  return `<svg viewBox="0 0 120 120" class="ring${warn ? ' warn' : ''}" aria-hidden="true">
    <circle cx="60" cy="60" r="54" class="track"/>
    <circle cx="60" cy="60" r="54" class="fill" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - fraction)}"/>
  </svg>`;
}

async function runSession(root, topic, durations) {
  let mic;
  try {
    mic = await openMic();
  } catch (err) {
    toast(err.message);
    return;
  }
  const session = { id: uid(), created: Date.now(), topic, durations, rounds: [] };
  let round = 0;
  let timer = 0;
  let listener = null;
  let release = () => {};
  let finishing = false;

  // Якщо користувач піде зі сторінки посеред раунду — звільняємо мікрофон.
  const stopAll = () => {
    clearInterval(timer);
    listener?.abort();
    mic.release();
    release();
  };
  window.addEventListener('hashchange', stopAll, { once: true });

  function intro() {
    const prev = session.rounds[round - 1];
    root.innerHTML = `
      <a href="#/fluency" class="muted small">← Скасувати</a>
      <h1 style="margin-bottom:4px">Раунд ${round + 1} з 3 · ${fmtTime(durations[round])}</h1>
      <p class="topic-big">${esc(topic)}</p>
      <div class="card">
        ${round === 0
          ? `<p>Говори весь час, не зупиняйся на помилках: якщо забув слово, скажи інакше. Можеш спершу 20–30 секунд подумати, з чого почнеш.</p>`
          : `<p>Та сама історія, але тепер за <strong>${fmtTime(durations[round])}</strong>. Нічого суттєвого не викидай: просто говори щільніше й упевненіше.</p>
             ${prev?.url ? `<p class="small muted">Попередній раунд${wpm(prev) ? ` · ${wpm(prev)} сл/хв` : ''}:</p><audio controls src="${prev.url}" class="audio"></audio>` : ''}`}
        <div class="row" style="margin-top:12px"><button class="primary" id="start">🎙 Почати раунд ${round + 1}</button></div>
      </div>`;
    $$('audio', root).forEach(fixDuration);
    $('#start').addEventListener('click', start);
  }

  async function start() {
    release = await keepAwake();
    const total = durations[round];
    const t0 = performance.now();
    let words = 0;
    let finalText = '';
    finishing = false;

    root.innerHTML = `
      <h1 style="margin-bottom:4px">Раунд ${round + 1} з 3</h1>
      <p class="topic-big">${esc(topic)}</p>
      <div class="timer-wrap">
        <div class="timer" id="timer">${ring(1)}<div class="timer-text"><b id="left">${fmtTime(total)}</b><span class="rec">● запис</span></div></div>
        <div class="muted" id="live">${canListen() ? 'слів: 0' : ''}</div>
        <button id="done">Закінчив раніше</button>
      </div>`;

    mic.start();
    if (canListen()) {
      listener = createListener({
        onText: (f, interim) => {
          finalText = f;
          words = countWords(`${f} ${interim}`);
          const live = $('#live');
          if (live) live.textContent = `слів: ${words}`;
        },
        onStop: (text) => { finalText = text || finalText; },
        // Запис голосу триває й без розпізнавання — просто не буде підрахунку слів.
        onError: (msg) => { const live = $('#live'); if (live) live.textContent = `Підрахунок слів недоступний: ${msg}`; },
      });
      listener.start();
    }

    const finish = async () => {
      if (finishing) return;
      finishing = true;
      clearInterval(timer);
      const seconds = Math.min(total, (performance.now() - t0) / 1000);
      listener?.stop();
      const blob = await mic.stop();
      await new Promise((r) => setTimeout(r, 600)); // даємо розпізнавачу віддати останні слова
      release();
      beep();
      const mediaId = uid();
      if (blob) await put('media', { id: mediaId, blob });
      const transcript = finalText.trim();
      session.rounds.push({
        seconds: Math.round(seconds),
        mediaId: blob ? mediaId : null,
        transcript,
        words: canListen() ? countWords(transcript) : null,
        fillers: canListen() ? countFillers(transcript) : null,
        url: blob ? URL.createObjectURL(blob) : null,
      });
      await put('fluency', { ...session, rounds: session.rounds.map(({ url, ...r }) => r) });
      await logMinutes('fluency', seconds / 60, 'fluency');
      round++;
      if (round < durations.length) intro();
      else { mic.release(); location.hash = `#/fluency?id=${session.id}`; }
    };

    timer = setInterval(() => {
      const elapsed = (performance.now() - t0) / 1000;
      const left = Math.max(0, total - elapsed);
      const box = $('#timer');
      if (box) box.innerHTML = `${ring(left / total, left <= 15)}<div class="timer-text"><b>${fmtTime(Math.ceil(left))}</b><span class="rec">● запис</span></div>`;
      if (left <= 0) finish();
    }, 250);
    $('#done').addEventListener('click', finish);
  }

  intro();
}

// ---------- Результати ----------

async function renderResults(root, s) {
  const media = await Promise.all(s.rounds.map((r) => (r.mediaId ? get('media', r.mediaId) : null)));
  const urls = media.map((m) => (m ? URL.createObjectURL(m.blob) : null));
  const rates = s.rounds.map(wpm);
  const maxRate = Math.max(...rates.filter(Boolean), 1);
  const first = rates[0];
  const last = rates[rates.length - 1];
  const growth = first && last ? Math.round(((last - first) / first) * 100) : null;

  root.innerHTML = `
    <a href="#/fluency" class="muted small">← Fluency</a>
    <h1 style="margin-bottom:4px">${esc(s.topic)}</h1>
    <p class="muted small">${new Date(s.created).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' })}</p>

    ${growth !== null ? `<div class="card"><p style="margin:0">${growth > 0
      ? `📈 Темп зріс з <strong>${first}</strong> до <strong>${last}</strong> слів/хв (+${growth}%). Саме так працює 4/3/2: знайоме кажеш дедалі вільніше.`
      : `Темп: ${first} → ${last} слів/хв. Спробуй у наступних раундах не скорочувати історію, а говорити щільніше, з коротшими паузами.`}</p></div>` : ''}

    ${s.rounds.map((r, i) => `
      <div class="card">
        <div class="row">
          <h2 style="margin:0">Раунд ${i + 1}</h2>
          <span class="muted small">${fmtTime(r.seconds)} з ${fmtTime(s.durations[i])}</span>
          <span class="spacer"></span>
          ${rates[i] ? `<strong>${rates[i]} сл/хв</strong>` : ''}
        </div>
        ${rates[i] ? `<div class="wpm-bar"><div style="width:${(rates[i] / maxRate) * 100}%"></div></div>` : ''}
        ${urls[i] ? `<audio controls src="${urls[i]}" class="audio"></audio>` : '<p class="muted small">Запис недоступний (дані відновлено з бекапу).</p>'}
        ${r.words !== null ? `<p class="small muted" style="margin:6px 0 0">слів: ${r.words}${r.fillers ? ` · заповнювачів (um, uh, you know…): ${r.fillers}` : ''}</p>` : ''}
        ${r.transcript ? `<details class="small"><summary>Розпізнаний текст</summary><p>${esc(r.transcript)}</p></details>` : ''}
      </div>`).join('')}

    <div class="row">
      <a class="btn primary" href="#/fluency">Нова сесія</a>
      <a class="btn" href="#/">На головну</a>
    </div>
    <p class="muted small">Порада: переслухай перший і третій раунди підряд. Різницю в плавності чути одразу.</p>`;
  $$('audio', root).forEach(fixDuration);

  return () => urls.forEach((u) => u && URL.revokeObjectURL(u));
}
