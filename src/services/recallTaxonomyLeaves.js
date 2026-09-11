/**
 * The RECALL taxonomy's leaf set, vendored from pivota-backend so this repo can answer
 * "can category recall reach this path" with the SAME rule production uses.
 *
 * WHY THIS FILE EXISTS. `has_category_door()` in pivota-backend
 * (services/category_path_aliases.py) is derived entirely from `TAXONOMY_LEAVES`, which is derived
 * from `CATEGORY_PATTERNS` in services/pdp_category_classifier.py. This repo had no equivalent, so
 * anything here that wanted to ask the door question had to re-derive it from
 * `CANONICAL_CATEGORY_PATHS` in beautyTaxonomy.js -- and that is a DIFFERENT SET.
 *
 * MEASURED 2026-09-11, over all 217 distinct `category_path` values in production:
 *
 *     leaves in CANONICAL_CATEGORY_PATHS (this repo)  25   roots: beauty
 *     leaves in TAXONOMY_LEAVES (pivota-backend)      72   roots: beauty 42, fashion 25, electronics 5
 *
 *     serving rows the BACKEND rule calls doorless          76
 *     serving rows the CANONICAL_CATEGORY_PATHS rule would  190
 *     paths where the two disagree      40   (114 serving rows)
 *
 * Every disagreement runs one way -- the local set says "no door" where production says "door":
 * `beauty/body/care` (56 serving rows), every `fashion/*`, every `electronics/*`,
 * `beauty/body/oil`, `beauty/devices/hair-styling`. A writer-side door check built on the local set
 * would therefore skip 2.5x the rows it was meant to, and the extra ones are rows recall CAN reach.
 * That is the bug this file exists to prevent, and the reason it is a VENDORED COPY rather than a
 * clever local derivation.
 *
 * THE DIRECTION OF TRUTH. pivota-backend's own docstring says its patterns were derived from this
 * repo's `BEAUTY_CATEGORY_PATTERNS`; the two then drifted, and the backend's is now the larger and
 * the one recall's prefixes are actually computed from. So the backend is upstream FOR THIS LIST,
 * and this file is the mirror image of services/gateway_intentionally_distinct.py over there --
 * which vendors THIS repo's INTENTIONALLY_DISTINCT for the same reason, after a 2026-09-10 incident
 * where a one-sided diff collapsed seven paths in production.
 *
 * HOW TO REGENERATE, when pivota-backend's taxonomy changes:
 *
 *     python - <<'EOF'
 *     from services.category_path_aliases import TAXONOMY_LEAVES
 *     print("\n".join(sorted(TAXONOMY_LEAVES)))
 *     EOF
 *
 * `tests/recall_taxonomy_leaf_parity.node.test.cjs` pins this list against a fixture captured from
 * production and will fail if it is edited by hand without the fixture moving with it.
 *
 * WHAT THIS FILE IS NOT. Not a canonicalisation table and not a replacement for
 * CANONICAL_CATEGORY_PATHS. That map answers "where should this semantic category LIVE" (a writer
 * decision, beauty-only, deliberately small). This list answers "which paths does recall's prefix
 * machinery know about" (a read-side fact). They are different questions and conflating them is
 * what produced the 2.5x above.
 */

'use strict';

