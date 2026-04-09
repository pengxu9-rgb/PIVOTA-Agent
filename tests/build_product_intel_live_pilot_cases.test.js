const {
  buildPilotCaseFromPdpResponse,
  buildPilotCaseFromSearchCandidate,
  hasBadgeEvidence,
  sampleWithoutReplacement,
} = require('../scripts/build_product_intel_live_pilot_cases');

describe('build_product_intel_live_pilot_cases', () => {
  test('samples deterministically without replacement', () => {
    const input = ['a', 'b', 'c', 'd', 'e', 'e'];
    const first = sampleWithoutReplacement(input, 3, 'seed-1');
    const second = sampleWithoutReplacement(input, 3, 'seed-1');
    const third = sampleWithoutReplacement(input, 3, 'seed-2');

    expect(first).toHaveLength(3);
    expect(new Set(first).size).toBe(3);
    expect(first).toEqual(second);
    expect(third).not.toEqual(first);
  });

  test('builds a live pilot case from get_pdp_v2 response', () => {
    const response = {
      subject: {
        canonical_product_ref: {
          merchant_id: 'external_seed',
          product_id: 'ext_demo123',
        },
      },
      modules: [
        {
          type: 'canonical',
          data: {
            pdp_payload: {
              product: {
                title: 'Dew-Glow Moisturizer SPF 50',
                brand: { name: 'Naturium' },
                category_path: ['Skincare', 'Sunscreen'],
                description: 'A glow-forward sunscreen moisturizer for daily wear.',
                texture: 'light cream',
                finish: 'dewy',
              },
            },
          },
        },
        {
          type: 'product_details',
          data: {
            sections: [
              {
                heading: 'Overview',
                body: 'A daily sunscreen moisturizer with a hydrated finish.',
              },
              {
                heading: 'How to Use',
                body: 'Apply as the last skincare step before sun exposure.',
              },
            ],
          },
        },
        {
          type: 'ingredients_inci',
          data: {
            ingredients_inci: ['Avobenzone', 'Homosalate', 'Glycerin'],
          },
        },
      ],
    };

    expect(buildPilotCaseFromPdpResponse(response)).toEqual({
      case_id: 'live_ext_demo123',
      notes: 'Live pilot case sampled from public /products listing (Naturium).',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_demo123',
      },
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_demo123',
        brand: 'Naturium',
        title: 'Dew-Glow Moisturizer SPF 50',
        category: 'Skincare/Sunscreen',
        description: 'A glow-forward sunscreen moisturizer for daily wear.',
        tags: ['Skincare', 'Sunscreen'],
        texture: 'light cream',
        finish: 'dewy',
        ingredients_inci: ['Avobenzone', 'Homosalate', 'Glycerin'],
        how_to_use: 'Apply as the last skincare step before sun exposure.',
        review_summary: undefined,
      },
    });
  });

  test('builds a seed case from a search candidate with review evidence', () => {
    expect(
      buildPilotCaseFromSearchCandidate({
        merchant_id: 'merch_demo',
        product_id: 'prod_demo',
        brand: 'Olehenriksen',
        title: 'Vitamin C + Niacinamide Cream',
        category: 'Moisturizer',
        description: 'Brightening cream',
        visible_attributes: {
          product_category: ['moisturizer'],
        },
        signals: {
          rating: 4.8,
          review_count: 412,
        },
      }),
    ).toEqual({
      case_id: 'live_prod_demo',
      notes: 'Live pilot case sampled from public search results (Olehenriksen).',
      canonical_product_ref: {
        merchant_id: 'merch_demo',
        product_id: 'prod_demo',
      },
      product: {
        merchant_id: 'merch_demo',
        product_id: 'prod_demo',
        brand: 'Olehenriksen',
        title: 'Vitamin C + Niacinamide Cream',
        category: 'Moisturizer',
        description: 'Brightening cream',
        tags: ['moisturizer'],
        review_summary: {
          rating: 4.8,
          review_count: 412,
        },
      },
    });
  });

  test('merges product intel evidence from PDP response into a seeded live case', () => {
    const seedCase = {
      case_id: 'live_prod_demo',
      notes: 'Live pilot case sampled from public search results (Olehenriksen).',
      canonical_product_ref: {
        merchant_id: 'merch_demo',
        product_id: 'prod_demo',
      },
      product: {
        merchant_id: 'merch_demo',
        product_id: 'prod_demo',
        brand: 'Olehenriksen',
        title: 'Vitamin C + Niacinamide Cream',
        category: 'Moisturizer',
        description: 'Brightening cream',
        tags: ['moisturizer'],
        review_summary: {
          rating: 4.8,
          review_count: 412,
        },
      },
    };

    const response = {
      subject: {
        canonical_product_ref: {
          merchant_id: 'merch_demo',
          product_id: 'prod_demo',
        },
      },
      modules: [
        {
          type: 'canonical',
          data: {
            pdp_payload: {
              product: {
                title: 'Vitamin C + Niacinamide Cream',
                brand: { name: 'Olehenriksen' },
                category_path: ['Skincare', 'Moisturizer'],
                description: 'A brightening cream.',
              },
            },
          },
        },
        {
          type: 'product_intel',
          data: {
            evidence_profile: 'mixed',
            market_signal_badges: [
              {
                badge_type: 'review_signal',
                badge_label: '4.8★ from 412 reviews',
              },
            ],
            community_signals: {
              status: 'available',
              source_counts: {
                editorial: 4,
              },
            },
          },
        },
      ],
    };

    const row = buildPilotCaseFromPdpResponse(response, seedCase);
    expect(row.product.review_summary).toEqual({
      rating: 4.8,
      review_count: 412,
    });
    expect(row.product.community_signals).toEqual({
      status: 'available',
      source_counts: {
        editorial: 4,
      },
    });
    expect(row.product.market_signal_badges).toEqual([
      {
        badge_type: 'review_signal',
        badge_label: '4.8★ from 412 reviews',
      },
    ]);
    expect(row.product.evidence_profile).toBe('mixed');
  });

  test('detects badge evidence from review summary and community counts', () => {
    expect(
      hasBadgeEvidence({
        product: {
          review_summary: {
            rating: 4.7,
            review_count: 182,
          },
        },
      }),
    ).toBe(true);

    expect(
      hasBadgeEvidence({
        product: {
          community_signals: {
            status: 'available',
            source_counts: {
              creator_mentions: 12,
            },
          },
        },
      }),
    ).toBe(true);

    expect(
      hasBadgeEvidence({
        product: {
          review_summary: {
            rating: 4.3,
            review_count: 12,
          },
        },
      }),
    ).toBe(false);
  });
});
