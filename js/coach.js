// Методика розмови й розбору: системний промпт, схема аналізу і замкнений цикл
// «помилки → журнал → картки → фокус наступних розмов».
import { getAll, putMany, uid, getSetting } from './db.js';
import { makeCard, dayKey } from './stats.js';
import { ERROR_CATEGORIES } from './ui.js';

const LEVEL_STYLE = {
  B1: 'Speak a bit slower and simpler: shorter sentences, common words, few idioms. Still natural American English.',
  B2: 'Speak naturally with contractions and common phrasal verbs, occasional idioms; keep sentences reasonably clear.',
  C1: 'Speak like a native speaker would to another fluent adult: natural speed, idioms, slang where it fits, reduced forms ("gonna", "wanna", "kinda").',
};

export const START_MESSAGE = '[The learner is ready. Open the conversation in character with your first line.]';

// Системний промпт стабільний протягом сесії (без часу/дат) — так працює кешування.
export function systemPrompt(scenario, { level, hints, focus, twist = false }) {
  const hintRules = hints
    ? `Corrective feedback during the conversation:
- When the learner makes an error that matters (grammar that changes meaning or sounds clearly non-native, wrong word, missing article in a common phrase), stay in character for your reply, then add ONE short hint on a separate final line that starts with "💡 ".
- The hint should prompt self-correction rather than give the answer: point to the place and the type of problem, e.g. "💡 Check the tense in 'I am here since Monday' — can you say it again?" or "💡 Is there a more natural word than 'make a photo'?".
- At most one hint per reply, and skip hints for small slips so the conversation keeps flowing. Never hint about punctuation or capitalization.
- If the learner fixes it, acknowledge briefly and naturally in character (e.g. "Got it — since Monday.").`
    : 'Do not correct the learner during the conversation; a separate review will cover mistakes afterwards. Just respond naturally.';

  const twistRule = twist
    ? `Stress test: after the first two or three exchanges, introduce ONE realistic complication that fits the scene (for example: the reservation can't be found, the card is declined, the item is out of stock, a delay or a misunderstanding) and let the learner handle it. Stay polite but don't solve it for them too quickly. Speak at a natural native pace.`
    : '';
  const focusRule = focus.length
    ? `The learner's most frequent recent problem areas: ${focus.map((c) => FOCUS_EN[c] || c).join('; ')}. Naturally create chances to use these structures (ask questions that invite them) and watch for these errors especially.`
    : '';

  return `You are a conversation partner in an English practice app for a Ukrainian-speaking adult learner (level around ${level}) preparing for a trip to the USA. The goal is real speaking practice in American English.

Role-play: you are ${scenario.role}.
Situation: ${scenario.situation}

How to talk:
- Stay in character and keep it a real conversation: react, ask follow-up questions, move the situation forward. Do not lecture.
- Keep each reply short like in real speech: usually 1–3 sentences, never long monologues.
- Use American English vocabulary and spelling. ${LEVEL_STYLE[level] || LEVEL_STYLE.B2}
- If the learner writes in Ukrainian or seems stuck, help briefly in simple English (offer a phrase they could use), then continue the scene.
- If the learner asks a direct question about English (a word, grammar), answer in one or two sentences, then return to the scene.
- No markdown, lists, or emojis in your lines (except the 💡 hint line). Your lines may be read aloud by text-to-speech, so write them the way they are said: no abbreviations like "e.g.", no symbols, no parentheses.
- The learner may be speaking through speech recognition: if a word looks like a mis-recognized similar-sounding word, assume the intended word and carry on.

${hintRules}
${twistRule}
${focusRule}`.trim();
}

// Схема структурованого розбору. Усі поля обов'язкові — цього вимагають structured outputs.
export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'strengths', 'errors', 'better_phrasings', 'useful_phrases'],
  properties: {
    summary: { type: 'string', description: 'Ukrainian, 2–3 sentences: overall impression and the single most important thing to work on.' },
    strengths: { type: 'array', items: { type: 'string' }, description: 'Ukrainian, 1–3 short points about what the learner did well.' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['original', 'corrected', 'explanation', 'category', 'ua'],
        properties: {
          original: { type: 'string', description: 'The learner\'s exact words containing the error (a sentence or clause).' },
          corrected: { type: 'string', description: 'Minimal natural correction of the same sentence in American English.' },
          explanation: { type: 'string', description: 'Ukrainian, one short sentence: what rule or why.' },
          category: { type: 'string', enum: ERROR_CATEGORIES },
          ua: { type: 'string', description: 'Ukrainian translation of the corrected sentence (for a ua→en flashcard).' },
        },
      },
    },
    better_phrasings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['original', 'natural', 'note', 'ua'],
        properties: {
          original: { type: 'string', description: 'Grammatically OK but unnatural/bookish learner phrase.' },
          natural: { type: 'string', description: 'How an American would naturally say it.' },
          note: { type: 'string', description: 'Ukrainian, short note on why it sounds more natural.' },
          ua: { type: 'string', description: 'Ukrainian meaning of the natural version.' },
        },
      },
    },
    useful_phrases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['en', 'ua', 'context'],
        properties: {
          en: { type: 'string', description: 'A useful phrase or collocation from the partner\'s lines or relevant to this situation.' },
          ua: { type: 'string', description: 'Ukrainian meaning.' },
          context: { type: 'string', description: 'An English example sentence using it, ideally from this conversation.' },
        },
      },
    },
  },
};

