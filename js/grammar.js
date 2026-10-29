// Граматичні міні-уроки у форматі focus on form: тема — з журналу помилок, приклади — власні помилки учня.
import { getAll } from './db.js';
import { structured } from './claude.js';
import { FOCUS_EN } from './coach.js';

// Пріоритетні граматичні теми з брифу (у порядку важливості для україномовних на B2).
export const GRAMMAR_TOPICS = ['articles', 'tenses', 'conditionals', 'modals', 'word-order', 'prepositions', 'phrasal', 'c1-grammar'];
export const EXERCISES = 12;

// Помилки за 4 тижні по граматичних темах: { category: [errors…] }, від найчастішої.
export async function errorsByTopic(days = 28) {
  const since = Date.now() - days * 86_400_000;
  const by = Object.fromEntries(GRAMMAR_TOPICS.map((t) => [t, []]));
  for (const e of await getAll('errors')) if (e.ts >= since && by[e.category]) by[e.category].push(e);
  for (const list of Object.values(by)) list.sort((a, b) => b.ts - a.ts);
  return by;
}

const LESSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'explanation', 'rules', 'your_errors', 'exercises', 'tip'],
  properties: {
    title: { type: 'string', description: 'Ukrainian lesson title, short.' },
    explanation: { type: 'string', description: 'Ukrainian, 3–6 short sentences: the core idea and why Ukrainian speakers get it wrong (no markdown).' },
    rules: {
      type: 'array',
      description: '3–5 key rules or patterns.',
      items: {
        type: 'object', additionalProperties: false, required: ['rule', 'example_en', 'example_ua'],
        properties: {
          rule: { type: 'string', description: 'Ukrainian, one sentence.' },
          example_en: { type: 'string', description: 'Natural American English example.' },
          example_ua: { type: 'string', description: 'Ukrainian translation of the example.' },
        },
      },
    },
    your_errors: {
      type: 'array',
      description: "The learner's own errors from the list, explained through this lesson (empty if none were provided).",
      items: {
        type: 'object', additionalProperties: false, required: ['original', 'corrected', 'why'],
        properties: { original: { type: 'string' }, corrected: { type: 'string' }, why: { type: 'string', description: 'Ukrainian, which rule applies.' } },
      },
    },
    exercises: {
      type: 'array',
      description: `Exactly ${EXERCISES} production exercises, from easier to harder.`,
      items: {
        type: 'object', additionalProperties: false, required: ['type', 'task', 'source', 'answer', 'ua'],
        properties: {
          type: { type: 'string', enum: ['translate', 'transform', 'correct'] },
          task: { type: 'string', description: 'Ukrainian instruction. For translate: just the Ukrainian sentence to translate.' },
          source: { type: 'string', description: 'English sentence to transform or correct; empty string for translate.' },
          answer: { type: 'string', description: 'One model answer in natural American English.' },
          ua: { type: 'string', description: 'Ukrainian meaning of the answer (used as the flashcard prompt).' },
        },
      },
    },
    tip: { type: 'string', description: 'Ukrainian, one practical tip for noticing this in real speech.' },
  },
};

export async function generateLesson({ category, level, errors }) {
  const system = `You are an expert teacher of English to Ukrainian-speaking adults (B2 → C1, American English).
You write short "focus on form" mini-lessons built around the learner's own mistakes.
Principles:
- Explanations in Ukrainian, concise and practical; contrast with how Ukrainian works when it helps (e.g. no articles, aspect instead of perfect tenses).
- Examples: natural, everyday American English, ideally travel and small-talk situations.
- Exercises make the learner PRODUCE full sentences (mostly translate from Ukrainian, plus transform and correct-the-error). Each exercise must clearly target the lesson structure and have an unambiguous intended structure; other correct wordings will be accepted by the checker.
- Reuse the learner's own errors as "correct" exercises or as translation prompts where possible.
- Level ${level}: ${level === 'C1' ? 'include nuanced and advanced uses' : 'focus on the most common, high-impact uses'}.
- No markdown.`;
  const prompt = `Topic: ${FOCUS_EN[category] || category}

The learner's recent errors on this topic (JSON):
${JSON.stringify(errors.slice(0, 12).map((e) => ({ original: e.original, corrected: e.corrected })), null, 1)}

Write the mini-lesson with exactly ${EXERCISES} exercises.`;
  return structured({ system, prompt, schema: LESSON_SCHEMA, effort: 'medium' });
}

const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results', 'summary'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['index', 'correct', 'corrected', 'feedback'],
        properties: {
          index: { type: 'integer' },
          correct: { type: 'boolean', description: 'True if the answer is correct and natural (any valid wording), especially the target structure.' },
          corrected: { type: 'string', description: "Minimal correction of the learner's answer; if it is correct, repeat it; if blank, give the model answer." },
          feedback: { type: 'string', description: 'Ukrainian, one short sentence: what was wrong or a brief praise.' },
        },
      },
    },
    summary: { type: 'string', description: 'Ukrainian, 1–2 sentences: overall result and what to watch.' },
  },
};

export async function checkAnswers({ lesson, category, answers }) {
  const system = `You check a Ukrainian learner's answers to grammar exercises (topic: ${FOCUS_EN[category] || category}).
- Accept any correct, natural American English wording, not only the model answer.
- The target structure must be used correctly; also flag other clear grammar errors, but ignore punctuation, capitalization and typos that do not change the word.
- Keep corrections minimal and keep the learner's wording where possible. Feedback in Ukrainian, one short sentence.`;
  const items = lesson.exercises.map((ex, i) => ({
    index: i, type: ex.type, task: ex.task, source: ex.source, model_answer: ex.answer, learner_answer: answers[i] || '',
  }));
  return structured({ system, prompt: `Check every item (JSON):\n${JSON.stringify(items, null, 1)}`, schema: CHECK_SCHEMA, effort: 'medium' });
}
