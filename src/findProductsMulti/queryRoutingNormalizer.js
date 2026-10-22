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
// With the bare-ingredient flag, a query that only excludes ingredients is rewritten to what it asks
// for (rewriteExclusionQuery: a known or named stand-in, or the body area it names), "<ingredient> like
// <brand>" becomes "<brand> <ingredient>", and the response door's rules (routingDoor) are read from the
// query before any rewrite.
//
// One guard over both: a query whose normalised form EXCLUDES an ingredient but names no product type
// ("without retinol", "sin retinol", "0% retinol") is left exactly as typed. Rewriting it would turn a
// clarify into a beauty-wide browse, and a bare negation must never widen what is served.
//
// The original text is kept for logs, language detection and replies (the handler keeps it in its own
// variable and hands it to the context build; never in caller-visible metadata); the normalised text is
// used only to route and match.

const {
  multilingualRoutingMode,
  normalizeMultilingualBeautyTerms,
} = require('./multilingualBeautyTerms');
const {
  KNOWN_STAND_INS,
  STAND_IN_ACTIVE_ALIASES,
  bareIngredientRoutingMode,
  canonicalizeEnglishIngredientNegations,
  extractExcludedStrictIngredientIds,
  extractPositiveStrictIngredientIds,
  extractStandInOnlyStrictIngredientIds,
  isBareStrictIngredientQuery,
  normalizeForMatch,
  stripNegatedStrictIngredientMentions,
  strictIngredientNamingTerms,
} = require('./strictIngredientQuery');
const { buildSearchQualityContract, resolveBeautyCategoryPathPrefixFromText } = require('./queryUnderstanding');
const { resolveBeautyBrandBrowseQuery } = require('./brandLexicon');

// What the response door enforces for this query (see server.js): rows naming an excluded ingredient
// are dropped, rows not naming a required one (a stand-in the query asked for) are dropped, and rows
// outside the scope are dropped. Read from the query BEFORE any rewrite below, so a rewrite never
// loses an exclusion ("bakuchiol instead of retinol" -> "bakuchiol" still excludes retinol).
function routingDoor(text, requiredIds = []) {
  return {
    excludedIds: extractExcludedStrictIngredientIds(text),
    requiredIds,
    scopePrefix: exclusionCategoryScope(text),
  };
}

function runPipeline(original, { multilingual, bareIngredient }) {
  let query = original;
  let terms = [];
  let negation = false;
  let rewrite = null;
  let door = null;
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
    // Before any rewrite: the exclusions and the scope are the query's own.
    door = routingDoor(query);
    const fromBrand = rewriteIngredientLikeBrandQuery(query);
    if (fromBrand.query !== query) {
      query = fromBrand.query;
      rewrite = 'ingredient_like_brand';
      door = { ...door, requiredIds: fromBrand.requiredIds };
    }
    const exclusion = rewriteExclusionQuery(query);
    if (exclusion.kind) {
      query = exclusion.query;
      negation = true;
      rewrite = exclusion.kind;
      door = { ...door, requiredIds: exclusion.requiredIds };
    }
  }
  if (query === original) return { query: original, changed: false, terms: [], negation: false, rewrite: null, guard: null, door };
  if (isBareIngredientNegationQuery(query)) {
    // `candidate` is what the rewrite would have been; the handler answers it with a safe-empty.
    return { query: original, changed: false, terms: [], negation: false, rewrite: null, guard: 'bare_negation_kept', candidate: query, door };
  }
  return { query, changed: true, terms, negation, rewrite, guard: null, door };
}

// "<ingredient> like <brand>" asks for that ingredient FROM that brand (the brand's version of it):
// "retinol like the ordinary" -> "the ordinary retinol", and the door keeps only rows that name the
// ingredient (the brand browse that query lands in serves every row of the brand). Only when the head
// is nothing but table ingredients and the tail is nothing but a known beauty brand; "products like
// retinol", "retinol like results" are unchanged. Returns { query, requiredIds }.
function rewriteIngredientLikeBrandQuery(query) {
  const unchanged = { query, requiredIds: [] };
  const match = String(query || '').match(/^\s*(.+?)\s+like\s+(.+?)\s*$/i);
  if (!match) return unchanged;
  const [, head, tail] = match;
  if (!isBareStrictIngredientQuery(head)) return unchanged;
  const brand = resolveBeautyBrandBrowseQuery(tail);
  if (!brand || !brand.matched || !brand.brand_only) return unchanged;
  return { query: `${tail.trim()} ${head.trim()}`, requiredIds: extractPositiveStrictIngredientIds(head) };
}

