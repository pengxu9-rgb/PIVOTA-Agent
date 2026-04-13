const {
  buildSeedGate,
  buildExtractorGate,
  buildLivePdpGate,
  buildSimilarGate,
  buildExternalSeedQualityResult,
} = require('../../src/services/externalSeedPdpQuality');

describe('externalSeedPdpQuality', () => {
  test('flags missing overview, polluted facts, and similar underfill for eligible seeds', () => {
    const seedGate = buildSeedGate({ findings: [] });
    const extractorGate = buildExtractorGate({
      extractorResponse: { diagnostics: {} },
      extractorProduct: {
        description_raw: 'Hydrating serum for barrier support.',
        variants: [{ price: '25.00' }],
      },
    });
    const livePdpGate = buildLivePdpGate({
      extractorProduct: {
        description_raw: 'Hydrating serum for barrier support.',
        variants: [{ price: '25.00' }],
      },
      livePayload: {
        product: {
          description: 'Hydrating serum for barrier support.',
        },
        modules: [
          {
            type: 'price_promo',
            data: { price: { amount: 25, currency: 'USD' } },
          },
          {
            type: 'product_facts',
            data: {
              sections: [
                { heading: 'Support', content: 'About us blog impact foundation transparency.' },
                { heading: 'Description', content: 'Hydrating serum for barrier support.' },
              ],
            },
          },
        ],
      },
    });
    const similarGate = buildSimilarGate({
      similarResponse: { products: [] },
      exclusionFlags: { gift_card: false, donation_bundle: false, non_merchandise: false },
    });
    const result = buildExternalSeedQualityResult({
      seedId: 'eps_1',
      externalProductId: 'ext_1',
      canonicalUrl: 'https://example.com/products/hydrating-serum',
      seedGate,
      extractorGate,
      livePdpGate,
      similarGate,
    });

    expect(result.failure_reasons).toEqual(
      expect.arrayContaining([
        'missing_overview_from_available_description',
        'polluted_product_facts',
        'duplicated_description_facts',
        'similar_underfill',
      ]),
    );
  });

  test('flags polluted live description and details independently from facts', () => {
    const livePdpGate = buildLivePdpGate({
      extractorProduct: {
        description_raw: 'Clean description.',
        variants: [{ price: '25.00' }],
      },
      livePayload: {
        product: {
          description:
            'OFFICIAL: Clean description. /// SOCIAL HIGHLIGHTS: Community copy should not appear.',
        },
        modules: [
          {
            type: 'price_promo',
            data: { price: { amount: 25, currency: 'USD' } },
          },
          {
            type: 'product_details',
            data: {
              sections: [
                { heading: 'Overview', content: 'THE LOWDOWN: Clean description.' },
              ],
            },
          },
        ],
      },
    });

    expect(livePdpGate.failure_reasons).toEqual(
      expect.arrayContaining(['polluted_product_description', 'polluted_product_details']),
    );
  });

  test('uses exact seed price when auditing variant-scoped PDP live output', () => {
    const livePdpGate = buildLivePdpGate({
      expectedPrice: 56,
      extractorProduct: {
        description_raw: 'Vitamin C serum.',
        variants: [{ price: '64.00' }],
      },
      livePayload: {
        modules: [
          {
            type: 'price_promo',
            data: { price: { amount: 56, currency: 'USD' } },
          },
          {
            type: 'product_details',
            data: { sections: [{ heading: 'Overview', content: 'Vitamin C serum.' }] },
          },
        ],
      },
    });

    expect(livePdpGate.status).toBe('passed');
    expect(livePdpGate.failure_reasons).not.toContain('price_mismatch');
  });

  test('exempts gift cards from strict similar count requirement', () => {
    const similarGate = buildSimilarGate({
      similarResponse: { products: [] },
      exclusionFlags: { gift_card: true, donation_bundle: false, non_merchandise: false },
    });

    expect(similarGate.status).toBe('exempt');
    expect(similarGate.failure_reasons).toEqual([]);
  });

  test('reports probe failures instead of misclassifying them as product-quality regressions', () => {
    const livePdpGate = buildLivePdpGate({
      extractorProduct: {
        description_raw: 'Warm vanilla fragrance with deep amber notes.',
        variants: [{ price: '405.00' }],
      },
      livePayload: {},
      liveResponse: {
        error: 'AUTH_INTROSPECT_UNAVAILABLE',
        message: 'Authentication service unavailable',
      },
    });
    const similarGate = buildSimilarGate({
      similarResponse: {
        error: 'AUTH_INTROSPECT_UNAVAILABLE',
        message: 'Authentication service unavailable',
      },
      exclusionFlags: { gift_card: false, donation_bundle: false, non_merchandise: false },
    });

    expect(livePdpGate.failure_reasons).toEqual(['live_pdp_probe_failed']);
    expect(livePdpGate.probe_error).toBe('Authentication service unavailable');
    expect(similarGate.failure_reasons).toEqual(['similar_probe_failed']);
    expect(similarGate.probe_error).toBe('Authentication service unavailable');
  });
});
