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
  if (intent === 'serum') {
    return /\b(serum|essence|ampoule|concentrate|booster|treatment)\b|精华|精華|美容液/i.test(visibleText);
  }
  if (intent === 'moisturizer') {
    return /\b(moisturi[sz]er|cream|gel\s*cream|barrier\s*cream|repair\s*cream|lotion|balm)\b|面霜|乳液|保湿|保濕/i.test(visibleText);
  }
  if (intent === 'cleanser') {
    return /\b(cleanser|cleansing|face\s*wash|facial\s*wash|wash\s*gel|cleansing\s*(?:foam|gel|milk|oil|balm))\b|洁面|潔面|洗顔/i.test(visibleText);
  }
  if (intent === 'toner') {
    return /\b(toner|tonic|lotion|essence\s*water|skin\s*booster)\b|爽肤水|化妆水|化粧水/i.test(visibleText);
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

module.exports = {
  normalizeSearchTextForMatch,
  SKINCARE_FORM_TERMS,
  extractSkincareFormIntents,
  productMatchesSkincareFormIntent,
  filterProductsBySkincareFormIntents,
  getProductCategoryPathText,
  productMatchesCategoryPathPrefix,
  categoryPathParentScope,
};
