/**
 * Canonical beauty category taxonomy — single source of truth (Class 3).
 *
 * WHY. `category_path` is written by the seed sync with string hygiene only
 * (`normalizeCategoryPath` lowercases and cleans separators); no canonical
 * vocabulary is enforced, so the same semantic category accumulated multiple
 * spellings. Prod survey 2026-08-04: 294 distinct paths over 14,124 products,
 * with only 32.9% of rows on a leaf the code's own taxonomy table names, and
 * 50 leaf words split across more than one path.
 *
 * The damage is measurable, not theoretical. `resolveBeautyCategoryPathPrefixForQuery`
 * derives browse prefixes from the taxonomy table, so when the table names a
 * leaf the data does not use, the canonical browse leg recalls NOTHING.
 * Prod-measured on the isolated leg (2026-08-04):
 *   toner    prefix beauty/skincare/tone/  -> BROWSE 0 rows   (TEXT 48/48 hits)
 *   shampoo  prefix beauty/hair/           -> BROWSE 0 rows   (TEXT 48/48 hits)
 *   bronzer  prefix beauty/makeup/cheek/   -> BROWSE 13 rows, 0 title hits
 * Serving survives on other lanes, which is exactly why this stayed invisible.
 *
 * NOT EVERY SPLIT IS AN ERROR — this is the load-bearing constraint on any
 * automated merge. Distinct products legitimately share a leaf word:
 *   beauty/makeup/lip/oil (27) vs beauty/skincare/moisturize/oil (24) vs beauty/body/oil (9)
 *   beauty/skincare/treat/mask (421) vs beauty/haircare/mask (3)
 *   beauty/makeup/lip/balm (151) vs beauty/skincare/eye/balm (3)
 *   beauty/sets vs beauty/skincare/sets vs beauty/haircare/sets
 * A "merge by leaf word" rule would destroy these. Hence an explicit curated
 * alias table: every entry is a deliberate claim that two paths name the SAME
 * category, and anything not listed is left alone.
 */

'use strict';

const {
  TAXONOMY_LEAVES,
  LEAF_PARENTS,
  ANCESTOR_NODES,
  TAXONOMY_ROOTS,
} = require('./recallTaxonomyLeaves');

// Canonical home for each semantic category. Where the data and the old
// taxonomy table disagreed, the choice is recorded with its reason — the rule
// is whichever target yields a TIGHT browse bucket, because the prefix's
// parent segment is what recall browses.
const CANONICAL_CATEGORY_PATHS = Object.freeze({
  // --- skincare -----------------------------------------------------------
  serum: 'beauty/skincare/treat/serum',
  cleanser: 'beauty/skincare/cleanse/cleanser',
  sunscreen: 'beauty/skincare/sun/sunscreen',
  mask: 'beauty/skincare/treat/mask',
  treatment: 'beauty/skincare/treat/treatment',
  exfoliant: 'beauty/skincare/treat/exfoliant',
  moisturizer: 'beauty/skincare/moisturize/cream',
  // Toner: data sits at treat/toner (316) + skincare/toner (54); the old table
  // named tone/toner (0 rows). Target tone/toner anyway — it is the only option
  // that gives "toner" a clean bucket. Folding into treat/ instead would put
  // toner in with serum(520)+mask(421)+exfoliant(123), i.e. the broad-bucket
  // shape that produced the 2026-07-31 junk recall. Costs 370 row writes.
  toner: 'beauty/skincare/tone/toner',

  // --- makeup -------------------------------------------------------------
  lipstick: 'beauty/makeup/lip/lipstick',
  lip_balm: 'beauty/makeup/lip/balm',
  concealer: 'beauty/makeup/face/concealer',
  foundation: 'beauty/makeup/face/foundation',
  powder: 'beauty/makeup/face/powder',
  eyeshadow: 'beauty/makeup/eye/eyeshadow',
  mascara: 'beauty/makeup/eye/mascara',
  brow: 'beauty/makeup/eye/brow',
  // Cheek family: data overwhelmingly uses makeup/face/* (blush 83+22,
  // highlighter 57, bronzer 35) against the old table's makeup/cheek/*
  // (2/13/0). Follow the data — and note CATEGORY_ALIAS_RULES in
  // findProductsMulti/queryUnderstanding.js ALREADY resolves blush to
  // beauty/makeup/face/blush/, so face/* is what one live resolver expects.
  blush: 'beauty/makeup/face/blush',
  highlighter: 'beauty/makeup/face/highlighter',
  bronzer: 'beauty/makeup/face/bronzer',

  // --- hair ---------------------------------------------------------------
  // Data uses beauty/haircare/* (shampoo 143, conditioner 42, styling 8,
  // general 273); the old table named beauty/hair/* (2/2/0). Follow the data:
  // moving 466 rows to satisfy a 4-row spelling would be backwards.
  shampoo: 'beauty/haircare/shampoo',
  conditioner: 'beauty/haircare/conditioner',
  hair_styling: 'beauty/haircare/styling',

  // --- other --------------------------------------------------------------
  brush: 'beauty/tools/brush',
  fragrance: 'beauty/fragrance/perfume',
  gift_set: 'beauty/sets/gift-set',
});

