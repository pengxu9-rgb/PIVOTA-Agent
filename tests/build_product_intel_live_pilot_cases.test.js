jest.mock('axios', () => ({
  post: jest.fn(),
}));

const {
  buildPilotCaseFromExternalSeedProduct,
  buildPilotCaseFromPdpResponse,
  buildPilotCaseFromSearchCandidate,
  extractReviewsPreviewSummary,
  extractProductIdsFromFrontendHtml,
  fetchDiscoveryCandidates,
  fetchPdpResponse,
  hasBadgeEvidence,
  isBeautyPilotCase,
  loadCoveredProductIdSet,
  loadCoveredProductIdSetFromReport,
  loadManualOverrideProductIdSet,
  parseArgs,
  sampleWithoutReplacement,
  selectDiverseCases,
} = require('../scripts/build_product_intel_live_pilot_cases');

const axios = require('axios');

describe('build_product_intel_live_pilot_cases', () => {
  test('parses concurrency controls for bulk batches', () => {
    const args = parseArgs([
      'node',
      'script',
      '--queries',
      'cleanser,serum',
      '--query-concurrency',
      '8',
      '--frontend-concurrency',
      '3',
      '--pdp-concurrency',
      '12',
    ]);

    expect(args.queries).toEqual(['cleanser', 'serum']);
    expect(args.queryConcurrency).toBe(8);
    expect(args.frontendConcurrency).toBe(3);
    expect(args.pdpConcurrency).toBe(12);
  });

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

  test('loads covered product ids from final reviewed reports in a directory', () => {
    const fs = require('fs');
    const path = require('path');
    const tmpDir = '/tmp/build-product-intel-covered-report-dir';
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpDir, 'nested'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'compare_gemini3flash.json'),
      JSON.stringify({
        rows: [
          {
            selected: {
              bundle: {
                canonical_product_ref: {
                  product_id: 'should_ignore',
                },
              },
            },
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'nested', 'compare_final_reviewed.json'),
      JSON.stringify({
        rows: [
          {
            selected: {
              bundle: {
                canonical_product_ref: {
                  product_id: 'prod_dir_a',
                },
              },
            },
          },
          {
            baseline: {
              canonical_product_ref: {
                product_id: 'prod_dir_b',
              },
            },
          },
        ],
      }),
    );

    expect(Array.from(loadCoveredProductIdSetFromReport(tmpDir)).sort()).toEqual(['prod_dir_a', 'prod_dir_b']);
  });

  test('loads covered product ids from manual overrides', () => {
    const tmpOverrides = '/tmp/build-product-intel-manual-overrides.json';
    require('fs').writeFileSync(
      tmpOverrides,
      JSON.stringify({
        'product:ext_alpha': { notes: 'reviewed' },
        live_ext_beta: { notes: 'reviewed' },
        random_key: { notes: 'ignore' },
      }),
    );

    expect(Array.from(loadManualOverrideProductIdSet(tmpOverrides)).sort()).toEqual(['ext_alpha', 'ext_beta']);
  });

  test('accepts beauty pilot cases and rejects obvious non-beauty drift', () => {
    expect(
      isBeautyPilotCase({
        product: {
          title: 'Barrier Repair Moisturizer',
          category: 'Moisturizer',
          description: 'Ceramide cream for dry skin.',
          tags: ['skincare'],
        },
      }),
    ).toBe(true);

    expect(
      isBeautyPilotCase({
        product: {
          title: 'Escape-Proof Dog Harness for Small Dogs',
          category: 'Dog Harness',
          description: 'Pet supplies for walks.',
          tags: ['pet supplies'],
        },
      }),
    ).toBe(false);
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

  test('search candidate fetch uses the beauty discovery contract', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        products: [],
      },
    });
    axios.post.mockResolvedValueOnce({
      data: {
        products: [],
      },
    });

    await fetchDiscoveryCandidates('https://gateway.example/api', 'browse_products', 1, 12);
    await require('../scripts/build_product_intel_live_pilot_cases').fetchSearchCandidates(
      'https://gateway.example/api',
      'vitamin c serum',
      12,
    );

    expect(axios.post).toHaveBeenLastCalledWith(
      'https://gateway.example/api',
      expect.objectContaining({
        operation: 'find_products_multi',
        payload: expect.objectContaining({
          search: expect.objectContaining({
            query: 'vitamin c serum',
            catalog_surface: 'beauty',
            commerce_surface: 'beauty',
          }),
        }),
        metadata: expect.objectContaining({
          catalog_surface: 'beauty',
          commerce_surface: 'beauty',
        }),
      }),
      expect.any(Object),
    );
  });

  test('extracts review summary from reviews_preview module', () => {
    expect(
      extractReviewsPreviewSummary({
        modules: [
          {
            type: 'reviews_preview',
            data: {
              scale: 5,
              rating: 4.7,
              review_count: 182,
            },
          },
        ],
      }),
    ).toEqual({
      rating: 4.7,
      review_count: 182,
    });

    expect(
      extractReviewsPreviewSummary({
        modules: [
          {
            type: 'reviews_preview',
            data: {
              scale: 5,
              rating: 0,
              review_count: 0,
            },
          },
        ],
      }),
    ).toBeUndefined();
  });

  test('uses reviews_preview review summary when live PDP exposes review aggregate', () => {
    const response = {
      subject: {
        canonical_product_ref: {
          merchant_id: 'external_seed',
          product_id: 'ext_reviewed123',
        },
      },
      modules: [
        {
          type: 'canonical',
          data: {
            pdp_payload: {
              product: {
                title: 'Hydra Barrier Cream',
                brand: { name: 'Byoma' },
                category_path: ['Skincare', 'Moisturizer'],
                description: 'A barrier cream for dry, reactive skin.',
              },
            },
          },
        },
        {
          type: 'reviews_preview',
          data: {
            scale: 5,
            rating: 4.7,
            review_count: 182,
            preview_items: [],
          },
        },
      ],
    };

    const row = buildPilotCaseFromPdpResponse(response);
    expect(row.product.review_summary).toEqual({
      rating: 4.7,
      review_count: 182,
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

  test('requests reviews_preview when fetching live PDP responses', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        status: 'success',
      },
    });

    await expect(fetchPdpResponse('https://agent.pivota.cc/api/gateway', 'ext_demo')).resolves.toEqual({
      status: 'success',
    });

    expect(axios.post).toHaveBeenCalledWith(
      'https://agent.pivota.cc/api/gateway',
      expect.objectContaining({
        operation: 'get_pdp_v2',
        payload: expect.objectContaining({
          product_ref: {
            product_id: 'ext_demo',
          },
          include: expect.arrayContaining(['canonical', 'product_intel', 'reviews_preview']),
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
    ).toBe(false);

    expect(
      hasBadgeEvidence({
        product: {
          market_signal_badges: [
            {
              badge_type: 'creator_signal',
              badge_label: 'Seen across creator routines',
              source_type: 'creator_consensus',
              sponsorship_status: 'organic',
              evidence_strength: 'strong',
              independence_count: 3,
            },
          ],
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
