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
//   2. AN ITEM -- OR A CANDIDATE -- WHOSE WORDS NAME MAKEUP, FRAGRANCE, HAIR, SCALP, LIPS, LASHES, BROWS,
//      NAILS OR SELF-TAN IS NOT FACE/BODY SKINCARE, whatever step those words resolve to. The step
//      resolver settles overlaps to one step: "body mist" and "setting mist" read as toner, "hair
//      treatment" as treatment, "lip mask" as mask, "Liquid Touch Serum Foundation" as serum and
//      "Highlighter Cream" as moisturizer. So the requested step alone would let a facial toner stand in
//      for a setting mist, and a niacinamide serum for a serum foundation.
//   3. A SKINCARE REBOUND NEEDS POSITIVE EVIDENCE that the substitute is the requested kind: the
//      catalog's own step-level taxonomy leaf (pivota-backend services/category_path_aliases.py
//      TAXONOMY_LEAVES, captured in tests/fixtures/recall_taxonomy_leaves.json), else -- for a row with
//      no path, or a path too coarse to name a step -- its own category, type and title, which must
//      name at least one step and contradict none. The retrieval step is never evidence: it is the
//      request itself.
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
// moisturiser exactly as it could before this gate. Self-tan (beauty/body/tanning) is not: a bronzing
// mousse is not a sunscreen. Everything else -- makeup, fragrance, haircare, devices, tools, sets -- is
// a different kind of product.
const SKINCARE_COMPATIBLE_ROOTS = Object.freeze(['beauty/skincare', 'beauty/body/care']);
// Paths that say "beauty" or "body" and nothing more: neither for nor against, so the row's own words
// decide.
const UNSPECIFIC_PATHS = Object.freeze(['beauty', 'beauty/body']);

// Product nouns that make a skincare-step word name a different kind of product (rule 2). Not the bare
// word "fragrance": a body lotion "with a light fragrance" is still a body lotion. Run over text cleared
// of denials and context (maskNonCategoryQualifiers already clears "fragrance-free" and "wears under
// foundation"; the phrasings below are cleared on top), so "sans parfum", "ingrown hairs" and "eye & lip
// contour cream" stay skincare.
const NON_SKIN_ITEM_RE = new RegExp(`\\b(?:${[
  // fragrance
  'perfumes?', 'parfums?', 'eau de (?:parfum|toilette|cologne)', 'colognes?', 'fragrance mists?',
  'body mists?', 'body sprays?',
  // makeup (the nouns a complexion/eye/lip product is titled by)
  'foundations?', 'concealers?', 'mascaras?', 'eye ?liners?', 'eye ?shadows?', 'blush(?:es)?',
  'bronz(?:er|ers|ing)', 'highlighters?', 'illuminators?', 'luminizers?', 'primers?',
  'setting (?:powders?|sprays?|mists?)', 'face powders?', 'contour(?:ing)?', 'skin tints?',
  '[bc]c creams?', 'tinted',
  // other body parts and kinds this door does not treat as skincare
  'hairs?', 'scalp', 'lips?', 'lipsticks?', 'lipgloss(?:es)?', 'lipliners?', 'lash(?:es)?', 'brows?', 'nails?', 'cuticles?', 'self[- ]?tan\\w*', 'tanning',
].join('|')})\\b`, 'i');
const NON_SKIN_ITEM_DENIALS = Object.freeze([
  /\bsans\s+parfum\b/gi,
  /\b0\s*%\s*(?:fragrance|parfum|perfume)\b/gi,
  /\bingrown\s+hairs?\b/gi,
  /\bhair[-\s]?removal\b/gi,
  /\beyes?\s*(?:&|and|\+|\/)\s*lips?(?:\s+contour)?\b/gi,
  /\beye\s+contour\b/gi,
]);

// Makeup, fragrance and lash/brow products the step resolver settles to a skincare step ("setting
// mist" and "body mist" read as toner, "lash serum" as serum). Only these: a need is matched on what it
// asks for, not on every word -- "frown lines between my brows" is a skincare need, "eyebrow serum" is
// not. Matched on the MASKED need, so "a toner to use under my setting powder" stays a toner need.
const NEED_RESOLVER_GAPS_RE = new RegExp(`\\b(?:${[
  'setting[- ]?(?:sprays?|mists?|powders?)', 'set(?:s|ting)? (?:my |your |the )?make-?up',
  'make-?up (?:setting|fixing|fixer) (?:sprays?|mists?)', 'fix(?:ing|er) (?:sprays?|mists?)',
  'body mists?', 'fragrance mists?', 'body sprays?',
  '(?:eye)?lash(?:es)?', 'eyebrows?', 'brow (?:serums?|gels?|growth|tints?|pencils?|powders?|pomades?)',
].join('|')})\\b`, 'i');

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
 * `requestedStep`? `requestedText` is the item's own type and name; `needText` is the buyer's need when
 * the door has one. Returns { accept, reason }; the reason is a stable token for debug counters.
 */
