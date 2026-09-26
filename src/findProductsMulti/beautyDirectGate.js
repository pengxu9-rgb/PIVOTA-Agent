'use strict';

// Whether find_products_multi takes the beauty direct recall after context build (lane
// creator_direct). Until 2026-09-26 a second call site (mainline_direct) sat before the creator
// lanes and took pivot beauty contract requests with no product_only / strict conditions; #2279
// folded it in here, so a pivot contract request skips those two conditions and every other
// request keeps them. tests/beauty_direct_gate.node.test.cjs checks this against the old two
// gates over every combination of inputs.
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
  return Boolean(
    directRecallEnabled &&
      !canonicalSigEntityMode &&
      hasQueryText &&
      (beautyLike || searchQualityContractApplied) &&
      !hasMerchantScope &&
      (
        pivotBeautyContract ||
        (
          !productOnly &&
          (!strictCommerce || searchQualityContractApplied) &&
          (shoppingCanonicalMainlineEligible || searchQualityContractApplied)
        )
      ),
  );
}

module.exports = { isBeautyDirectAfterContextEligible };
