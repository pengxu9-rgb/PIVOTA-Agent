jest.mock('axios', () => ({
  post: jest.fn(),
}));

const {
  buildPilotCaseFromExternalSeedProduct,
  buildPilotCaseFromPdpResponse,
  buildPilotCaseFromSearchCandidate,
  extractProductIdsFromFrontendHtml,
  fetchDiscoveryCandidates,
  hasBadgeEvidence,
  loadCoveredProductIdSet,
  loadCoveredProductIdSetFromReport,
  sampleWithoutReplacement,
  selectDiverseCases,
} = require('../scripts/build_product_intel_live_pilot_cases');

const axios = require('axios');

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

  test('loads covered product ids from KB keys', async () => {
    const covered = await loadCoveredProductIdSet(['prod_a', 'prod_b'], async () => ({
      rows: [{ kb_key: 'product:prod_a' }],
    }));

    expect(Array.from(covered)).toEqual(['prod_a']);
  });

  test('loads covered product ids from a compare report', () => {
    const tmpReport = '/tmp/build-product-intel-covered-report.json';
    require('fs').writeFileSync(
      tmpReport,
      JSON.stringify({
        rows: [
          {
            selected: {
              bundle: {
                canonical_product_ref: {
                  product_id: 'prod_a',
                },
              },
            },
          },
        ],
      }),
    );

    expect(Array.from(loadCoveredProductIdSetFromReport(tmpReport))).toEqual(['prod_a']);
  });

  test('selects a diverse subset across brands and categories', () => {
    const cases = [
      { case_id: '1', product: { brand: 'Brand A', category: 'Serum' } },
      { case_id: '2', product: { brand: 'Brand A', category: 'Serum' } },
      { case_id: '3', product: { brand: 'Brand B', category: 'Moisturizer' } },
      { case_id: '4', product: { brand: 'Brand C', category: 'Toner' } },
    ];

    const selected = selectDiverseCases(cases, {
      limit: 3,
      seed: 'seed-1',
      maxPerBrand: 1,
      maxPerCategory: 1,
    });

    expect(selected).toHaveLength(3);
    expect(new Set(selected.map((row) => row.product.brand)).size).toBe(3);
    expect(new Set(selected.map((row) => row.product.category)).size).toBe(3);
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

  test('builds a live pilot case from external seed product fallback', () => {
    expect(
      buildPilotCaseFromExternalSeedProduct({
        merchant_id: 'external_seed',
        id: 'ext_demo_seed',
        brand: 'Naturium',
        title: 'Vitamin C Super Serum Plus',
        category_path: ['Skincare', 'Serum'],
        description: 'A multi-active serum for tone and texture.',
        ingredients_inci: ['Ascorbic Acid', 'Niacinamide'],
        review_summary: {
          rating: 4.6,
          review_count: 228,
        },
      }),
    ).toEqual({
      case_id: 'live_ext_demo_seed',
      notes: 'Live pilot case sampled from external product seeds (Naturium).',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_demo_seed',
      },
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_demo_seed',
        brand: 'Naturium',
        title: 'Vitamin C Super Serum Plus',
        category: 'Skincare/Serum',
        description: 'A multi-active serum for tone and texture.',
        tags: ['Skincare', 'Serum'],
        texture: '',
        finish: '',
        ingredients_inci: ['Ascorbic Acid', 'Niacinamide'],
        how_to_use: '',
        review_summary: {
          rating: 4.6,
          review_count: 228,
        },
      },
    });
  });

  test('fetches discovery candidates from get_discovery_feed card surface', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        products: [{ product_id: 'ext_demo', title: 'Demo Product' }],
      },
    });

    await expect(
      fetchDiscoveryCandidates('https://agent.pivota.cc/api/gateway', 'browse_products', 2, 24),
    ).resolves.toEqual([{ product_id: 'ext_demo', title: 'Demo Product' }]);

    expect(axios.post).toHaveBeenCalledWith(
      'https://agent.pivota.cc/api/gateway',
      expect.objectContaining({
        operation: 'get_discovery_feed',
        payload: expect.objectContaining({
          surface: 'browse_products',
          page: 2,
          limit: 24,
          response_detail: 'card',
        }),
      }),
      expect.any(Object),
    );
  });

  test('extracts product ids from frontend HTML links', () => {
    const ids = extractProductIdsFromFrontendHtml(`
      <a href="/products/ext_13c520e764f9f7d7f23c611b?return=%2Fproducts">Naturium</a>
      <a href="/products/ext_4e155bb184ec35f3cd7827e3">Olehenriksen</a>
    `);

    expect(ids).toEqual([
      'ext_13c520e764f9f7d7f23c611b',
      'ext_4e155bb184ec35f3cd7827e3',
    ]);
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
