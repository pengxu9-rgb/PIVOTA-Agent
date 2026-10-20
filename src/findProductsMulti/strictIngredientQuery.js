'use strict';

// Strict ingredient vocabulary for find_products_multi, and the rules that decide what an ingredient
// mention in a QUERY or on a PRODUCT means.
//
// The alias table is the one the ingredient lane (agent_products_ingredient_recall_direct) has always
// used: src/server.js imports it from here, unchanged. It lives in this module so the routing layer
// (policy.js, the entry normaliser) can ask the same question the lane asks without loading the gateway.
//
// Flag: FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING = off | on (default off), read per call.
//   off  nothing here changes behaviour: the strict detectors match ingredient terms as plain substrings
//        exactly as before, and no caller consults the helpers below.
//   on   1. A NEGATED mention is not an ingredient intent: "retinol-free", "retinol free", "without
//           retinol", "no retinol", "avoid retinol", "free of retinol" do not ask for retinol. Before,
//           every one of them was detected as a retinol intent and the ingredient lane served retinol
//           products for it.
//        2. A query that is ONLY a known ingredient ("retinol", "hyaluronic acid", "best niacinamide
//           products") keeps its own words through the context build, so the ingredient lane sees the
//           ingredient. Before, the beauty semantic rewrite replaced it with a step-family phrase
//           ("anti aging treatment", "treatment treatment") that names no ingredient.
//        3. The ingredient lane admits a row only when the row NAMES every queried ingredient (title or
//           its structured ingredient fields, whole words, not negated); a row whose only mention is
//           "Retinol-Free" or "Retinol Alternative" does not answer "retinol".
//
// Pure functions, no dependencies.

const BARE_INGREDIENT_ROUTING_FLAG = 'FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING';

function isBareIngredientRoutingEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String((env && env[BARE_INGREDIENT_ROUTING_FLAG]) || '').trim());
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

// Same normalisation as services/beautyRelevanceGate.normalizeSearchTextForMatch, which every strict
// detector applies before matching. Duplicated (three lines) so this module stays dependency-free.
function normalizeForMatch(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longest first, so "ceramide np" is consumed before "ceramide".
const STRICT_TERMS_BY_LENGTH = Object.freeze(
  Object.keys(STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES)
    .map((term) => normalizeForMatch(term))
    .sort((a, b) => b.length - a.length),
);

const STRICT_TERM_ALTERNATION = STRICT_TERMS_BY_LENGTH.map(escapeRegExp).join('|');

// English words that, placed directly around an ingredient, mean the query (or the product) is
// WITHOUT it, or is a stand-in for it. On normalised text: punctuation is already a space, so
// "retinol-free" is "retinol free". "no" counts only as a whole word directly before the ingredient
// ("no retinol"). "Retinol alternative" / "alternative to retinol" (bakuchiol and friends) do not
// contain retinol, so they are treated like a negation too.
const NEGATION_BEFORE =
  '(?:without(?:\\s+any)?|no|non|zero|avoid|avoiding|free\\s+of|free\\s+from|alternatives?\\s+to|substitutes?\\s+for)';
const NEGATION_AFTER = '(?:free|alternatives?|substitutes?)';

// Every negated mention of a strict ingredient term in normalised text, e.g. "retinol free",
// "without retinol". Matched on whole words.
const NEGATED_STRICT_TERM_RE = new RegExp(
  `(?:^|\\s)(?:${NEGATION_BEFORE}\\s+(?:${STRICT_TERM_ALTERNATION})|(?:${STRICT_TERM_ALTERNATION})\\s+${NEGATION_AFTER})(?=\\s|$)`,
  'g',
);

// Removes every negated strict-ingredient mention from already-normalised text, so the substring
// detectors that run afterwards cannot read "retinol free" as "retinol". Text without a negated
// mention is returned unchanged.
function stripNegatedStrictIngredientMentions(normalizedText) {
  const text = String(normalizedText || '');
  if (!text) return text;
  NEGATED_STRICT_TERM_RE.lastIndex = 0;
  if (!NEGATED_STRICT_TERM_RE.test(text)) return text;
  NEGATED_STRICT_TERM_RE.lastIndex = 0;
  return text.replace(NEGATED_STRICT_TERM_RE, ' ').replace(/\s+/g, ' ').trim();
}

// Ingredient ids the text asks FOR (negated mentions excluded), in table order. Mirrors the lane's
// own detector, minus the negations.
function extractPositiveStrictIngredientIds(text) {
  const normalized = stripNegatedStrictIngredientMentions(normalizeForMatch(text));
  if (!normalized) return [];
  const out = [];
  for (const [term, ingredientId] of Object.entries(STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES)) {
    if (!normalized.includes(normalizeForMatch(term))) continue;
    if (!out.includes(ingredientId)) out.push(ingredientId);
  }
  return out;
}

// Words that do not change what a bare ingredient query asks for. Deliberately short: anything that
// names a product form, a concern, a brand or a body area makes the query something other than "just
// the ingredient", and it keeps its existing route.
const BARE_QUERY_FILLER_WORDS = new Set([
  'a', 'an', 'the', 'any', 'some', 'me', 'i', 'my',
  'best', 'top', 'good', 'great', 'popular', 'pure',
  'product', 'products', 'item', 'items',
  'shop', 'buy', 'find', 'show', 'search', 'get', 'want', 'need', 'looking', 'recommend',
  'recommendation', 'recommendations', 'please',
  'with', 'containing', 'contains', 'for',
]);

// True when the query is ONLY one or more strict-table ingredients (plus filler words). A negated
// mention is never bare: its negator ("free", "without", "no", "alternative") is not a filler word. "retinol", "Hyaluronic Acid", "best niacinamide products" -> true;
// "retinol serum", "retinol-free", "vitamin c supplement", "hyaluronic" (not a table term) -> false.
function isBareStrictIngredientQuery(text) {
  const normalized = normalizeForMatch(text);
  if (!normalized) return false;
  let remainder = ` ${normalized} `;
  let matched = false;
  for (const term of STRICT_TERMS_BY_LENGTH) {
    const pattern = new RegExp(`\\s${escapeRegExp(term)}(?=\\s)`, 'g');
    if (pattern.test(remainder)) {
      matched = true;
      remainder = remainder.replace(pattern, ' ');
    }
  }
  if (!matched) return false;
  return remainder
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => BARE_QUERY_FILLER_WORDS.has(token));
}

