'use strict';

// DID THE ANSWER COME BACK IN THE CATEGORY THE BUYER ASKED FOR?
//
// Nothing in the lane asks this. #2155: "a bronzer for contouring my cheekbones, warm undertone"
// answers with The Ordinary Soothing & Barrier Support Serum at the strongest confidence label the
// surface can emit. The domain rules that would have caught it live in an LLM PROMPT, and the
// catalog path — which serves a real share of turns and produced the three-cleanser answer measured
// on prod 2026-09-09 — never reads a prompt at all. So a prompt can never fix this; the question has
// to be asked after every answer path has converged.
//
// THIS MODULE ONLY REPORTS. It does not empty a shortlist. The precision of the request classifier
// below is what decides whether acting on it is safe, and that number does not exist yet for real
// traffic. Adversarial review found 55 false positives across 129 hand-written needs it wrote
// itself ("dog shampoo" -> haircare, "toner cartridge for my hp printer" -> skincare, "a fan brush
// for watercolour painting" -> beauty_tool). The corpus in the test file is a FLOOR against
// regression, not evidence of precision — #2149 already emptied in-vertical buyers' shortlists once by acting on a signal that
// looked good enough, and the fix was to stop acting on it. Measure first.
//
// Two asymmetric jobs:
//   - the ANSWER side is easy and reliable: catalog rows carry a category_path.
//   - the REQUEST side is a buyer sentence, and is where every bad outcome comes from. It is built
//     for PRECISION, not coverage: a need that does not clearly name a category resolves to null and
//     the whole evaluation returns `unresolved`. Silence is the correct answer far more often than a
//     guess is.

const anchored = (groups) => new RegExp(String.raw`\b(?:${groups.join('|')})\b`, 'i');

