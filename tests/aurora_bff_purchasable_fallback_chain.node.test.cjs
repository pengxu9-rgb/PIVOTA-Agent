const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/routes');

test('purchasable fallback: returns query_missing when query is empty', async () => {
  let called = 0;
  const out = await __internal.buildPurchasableFallbackCandidates({
    query: '',
    searchFn: async () => {
      called += 1;
      return { ok: false, products: [], reason: 'should_not_call' };
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'query_missing');
  assert.equal(called, 0);
});

test('purchasable fallback: catalog-only mode keeps catalog source', async () => {
  const calls = [];
  const out = await __internal.buildPurchasableFallbackCandidates({
    query: 'mineral sunscreen',
    allowExternalSeed: false,
    searchFn: async (params) => {
      calls.push(params);
      return {
        ok: true,
        products: [
          {
            product_id: 'prod_catalog_1',
            merchant_id: 'm_1',
            name: 'Catalog Sunscreen',
            pdp_url: 'https://example.com/pdp/catalog-sunscreen',
            source: 'catalog',
          },
        ],
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(out.ok, true);
  assert.equal(out.selected_source, 'catalog');
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].source, 'catalog');
  assert.equal(out.products[0].retrieval_source, 'catalog');
});

test('purchasable fallback: explicit internal sourceScope runs only the catalog stage', async () => {
  const calls = [];
  const out = await __internal.buildPurchasableFallbackCandidates({
    query: 'oil control serum',
    sourceScope: 'internal',
    searchFn: async (params) => {
      calls.push({
        allowExternalSeed: params.allowExternalSeed === true,
        fastMode: params.fastMode === true,
      });
      return {
        ok: true,
        products: [
          {
            product_id: 'prod_catalog_internal_only',
            merchant_id: 'm_catalog_internal_only',
            name: 'Catalog Oil Control Serum',
            pdp_url: 'https://example.com/pdp/catalog-oil-control',
            source: 'catalog',
          },
        ],
      };
    },
  });

  assert.deepEqual(calls, [{ allowExternalSeed: false, fastMode: true }]);
  assert.equal(out.selected_source, 'catalog');
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].retrieval_source, 'catalog');
});

test('purchasable fallback: explicit external sourceScope runs only the external seed stage', async () => {
  const calls = [];
  const out = await __internal.buildPurchasableFallbackCandidates({
    query: 'oil control serum',
    sourceScope: 'external_seed',
    searchFn: async (params) => {
      calls.push({
        allowExternalSeed: params.allowExternalSeed === true,
        fastMode: params.fastMode === true,
        externalSeedStrategy: params.externalSeedStrategy,
      });
      return { ok: false, products: [], reason: 'should_not_call' };
    },
    externalSeedSearchFn: async ({ query, transportPolicyMode }) => {
      calls.push({
        externalSeedQuery: query,
        transportPolicyMode,
      });
      return {
        ok: true,
        products: [
          {
            product_id: 'prod_external_stage_only',
            merchant_id: 'm_external_stage_only',
            name: 'External Oil Balance Serum',
            canonical_pdp_url: 'https://example.com/pdp/external-oil-balance',
            source: 'external_seed',
            retrieval_source: 'external_seed',
          },
          {
            product_id: 'prod_catalog_noise',
            merchant_id: 'm_catalog_noise',
            name: 'Catalog Noise',
            canonical_pdp_url: 'https://example.com/pdp/catalog-noise',
            source: 'catalog',
            retrieval_source: 'catalog',
          },
        ],
      };
    },
  });

  assert.deepEqual(calls, [{ externalSeedQuery: 'oil control serum', transportPolicyMode: 'default' }]);
  assert.equal(out.selected_source, 'external_seed');
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].retrieval_source, 'external_seed');
  assert.equal(out.actual_http_attempt_count, 0);
});

