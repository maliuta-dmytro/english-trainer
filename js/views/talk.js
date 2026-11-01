import { getAll, get, put, getSetting, setSetting, uid } from '../db.js';
import { streamReply, structured, costOf, hasKey, currentModel, NO_KEY_HTML } from '../ai.js';
import { SCENARIOS, GROUPS, LEVELS, customScenario } from '../scenarios.js';
import {
  systemPrompt, START_MESSAGE, ANALYSIS_SYSTEM, ANALYSIS_SCHEMA,
  transcriptForAnalysis, wordCount, applyAnalysis, focusTopics,
} from '../coach.js';
import { logMinutes, makeCard } from '../stats.js';
import {
  speak, canSpeak, canListen, createSpeaker, createListener, stopSpeaking, getRate, setRate,
} from '../speech.js';
import { esc, $, $$, toast, tagLabel } from '../ui.js';

const IDLE_CAP_MS = 3 * 60_000; // паузи довші за 3 хв не зараховуємо як практику
const analyzing = new Set(); // id розмов, розбір яких виконується просто зараз

export async function render(root) {
  const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
  const conv = id ? await get('conversations', id) : null;
  if (conv) return renderConversation(root, conv);
  return renderPicker(root);
}

// ---------- Вибір сценарію та історія ----------

