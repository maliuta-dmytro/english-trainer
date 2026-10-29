import { getSetting, setSetting, exportAll, importAll } from '../db.js';
import { esc, $, toast } from '../ui.js';
import { dayKey } from '../stats.js';
import { MODELS, DEFAULT_MODEL } from '../claude.js';
import { englishVoices, loadSpeechSettings, speak, canSpeak, canListen } from '../speech.js';

export async function render(root) {
  const [tripDate, newPerDay, retention, autoSpeak, reverseDefault, apiKey, model] = await Promise.all([
    getSetting('tripDate', '2027-09-01'), getSetting('newPerDay', 15), getSetting('retention', 0.9),
    getSetting('autoSpeak', true), getSetting('reverseDefault', true), getSetting('apiKey', ''),
    getSetting('model', DEFAULT_MODEL),
  ]);
  const [ttsVoice, ttsRate] = await Promise.all([getSetting('ttsVoice', ''), getSetting('ttsRate', 1)]);
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
      ${canSpeak() ? `
        <div class="grid grid-2">
          <div class="field"><label for="s-voice">Голос співрозмовника</label>
            <select id="s-voice"><option value="">Автоматично (американський)</option></select></div>
          <div class="field">
            <label for="s-rate">Темп мовлення: <strong id="rate-val">${ttsRate}×</strong></label>
            <input type="range" id="s-rate" min="0.7" max="1.3" step="0.05" value="${ttsRate}" style="width:100%">
          </div>
        </div>
        <div class="row"><button type="button" id="s-try">🔊 Прослухати</button><button type="submit">Зберегти</button></div>`
        : '<p class="muted">Цей браузер не підтримує синтез мовлення.</p>'}
      <p class="muted small" style="margin:10px 0 0">Розпізнавання твого мовлення: ${canListen()
        ? 'доступне ✓ (обробляє сервіс розпізнавання браузера, тож потрібен інтернет).'
        : 'недоступне в цьому браузері. Відкрий застосунок у Chrome або Edge.'}
        Найприродніше звучать голоси з позначкою «Natural» або «Online» (Edge) та «Google» (Chrome).</p>
    </form>

    <form class="card" id="api">
      <h2>Claude API <span class="tag">розмова з ШІ та розбір</span></h2>
      <p class="muted small">Ключ зберігається лише в цьому браузері й не потрапляє в бекап. Запити йдуть напряму з браузера до api.anthropic.com. Створити ключ можна на console.anthropic.com.</p>
      <div class="field">
        <input type="password" id="s-key" placeholder="sk-ant-…" value="${esc(apiKey)}" autocomplete="off">
      </div>
      <div class="field">
        <label for="s-model">Модель</label>
        <select id="s-model">${MODELS.map((m) => `<option value="${m.id}"${m.id === model ? ' selected' : ''}>${esc(m.label)} · $${m.price.in}/$${m.price.out} за 1M токенів</option>`).join('')}</select>
        <div class="muted small">Типова 15-хвилинна розмова з розбором на Opus коштує орієнтовно кілька центів, на Sonnet — приблизно вдвічі менше. Точну вартість видно в історії розмов.</div>
      </div>
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

  if (canSpeak()) {
    // Список голосів у Chrome підвантажується асинхронно.
    const fillVoices = () => {
      const sel = $('#s-voice');
      if (!sel) return;
      sel.innerHTML = '<option value="">Автоматично (американський)</option>' + englishVoices()
        .map((v) => `<option value="${esc(v.name)}"${v.name === ttsVoice ? ' selected' : ''}>${esc(v.name)} · ${esc(v.lang)}</option>`).join('');
    };
    fillVoices();
    speechSynthesis.addEventListener('voiceschanged', fillVoices, { once: true });
    $('#s-rate').addEventListener('input', (e) => { $('#rate-val').textContent = `${Number(e.target.value)}×`; });
    const saveVoice = async () => {
      await setSetting('ttsVoice', $('#s-voice').value);
      await setSetting('ttsRate', Number($('#s-rate').value));
      await loadSpeechSettings();
    };
    $('#s-try').addEventListener('click', async () => {
      await saveVoice();
      speak("Hi there! For here or to go? I'm gonna grab a coffee, wanna come with?");
    });
    $('#voice').addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveVoice();
      toast('Голос збережено');
    });
  }

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

  $('#api').addEventListener('submit', async (e) => {
    e.preventDefault();
    await setSetting('apiKey', $('#s-key').value.trim());
    await setSetting('model', $('#s-model').value);
    toast('Збережено');
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
