process.env.PIVOTA_API_BASE = 'http://pivota.test';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.API_MODE = 'REAL';

const request = require('supertest');
const nock = require('nock');

const INGREDIENT_DIRECT_QUERY_SOURCE = 'agent_products_ingredient_recall_direct';

function mockDbRows(rows = [], capturedSqlRef = null) {
  jest.doMock('../../src/db', () => ({
    query: jest.fn(async (sql) => {
      const text = String(sql || '');
      if (capturedSqlRef) {
        capturedSqlRef.value = text;
        capturedSqlRef.all = [...(capturedSqlRef.all || []), text];
      }
      if (!text.includes('FROM external_product_seeds')) {
        return { rows: [] };
      }
      return { rows };
    }),
  }));
}

function seedRow(overrides = {}) {
  return {
    id: 'seed_fenty_niacinamide',
    market: 'US',
    tool: '*',
    destination_url:
      'https://fentybeauty.com/products/watch-ya-tone-niacinamide-dark-spot-serum',
    canonical_url:
      'https://fentybeauty.com/products/watch-ya-tone-niacinamide-dark-spot-serum',
    domain: 'fentybeauty.com',
    title: 'Watch Ya Tone Niacinamide Dark Spot Serum',
    image_url: 'https://cdn.example/fenty-watch-ya-tone.jpg',
    price_amount: 22,
    price_currency: 'USD',
    availability: 'in_stock',
    seed_data: {
      title: 'Watch Ya Tone Niacinamide Dark Spot Serum',
      description: 'Reviewed niacinamide serum external seed.',
      category: 'Serum',
      brand: 'Fenty Skin',
      reviewed_ingredient_ids: ['niacinamide'],
      variants: [
        {
          id: 'seed_variant_default',
          title: 'Default Title',
          price: 22,
          availability: 'in_stock',
        },
      ],
    },
    status: 'active',
    attached_product_key: null,
    created_at: '2026-03-23T00:00:00Z',
    updated_at: '2026-03-23T00:00:00Z',
    ...overrides,
  };
}

describe('/agent/shop/v1/invoke find_products_multi strict surfaces', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.dontMock('../../src/db');
    jest.dontMock('../../src/services/productGroundingResolver');
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => {
      const value = String(host || '');
      return value.includes('127.0.0.1') || value.includes('localhost') || value === '::1';
    });

    prevEnv = {
      DATABASE_URL: process.env.DATABASE_URL,
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      API_MODE: process.env.API_MODE,
      PIVOTA_BACKEND_BASE_URL: process.env.PIVOTA_BACKEND_BASE_URL,
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test-token';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://strict-surface-test';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
  });

  afterEach(() => {
    jest.dontMock('../../src/db');
    jest.dontMock('../../src/services/productGroundingResolver');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
    if (!prevEnv) return;
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('strict ingredient queries return external seed hits through one ingredient direct authority', async () => {
    const capturedSql = { value: '', all: [] };
    mockDbRows([seedRow()], capturedSql);

    const legacyInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        metadata: { query_source: 'cache_multi_intent' },
      });

    const app = require('../../src/server');
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'niacinamide serum under €30',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    expect(legacyInvoke.isDone()).toBe(false);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        external_seed_id: 'seed_fenty_niacinamide',
        title: 'Watch Ya Tone Niacinamide Dark Spot Serum',
      }),
    );
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'authoritative_shopping',
        legacy_contract: false,
        query_source: INGREDIENT_DIRECT_QUERY_SOURCE,
        ingredient_direct_resolution_variant: expect.any(String),
        strict_constraint_query: true,
        strict_constraint_reason: expect.stringMatching(/ingredient|multi_constraint/),
        matched_ingredient_ids: expect.arrayContaining(['niacinamide']),
        budget_fx_applied: true,
        budget_fx_rate: expect.any(Number),
        budget_fx_source: expect.any(String),
        budget_fx_candidate_currency: 'USD',
        budget_fx_unresolved: false,
        service_version: expect.objectContaining({
          build_id: expect.any(String),
        }),
        route_health: expect.objectContaining({
          primary_path_used: 'ingredient_recall_direct',
          fallback_triggered: false,
        }),
      }),
    );
    const externalSeedSql = capturedSql.all.find((text) =>
      text.includes('FROM external_product_seeds'),
    );
    expect(externalSeedSql).toContain('reviewed_ingredient_ids');
  });

  test('strict ingredient empty responses stay on ingredient direct authority without fallback', async () => {
    mockDbRows([]);

    const budgetRescueSearch = nock('http://pivota.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'legacy_1',
            merchant_id: 'legacy_m',
            title: 'Legacy Vitamin C Serum',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'vitamin c serum under €30',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    budgetRescueSearch.persist(false);
    expect(res.body.products).toHaveLength(0);
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'authoritative_shopping',
        legacy_contract: false,
        query_source: INGREDIENT_DIRECT_QUERY_SOURCE,
        ingredient_direct_resolution_variant: 'direct_empty',
        strict_empty: true,
        strict_constraint_query: true,
        strict_constraint_reason: expect.stringMatching(/ingredient|multi_constraint/),
        route_health: expect.objectContaining({
          primary_path_used: 'ingredient_recall_direct',
          fallback_triggered: false,
        }),
      }),
    );
    expect(res.body.metadata?.proxy_search_fallback?.applied).not.toBe(true);
  });

  test('strict ingredient authoritative rail skips resolver-first fallback', async () => {
    mockDbRows([]);
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';

    const resolveProductRef = jest.fn().mockResolvedValue({
      resolved: true,
      product_ref: {
        merchant_id: 'resolver_mid',
        product_id: 'resolver_pid',
      },
      confidence: 1,
      reason: 'stable_alias_ref',
      metadata: { latency_ms: 6 },
    });
    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef,
    }));

    const app = require('../../src/server');
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'niacinamide serum',
            limit: 10,
            in_stock_only: true,
            catalog_surface: 'agent_api',
          },
        },
        metadata: {
          source: 'shopping_agent',
          catalog_surface: 'agent_api',
        },
      })
      .expect(200);

    expect(resolveProductRef).not.toHaveBeenCalled();
    expect(res.body.products).toHaveLength(0);
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'authoritative_shopping',
        legacy_contract: false,
        query_source: INGREDIENT_DIRECT_QUERY_SOURCE,
        strict_empty: true,
        route_health: expect.objectContaining({
          fallback_triggered: false,
        }),
      }),
    );
  });
});
