function normalizeText(input) {
  if (!input) return '';
  return String(input)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTitleCaseWord(w) {
  if (!w) return '';
  const s = String(w);
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function toTitleCaseToken(token) {
  const t = String(token || '').trim();
  if (!t) return '';
  return t.split('-').map(toTitleCaseWord).join('-');
}

module.exports = {
  normalizeText,
  toTitleCaseWord,
  toTitleCaseToken,
};