test('purchasable fallback: explicit external sourceScope falls back to backend external supplement when local seed search is empty', async () => {
  const calls = [];
  const out = await __internal.buildPurchasableFallbackCandidates({
    query: 'lightweight moisturizer oily skin',
    sourceScope: 'external_seed',
    searchFn: async (params) => {
      calls.push({
        allowExternalSeed: params.allowExternalSeed === true,
        fastMode: params.fastMode === true,
        externalSeedStrategy: params.externalSeedStrategy,
      });
      return {
        ok: true,
        products: [
          {
            product_id: 'prod_backend_external_only',
            merchant_id: 'external_seed',
            name: 'Backend External Gel Cream',
            canonical_pdp_url: 'https://example.com/pdp/backend-external-gel-cream',
            source: 'external_seed',
            retrieval_source: 'external_seed',
          },
          {
            product_id: 'prod_backend_catalog_noise',
            merchant_id: 'catalog',
            name: 'Catalog Noise',
            canonical_pdp_url: 'https://example.com/pdp/catalog-noise',
            source: 'catalog',
            retrieval_source: 'catalog',
          },
        ],
        actual_http_attempt_count: 1,
        attempted_base_urls: ['https://pivota-backend.test'],
        attempted_paths: ['/agent/v1/products/search'],
      };
    },
    externalSeedSearchFn: async ({ query, transportPolicyMode }) => {
      calls.push({
        externalSeedQuery: query,
        transportPolicyMode,
      });
      return {
        ok: true,
        products: [],
        reason: 'empty',
      };
    },
  });

  assert.deepEqual(calls, [
    { externalSeedQuery: 'lightweight moisturizer oily skin', transportPolicyMode: 'default' },
    { allowExternalSeed: true, fastMode: true, externalSeedStrategy: 'supplement_internal_first' },
  ]);
  assert.equal(out.selected_source, 'external_seed');
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].product_id, 'prod_backend_external_only');
  assert.equal(out.products[0].retrieval_source, 'external_seed');
  assert.equal(out.actual_http_attempt_count, 1);
  assert.deepEqual(out.attempted_base_urls, ['https://pivota-backend.test']);
  assert.deepEqual(out.attempted_paths, ['/agent/v1/products/search']);
  assert.equal(out.stages.external_seed_local.products.length, 0);
  assert.equal(out.stages.external_seed_backend.products.length, 2);
});

test('purchasable fallback: supplements from external seed when catalog is empty', async () => {
  const calls = [];
  const out = await __internal.buildPurchasableFallbackCandidates({
    query: 'azelaic acid serum',
    allowExternalSeed: true,
    externalSeedStrategy: 'supplement_internal_first',
    searchFn: async (params) => {
      calls.push(params);
      if (params.allowExternalSeed === false) {
        return { ok: true, products: [], reason: 'empty' };
      }
      return { ok: false, products: [], reason: 'should_not_call' };
    },
    externalSeedSearchFn: async ({ query, transportPolicyMode }) => {
      calls.push({ externalSeedQuery: query, transportPolicyMode });
      return {
        ok: true,
        products: [
          {
            product_id: 'prod_external_1',
            merchant_id: 'm_ext_1',
            name: 'External Seed Serum',
            canonical_pdp_url: 'https://example.com/pdp/ext-serum',
            source: 'external_seed',
          },
        ],
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].allowExternalSeed, false);
  assert.equal(calls[1].externalSeedQuery, 'azelaic acid serum');
  assert.equal(out.ok, true);
  assert.equal(out.selected_source, 'external_seed');
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].retrieval_source, 'external_seed');
});

test('purchasable fallback: still supplements from external seed when catalog transiently times out', async () => {
  const calls = [];
  const out = await __internal.buildPurchasableFallbackCandidates({
    query: 'oil control serum',
    allowExternalSeed: true,
    externalSeedStrategy: 'supplement_internal_first',
    searchFn: async (params) => {
      calls.push({
        allowExternalSeed: params.allowExternalSeed === true,
        fastMode: params.fastMode === true,
      });
      if (params.allowExternalSeed === false) {
        return { ok: false, products: [], reason: 'upstream_timeout' };
      }
      return { ok: false, products: [], reason: 'should_not_call' };
    },
    externalSeedSearchFn: async ({ query }) => {
      calls.push({ externalSeedQuery: query });
      return {
        ok: true,
        products: [
          {
            product_id: 'prod_external_timeout_1',
            merchant_id: 'm_ext_timeout_1',
            name: 'External Oil Control Serum',
            canonical_pdp_url: 'https://example.com/pdp/ext-oil-timeout',
            source: 'external_seed',
            search_aliases: ['oil control serum'],
            benefit_tags: ['oil control', 'shine control'],
          },
        ],
      };
    },
  });

  assert.deepEqual(calls, [
    { allowExternalSeed: false, fastMode: true },
    { externalSeedQuery: 'oil control serum' },
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.selected_source, 'external_seed');
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].retrieval_source, 'external_seed');
});

