const {
  buildProductIntelBundle,
  buildProductIntelDraftBundle,
  normalizePublishedProductIntelBundle,
} = require('../src/pdpProductIntel');

describe('pdp product intel bundle shaping', () => {
  test('buildProductIntelBundle returns structured insights with texture and community signals', () => {
    const bundle = buildProductIntelBundle({
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
    });

    expect(bundle).toBeTruthy();
    expect(bundle.display_name).toBe('Pivota Insights');
    expect(bundle.evidence_profile).toBe('community_supported');
    expect(bundle.product_intel_core.what_it_is.body).toMatch(/daily gel-cream moisturizer/i);
    expect(bundle.texture_finish.texture).toBe('gel-cream');
    expect(bundle.community_signals.status).toBe('available');
  });

  test('seller-only bundles keep community signals unavailable', () => {
    const bundle = buildProductIntelBundle({
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
    });

    expect(bundle).toBeTruthy();
    expect(bundle.evidence_profile).toBe('seller_only');
    expect(bundle.product_intel_core.confidence.overall).toBe('moderate');
    expect(bundle.community_signals.status).toBe('unavailable');
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

  test('seller-only drafts compact overlong what_it_is narrative', () => {
    const draft = buildProductIntelDraftBundle({
      product: {
        product_id: 'pilot_long_1',
        merchant_id: 'pilot_merchant_1',
        title: 'Vitamin C Super Serum Plus - Jumbo',
        category: 'Serum',
        description:
          'Double up and save with this jumbo size of our supercharged, multi-benefit serum formulated with vitamin c, retinol, hyaluronic acid, niacinamide and salicylic acid to help improve the look of fine lines and wrinkles, smooth and brighten the appearance of skin, while also helping protect skin from environmental stressors. Our Vitamin C Super Serum Plus is clinically proven to brighten skin appearance and improve the look of fine lines and wrinkles plus skin tone and texture in just 8 weeks. In an 8-week clinical study on subjects, representation across all skin types and self-perceived sensitive skin.',
      },
    });

    expect(draft.product_intel_core.what_it_is.body.length).toBeLessThanOrEqual(320);
    expect(draft.product_intel_core.what_it_is.body).not.toMatch(/in an 8-week clinical study/i);
  });

  test('published bundles compact overlong what_it_is narrative at read time', () => {
    const bundle = normalizePublishedProductIntelBundle({
      contract_version: 'pivota.product_intel.v1',
      product_intel_core: {
        what_it_is: {
          headline: 'Treatment serum',
          body:
            'Double up and save with this jumbo size of our supercharged, multi-benefit serum formulated with vitamin c, retinol, hyaluronic acid, niacinamide and salicylic acid to help improve the look of fine lines and wrinkles, smooth and brighten the appearance of skin, while also helping protect skin from environmental stressors. Our Vitamin C Super Serum Plus is clinically proven to brighten skin appearance and improve the look of fine lines and wrinkles plus skin tone and texture in just 8 weeks. In an 8-week clinical study on subjects, representation across all skin types and self-perceived sensitive skin.',
        },
        best_for: [{ tag: 'tone', label: 'Uneven tone concerns', confidence: 'moderate' }],
        why_it_stands_out: [],
        routine_fit: { step: 'serum', am_pm: ['am', 'pm'], pairing_notes: [] },
        watchouts: [],
        confidence: { overall: 'moderate' },
        freshness: { generated_at: '2026-04-08T12:00:00.000Z', source_version: 'pilot_selected:test' },
        quality_state: 'limited',
        evidence_profile: 'seller_only',
      },
      community_signals: {
        status: 'unavailable',
        unavailable_reason: 'insufficient_feedback',
        confidence: 'low',
        evidence_profile: 'seller_only',
      },
      quality_state: 'limited',
      evidence_profile: 'seller_only',
    });

    expect(bundle.product_intel_core.what_it_is.body.length).toBeLessThanOrEqual(320);
    expect(bundle.product_intel_core.what_it_is.body).toMatch(/^A /);
    expect(bundle.product_intel_core.what_it_is.body).not.toMatch(/^Double up and save with/i);
    expect(bundle.product_intel_core.what_it_is.body).not.toMatch(/in an 8-week clinical study/i);
  });
});