function judgeRecoReboundCandidate({ requestedStep, requestedText = '', needText = '', candidate } = {}) {
  const step = normalizeRecoTargetStep(requestedStep);
  if (!step) return { accept: false, reason: 'requested_type_unresolved' };
  if (resolveRecoStepDomain(step) !== 'skincare') return { accept: false, reason: 'shade_or_scent_led_type' };
  if (NON_SKIN_ITEM_RE.test(maskNonSkinItemDenials(text(requestedText)))) {
    return { accept: false, reason: 'non_skin_item' };
  }
  // THE BUYER'S NEED, not only the model's item. Live 2026-10-14 "a setting mist that keeps makeup in
  // place" grounded to a skincare serum mist: the model's own item was a facial mist typed toner, so
  // the item said nothing non-skin, and a toner was a compatible substitute FOR THE ITEM. A need that
  // ASKS FOR a makeup or fragrance product gets no substitute at all.
  //
  // Narrower than the item rule on purpose. A need is a sentence, not a product name: "a moisturizer
  // for dry patches around my lips", "a serum for frown lines between my brows" and "a firming,
  // contouring neck cream" are skincare asks that MENTION non-skin words, and the item rule would have
  // refused every substitute in them (review of the first cut). So the need must RESOLVE to a single
  // makeup or fragrance step, or name one of the few makeup/fragrance products the step resolver reads
  // as skincare (NEED_RESOLVER_GAPS_RE).
  // "long-wear foundation" is a product, not "wear foundation" as context: fold it before masking.
  const maskedNeed = maskNonSkinItemDenials(text(needText).replace(/\blong[- ]wear(ing)?\b/gi, 'longwear$1'));
  const needStep = extractRecoTargetStepFromText(maskedNeed);
  if ((needStep && resolveRecoStepDomain(needStep) !== 'skincare') || NEED_RESOLVER_GAPS_RE.test(maskedNeed)) {
    return { accept: false, reason: 'shade_or_scent_led_need' };
  }
  const row = candidate && typeof candidate === 'object' ? candidate : {};
  const title = text(row.name || row.title || row.display_name);
  if (NON_SKIN_ITEM_RE.test(maskNonSkinItemDenials(title))) {
    return { accept: false, reason: 'non_skin_candidate' };
  }

  const path = readCatalogCategoryPath(row);
  if (path && !UNSPECIFIC_PATHS.includes(path)) {
    if (!SKINCARE_COMPATIBLE_ROOTS.some((root) => underRoot(path, root))) {
      return { accept: false, reason: 'catalog_category_other_domain' };
    }
    const leafStep = SKINCARE_LEAF_STEP[path];
    if (leafStep) {
      return getRecoTargetFamilyRelation(step, leafStep) === 'incompatible_family'
        ? { accept: false, reason: 'catalog_category_incompatible' }
        : { accept: true, reason: 'catalog_category_compatible' };
    }
    // A skincare/body-care path too coarse to name a step ("beauty/skincare/treat", "beauty/body/care")
    // proves the domain only; the row's own words must still name the kind.
  }

  // The row's own category, product type and title. Each is read on its own -- "Skincare" maps to no
  // step and must not hide a product_type of "cream" -- and they must AGREE: a "Gentle Foaming
  // Cleanser" typed "serum" is not evidence of a serum. On a row the search marked as inferred,
  // category and product_type may themselves be the request (the hint fills them when empty), so only
  // the title counts. (A makeup or fragrance step is never in a skincare step's family, so the relation
  // refutes those too.)
  const inferred = row.category_path_inferred_from_query === true;
  const ownSteps = [
    inferred ? null : normalizeRecoTargetStep(text(row.category)),
    inferred ? null : normalizeRecoTargetStep(text(row.product_type)),
    extractRecoTargetStepFromText(maskNonCategoryQualifiers(title)),
  ].filter(Boolean);
  if (!ownSteps.length) return { accept: false, reason: 'no_category_evidence' };
  if (ownSteps.some((ownStep) => getRecoTargetFamilyRelation(step, ownStep) === 'incompatible_family')) {
    return { accept: false, reason: 'own_type_incompatible' };
  }
  return { accept: true, reason: 'own_type_compatible' };
}

module.exports = {
  SKINCARE_LEAF_STEP,
  readCatalogCategoryPath,
  judgeRecoReboundCandidate,
};
