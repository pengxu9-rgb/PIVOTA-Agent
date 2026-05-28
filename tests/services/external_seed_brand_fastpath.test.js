const {
  runExternalSeedBrandMainlineFastpath,
} = require('../../src/findProductsExternalSeedBrandFastpath');
const {
  prepareExternalSeedDirectSearchPlan,
} = require('../../src/findProductsExternalSeedDirectPlanning');

function buildDeps(overrides = {}) {
  return {
    detectBrandEntities: () => ({ brands: ['fenty'] }),
    normalizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase(),
    buildBrandQueryVariants: (query, brands) => [query, ...(brands || [])],
    normalizeBrandText: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ''),
    buildExternalSeedBrandSearchProduct: (row) => ({
      id: row.external_product_id || row.id,
      product_id: row.external_product_id || row.id,
      merchant_id: 'external_seed',
      title: row.title,
    }),
    buildSearchProductKey: (product) => product.product_id,
    logger: { warn: jest.fn() },
    ...overrides,
  };
}

describe('runExternalSeedBrandMainlineFastpath', () => {
  test('gates on index_pipeline_state.serving_eligible when FIND_PRODUCTS_USES_CATALOG_ROW_TRUST is off', async () => {
    const prev = process.env.FIND_PRODUCTS_USES_CATALOG_ROW_TRUST;
    delete process.env.FIND_PRODUCTS_USES_CATALOG_ROW_TRUST;
    jest.resetModules();
    const queries = [];
    const deps = buildDeps({
      query: jest.fn(async (sql, params) => {
        queries.push({ sql: String(sql), params });
        return {
          rows: [
            { id: 'seed_x', external_product_id: 'ext_x', title: 'X', total_rows: 1 },
          ],
        };
      }),
    });
    try {
      const { runExternalSeedBrandMainlineFastpath: freshRunner } = require('../../src/findProductsExternalSeedBrandFastpath');
      await freshRunner({
        relevanceQueryText: 'fenty',
        market: 'US',
        tool: '*',
        inStockOnly: false,
        safePage: 1,
        safeLimit: 24,
        safeOffset: 0,
        deps,
      });
      expect(deps.query).toHaveBeenCalledTimes(1);
      expect(queries[0].sql).toMatch(/INNER\s+JOIN\s+index_pipeline_state\s+ips/i);
      expect(queries[0].sql).toMatch(/ips\.serving_eligible\s*=\s*TRUE/i);
      expect(queries[0].sql).toMatch(/attached_product_key\s+IS\s+NOT\s+NULL/i);
      expect(queries[0].sql).toMatch(/cp\.product_key\s*=\s*external_product_seeds\.attached_product_key/i);
      expect(queries[0].sql).not.toMatch(/source_product_id\s*=\s*coalesce/i);
      expect(queries[0].sql).not.toMatch(/catalog_row_trust/i);
    } finally {
      if (prev === undefined) delete process.env.FIND_PRODUCTS_USES_CATALOG_ROW_TRUST;
      else process.env.FIND_PRODUCTS_USES_CATALOG_ROW_TRUST = prev;
    }
  });

  test('gates on catalog_row_trust when FIND_PRODUCTS_USES_CATALOG_ROW_TRUST is on', async () => {
    const prev = process.env.FIND_PRODUCTS_USES_CATALOG_ROW_TRUST;
    process.env.FIND_PRODUCTS_USES_CATALOG_ROW_TRUST = 'true';
    jest.resetModules();
    const queries = [];
    const deps = buildDeps({
      query: jest.fn(async (sql, params) => {
        queries.push({ sql: String(sql), params });
        return {
          rows: [
            { id: 'seed_x', external_product_id: 'ext_x', title: 'X', total_rows: 1 },
          ],
        };
      }),
    });
    try {
      const { runExternalSeedBrandMainlineFastpath: freshRunner } = require('../../src/findProductsExternalSeedBrandFastpath');
      await freshRunner({
        relevanceQueryText: 'fenty',
        market: 'US',
        tool: '*',
        inStockOnly: false,
        safePage: 1,
        safeLimit: 24,
        safeOffset: 0,
        deps,
      });
      expect(deps.query).toHaveBeenCalledTimes(1);
      expect(queries[0].sql).toMatch(/INNER\s+JOIN\s+catalog_row_trust\s+crt/i);
      expect(queries[0].sql).toMatch(/crt\.subject_type\s*=\s*'product'/i);
      expect(queries[0].sql).toMatch(/crt\.subject_key\s*=\s*cp\.product_key/i);
      expect(queries[0].sql).toMatch(/crt\.serving_decision\s*=\s*'public'/i);
      expect(queries[0].sql).toMatch(/attached_product_key\s+IS\s+NOT\s+NULL/i);
      expect(queries[0].sql).toMatch(/cp\.product_key\s*=\s*external_product_seeds\.attached_product_key/i);
      expect(queries[0].sql).not.toMatch(/source_product_id\s*=\s*coalesce/i);
      expect(queries[0].sql).not.toMatch(/INNER\s+JOIN\s+index_pipeline_state\s+ips/i);
      expect(queries[0].sql).not.toMatch(/ips\.serving_eligible/i);
    } finally {
      if (prev === undefined) delete process.env.FIND_PRODUCTS_USES_CATALOG_ROW_TRUST;
      else process.env.FIND_PRODUCTS_USES_CATALOG_ROW_TRUST = prev;
    }
  });

  test('uses a single windowed exact-brand query for covered pages', async () => {
    const queries = [];
    const deps = buildDeps({
      query: jest.fn(async (sql, params) => {
        queries.push({ sql: String(sql), params });
        return {
          rows: [
            {
              id: 'seed_1',
              external_product_id: 'fenty_1',
              title: 'Fenty Product',
              total_rows: 299,
            },
          ],
        };
      }),
    });

    const response = await runExternalSeedBrandMainlineFastpath({
      relevanceQueryText: 'fenty',
      market: 'US',
      tool: '*',
      inStockOnly: true,
      safePage: 1,
      safeLimit: 24,
      safeOffset: 0,
      deps,
    });

    expect(response?.status).toBe('success');
    expect(response?.total).toBe(299);
    expect(response?.products).toHaveLength(1);
    expect(deps.query).toHaveBeenCalledTimes(1);
    expect(queries[0].sql).toContain('COUNT(*) OVER()::int AS total_rows');
    expect(queries[0].sql).not.toContain('tool = ANY');
    expect(queries[0].params[1]).toEqual(['fenty']);
    expect(queries[0].params[2]).toBe(24);
    expect(queries[0].params[3]).toBe(0);
    expect(queries[0].sql).toContain('LIMIT $3');
    expect(queries[0].sql).toContain('OFFSET $4');
    expect(queries[0].sql).not.toContain('SELECT COUNT(*)::int AS total');
  });

  test('scopes exact-brand query to preferred seed tools when a concrete tool is supplied', async () => {
    const queries = [];
    const deps = buildDeps({
      query: jest.fn(async (sql, params) => {
        queries.push({ sql: String(sql), params });
        return {
          rows: [
            {
              id: 'seed_1',
              external_product_id: 'fenty_1',
              title: 'Fenty Product',
              total_rows: 1,
            },
          ],
        };
      }),
    });

    await runExternalSeedBrandMainlineFastpath({
      relevanceQueryText: 'fenty',
      market: 'US',
      tool: 'creator_agents',
      inStockOnly: true,
      safePage: 1,
      safeLimit: 24,
      safeOffset: 0,
      deps,
    });

    expect(queries[0].sql).toContain('tool = ANY($2::text[])');
    expect(queries[0].params[1]).toEqual(['creator_agents', '*']);
    expect(queries[0].params[2]).toEqual(['fenty']);
    expect(queries[0].params[3]).toBe(24);
    expect(queries[0].params[4]).toBe(0);
    expect(queries[0].sql).toContain('LIMIT $4');
    expect(queries[0].sql).toContain('OFFSET $5');
  });

  test('can include attached seeds and match brand evidence inside seed data for rescue scope', async () => {
    const queries = [];
    const deps = buildDeps({
      query: jest.fn(async (sql, params) => {
        queries.push({ sql: String(sql), params });
        if (queries.length === 1) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: 'seed_1',
              external_product_id: 'fenty_1',
              title: 'Gloss Bomb Universal Lip Luminizer',
              seed_data: { brand: 'Fenty Beauty' },
              total_rows: 1,
            },
          ],
        };
      }),
    });

    const response = await runExternalSeedBrandMainlineFastpath({
      relevanceQueryText: 'fenty beauty gloss',
      market: 'US',
      tool: '*',
      inStockOnly: true,
      includeAttached: true,
      safePage: 1,
      safeLimit: 24,
      safeOffset: 0,
      deps,
    });

    expect(response?.products).toHaveLength(1);
    expect(response?.metadata?.retrieval_include_attached).toBe(true);
    expect(queries[0].sql).toContain('attached_product_key IS NOT NULL');
    expect(queries[0].sql).not.toContain('attached_product_key IS NULL');
    expect(queries[1].sql).toContain('seed_data::text');
    expect(queries[1].sql).toContain('attached_product_key IS NOT NULL');
    expect(queries[1].sql).not.toContain('attached_product_key IS NULL');
  });
});

