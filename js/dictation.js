// Логіка диктанту: субтитри → фрагменти, речення, порівняння з урахуванням розмовних форм, генерація тексту.
import { diffWords } from './diff.js';
import { structured } from './ai.js';

const MIN_SEG = 4;   // с — коротші репліки зливаємо з сусідніми
const MAX_SEG = 15;  // с — довші не зливаємо далі

function parseTime(t) {
  const m = t.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
}

const cleanCue = (s) => s
  .replace(/<[^>]+>/g, '')        // <i>, <c.color>, <00:00:01.000>
  .replace(/\{\\[^}]*\}/g, '')    // {\an8}
  .replace(/^\s*-\s*/gm, '')      // «- » на початку репліки в діалогах
  .replace(/\[[^\]]*\]|\([^)]*\)/g, (m) => (/^[[(][A-Z\s]+[\])]$/.test(m) ? '' : m)) // [MUSIC], (LAUGHS)
  .replace(/\s+/g, ' ')
  .trim();

// SRT або WebVTT → [{start, end, text}]
export function parseSubtitles(raw) {
  const cues = [];
  const blocks = raw.replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i === -1) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTime(a);
    const end = parseTime(b.trim().split(/\s+/)[0]);
    const text = lines.slice(i + 1).map(cleanCue).filter(Boolean).join(' ');
    if (start !== null && end !== null && end > start && text) cues.push({ start, end, text });
  }
  return cues;
}

// Зливає короткі репліки у фрагменти 4–15 с, намагаючись різати на кінці речення.
export function mergeCues(cues) {
  const out = [];
  let cur = null;
  for (const c of cues) {
    if (!cur) { cur = { ...c }; continue; }
    const gap = c.start - cur.end;
    const dur = cur.end - cur.start;
    const endsSentence = /[.!?…"”]$/.test(cur.text);
    const tooShort = dur < MIN_SEG || (!endsSentence && dur < 8);
    if (gap < 1.5 && tooShort && c.end - cur.start <= MAX_SEG) {
      cur.end = c.end;
      cur.text = `${cur.text} ${c.text}`;
    } else {
      out.push(cur);
      cur = { ...c };
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…]["”]?)(?<!\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|vs)\.)\s+(?=["“A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Розмовні та стягнені форми зводимо до повних, щоб «gonna» і «going to» вважались однаковими.
const FORMS = [
  [/\bgonna\b/g, 'going to'], [/\bwanna\b/g, 'want to'], [/\bgotta\b/g, 'got to'], [/\bkinda\b/g, 'kind of'],
  [/\bsorta\b/g, 'sort of'], [/\blemme\b/g, 'let me'], [/\bgimme\b/g, 'give me'], [/\bdunno\b/g, 'do not know'],
  [/\by'all\b/g, 'you all'], [/\bya\b/g, 'you'], [/\b'cause\b/g, 'because'], [/\bcuz\b/g, 'because'],
  [/\bok\b/g, 'okay'], [/\bwon't\b/g, 'will not'], [/\bcan't\b/g, 'can not'], [/\bcannot\b/g, 'can not'],
  [/\bshan't\b/g, 'shall not'], [/\bain't\b/g, 'is not'], [/n't\b/g, ' not'], [/'re\b/g, ' are'], [/'m\b/g, ' am'],
  [/'ll\b/g, ' will'], [/'ve\b/g, ' have'], [/'d\b/g, ' would'],
  [/\b(it|that|what|there|here|he|she|who|where|how|let)'s\b/g, (_, w) => (w === 'let' ? 'let us' : `${w} is`)],
];
const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

// Стягнення, набрані без апострофа («dont», «its»), — це не помилка слуху, тож відновлюємо апостроф.
const NO_APOSTROPHE = [
  [/\b(do|does|did|is|was|are|were|could|would|should|have|has|had)nt\b/g, "$1n't"],
  [/\bcant\b/g, "can't"], [/\bwont\b/g, "won't"], [/\bim\b/g, "i'm"],
  [/\b(you|they)re\b/g, "$1're"], [/\b(i|you|we|they)ve\b/g, "$1've"], [/\b(i|you|he|she|we|they)ll\b/g, "$1'll"],
  [/\b(that|what|there|it|let)s\b/g, "$1's"],
];

export function expandForms(text) {
  let t = text.toLowerCase().replace(/[’‘`´]/g, "'");
  for (const [re, rep] of NO_APOSTROPHE) t = t.replace(re, rep);
  for (const [re, rep] of FORMS) t = t.replace(re, rep);
  t = t.replace(/\b(\d{1,2})\b/g, (m, n) => NUMBERS[Number(n)] ?? m);
  return t;
}

// Порівняння для диктанту по розгорнутих формах (у розборі слова показуються вже розгорнутими: «going to»).
export function compareDictation(expected, typed) {
  return diffWords(expandForms(expected), expandForms(typed));
}

// Пропущені слова (для статистики «що найчастіше не чую»).
export const missedWords = (diff) => diff.parts.filter((p) => p.type === 'miss').map((p) => p.word);

const GEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'sentences'],
  properties: {
    title: { type: 'string', description: 'Short English title.' },
    sentences: { type: 'array', items: { type: 'string' }, description: 'The text split into sentences or short utterances, in order.' },
  },
};

// [id, підпис, як назвати формат у промпті]
export const GEN_KINDS = [
  ['dialogue', 'Діалог двох людей', 'a dialogue between two people'],
  ['monologue', 'Монолог / розповідь', 'a spoken monologue or story'],
  ['announcement', 'Оголошення (аеропорт, вокзал)', 'a public announcement (airport, station, store)'],
  ['voicemail', 'Голосове повідомлення', 'a voicemail message'],
];

export async function generateText({ topic, level, kind, sentences = 10 }) {
  const system = `You write short listening-practice texts in natural, spoken American English for a Ukrainian learner moving from B2 to C1.
Make it sound like real speech, not a textbook: contractions, everyday phrasal verbs and idioms, fillers sparingly ("you know", "I mean"), and reduced forms written as people say them where natural ("gonna", "wanna", "kinda").
Level ${level}: ${level === 'C1' ? 'native-like vocabulary and idioms, longer utterances' : level === 'B1' ? 'common words, short clear sentences' : 'natural but clear, some idioms'}.
Each sentence must be 5–20 words so it fits a dictation segment. For dialogues, do not write speaker names; just alternate utterances.
No markdown, no stage directions, no numbers written as digits.`;
  const format = (GEN_KINDS.find(([k]) => k === kind) || GEN_KINDS[1])[2];
  const prompt = `Write ${format}, about ${sentences} sentences, on this topic: ${topic}`;
  const { data, usage, model } = await structured({ system, prompt, schema: GEN_SCHEMA, effort: 'low' });
  return { ...data, usage, model };
}

const TR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ua'],
  properties: { ua: { type: 'string', description: 'Natural Ukrainian translation of the phrase as used in the sentence.' } },
};

export async function translatePhrase(phrase, sentence) {
  const { data } = await structured({
    system: 'Translate an English phrase into natural Ukrainian for a flashcard. Return only the translation of the phrase (not the whole sentence), as it is meant in context.',
    prompt: `Phrase: ${phrase}\nSentence: ${sentence}`,
    schema: TR_SCHEMA,
    effort: 'low',
  });
  return data.ua;
}