// Body areas a query can name. hair and lip have a category the contract routes ("hair care",
// "lip treatment") and a scope; the others have no category of their own (body care is spread over
// several trees), so they keep the query's own route and get no scope -- never skincare.
const AREA_PATTERNS = Object.freeze([
  ['hair', /(?:^|\s)(?:hair|scalp|haircare|shampoos?|conditioners?|hairsprays?|pomades?)(?=\s|$)/],
  ['lip', /(?:^|\s)lips?(?=\s|$)/],
  ['other', /(?:^|\s)(?:body|bodies|nails?|cuticles?|soaps?|hands?|feet|foot|bath|shower|deodorants?|men|mens|man|male|beard)(?=\s|$)/],
]);
const AREA_SCOPE = Object.freeze({ hair: 'beauty/haircare/', lip: 'beauty/makeup/lip/', other: null });
// The words that name ONLY the area (not a product form like "shampoo"), and the phrase the contract
// routes to that area's category.
const AREA_ONLY_WORDS = Object.freeze({ hair: ['hair', 'scalp'], lip: ['lip', 'lips'] });
const AREA_NOUN = Object.freeze({ hair: 'hair care', lip: 'lip treatment' });

// The single area normalised text names, 'mixed' for more than one, or null.
function areaOf(normalizedText) {
  const found = AREA_PATTERNS.filter(([, pattern]) => pattern.test(normalizedText)).map(([area]) => area);
  if (found.length === 0) return null;
  return found.length === 1 ? found[0] : 'mixed';
}

// Words a query that only EXCLUDES ingredients may carry besides them: the qualifier words themselves
// and the filler words a bare query may carry.
const EXCLUSION_QUALIFIER_WORDS = new Set([
  'alternative', 'alternatives', 'to', 'substitute', 'substitutes', 'replacement', 'replacements', 'for',
  'instead', 'of', 'better', 'gentler', 'than', 'faux', 'pseudo', 'phyto',
  'without', 'any', 'no', 'added', 'non', 'not', 'zero', '0', 'avoid', 'avoiding', 'free', 'from',
  'sans', 'sin', 'ohne', 'frei', 'freie', 'freier', 'freies', 'freien', 'freiem', 'von', 'libre', 'de',
  'без', 'не', 'содержит',
  'a', 'an', 'the', 'some', 'me', 'my', 'i', 'best', 'top', 'good', 'great', 'popular',
  'product', 'products', 'item', 'items', 'shop', 'buy', 'find', 'show', 'search', 'get', 'want', 'need',
  'looking', 'recommend', 'recommendation', 'recommendations', 'please', 'with', 'something',
  // list words between the excluded ingredients ("instead of retinol and niacinamide")
  'and', 'or', 'nor',
  // marketing words
  'premium', '프리미엄', 'プレミアム',
  // face and skin ARE skincare, the default area: "retinol alternative for my face" is a bare stand-in ask
  'face', 'faces', 'facial', 'skin', 'complexion',
]);
// Price words and budgets are not something to serve, and they travel with the rewrite (below), so the
// price cap the rest of the pipeline reads from them still applies.
const PRICE_WORDS = new Set([
  'cheap', 'cheaper', 'cheapest', 'affordable', 'budget', 'inexpensive', 'low', 'cost', 'priced', 'price',
  'under', 'below', 'less', 'than', 'max', 'maximum', 'up', 'to', 'dollar', 'dollars', 'usd', 'bucks',
]);
const PRICE_ADJECTIVE_RE = /(?<![\p{L}\p{N}])(?:cheap|cheaper|cheapest|affordable|budget|inexpensive|low[-\s]cost)(?![\p{L}\p{N}])/giu;
const BUDGET_PHRASE_RE =
  /(?<![\p{L}\p{N}])(?:under|below|less\s+than|max(?:imum)?|up\s+to)\s*(?:\$|usd\s*)?\d+(?:\.\d+)?\s*(?:\$|usd|dollars?|bucks)?(?![\p{L}\p{N}])|\$\s*\d+(?:\.\d+)?/giu;

