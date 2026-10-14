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
// So:
//
//   1. MAKEUP AND FRAGRANCE NEVER REBOUND. For these types the need IS the shade, finish or scent, and
//      a substitute's fit on those axes was never assessed by anyone. The item stays ungrounded and the
//      agent door lists it under metadata.unresolved_archetypes. The model's own pick still grounds when
//      it carries the catalog id, as a pick from the candidates the model was shown does
//      (sameRecommendationProduct). A product named WITHOUT an id is not matched by name: a review of
//      that rule found brand + name words could not tell "MAC Retro Matte Lipstick" (Ruby Woo) from
//      "Retro Matte Lipstick - Velvet Teddy", which is the nude-for-red swap this gate exists to stop.
//   2. AN ITEM THAT NAMES FRAGRANCE, HAIR, SCALP OR LIPS IS NOT FACE/BODY SKINCARE, whatever step its
//      words resolve to. The step resolver reads "body mist" and "fragrance mist" as toner, "hair
//      treatment" as treatment and "lip mask" as mask, so the domain check alone would let a facial
//      toner stand in for a fragrance mist.
//   3. A SKINCARE REBOUND NEEDS POSITIVE EVIDENCE that the substitute is the requested kind: the
//      catalog's own taxonomy path first (pivota-backend services/category_path_aliases.py
//      TAXONOMY_LEAVES, captured in tests/fixtures/recall_taxonomy_leaves.json), else the row's own
//      type or title. The retrieval step is never evidence -- it is the request itself.
//
// A requested type that resolves to no step at all has nothing to be compatible with, so a substitute
// for it is refused too.

const {
  normalizeRecoTargetStep,
  resolveRecoStepDomain,
  getRecoTargetFamilyRelation,
  extractRecoTargetStepFromText,
  maskNonCategoryQualifiers,
} = require('./recoTargetStep');

// Taxonomy leaf -> reco step, for the skincare leaves only (makeup and fragrance never rebound). The
// taxonomy is coarser than the step vocabulary -- there is no essence leaf, an SPF moisturiser lives
// under cream -- so a leaf only REFUTES a substitute when its step is incompatible with the requested
// one; an adjacent step passes.
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

// Product nouns that make a skincare-step word name a different kind of product (rule 2). Not the bare
// word "fragrance": a body lotion "with a light fragrance" is still a body lotion. Run over text cleared
// of denials (maskNonCategoryQualifiers, plus the phrasings below), so "fragrance-free", "sans parfum",
// "ingrown hairs" and "eye & lip contour cream" stay skincare.
const NON_SKIN_ITEM_RE = /\b(?:perfumes?|parfums?|eau de (?:parfum|toilette|cologne)|colognes?|fragrance mists?|body mists?|body sprays?|hairs?|scalp|lips?)\b/i;
const NON_SKIN_ITEM_DENIALS = Object.freeze([
  /\bsans\s+parfum\b/gi,
  /\b0\s*%\s*(?:fragrance|parfum|perfume)\b/gi,
  /\bingrown\s+hairs?\b/gi,
  /\bhair[-\s]?removal\b/gi,
  /\beyes?\s*(?:&|and|\+|\/)\s*lips?\b/gi,
]);

function maskNonSkinItemDenials(value) {
  let out = maskNonCategoryQualifiers(value);
  for (const pattern of NON_SKIN_ITEM_DENIALS) out = out.replace(pattern, (match) => ' '.repeat(match.length));
  return out;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The product's own taxonomy path as 'beauty/makeup/lip/balm', from either spelling the search emits:
// `catalog_category_path` (string) or `category_path` (string on seed rows, array on catalog rows).
// '' when the row has none.
//
// A PATH THE SEARCH INFERRED FROM THE QUERY IS NOT THE PRODUCT'S. applySearchQualityContractResponseHints
// (src/server.js) gives a row that has no path the REQUESTED category prefix and marks it
// `category_path_inferred_from_query`. Reading that as the product's category would approve exactly the
// row this gate exists to question, so a marked row counts as having no path.
function readCatalogCategoryPath(product) {
  if (!product || typeof product !== 'object') return '';
  if (product.category_path_inferred_from_query === true) return '';
  const fromString = text(product.catalog_category_path || product.catalogCategoryPath);
  const rawPath = product.category_path || product.categoryPath;
  const segments = fromString
    ? fromString.split('/')
    : Array.isArray(rawPath)
      ? rawPath
      : text(rawPath).split('/');
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
 * `requestedStep`? `requestedText` is the item's own type and name. Returns { accept, reason }; the
 * reason is a stable token for debug counters.
 */
function judgeRecoReboundCandidate({ requestedStep, requestedText = '', candidate } = {}) {
  const step = normalizeRecoTargetStep(requestedStep);
  if (!step) return { accept: false, reason: 'requested_type_unresolved' };
  if (resolveRecoStepDomain(step) !== 'skincare') return { accept: false, reason: 'shade_or_scent_led_type' };
  if (NON_SKIN_ITEM_RE.test(maskNonSkinItemDenials(text(requestedText)))) {
    return { accept: false, reason: 'non_skin_item' };
  }

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

  // No path on the row (a pool cached before the path was persisted, or a row the catalog never
  // filed). Its own category, product type or title must name a compatible step -- a substitute nothing
  // identifies is not evidence of anything. Each is tried in turn: "Moisturizers" maps to no step and
  // must not hide a product_type of "cream". On a row the search marked as inferred, category and
  // product_type may themselves be the request (the hint fills them when empty), so only the title
  // counts. (A makeup or fragrance step is never in a skincare step's family, so the relation alone
  // refutes those.)
  const row = candidate && typeof candidate === 'object' ? candidate : {};
  const inferred = row.category_path_inferred_from_query === true;
  const ownStep = (inferred ? null : normalizeRecoTargetStep(text(row.category)))
    || (inferred ? null : normalizeRecoTargetStep(text(row.product_type)))
    || extractRecoTargetStepFromText(maskNonCategoryQualifiers(text(row.name || row.title || row.display_name)));
  if (!ownStep) return { accept: false, reason: 'no_category_evidence' };
  if (getRecoTargetFamilyRelation(step, ownStep) === 'incompatible_family') {
    return { accept: false, reason: 'own_type_incompatible' };
  }
  return { accept: true, reason: 'own_type_compatible' };
}

module.exports = {
  SKINCARE_LEAF_STEP,
  readCatalogCategoryPath,
  judgeRecoReboundCandidate,
};
