// «Слухай і перекажи»: оцінка складності, розбір переказу (зміст + мова) і пропозиції карток.
import { getAll, putMany, uid } from './db.js';
import { structured } from './ai.js';
import { timecode } from './gemini.js';
import { makeCard, dayKey } from './stats.js';
import { ERROR_CATEGORIES } from './ui.js';
import { wordCount } from './coach.js';

export const LENGTHS = [2, 3, 4, 5, 7]; // хвилин
export const MAX_MARKERS_SOFT = 10;
export const MAX_NEW_CARDS = 10;

// Сегменти, що перетинають фрагмент [start, end].
export const inRange = (segments, start, end) => segments.filter((s) => s.end > start && s.start < end);

export const transcriptText = (segments) => segments.map((s) => `[${timecode(s.start)}] ${s.text}`).join('\n');

// Речення транскрипту, що звучало в момент t (для позначки «не зрозумів»).
export function sentenceAt(segments, t) {
  const hit = segments.find((s) => t >= s.start - 0.3 && t <= s.end + 0.3);
  if (hit) return hit.text;
  const before = [...segments].reverse().find((s) => s.start <= t);
  return before?.text || '';
}

// Темп мовлення фрагмента (слів за хвилину) — рахується локально з таймкодів.
export function speechRate(segments) {
  const words = segments.reduce((n, s) => n + wordCount(s.text), 0);
  const spoken = segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
  return { words, wpm: spoken > 5 ? Math.round(words / (spoken / 60)) : null };
}

const DIFFICULTY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cefr', 'hard_words', 'note'],
  properties: {
    cefr: { type: 'string', enum: ['A2', 'B1', 'B2', 'C1', 'C2'] },
    hard_words: { type: 'array', items: { type: 'string' }, description: 'Up to 8 rare words, idioms or slang a B2 learner likely does not know.' },
    note: { type: 'string', description: 'Ukrainian, one sentence: what makes it easy or hard for a B2 learner.' },
  },
};

export async function estimateDifficulty(segments) {
  const { data, usage } = await structured({
    system: 'You estimate how hard a piece of spoken American English is for a Ukrainian learner at B2 level. Judge vocabulary, idioms, slang and sentence complexity from the transcript.',
    prompt: `Transcript:\n${segments.map((s) => s.text).join(' ')}`,
    schema: DIFFICULTY_SCHEMA,
    effort: 'low',
  });
  return { ...data, usage };
}

// Одна з підказок для самоперевірки складності (покриття 95–98% виміряти точно не можна).
export function difficultyWarning(d, level = 'B2') {
  const order = ['A2', 'B1', 'B2', 'C1', 'C2'];
  const tooHard = d?.cefr && order.indexOf(d.cefr) > order.indexOf(level);
  const tooFast = d?.wpm && d.wpm > 190;
  if (tooHard && tooFast) return 'Матеріал складний і швидкий. Візьми коротший фрагмент або сповільни до 0.85×.';
  if (tooHard) return 'Матеріал вищого рівня, ніж твій поточний. Розуміння буде частковим, тож краще коротший фрагмент.';
  if (tooFast) return 'Дуже швидке мовлення. Спробуй 0.85× для першого прослуховування.';
  return '';
}

const MARKER_CAUSES = ['unknown_word', 'connected_speech', 'idiom', 'fast_speech', 'accent', 'other'];
export const CAUSE_LABELS = {
  unknown_word: 'незнайоме слово', connected_speech: 'злиття звуків', idiom: 'ідіома',
  fast_speech: 'швидкий темп', accent: 'акцент', other: 'інше',
};

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['comprehension', 'correct', 'inaccurate', 'missed', 'strengths', 'errors', 'natural', 'useful_phrases', 'markers'],
  properties: {
    comprehension: {
      type: 'object', additionalProperties: false, required: ['score', 'verdict', 'summary'],
      properties: {
        score: { type: 'integer', description: '0–100: how much of the main content the retelling conveys correctly.' },
        verdict: { type: 'string', enum: ['full', 'partial', 'superficial'] },
        summary: { type: 'string', description: 'Ukrainian, 1–2 sentences, supportive: what was understood and what to improve.' },
      },
    },
    correct: { type: 'array', items: { type: 'string' }, description: 'Ukrainian: main ideas conveyed correctly.' },
    inaccurate: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['point', 'quote', 'time'],
        properties: {
          point: { type: 'string', description: 'Ukrainian: what was conveyed inaccurately.' },
          quote: { type: 'string', description: 'The relevant original sentence from the transcript.' },
          time: { type: 'string', description: 'MM:SS of that place, taken from the transcript timestamps.' },
        },
      },
    },
    missed: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['point', 'time'],
        properties: { point: { type: 'string', description: 'Ukrainian: important point that was missed.' }, time: { type: 'string' } },
      },
    },
    strengths: { type: 'array', items: { type: 'string' }, description: 'Ukrainian, 1–3 points about the language of the retelling.' },
    errors: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['original', 'corrected', 'explanation', 'hint', 'category', 'ua', 'top'],
        properties: {
          original: { type: 'string' },
          corrected: { type: 'string', description: 'Minimal natural correction in American English.' },
          explanation: { type: 'string', description: 'Ukrainian, 1–2 sentences.' },
          hint: { type: 'string', description: 'Ukrainian hint for self-correction that names the problem area without giving the answer.' },
          category: { type: 'string', enum: ERROR_CATEGORIES },
          ua: { type: 'string', description: 'Ukrainian translation of the corrected sentence.' },
          top: { type: 'boolean', description: 'True for at most 3 most important errors.' },
        },
      },
    },
    natural: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['original', 'natural', 'note', 'ua'],
        properties: { original: { type: 'string' }, natural: { type: 'string' }, note: { type: 'string' }, ua: { type: 'string' } },
      },
    },
    useful_phrases: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['en', 'ua', 'context', 'time'],
        properties: {
          en: { type: 'string', description: 'A useful phrase from the original that would improve the retelling.' },
          ua: { type: 'string' }, context: { type: 'string', description: 'The original sentence.' }, time: { type: 'string' },
        },
      },
    },
    markers: {
      type: 'array',
      description: 'One item per marker the learner set, explaining what they likely did not catch.',
      items: {
        type: 'object', additionalProperties: false, required: ['index', 'phrase', 'meaning', 'cause'],
        properties: {
          index: { type: 'integer' },
          phrase: { type: 'string', description: 'The exact word or phrase from the transcript the learner most likely missed.' },
          meaning: { type: 'string', description: 'Ukrainian meaning in this context.' },
          cause: { type: 'string', enum: MARKER_CAUSES },
        },
      },
    },
  },
};