async function renderPicker(root) {
  const [apiKey, level, hints, model, focus, history] = await Promise.all([
    hasKey(), getSetting('talkLevel', 'B2'), getSetting('talkHints', true),
    currentModel(), focusTopics(), getAll('conversations'),
  ]);
  history.sort((a, b) => b.created - a.created);
  const modelLabel = model.label.split(' — ')[0];

  root.innerHTML = `
    <h1>Розмова з ШІ</h1>
    ${apiKey ? '' : `<div class="card notice">${NO_KEY_HTML}</div>`}

    <div class="card">
      <div class="row">
        <div><label for="t-level">Складність мовлення</label>
          <select id="t-level">${LEVELS.map(([k, v]) => `<option value="${k}"${k === level ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
        <label class="check" style="margin-top:18px"><input type="checkbox" id="t-hints" ${hints ? 'checked' : ''}> Підказки для самовиправлення під час розмови</label>
      </div>
      <p class="muted small" style="margin:10px 0 0">Модель: ${esc(modelLabel)} (<a href="#/settings">змінити</a>).
        ${focus.length ? `Фокус із журналу помилок: <strong>${esc(focus.map(tagLabel).join(', '))}</strong>. Співрозмовник частіше створюватиме ситуації для цих тем.` : ''}</p>
    </div>

    <div class="modules" style="margin-bottom:16px">
      <a class="card module" href="#/trip" style="margin:0"><strong>🧳 Подорож до США</strong>
        <div class="muted small">11 туристичних ситуацій з розмовником, порадами й режимом «зі складністю».</div></a>
      <a class="card module" href="#/fluency" style="margin:0"><strong>⏱ Fluency 4/3/2</strong>
        <div class="muted small">Без ШІ: розкажи знайому історію тричі, щоразу швидше. Тренує плавність.</div></a>
    </div>

    ${GROUPS.map(([g, title]) => `
      <h2>${esc(title)}</h2>
      <div class="modules" style="margin-bottom:18px">
        ${SCENARIOS.filter((s) => s.group === g).map((s) => `
          <button class="module scenario" data-scenario="${s.id}">
            <strong>${s.icon} ${esc(s.title)}</strong>
            <div class="muted small">${esc(s.goal)}</div>
          </button>`).join('')}
      </div>`).join('')}

    <div class="card">
      <h2>Свій сценарій</h2>
      <textarea id="t-custom" placeholder="Напр.: You are my new American coworker. We're having lunch and you ask me about Ukraine and my hobbies."></textarea>
      <div class="row" style="margin-top:8px"><button id="t-custom-go">Почати</button></div>
    </div>

    <h2>Історія</h2>
    <div class="card">
      ${history.length ? `<ul class="card-list">${history.slice(0, 20).map((c) => `
        <li>
          <div style="flex:1;min-width:0">
            <a href="#/talk?id=${c.id}"><strong>${c.scenario.icon} ${esc(c.scenario.title)}</strong></a>
            <div class="meta">${new Date(c.created).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' })}
              · реплік: ${c.messages.filter((m) => m.role === 'user' && !m.hidden).length}
              ${c.analysis ? ` · помилок: ${c.analysis.errors.length}` : c.status === 'active' ? ' · <span class="tag">не завершена</span>' : ''}
              · ≈ $${costOf(c.usage, c.model).toFixed(3)}</div>
          </div>
        </li>`).join('')}</ul>` : '<p class="muted" style="margin:0">Тут з\'являться твої розмови та їхні розбори.</p>'}
    </div>`;

  $('#t-level').addEventListener('change', (e) => setSetting('talkLevel', e.target.value));
  $('#t-hints').addEventListener('change', (e) => setSetting('talkHints', e.target.checked));

  const start = (scenario) => startConversation(scenario, { level: $('#t-level').value, hints: $('#t-hints').checked });
  $$('[data-scenario]').forEach((b) => b.addEventListener('click', () => start(SCENARIOS.find((s) => s.id === b.dataset.scenario))));
  $('#t-custom-go').addEventListener('click', () => {
    const text = $('#t-custom').value.trim();
    if (text.length < 10) { toast('Опиши ситуацію трохи детальніше'); return; }
    start(customScenario(text));
  });
}

/**
 * Створює розмову й відкриває її. Використовується й туристичним режимом.
 * twist — співрозмовник посеред сцени підкидає реалістичну проблему.
 */
export async function startConversation(scenario, { level, hints, twist = false, trip = null } = {}) {
  const conv = {
    id: uid(),
    created: Date.now(),
    scenario,
    level: level ?? await getSetting('talkLevel', 'B2'),
    hints: hints ?? await getSetting('talkHints', true),
    twist,
    trip,
    focus: await focusTopics(),
    model: (await currentModel()).id,
    status: 'active',
    messages: [{ role: 'user', text: START_MESSAGE, hidden: true }],
    usage: {},
    activeMs: 0,
    loggedMs: 0,
  };
  await put('conversations', conv);
  location.hash = `#/talk?id=${conv.id}`;
}

// ---------- Розмова ----------

function addUsage(total, u) {
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    total[k] = (total[k] || 0) + (u?.[k] || 0);
  }
}

// Репліка ШІ: рядки з «💡» показуємо окремо як підказку.
function splitHint(text) {
  const lines = text.split('\n');
  const hint = lines.filter((l) => l.trim().startsWith('💡')).join(' ').trim();
  const speech = lines.filter((l) => !l.trim().startsWith('💡')).join('\n').trim();
  return { speech, hint };
}

const RATES = [[0.8, '0.8×'], [1, '1×'], [1.15, '1.15×']];

function bubble(m, i, concealed) {
  if (m.role === 'user') return `<div class="msg user">${m.voice ? '<span class="voice-mark" title="Сказано голосом">🎙</span> ' : ''}${esc(m.text)}</div>`;
  const { speech, hint } = splitHint(m.text);
  const controls = canSpeak()
    ? ` <button class="ghost icon-btn say" data-say="${i}" aria-label="Озвучити">🔊</button><button class="ghost icon-btn say" data-say-slow="${i}" aria-label="Озвучити повільно">🐢</button>`
    : '';
  return `
    <div class="msg ai${concealed ? ' concealed' : ''}" ${concealed ? `data-reveal="${i}" title="Натисни, щоб показати текст"` : ''}>
      <span class="msg-text">${esc(speech)}</span>${controls}
      ${concealed ? '<div class="reveal-hint small">👂 Спершу послухай · натисни, щоб показати текст</div>' : ''}
    </div>
    ${hint ? `<div class="msg hint">${esc(hint)}</div>` : ''}`;
}

async function renderConversation(root, conv) {
  const prefs = {
    voice: await getSetting('voiceMode', false),
    autoSend: await getSetting('voiceAutoSend', true),
    conceal: await getSetting('hideAiText', false),
  };
  const revealed = new Set();
  const visible = () => conv.messages
    .map((m, i) => (m.hidden ? '' : bubble(m, i, prefs.conceal && m.role === 'assistant' && !revealed.has(i))))
    .join('');
  let controller = null;
  let speaker = null;
  let listener = null;
  let busy = false;
  let lastActivity = Date.now();
  let alive = true;

  const save = () => put('conversations', conv);
  // Розбір обірвався (закрили вкладку) — пропонуємо повторити.
  if (conv.status === 'analyzing' && !analyzing.has(conv.id)) conv.status = 'ended';

  function drawShell() {
    root.innerHTML = `
      <div class="row" style="margin-bottom:6px">
        <a href="#/talk" class="muted small">← Сценарії</a>
        <span class="spacer"></span>
        <span class="tag">${esc(conv.level)}</span>
      </div>
      <h1 style="margin-bottom:4px">${conv.scenario.icon} ${esc(conv.scenario.title)}${conv.twist ? ' <span class="tag">⚡ зі складністю</span>' : ''}</h1>
      ${conv.scenario.id !== 'custom' ? `<p class="muted small">Завдання: ${esc(conv.scenario.goal)}</p>` : ''}
      <div id="voicebar"></div>
      <div id="chat" class="chat"></div>
      <div id="bottom"></div>`;
    drawVoicebar();
    drawChat();
    drawBottom();
  }

  function drawVoicebar() {
    const bar = $('#voicebar', root);
    if (!bar || conv.status === 'done') { if (bar) bar.innerHTML = ''; return; }
    bar.innerHTML = `
      <div class="voicebar">
        <label class="check"><input type="checkbox" id="v-on" ${prefs.voice ? 'checked' : ''}> 🎙 Голосовий режим</label>
        ${prefs.voice ? `
          <span class="seg" role="group" aria-label="Темп мовлення">
            ${RATES.map(([r, l]) => `<button class="icon-btn${Math.abs(getRate() - r) < 0.01 ? ' primary' : ''}" data-rate="${r}">${l}</button>`).join('')}
          </span>
          <label class="check"><input type="checkbox" id="v-auto" ${prefs.autoSend ? 'checked' : ''}> надсилати одразу</label>` : ''}
        <label class="check"><input type="checkbox" id="v-conceal" ${prefs.conceal ? 'checked' : ''}> 👂 ховати текст ШІ</label>
      </div>
      ${prefs.voice && !canListen() ? '<p class="small notice card" style="padding:10px 14px">Розпізнавання мовлення в цьому браузері недоступне: відповіді ШІ озвучуватимуться, а свої репліки пиши текстом. Для голосу відкрий застосунок у Chrome або Edge.</p>' : ''}`;

    $('#v-on', bar).addEventListener('change', async (e) => {
      prefs.voice = e.target.checked;
      await setSetting('voiceMode', prefs.voice);
      if (!prefs.voice) { stopSpeaking(); listener?.abort(); listener = null; }
      drawVoicebar();
      drawBottom();
    });
    $('#v-auto', bar)?.addEventListener('change', (e) => { prefs.autoSend = e.target.checked; setSetting('voiceAutoSend', prefs.autoSend); });
    $('#v-conceal', bar).addEventListener('change', (e) => {
      prefs.conceal = e.target.checked;
      setSetting('hideAiText', prefs.conceal);
      drawChat();
    });
    $$('[data-rate]', bar).forEach((b) => b.addEventListener('click', () => {
      setRate(Number(b.dataset.rate));
      setSetting('ttsRate', getRate());
      drawVoicebar();
    }));
  }

  function drawChat(streamText = null) {
    const chat = $('#chat', root);
    if (!chat) return;
    let html = visible();
    if (streamText !== null) {
      html += prefs.conceal
        ? '<div class="msg ai concealed"><span class="typing">👂 слухай…</span></div>'
        : `<div class="msg ai">${esc(streamText) || '<span class="typing">···</span>'}</div>`;
    }
    chat.innerHTML = html;
    const speechOf = (i) => splitHint(conv.messages[i].text).speech;
    $$('[data-say]', chat).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); speak(speechOf(b.dataset.say)); }));
    $$('[data-say-slow]', chat).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); speak(speechOf(b.dataset.saySlow), 0.75); }));
    $$('[data-reveal]', chat).forEach((el) => el.addEventListener('click', () => {
      revealed.add(Number(el.dataset.reveal));
      drawChat();
    }));
    chat.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  function drawBottom(error = null) {
    const bottom = $('#bottom', root);
    if (!bottom) return;
    if (conv.status === 'done') { drawVoicebar(); drawAnalysis(bottom); return; }
    if (conv.status === 'analyzing') {
      bottom.innerHTML = '<div class="card empty"><p>Розбираю розмову: помилки, природніші варіанти, корисні фрази…</p><span class="typing">···</span></div>';
      return;
    }
    const userTurns = conv.messages.filter((m) => m.role === 'user' && !m.hidden).length;
    const micOn = prefs.voice && canListen();
    bottom.innerHTML = `
      ${error ? `<div class="card notice error">${esc(error.message)} <button id="retry" class="icon-btn">Повторити</button></div>` : ''}
      ${conv.status === 'ended'
        ? `<div class="card empty"><p>Розмову завершено, але розбір не вдався.</p><button class="primary" id="analyze">Зробити розбір ще раз</button></div>`
        : `<form id="composer" class="composer">
            ${micOn ? `<div class="mic-row">
              <button type="button" id="mic" class="mic" ${busy ? 'disabled' : ''} aria-label="Говорити">🎙</button>
              <span class="muted small" id="mic-state">${busy ? 'Співрозмовник відповідає…' : 'Натисни й говори англійською; натисни ще раз, коли закінчиш. Пробіл (поза полем вводу) теж працює.'}</span>
            </div>` : ''}
            <textarea id="input" rows="2" placeholder="${micOn ? 'Тут з\'явиться розпізнаний текст. Його можна виправити перед надсиланням.' : 'Пиши англійською… (Enter — надіслати, Shift+Enter — новий рядок)'}" ${busy ? 'disabled' : ''}></textarea>
            <div class="row">
              <span class="muted small">${userTurns ? `Реплік: ${userTurns}` : 'Порада: відповідай повними реченнями, навіть якщо можна коротко.'}</span>
              <span class="spacer"></span>
              <button type="button" id="finish" ${userTurns && !busy ? '' : 'disabled'}>Завершити й розібрати</button>
              <button type="submit" class="primary" ${busy ? 'disabled' : ''}>Надіслати</button>
            </div>
          </form>`}`;

    $('#retry', bottom)?.addEventListener('click', () => (conv.status === 'ended' ? analyze() : reply()));
    $('#analyze', bottom)?.addEventListener('click', analyze);
    const form = $('#composer', bottom);
    if (!form) return;
    const input = $('#input', bottom);
    let spoken = false; // чи текст у полі прийшов із мікрофона
    if (!busy && !micOn) input.focus();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || busy) return;
      listener?.abort();
      const now = Date.now();
      conv.activeMs += Math.min(now - lastActivity, IDLE_CAP_MS);
      lastActivity = now;
      conv.messages.push(spoken ? { role: 'user', text, voice: true } : { role: 'user', text });
      save();
      reply();
    });
    $('#finish', bottom).addEventListener('click', analyze);

    const mic = $('#mic', bottom);
    if (!mic) return;
    const state = $('#mic-state', bottom);
    const toggle = () => {
      if (busy) return;
      if (listener?.listening) { listener.stop(); return; }
      listener = createListener({
        onText: (finalText, interim) => {
          input.value = [finalText, interim].filter(Boolean).join(' ');
          spoken = true;
        },
        onStop: (text) => {
          mic.classList.remove('listening');
          state.textContent = text ? (prefs.autoSend ? 'Надсилаю…' : 'Перевір текст і натисни «Надіслати».') : 'Нічого не почуто. Спробуй ще раз.';
          if (text) {
            input.value = text;
            spoken = true;
            if (prefs.autoSend) form.requestSubmit();
          }
        },
        onError: (msg) => {
          mic.classList.remove('listening');
          state.textContent = msg;
        },
      });
      input.value = '';
      listener.start();
      mic.classList.add('listening');
      state.textContent = 'Слухаю… натисни ще раз, коли закінчиш.';
    };
    mic.addEventListener('click', toggle);
    // Пробіл поза полем вводу — швидкий старт/стоп мікрофона.
    bottom.ownerDocument.onkeydown = (e) => {
      if (e.code === 'Space' && !e.repeat && e.target === document.body && $('#mic', root)) { e.preventDefault(); toggle(); }
    };
  }

  async function reply() {
    busy = true;
    drawChat('');
    drawBottom();
    controller = new AbortController();
    stopSpeaking();
    speaker = prefs.voice ? createSpeaker() : null;
    let streamed = '';
    try {
      const focus = conv.focus || [];
      const { text, usage } = await streamReply({
        system: systemPrompt(conv.scenario, { level: conv.level, hints: conv.hints, focus, twist: conv.twist }),
        messages: conv.messages.map((m) => ({ role: m.role, content: m.text })),
        onText: (delta) => {
          streamed += delta;
          speaker?.feed(delta);
          if (alive) drawChat(streamed);
        },
        signal: controller.signal,
      });
      speaker?.finish();
      conv.messages.push({ role: 'assistant', text: text.trim() });
      addUsage(conv.usage, usage);
      await save();
      busy = false;
      if (!alive) return;
      drawChat();
      drawBottom();
    } catch (err) {
      speaker?.cancel();
      busy = false;
      if (!alive || controller.signal.aborted) return;
      drawChat();
      drawBottom(err);
    }
  }

  async function analyze() {
    listener?.abort();
    stopSpeaking();
    conv.activeMs += Math.min(Date.now() - lastActivity, IDLE_CAP_MS);
    lastActivity = Date.now();
    conv.status = 'analyzing';
    analyzing.add(conv.id);
    await save();
    drawBottom();
    try {
      const prompt = `Scenario: ${conv.scenario.title} — the partner was ${conv.scenario.role}.
Learner level: about ${conv.level}.

Transcript:
${transcriptForAnalysis(conv)}`;
      const { data, usage } = await structured({ system: ANALYSIS_SYSTEM, prompt, schema: ANALYSIS_SCHEMA });
      addUsage(conv.usage, usage);
      conv.analysis = data;
      conv.userWords = conv.messages.filter((m) => m.role === 'user' && !m.hidden).reduce((n, m) => n + wordCount(m.text), 0);
      conv.cardsCreated = await applyAnalysis(conv, data);
      conv.status = 'done';
      await save();
      if (conv.cardsCreated) toast(`Створено карток: ${conv.cardsCreated}`);
    } catch (err) {
      conv.status = 'ended';
      await save();
      if (alive) drawBottom(err);
      return;
    } finally {
      analyzing.delete(conv.id);
    }
    if (alive) drawBottom();
  }

  async function drawAnalysis(bottom) {
    const a = conv.analysis;
    const known = new Set((await getAll('cards')).map((c) => c.en.trim().toLowerCase()));
    if (!alive) return;
    bottom.innerHTML = `
      <div class="card analysis">
        <h2>Розбір</h2>
        <p>${esc(a.summary)}</p>
        ${a.strengths.length ? `<p class="small"><strong>Добре вийшло:</strong> ${a.strengths.map(esc).join(' · ')}</p>` : ''}

        <h3>Помилки ${a.errors.length ? `<span class="muted small">(${a.errors.length})</span>` : ''}</h3>
        ${a.errors.length ? `<ul class="fix-list">${a.errors.map((e) => `
          <li>
            <div class="was">${esc(e.original)}</div>
            <div class="now">${esc(e.corrected)}</div>
            <div class="small muted">${esc(e.explanation)} <span class="tag">${esc(tagLabel(e.category))}</span></div>
          </li>`).join('')}</ul>` : '<p class="muted">Помилок не знайдено. Чудово! Наступного разу спробуй складнішу тему або рівень C1.</p>'}

        ${a.better_phrasings.length ? `<h3>Як сказати природніше</h3>
          <ul class="fix-list">${a.better_phrasings.map((p) => `
            <li><div class="was soft">${esc(p.original)}</div><div class="now">${esc(p.natural)}</div><div class="small muted">${esc(p.note)}</div></li>`).join('')}</ul>` : ''}

        <h3>Корисні фрази</h3>
        <ul class="card-list">${a.useful_phrases.map((p, i) => `
          <li>
            <div style="flex:1;min-width:0"><div class="en">${esc(p.en)}</div><div>${esc(p.ua)}</div><div class="meta"><em>${esc(p.context)}</em></div></div>
            ${known.has(p.en.trim().toLowerCase())
              ? '<span class="tag">у картках</span>'
              : `<button class="icon-btn" data-phrase="${i}">+ у картки</button>`}
          </li>`).join('')}</ul>

        <p class="muted small">${conv.cardsCreated ? `Виправлення автоматично додано в картки: ${conv.cardsCreated}. ` : ''}Помилки збережено в журнал.
          Вартість розмови ≈ $${costOf(conv.usage, conv.model).toFixed(3)}.</p>
        <div class="row">
          <a class="btn primary" href="#/review">Повторити картки</a>
          <a class="btn" href="#/journal">Журнал помилок</a>
          <a class="btn" href="#/talk">Нова розмова</a>
        </div>
      </div>`;

    $$('[data-phrase]', bottom).forEach((b) => b.addEventListener('click', async () => {
      const p = a.useful_phrases[Number(b.dataset.phrase)];
      const reverse = await getSetting('reverseDefault', true);
      await put('cards', makeCard({ en: p.en, ua: p.ua, context: p.context, tag: 'vocab', source: 'conversation', reverse }));
      b.outerHTML = '<span class="tag">у картках</span>';
      toast('Фразу додано');
    }));
  }

  drawShell();
  // Нова розмова (або обірвана на репліці учня): ШІ відповідає першим.
  if (conv.status === 'active' && conv.messages.at(-1).role === 'user') reply();

  return async () => {
    alive = false;
    controller?.abort();
    listener?.abort();
    speaker?.cancel();
    stopSpeaking();
    document.onkeydown = null;
    if (conv.status === 'active') conv.activeMs += Math.min(Date.now() - lastActivity, IDLE_CAP_MS);
    const delta = conv.activeMs - (conv.loggedMs || 0);
    if (delta > 0) {
      conv.loggedMs = conv.activeMs;
      await put('conversations', conv);
      await logMinutes('output', delta / 60000, 'conversation');
    }
  };
}
