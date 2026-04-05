const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';

const STANDARD_PDP_INITIAL_INCLUDE = Object.freeze([
  'offers',
  'variant_selector',
  'active_ingredients',
  'ingredients_inci',
  'how_to_use',
  'product_details',
  'reviews_preview',
  'similar',
]);

function inferCanonicalPdpMerchantId(productId, merchantId) {
  const explicitMerchantId = String(merchantId || '').trim();
  if (explicitMerchantId) return explicitMerchantId;

  const normalizedProductId = String(productId || '').trim().toLowerCase();
  if (!normalizedProductId) return null;
  if (normalizedProductId.startsWith('ext_') || normalizedProductId.startsWith('ext:')) {
    return EXTERNAL_SEED_MERCHANT_ID;
  }
  return null;
}

function buildPdpCorePrewarmRequestBody(target, metadataSource = 'pdp_core_prewarm') {
  return {
    operation: 'get_pdp_v2',
    payload: {
      product_ref: {
        merchant_id: String(target?.merchant_id || '').trim(),
        product_id: String(target?.product_id || '').trim(),
      },
      include: [...STANDARD_PDP_INITIAL_INCLUDE],
      options: {
        debug: false,
      },
    },
    metadata: {
      source: metadataSource,
    },
  };
}

module.exports = {
  EXTERNAL_SEED_MERCHANT_ID,
  STANDARD_PDP_INITIAL_INCLUDE,
  buildPdpCorePrewarmRequestBody,
  inferCanonicalPdpMerchantId,
};