const ANALYSIS_SYSTEM = `You are an expert teacher of English for Ukrainian-speaking adults (B2 → C1, American English).
The learner listened to a fragment of a podcast or video and retold it WITHOUT seeing the transcript. Give feedback on content and language.
Content: compare the retelling with the transcript. Judge meaning, not wording. Use transcript timestamps for "time" fields.
Language:
- Never invent errors in correct sentences. Ignore punctuation and capitalization; if the retelling was spoken (speech recognition), ignore likely recognition artifacts.
- British variants are not errors.
- List every distinct error once; mark at most 3 most important ones as "top".
- natural: at most 3 phrases that are correct but would sound more natural to an American.
- useful_phrases: 3–6 phrases from the original worth learning.
Markers: for each marker the learner set (time + transcript sentence + optional note of what they heard), find the word or phrase they most likely missed and why.
All explanations in Ukrainian, short, supportive and concrete: first what went well, then what to improve.`;

export async function analyzeRetell(r) {
  const segs = inRange(r.segments, r.range.start, r.range.end);
  const markers = r.markers.map((m, i) => ({ index: i, time: timecode(m.t), sentence: m.sentence, learner_note: m.note || '' }));
  const prompt = `Learner level: about ${r.level || 'B2'}.

Transcript of the fragment (with timestamps):
${transcriptText(segs)}

Learner's retelling (${r.retell.mode === 'voice' ? 'spoken, auto-transcribed' : 'typed'}):
${r.retell.text}

Markers the learner set while listening (JSON):
${JSON.stringify(markers)}`;
  const { data, usage, model } = await structured({ system: ANALYSIS_SYSTEM, prompt, schema: ANALYSIS_SCHEMA, effort: 'medium' });
  // Гарантуємо не більше 3 «головних» помилок, навіть якщо модель позначила більше.
  let top = 0;
  data.errors = data.errors.map((e) => ({ ...e, top: e.top && top++ < 3 }));
  return { data, usage, model };
}

// Пропозиції карток: позначені слова → помилки (головні) → природніші фрази → фрази з оригіналу.
export function cardProposals(r) {
  const fb = r.feedback;
  const items = [];
  fb.markers.forEach((m) => {
    const src = r.markers[m.index];
    if (m.phrase) items.push({ kind: 'marker', en: m.phrase, ua: m.meaning, context: src?.sentence || '', tag: 'vocab', t: src?.t });
  });
  fb.errors.filter((e) => e.top).forEach((e) => items.push({ kind: 'error', en: e.corrected, ua: e.ua, context: `Було: ${e.original}`, tag: e.category }));
  fb.natural.forEach((n) => items.push({ kind: 'natural', en: n.natural, ua: n.ua, context: `Замість: ${n.original}`, tag: 'collocation' }));
  fb.useful_phrases.forEach((p) => items.push({ kind: 'phrase', en: p.en, ua: p.ua, context: p.context, tag: 'vocab' }));
  const seen = new Set();
  return items.filter((it) => {
    const k = it.en.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Зберігає вибрані картки й усі помилки переказу в журнал. Повертає кількість нових карток.
export async function saveResults(r, chosen) {
  const known = new Set((await getAll('cards')).map((c) => c.en.trim().toLowerCase()));
  const source = `Слухай і перекажи: ${r.title}`;
  const cards = chosen
    .filter((it) => it.en.trim() && it.ua.trim() && !known.has(it.en.trim().toLowerCase()))
    .map((it) => makeCard({
      en: it.en, ua: it.ua, context: it.context, tag: it.tag, source: 'retell',
      // Виправлення вчимо лише укр → англ; слова й фрази — в обидва боки.
      reverse: it.kind === 'marker' || it.kind === 'phrase',
    }));
  const now = Date.now();
  const errors = r.feedback.errors.map((e) => ({
    id: uid(), ts: now, date: dayKey(now), retellId: r.id, source,
    category: ERROR_CATEGORIES.includes(e.category) ? e.category : 'other',
    original: e.original, corrected: e.corrected, explanation: e.explanation,
  }));
  await putMany('cards', cards);
  await putMany('errors', errors);
  return cards.length;
}
