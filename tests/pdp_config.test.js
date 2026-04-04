const {
  STANDARD_PDP_INITIAL_INCLUDE,
  buildPdpCorePrewarmRequestBody,
} = require('../src/pdpConfig');

describe('pdpConfig', () => {
  test('uses the full standard pdp initial include set', () => {
    expect(STANDARD_PDP_INITIAL_INCLUDE).toEqual([
      'offers',
      'variant_selector',
      'active_ingredients',
      'ingredients_inci',
      'how_to_use',
      'product_details',
      'reviews_preview',
      'similar',
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
});
