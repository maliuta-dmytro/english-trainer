import { getSetting, setSetting, exportAll, importAll } from '../db.js';
import { esc, $, toast } from '../ui.js';
import { dayKey } from '../stats.js';
import { MODELS as CLAUDE_MODELS, DEFAULT_MODEL as CLAUDE_DEFAULT } from '../claude.js';
import {
  MODELS as GEMINI_MODELS, DEFAULT_MODEL as GEMINI_DEFAULT, TTS_VOICES as GEMINI_VOICES, DEFAULT_VOICE as GEMINI_VOICE,
} from '../gemini.js';
import { englishVoices, loadSpeechSettings, speak, canListen, getEngine } from '../speech.js';

const modelOptions = (models, selected) => models
  .map((m) => `<option value="${m.id}"${m.id === selected ? ' selected' : ''}>${esc(m.label)}</option>`).join('');

export async function render(root) {
  const [tripDate, newPerDay, retention, autoSpeak, reverseDefault, apiKey, model, provider, geminiKey, geminiModel] = await Promise.all([
    getSetting('tripDate', '2027-09-01'), getSetting('newPerDay', 15), getSetting('retention', 0.9),
    getSetting('autoSpeak', true), getSetting('reverseDefault', true), getSetting('apiKey', ''),
    getSetting('model', CLAUDE_DEFAULT), getSetting('provider', 'claude'), getSetting('geminiKey', ''),
    getSetting('geminiModel', GEMINI_DEFAULT),
  ]);
  const [ttsVoice, ttsRate, ttsEngine, geminiVoice, youtubeKey] = await Promise.all([
    getSetting('ttsVoice', ''), getSetting('ttsRate', 1), getSetting('ttsEngine', 'browser'), getSetting('geminiVoice', GEMINI_VOICE),
    getSetting('youtubeKey', ''),
  ]);
  const persisted = (await navigator.storage?.persisted?.()) ?? false;

  root.innerHTML = `
    <h1>Налаштування</h1>
    <form class="card" id="prefs">
      <h2>Навчання</h2>
      <div class="grid grid-2">
        <div class="field"><label for="s-trip">Дата поїздки</label><input type="date" id="s-trip" value="${esc(tripDate)}"></div>
        <div class="field"><label for="s-new">Нових фраз на день</label><input type="number" id="s-new" min="0" max="100" value="${newPerDay}"></div>
        <div class="field">
          <label for="s-ret">Цільове утримання: <strong id="ret-val">${Math.round(retention * 100)}%</strong></label>
          <input type="range" id="s-ret" min="0.8" max="0.95" step="0.01" value="${retention}" style="width:100%">
          <div class="muted small">Вище означає частіші повторення й надійнішу пам'ять. 90% — збалансований варіант.</div>
        </div>
      </div>
      <label class="check"><input type="checkbox" id="s-speak" ${autoSpeak ? 'checked' : ''}> Озвучувати англійську фразу після відповіді</label>
      <label class="check"><input type="checkbox" id="s-rev" ${reverseDefault ? 'checked' : ''}> Нові картки за замовчуванням і в напрямку англ → укр</label>
      <div class="row" style="margin-top:14px"><button class="primary" type="submit">Зберегти</button></div>
    </form>

    <form class="card" id="voice">
      <h2>Голос</h2>
      <div class="seg" role="radiogroup" aria-label="Рушій голосу" style="margin-bottom:14px">
        <label class="check seg-opt"><input type="radio" name="engine" value="gemini" ${ttsEngine === 'gemini' ? 'checked' : ''}> ✨ Природний голос Gemini</label>
        <label class="check seg-opt"><input type="radio" name="engine" value="browser" ${ttsEngine === 'browser' ? 'checked' : ''}> Голос браузера</label>
      </div>
      <div data-engine="gemini" ${ttsEngine === 'gemini' ? '' : 'hidden'}>
        <div class="field"><label for="s-gvoice">Голос співрозмовника</label>
          <select id="s-gvoice">${GEMINI_VOICES.map(([name, desc]) => `<option value="${name}"${name === geminiVoice ? ' selected' : ''}>${name} — ${desc}</option>`).join('')}</select></div>
        <p class="muted small">${geminiKey ? '' : '<strong>Потрібен ключ Gemini</strong> (блок «Штучний інтелект» нижче), навіть якщо розмову веде Claude. '}Озвучені фрази зберігаються в браузері, тож картки й диктанти звучать миттєво й не витрачають ліміт повторно. Якщо Gemini недоступний, тимчасово звучить голос браузера.</p>
      </div>
      <div data-engine="browser" ${ttsEngine === 'browser' ? '' : 'hidden'}>
        ${'speechSynthesis' in window ? `<div class="field"><label for="s-voice">Голос браузера</label>
          <select id="s-voice"><option value="">Автоматично (американський)</option></select></div>` : '<p class="muted">Цей браузер не має вбудованих голосів.</p>'}
      </div>
      <div class="field">
        <label for="s-rate">Темп мовлення: <strong id="rate-val">${ttsRate}×</strong></label>
        <input type="range" id="s-rate" min="0.7" max="1.3" step="0.05" value="${ttsRate}" style="width:100%">
      </div>
      <div class="row"><button type="button" id="s-try">🔊 Прослухати</button><button type="submit">Зберегти</button></div>
      <p class="muted small" style="margin:10px 0 0">Розпізнавання твого мовлення: ${canListen()
        ? 'доступне ✓ (обробляє сервіс розпізнавання браузера, тож потрібен інтернет).'
        : 'недоступне в цьому браузері. Відкрий застосунок у Chrome або Edge.'}
        Серед голосів браузера найприродніше звучать ті, що з позначкою «Natural» або «Online» (Edge) та «Google» (Chrome).</p>
    </form>

    <form class="card" id="api">
      <h2>Штучний інтелект <span class="tag">розмова, розбір, уроки</span></h2>
      <p class="muted small">Ключі зберігаються лише в цьому браузері й не потрапляють у бекап. Запити йдуть напряму з браузера до обраного сервісу.</p>
      <div class="seg" role="radiogroup" aria-label="Провайдер" style="margin-bottom:14px">
        <label class="check seg-opt"><input type="radio" name="provider" value="gemini" ${provider === 'gemini' ? 'checked' : ''}> Gemini · безкоштовно</label>
        <label class="check seg-opt"><input type="radio" name="provider" value="claude" ${provider === 'claude' ? 'checked' : ''}> Claude · оплата за використання</label>
      </div>

      <div class="provider-box" data-box="gemini" ${provider === 'gemini' ? '' : 'hidden'}>
        <p class="small">Ключ створюється в <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>: увійди акаунтом Google → «Create API key» → скопіюй ключ і встав нижче. Безкоштовний рівень не потребує картки.</p>
        <div class="field"><label for="s-gkey">Ключ Gemini API</label>
          <input type="password" id="s-gkey" placeholder="AIza…" value="${esc(geminiKey)}" autocomplete="off"></div>
        <div class="field"><label for="s-gmodel">Модель</label>
          <select id="s-gmodel">${modelOptions(GEMINI_MODELS, geminiModel)}</select></div>
        <p class="muted small">На безкоштовному рівні є ліміти запитів на хвилину й на день, а Google може використовувати ці розмови для покращення своїх продуктів. Тож особистого краще не писати. Вартість у історії розмов розрахована за цінами платного рівня: на безкоштовному ти нічого не платиш.</p>
      </div>

      <div class="provider-box" data-box="claude" ${provider === 'claude' ? '' : 'hidden'}>
        <p class="small">Ключ створюється на <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a> (розділ API Keys) після поповнення балансу.</p>
        <div class="field"><label for="s-key">Ключ Claude API</label>
          <input type="password" id="s-key" placeholder="sk-ant-…" value="${esc(apiKey)}" autocomplete="off"></div>
        <div class="field"><label for="s-model">Модель</label>
          <select id="s-model">${CLAUDE_MODELS.map((m) => `<option value="${m.id}"${m.id === model ? ' selected' : ''}>${esc(m.label)} · $${m.price.in}/$${m.price.out} за 1M токенів</option>`).join('')}</select>
          <div class="muted small">Типова розмова з розбором на Opus коштує орієнтовно кілька центів, на Sonnet приблизно вдвічі менше. Точну вартість видно в історії розмов.</div></div>
      </div>
      <button type="submit" class="primary">Зберегти</button>
    </form>

    <form class="card" id="yt">
      <h2>YouTube <span class="tag">мої канали в «Слуханні»</span></h2>
      <p class="small">Щоб гортати відео збережених каналів, потрібен безкоштовний ключ YouTube Data API:</p>
      <ol class="small steps">
        <li>Відкрий <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">YouTube Data API v3 у Google Cloud Console</a> і натисни <strong>Enable</strong> (за потреби погодься створити проєкт).</li>
        <li>Перейди в <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Credentials</a> → <strong>Create credentials</strong> → <strong>API key</strong>.</li>
        <li>Рекомендую обмежити ключ: <em>Application restrictions</em> → <em>Websites</em> → <code>${esc(location.origin)}/*</code>; <em>API restrictions</em> → лише YouTube Data API v3.</li>
        <li>Скопіюй ключ і встав нижче.</li>
      </ol>
      <div class="field"><label for="s-ytkey">Ключ YouTube Data API</label>
        <input type="password" id="s-ytkey" placeholder="AIza…" value="${esc(youtubeKey)}" autocomplete="off"></div>
      <p class="muted small">Ключ зберігається лише в цьому браузері й не потрапляє в бекап. Безкоштовної квоти (10 000 одиниць на день) вистачає з великим запасом: оновлення каналу коштує кілька одиниць.</p>
      <button type="submit">Зберегти</button>
    </form>

    <div class="card">
      <h2>Дані й бекап</h2>
      <p class="muted small">Усі картки й статистика зберігаються локально в цьому браузері.
        ${persisted ? 'Браузер дозволив постійне зберігання ✓' : 'Браузер ще не підтвердив постійне зберігання, тому регулярно роби бекап.'}
        Через бекап можна перенести дані на інший пристрій.</p>
      <div class="row">
        <button id="export">⬇ Завантажити бекап (JSON)</button>
        <label class="btn" style="margin:0;color:var(--text)">⬆ Відновити з бекапу<input type="file" id="import" accept="application/json,.json" hidden></label>
      </div>
    </div>`;

  // Список голосів браузера в Chrome підвантажується асинхронно.
  const fillVoices = () => {
    const sel = $('#s-voice');
    if (!sel) return;
    sel.innerHTML = '<option value="">Автоматично (американський)</option>' + englishVoices()
      .map((v) => `<option value="${esc(v.name)}"${v.name === ttsVoice ? ' selected' : ''}>${esc(v.name)} · ${esc(v.lang)}</option>`).join('');
  };
  if ('speechSynthesis' in window) {
    fillVoices();
    speechSynthesis.addEventListener('voiceschanged', fillVoices, { once: true });
  }
  root.querySelectorAll('input[name=engine]').forEach((r) => r.addEventListener('change', () => {
    root.querySelectorAll('[data-engine]').forEach((box) => { box.hidden = box.dataset.engine !== r.value; });
  }));
  $('#s-rate').addEventListener('input', (e) => { $('#rate-val').textContent = `${Number(e.target.value)}×`; });
  const saveVoice = async () => {
    await Promise.all([
      setSetting('ttsEngine', root.querySelector('input[name=engine]:checked').value),
      setSetting('geminiVoice', $('#s-gvoice').value),
      setSetting('ttsVoice', $('#s-voice')?.value || ''),
      setSetting('ttsRate', Number($('#s-rate').value)),
    ]);
    await loadSpeechSettings();
  };
  $('#s-try').addEventListener('click', async () => {
    await saveVoice();
    if (root.querySelector('input[name=engine]:checked').value === 'gemini' && getEngine() !== 'gemini') {
      toast('Для голосу Gemini спершу додай ключ Gemini в блоці «Штучний інтелект».');
    }
    speak("Hi there! For here or to go? I'm gonna grab a coffee, wanna come with?");
  });
  $('#voice').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveVoice();
    toast('Голос збережено');
  });

  $('#s-ret').addEventListener('input', (e) => { $('#ret-val').textContent = `${Math.round(e.target.value * 100)}%`; });

  $('#prefs').addEventListener('submit', async (e) => {
    e.preventDefault();
    await Promise.all([
      setSetting('tripDate', $('#s-trip').value || '2027-09-01'),
      setSetting('newPerDay', Math.max(0, Number($('#s-new').value) || 0)),
      setSetting('retention', Number($('#s-ret').value)),
      setSetting('autoSpeak', $('#s-speak').checked),
      setSetting('reverseDefault', $('#s-rev').checked),
    ]);
    toast('Налаштування збережено');
  });

  root.querySelectorAll('input[name=provider]').forEach((r) => r.addEventListener('change', () => {
    root.querySelectorAll('[data-box]').forEach((box) => { box.hidden = box.dataset.box !== r.value; });
  }));

  $('#api').addEventListener('submit', async (e) => {
    e.preventDefault();
    const chosen = root.querySelector('input[name=provider]:checked').value;
    await Promise.all([
      setSetting('provider', chosen),
      setSetting('apiKey', $('#s-key').value.trim()),
      setSetting('model', $('#s-model').value),
      setSetting('geminiKey', $('#s-gkey').value.trim()),
      setSetting('geminiModel', $('#s-gmodel').value),
    ]);
    // Перший ключ Gemini → природний голос за замовчуванням (якщо голос ще ніхто не обирав).
    if ($('#s-gkey').value.trim() && (await getSetting('ttsEngine', null)) === null) await setSetting('ttsEngine', 'gemini');
    await loadSpeechSettings();
    toast(`Збережено. Працюємо з ${chosen === 'gemini' ? 'Gemini' : 'Claude'}`);
    render(root);
  });

  $('#yt').addEventListener('submit', async (e) => {
    e.preventDefault();
    await setSetting('youtubeKey', $('#s-ytkey').value.trim());
    toast('Ключ YouTube збережено');
  });

  $('#export').addEventListener('click', async () => {
    const blob = new Blob([JSON.stringify(await exportAll(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `english-trainer-backup-${dayKey()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const res = await importAll(JSON.parse(await file.text()));
      toast(`Відновлено: ${res.cards} карток, ${res.sessions} сесій`);
    } catch (err) {
      toast(`Помилка: ${err.message}`);
    }
    e.target.value = '';
  });
}
