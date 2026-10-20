'use strict';

// The find_products_multi request query, normalised for routing BEFORE any lane is chosen.
//
// Two independent flags, both off by default and read per call:
//   FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING   non-English beauty terms -> the English term the router
//                                              knows (multilingualBeautyTerms.js).
//   FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING English ingredient negations ("without retinol",
//                                              "no retinol", "retinol free") -> "retinol-free", the form
//                                              the search-quality contract already reads as a constraint
//                                              (strictIngredientQuery.js).
// Both off: the query is returned untouched and nothing else in the request changes.
//
// The handler writes the result into the request's search.query once, at entry, so every lane, the
// context build and the contract read the same text. The completion log carries counts only, never
// query text.

const {
  isMultilingualRoutingEnabled,
  normalizeMultilingualBeautyTerms,
} = require('./multilingualBeautyTerms');
const {
  isBareIngredientRoutingEnabled,
  canonicalizeEnglishIngredientNegations,
} = require('./strictIngredientQuery');

function normalizeFindProductsMultiRoutingQuery(rawQuery, env = process.env) {
  const original = typeof rawQuery === 'string' ? rawQuery : '';
  const multilingual = isMultilingualRoutingEnabled(env);
  const bareIngredient = isBareIngredientRoutingEnabled(env);
  const result = { query: original, changed: false, terms: [], negation_canonicalized: false };
  if (!original.trim() || (!multilingual && !bareIngredient)) return result;
  let query = original;
  if (multilingual) {
    const mapped = normalizeMultilingualBeautyTerms(query);
    if (mapped.applied) {
      query = mapped.query;
      result.terms = mapped.terms;
    }
  }
  if (bareIngredient) {
    const negation = canonicalizeEnglishIngredientNegations(query);
    if (negation.changed) {
      query = negation.query;
      result.negation_canonicalized = true;
    }
  }
  result.query = query;
  result.changed = query !== original;
  return result;
}

// Rewrites search.query (and a top-level payload.query) in place when normalisation changed it.
// Returns true when anything was written.
function applyRoutingQueryToPayload(payload, normalization) {
  if (!normalization || !normalization.changed) return false;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  let wrote = false;
  const search = payload.search;
  if (search && typeof search === 'object' && !Array.isArray(search) && typeof search.query === 'string') {
    search.query = normalization.query;
    wrote = true;
  } else if (typeof payload.query === 'string') {
    payload.query = normalization.query;
    wrote = true;
  }
  return wrote;
}

// Completion-log fields: counts and fixed tokens only.
function buildRoutingQueryLogFields(normalization) {
  if (!normalization || !normalization.changed) return {};
  const kinds = Array.from(new Set((normalization.terms || []).map((term) => term.kind))).sort();
  return {
    fpm_routing_query_normalized: true,
    fpm_routing_query_terms_mapped: (normalization.terms || []).length,
    ...(kinds.length ? { fpm_routing_query_term_kinds: kinds } : {}),
    ...(normalization.negation_canonicalized ? { fpm_routing_query_negation: true } : {}),
  };
}

module.exports = {
  normalizeFindProductsMultiRoutingQuery,
  applyRoutingQueryToPayload,
  buildRoutingQueryLogFields,
};