// The price words and budget phrases of a raw query, in order, to carry onto a rewrite.
function pricePhrases(rawQuery) {
  const raw = String(rawQuery || '');
  const adjectives = (raw.match(PRICE_ADJECTIVE_RE) || []).map((value) => value.trim().toLowerCase());
  const budgets = (raw.match(BUDGET_PHRASE_RE) || []).map((value) => value.trim().replace(/\s+/g, ' '));
  return { before: adjectives.join(' '), after: budgets.join(' ') };
}
const INGREDIENT_ENGLISH_NAME = Object.freeze({ ascorbic_acid: 'vitamin c', ceramide_np: 'ceramide' });
const ingredientName = (id) => INGREDIENT_ENGLISH_NAME[id] || id.replace(/_/g, ' ');

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The words of normalised text left after the given ingredients' terms (qualified or not) and every
// qualifier, filler or zero-percent word are set aside.
function exclusionRemainderWords(normalized, ids) {
  let text = ` ${normalized} `;
  const terms = Array.from(new Set(ids.flatMap((id) => strictIngredientNamingTerms(id)))).sort((a, b) => b.length - a.length);
  for (const term of terms) text = text.replace(new RegExp(`\\s${escapeRegExp(term)}(?=\\s|frei)`, 'g'), ' ');
  return text.split(/\s+/).filter((word) => word && !EXCLUSION_QUALIFIER_WORDS.has(word));
}

// The remainder words that name something to serve: price words and plain numbers (a budget, a bare
// zero left by "retinol 0") are not.
function servableRemainderWords(words) {
  return words.filter((word) => !PRICE_WORDS.has(word) && !/^\d+(?:\.\d+)?$/.test(word));
}

// A query that EXCLUDES ingredients and names nothing else to serve but, at most, a body area or a
// stand-in active. Rewritten so the contract routes what it asks for:
//   - it names a stand-in active ("bakuchiol instead of retinol", "retinol-free bakuchiol"): that
//     active is the ask -> "bakuchiol" (kind stand_in_named);
//   - it only asks for a stand-in, with no area, and every excluded ingredient has a known stand-in
//     ("retinol alternative", "alternative to retinol", "faux retinol", "phyto retinol"): the known
//     stand-in is the ask -> "bakuchiol" (kind stand_in_known);
//   - it names hair or lips ("retinol alternative for hair", "without glycerin for hair"): the area's
//     own category, without the ingredient -> "retinol-free hair care", "retinol-free lip treatment"
//     (kind area).
// The door keeps the exclusion, requires the asked-for stand-in, and scopes the page (routingDoor).
// Anything else is unchanged: a bare stand-in with no known stand-in ("niacinamide alternative") or a
// bare absence ("without retinol") names nothing to serve and is answered as a bare negation (a
// clarify), the same for every ingredient; a query naming a product type, a concern, a brand or any
// other area keeps its own route.
function rewriteExclusionQuery(query) {
  const unchanged = { query, kind: null, requiredIds: [] };
  const excluded = extractExcludedStrictIngredientIds(query);
  if (excluded.length === 0) return unchanged;
  const wanted = extractPositiveStrictIngredientIds(query);
  const standInActives = Object.values(STAND_IN_ACTIVE_ALIASES);
  if (wanted.some((id) => !standInActives.includes(id))) return unchanged;
  const normalized = normalizeForMatch(query);
  const rest = servableRemainderWords(exclusionRemainderWords(normalized, [...excluded, ...wanted]));
  const area = areaOf(rest.join(' '));
  if (area === 'mixed' || area === 'other') return unchanged;
  const restWithoutArea = rest.filter((word) => !(area && AREA_ONLY_WORDS[area].includes(word)));
  if (restWithoutArea.length > 0) return unchanged;
  const price = pricePhrases(query);
  const withArea = (text) => [price.before, area ? `${text} ${AREA_NOUN[area]}` : text, price.after].filter(Boolean).join(' ');
  if (wanted.length > 0) {
    return { query: withArea(wanted.map(ingredientName).join(' ')), kind: 'stand_in_named', requiredIds: wanted };
  }
  const standInOnly = extractStandInOnlyStrictIngredientIds(query);
  if (!area && standInOnly.length === excluded.length && excluded.every((id) => KNOWN_STAND_INS[id])) {
    const standIns = Array.from(new Set(excluded.flatMap((id) => KNOWN_STAND_INS[id])));
    return { query: withArea(standIns.join(' ')), kind: 'stand_in_known', requiredIds: standIns };
  }
  if (area) {
    return { query: withArea(excluded.map((id) => `${ingredientName(id)}-free`).join(' ')), kind: 'area', requiredIds: [] };
  }
  return unchanged;
}