// Variant -> canonical. Every entry asserts the two paths name the SAME
// category. Curated from the 2026-08-04 prod survey; unlisted paths are never
// rewritten.
const CATEGORY_PATH_ALIASES = Object.freeze({
  // skincare: shallower spellings of an existing canonical leaf
  'beauty/skincare/serum': CANONICAL_CATEGORY_PATHS.serum,
  'beauty/skincare/cleanser': CANONICAL_CATEGORY_PATHS.cleanser,
  'beauty/skincare/sunscreen': CANONICAL_CATEGORY_PATHS.sunscreen,
  'beauty/skincare/mask': CANONICAL_CATEGORY_PATHS.mask,
  'beauty/skincare/treatment': CANONICAL_CATEGORY_PATHS.treatment,
  'beauty/skincare/exfoliator': CANONICAL_CATEGORY_PATHS.exfoliant,
  'beauty/skincare/moisturizer': CANONICAL_CATEGORY_PATHS.moisturizer,
  // toner: both non-canonical spellings converge on the tight bucket
  'beauty/skincare/treat/toner': CANONICAL_CATEGORY_PATHS.toner,
  'beauty/skincare/toner': CANONICAL_CATEGORY_PATHS.toner,

  // makeup: singular/plural and depth variants
  'beauty/makeup/lips/lipstick': CANONICAL_CATEGORY_PATHS.lipstick,
  'beauty/makeup/eyes/eyeshadow': CANONICAL_CATEGORY_PATHS.eyeshadow,
  'beauty/makeup/eyes/brow': CANONICAL_CATEGORY_PATHS.brow,
  'beauty/makeup/concealer': CANONICAL_CATEGORY_PATHS.concealer,
  'beauty/makeup/blush': CANONICAL_CATEGORY_PATHS.blush,
  'beauty/makeup/cheek/blush': CANONICAL_CATEGORY_PATHS.blush,
  'beauty/makeup/cheek/highlighter': CANONICAL_CATEGORY_PATHS.highlighter,
  'beauty/makeup/cheek/bronzer': CANONICAL_CATEGORY_PATHS.bronzer,
  'beauty/makeup/brush': CANONICAL_CATEGORY_PATHS.brush,

  // hair: the beauty/hair/* spelling folds into beauty/haircare/*
  'beauty/hair/shampoo': CANONICAL_CATEGORY_PATHS.shampoo,
  'beauty/hair/conditioner': CANONICAL_CATEGORY_PATHS.conditioner,
  'beauty/hair/styling': CANONICAL_CATEGORY_PATHS.hair_styling,

  // sets
  'beauty/gift-set': CANONICAL_CATEGORY_PATHS.gift_set,
});

// Paths deliberately NOT merged despite sharing a leaf word with a canonical
// entry — kept here so a future pass does not "helpfully" collapse them.
const INTENTIONALLY_DISTINCT = Object.freeze([
  'beauty/makeup/lip/oil',
  'beauty/skincare/moisturize/oil',
  'beauty/skincare/oil',
  'beauty/body/oil',
  'beauty/haircare/mask',
  'beauty/haircare/scalp-treatment/mask',
  'beauty/skincare/eye/balm',
  'beauty/skincare/moisturizer/balm',
  'beauty/skincare/eye/serum',
  'beauty/skincare/body/moisturizer',
  'beauty/skincare/hand/cream',
  'beauty/skincare/sets',
  'beauty/haircare/sets',
  'beauty/bodycare/sets',
  'beauty/fragrance/sets',
  'beauty/makeup/sets',
]);