// Fold the separators a buyer types between the words of one term onto a single space, same as the
// off-vertical gate does — "anti-aging", "lip_balm" and "makeup/brush" are all one term.
function normalizeForMatch(value) {
  return String(value || '').replace(/[-–—_:/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ONE ENTRY PER CATEGORY, and every pattern here must be a word that names that category and no
// other commerce. The ambiguous nouns (brush, sponge, palette, powder, oil, mask, mist) appear ONLY
// in their qualified forms, copied from the off-vertical gate's own hard-won list: bare `brush`
// matched a wire brush, bare `palette` a laptop colour palette, bare `sponge` a dishwasher sponge.
// A qualifier that the rest of commerce also uses is not a qualifier.
const REQUEST_CATEGORY_PATTERNS = [
  ['makeup', anchored([
    String.raw`makeup|make up|cosmetics?`,
    String.raw`bronzers?|blush(?:es)?|highlighters? (?:powder|stick|palette)|contour\w*`,
    String.raw`foundations?|concealers?|primers?|setting sprays?|setting powders?|bb creams?|cc creams?|tinted moisturi[sz]ers?`,
    String.raw`lipsticks?|lip glosss?|lip gloss(?:es)?|lip liners?|lip tints?`,
    String.raw`mascaras?|eyeliners?|eyeshadows?|brow pencils?|brow gels?`,
    String.raw`(?:eyeshadow|contour|highlight\w*|makeup|blush|bronzer) palettes?`,
  ])],
  ['haircare', anchored([
    String.raw`shampoos?|conditioners?|hair masks?|hair oils?|hair serums?|scalp \w+|dry shampoos?`,
    String.raw`haircare|hair care|leave.?in conditioners?|heat protectants?`,
  ])],
  ['fragrance', anchored([
    String.raw`fragrances?|perfumes?|colognes?|eau de (?:parfum|toilette)|body mists?|scents? for`,
  ])],
  ['beauty_tool', anchored([
    String.raw`(?:makeup|make up|cosmetics?|blush|brow|lash|eyeshadow|eyeliner|foundation|contour|powder|kabuki|fan|blending|stippling|duo fibre|duo fiber|beauty) brush(?:es)?`,
    String.raw`(?:makeup|make up|blending|blender|beauty|konjac|cleansing) sponges?|beauty blenders?`,
    String.raw`gua sha|jade rollers?|derma ?rollers?|facial steamers?|led masks?`,
  ])],
  ['skincare', anchored([
    String.raw`skin ?care|moistur[iy]s?\w*|cleansers?|face washe?s?|toners?|serums?|essences?|ampoules?`,
    String.raw`sunscreens?|spf|retinols?|retinoids?|niacinamide|hyaluronic|ceramides?|salicylic|glycolic|azelaic|vitamin c|peptides?`,
    String.raw`acne|breakouts?|blackheads?|whiteheads?|clogged pores?|wrinkles?|fine lines|dark spots?|hyperpigmentation|rosacea|eczema|melasma`,
    String.raw`eye creams?|face creams?|face oils?|face masks?|sheet masks?|exfoliants?|chemical peels?`,
  ])],
];

/**
 * The category a NEED names, or null when it does not clearly name one.
 *
 * Deliberately refuses to answer when the need matches more than one category: "a fragrance-free
 * moisturiser" names fragrance AND skincare, and picking either would be a guess. An ambiguous need
 * is exactly the one where emptying a shortlist would hurt a real buyer.
 *
 * (An earlier version of this comment used "a bronzer that will not break me out" as the example.
 * That need resolves to makeup, because the skincare family matches `breakouts?` and not "break me
 * out" — the comment described a refusal the code does not make.)
 */
function classifyRecoRequestCategory(requestText) {
  const text = normalizeForMatch(requestText);
  if (!text) return { category: null, reason: 'empty' };
  const hits = [];
  for (const [category, pattern] of REQUEST_CATEGORY_PATTERNS) {
    const match = pattern.exec(text);
    if (match) hits.push({ category, marker: match[0] });
  }
  if (hits.length === 0) return { category: null, reason: 'no_category_named' };
  if (hits.length > 1) {
    // THE MORE SPECIFIC TERM WINS WHEN IT CONTAINS THE OTHER. "a set of makeup brushes" matches
    // beauty_tool via `makeup brushes` and makeup via the bare `makeup` inside it — one term, not
    // two competing ones. Without this the need reads as ambiguous and resolves to null, which is
    // the single most common beauty need this classifier would otherwise refuse to see.
    const containing = hits.filter((hit) =>
      hits.every((other) => other === hit || hit.marker.toLowerCase().includes(other.marker.toLowerCase())));
    if (containing.length === 1) {
      return { category: containing[0].category, reason: 'named_specific', marker: containing[0].marker };
    }
    // Genuinely two different terms — "a serum and a lipstick". Refusing is correct: acting on
    // either reading would call half of what the buyer asked for off-category.
    return { category: null, reason: 'multiple_categories_named', candidates: hits.map((h) => h.category) };
  }
  return { category: hits[0].category, reason: 'named', marker: hits[0].marker };
}

const CATEGORY_PATH_PREFIXES = [
  [/^beauty\/makeup\b/i, 'makeup'],
  [/^beauty\/(?:haircare|hair)\b/i, 'haircare'],
  [/^beauty\/fragrance\b/i, 'fragrance'],
  [/^beauty\/(?:tools?|beauty[_-]?tools?)\b/i, 'beauty_tool'],
  [/^beauty\/(?:skincare|skin[_-]care|body)\b/i, 'skincare'],
];

// THE FIELDS SERVED ROWS ACTUALLY CARRY. An earlier version read `category_path` and called it
// authoritative; review showed served rows do not have one — the catalog builder emits `category`
// (a product type such as 'serum'), and grounded rows keep the catalog product under `sku`. The
// path branch above stayed dead in production while the fixtures injected a shape prod never
// produces. These are the real fields, checked against a live row.
const PRODUCT_TYPE_CATEGORY = [
  [/^(?:bronzer|blush|highlighter|foundation|concealer|primer|lipstick|lip gloss|lip liner|mascara|eyeliner|eyeshadow|brow|setting spray|setting powder|bb cream|cc cream)$/i, 'makeup'],
  [/^(?:shampoo|conditioner|hair mask|hair oil|hair serum|hair treatment|dry shampoo|styling)$/i, 'haircare'],
  [/^(?:fragrance|perfume|cologne|eau de parfum|eau de toilette|body mist)$/i, 'fragrance'],
  [/^(?:brush|makeup brush|sponge|beauty blender|applicator|gua sha|jade roller|device|tool)$/i, 'beauty_tool'],
  [/^(?:cleanser|serum|moisturizer|moisturiser|sunscreen|treatment|toner|essence|ampoule|exfoliant|mask|eye cream|face oil|balm|lotion|cream)$/i, 'skincare'],
];

function categoryFromProductTypeToken(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!token) return null;
  for (const [pattern, category] of PRODUCT_TYPE_CATEGORY) {
    if (pattern.test(token)) return category;
  }
  return null;
}

/**
 * The category an ANSWER ITEM belongs to, or null. category_path is authoritative because the
 * catalog assigns it; the coarse classifier is a fallback for rows that carry none.
 */
function classifyRecoItemCategory(item, { classifyCoarse = null } = {}) {
  if (!item || typeof item !== 'object') return { category: null, reason: 'not_an_item' };
  const path = String(
    item.category_path
    || item.categoryPath
    || (item.product && item.product.category_path)
    || (item.sku && item.sku.category_path)
    || '',
  ).trim();
  if (path) {
    for (const [pattern, category] of CATEGORY_PATH_PREFIXES) {
      if (pattern.test(path)) return { category, reason: 'category_path', path };
    }
  }
  // The fields a served row really has. `product_type` and `step` come from the lane's own
  // normalisation, `category`/`sku.category` from the catalog row.
  for (const [field, value] of [
    ['product_type', item.product_type],
    ['category', item.category],
    ['sku_category', item.sku && item.sku.category],
    ['step', item.step],
  ]) {
    const category = categoryFromProductTypeToken(value);
    if (category) return { category, reason: field };
  }
  if (typeof classifyCoarse === 'function') {
    let coarse = null;
    try {
      coarse = classifyCoarse(item);
    } catch (_err) {
      coarse = null;
    }
    const scope = String((coarse && coarse.domain_scope) || '').trim().toLowerCase();
    // 'bodycare' files under skincare in this catalog's taxonomy (beauty/skincare/moisturize/),
    // measured 2026-09-09; 'unknown' and 'beauty_service' stay unresolved on purpose.
    if (scope === 'makeup' || scope === 'skincare' || scope === 'beauty_tool') {
      return { category: scope, reason: 'coarse_classifier' };
    }
    if (scope === 'bodycare') return { category: 'skincare', reason: 'coarse_classifier_bodycare' };
  }
  return { category: null, reason: 'unclassified' };
}

/**
 * Did the answer come back in the category the request named?
 *
 * `off_category` is deliberately hard to reach: the request must name exactly one category, at least
 * one item must be confidently classified, and EVERY confidently-classified item must disagree. One
 * matching item is enough to make the answer `matched`. Anything less certain is `unresolved`, which
 * is the verdict that must never be acted on.
 */
function evaluateRecoCategoryFidelity({ requestText = '', items = [], classifyCoarse = null } = {}) {
  const request = classifyRecoRequestCategory(requestText);
  const rows = Array.isArray(items) ? items : [];
  const itemCategories = rows.map((item) => classifyRecoItemCategory(item, { classifyCoarse }).category);
  const resolved = itemCategories.filter(Boolean);
  const base = {
    request_category: request.category,
    request_reason: request.reason,
    item_categories: itemCategories,
    resolved_item_count: resolved.length,
    item_count: rows.length,
  };
  if (!request.category) return { ...base, verdict: 'unresolved' };
  if (!rows.length) return { ...base, verdict: 'unresolved' };
  if (!resolved.length) return { ...base, verdict: 'unresolved' };
  const matching = resolved.filter((category) => category === request.category).length;
  if (matching > 0) return { ...base, verdict: 'matched', matching_item_count: matching };
  return { ...base, verdict: 'off_category', matching_item_count: 0 };
}

module.exports = {
  classifyRecoRequestCategory,
  classifyRecoItemCategory,
  evaluateRecoCategoryFidelity,
};
