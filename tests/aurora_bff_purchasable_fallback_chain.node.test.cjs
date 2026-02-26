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