describe('prepareExternalSeedDirectSearchPlan brand fastpath', () => {
  test('skips ingredient recall planning for brand-like public search', async () => {
    const resolveIngredientRecallProfileKnowledge = jest.fn(async () => {
      throw new Error('ingredient recall should not run for brand mainline');
    });

    const plan = await prepareExternalSeedDirectSearchPlan({
      search: {
        query: 'fenty',
        page: 1,
        limit: 24,
        in_stock_only: true,
      },
      metadata: {
        source: 'search',
      },
      deps: {
        extractSearchQueryText: (search) => String(search?.query || '').trim(),
        firstQueryParamValue: (value) => value,
        SEARCH_LIMIT_MAX: 100,
        parseQueryBoolean: (value) => value !== false && value !== 'false',
        normalizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase(),
        isPublicSearchSource: (source) => source === 'search',
        detectBrandEntities: () => ({ brand_like: true, brands: ['fenty'] }),
        hasExplicitCategoryHint: () => false,
        resolveIngredientRecallProfileKnowledge,
        resolveIngredientRecallProfile: jest.fn(() => null),
        hasBeautyIngredientIntentSignal: jest.fn(() => false),
        normalizeRecoTargetStep: jest.fn((value) => value || null),
        resolveRecoTargetStepIntent: jest.fn(() => null),
        resolveIngredientIntentTargetStepFamily: jest.fn(() => null),
        normalizeSearchUiSurface: jest.fn(() => null),
        normalizeRecommendationDecisionMode: jest.fn(() => null),
        resolveGuidanceSearchSessionId: jest.fn(() => null),
        loadGuidanceSearchSessionSeenProductIds: jest.fn(async () => []),
        shouldUseSharedTargetRelevancePipeline: jest.fn(() => false),
        resolveGuidanceSearchStepStrength: jest.fn(() => null),
        buildGuidanceSearchNormalizedIntent: jest.fn(() => null),
        buildSerumCanaryBackboneQueries: jest.fn(() => []),
        buildGuidanceRecallSupplementQueries: jest.fn(() => []),
        buildBeautyFamilySupplementQueries: jest.fn(() => []),
        buildIngredientRecallQueryVariants: jest.fn(() => []),
        parseQueryStringArray: jest.fn(() => []),
        extractSearchAnchorTokens: (value) => String(value || '').split(/\s+/).filter(Boolean),
        tokenizeSearchTextForMatch: (value) => String(value || '').split(/\s+/).filter(Boolean),
      },
    });

    expect(plan?.publicBrandSearchMainline).toBe(true);
    expect(plan?.retrievalQueries).toEqual(['fenty']);
    expect(plan?.ingredientIntent).toBe(false);
    expect(resolveIngredientRecallProfileKnowledge).not.toHaveBeenCalled();
  });
});
