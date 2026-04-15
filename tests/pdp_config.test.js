const {
  EXTERNAL_SEED_MERCHANT_ID,
  STANDARD_PDP_INITIAL_INCLUDE,
  buildPdpCorePrewarmRequestBody,
  inferCanonicalPdpMerchantId,
} = require('../src/pdpConfig');

describe('pdpConfig', () => {
  test('uses the full standard pdp initial include set', () => {
    expect(STANDARD_PDP_INITIAL_INCLUDE).toEqual([
      'offers',
      'variant_selector',
      'active_ingredients',
      'ingredients_inci',
      'how_to_use',
      'product_overview',
      'supplemental_details',
      'reviews_preview',
    ]);
  });

  test('builds the shared pdp prewarm request body', () => {
    expect(
      buildPdpCorePrewarmRequestBody(
        { merchant_id: 'external_seed', product_id: 'ext_123' },
        'pdp_core_prewarm_script',
      ),
    ).toEqual({
      operation: 'get_pdp_v2',
      payload: {
        product_ref: {
          merchant_id: 'external_seed',
          product_id: 'ext_123',
        },
        include: [...STANDARD_PDP_INITIAL_INCLUDE],
        options: {
          debug: false,
        },
      },
      metadata: {
        source: 'pdp_core_prewarm_script',
      },
    });
  });

  test('infers external seed merchant ids for ext_* product ids', () => {
    expect(inferCanonicalPdpMerchantId('ext_123', null)).toBe(EXTERNAL_SEED_MERCHANT_ID);
    expect(inferCanonicalPdpMerchantId('ext:abc', '')).toBe(EXTERNAL_SEED_MERCHANT_ID);
    expect(inferCanonicalPdpMerchantId('prod_1', null)).toBeNull();
    expect(inferCanonicalPdpMerchantId('ext_123', 'merchant_a')).toBe('merchant_a');
  });
});
