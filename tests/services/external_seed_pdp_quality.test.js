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
        'similar_underfill',
      ]),
    );
  });

  test('exempts gift cards from strict similar count requirement', () => {
    const similarGate = buildSimilarGate({
      similarResponse: { products: [] },
      exclusionFlags: { gift_card: true, donation_bundle: false, non_merchandise: false },
    });

    expect(similarGate.status).toBe('exempt');
    expect(similarGate.failure_reasons).toEqual([]);
  });
});
