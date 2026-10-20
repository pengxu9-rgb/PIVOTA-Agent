'use strict';

// The find_products_multi request query, normalised for ROUTING before any lane is chosen.
//
// Two independent flags, each off | observe | on (default off), read per call:
//   FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING    non-English beauty terms -> the English term the router
//                                               knows (multilingualBeautyTerms.js).
//   FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING English ingredient negations ("without retinol",
//                                               "no-retinol", "0% retinol") -> "retinol-free", the form
//                                               the search-quality contract already reads
//                                               (strictIngredientQuery.js).
// off: nothing is computed. observe: the normalised query is computed and described on the completion
// log line, and nothing in the request changes. on: the normalised query replaces the routing query.
//
// One guard over both: a query whose normalised form EXCLUDES an ingredient but names no product type
// ("without retinol", "sin retinol", "0% retinol") is left exactly as typed. Rewriting it would turn a
// clarify into a beauty-wide browse, and a bare negation must never widen what is served.
//
// The original text is kept for logs, language detection and replies (the handler passes it on as
// metadata.routing_original_query); the normalised text is used only to route and match.

const {
  multilingualRoutingMode,
  normalizeMultilingualBeautyTerms,
} = require('./multilingualBeautyTerms');
const {
  bareIngredientRoutingMode,
  canonicalizeEnglishIngredientNegations,
  extractExcludedStrictIngredientIds,
  extractPositiveStrictIngredientIds,
  isBareStrictIngredientQuery,
  normalizeForMatch,
  stripNegatedStrictIngredientMentions,
} = require('./strictIngredientQuery');
const { buildSearchQualityContract, resolveBeautyCategoryPathPrefixFromText } = require('./queryUnderstanding');

function runPipeline(original, { multilingual, bareIngredient }) {
  let query = original;
  let terms = [];
  let negation = false;
  if (multilingual) {
    const mapped = normalizeMultilingualBeautyTerms(query);
    if (mapped.applied) {
      query = mapped.query;
      terms = mapped.terms;
    }
  }
  if (bareIngredient) {
    const canonical = canonicalizeEnglishIngredientNegations(query);
    if (canonical.changed) {
      query = canonical.query;
      negation = true;
    }
  }
  if (query === original) return { query: original, changed: false, terms: [], negation: false, guard: null };
  if (isBareIngredientNegationQuery(query)) {
    // `candidate` is what the rewrite would have been; the handler answers it with a safe-empty.
    return { query: original, changed: false, terms: [], negation: false, guard: 'bare_negation_kept', candidate: query };
  }
  return { query, changed: true, terms, negation, guard: null };
}

// Product-form words the category rules do not claim on their own ("balm", "mist", "suncream", ...),
// and generic skincare words: any of them means the query names something to serve.
const PRODUCT_FORM_RE =
  /(?:^|\s)(?:balms?|mists?|sun\s*creams?|suncreams?|oils?|gels?|sticks?|essences?|ampoules?|lotions?|creams?|cremes?|serums?|toners?|masks?|cleansers?|moisturi[sz]ers?|sprays?|foams?|washes|sunscreens?|spf|skin\s*care|skincare|beauty|makeup|cosmetics?)(?=\s|$)/;

// Skin concerns and constraints the contract may not read on their own.
const SKIN_CONCERN_RE =
  /(?:^|\s)(?:anti\s*aging|anti\s*ageing|ageing|aging|wrinkles?|fine\s+lines|acne|blemish(?:es)?|breakouts?|sensitive|sensiti[sz]ed|dry|oily|combination|redness|rosacea|eczema|pregnan\w*|dark\s+spots?|pigmentation|hyperpigmentation|brightening|firming|hydrating|barrier|pores?|dullness)(?=\s|$)/;