test('purchasable fallback: supplement_internal_first runs catalog and external seed in parallel', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls = [];
  const out = await __internal.buildPurchasableFallbackCandidates({
    query: 'oil control serum',
    allowExternalSeed: true,
    externalSeedStrategy: 'supplement_internal_first',
    searchFn: async (params) => {
      calls.push({
        allowExternalSeed: params.allowExternalSeed === true,
        fastMode: params.fastMode === true,
      });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return { ok: true, products: [], reason: 'empty' };
    },
    externalSeedSearchFn: async ({ query }) => {
      calls.push({ externalSeedQuery: query });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return {
        ok: true,
        products: [
          {
            product_id: 'prod_external_parallel_1',
            merchant_id: 'm_ext_parallel_1',
            name: 'External Oil Control Serum',
            canonical_pdp_url: 'https://example.com/pdp/ext-oil-parallel',
            source: 'external_seed',
            search_aliases: ['oil control serum'],
            benefit_tags: ['oil control', 'shine control'],
          },
        ],
      };
    },
  });

  assert.equal(calls.filter((row) => row.allowExternalSeed === false).length, 1);
  assert.equal(calls.filter((row) => row.externalSeedQuery === 'oil control serum').length, 1);
  assert.ok(maxInFlight >= 2);
  assert.equal(out.selected_source, 'external_seed');
});

test('purchasable fallback: merges catalog + external and de-duplicates by product+merchant', async () => {
  const out = await __internal.buildPurchasableFallbackCandidates({
    query: 'niacinamide',
    allowExternalSeed: true,
    externalSeedStrategy: 'supplement_internal_first',
    searchFn: async ({ allowExternalSeed }) => {
      if (allowExternalSeed === false) {
        return {
          ok: true,
          products: [
            {
              product_id: 'prod_1',
              merchant_id: 'm_1',
              name: 'Catalog Niacinamide',
              pdp_url: 'https://example.com/pdp/catalog-niacinamide',
              source: 'catalog',
            },
          ],
        };
      }
      return { ok: false, products: [], reason: 'should_not_call' };
    },
    externalSeedSearchFn: async () => ({
        ok: true,
        products: [
          {
            product_id: 'prod_1',
            merchant_id: 'm_1',
            name: 'Catalog Niacinamide Duplicate',
            pdp_url: 'https://example.com/pdp/catalog-niacinamide',
            source: 'external_seed',
          },
          {
            product_id: 'prod_2',
            merchant_id: 'm_2',
            name: 'External Niacinamide',
            pdp_url: 'https://example.com/pdp/external-niacinamide',
            source: 'external_seed',
          },
        ],
      }),
  });

  assert.equal(out.ok, true);
  assert.equal(out.selected_source, 'catalog_plus_external_seed');
  assert.equal(out.products.length, 2);
  assert.equal(out.products.some((row) => row.product_id === 'prod_1'), true);
  assert.equal(out.products.some((row) => row.product_id === 'prod_2'), true);
});

test('purchasable fallback: can retain id-less external candidates when explicitly enabled', async () => {
  const out = await __internal.buildPurchasableFallbackCandidates({
    query: 'tranexamic acid serum',
    allowExternalSeed: false,
    allowIdlessProducts: true,
    searchFn: async () => ({
      ok: true,
      products: [
        {
          name: 'External Listing Without Canonical Id',
          pdp_url: 'https://example.com/pdp/txa-no-id',
          source: 'external_seed',
        },
      ],
    }),
  });

  assert.equal(out.ok, true);
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].name, 'External Listing Without Canonical Id');
  assert.equal(out.products[0].retrieval_source, 'external_seed');
});

