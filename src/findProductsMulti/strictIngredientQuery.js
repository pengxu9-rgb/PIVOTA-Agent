'use strict';

// Strict ingredient vocabulary for find_products_multi, and the rules that decide what an ingredient
// mention in a QUERY or on a PRODUCT means.
//
// The alias table is the one the ingredient lane (agent_products_ingredient_recall_direct) has always
// used: src/server.js imports it from here, unchanged. It lives in this module so the routing layer
// (policy.js, the entry normaliser) can ask the same question the lane asks without loading the gateway.
//
// Flag: FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING = off | observe | on (default off), read per call.
//   off      nothing here changes behaviour, and nothing is computed for the log.
//   observe  every decision below is computed and logged on the completion line; the response, the
//            lane and the rows are exactly what `off` produces.
//   on       1. A query that is ONLY a known ingredient ("retinol", "hyaluronic acid") keeps its own
//              words through the context build, so the ingredient lane sees the ingredient.
//            2. An ingredient mention that is negated or a stand-in is not an ingredient intent:
//              "retinol-free", "without retinol", "no added retinol", "0% retinol", "retinol
//              alternative", "better than retinol", "phyto-retinol".
//            3. The ingredient lane admits a row only when the row positively NAMES every queried
//              ingredient (productIngredientMention).
//            4. A query that excludes an ingredient ("niacinamide-free serum", "retinol alternative
//              serum") never gets a row that names it, whichever lane answered.
//
// Pure functions, no dependencies.

const BARE_INGREDIENT_ROUTING_FLAG = 'FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING';

function readMode(env, flag) {
  const raw = String((env && env[flag]) || '').trim().toLowerCase();
  if (/^(1|true|on|yes)$/.test(raw)) return 'on';
  if (/^(observe|shadow)$/.test(raw)) return 'observe';
  return 'off';
}

function bareIngredientRoutingMode(env = process.env) {
  return readMode(env, BARE_INGREDIENT_ROUTING_FLAG);
}

function isBareIngredientRoutingEnabled(env = process.env) {
  return bareIngredientRoutingMode(env) === 'on';
}

// The ingredient lane's table (moved verbatim from src/server.js). Term -> ingredient id.
const STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES = Object.freeze({
  'ascorbic acid': 'ascorbic_acid',
  'azelaic acid': 'azelaic_acid',
  'benzoyl peroxide': 'benzoyl_peroxide',
  ceramide: 'ceramide_np',
  ceramides: 'ceramide_np',
  'ceramide np': 'ceramide_np',
  glycerin: 'glycerin',
  glycerine: 'glycerin',
  'hyaluronic acid': 'hyaluronic_acid',
  niacinamide: 'niacinamide',
  panthenol: 'panthenol',
  retinol: 'retinol',
  'salicylic acid': 'salicylic_acid',
  'vitamin c': 'ascorbic_acid',
  'zinc pca': 'zinc_pca',
});

// INCI names that ARE the ingredient, read only from a product's structured ingredient fields (never
// from a title or a query). Each is a name for the same substance or a direct salt/ester of it.
const STRUCTURED_INCI_SYNONYMS = Object.freeze({
  hyaluronic_acid: ['sodium hyaluronate', 'hydrolyzed sodium hyaluronate', 'sodium acetylated hyaluronate', 'hydrolyzed hyaluronic acid'],
  ascorbic_acid: ['l ascorbic acid', 'ascorbyl glucoside', 'sodium ascorbyl phosphate', 'magnesium ascorbyl phosphate',
    'ethyl ascorbic acid', '3 o ethyl ascorbic acid', 'tetrahexyldecyl ascorbate', 'ascorbyl tetraisopalmitate'],
  niacinamide: ['nicotinamide'],
  panthenol: ['d panthenol', 'dexpanthenol'],
  glycerin: ['glycerol'],
  ceramide_np: ['ceramide ap', 'ceramide eop', 'ceramide ns', 'ceramide as'],
});