// A query that only EXCLUDES ingredients: no ingredient asked for, and nothing to serve once the
// excluded ingredient's own words are set aside -- no product type (in English or in any language the
// multilingual table knows, flag or no flag), no brand, no skin concern or constraint, no generic
// skincare word. "retinol-free", "without retinol", "0% retinol", "retinolfrei" are bare;
// "retinol-free balm", "cerave without retinol", "retinol free for sensitive skin", "pregnancy safe
// no retinol", "retinol free skincare", "retinol-free 크림", "ohne Retinol creme" are not.
function isBareIngredientNegationQuery(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  if (extractExcludedStrictIngredientIds(raw).length === 0) return false;
  if (extractPositiveStrictIngredientIds(raw).length > 0) return false;
  const remainder = stripNegatedStrictIngredientMentions(normalizeForMatch(raw))
    .replace(/(?:^|\s)(?:without(?:\s+any)?|no(?:\s+added)?|non|not|zero|0|avoid(?:ing)?|free(?:\s+(?:of|from))?|sans|sin|ohne|frei(?:\s+von)?|libre\s+de|без|alternatives?(?:\s+to)?|substitutes?(?:\s+for)?|replacements?(?:\s+for)?|instead\s+of|better\s+than|gentler\s+than|phyto|like)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!remainder) return true;
  if (resolveBeautyCategoryPathPrefixFromText(remainder)) return false;
  if (PRODUCT_FORM_RE.test(remainder) || SKIN_CONCERN_RE.test(remainder)) return false;
  if (normalizeMultilingualBeautyTerms(remainder, { contextAvailable: true }).terms.some((term) => term.kind === 'term')) {
    return false;
  }
  const contract = buildSearchQualityContract({ rawQuery: remainder, allowContextBinding: false });
  return contract?.target_domain !== 'beauty';
}

// Returns the query to ROUTE on (`query`, `changed`: only the parts whose flag is on) and the query
// both flags would produce (`shadow`: every part whose flag is observe or on), plus the modes.
function normalizeFindProductsMultiRoutingQuery(rawQuery, env = process.env) {
  const original = typeof rawQuery === 'string' ? rawQuery : '';
  const modes = { multilingual: multilingualRoutingMode(env), bareIngredient: bareIngredientRoutingMode(env) };
  const inactive = { query: original, changed: false, terms: [], negation: false, guard: null };
  const result = { original, modes, ...inactive, shadow: inactive };
  if (!original.trim() || (modes.multilingual === 'off' && modes.bareIngredient === 'off')) return result;
  const applied = runPipeline(original, {
    multilingual: modes.multilingual === 'on',
    bareIngredient: modes.bareIngredient === 'on',
  });
  const shadow = runPipeline(original, {
    multilingual: modes.multilingual !== 'off',
    bareIngredient: modes.bareIngredient !== 'off',
  });
  return { original, modes, ...applied, shadow };
}

// Where the routing query lives in this payload, in the order the context build reads it
// (policy.js buildFindProductsMultiContext): search.query, then payload.query, then the latest user
// message. Returns { text, write(value) } or null.
function locateRoutingQuery(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const looksReal = (text) => typeof text === 'string' && text.trim().length >= 2;
  const search = payload.search && typeof payload.search === 'object' && !Array.isArray(payload.search) ? payload.search : null;
  if (search && looksReal(search.query)) {
    return { source: 'search', text: search.query, write: (value) => { search.query = value; } };
  }
  if (looksReal(payload.query)) {
    return { source: 'payload', text: payload.query, write: (value) => { payload.query = value; } };
  }
  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.user?.conversation_messages)
      ? payload.user.conversation_messages
      : null;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || typeof message !== 'object' || String(message.role || '').toLowerCase() !== 'user') continue;
      if (typeof message.content !== 'string' || !message.content.trim()) continue;
      return { source: 'messages', text: message.content, write: (value) => { message.content = value; } };
    }
  }
  return null;
}

// Completion-log fields: modes, counts and fixed tokens only, never query text.
function buildRoutingQueryLogFields(normalization, extra = {}) {
  if (!normalization || !normalization.modes) return {};
  const { modes } = normalization;
  if (modes.multilingual === 'off' && modes.bareIngredient === 'off') return {};
  const shadow = normalization.shadow || {};
  const kinds = Array.from(new Set((shadow.terms || []).map((term) => term.kind))).sort();
  return {
    fpm_routing_multilingual_mode: modes.multilingual,
    fpm_routing_bare_ingredient_mode: modes.bareIngredient,
    fpm_routing_query_normalized: Boolean(normalization.changed),
    fpm_routing_query_would_normalize: Boolean(shadow.changed),
    ...(shadow.changed ? { fpm_routing_query_terms_mapped: (shadow.terms || []).length } : {}),
    ...(kinds.length ? { fpm_routing_query_term_kinds: kinds } : {}),
    ...(shadow.negation ? { fpm_routing_query_negation: true } : {}),
    ...(shadow.guard ? { fpm_routing_query_guard: shadow.guard } : {}),
    ...(modes.bareIngredient !== 'off'
      ? { fpm_routing_would_bare_ingredient: isBareStrictIngredientQuery(shadow.query || normalization.original) }
      : {}),
    ...extra,
  };
}

module.exports = {
  isBareIngredientNegationQuery,
  normalizeFindProductsMultiRoutingQuery,
  locateRoutingQuery,
  buildRoutingQueryLogFields,
};