test('purchasable fallback: llm fallback returns strict https skincare products only', async () => {
  __internal.__setCallGeminiJsonObjectForTest(async () => ({
    ok: true,
    json: {
      products: [
        {
          name: 'Lightweight UV Gel',
          brand: 'SunLabs',
          category: 'skincare sunscreen',
          pdp_url: 'https://example.com/pdp/uv-gel',
          why: 'Daily UV baseline support.',
        },
        {
          name: 'Search Link Candidate',
          brand: 'QueryLabs',
          category: 'skincare',
          pdp_url: 'https://www.google.com/search?q=uv+gel',
          why: 'invalid search url',
        },
      ],
    },
  }));
  try {
    const out = await __internal.recoverProductsWithLlmFallbackFromQueries({
      queries: ['UV gel sunscreen'],
      strictFilter: true,
      maxProducts: 3,
    });
    assert.equal(out.products.length, 1);
    assert.equal(out.products[0].retrieval_source, 'llm_fallback');
    assert.equal(out.products[0].retrieval_reason, 'catalog_empty_or_filtered');
    assert.equal(out.products[0].pdp_url, 'https://example.com/pdp/uv-gel');
    assert.equal(out.external_search_ctas.length, 0);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
  }
});

test('photo fallback cta builder: string query keeps the ingredient text instead of generic open search result', () => {
  const out = __internal.buildExternalSearchCta('Azelaic Acid', 'strict_filter_all_dropped_fallback');
  assert.equal(out.title, 'Azelaic Acid');
  assert.equal(out.source, 'external');
  assert.equal(String(out.url || '').includes('Azelaic%20Acid'), true);
});

test('purchasable fallback: query collection includes ingredient target names and missing-catalog ladder queries', () => {
  const queries = __internal.collectPurchasableFallbackQueries({
    payload: {
      __missing_catalog_queries: [
        {
          ingredient_id: 'ceramide_np',
          ingredient_name: 'Ceramide NP',
          query: 'ceramide barrier moisturizer',
          query_ladder_steps: [
            { query: 'barrier repair ceramide moisturizer' },
          ],
          candidate_url: 'https://www.amazon.com/s?k=ceramide+barrier+moisturizer',
        },
      ],
    },
    extraSeeds: [
      {
        ingredient_id: 'ceramide_np',
        ingredient_name: 'Ceramide NP',
      },
      {
        ingredient_id: 'panthenol',
        ingredient_name: 'Panthenol (B5)',
      },
    ],
    maxQueries: 8,
  });

  assert.equal(Array.isArray(queries), true);
  assert.equal(queries.some((row) => /ceramide barrier moisturizer/i.test(String(row))), true);
  assert.equal(queries.some((row) => /barrier repair ceramide moisturizer/i.test(String(row))), true);
  assert.equal(queries.some((row) => /panthenol \(b5/i.test(String(row))), true);
});

test('reco catalog dependency failure prefers staged recall diagnostics over artifact_missing', () => {
  const primaryTimeoutFailure = __internal.deriveRecoCatalogDependencyFailure({
    executed_query_count: 4,
    stage_timeout_counts: {
      framework_stage_a_primary_internal: 2,
      framework_stage_b_primary_external_seed: 2,
    },
    primary_stage_timeout_class: 'transient_timeout',
    candidate_drop_stage: 'upstream_timeout_primary_role',
  });
  assert.equal(primaryTimeoutFailure.effective_failure_class, 'upstream_timeout_primary_role');

  const timeoutFailure = __internal.deriveRecoCatalogDependencyFailure({
    executed_query_count: 4,
    stage_timeout_counts: {
      framework_stage_a_primary_internal: 2,
      framework_stage_b_primary_external_seed: 2,
    },
    candidate_drop_stage: 'upstream_timeout',
  });
  assert.equal(timeoutFailure.effective_failure_class, 'upstream_timeout');

  const noRecallFailure = __internal.deriveRecoCatalogDependencyFailure({
    executed_query_count: 2,
    candidate_drop_stage: 'no_recall_from_planned_sources',
  });
  assert.equal(noRecallFailure.effective_failure_class, 'no_recall_from_planned_sources');

  const filteredFailure = __internal.deriveRecoCatalogDependencyFailure({
    executed_query_count: 2,
    candidate_drop_stage: 'filtered_after_recall',
  });
  assert.equal(filteredFailure.effective_failure_class, 'filtered_after_recall');
});