// Lower-case, diacritics stripped, every run of non-letters/digits (in ANY script) -> one space.
// Script-preserving on purpose: Hangul, kana, Han and Cyrillic survive, so "retinol 크림" is not
// mistaken for the bare query "retinol".
function normalizeForMatch(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TERM_TO_ID = new Map(
  Object.entries(STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES).map(([term, id]) => [normalizeForMatch(term), id]),
);
// Longest first, so "ceramide np" is consumed before "ceramide".
const STRICT_TERMS_BY_LENGTH = Object.freeze(Array.from(TERM_TO_ID.keys()).sort((a, b) => b.length - a.length));
const STRICT_TERM_ALTERNATION = STRICT_TERMS_BY_LENGTH.map(escapeRegExp).join('|');

// Words around an ingredient that mean "without it" or "a stand-in for it", on normalised text
// (punctuation is already a space: "retinol-free" is "retinol free", "0% retinol" is "0 retinol").
// BEFORE the term:
const QUALIFIER_BEFORE = [
  'without any', 'without', 'no added', 'no', 'non', 'not', 'never', 'zero', '0', 'avoid', 'avoiding',
  'free of', 'free from',
  'alternatives to', 'alternative to', 'substitutes for', 'substitute for', 'replacement for', 'replacements for',
  'better than', 'gentler than', 'instead of', 'like',
  'plant based', 'plant', 'phyto', 'botanical', 'natural', 'vegan', 'faux', 'bio', 'pro', 'pseudo',
];
// AFTER the term. "free" does not count before shipping / delivery / returns / gift / sample / trial:
// "retinol free shipping" is a retinol query.
const QUALIFIER_AFTER = [
  'free(?!\\s+(?:shipping|delivery|returns?|gifts?|samples?|trials?)(?:\\s|$))',
  'alternatives?', 'substitutes?', 'replacements?', 'like', 'alike', 'dupes?', 'alt', 'analogs?', 'analogues?',
];
const QUALIFIER_BEFORE_RE = `(?:${QUALIFIER_BEFORE.map((value) => value.replace(/ /g, '\\s+')).join('|')})`;
const QUALIFIER_AFTER_RE = `(?:${QUALIFIER_AFTER.join('|')})`;
const BEFORE_TAIL_RE = new RegExp(`(?:^|\\s)${QUALIFIER_BEFORE_RE}\\s$`);
const AFTER_HEAD_RE = new RegExp(`^\\s${QUALIFIER_AFTER_RE}(?=\\s|$)`);

// Every whole-word occurrence of `term` in normalised `text`, each marked qualified (negated /
// stand-in) or positive. Whole words on BOTH sides: "bioretinol" and "retinoloid" are not "retinol".
function termOccurrences(text, term) {
  const out = [];
  if (!text || !term) return out;
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(term)}(?=\\s|$)`, 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index + (match[0].startsWith(' ') ? 1 : 0);
    const end = start + term.length;
    const qualified = BEFORE_TAIL_RE.test(text.slice(0, start)) || AFTER_HEAD_RE.test(text.slice(end));
    out.push({ start, end, qualified });
  }
  return out;
}

// Query side: which table ingredients the text asks FOR, and which it EXCLUDES (mentions only in a
// negated or stand-in form). A positive mention anywhere wins. Ids in table order.
function classifyStrictIngredientMentions(text) {
  const normalized = normalizeForMatch(text);
  const states = new Map();
  if (normalized) {
    const consumed = new Array(normalized.length).fill(false);
    for (const term of STRICT_TERMS_BY_LENGTH) {
      const id = TERM_TO_ID.get(term);
      for (const occurrence of termOccurrences(normalized, term)) {
        let overlaps = false;
        for (let i = occurrence.start; i < occurrence.end; i += 1) if (consumed[i]) overlaps = true;
        if (overlaps) continue;
        for (let i = occurrence.start; i < occurrence.end; i += 1) consumed[i] = true;
        const state = states.get(id) || { positive: false, qualified: false };
        if (occurrence.qualified) state.qualified = true;
        else state.positive = true;
        states.set(id, state);
      }
    }
  }
  const wanted = [];
  const excluded = [];
  for (const id of Object.values(STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES)) {
    const state = states.get(id);
    if (!state) continue;
    if (state.positive && !wanted.includes(id)) wanted.push(id);
    if (!state.positive && state.qualified && !excluded.includes(id)) excluded.push(id);
  }
  return { wanted, excluded };
}

// Removes every negated / stand-in strict-ingredient mention from text already normalised by the
// gateway's normalizeSearchTextForMatch, so the substring detector that runs afterwards cannot read
// "retinol free" as "retinol". Text without such a mention is returned unchanged.
function stripNegatedStrictIngredientMentions(normalizedText) {
  const text = String(normalizedText || '');
  if (!text) return text;
  let out = text;
  for (const term of STRICT_TERMS_BY_LENGTH) {
    const occurrences = termOccurrences(out, term).filter((occurrence) => occurrence.qualified);
    for (let i = occurrences.length - 1; i >= 0; i -= 1) {
      out = `${out.slice(0, occurrences[i].start)} ${out.slice(occurrences[i].end)}`;
    }
  }
  return out === text ? text : out.replace(/\s+/g, ' ').trim();
}

function extractPositiveStrictIngredientIds(text) {
  return classifyStrictIngredientMentions(text).wanted;
}

function extractExcludedStrictIngredientIds(text) {
  return classifyStrictIngredientMentions(text).excluded;
}

// Words that do not change what a bare ingredient query asks for. Deliberately short: anything that
// names a product form, a concern, a brand, a body area -- or is in another script -- makes the query
// something other than "just the ingredient", and it keeps its existing route.
const BARE_QUERY_FILLER_WORDS = new Set([
  'a', 'an', 'the', 'any', 'some', 'me', 'i', 'my',
  'best', 'top', 'good', 'great', 'popular', 'pure',
  'product', 'products', 'item', 'items',
  'shop', 'buy', 'find', 'show', 'search', 'get', 'want', 'need', 'looking', 'recommend',
  'recommendation', 'recommendations', 'please',
  'with', 'containing', 'contains', 'for',
]);

// True when the query is ONLY one or more strict-table ingredients (plus filler words), each asked
// for positively. "retinol", "Hyaluronic Acid", "best niacinamide products" -> true;
// "retinol serum", "retinol 크림", "retinol-free", "0% retinol", "hyaluronic" (not a table term) -> false.
function isBareStrictIngredientQuery(text) {
  const normalized = normalizeForMatch(text);
  if (!normalized) return false;
  const { wanted, excluded } = classifyStrictIngredientMentions(normalized);
  if (wanted.length === 0 || excluded.length > 0) return false;
  let remainder = ` ${normalized} `;
  for (const term of STRICT_TERMS_BY_LENGTH) {
    remainder = remainder.replace(new RegExp(`\\s${escapeRegExp(term)}(?=\\s)`, 'g'), ' ');
  }
  return remainder
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => BARE_QUERY_FILLER_WORDS.has(token));
}

// Terms a TITLE may use to name an ingredient: the id and its table aliases. No loose extras: a bare
// "vitamin" names vitamin E as readily as vitamin C.
function strictIngredientNamingTerms(ingredientId) {
  const id = String(ingredientId || '').trim().toLowerCase();
  if (!id) return [];
  const out = [normalizeForMatch(id.replace(/_/g, ' '))];
  for (const [term, mappedId] of TERM_TO_ID.entries()) {
    if (mappedId === id && !out.includes(term)) out.push(term);
  }
  return out.filter(Boolean);
}

function structuredNamingTerms(ingredientId) {
  const id = String(ingredientId || '').trim().toLowerCase();
  const synonyms = (STRUCTURED_INCI_SYNONYMS[id] || []).map((value) => normalizeForMatch(value));
  return Array.from(new Set([...strictIngredientNamingTerms(id), ...synonyms]));
}

function productIngredientIds(product) {
  return Array.isArray(product?.ingredient_ids)
    ? product.ingredient_ids.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
}

// A structured ingredient field as a list of entries: an array, or an INCI string split on its
// separators. Each entry is matched on its own, so a qualifier ending one entry never reaches the next.
function structuredEntries(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (typeof entry === 'string' ? structuredEntries(entry) : []));
  }
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(/[,;|\n\u3001\uff0c]+/)
    .map((entry) => normalizeForMatch(entry))
    .filter(Boolean);
}

// The product's STRUCTURED ingredient fields: actives, key ingredients and the INCI list, wherever the
// row carries them (top level, ingredient_intel, the seed payload). Deliberately NOT:
//   - the description, which mentions ingredients loosely ("free of retinol", "pairs well with");
//   - ingredient_tokens / external_seed_recall.ingredient_tokens, which are DERIVED, partly from the
//     description, with no negation handling (deriveBeautyRecallActives: "free of retinol" -> "retinol").
function productStructuredIngredientEntries(product) {
  if (!product || typeof product !== 'object') return [];
  const seedData = product.product_payload?.seed_data || product.seed_data || null;
  const intel = product.ingredient_intel && typeof product.ingredient_intel === 'object' ? product.ingredient_intel : null;
  const seedIntel = seedData?.ingredient_intel && typeof seedData.ingredient_intel === 'object' ? seedData.ingredient_intel : null;
  return [
    product.active_ingredients,
    product.key_ingredients,
    product.ingredients_inci,
    product.inci_list,
    product.pdp_active_ingredients_raw,
    intel?.active_ingredients,
    intel?.inci_list,
    seedData?.active_ingredients,
    seedData?.key_ingredients,
    seedData?.ingredients_inci,
    seedData?.inci_list,
    seedIntel?.active_ingredients,
    seedIntel?.inci_list,
  ].flatMap(structuredEntries);
}

function productTitleText(product) {
  if (!product || typeof product !== 'object') return '';
  return normalizeForMatch(
    [product.title, product.name, product.product_title].filter((value) => typeof value === 'string' && value.trim()).join(' | '),
  );
}

// How the product mentions one ingredient:
//   'named'         its structured ingredient fields name it, or its ingredient_ids carry it, or its
//                   title names it outright -- and the title does not qualify it away;
//   'negated_only'  every mention is qualified ("Retinol-Free", "Phyto-Retinol", "Retinol Alternative",
//                   "Better Than Retinol", "0% Retinol", "No Added Retinol", "Not Retinol"); a title
//                   that qualifies the ingredient away also overrides ingredient_ids and structured fields;
//   'absent'        no mention.
function productIngredientMention(product, ingredientId) {
  const id = String(ingredientId || '').trim().toLowerCase();
  if (!id || !product || typeof product !== 'object') return 'absent';
  const title = productTitleText(product);
  let titlePositive = false;
  let titleQualified = false;
  for (const term of strictIngredientNamingTerms(id)) {
    for (const occurrence of termOccurrences(title, term)) {
      if (occurrence.qualified) titleQualified = true;
      else titlePositive = true;
    }
  }
  if (titleQualified && !titlePositive) return 'negated_only';
  if (productIngredientIds(product).includes(id)) return 'named';
  let structuredQualified = false;
  const terms = structuredNamingTerms(id);
  for (const entry of productStructuredIngredientEntries(product)) {
    for (const term of terms) {
      for (const occurrence of termOccurrences(entry, term)) {
        if (!occurrence.qualified) return 'named';
        structuredQualified = true;
      }
    }
  }
  if (titlePositive) return 'named';
  return structuredQualified ? 'negated_only' : 'absent';
}

function productNamesStrictIngredientsPositively(product, ingredientIds = []) {
  const ids = (Array.isArray(ingredientIds) ? ingredientIds : []).filter(Boolean);
  if (ids.length === 0) return false;
  return ids.every((id) => productIngredientMention(product, id) === 'named');
}

function cleanIds(ingredientIds) {
  return (Array.isArray(ingredientIds) ? ingredientIds : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

// The ingredient lane's admission rule: every row must NAME every queried ingredient. The lane's recall
// does not guarantee this on its own: the canonical leg matches query text against title / recall_doc /
// SKU ingredient ids (a recall_doc LIKE '%retinol%' admits "Retinol-Free ..."), and the seed prefetch
// substring-matches derived ingredient tokens (where "vitamin" names vitamin E and a description's
// "free of retinol" yields the token "retinol"). Order is preserved and nothing is added.
function admitIngredientLaneProducts(products = [], { ingredientIds = [] } = {}) {
  const list = Array.isArray(products) ? products : [];
  const ids = cleanIds(ingredientIds);
  if (ids.length === 0) return { products: list, dropped_count: 0 };
  const kept = list.filter((product) => productNamesStrictIngredientsPositively(product, ids));
  return { products: kept, dropped_count: list.length - kept.length };
}

// The exclusion a query like "niacinamide-free serum" or "retinol alternative serum" asks for: no row
// that names the excluded ingredient. Order is preserved and nothing is added.
function excludeProductsNamingIngredients(products = [], { ingredientIds = [] } = {}) {
  const list = Array.isArray(products) ? products : [];
  const ids = cleanIds(ingredientIds);
  if (ids.length === 0) return { products: list, dropped_count: 0 };
  const kept = list.filter((product) => !ids.some((id) => productIngredientMention(product, id) === 'named'));
  return { products: kept, dropped_count: list.length - kept.length };
}

// English negation phrasing, canonicalised to the form the rest of the pipeline already understands
// ("<ingredient>-free": the search-quality contract reads "retinol-free" as avoid-retinoids). Absence
// forms only -- a stand-in ("retinol alternative") is not "free of" anything. Strict-table terms only.
const RAW_TERM = `(${STRICT_TERM_ALTERNATION.replace(/ /g, '[\\s-]+')})`;
const RAW_NEGATED_TERM_RE = new RegExp(
  `(?<![\\w-])(?:without(?:\\s+any)?|no(?:\\s+added)?|avoid(?:ing)?|free\\s+(?:of|from)|zero|0\\s*%)[\\s-]*${RAW_TERM}\\b`,
  'gi',
);
const RAW_TERM_FREE_RE = new RegExp(
  `\\b${RAW_TERM}\\s+free\\b(?!\\s+(?:shipping|delivery|returns?|gifts?|samples?|trials?)\\b)`,
  'gi',
);

function canonicalizeEnglishIngredientNegations(rawQuery) {
  const text = String(rawQuery || '');
  if (!text.trim()) return { query: text, changed: false };
  const toFree = (_match, term) => `${term.toLowerCase().replace(/[\s-]+/g, ' ')}-free`;
  const out = text.replace(RAW_NEGATED_TERM_RE, toFree).replace(RAW_TERM_FREE_RE, toFree);
  if (out === text) return { query: text, changed: false };
  return { query: out.replace(/\s+/g, ' ').trim(), changed: true };
}

module.exports = {
  BARE_INGREDIENT_ROUTING_FLAG,
  STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES,
  bareIngredientRoutingMode,
  isBareIngredientRoutingEnabled,
  readMode,
  normalizeForMatch,
  stripNegatedStrictIngredientMentions,
  extractPositiveStrictIngredientIds,
  extractExcludedStrictIngredientIds,
  isBareStrictIngredientQuery,
  strictIngredientNamingTerms,
  productIngredientMention,
  productNamesStrictIngredientsPositively,
  admitIngredientLaneProducts,
  excludeProductsNamingIngredients,
  canonicalizeEnglishIngredientNegations,
};