export const ANALYSIS_SYSTEM = `You are an expert ESL teacher reviewing a Ukrainian-speaking learner's practice conversation (target: move from B2 to C1, American English).
Principles:
- Focus on errors that matter for communication and for sounding natural; ignore punctuation, capitalization, and obvious typos.
- Lines marked "spoken, auto-transcribed" came through speech recognition: never penalize punctuation there, and if an odd word looks like a recognition artifact (a similar-sounding word that makes no sense) rather than the learner's choice, skip it. Grammar that is clearly the learner's (wrong tense, missing article, word order) still counts — spoken errors are the most valuable to catch.
- Prioritize recurring patterns typical for Ukrainian speakers (articles, Present Perfect vs Past Simple, conditionals, modals of deduction, question word order, prepositions, collocations).
- Make corrections minimal: change only what is needed, keep the learner's meaning.
- List each distinct error once (merge repeats), max 10 errors, most important first. If there are none, return an empty list.
- better_phrasings: max 5, only when the phrase is correct but unnatural.
- useful_phrases: 3–6 natural phrases worth learning for this situation.
- All explanations in Ukrainian, short and friendly.`;

export function transcriptForAnalysis(conv) {
  return conv.messages
    .filter((m) => !m.hidden)
    .map((m) => `${m.role === 'user' ? (m.voice ? 'LEARNER (spoken, auto-transcribed)' : 'LEARNER') : 'PARTNER'}: ${m.text}`)
    .join('\n');
}

export const wordCount = (text) => (text.match(/[\p{L}']+/gu) || []).length;

// Зберігає помилки в журнал і створює картки з виправлень. Повертає кількість нових карток.
export async function applyAnalysis(conv, analysis) {
  const existing = new Set((await getAll('cards')).map((c) => c.en.trim().toLowerCase()));
  const now = Date.now();
  const cards = [];
  const addCard = (fields) => {
    const key = fields.en.trim().toLowerCase();
    if (!key || existing.has(key)) return null;
    existing.add(key);
    // Для виправлень цінний лише напрямок укр → англ: саме його треба вміти сказати.
    const card = makeCard({ ...fields, source: 'conversation', reverse: false });
    cards.push(card);
    return card.id;
  };

  const errors = analysis.errors.map((e) => ({
    id: uid(),
    ts: now,
    date: dayKey(now),
    convId: conv.id,
    category: ERROR_CATEGORIES.includes(e.category) ? e.category : 'other',
    original: e.original,
    corrected: e.corrected,
    explanation: e.explanation,
    cardId: addCard({ en: e.corrected, ua: e.ua, context: `Було: ${e.original}`, tag: e.category }),
  }));
  for (const p of analysis.better_phrasings) {
    addCard({ en: p.natural, ua: p.ua, context: `Замість: ${p.original}`, tag: 'collocation' });
  }

  await putMany('errors', errors);
  await putMany('cards', cards);
  return cards.length;
}

// Фокус наступних розмов (id категорій): спершу тема недавнього граматичного уроку (тиждень),
// далі — найчастіші категорії помилок за останні 14 днів.
export async function focusTopics(limit = 3) {
  const since = Date.now() - 14 * 86_400_000;
  const counts = {};
  for (const e of await getAll('errors')) {
    if (e.ts >= since && e.category !== 'other') counts[e.category] = (counts[e.category] || 0) + 1;
  }
  const fromErrors = Object.entries(counts)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([cat]) => cat);
  const lesson = await getSetting('lessonFocus', null);
  const fromLesson = lesson && lesson.until > Date.now() ? [lesson.category] : [];
  return [...new Set([...fromLesson, ...fromErrors])].slice(0, limit);
}

export const FOCUS_EN = {
  articles: 'articles (a/an/the/zero article)',
  tenses: 'Present Perfect vs Past Simple and tense choice',
  conditionals: 'conditionals, including mixed conditionals',
  modals: 'modals of deduction (must have been, might have, can\'t be)',
  'word-order': 'word order in questions and indirect questions',
  prepositions: 'prepositions',
  phrasal: 'phrasal verbs',
  collocation: 'natural collocations',
  vocab: 'word choice',
  'c1-grammar': 'advanced structures (inversion, cleft sentences, passive)',
};