function normalizeCategoryPathText(value) {
  const raw = Array.isArray(value) ? value.join('/') : String(value || '');
  return raw.trim().toLowerCase().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

/**
 * Map a stored category_path to its canonical home.
 * Returns the input (normalized) when no alias applies — never guesses.
 */
function toCanonicalCategoryPath(value) {
  const path = normalizeCategoryPathText(value);
  if (!path) return '';
  return CATEGORY_PATH_ALIASES[path] || path;
}

// THE WRITER-SIDE DEFINITION OF "THIS ROW HAS BEEN CATEGORISED".
//
// A path names a category only once it says something past the top-level domain. `beauty` is a
// NAMESPACE, not an answer to "what is this" -- and three committed writers were stamping it as an
// answer, which makes the row unretrievable by category-scoped recall while looking finished to
// every repair tool.
//
// IT SURVIVED A TAXONOMY STANDARDISATION PASS BECAUSE `beauty` IS ON THE TAXONOMY. The backend
// builds ANCESTOR_NODES with `range(1, len(parts))` (services/category_path_aliases.py), so every
// root is a node: `has_category_door("beauty")` is True while `resolve("beauty")` is None. An
// off-taxonomy health check therefore counts the whole cohort healthy. Measured on the live index
// via search_catalog("eau de parfum"): 16 of 50 rows sit on bare `beauty` -- the entire Ariana
// Grande fragrance line, Cosmic Kylie Jenner, every PixiPerfume.
//
// ONE RULE, THREE LANGUAGES, SAME ANSWER. This is the ingest-side twin of the serving-side
// `categoryPathIsCategorised` (src/server.js, pengxu9-rgb/PIVOTA-Agent#2195) and of pivota-backend's
// `is_categorised_path()` (services/pdp_category_classifier.py, pengxu9-rgb/pivota-backend#2172).
// Deliberately the SAME NAME as the serving twin: when #2195 lands, its local copy in server.js
// should become a require of this one rather than a second definition. Segment counting is
// identical in all three -- trim, strip leading/trailing slashes, drop empty segments, require >= 2.
//
// It asks for depth, not for a beauty leaf, so `fashion` and `electronics` are caught by the same
// rule without being named. It deliberately does NOT assert canonicality: `toCanonicalCategoryPath`
// above is the alias question and is a separate concern -- a row on a non-canonical but real
// two-segment path is categorised, just not yet folded.
const MIN_CATEGORISED_PATH_SEGMENTS = 2;

function categoryPathIsCategorised(value) {
  const path = normalizeCategoryPathText(value);
  if (!path) return false;
  return path.split('/').filter(Boolean).length >= MIN_CATEGORISED_PATH_SEGMENTS;
}

function isCanonicalCategoryPath(value) {
  const path = normalizeCategoryPathText(value);
  if (!path) return false;
  return !Object.prototype.hasOwnProperty.call(CATEGORY_PATH_ALIASES, path);
}

// CAN CATEGORY RECALL REACH THIS PATH, AS STORED?
//
// The read-side twin of `categoryPathIsCategorised` above, and a DIFFERENT QUESTION from it:
//
//     categoryPathIsCategorised('beauty/pottery')  -> true   (two segments: somebody answered)
//     categoryPathHasDoor('beauty/pottery')        -> false  (no prefix recall browses reaches it)
//     categoryPathIsCategorised('beauty')          -> false  (a namespace is not an answer)
//     categoryPathHasDoor('beauty')                -> TRUE   (every root is an ANCESTOR_NODES entry)
//
// That last line is the whole reason the bare-domain cohort survived a standardisation pass, so the
// two predicates must never be collapsed into one.
//
// IT ASKS THE WAY RECALL ASKS -- case-sensitively, without trimming -- because a mis-cased path
// being unreachable is precisely the failure mode. `Beauty/Makeup` has no door even though
// `beauty/makeup` does. Do not "helpfully" lowercase here; that would measure a different system
// than the one serving the query.
//
// Derived from the VENDORED backend leaf set, not from CANONICAL_CATEGORY_PATHS. Building it from
// the local canonical map instead was measured to call 190 serving rows doorless where production
// calls 76 -- see the header of recallTaxonomyLeaves.js.
function categoryPathHasDoor(value) {
  const path = String(value == null ? '' : value);
  if (!path) return false;
  if (ANCESTOR_NODES.includes(path)) return true;
  return LEAF_PARENTS.some((parent) => path.startsWith(`${parent}/`));
}

// THE REVERSE DRIFT CHECK, and it runs at import so it cannot be skipped by a test that nobody
// invokes. The vendored list can go stale in two directions; this catches the one this repo can
// actually cause. If somebody adds a canonical home here that the recall taxonomy has never heard
// of, then `toCanonicalCategoryPath` would start steering rows onto a path recall cannot browse --
// the exact defect this whole area exists to prevent, arriving from the inside.
//
// The other direction (the backend adds a leaf and this copy goes stale) is caught by the fixture
// in tests/recall_taxonomy_leaf_parity.node.test.cjs, which pins the list against production.
//
// A FUNCTION, not an inline filter, for the reason pivota-backend learned the hard way with
// `gateway_collisions`: an assertion that only ever sees a clean map proves the map is clean, never
// that the check works. A test hands this a deliberately broken map and watches it fire.
function canonicalTargetsWithoutADoor(canonicalPaths = CANONICAL_CATEGORY_PATHS) {
  return Object.values(canonicalPaths || {})
    .filter((path) => !categoryPathHasDoor(path))
    .sort();
}

const _CANONICAL_WITHOUT_A_DOOR = canonicalTargetsWithoutADoor();
if (_CANONICAL_WITHOUT_A_DOOR.length) {
  throw new Error(
    'beautyTaxonomy: CANONICAL_CATEGORY_PATHS targets a path recall cannot reach: '
      + `${_CANONICAL_WITHOUT_A_DOOR.join(', ')} — either the target is wrong, or `
      + 'src/services/recallTaxonomyLeaves.js needs regenerating from pivota-backend.',
  );
}

module.exports = {
  MIN_CATEGORISED_PATH_SEGMENTS,
  TAXONOMY_LEAVES,
  LEAF_PARENTS,
  ANCESTOR_NODES,
  TAXONOMY_ROOTS,
  categoryPathHasDoor,
  canonicalTargetsWithoutADoor,
  CANONICAL_CATEGORY_PATHS,
  CATEGORY_PATH_ALIASES,
  INTENTIONALLY_DISTINCT,
  normalizeCategoryPathText,
  toCanonicalCategoryPath,
  isCanonicalCategoryPath,
  categoryPathIsCategorised,
};
