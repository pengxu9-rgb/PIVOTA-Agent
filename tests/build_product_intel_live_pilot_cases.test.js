jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const {
  buildPilotCaseFromExternalSeedProduct,
  buildPilotCaseFromPdpResponse,
  buildPilotCaseFromSearchCandidate,
  enrichCaseWithSourcePageEvidence,
  enrichCaseWithSourceReviewSummary,
  extractReviewsPreviewSummary,
  extractSourceProductFactsFromHtml,
  extractSourceReviewSummaryFromHtml,
  extractProductIdsFromFrontendHtml,
  fetchDiscoveryCandidates,
  fetchSourceReviewSummary,
  fetchPdpResponse,
  hasBadgeEvidence,
  loadCoveredProductIdSet,
  loadCoveredProductIdSetFromReport,
  loadManualOverrideProductIdSet,
  loadMissingIdentityCoverageProductIds,
  parseArgs,
  parseProductRefInput,
  sampleWithoutReplacement,
  selectDiverseCases,
} = require('../scripts/build_product_intel_live_pilot_cases');

const axios = require('axios');

describe('build_product_intel_live_pilot_cases', () => {
  test('parses covered review mode controls for bulk batches', () => {
    const args = parseArgs([
      'node',
      'script',
      '--queries',
      'cleanser,serum',
      '--covered-review-mode',
      'reviewed',
    ]);

    expect(args.queries).toEqual(['cleanser', 'serum']);
    expect(args.coveredReviewMode).toBe('reviewed');
  });

  test('parses merchant-scoped product refs for coverage batches', () => {
    const args = parseArgs([
      'node',
      'script',
      '--product-ids',
      'external_seed:ext_demo,plain_demo',
      '--product-refs',
      'merch_demo:shopify_demo',
    ]);

    expect(args.productIds).toEqual(['external_seed:ext_demo', 'plain_demo', 'merch_demo:shopify_demo']);
    expect(parseProductRefInput('merch_demo:shopify_demo')).toEqual({
      merchant_id: 'merch_demo',
      product_id: 'shopify_demo',
    });
    expect(parseProductRefInput('plain_demo')).toEqual({
      product_id: 'plain_demo',
    });
  });

  test('defaults identity per-brand limit to 3 when not provided', () => {
    const args = parseArgs(['node', 'script']);
    expect(args.identityPerBrandLimit).toBe(3);
  });

  test('parses identity supplemental args', () => {
    const args = parseArgs([
      'node',
      'script',
      '--identity-brands',
      'Naturium,Olehenriksen',
      '--identity-top-brands',
      '2',
      '--identity-per-brand-limit',
      '4',
      '--identity-min-source-rows',
      '3',
      '--identity-min-review-ratio',
      '0.5',
      '--identity-include-non-beauty',
    ]);

    expect(args.identityBrands).toEqual(['Naturium', 'Olehenriksen']);
    expect(args.identityTopBrands).toBe(2);
    expect(args.identityPerBrandLimit).toBe(4);
    expect(args.identityMinSourceRows).toBe(3);
    expect(args.identityMinReviewRatio).toBe(0.5);
    expect(args.identityBeautyOnly).toBe(false);
  });

  test('parses source review fetch controls for batch-only source page enrichment', () => {
    const args = parseArgs([
      'node',
      'script',
      '--fetch-source-reviews',
      '--source-review-timeout-ms',
      '9000',
    ]);

    expect(args.fetchSourceReviews).toBe(true);
    expect(args.fetchSourceFacts).toBe(false);
    expect(args.sourceReviewTimeoutMs).toBe(9000);

    const disabled = parseArgs(['node', 'script', '--no-fetch-source-reviews']);
    expect(disabled.fetchSourceReviews).toBe(false);

    const facts = parseArgs(['node', 'script', '--fetch-source-facts']);
    expect(facts.fetchSourceFacts).toBe(true);
  });

  test('loads missing identity candidates from explicit brands', async () => {
    const rows = await loadMissingIdentityCoverageProductIds({
      explicitBrands: ['Naturium'],
      perBrandLimit: 5,
      queryFn: async (_query, params) => {
        const refs = Array.isArray(params?.[0]) ? params[0] : [];
        return {
          rows: refs.includes('m1:exists_1') ? [{ source_listing_ref: 'm1:exists_1' }] : [],
        };
      },
      summarizeFn: async () => [],
      fetchBackfillProductsFn: async ({ brandFilter }) =>
        [
          { merchant_id: 'm1', product_id: 'missing_1' },
          { merchant_id: 'm1', product_id: 'exists_1' },
        ].map((item) => ({ ...item, source_listing_ref: `${item.merchant_id}:${item.product_id}` })),
    });

    expect(rows).toEqual(['missing_1']);
    expect(rows).toEqual(expect.not.arrayContaining(['exists_1']));
  });

  test('loads missing identity candidates from summary top brands', async () => {
    const usedBrands = [];
    const rows = await loadMissingIdentityCoverageProductIds({
      topBrands: 2,
      perBrandLimit: 2,
      minReviewRatio: 0.5,
      minSourceRows: 0,
      beautyOnly: false,
      queryFn: async () => ({ rows: [] }),
      summarizeFn: async () => [
        {
          brand_norm: 'alpha',
          missing_identity_rows: 10,
          review_ratio: 0.65,
        },
        {
          brand_norm: 'beta',
          missing_identity_rows: 8,
          review_ratio: 0.25,
        },
      ],
      fetchBackfillProductsFn: async ({ brandFilter }) => {
        usedBrands.push(brandFilter);
        if (brandFilter === 'alpha') {
          return [
            { merchant_id: 'm1', product_id: 'p1' },
            { merchant_id: 'm1', product_id: 'p2' },
            { merchant_id: 'm1', product_id: 'p3' },
          ];
        }
        return [];
      },
    });

    expect(usedBrands).toEqual(['alpha']);
    expect(rows).toHaveLength(2);
    expect(rows.every((rowId) => ['p1', 'p2', 'p3'].includes(rowId))).toBe(true);
  });

  test('finds missing identity rows even when missing rows are deep in fetch results', async () => {
    const totalCandidates = Array.from({ length: 300 }).map((_, index) => `ext_${index}`);
    const allCoveredRefs = new Set(totalCandidates.slice(0, 250).map((productId) => `external_seed:${productId}`));
    const fetchCalls = [];
    const rows = await loadMissingIdentityCoverageProductIds({
      explicitBrands: ['Moyu'],
      perBrandLimit: 5,
      queryFn: async (_query, params) => ({
        rows: Array.isArray(params?.[0])
          ? params[0]
              .filter((ref) => allCoveredRefs.has(ref))
              .map((source_listing_ref) => ({ source_listing_ref }))
          : [],
      }),
      fetchBackfillProductsFn: async ({ limit }) => {
        fetchCalls.push(limit);
        return totalCandidates.slice(0, limit).map((productId) => ({
          merchant_id: 'external_seed',
          product_id: productId,
        }));
      },
      summarizeFn: async () => [],
    });

    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(fetchCalls.every((value) => value >= 200)).toBe(true);
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

  test('loads strict-human covered product ids from KB rows', async () => {
    const covered = await loadCoveredProductIdSet(
      ['prod_a', 'prod_b', 'prod_c'],
      async () => ({
        rows: [
          {
            kb_key: 'product:prod_a',
            source_meta: {
              review_status: 'completed',
              review_decision: 'pass',
              reviewer: 'Human QA',
            },
          },
          {
            kb_key: 'product:prod_b',
            source_meta: {
              review_status: 'completed',
              review_decision: 'pass',
              reviewer: 'codex',
            },
          },
          {
            kb_key: 'product:prod_c',
            source_meta: {
              external_highlight_review_status: 'rewrite',
            },
          },
        ],
      }),
      'strict_human',
    );

    expect(Array.from(covered)).toEqual(['prod_a']);
  });

  test('loads reviewed coverage from KB rows when assistant and legacy rows are allowed', async () => {
    const covered = await loadCoveredProductIdSet(
      ['prod_a', 'prod_b'],
      async () => ({
        rows: [
          {
            kb_key: 'product:prod_a',
            source_meta: {
              review_status: 'completed',
              review_decision: 'pass',
              reviewer: 'codex',
            },
          },
          {
            kb_key: 'product:prod_b',
            source_meta: {
              external_highlight_review_status: 'rewrite',
            },
          },
        ],
      }),
      'reviewed',
    );

    expect(Array.from(covered).sort()).toEqual(['prod_a', 'prod_b']);
  });

  test('loads strict-human covered product ids from a compare report', () => {
    const tmpReport = '/tmp/build-product-intel-covered-report.json';
    require('fs').writeFileSync(
      tmpReport,
      JSON.stringify({
        rows: [
          {
            review_status: 'completed',
            review_decision: 'rewrite',
            reviewer: 'QA reviewer',
            selected: {
              bundle: {
                canonical_product_ref: {
                  product_id: 'prod_a',
                },
              },
            },
          },
          {
            review_status: 'completed',
            review_decision: 'rewrite',
            reviewer: 'codex',
            selected: {
              bundle: {
                canonical_product_ref: {
                  product_id: 'prod_b',
                },
              },
            },
          },
        ],
      }),
    );

    expect(Array.from(loadCoveredProductIdSetFromReport(tmpReport, 'strict_human'))).toEqual(['prod_a']);
  });

  test('loads reviewed covered product ids from final reviewed reports in a directory', () => {
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
            review_status: 'completed',
            review_decision: 'rewrite',
            reviewer: 'codex',
            selected: {
              bundle: {
                canonical_product_ref: {
                  product_id: 'prod_dir_a',
                },
              },
            },
          },
          {
            review_status: 'completed',
            review_decision: 'pass',
            reviewer: 'Human QA',
            baseline: {
              canonical_product_ref: {
                product_id: 'prod_dir_b',
              },
            },
          },
        ],
      }),
    );

    expect(Array.from(loadCoveredProductIdSetFromReport(tmpDir, 'reviewed')).sort()).toEqual(['prod_dir_a', 'prod_dir_b']);
  });

  test('loads covered product ids from manual overrides', () => {
    const tmpOverrides = '/tmp/build-product-intel-manual-overrides.json';
    require('fs').writeFileSync(
      tmpOverrides,
      JSON.stringify({
        'product:ext_alpha': {
          review_status: 'completed',
          review_decision: 'rewrite',
          reviewer: 'Human QA',
        },
        'product:9886499864904': {
          review_status: 'completed',
          review_decision: 'rewrite',
          reviewer: 'Human QA',
        },
        live_ext_beta: { external_highlight_review_status: 'rewrite' },
        random_key: { notes: 'ignore' },
      }),
    );

    expect(Array.from(loadManualOverrideProductIdSet(tmpOverrides, 'strict_human')).sort()).toEqual([
      '9886499864904',
      'ext_alpha',
    ]);
    expect(Array.from(loadManualOverrideProductIdSet(tmpOverrides, 'reviewed')).sort()).toEqual([
      '9886499864904',
      'ext_alpha',
      'ext_beta',
    ]);
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
          type: 'product_overview',
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

  test('builds product intel cases from nested canonical PDP modules and drops truncated descriptions', () => {
    const response = {
      subject: {
        canonical_product_ref: {
          merchant_id: 'external_seed',
          product_id: 'ext_daily_tinted',
        },
      },
      modules: [
        {
          type: 'canonical',
          data: {
            pdp_payload: {
              product: {
                title: 'Daily Tinted Fluid Sunscreen DN350',
                brand: { name: 'Beauty of Joseon' },
                category_path: ['external'],
                description:
                  'Meet the Tint + SPF You’ll Actually Wear Naturally radiant, this tinted fluid sunscreen feels like ski…',
              },
              modules: [
                {
                  type: 'how_to_use',
                  data: {
                    title: 'How to use',
                    steps: ['Shake well before use.', 'Apply as the last morning skin-care step.'],
                  },
                },
                {
                  type: 'ingredients_inci',
                  data: {
                    items: ['Zinc Oxide', 'Glycerin'],
                  },
                },
              ],
            },
          },
        },
      ],
    };

    const row = buildPilotCaseFromPdpResponse(response);

    expect(row.product.description).toBe('');
    expect(row.product.how_to_use).toBe(
      'Shake well before use. Apply as the last morning skin-care step.',
    );
    expect(row.product.ingredients_inci).toEqual(['Zinc Oxide', 'Glycerin']);
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

  test('extracts source review aggregate from Okendo and JSON-LD HTML', () => {
    expect(
      extractSourceReviewSummaryFromHtml(`
        <script>
          const okendoProduct = {"reviewCount":1404,"reviewAverageValue":"4.9"};
        </script>
      `),
    ).toEqual({
      rating: 4.9,
      review_count: 1404,
    });

    expect(
      extractSourceReviewSummaryFromHtml(`
        <script type="application/ld+json">
          {"@type":"Product","aggregateRating":{"@type":"AggregateRating","ratingValue":"4.8","reviewCount":"1,204"}}
        </script>
      `),
    ).toEqual({
      rating: 4.8,
      review_count: 1204,
    });
  });

  test('extracts source product facts from official Shopify-style HTML', () => {
    const descriptionHtml = [
      '<h3>About Good Molecules Niacinamide Serum</h3>',
      '<p>Promote smooth, even skin and minimize the appearance of pores with Niacinamide Serum from Good Molecules.</p>',
      '<h3>Ingredients</h3>',
      '<p>Water - 80.2%<br>Niacinamide - 10%<br>Dipropylene Glycol - 4%<br>Glycerin - 2.02%</p>',
      '<h3>Other Details</h3>',
    ].join('');
    const html = `
      <script>
        window.__remixContext = {"product":{"descriptionHtml":${JSON.stringify(descriptionHtml)}}};
      </script>
    `;

    expect(extractSourceProductFactsFromHtml(html)).toEqual({
      description:
        'Promote smooth, even skin and minimize the appearance of pores with Niacinamide Serum from Good Molecules.',
      ingredients_inci: ['Water', 'Niacinamide', 'Dipropylene Glycol', 'Glycerin'],
    });
  });

  test('extracts full INCI from Shopify product description JSON instead of key-ingredient copy', () => {
    const description = [
      '<p><strong>Details</strong></p>',
      '<p><strong>Key Features</strong></p>',
      '<p>Replenish and Renew: Restore what skin loses with age. High-performance ingredients support the barrier.</p>',
      '<p><strong>Ingredients</strong></p>',
      '<p><strong>Key Ingredients</strong></p>',
      '<p>2% NAD+ - Antioxidant / Skin cell turnover 5 Ceramide Complex - Barrier support</p>',
      '<p><strong>Full ingredients</strong></p>',
      '<p>Water, Butylene Glycol, Nicotinamide Adenine Dinucleotide, 1,2-Hexanediol, Coco-Caprylate/Caprate, Glycerin, Panthenol</p>',
    ].join('');
    const html = `
      <script>
        window.ShopifyAnalytics = {"meta":{"product":{"description":${JSON.stringify(description)}}};
      </script>
    `;

    expect(extractSourceProductFactsFromHtml(html)).toEqual({
      ingredients_inci: [
        'Water',
        'Butylene Glycol',
        'Nicotinamide Adenine Dinucleotide',
        '1,2-Hexanediol',
        'Coco-Caprylate/Caprate',
        'Glycerin',
        'Panthenol',
      ],
    });
  });

  test('ignores short non-product JSON descriptions before Shopify product description payloads', () => {
    const productDescription = [
      '<p><strong>Full ingredients</strong></p>',
      '<p>Water, Butylene Glycol, Glycerin, Panthenol, Ceramide NP</p>',
    ].join('');
    const html = `
      <script>
        window.Cart = {"description":"Package Protection"};
        window.ShopifyAnalytics = {"meta":{"product":{"description":${JSON.stringify(productDescription)}}};
      </script>
    `;

    expect(extractSourceProductFactsFromHtml(html)).toEqual({
      ingredients_inci: ['Water', 'Butylene Glycol', 'Glycerin', 'Panthenol', 'Ceramide NP'],
    });
  });

  test('extracts full INCI from product page ingredient paragraphs without explicit heading', () => {
    const html = `
      <div class="tab-content tab-content-1 rte">
        <p><span class="metafield-multi_line_text_field">Zinc Oxide (CI 77947), Water, Butyloctyl Salicylate, Isopropyl Myristate, Coco-Caprylate/Caprate, Caprylic/Capric Triglyceride, Butylene Glycol, Propanediol, Silica, Tocopherol</span></p>
      </div>
    `;

    expect(extractSourceProductFactsFromHtml(html)).toEqual({
      ingredients_inci: [
        'Zinc Oxide (CI 77947)',
        'Water',
        'Butyloctyl Salicylate',
        'Isopropyl Myristate',
        'Coco-Caprylate/Caprate',
        'Caprylic/Capric Triglyceride',
        'Butylene Glycol',
        'Propanediol',
        'Silica',
        'Tocopherol',
      ],
    });
  });

  test('does not treat product feature headings as INCI names', () => {
    const html = `
      <script>
        window.__remixContext = {"product":{"descriptionHtml":${JSON.stringify(
          '<h3>Ingredients</h3><p>Key Features<br>Scent: Unscented<br>Size: 80ml<br>Water, Glycerin, Isononyl Isononanoate, Isododecane, Panthenol</p>',
        )}}};
      </script>
    `;

    expect(extractSourceProductFactsFromHtml(html).ingredients_inci).toEqual([
      'Water',
      'Glycerin',
      'Isononyl Isononanoate',
      'Isododecane',
      'Panthenol',
    ]);
  });

  test('rejects corrupted official INCI blocks instead of sending OCR-like text to Gemini', () => {
    const html = `
      <script>
        window.__remixContext = {"product":{"descriptionHtml":${JSON.stringify(
          '<p><strong>FULL INGREDIENTS</strong></p><p>Water, DibuyiAdipate Propanedial, Butylocty Salicylate, Ethylhexy/Trazone, Terephthalyidene Dicamphor Sulfonic Acid, Glycerin, Niacinamide, Polyglycer y/ 3 Distearate, Ceteary Alcohol, Capryivi Methicone, Polvsilicone-15, Methyloropanedid, Ethyhexviglycerin, Polvether-1</p>',
        )}}};
      </script>
    `;

    expect(extractSourceProductFactsFromHtml(html).ingredients_inci).toBeUndefined();
  });

  test('extracts full INCI after non-INCI product-benefit prefixes', () => {
    const html = `
      <div class="tab-panel">
        <h4>Full Ingredients</h4>
        <p class="full_ingredients">Hydrating Soothing UV Protection WATER, ZINC OXIDE, CAPRYLYL METHICONE, METHYL TRIMETHICONE, BUTYLENE GLYCOL, GLYCERIN, TOCOPHEROL</p>
      </div>
    `;

    expect(extractSourceProductFactsFromHtml(html).ingredients_inci).toEqual([
      'WATER',
      'ZINC OXIDE',
      'CAPRYLYL METHICONE',
      'METHYL TRIMETHICONE',
      'BUTYLENE GLYCOL',
      'GLYCERIN',
      'TOCOPHEROL',
    ]);
  });

  test('does not mix key-ingredient bullets into full comma-delimited INCI', () => {
    const html = `
      <section>
        <h3>Key Ingredients</h3>
        <p><strong>Zinc Oxide</strong>: Gentle mineral UV filter for broad-spectrum protection</p>
        <h4>Full Ingredients</h4>
        <p>Hydrating Soothing UV Protection WATER, ZINC OXIDE, CAPRYLYL METHICONE, METHYL TRIMETHICONE, BUTYLENE GLYCOL, GLYCERIN, TOCOPHEROL</p>
      </section>
    `;

    expect(extractSourceProductFactsFromHtml(html).ingredients_inci).toEqual([
      'WATER',
      'ZINC OXIDE',
      'CAPRYLYL METHICONE',
      'METHYL TRIMETHICONE',
      'BUTYLENE GLYCOL',
      'GLYCERIN',
      'TOCOPHEROL',
    ]);
  });

  test('trims source description section soup before insights candidate generation', () => {
    const descriptionHtml = [
      '<p>Meet the Tint + SPF You’ll Actually Wear Naturally radiant, this tinted fluid sunscreen balances hydration and control.</p>',
      '<p>Infused with hydrating ingredients and shine control, it leaves skin glowing yet balanced.</p>',
      '<p><strong>Effortless Skin Enhancement</strong><br>Designed to be your skin, but better.</p>',
      '<p><strong>12 Versatile Shades</strong><br>Available in 12 sheer shades.</p>',
    ].join('');
    const html = `
      <script>
        window.__remixContext = {"product":{"descriptionHtml":${JSON.stringify(descriptionHtml)}}};
      </script>
    `;

    expect(extractSourceProductFactsFromHtml(html).description).toBe(
      'Meet the Tint + SPF You’ll Actually Wear Naturally radiant, this tinted fluid sunscreen balances hydration and control.',
    );
  });

  test('fetches source review aggregate from official product HTML', async () => {
    axios.get.mockResolvedValueOnce({
      data: '<script>var okendoProduct = {"reviewCount":1404,"reviewAverageValue":"4.9"};</script>',
    });

    await expect(
      fetchSourceReviewSummary('https://beautyofjoseon.com/products/glow-replenishing-rice-milk', {
        timeoutMs: 5000,
      }),
    ).resolves.toEqual({
      rating: 4.9,
      review_count: 1404,
    });

    expect(axios.get).toHaveBeenCalledWith(
      'https://beautyofjoseon.com/products/glow-replenishing-rice-milk',
      expect.objectContaining({
        timeout: 5000,
      }),
    );
  });

  test('extracts Klaviyo metafield review aggregate from official product HTML', () => {
    expect(
      extractSourceReviewSummaryFromHtml(`
        <script>
          MetafieldReviews = {"rating":{"scale_min":"1.0","scale_max":"5.0","value":"4.67"},"rating_count":69};
        </script>
      `),
    ).toEqual({
      rating: 4.67,
      review_count: 69,
    });
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

  test('hydrates external seed pilot cases from structured PDP formula fields', () => {
    const row = buildPilotCaseFromExternalSeedProduct({
      merchant_id: 'external_seed',
      id: 'ext_byoma_cleanser',
      brand: 'BYOMA',
      title: 'Milky Moisture Cleanser',
      category_path: ['Skincare', 'Cleanser'],
      description: 'A milky cleanser for dry, sensitive skin.',
      pdp_ingredients_raw:
        'Water, Glycerin, Avena Sativa Kernel Flour, Ceramide NP, Cholesterol, Panthenol',
      pdp_active_ingredients_raw: 'Tri-Ceramide Complex, Oat Extract, Panthenol',
      pdp_how_to_use_raw: 'Massage onto damp skin, then rinse well.',
    });

    expect(row.product.ingredients_inci).toEqual([
      'Water',
      'Glycerin',
      'Avena Sativa Kernel Flour',
      'Ceramide NP',
      'Cholesterol',
      'Panthenol',
    ]);
    expect(row.product.how_to_use).toBe('Massage onto damp skin, then rinse well.');
  });

  test('normalizes split numeric INCI tokens from seed ingredient arrays', () => {
    const row = buildPilotCaseFromExternalSeedProduct({
      merchant_id: 'external_seed',
      id: 'ext_split_inci',
      brand: 'BYOMA',
      title: 'Bio-Collagen Radiance Facial Mask',
      category_path: ['Skincare', 'Mask'],
      description: 'A gel-to-film facial mask.',
      inci_list: ['Water', '1', '2-Hexanediol', 'Glycerin'],
    });

    expect(row.product.ingredients_inci).toEqual([
      'Water',
      '1,2-Hexanediol',
      'Glycerin',
    ]);
  });

  test('uses external seed structure to complete live PDP cases missing formula modules', () => {
    const response = {
      subject: {
        canonical_product_ref: {
          merchant_id: 'external_seed',
          product_id: 'ext_byoma_mask',
        },
      },
      modules: [
        {
          type: 'canonical',
          data: {
            pdp_payload: {
              product: {
                title: 'Bio-Collagen Radiance Facial Mask',
                brand: { name: 'BYOMA' },
                category_path: ['Skincare', 'Mask'],
                description: 'A gel-to-film facial mask for hydrated-looking skin.',
              },
            },
          },
        },
      ],
    };

    const row = buildPilotCaseFromPdpResponse(response, {
      product: {
        pdp_ingredients_raw:
          'Water, Glycerin, Hydrolyzed Collagen, Centella Asiatica Extract, Ceramide NP, Astaxanthin',
        pdp_how_to_use_raw: 'Apply an even layer, let it dry, then peel off.',
      },
    });

    expect(row.product.ingredients_inci).toEqual([
      'Water',
      'Glycerin',
      'Hydrolyzed Collagen',
      'Centella Asiatica Extract',
      'Ceramide NP',
      'Astaxanthin',
    ]);
    expect(row.product.how_to_use).toBe('Apply an even layer, let it dry, then peel off.');
  });

  test('drops pseudo-ingredient phrases from external seed pilot cases', () => {
    const row = buildPilotCaseFromExternalSeedProduct({
      merchant_id: 'external_seed',
      id: 'ext_bad_ingredients',
      brand: 'INNBEAUTY PROJECT',
      title: 'Extreme Cream',
      category_path: ['Skincare', 'Moisturizer'],
      description: 'A rich moisturizer.',
      ingredients_inci: [
        'including "lifting" peptides',
        'biomimetic growth factors',
        'and ceramides combine - Fast-acting',
        'See full ingredients',
        'Ingredients tab on each product',
        'We got you covered',
        'Water',
        'Glycerin',
        'Ceramide NP',
      ],
    });

    expect(row.product.ingredients_inci).toEqual(['Water', 'Glycerin', 'Ceramide NP']);
  });

  test('enriches live pilot case with source page buyer review aggregate', async () => {
    axios.get.mockResolvedValueOnce({
      data: '<script>var okendoProduct = {"reviewCount":1404,"reviewAverageValue":"4.9"};</script>',
    });

    const row = await enrichCaseWithSourceReviewSummary({
      case_id: 'live_ext_joseon',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_joseon',
      },
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_joseon',
        brand: 'Beauty of Joseon',
        title: 'Glow Replenishing Rice Milk',
        source_url: 'https://beautyofjoseon.com/products/glow-replenishing-rice-milk',
      },
    });

    expect(row.product.review_summary).toEqual({
      rating: 4.9,
      review_count: 1404,
    });
    expect(row.product.community_signals).toEqual(
      expect.objectContaining({
        status: 'available',
        source_counts: {
          reviews: 1404,
        },
      }),
    );
    expect(row.product.review_source_url).toBe(
      'https://beautyofjoseon.com/products/glow-replenishing-rice-milk',
    );
  });

  test('enriches live pilot case with official source facts without overriding stronger PDP facts', async () => {
    axios.get.mockResolvedValueOnce({
      data: `
        <script>
          window.__remixContext = {"product":{"descriptionHtml":${JSON.stringify(
            '<p>A 10% niacinamide serum for visible pores, uneven tone, and texture.</p><h3>Ingredients</h3><p>Water - 80.2%<br>Niacinamide - 10%<br>Glycerin - 2%</p>',
          )}}};
        </script>
      `,
    });

    const row = await enrichCaseWithSourcePageEvidence(
      {
        case_id: 'live_ext_good_molecules',
        canonical_product_ref: {
          merchant_id: 'external_seed',
          product_id: 'ext_good_molecules',
        },
        product: {
          merchant_id: 'external_seed',
          product_id: 'ext_good_molecules',
          brand: 'Good Molecules',
          title: 'Niacinamide Serum',
          description: '',
          ingredients_inci: ['Niacinamide'],
          source_url: 'https://v1.goodmolecules.com/products/niacinamide-serum',
        },
      },
      {
        includeFacts: true,
        timeoutMs: 5000,
      },
    );

    expect(row.product.description).toBe(
      'A 10% niacinamide serum for visible pores, uneven tone, and texture.',
    );
    expect(row.product.ingredients_inci).toEqual(['Water', 'Niacinamide', 'Glycerin']);
    expect(row.product.source_page_facts_url).toBe(
      'https://v1.goodmolecules.com/products/niacinamide-serum',
    );
  });

  test('replaces noisy long seed descriptions with cleaner official source facts', async () => {
    axios.get.mockResolvedValueOnce({
      data: `
        <script>
          window.__remixContext = {"product":{"descriptionHtml":${JSON.stringify(
            '<p>A barrier mist with NAD+, fermented black rice, probiotics, and ceramides for lightweight hydration.</p>',
          )}}};
        </script>
      `,
    });

    const row = await enrichCaseWithSourcePageEvidence(
      {
        case_id: 'live_ext_haruharu',
        canonical_product_ref: {
          merchant_id: 'external_seed',
          product_id: 'ext_haruharu',
        },
        product: {
          merchant_id: 'external_seed',
          product_id: 'ext_haruharu',
          brand: 'Haruharu Wonder',
          title: 'Probiotics Barrier 2% NAD + Serum Mist',
          description: `Details Benefits ${'Long page soup. '.repeat(120)}`,
          source_url: 'https://haruharuwonder.com/products/mist',
        },
      },
      {
        includeFacts: true,
        timeoutMs: 5000,
      },
    );

    expect(row.product.description).toBe(
      'A barrier mist with NAD+, fermented black rice, probiotics, and ceramides for lightweight hydration.',
    );
    expect(row.product.source_page_facts_url).toBe('https://haruharuwonder.com/products/mist');
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

  test('preserves merchant id when fetching merchant-scoped PDP responses', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        status: 'success',
      },
    });

    await fetchPdpResponse('https://agent.pivota.cc/api/gateway', '9886499864904', {
      merchant_id: 'merch_efbc46b4619cfbdf',
      product_id: '9886499864904',
    });

    expect(axios.post).toHaveBeenCalledWith(
      'https://agent.pivota.cc/api/gateway',
      expect.objectContaining({
        operation: 'get_pdp_v2',
        payload: expect.objectContaining({
          product_ref: {
            merchant_id: 'merch_efbc46b4619cfbdf',
            product_id: '9886499864904',
          },
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
