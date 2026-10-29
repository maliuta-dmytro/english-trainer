// Порівняння відповіді з еталоном на рівні слів (LCS).
// Буде перевикористано в модулі диктанту.

export function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = (text) => normalize(text).split(' ').filter(Boolean);

// Повертає [{type: 'ok'|'miss'|'extra', word}] та частку збігу еталонних слів.
export function diffWords(expected, actual) {
  const a = tokens(expected);
  const b = tokens(actual);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const parts = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { parts.push({ type: 'ok', word: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { parts.push({ type: 'miss', word: a[i] }); i++; }
    else { parts.push({ type: 'extra', word: b[j] }); j++; }
  }
  while (i < a.length) parts.push({ type: 'miss', word: a[i++] });
  while (j < b.length) parts.push({ type: 'extra', word: b[j++] });
  const matched = parts.filter((p) => p.type === 'ok').length;
  const extra = parts.filter((p) => p.type === 'extra').length;
  return { parts, score: a.length ? matched / a.length : 1, exact: matched === a.length && extra === 0 };
}
