/**
 * Beauty relevance gate — the single home for post-recall category/relevance
 * matching (recall-lane assessment, Class 2).
 *
 * WHY THIS MODULE EXISTS. As of 2026-08-01 the codebase carried EIGHT
 * divergent category-matcher implementations, each grown lane-locally inside
 * server.js. The divergence is not cosmetic: the 2026-07-31 release-gate
 * incident chain crossed three of them (the 4-form-word strict extractor, the
 * category-path prefix matcher, and the parent-scope floor added by PR #1889),
 * and a hole in any one of them is invisible to every other lane's tests.
 * Phase A consolidates the STRICT-side matchers here verbatim — server.js
 * keeps thin delegates so call sites and behavior are unchanged — which makes
 * this file the one place the vocabulary lives and the one place it gets
 * fixed.
 *
 * PHASE B (not here): unify the remaining variants, which deliberately stay
 * behind because each carries lane-specific behavior that must be measured
 * before merging vocabularies:
 *   - beautyProductMatchesFamily (server.js): regex families that match
 *     INGREDIENT names as form words ("niacinamide" matches the serum
 *     family) — cannot serve as a category floor as-is.
 *   - filterBeautyMainlineProductsByQuery / scoreBeautyMainlineProduct
 *     (server.js): the mainline's relevance gate; masks bucket-browse noise.
 *   - classifyBeautyBucketFromText (server.js): bucket classifier.
 *   - beautyProductMatchesCategoryPathQuery (server.js): prefix matcher with
 *     per-prefix fallback-text regexes (depends on buildFallbackCandidateText).
 *   - resolveBeautyCategoryPathPrefixForQuery (externalSeedProducts.js): the
 *     query→prefix resolver and its BEAUTY_CATEGORY_* taxonomy tables.
 * A Phase B change here should REPLACE one of those, never add a ninth.
 */

'use strict';

function normalizeSearchTextForMatch(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) return text;
  }
  return '';
}

// The strict lane's skincare form vocabulary. A query naming one of these
// forms pins results to that form; a query naming none (bare ingredient
// queries like "niacinamide") yields no form intent — which is exactly why
// the category-path floor below exists as a second, independent gate.
const SKINCARE_FORM_TERMS = Object.freeze([
  'serum',
  'moisturizer',
  'cleanser',
  'toner',
]);

function extractSkincareFormIntents(queryText) {
  const normalizedQuery = normalizeSearchTextForMatch(String(queryText || ''));
  if (!normalizedQuery) return [];
  return SKINCARE_FORM_TERMS.filter((term) =>
    normalizedQuery.includes(normalizeSearchTextForMatch(term)),
  );
}

