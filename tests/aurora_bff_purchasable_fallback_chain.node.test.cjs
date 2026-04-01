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
  assert.equal(calls[1].allowExternalSeed, true);
  assert.equal(calls[1].externalSeedStrategy, 'supplement_internal_first');
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
    { allowExternalSeed: true, fastMode: false },
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.selected_source, 'external_seed');
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].retrieval_source, 'external_seed');
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
      return {
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
      };
    },
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
    assert.equal(out.external_search_ctas.length > 0, true);
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
