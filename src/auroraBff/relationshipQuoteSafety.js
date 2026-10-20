// What a relationship quote must be before it can stand as evidence or reach a shopper (2026-10-20).
// The reviewer's validator (scripts/review-relationship-candidate-labels.js, validator v3) grounds each
// quote in the product's facts and stores only specific, showable ones; the edge reader
// (productRelationshipGraph.js coerceRelationshipEdge) applies the display half to rows written before
// v3, so every serving path (similar items, PDP rails, agent signals) reads the same why_candidate.

// Words that prove nothing about a pair on their own: category nouns, and base ingredients nearly every
// product has. "Toner / toner" says only that both are toners.
const GENERIC_QUOTE_SPAN = new RegExp('^(?:beauty|skincare|makeup|cosmetics|cosmetic|face|body|skin|cream|serum|water|aqua|glycerin|'
  + 'fragrance|parfum|alcohol|toner|cleanser|moisturizer|moisturiser|lotion|essence|ampoule|mask|shampoo|conditioner|'
  + 'lipstick|mascara|foundation|primer|perfume|cologne|balm|gel|product|products)$');
// Function words: "of the" / "with a" are not facts.
const QUOTE_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'or', 'for', 'to', 'in', 'on', 'by', 'from', 'at', 'as',
  'is', 'are', 'be', 'this', 'that', 'these', 'those', 'your', 'our', 'its', 'it', 'all', 'any', 'more', 'most', 'very', 'so',
  'than', 'into', 'up', 'out', 'new', 'plus', 'each', 'per']);
// Short actives a shopper does compare on; they count as specific despite their length.
const SHORT_ACTIVES = new Set(['aha', 'bha', 'pha', 'spf', 'uva', 'uvb', 'cica', 'pdrn', 'egf', 'hpr', 'ph']);
// CJK category nouns and base ingredients (Korean, Chinese, Japanese), the same idea as the English list.
const CJK_GENERIC = new Set(['크림', '세럼', '토너', '스킨', '에센스', '앰플', '로션', '마스크', '샴푸', '린스', '향수', '화장품',
  '정제수', '물', '글리세린', '향료', '알코올', '精华', '精華', '面霜', '乳液', '化妆水', '化粧水', '爽肤水', '水', '甘油', '香精', '香料', '酒精',
  '美容液', 'クリーム', 'セラム', 'ローション', 'トナー', 'マスク', 'シャンプー', 'グリセリン', '化粧品', '香水']);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// NFKC leaves curly apostrophes and quotes alone; "isn’t" must read as "isn't".
function foldQuoteText(value) {
  return String(value || '').normalize('NFKC').replace(/[‘’ʼ′]/g, "'").replace(/[“”″]/g, '"');
}
function normalizeQuoteText(value) {
  return foldQuoteText(value).toLowerCase().replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?)\]])/g, '$1').replace(/([.,;:!?])(?=[\p{L}])/gu, '$1 ').trim();
}
function quoteWords(value) {
  return normalizeQuoteText(value).split(/[^\p{L}\p{N}%]+/u).filter(Boolean);
}

// The brand as a quote can name it: the brand field, plus the native-script name a product's title opens
// with when the brand field is Latin ("에뛰드 ..." for ETUDE). Titles lead with the brand on these sites.
function brandAliases(product) {
  const brand = product && typeof product.brand === 'string' ? product.brand : '';
  const title = product && typeof (product.title || product.name) === 'string' ? (product.title || product.name) : '';
  const first = quoteWords(title)[0] || '';
  return CJK.test(first) && !CJK.test(brand) ? `${brand} ${first}` : brand;
}

// Specific: a curated short active, a CJK word of two or more characters, two or more words of which
// one is a real word of three or more characters, or one real word of four or more. Generic words,
// stopwords and every word of the brand never count.
function quotePartIsSpecific(part, brandValue = '') {
  const brandWords = new Set(quoteWords(brandValue));
  const words = quoteWords(part).filter((word) => !brandWords.has(word));
  if (words.some((word) => SHORT_ACTIVES.has(word))) return true;
  const meaningful = words.filter((word) => !GENERIC_QUOTE_SPAN.test(word) && !QUOTE_STOPWORDS.has(word) && !CJK_GENERIC.has(word));
  if (meaningful.some((word) => CJK.test(word) && [...word].length >= 2)) return true;
  if (words.length >= 2) return meaningful.some((word) => word.length >= 3);
  return meaningful.length === 1 && meaningful[0].length >= 4;
}

// One fact's shape: never stitched (an ellipsis) and never JSON-shaped (a quote-colon, a quote at a
// bracket, a brace). Brackets alone are text: titles carry them ("[THE ORDINARY] Retinol 0.2%").
function hasQuoteShape(text) {
  const value = typeof text === 'string' ? foldQuoteText(text) : '';
  return Boolean(value.trim()) && !/\.\.\.|…|"\s*:|\[\s*"|"\s*\]|[{}]/.test(value);
}
// Shown only when it is one specific fact.
function isShowableQuote(text, brand = '') {
  return hasQuoteShape(text) && quotePartIsSpecific(text, brand);
}

// The builder's fixed reasons, for a why_candidate left with nothing to show. Never the row's own
// summary: before 2026-10-01 (d24db0192) that was the model's recommendation_reason, and renewal keeps
// such rows alive for up to 180 days without revalidation.
const DEFAULT_REASONS_USER_VISIBLE = ['Category/use-case evidence is aligned.', 'Source provenance is available.'];

// why_candidate with unshowable shared_evidence pairs removed, and the "anchor / candidate" reasons
// built from them. Other reasons (the builder's own copy) are left alone; when nothing is left to show,
// the fixed default reasons stand in rather than an empty list.
function sanitizeWhyCandidateQuotes(why, { anchorBrand = '', candidateBrand = '', anchor = null, candidate = null } = {}) {
  if (anchor) anchorBrand = brandAliases(anchor);
  if (candidate) candidateBrand = brandAliases(candidate);
  if (!why || typeof why !== 'object' || Array.isArray(why) || !Array.isArray(why.shared_evidence)) return why;
  const kept = [];
  const dropped = new Set();
  for (const item of why.shared_evidence) {
    const anchor = item && item.anchor_fact; const candidate = item && item.candidate_fact;
    if (isShowableQuote(anchor, anchorBrand) && isShowableQuote(candidate, candidateBrand)) kept.push(item);
    else dropped.add(`${anchor} / ${candidate}`);
  }
  if (!dropped.size) return why;
  const out = { ...why, shared_evidence: kept };
  if (Array.isArray(why.reasons_user_visible)) {
    const reasons = why.reasons_user_visible.filter((reason) => !dropped.has(reason));
    out.reasons_user_visible = reasons.length ? reasons : [...DEFAULT_REASONS_USER_VISIBLE];
  }
  return out;
}

module.exports = {
  GENERIC_QUOTE_SPAN, QUOTE_STOPWORDS, SHORT_ACTIVES, foldQuoteText, normalizeQuoteText, quoteWords, quotePartIsSpecific,
  hasQuoteShape, isShowableQuote, sanitizeWhyCandidateQuotes, DEFAULT_REASONS_USER_VISIBLE, CJK_GENERIC, brandAliases,
};
