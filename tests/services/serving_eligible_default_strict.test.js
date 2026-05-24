'use strict';

const ORIGINAL_ENV = process.env;

function resetTestEnv(extra = {}) {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
    API_MODE: 'REAL',
    PIVOTA_API_BASE: 'http://pivota.test',
    PIVOTA_API_KEY: 'test_key',
    DATABASE_URL: '',
    PGHOST: '',
    ...extra,
  };
}

function expectServingEligibleJoin(sql, alias) {
  expect(sql).toMatch(new RegExp(`index_pipeline_state\\s+ips`, 'i'));
  expect(sql).toMatch(new RegExp(`ips\\.content_key\\s*=\\s*${alias}\\.content_key`, 'i'));
  expect(sql).toMatch(/ips\.serving_eligible\s*=\s*TRUE/i);
}

describe('serving eligibility default-strict behavior', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    resetTestEnv();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('PDP serving eligibility is required by default and ineligible bypass is test-only', () => {
    const app = require('../../src/server');
    const { shouldRequirePdpServingEligible } = app._debug;

    expect(shouldRequirePdpServingEligible({}, {})).toBe(true);
    expect(shouldRequirePdpServingEligible({ serving_mode: 'serving_eligible_only' }, {})).toBe(true);
    expect(shouldRequirePdpServingEligible({ serving_mode: 'permissive' }, {})).toBe(false);
    expect(shouldRequirePdpServingEligible({ serving_mode: 'db_serving' }, {})).toBe(false);
    expect(shouldRequirePdpServingEligible({ allow_ineligible: true }, {})).toBe(false);
    expect(shouldRequirePdpServingEligible({}, { allowIneligible: 'yes' })).toBe(false);

    process.env.NODE_ENV = 'production';
    expect(shouldRequirePdpServingEligible({ serving_mode: 'permissive' }, {})).toBe(true);
    expect(shouldRequirePdpServingEligible({ serving_mode: 'db_serving' }, {})).toBe(true);
    expect(shouldRequirePdpServingEligible({ allow_ineligible: true }, {})).toBe(true);
    expect(shouldRequirePdpServingEligible({}, { allowIneligible: 'yes' })).toBe(true);
  });

  test('catalog serving gateway auto mode resolves to serving_eligible_only', async () => {
    const { searchCatalogServingGateway } = require('../../src/services/catalogServingGateway');
    const searchCatalogServingIndexFn = jest.fn(async () => ({
      source: 'local_shadow',
      items: [],
      cursor_info: { next_cursor: null, has_next_page: false },
    }));

    const result = await searchCatalogServingGateway(
      { query_text: 'lipstick', serving_mode: 'auto' },
      {
        env: { DATABASE_URL: 'postgres://example/test' },
        searchCatalogServingIndexFn,
      },
    );

    expect(result.serving_mode).toBe('serving_eligible_only');
    expect(result.shadow_mode).toBe('serving_eligible_only');
    expect(searchCatalogServingIndexFn.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        allowLocalShadow: true,
        servingEligibleOnly: true,
      }),
    );
  });

  test('canonical catalog search joins index_pipeline_state as an eligibility gate', async () => {
    const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
    const query = jest.fn(async () => ({ rows: [] }));

    await fetchCanonicalChainRows({
      query: 'lipstick',
      deps: { query },
    });

    const sql = String(query.mock.calls[0][0] || '');
    expect(sql).toMatch(/FROM catalog_products p/i);
    expectServingEligibleJoin(sql, 'p');
  });

  test('product entity index feed joins index_pipeline_state as an eligibility gate', async () => {
    const { getProductEntityIndexFeed } = require('../../src/services/productEntityIndexFeed');
    const query = jest.fn(async () => ({ rows: [] }));

    await getProductEntityIndexFeed({ limit: 5 }, { query });

    const sql = String(query.mock.calls[0][0] || '');
    expect(sql).toMatch(/FROM catalog_products cp/i);
    expectServingEligibleJoin(sql, 'cp');
  });

  test('direct external-seed retrieval gates seeds through eligible catalog products', async () => {
    const { retrieveExternalSeedDirectCandidates } = require('../../src/findProductsExternalSeedDirectRetrieval');
    const query = jest.fn(async () => ({ rows: [] }));

    await retrieveExternalSeedDirectCandidates({
      retrievalQueries: ['lipstick'],
      relevanceQueryText: 'lipstick',
      deps: {
        resolveGuidanceDirectExternalSeedRetrievalBudget: () => ({
          per_variant_limit: 5,
          raw_product_cap: 5,
        }),
        shouldRunExternalSeedExactTitleRecall: () => false,
        queryExternalSeedExactTitleRows: jest.fn(),
        normalizeExactTitleLookupText: (value) => String(value || '').trim().toLowerCase(),
        compactExactTitleLookupText: (value) => String(value || '').replace(/\s+/g, ''),
        buildExternalSeedProduct: () => null,
        buildSearchProductKey: () => '',
        normalizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase(),
        extractSearchAnchorTokens: () => ['lipstick'],
        tokenizeSearchTextForMatch: (value) => String(value || '').split(/\s+/).filter(Boolean),
        query,
      },
    });

    const sql = String(query.mock.calls[0][0] || '');
    expect(sql).toMatch(/FROM external_product_seeds/i);
    expect(sql).toMatch(/FROM catalog_products cp/i);
    expectServingEligibleJoin(sql, 'cp');
  });

  test('brand external-seed fastpath gates exact and broad queries through eligible catalog products', async () => {
    const { runExternalSeedBrandMainlineFastpath } = require('../../src/findProductsExternalSeedBrandFastpath');
    const query = jest.fn(async () => ({ rows: [] }));

    await runExternalSeedBrandMainlineFastpath({
      relevanceQueryText: 'Fenty',
      market: 'US',
      safeLimit: 5,
      deps: {
        detectBrandEntities: () => ({ brands: ['Fenty'] }),
        normalizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase(),
        buildBrandQueryVariants: () => ['fenty'],
        normalizeBrandText: (value) => String(value || '').trim().toLowerCase(),
        buildExternalSeedBrandSearchProduct: () => null,
        buildSearchProductKey: () => '',
        query,
        logger: { warn: jest.fn() },
      },
    });

    const seedQueries = query.mock.calls
      .map(([sql]) => String(sql || ''))
      .filter((sql) => /FROM external_product_seeds/i.test(sql));
    expect(seedQueries.length).toBeGreaterThanOrEqual(2);
    for (const sql of seedQueries) {
      expect(sql).toMatch(/FROM catalog_products cp/i);
      expectServingEligibleJoin(sql, 'cp');
    }
  });

  test('discovery internal_catalog query gates products_cache through eligible catalog products', async () => {
    resetTestEnv({ DATABASE_URL: 'postgres://example/test' });
    const columns = [
      ...['id', 'merchant_id', 'product_data', 'expires_at', 'cached_at'].map((column_name) => ({
        table_name: 'products_cache',
        column_name,
      })),
      ...[
        'id',
        'external_product_id',
        'destination_url',
        'canonical_url',
        'title',
        'seed_data',
        'market',
        'tool',
        'status',
        'attached_product_key',
        'updated_at',
        'created_at',
      ].map((column_name) => ({
        table_name: 'external_product_seeds',
        column_name,
      })),
    ];
    const dbQuery = jest.fn(async (sql) => {
      const text = String(sql || '');
      if (/information_schema\.columns/i.test(text)) return { rows: columns };
      if (/pg_indexes/i.test(text)) return { rows: [] };
      return { rows: [] };
    });
    jest.doMock('../../src/db', () => ({ query: dbQuery }));
    const { _internals } = require('../../src/services/discoveryFeed');

    await _internals.fetchInternalCatalogCandidates({
      request: { surface: 'test' },
      profile: {},
      queries: ['lipstick'],
      limit: 12,
    });

    const sql = dbQuery.mock.calls
      .map(([callSql]) => String(callSql || ''))
      .find((callSql) => /WITH source AS/i.test(callSql) && /FROM products_cache/i.test(callSql));
    expect(sql).toBeTruthy();
    expect(sql).toMatch(/FROM catalog_products cp/i);
    expectServingEligibleJoin(sql, 'cp');
  });

  test('catalog serving index fails closed when the IPS eligibility query throws', async () => {
    const logger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };
    jest.doMock('../../src/logger', () => logger);
    const { searchCatalogServingIndex } = require('../../src/services/catalogServingIndex');
    const fetchBackfillProductsFn = jest.fn(async () => [
      {
        merchant_id: 'merchant_a',
        product_id: 'prod_a',
        product: {
          merchant_id: 'merchant_a',
          product_id: 'prod_a',
          title: 'Eligible only test',
        },
      },
    ]);
    const queryFn = jest.fn(async () => {
      throw new Error('ips query unavailable');
    });

    const result = await searchCatalogServingIndex(
      { query_text: 'eligible only test', local_scan_limit: 50 },
      {
        env: { DATABASE_URL: 'postgres://example/test' },
        allowLocalShadow: true,
        servingEligibleOnly: true,
        fetchBackfillProductsFn,
        queryFn,
        identityRowsResolverFn: jest.fn(async () => []),
        productIntelSummariesResolverFn: jest.fn(async () => []),
      },
    );

    expect(result.items).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'catalog_serving_index_pipeline_state_query_failed',
        error: 'ips query unavailable',
        fail_open: false,
      }),
      expect.any(String),
    );
  });

  test('catalog serving local eligible-only search carries IPS eligibility into public docs', async () => {
    const { searchCatalogServingIndex } = require('../../src/services/catalogServingIndex');
    const fetchBackfillProductsFn = jest.fn(async () => [
      {
        merchant_id: 'external_seed',
        product_id: 'prod_a',
        source_kind: 'external_seed',
        product: {
          product_id: 'prod_a',
          title: 'Eligible Only Serum',
          brand: 'Example Beauty',
          category: 'Serum',
          canonical_url: 'https://example.test/products/eligible-only-serum',
          image_url: 'https://example.test/eligible-only-serum.jpg',
          price: 24,
        },
        source_meta: { market: 'US' },
      },
    ]);
    const queryFn = jest.fn(async () => ({
      rows: [{ merchant_id: 'external_seed', source_product_id: 'prod_a' }],
    }));

    const result = await searchCatalogServingIndex(
      { query_text: 'eligible serum', local_scan_limit: 50, market: 'US' },
      {
        env: { DATABASE_URL: 'postgres://example/test' },
        allowLocalShadow: true,
        servingEligibleOnly: true,
        fetchBackfillProductsFn,
        queryFn,
        identityRowsResolverFn: jest.fn(async () => [
          {
            source_listing_ref: 'external_seed:prod_a',
            sellable_item_group_id: 'sig_prod_a',
            product_line_id: 'pl_prod_a',
            review_family_id: 'rf_prod_a',
            identity_status: 'approved',
            live_read_enabled: true,
            review_required: false,
          },
        ]),
        productIntelSummariesResolverFn: jest.fn(async () => new Map()),
      },
    );

    expect(result.source).toBe('local_shadow');
    expect(result.items).toEqual([
      expect.objectContaining({
        sellable_item_group_id: 'sig_prod_a',
        title: 'Eligible Only Serum',
        publish_state: 'public',
      }),
    ]);
  });

  test('catalog serving public docs require serving_eligible by default', () => {
    const { _internals } = require('../../src/services/catalogServingIndex');

    const entries = _internals.buildCatalogServingBackfillEntries(
      [
        {
          merchant_id: 'merchant_a',
          product_id: 'prod_a',
          serving_eligible: false,
          product: {
            merchant_id: 'merchant_a',
            product_id: 'prod_a',
            title: 'Approved but not eligible',
          },
        },
      ],
      {
        identityRows: [
          {
            source_listing_ref: 'merchant_a:prod_a',
            identity_status: 'approved',
            live_read_enabled: true,
          },
        ],
      },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        serving_eligible: false,
        is_public: false,
      }),
    );
  });

  test('brand commerce-index flow still requests attached external-seed fallback', async () => {
    resetTestEnv({ BRAND_PAGE_USES_COMMERCE_INDEX: 'true' });
    const { _internals } = require('../../src/services/discoveryFeed');
    const fetchExternalCandidatesFn = jest.fn(async ({ includeAttached }) =>
      includeAttached
        ? [
            {
              merchant_id: 'external_seed',
              product_id: 'ext_fenty_seed',
              id: 'ext_fenty_seed',
              title: 'Fenty Seed Product',
            },
          ]
        : [],
    );

    const result = await _internals.loadBrandScopedDirectCandidates({
      request: { query: 'Fenty' },
      brandAliases: ['Fenty'],
      limit: 24,
      fetchInternalCandidatesFn: jest.fn(async () => []),
      fetchExternalCandidatesFn,
    });

    expect(fetchExternalCandidatesFn).toHaveBeenCalledWith(
      expect.objectContaining({ includeAttached: true }),
    );
    expect(result.products).toHaveLength(1);
    expect(result.products[0].product_id).toBe('ext_fenty_seed');
  });
});
