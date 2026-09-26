'use strict';

// Whether find_products_multi takes the beauty direct recall after context build (lane
// creator_direct). Until 2026-09-26 a second call site (mainline_direct) sat before the creator
// lanes and took pivot beauty contract requests with no product_only / strict conditions; #2279
// folded it in here, so a pivot contract request skips those two conditions and every other
// request keeps them. tests/beauty_direct_gate.node.test.cjs checks this against the old two
// gates over every combination of inputs.
//
// `pivotBeautyContract` may be a boolean or a function; a function is only called once the
// cheap conditions hold, as the inline && chain did, because the pivot detector runs beauty
// intent inference over the whole query.
function isBeautyDirectAfterContextEligible({
  directRecallEnabled,
  canonicalSigEntityMode,
  hasQueryText,
  beautyLike,
  searchQualityContractApplied,
  hasMerchantScope,
  pivotBeautyContract,
  productOnly,
  strictCommerce,
  shoppingCanonicalMainlineEligible,
}) {
  if (
    !directRecallEnabled ||
    canonicalSigEntityMode ||
    !hasQueryText ||
    !(beautyLike || searchQualityContractApplied) ||
    hasMerchantScope
  ) {
    return false;
  }
  const isPivot = typeof pivotBeautyContract === 'function' ? pivotBeautyContract() : pivotBeautyContract;
  return Boolean(
    isPivot ||
      (
        !productOnly &&
        (!strictCommerce || searchQualityContractApplied) &&
        (shoppingCanonicalMainlineEligible || searchQualityContractApplied)
      ),
  );
}

module.exports = { isBeautyDirectAfterContextEligible };