// The category path a row WITHOUT one reads as, from its own title / product type / category text, for
// the door's scope check (strictIngredientQuery.excludeIngredientsFromPage). '' when nothing is named.
function inferRowCategoryPath(product) {
  if (!product || typeof product !== 'object') return '';
  const text = [product.title, product.name, product.product_title, product.product_type, product.category]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ');
  return text ? resolveBeautyCategoryPathPrefixFromText(text) || '' : '';
}

// The category scope a query that excludes an ingredient keeps the page in:
//   - the rest of the query names a category ("retinol-free cream", "retinol-free lipstick"): that
//     category's own route, no extra scope (null);
//   - it names hair or lips: that area's tree ("glycerin-free hair gel" -> beauty/haircare/);
//   - it names another area (body, nails, soap, hands, men's): no scope (null) -- never skincare;
//   - nothing: the excluded actives are skincare actives and the page stays in skincare -- a
//     "retinol-free mist" is never a shampoo or a lipstick.
const EXCLUSION_DEFAULT_SCOPE = 'beauty/skincare/';
function exclusionCategoryScope(text) {
  const raw = String(text || '');
  if (extractExcludedStrictIngredientIds(raw).length === 0) return null;
  const remainder = stripNegatedStrictIngredientMentions(normalizeForMatch(raw));
  if (resolveBeautyCategoryPathPrefixFromText(remainder)) return null;
  const area = areaOf(remainder);
  if (area === 'mixed') return null;
  if (area) return AREA_SCOPE[area];
  return EXCLUSION_DEFAULT_SCOPE;
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
// multilingual table knows, flag or no flag), no body area, no brand, no skin concern or constraint, no
// generic skincare word. "retinol-free", "without retinol", "0% retinol", "retinol 0%", "retinolfrei",
// "niacinamide alternative" are bare; "retinol-free balm", "cerave without retinol", "retinol free for
// sensitive skin", "pregnancy safe no retinol", "retinol free skincare", "retinol-free 크림", "ohne
// Retinol creme", "without glycerin for hair", "retinol alternative for body" are not.
function isBareIngredientNegationQuery(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  if (extractExcludedStrictIngredientIds(raw).length === 0) return false;
  if (extractPositiveStrictIngredientIds(raw).length > 0) return false;
  // The qualifier words left behind ("without", "free", "alternative") name nothing to serve, so they
  // need no removal: none of them is a product type, a brand, a concern or a skincare word.
  const remainder = stripNegatedStrictIngredientMentions(normalizeForMatch(raw));
  if (!remainder) return true;
  if (resolveBeautyCategoryPathPrefixFromText(remainder)) return false;
  if (PRODUCT_FORM_RE.test(remainder) || SKIN_CONCERN_RE.test(remainder) || areaOf(remainder)) return false;
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
  const inactive = { query: original, changed: false, terms: [], negation: false, rewrite: null, guard: null, door: null };
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
    ...(shadow.rewrite ? { fpm_routing_query_rewrite: shadow.rewrite } : {}),
    ...(shadow.guard ? { fpm_routing_query_guard: shadow.guard } : {}),
    ...(modes.bareIngredient !== 'off'
      ? { fpm_routing_would_bare_ingredient: isBareStrictIngredientQuery(shadow.query || normalization.original) }
      : {}),
    ...extra,
  };
}

module.exports = {
  exclusionCategoryScope,
  inferRowCategoryPath,
  isBareIngredientNegationQuery,
  rewriteExclusionQuery,
  rewriteIngredientLikeBrandQuery,
  normalizeFindProductsMultiRoutingQuery,
  locateRoutingQuery,
  buildRoutingQueryLogFields,
};
