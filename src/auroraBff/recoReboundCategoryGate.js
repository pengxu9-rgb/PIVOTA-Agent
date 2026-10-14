'use strict';

// WHEN GROUNDING SUBSTITUTES A PRODUCT, THE SUBSTITUTE HAS TO BE THE KIND OF PRODUCT THAT WAS ASKED FOR.
//
// groundRecoRecommendationsFromCatalog searches the catalog for each model-authored item and takes the
// first viable hit. When that hit is NOT the product the model named, the row is a `catalog_rebound`:
// the model's rationale and confidence are dropped and only the requested slot/type survive. Nothing
// checked that the substitute was the requested type. Live on prod 2026-10-14, four makeup/fragrance
// needs each carried one: a NUXE lip balm for a bronzer, a Tom Ford "Santal Blush" eau de parfum for a
// cream blush, a leather/amber parfum for a light floral eau de toilette, and a nude liquid lipstick for
// a matte red. The first two are a different category altogether, and two things let them through:
// the classifier falls back to the row's `retrieval_step` -- the step the item ASKED for, stamped on
// every recalled row -- when its own type is a word it does not map ("perfume", "balm"), and a seed
// row's `category`/`product_type` is guessed from its title, so "Santal BLUSH Eau de Parfum" is
// labelled Blush. The last two are the right category and the wrong shade or scent -- no category
// check can catch those.
//
// So the rule has two halves:
//
//   1. MAKEUP AND FRAGRANCE NEVER REBOUND. For these types the need IS the shade, finish or scent, and
//      a substitute's fit on those axes was never assessed by anyone. The item stays ungrounded and the
//      agent door lists it under metadata.unresolved_archetypes. The model's own pick (same product)
//      still grounds -- that is not a rebound.
//   2. A SKINCARE REBOUND IS JUDGED BY THE CATALOG'S OWN CATEGORY PATH, not by the row's `category` /
//      `product_type` (a title guess on seed rows) nor its retrieval step (the request itself). The
//      path is the reviewed taxonomy leaf (pivota-backend services/category_path_aliases.py
//      TAXONOMY_LEAVES, captured in tests/fixtures/recall_taxonomy_leaves.json).
//
// A requested type that resolves to no step at all has nothing to be compatible with, so a substitute
// for it is refused too.

const {
  normalizeRecoTargetStep,
  resolveRecoStepDomain,
  getRecoTargetFamilyRelation,
} = require('./recoTargetStep');

// Taxonomy leaf -> reco step, for the skincare leaves only (makeup and fragrance never rebound). The
// taxonomy is coarser than the step vocabulary -- there is no essence leaf, an SPF moisturiser lives
// under cream -- so a leaf only REFUTES a substitute when its step is incompatible with the requested
// one; an adjacent step passes, since the classifier upstream already required the row's own
// category/title to be in the requested family.
const SKINCARE_LEAF_STEP = Object.freeze({
  'beauty/skincare/cleanse/cleanser': 'cleanser',
  'beauty/skincare/moisturize/cream': 'moisturizer',
  'beauty/skincare/moisturize/oil': 'oil',
  'beauty/skincare/sun/sunscreen': 'sunscreen',
  'beauty/skincare/tone/toner': 'toner',
  'beauty/skincare/treat/exfoliant': 'treatment',
  'beauty/skincare/treat/mask': 'mask',
  'beauty/skincare/treat/serum': 'serum',
  'beauty/skincare/treat/treatment': 'treatment',
});

// Body care is skincare to this door (the description says so), so a body lotion may stand in for a
// moisturiser exactly as it could before this gate. Everything else -- makeup, fragrance, haircare,
// devices, tools, sets -- is a different kind of product.
const SKINCARE_COMPATIBLE_ROOTS = Object.freeze(['beauty/skincare', 'beauty/body']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The product's own taxonomy path as 'beauty/makeup/lip/balm', from either spelling the search emits:
// `catalog_category_path` (string) or `category_path` (array of segments). '' when the row has none.
//
// A STRING `category_path` IS NOT THE PRODUCT'S OWN. The search's applySearchQualityContractResponseHints
// (src/server.js) gives a row that has no path the REQUESTED category prefix, written as a string into
// both fields; a catalog row's own path is an array. Reading the hint as the product's category would
// approve exactly the row this gate exists to question, so a row in that shape counts as having no path.
function readCatalogCategoryPath(product) {
  if (!product || typeof product !== 'object') return '';
  if (typeof (product.category_path ?? product.categoryPath) === 'string') return '';
  const fromString = text(product.catalog_category_path || product.catalogCategoryPath);
  const segments = fromString
    ? fromString.split('/')
    : Array.isArray(product.category_path || product.categoryPath)
      ? (product.category_path || product.categoryPath)
      : [];
  return segments
    .map((segment) => text(segment).toLowerCase())
    .filter(Boolean)
    .join('/');
}

function underRoot(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * May `candidate` (a DIFFERENT product from the one the model named) ground an item that asked for
 * `requestedStep`? Returns { accept, reason }; the reason is a stable token for debug counters.
 */
function judgeRecoReboundCandidate({ requestedStep, candidate } = {}) {
  const step = normalizeRecoTargetStep(requestedStep);
  if (!step) return { accept: false, reason: 'requested_type_unresolved' };
  if (resolveRecoStepDomain(step) !== 'skincare') return { accept: false, reason: 'shade_or_scent_led_type' };

  const path = readCatalogCategoryPath(candidate);
  if (path) {
    if (!SKINCARE_COMPATIBLE_ROOTS.some((root) => underRoot(path, root))) {
      return { accept: false, reason: 'catalog_category_other_domain' };
    }
    const leafStep = SKINCARE_LEAF_STEP[path];
    if (leafStep && getRecoTargetFamilyRelation(step, leafStep) === 'incompatible_family') {
      return { accept: false, reason: 'catalog_category_incompatible' };
    }
    return { accept: true, reason: 'catalog_category_compatible' };
  }

  // No path on the row (a pool cached before the path was persisted, or an upstream that omits it).
  // The row's own type is the weaker witness, but where it NAMES a type it can still refute.
  const ownStep = normalizeRecoTargetStep(text(candidate && candidate.category) || text(candidate && candidate.product_type));
  // (A makeup or fragrance step is never in a skincare step's family, so the relation alone covers it.)
  if (ownStep && getRecoTargetFamilyRelation(step, ownStep) === 'incompatible_family') {
    return { accept: false, reason: 'own_type_incompatible' };
  }
  return { accept: true, reason: 'no_catalog_path' };
}

module.exports = {
  SKINCARE_LEAF_STEP,
  readCatalogCategoryPath,
  judgeRecoReboundCandidate,
};