// Sorted, and grouped by root purely for reading. Order is not semantic.
const TAXONOMY_LEAVES = Object.freeze([
  // --- beauty (42) ------------------------------------------------------
  'beauty/body/care',
  'beauty/body/tanning',
  'beauty/devices/facial-cleansing',
  'beauty/devices/hair-removal',
  'beauty/devices/hair-styling',
  'beauty/devices/nail',
  'beauty/devices/skincare-energy',
  'beauty/fragrance/perfume',
  'beauty/haircare/conditioner',
  'beauty/haircare/general',
  'beauty/haircare/shampoo',
  'beauty/haircare/styling',
  'beauty/makeup/eye/brow',
  'beauty/makeup/eye/eyeliner',
  'beauty/makeup/eye/eyeshadow',
  'beauty/makeup/eye/mascara',
  'beauty/makeup/face/blush',
  'beauty/makeup/face/bronzer',
  'beauty/makeup/face/concealer',
  'beauty/makeup/face/foundation',
  'beauty/makeup/face/highlighter',
  'beauty/makeup/face/powder',
  'beauty/makeup/face/primer',
  'beauty/makeup/lip/balm',
  'beauty/makeup/lip/gloss',
  'beauty/makeup/lip/liner',
  'beauty/makeup/lip/lipstick',
  'beauty/makeup/lip/oil',
  'beauty/makeup/lip/tint',
  'beauty/sets/gift-set',
  'beauty/skincare/cleanse/cleanser',
  'beauty/skincare/moisturize/cream',
  'beauty/skincare/moisturize/oil',
  'beauty/skincare/sun/sunscreen',
  'beauty/skincare/tone/toner',
  'beauty/skincare/treat/exfoliant',
  'beauty/skincare/treat/mask',
  'beauty/skincare/treat/serum',
  'beauty/skincare/treat/treatment',
  'beauty/tools/brush',
  'beauty/tools/brush-accessory',
  'beauty/tools/sponge',

  // --- electronics (5) -------------------------------------------------
  'electronics/audio/earbuds',
  'electronics/audio/headphones',
  'electronics/audio/speaker',
  'electronics/drones/camera-drone',
  'electronics/ereader',

  // --- fashion (25) -----------------------------------------------------
  'fashion/accessories/bag',
  'fashion/accessories/hat',
  'fashion/accessories/jewelry',
  'fashion/accessories/pet',
  'fashion/accessories/scarf',
  'fashion/apparel/activewear',
  'fashion/apparel/base-layer',
  'fashion/apparel/bottoms/jeans',
  'fashion/apparel/bottoms/pants',
  'fashion/apparel/bottoms/shorts',
  'fashion/apparel/bottoms/skirt',
  'fashion/apparel/dresses',
  'fashion/apparel/general',
  'fashion/apparel/intimates/lingerie',
  'fashion/apparel/outerwear/coat',
  'fashion/apparel/outerwear/jacket',
  'fashion/apparel/outerwear/vest',
  'fashion/apparel/pet',
  'fashion/apparel/sleepwear',
  'fashion/apparel/swimwear',
  'fashion/apparel/tops/hoodie',
  'fashion/apparel/tops/shirt',
  'fashion/apparel/tops/sweater',
  'fashion/apparel/tops/tshirt',
  'fashion/shoes',
]);

// The prefixes recall actually asks for -- the leaf's PARENT plus a slash, per the backend's
// `category_path_prefix_for_query`. A path is reachable when it sits UNDER one of these, which is
// why a path can be reachable without being a leaf itself.
const LEAF_PARENTS = Object.freeze([
  ...new Set(TAXONOMY_LEAVES.map((path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : path))),
]);

// #2122's ancestor admission: a path that is a strict ancestor of a query prefix is admitted too.
//
// NOTE the range -- it starts at 1, so EVERY TOP-LEVEL DOMAIN IS IN HERE. `beauty` is an ancestor
// node and therefore has a "category door" while resolving to no leaf at all. That is not a bug to
// fix here; it is the exact reason a bare domain passed every off-taxonomy health check while being
// unretrievable, and it is why `categoryPathIsCategorised` is a SEPARATE question from this one.
const ANCESTOR_NODES = Object.freeze([
  ...new Set(
    TAXONOMY_LEAVES.flatMap((path) => {
      const parts = path.split('/');
      return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'));
    }),
  ),
]);

const TAXONOMY_ROOTS = Object.freeze([...new Set(TAXONOMY_LEAVES.map((path) => path.split('/')[0]))]);

module.exports = {
  TAXONOMY_LEAVES,
  LEAF_PARENTS,
  ANCESTOR_NODES,
  TAXONOMY_ROOTS,
};
