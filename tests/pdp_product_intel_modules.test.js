const { buildPdpPayload } = require('../src/pdpBuilder');
const { buildProductIntelBundle, buildProductIntelDraftBundle } = require('../src/pdpProductIntel');

describe('pdpBuilder product intel modules', () => {
  test('adds Pivota Insights and texture modules ahead of legacy details', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'p_intel_1',
        merchant_id: 'm_intel_1',
        title: 'Barrier Support Gel Cream',
        description: 'A lightweight gel cream with niacinamide for daily hydration.',
        category: 'Skincare/Moisturizer',
        price: { amount: 32, currency: 'USD' },
        tags: ['hydrating', 'sensitive'],
        texture: 'gel-cream',
        finish: 'natural',
        ingredients_inci: ['Water', 'Niacinamide', 'Glycerin'],
        assessment: {
          summary: 'A daily gel-cream moisturizer focused on hydration and barrier comfort.',
          best_for: ['Dry or dehydrated skin', 'Sensitive skin'],
          formula_intent: ['Hydration support', 'Barrier comfort'],
          how_to_use: {
            when: 'AM and PM',
            order_in_routine: 'Apply after serum and before SPF in daytime.',
          },
          not_for: ['Very rich cream seekers'],
        },
        evidence: {
          science: {
            key_ingredients: ['Niacinamide', 'Glycerin'],
            risk_notes: [],
          },
          social_signals: {
            typical_positive: ['hydration', 'comfort'],
            typical_negative: [],
            risk_for_groups: [],
          },
          expert_notes: [],
        },
        review_summary: {
          scale: 5,
          rating: 4.6,
          review_count: 182,
        },
      },
      relatedProducts: [
        {
          product_id: 'p_intel_2',
          merchant_id: 'm_intel_1',
          title: 'Companion Serum',
          price: { amount: 28, currency: 'USD' },
        },
      ],
      entryPoint: 'agent',
    });

    const moduleTypes = payload.modules.map((module) => module.type);
    expect(moduleTypes).toEqual(
      expect.arrayContaining(['product_intel', 'texture_finish', 'product_details']),
    );

    const productIntelModule = payload.modules.find((module) => module.type === 'product_intel');
    const textureModule = payload.modules.find((module) => module.type === 'texture_finish');
    const detailsModule = payload.modules.find((module) => module.type === 'product_details');

    expect(productIntelModule.data.display_name).toBe('Pivota Insights');
    expect(productIntelModule.data.evidence_profile).toBe('community_supported');
    expect(productIntelModule.priority).toBeGreaterThan(detailsModule.priority);
    expect(textureModule.data.texture).toBe('gel-cream');
  });

  test('seller-only products suppress community signals module', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'p_seller_only_1',
        merchant_id: 'm_seller_only_1',
        title: 'Small Batch Cleansing Balm',
        description: 'A cleansing balm made for evening makeup removal.',
        category: 'Skincare/Cleanser',
        price: { amount: 18, currency: 'USD' },
        assessment: {
          summary: 'A balm cleanser designed for evening cleansing.',
          best_for: ['Makeup removal'],
          formula_intent: ['Cleansing'],
        },
        evidence: {
          science: {
            key_ingredients: [],
            risk_notes: [],
          },
          social_signals: {
            typical_positive: [],
            typical_negative: [],
            risk_for_groups: [],
          },
          expert_notes: [],
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const productIntelModule = payload.modules.find((module) => module.type === 'product_intel');
    expect(productIntelModule).toBeTruthy();
    expect(productIntelModule.data.evidence_profile).toBe('seller_only');
    expect(productIntelModule.data.confidence.overall).toBe('moderate');
    expect(payload.modules.some((module) => module.type === 'community_signals')).toBe(false);
  });

  test('draft intel bundle stays offline-only and does not unlock runtime modules by itself', () => {
    const rawProduct = {
      product_id: 'pilot_raw_1',
      merchant_id: 'pilot_merchant_1',
      title: 'Cloud Finish Mineral Sunscreen SPF 50',
      description: 'A lightweight mineral sunscreen with a soft natural finish for daily wear.',
      category: 'Skincare/Sunscreen',
      tags: ['mineral', 'daily', 'lightweight'],
      texture: 'light cream',
      finish: 'natural',
      ingredients_inci: ['Zinc Oxide', 'Glycerin', 'Squalane'],
    };

    expect(buildProductIntelBundle({ product: rawProduct })).toBeNull();

    const draft = buildProductIntelDraftBundle({ product: rawProduct });
    expect(draft).toBeTruthy();
    expect(draft.display_name).toBe('Pivota Insights');
    expect(draft.product_intel_core.what_it_is.body).toMatch(/sunscreen/i);
    expect(draft.evidence_profile).toBe('seller_plus_formula');
    expect(draft.community_signals.status).toBe('unavailable');
  });
});
