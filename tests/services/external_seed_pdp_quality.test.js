const {
  buildSeedGate,
  buildExtractorGate,
  buildSourceUnavailableExtractorGate,
  buildProductIntelGate,
  buildLivePdpGate,
  buildSimilarGate,
  buildExternalSeedQualityResult,
  looksLikeSectionSoupText,
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

  test('treats extractor misses as terminal for reviewed source-unavailable seeds', () => {
    const extractorGate = buildSourceUnavailableExtractorGate({
      extractorResponse: {
        diagnostics: {
          failure_category: 'no_product_urls',
        },
      },
      extractorProduct: {},
      seedData: {
        source_unavailable_v1: {
          status: 'source_unavailable',
          reason: 'official PDP returns 404',
        },
      },
    });

    expect(extractorGate.status).toBe('terminal_source_unavailable');
    expect(extractorGate.source_unavailable).toBe(true);
    expect(extractorGate.failure_reasons).toEqual([]);
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
      seedData: {
        external_seed_snapshot_contract: {
          authoritative: true,
          legacy_fields_quarantined: true,
          replace_strategy: 'replace_not_merge',
        },
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

  test('treats disabled similar probes as skipped instead of PDP quality failures', () => {
    const similarGate = buildSimilarGate({
      similarResponse: { skipped: true, reason: 'similar_probe_disabled' },
      exclusionFlags: { gift_card: false, donation_bundle: false, non_merchandise: false },
    });

    expect(similarGate.status).toBe('skipped');
    expect(similarGate.skipped_reason).toBe('similar_probe_disabled');
    expect(similarGate.failure_reasons).toEqual([]);
  });

  test('prefers non-empty direct similar probe products over empty live PDP similar module', () => {
    const similarGate = buildSimilarGate({
      liveResponse: {
        modules: [
          {
            type: 'similar',
            data: { items: [] },
          },
        ],
      },
      similarResponse: {
        products: [
          {
            product_id: 'sig_lip_balm_1',
            title: 'Moonlight Lip Balm',
            card_highlight_status: 'ready',
            card_highlight: 'Glossy color lip balm.',
          },
          {
            product_id: 'sig_lip_balm_2',
            title: 'Glazed Lip Gloss',
            card_highlight_status: 'ready',
            card_highlight: 'High-shine lip color.',
          },
          {
            product_id: 'sig_lip_balm_3',
            title: 'Tinted Repair Lip Serum',
            card_highlight_status: 'ready',
            card_highlight: 'Tinted lip serum.',
          },
          {
            product_id: 'sig_lip_balm_4',
            title: 'Water Gloss',
            card_highlight_status: 'ready',
            card_highlight: 'Hydrating gloss.',
          },
        ],
      },
      exclusionFlags: { gift_card: false, donation_bundle: false, non_merchandise: false },
    });

    expect(similarGate.status).toBe('passed');
    expect(similarGate.similar_count).toBe(4);
    expect(similarGate.failure_reasons).toEqual([]);
  });

  test('fails product intel gate when the module is present but blocked or empty', () => {
    const gate = buildProductIntelGate({
      liveResponse: {
        modules: [{ type: 'product_intel', data: null, reason: 'missing_blocked' }],
        metadata: { product_intel_status: 'missing_blocked' },
      },
    });

    expect(gate.status).toBe('failed');
    expect(gate.failure_reasons).toEqual(['product_intel_module_empty_or_blocked']);
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

  test('does not infer active sunscreen ingredients from cosmetic pigment INCI alone', () => {
    const livePdpGate = buildLivePdpGate({
      seedData: {
        title: 'Longwear Pencil Eyeliner',
        pdp_ingredients_raw:
          'TRISILOXANE, POLYETHYLENE, MICA, TITANIUM DIOXIDE (CI 77891), IRON OXIDES (CI 77499).',
      },
      livePayload: {
        modules: [
          {
            type: 'product_details',
            data: {
              sections: [{ heading: 'Overview', content: 'A creamy pencil eyeliner.' }],
            },
          },
        ],
      },
    });

    expect(livePdpGate.active_ingredients_status.expected).toBe(false);
    expect(livePdpGate.failure_reasons).not.toContain('active_ingredients_expected_but_hidden');
  });

  test('does not infer active sunscreen ingredients for foundation just because how-to mentions SPF prep', () => {
    const livePdpGate = buildLivePdpGate({
      seedData: {
        title: "Pro Filt'r Soft Matte Longwear Foundation - #210",
        category: 'Foundation',
        pdp_ingredients_raw:
          'AQUA/WATER/EAU, DIMETHICONE, TALC, TITANIUM DIOXIDE (CI 77891), IRON OXIDES (CI 77492).',
        pdp_how_to_use_raw:
          'Prep skin with SPF moisturizer before applying foundation. Shake before use, then blend outward.',
      },
      livePayload: {
        modules: [
          {
            type: 'product_details',
            data: {
              sections: [{ heading: 'Overview', content: 'A soft matte longwear foundation.' }],
            },
          },
        ],
      },
    });

    expect(livePdpGate.active_ingredients_status.expected).toBe(false);
    expect(livePdpGate.failure_reasons).not.toContain('active_ingredients_expected_but_hidden');
  });

  test('does not expect active ingredients for makeup when stale active fields remain quarantined', () => {
    const livePdpGate = buildLivePdpGate({
      seedData: {
        title: 'Skin Tint Blurring Elixir',
        category: 'Foundation',
        pdp_active_ingredients_raw: 'Hyaluronic Acid, Niacinamide',
        pdp_field_quality_summary: {
          active_ingredients_raw: {
            source_quality_status: 'quarantined',
          },
        },
      },
      livePayload: {
        modules: [
          {
            type: 'product_details',
            data: {
              sections: [{ heading: 'Overview', content: 'A blurring complexion tint.' }],
            },
          },
        ],
      },
    });

    expect(livePdpGate.active_ingredients_status.expected).toBe(false);
    expect(livePdpGate.failure_reasons).not.toContain('active_ingredients_expected_but_hidden');
  });

  test('does not expect active ingredients for makeup from stale active fields without reviewed contract', () => {
    const livePdpGate = buildLivePdpGate({
      seedData: {
        title: 'Power Plush Longwear Foundation',
        category: 'Foundation',
        pdp_active_ingredients_raw: 'Vitamin E',
      },
      livePayload: {
        modules: [
          {
            type: 'product_details',
            data: {
              sections: [{ heading: 'Overview', content: 'A medium coverage longwear foundation.' }],
            },
          },
        ],
      },
    });

    expect(livePdpGate.active_ingredients_status.expected).toBe(false);
    expect(livePdpGate.failure_reasons).not.toContain('active_ingredients_expected_but_hidden');
  });

  test('expects active sunscreen ingredients when UV filter INCI has SPF context', () => {
    const livePdpGate = buildLivePdpGate({
      seedData: {
        title: 'Daily Tinted Fluid Sunscreen SPF 40',
        pdp_ingredients_raw: 'WATER, ZINC OXIDE, TITANIUM DIOXIDE, GLYCERIN.',
      },
      livePayload: {
        modules: [
          {
            type: 'product_details',
            data: {
              sections: [{ heading: 'Overview', content: 'A daily tinted sunscreen.' }],
            },
          },
        ],
      },
    });

    expect(livePdpGate.active_ingredients_status.expected).toBe(true);
    expect(livePdpGate.failure_reasons).toContain('active_ingredients_expected_but_hidden');
  });

  test('does not mark structured sections as compressed when dedicated modules carry them', () => {
    const livePdpGate = buildLivePdpGate({
      seedData: {
        pdp_details_sections: [
          { heading: 'Overview', content: 'A short overview.' },
          { heading: 'Details', content: 'Detailed seller copy.' },
          { heading: 'How to Use', content: 'Apply daily.' },
        ],
      },
      livePayload: {
        modules: [
          {
            type: 'product_overview',
            data: {
              sections: [{ heading: 'Description', content: 'A short overview.' }],
            },
          },
          {
            type: 'how_to_use',
            data: {
              steps: [{ text: 'Apply daily.' }],
            },
          },
        ],
      },
    });

    expect(livePdpGate.details_status.compressed_structured_sections).toBe(false);
    expect(livePdpGate.failure_reasons).not.toContain('structured_sections_compressed_to_description_category');
  });

  test('does not treat clean marketing overview prose as section soup', () => {
    const text =
      'Naturally radiant, this tinted fluid sunscreen delivers lightweight coverage with a breathable finish. ' +
      'The formula blends zinc oxide UV protection with skin-evening pigments and ingredients chosen for everyday wear.';

    expect(looksLikeSectionSoupText(text)).toBe(false);
  });

  test('still detects stitched heading blobs as section soup', () => {
    const text =
      'Description: A breathable tinted sunscreen. Benefits: Helps even skin tone. ' +
      'Ingredients: Zinc Oxide, Glycerin. How to Use: Shake well before use.';

    expect(looksLikeSectionSoupText(text)).toBe(true);
  });

  test('does not count category-only similar cards as highlight-ready', () => {
    const similarGate = buildSimilarGate({
      similarResponse: {
        products: [
          { product_id: 'ext_1', merchant_id: 'external_seed', title: 'Category only', category: 'Toner' },
          {
            product_id: 'ext_2',
            merchant_id: 'external_seed',
            title: 'Explained card',
            description: 'Milky toner with barrier-supporting ingredients.',
          },
          { product_id: 'ext_3', merchant_id: 'external_seed', title: 'Category only 2', product_type: 'Serum' },
          { product_id: 'ext_4', merchant_id: 'external_seed', title: 'Category only 3', category: 'Moisturizer' },
        ],
      },
      exclusionFlags: { gift_card: false, donation_bundle: false, non_merchandise: false },
    });

    expect(similarGate.failure_reasons).toEqual(['similar_card_missing_highlight']);
    expect(similarGate.card_highlight_missing_count).toBe(3);
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