// Form -> title/text synonym pattern. ONE vocabulary, two consumers: the
// serving-side form filter below, and the release gate's precision scoring
// (scripts/search_stability_matrix.js `form:` tokens).
//
// Why the gate needs this: scoring category precision by naive substring match
// on the query word is wrong, and wrong in a way that invents phantom bugs.
// "Pixi Glow Tonic" IS a toner; "Revitalising Cleansing Gel" IS a cleanser —
// neither contains the query string. Measured live 2026-08-04, substring
// scoring under-reported toner precision as 3/10 when the true value was 9/10,
// and that phantom nearly sent us chasing a serving regression that did not
// exist. Beauty categories are synonym-rich; the ruler has to know that.
//
// The first four entries are the EXACT patterns the serving-side filter has
// always used — moved here verbatim, not rewritten, so serving behavior is
// unchanged. Entries past them are measurement vocabulary (makeup and hair
// forms the strict skincare filter never handled).
const FORM_TITLE_PATTERNS = Object.freeze({
  // --- serving-side (verbatim; changing these changes recall) -------------
  serum: /\b(serum|essence|ampoule|concentrate|booster|treatment)\b|精华|精華|美容液/i,
  moisturizer: /\b(moisturi[sz]er|cream|gel\s*cream|barrier\s*cream|repair\s*cream|lotion|balm)\b|面霜|乳液|保湿|保濕/i,
  cleanser: /\b(cleanser|cleansing|face\s*wash|facial\s*wash|wash\s*gel|cleansing\s*(?:foam|gel|milk|oil|balm))\b|洁面|潔面|洗顔/i,
  toner: /\b(toner|tonic|lotion|essence\s*water|skin\s*booster)\b|爽肤水|化妆水|化粧水/i,
  // --- measurement vocabulary --------------------------------------------
  sunscreen: /\b(sunscreen|sun\s*screen|sunblock|spf|uv\s*(?:filter|protect\w*)|sun\s*(?:cream|fluid|stick|milk))\b|防晒|防曬/i,
  mask: /\b(mask|masque|sheet\s*mask|sleeping\s*mask|pack)\b|面膜/i,
  exfoliant: /\b(exfoliant|exfoliating|exfoliator|peel(?:ing)?|scrub|aha|bha|pha)\b|去角质|去角質/i,
  bronzer: /\b(bronzer|bronzing|contour(?:ing)?|self[-\s]*tan\w*)\b/i,
  highlighter: /\b(highlighter|highlighting|illuminat\w+|luminizer|glow\s*(?:stick|drops|balm))\b/i,
  blush: /\b(blush(?:er)?|cheek\s*(?:tint|colou?r|stain))\b|腮红|腮紅/i,
  lipstick: /\b(lipstick|lip\s*stick|lip\s*colou?r|lip\s*tint|rouge)\b|口红|口紅|唇膏/i,
  mascara: /\b(mascara|lash\s*(?:volumiz\w+|lengthen\w+))\b|睫毛膏/i,
  eyeshadow: /\b(eye\s*shadow|eyeshadow|shadow\s*palette)\b|眼影/i,
  foundation: /\b(foundation|skin\s*tint|bb\s*cream|cc\s*cream)\b|粉底/i,
  concealer: /\b(concealer|corrector)\b|遮瑕/i,
  shampoo: /\b(shampoo)\b|洗发|洗髮/i,
  conditioner: /\b(conditioner|conditioning\s*(?:mask|treatment)?)\b|护发素|護髮素/i,
});

/**
 * Does a product TITLE (or any text) denote the given product form?
 * Synonym-aware — this is the ruler for measurement code. Unknown forms fall
 * back to a plain substring test so a typo fails closed-ish rather than
 * matching everything.
 */
function titleMatchesForm(title, form) {
  const text = String(title || '');
  const key = String(form || '').trim().toLowerCase();
  if (!text || !key) return false;
  const pattern = FORM_TITLE_PATTERNS[key];
  if (pattern) return pattern.test(text);
  return normalizeSearchTextForMatch(text).includes(normalizeSearchTextForMatch(key));
}

function productMatchesSkincareFormIntent(product = {}, categoryIntent = '') {
  if (!product || typeof product !== 'object' || Array.isArray(product)) return false;
  const intent = normalizeSearchTextForMatch(categoryIntent);
  if (!intent) return true;
  const visibleText = normalizeSearchTextForMatch(
    [
      product.title,
      product.name,
      product.product_name,
      product.display_name,
      product.product_type,
      product.category,
      product.catalog_category_path,
      Array.isArray(product.category_path) ? product.category_path.join(' ') : product.category_path,
      product.canonical_url,
      product.destination_url,
      product.url,
      product.merchant_canonical_url,
    ]
      .filter(Boolean)
      .join(' '),
  );
  if (!visibleText) return false;
  // Serving keeps EXACTLY its historical vocabulary: only the four skincare
  // forms it has always handled, via the same patterns (now shared above).
  // The wider measurement vocabulary must NOT leak into recall.
  if (SKINCARE_FORM_TERMS.includes(intent)) {
    return FORM_TITLE_PATTERNS[intent].test(visibleText);
  }
  return visibleText.includes(intent);
}

function filterProductsBySkincareFormIntents(products = [], categoryIntents = []) {
  const list = Array.isArray(products) ? products.filter(Boolean) : [];
  const intents = Array.isArray(categoryIntents)
    ? categoryIntents.map((value) => normalizeSearchTextForMatch(value)).filter(Boolean)
    : [];
  if (list.length === 0 || intents.length === 0) {
    return {
      products: list,
      applied: false,
      filtered_out_count: 0,
      category_intents: intents,
    };
  }
  const filtered = list.filter((product) =>
    intents.every((intent) => productMatchesSkincareFormIntent(product, intent)),
  );
  return {
    products: filtered,
    applied: true,
    filtered_out_count: Math.max(0, list.length - filtered.length),
    category_intents: intents,
  };
}