// Terms a product may use to name an ingredient: the id itself ("hyaluronic acid") and every table
// alias mapped to it. Unlike the lane's recall terms, no loose extras ("vitamin" would name vitamin E).
function strictIngredientNamingTerms(ingredientId) {
  const id = String(ingredientId || '').trim().toLowerCase();
  if (!id) return [];
  const out = [normalizeForMatch(id.replace(/_/g, ' '))];
  for (const [term, mappedId] of Object.entries(STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES)) {
    if (mappedId !== id) continue;
    const normalized = normalizeForMatch(term);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out.filter(Boolean);
}

function productIngredientIds(product) {
  return Array.isArray(product?.ingredient_ids)
    ? product.ingredient_ids.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
}

// The product's own words about what it contains: its title and its STRUCTURED ingredient fields
// (actives, key ingredients, INCI list), each kept as a separate string so a negator at the end of one
// field can never reach the first word of the next. Deliberately NOT:
//   - the description, which mentions ingredients loosely ("free of retinol", "pairs well with");
//   - ingredient_tokens / external_seed_recall.ingredient_tokens, which are DERIVED, partly from the
//     description, with no negation handling (deriveBeautyRecallActives: "free of retinol" -> "retinol").
function productNamingFields(product) {
  if (!product || typeof product !== 'object') return [];
  const seedData = product.product_payload?.seed_data || product.seed_data || null;
  const intel = product.ingredient_intel && typeof product.ingredient_intel === 'object' ? product.ingredient_intel : null;
  const list = (value) => (Array.isArray(value) ? value : []);
  return [
    product.title,
    product.name,
    product.product_title,
    ...list(product.key_ingredients),
    ...list(product.active_ingredients),
    ...list(product.ingredients_inci),
    ...list(intel?.active_ingredients),
    ...list(intel?.inci_list),
    ...list(seedData?.active_ingredients),
    ...list(seedData?.key_ingredients),
    ...list(seedData?.ingredients_inci),
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => normalizeForMatch(value))
    .filter(Boolean);
}

// How the product mentions one ingredient: 'named' (a non-negated mention, or the id in its
// ingredient_ids), 'negated_only' (every mention is negated: "Retinol-Free Night Cream"), or 'absent'.
function productIngredientMention(product, ingredientId) {
  const id = String(ingredientId || '').trim().toLowerCase();
  if (!id) return 'absent';
  if (productIngredientIds(product).includes(id)) return 'named';
  let sawNegated = false;
  const terms = strictIngredientNamingTerms(id);
  for (const text of productNamingFields(product)) {
    for (const term of terms) {
      // Whole words only: "vitamin c" never matches "vitamin e", "retinol" never matches "retinoloid".
      const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(term)}(?=\\s|$)`, 'g');
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const start = match.index + (match[0].startsWith(' ') ? 1 : 0);
        const end = start + term.length;
        const negated =
          NEGATED_BEFORE_TAIL_RE.test(text.slice(0, start)) || NEGATED_AFTER_HEAD_RE.test(text.slice(end));
        if (!negated) return 'named';
        sawNegated = true;
      }
    }
  }
  return sawNegated ? 'negated_only' : 'absent';
}

const NEGATED_BEFORE_TAIL_RE = new RegExp(`(?:^|\\s)${NEGATION_BEFORE}\\s$`);
const NEGATED_AFTER_HEAD_RE = new RegExp(`^\\s${NEGATION_AFTER}(?=\\s|$)`);

function productNamesStrictIngredientsPositively(product, ingredientIds = []) {
  const ids = (Array.isArray(ingredientIds) ? ingredientIds : []).filter(Boolean);
  if (ids.length === 0) return false;
  return ids.every((id) => productIngredientMention(product, id) === 'named');
}

// The ingredient lane's admission rule while the flag is on: every row must NAME every queried
// ingredient, in its title or its structured ingredient fields, on whole words, and not negated. The
// lane's recall does not guarantee this on its own: the canonical leg matches query text against
// title / recall_doc / SKU ingredient ids (a recall_doc LIKE '%retinol%' admits "Retinol-Free ..."),
// and the seed prefetch matches substrings of derived ingredient tokens (where "vitamin" names vitamin E
// and "free of retinol" in a description yields the token "retinol"). Returns { products, dropped_count };
// order is preserved and nothing is added.
function admitIngredientLaneProducts(products = [], { ingredientIds = [] } = {}) {
  const list = Array.isArray(products) ? products : [];
  const ids = (Array.isArray(ingredientIds) ? ingredientIds : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  if (ids.length === 0) return { products: list, dropped_count: 0 };
  const kept = list.filter((product) => productNamesStrictIngredientsPositively(product, ids));
  return { products: kept, dropped_count: list.length - kept.length };
}

// English negation phrasing, canonicalised to the form the rest of the pipeline already understands
// ("<ingredient>-free": the search-quality contract reads "retinol-free" as avoid-retinoids, and
// shouldPreserveIngredientDirectForPivotBeautyContract declines the ingredient lane for it). Applied to
// raw query text at the request entry, only while the flag is on, and only to strict-table terms.
const RAW_NEGATED_TERM_RE = new RegExp(
  `\\b(?:without(?:\\s+any)?|no|avoid(?:ing)?|free\\s+(?:of|from)|zero)\\s+(${STRICT_TERM_ALTERNATION.replace(/ /g, '[\\s-]+')})\\b`,
  'gi',
);
const RAW_TERM_FREE_RE = new RegExp(`\\b(${STRICT_TERM_ALTERNATION.replace(/ /g, '[\\s-]+')})\\s+free\\b`, 'gi');

function canonicalizeEnglishIngredientNegations(rawQuery) {
  const text = String(rawQuery || '');
  if (!text.trim()) return { query: text, changed: false };
  const out = text
    .replace(RAW_NEGATED_TERM_RE, (_match, term) => `${term.toLowerCase().replace(/[\s-]+/g, ' ')}-free`)
    .replace(RAW_TERM_FREE_RE, (_match, term) => `${term.toLowerCase().replace(/[\s-]+/g, ' ')}-free`)
    .replace(/\s+/g, ' ')
    .trim();
  return { query: out, changed: out !== text.replace(/\s+/g, ' ').trim() };
}

module.exports = {
  BARE_INGREDIENT_ROUTING_FLAG,
  STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES,
  isBareIngredientRoutingEnabled,
  stripNegatedStrictIngredientMentions,
  extractPositiveStrictIngredientIds,
  isBareStrictIngredientQuery,
  strictIngredientNamingTerms,
  productIngredientMention,
  productNamesStrictIngredientsPositively,
  admitIngredientLaneProducts,
  canonicalizeEnglishIngredientNegations,
};
