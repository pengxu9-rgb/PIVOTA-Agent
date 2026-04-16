const {
  buildSeedGate,
  buildExtractorGate,
  buildProductIntelGate,
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

  test('fails product intel gate when the module exists but user-visible copy is not displayable', () => {
    const gate = buildProductIntelGate({
      liveResponse: {
        modules: [
          {
            type: 'product_intel',
            data: {
              product_intel_core: {
                what_it_is: {
                  headline: 'Overview',
                  body: 'Presented through merchant product data for a general skincare routine...',
                },
              },
              quality_state: 'eligible',
              provenance: {
                reviewer_kind: 'assistant',
                review_status: 'completed',
                review_decision: 'rewrite',
                selection_strategy: 'curated_override',
              },
            },
          },
        ],
      },
    });

    expect(gate.status).toBe('failed');
    expect(gate.failure_reasons).toEqual(
      expect.arrayContaining(['product_intel_not_displayable', 'product_intel_truncated_copy']),
    );
  });

  test('passes product intel gate only for reviewed product-specific copy', () => {
    const gate = buildProductIntelGate({
      liveResponse: {
        modules: [
          {
            type: 'product_intel',
            data: {
              product_intel_core: {
                evidence_profile: 'seller_plus_formula',
                quality_state: 'eligible',
                what_it_is: {
                  headline: 'Tinted mineral sunscreen',
                  body: 'Zinc oxide mineral SPF with a flexible tint for lightweight coverage.',
                },
                why_it_stands_out: [
                  {
                    headline: 'Shade-aware SPF',
                    body: 'Tinted coverage helps even visible tone while keeping the sunscreen step lightweight.',
                  },
                ],
              },
              evidence_profile: 'seller_plus_formula',
              quality_state: 'eligible',
              provenance: {
                reviewer_kind: 'assistant',
                review_status: 'completed',
                review_decision: 'rewrite',
                selection_strategy: 'curated_override',
              },
            },
          },
        ],
      },
    });

    expect(gate.status).toBe('passed');
    expect(gate.failure_reasons).toEqual([]);
  });

  test('flags structured sections, merchant FAQ, active ingredients, and thin similar card drift', () => {
    const livePdpGate = buildLivePdpGate({
      seedData: {
        pdp_details_sections: [
          { heading: 'Rice-Infused Hydration', content: 'Hydrates skin.' },
          { heading: 'Secret Sebum-Control Layer', content: 'Controls visible oil.' },
          { heading: 'How to Use', content: 'Apply daily.' },
        ],
        pdp_faq_items: [
          {
            question: 'Can I use it every day?',
            answer: 'Yes, it is designed for daily use.',
          },
        ],
        pdp_active_ingredients_raw: 'Zinc Oxide',
      },
      livePayload: {
        modules: [
          {
            type: 'product_details',
            data: {
              sections: [
                { heading: 'Description', content: 'A short sunscreen overview.' },
                { heading: 'Category', content: 'Sunscreen' },
              ],
            },
          },
        ],
      },
    });
    const similarGate = buildSimilarGate({
      similarResponse: {
        products: [
          { product_id: 'ext_1', merchant_id: 'external_seed', title: 'Thin card', category: 'Toner' },
          { product_id: 'ext_2', merchant_id: 'external_seed', title: 'Thin card 2' },
          { product_id: 'ext_3', merchant_id: 'external_seed', title: 'Thin card 3' },
          { product_id: 'ext_4', merchant_id: 'external_seed', title: 'Thin card 4' },
        ],
      },
      exclusionFlags: { gift_card: false, donation_bundle: false, non_merchandise: false },
    });

    expect(livePdpGate.failure_reasons).toEqual(
      expect.arrayContaining([
        'structured_sections_compressed_to_description_category',
        'merchant_faq_dropped',
        'active_ingredients_expected_but_hidden',
      ]),
    );
    expect(similarGate.failure_reasons).toEqual(['similar_card_missing_highlight']);
  });

  test('flags similar cards that lack backend-provided displayable highlights', () => {
    const similarGate = buildSimilarGate({
      similarResponse: {
        products: [
          { product_id: 'ext_1', title: 'Tinted SPF' },
          {
            product_id: 'ext_2',
            title: 'Mineral SPF',
            shopping_card: {
              highlight: 'Flexible tint helps soften visible tone.',
            },
          },
          {
            product_id: 'ext_3',
            title: 'Daily SPF',
            shopping_card: {
              highlight: 'Mineral filters for daily UV.',
            },
          },
          {
            product_id: 'ext_4',
            title: 'Soft Focus SPF',
            shopping_card: {
              highlight: 'Soft-focus finish for daily wear.',
            },
          },
        ],
      },
      exclusionFlags: { gift_card: false, donation_bundle: false, non_merchandise: false },
    });

    expect(similarGate.status).toBe('failed');
    expect(similarGate.failure_reasons).toContain('similar_card_missing_highlight');
    expect(similarGate.highlight_missing_count).toBe(1);
  });

  test('does not count descriptions or category-only similar cards as highlight-ready', () => {
    const similarGate = buildSimilarGate({
      similarResponse: {
        products: [
          { product_id: 'ext_1', merchant_id: 'external_seed', title: 'Category only', category: 'Toner' },
          {
            product_id: 'ext_2',
            merchant_id: 'external_seed',
            title: 'Description only',
            description: 'Milky toner with barrier-supporting ingredients.',
          },
          { product_id: 'ext_3', merchant_id: 'external_seed', title: 'Category only 2', product_type: 'Serum' },
          { product_id: 'ext_4', merchant_id: 'external_seed', title: 'Category only 3', category: 'Moisturizer' },
        ],
      },
      exclusionFlags: { gift_card: false, donation_bundle: false, non_merchandise: false },
    });

    expect(similarGate.failure_reasons).toEqual(['similar_card_missing_highlight']);
    expect(similarGate.highlight_missing_count).toBe(4);
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