function getProductCategoryPathText(product = {}) {
  const raw = firstNonEmptyString(
    product.catalog_category_path,
    Array.isArray(product.category_path) ? product.category_path.join('/') : product.category_path,
    product.categoryPath,
    product.seed_data?.category_path,
    product.snapshot?.category_path,
  );
  return String(raw || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
}

function productMatchesCategoryPathPrefix(product = {}, categoryPathPrefix = '') {
  const prefix = String(categoryPathPrefix || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!prefix) return false;
  const path = getProductCategoryPathText(product);
  if (!path) return false;
  return path === prefix || path.startsWith(`${prefix}/`);
}

// Parent scope of a resolved category prefix: beauty/skincare/treat/ ->
// beauty/skincare. This is the category FLOOR for ingredient-lane recall
// (PR #1889): the catalog runs competing taxonomies
// (beauty/skincare/treat/serum AND flat beauty/skincare/serum AND bare
// beauty/skincare), so flooring on the resolved prefix itself would exclude
// the literal PDPs the recall fix exists to surface — the parent admits all
// three trees while still excluding bodycare / haircare / makeup.
function categoryPathParentScope(categoryPathPrefix) {
  const resolved = String(categoryPathPrefix || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (!resolved) return '';
  const parts = resolved.split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : resolved;
}


// --- multi-product sets / bundles ------------------------------------------
// A shopper asking for "bronzer" wants a bronzer, not a discovery set. Prod
// 2026-08-04: 14 of 120 served rows across 12 category queries were sets, and
// they cluster in makeup (bronzer 4/10, blush 4/10, highlighter 2/10).
//
// THE CATEGORY SIGNAL IS USELESS HERE — verified, not assumed. All 14 rows
// carried the SINGLE-product category: "The Mini Discovery Set" is stored as
// category=Bronzer, product_type=Bronzer. Zero sat under beauty/sets/*. The
// merchant/harvester categorises a bundle by the department it sells into, so
// the title is the only available signal.
const MULTI_PRODUCT_TITLE_PATTERN =
  /\b(sets?|kits?|bundles?|duos?|trios?|collections?|discovery|value\s*pack|pack\s*of|\d+\s*(?:pc|pcs|piece)s?|routines?)\b|套装|套裝|礼盒|禮盒/i;

// Queries that ASK for a bundle. When the shopper says "set"/"kit"/"gift", a
// bundle is the right answer and must not be demoted.
const MULTI_PRODUCT_QUERY_PATTERN =
  /\b(sets?|kits?|bundles?|duos?|trios?|collections?|discovery|gift|routines?|starter)\b|套装|套裝|礼盒|禮盒/i;

/** Does this TITLE denote a multi-product bundle rather than one product? */
function titleLooksLikeMultiProductSet(title) {
  const text = String(title || '').trim();
  if (!text) return false;
  return MULTI_PRODUCT_TITLE_PATTERN.test(text);
}

/** Did the QUERY ask for a bundle? If so, bundles are on-intent. */
function queryWantsMultiProductSet(queryText) {
  const text = String(queryText || '').trim();
  if (!text) return false;
  return MULTI_PRODUCT_QUERY_PATTERN.test(text);
}

module.exports = {
  normalizeSearchTextForMatch,
  MULTI_PRODUCT_TITLE_PATTERN,
  titleLooksLikeMultiProductSet,
  queryWantsMultiProductSet,
  FORM_TITLE_PATTERNS,
  titleMatchesForm,
  SKINCARE_FORM_TERMS,
  extractSkincareFormIntents,
  productMatchesSkincareFormIntent,
  filterProductsBySkincareFormIntents,
  getProductCategoryPathText,
  productMatchesCategoryPathPrefix,
  categoryPathParentScope,
};
