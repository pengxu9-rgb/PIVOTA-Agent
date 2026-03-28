process.env.PIVOTA_API_BASE = 'http://pivota.test';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.API_MODE = 'REAL';

const request = require('supertest');
const nock = require('nock');

describe('/agent/shop/v1/invoke find_products_multi strict surfaces', () => {
  let prevDatabaseUrl;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    prevDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    nock.enableNetConnect((host) => {
      const value = String(host || '');
      return value.includes('127.0.0.1') || value.includes('localhost') || value === '::1';
    });
  });

  afterEach(() => {
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
    if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDatabaseUrl;
  });

  test('routes explicit agent_api surface to strict shopping invoke', async () => {
    let capturedBody = null;
    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [
            {
              product_id: 'prod_1',
              merchant_id: 'merch_1',
              title: 'The Ordinary Niacinamide 10% + Zinc 1%',
              price: 12.5,
              currency: 'USD',
              in_stock: true,
            },
          ],
          total: 1,
          metadata: {
            query_source: 'cache_multi_intent',
            serving_mode: 'eligible_only',
            catalog_surface: 'agent_api',
            strict_constraint_query: true,
            strict_constraint_reason: 'ingredient',
          },
        };
      })
      ;

    const legacySearch = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .reply(200, { status: 'success', products: [], total: 0 });

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

    expect(strictInvoke.isDone()).toBe(true);
    expect(legacySearch.isDone()).toBe(false);
    expect(capturedBody).toEqual(
      expect.objectContaining({
        operation: 'find_products_multi',
        metadata: expect.objectContaining({
          catalog_surface: 'agent_api',
          commerce_surface: 'agent_api',
        }),
      }),
    );
    expect(capturedBody?.payload?.search).toEqual(
      expect.objectContaining({
        catalog_surface: 'agent_api',
        commerce_surface: 'agent_api',
        limit: 10,
      }),
    );
    expect(String(capturedBody?.payload?.search?.query || '')).toContain('niacinamide serum');
    expect(capturedBody?.payload?.search?.request_context).toEqual(
      expect.objectContaining({
        channel: 'shopping_agent',
        request_id: expect.any(String),
      }),
    );
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'prod_1',
        merchant_id: 'merch_1',
      }),
    );
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        serving_mode: 'eligible_only',
        strict_constraint_query: true,
        strict_constraint_reason: 'ingredient',
        contract_bridge: expect.objectContaining({
          resolved_contract: 'shop_invoke_strict',
          legacy_fallback: false,
        }),
      }),
    );
  });

  test('keeps strict empty responses off legacy search fallback paths', async () => {
    let capturedBody = null;
    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [],
          total: 0,
          metadata: {
            query_source: 'cache_multi_intent',
            serving_mode: 'eligible_only',
            ingredient_intents: ['ascorbic_acid'],
            strict_constraint_query: true,
            strict_constraint_reason: 'multi_constraint',
          },
        };
      })
      ;

    const legacySearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .reply(200, {
        status: 'success',
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

    expect(strictInvoke.isDone()).toBe(true);
    expect(legacySearch.isDone()).toBe(false);
    expect(capturedBody).toEqual(
      expect.objectContaining({
        operation: 'find_products_multi',
        metadata: expect.objectContaining({
          catalog_surface: 'agent_api',
          commerce_surface: 'agent_api',
        }),
      }),
    );
    expect(capturedBody?.payload?.search).toEqual(
      expect.objectContaining({
        catalog_surface: 'agent_api',
        commerce_surface: 'agent_api',
        limit: 10,
      }),
    );
    expect(String(capturedBody?.payload?.search?.query || '')).toContain('vitamin c serum under €30');
    expect(capturedBody?.payload?.search?.request_context).toEqual(
      expect.objectContaining({
        channel: 'shopping_agent',
        request_id: expect.any(String),
      }),
    );
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(0);
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'cache_multi_intent',
        serving_mode: 'eligible_only',
        ingredient_intents: ['ascorbic_acid'],
        strict_constraint_query: true,
        strict_constraint_reason: 'multi_constraint',
        contract_bridge: expect.objectContaining({
          resolved_contract: 'shop_invoke_strict',
          legacy_fallback: false,
        }),
      }),
    );
  });

  test('preserves eur budget fx metadata on strict non-empty responses without fallback', async () => {
    let capturedBody = null;
    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [
            {
              product_id: 'vitc_1',
              merchant_id: 'merch_vitc',
              title: 'Vitamin-C Serum',
              price: 24.5,
              currency: 'USD',
              in_stock: true,
            },
          ],
          total: 1,
          metadata: {
            query_source: 'agent_products_search',
            serving_mode: 'eligible_only',
            strict_constraint_query: true,
            strict_constraint_reason: 'multi_constraint',
            budget_fx_applied: true,
            budget_fx_rate: 1.09,
            budget_fx_source: 'fx_table',
            budget_fx_candidate_currency: 'USD',
            budget_fx_unresolved: false,
            route_health: {
              fallback_triggered: false,
              primary_path_used: 'agent_products_search',
            },
          },
        };
      });

    const legacySearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .reply(200, {
        status: 'success',
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

    expect(strictInvoke.isDone()).toBe(true);
    expect(legacySearch.isDone()).toBe(false);
    expect(String(capturedBody?.payload?.search?.query || '')).toContain('vitamin c serum under €30');
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'vitc_1',
        merchant_id: 'merch_vitc',
        title: 'Vitamin-C Serum',
      }),
    );
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_search',
        strict_constraint_query: true,
        strict_constraint_reason: 'multi_constraint',
        budget_fx_applied: true,
        budget_fx_rate: 1.09,
        budget_fx_source: 'fx_table',
        budget_fx_candidate_currency: 'USD',
        budget_fx_unresolved: false,
        route_health: expect.objectContaining({
          fallback_triggered: false,
        }),
        contract_bridge: expect.objectContaining({
          resolved_contract: 'shop_invoke_strict',
          legacy_fallback: false,
        }),
      }),
    );
  });

  test('defaults beauty shade queries to strict shopping invoke without explicit surface', async () => {
    let capturedBody = null;
    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [],
          total: 0,
          metadata: {
            query_source: 'cache_multi_intent',
            serving_mode: 'eligible_only',
            visible_option_intents: ['shade_210'],
            strict_constraint_query: true,
            strict_constraint_reason: 'shade',
          },
        };
      });

    const legacySearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .reply(200, {
        status: 'success',
        products: [
          {
            id: 'legacy_foundation',
            merchant_id: 'legacy_m',
            title: 'Legacy Foundation 210',
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
            query: 'foundation shade 210',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    expect(strictInvoke.isDone()).toBe(true);
    expect(legacySearch.isDone()).toBe(false);
    expect(capturedBody?.payload?.search).toEqual(
      expect.objectContaining({
        query: 'foundation shade 210',
        catalog_surface: 'agent_api',
        commerce_surface: 'agent_api',
        limit: 10,
      }),
    );
    expect(res.body.products).toEqual([]);
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        serving_mode: 'eligible_only',
        visible_option_intents: ['shade_210'],
        strict_constraint_query: true,
        strict_constraint_reason: 'shade',
        contract_bridge: expect.objectContaining({
          resolved_contract: 'shop_invoke_strict',
          legacy_fallback: false,
        }),
      }),
    );
  });

  test('prefetches external seed candidates for strict ingredient queries and forwards them to shopping invoke', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    let capturedPrefetchSql = null;
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        capturedPrefetchSql = text;
        return {
          rows: [
            {
              id: 'seed_fenty_refill',
              market: 'US',
              tool: '*',
              destination_url:
                'https://fentybeauty.com/en-nl/products/watch-ya-tone-niacinamide-dark-spot-serum-refill?variant=40839564427309',
              canonical_url:
                'https://fentybeauty.com/en-nl/products/watch-ya-tone-niacinamide-dark-spot-serum-refill?variant=40839564427309',
              domain: 'fentybeauty.com',
              title: 'Watch Ya Tone Niacinamide Dark Spot Serum Refill',
              image_url: 'https://cdn.example/fenty-serum.jpg',
              price_amount: 22,
              price_currency: 'USD',
              availability: 'in_stock',
              seed_data: {
                title: 'Watch Ya Tone Niacinamide Dark Spot Serum Refill',
                description: 'External reviewed niacinamide serum refill.',
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
            },
          ],
        };
      },
    }));

    let capturedBody = null;
    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [],
          total: 0,
          metadata: {
            query_source: 'cache_multi_intent',
            serving_mode: 'eligible_only',
            ingredient_intents: ['niacinamide'],
            strict_constraint_query: true,
            strict_constraint_reason: 'ingredient',
          },
        };
      });

    const app = require('../../src/server');
    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'niacinamide serum',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    expect(strictInvoke.isDone()).toBe(true);
    expect(capturedBody?.metadata).toEqual(
      expect.objectContaining({
        catalog_surface: 'agent_api',
        commerce_surface: 'agent_api',
        external_seed_prefetch_source: 'agent_strict_ingredient_prefetch',
        external_seed_candidates: expect.any(Array),
      }),
    );
    expect(capturedBody?.metadata?.external_seed_candidates).toHaveLength(1);
    expect(capturedBody?.metadata?.external_seed_candidates?.[0]).toEqual(
      expect.objectContaining({
        source: 'external_seed',
        product_type: 'Serum',
        ingredient_ids: ['niacinamide'],
        external_seed_id: 'seed_fenty_refill',
      }),
    );
    expect(capturedPrefetchSql).toContain("reviewed_ingredient_ids");
    expect(capturedPrefetchSql).toContain("ingredient_ids");
  });

  test('strict external seed prefetch SQL requires structured ingredient evidence before sampling candidate rows', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    let capturedSql = '';
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        capturedSql = text;
        if (!text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    }));

    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        metadata: {
          query_source: 'cache_multi_intent',
          serving_mode: 'eligible_only',
          ingredient_intents: ['hyaluronic_acid'],
          strict_constraint_query: true,
          strict_constraint_reason: 'ingredient',
        },
      });

    const app = require('../../src/server');
    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'hyaluronic serum',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    expect(strictInvoke.isDone()).toBe(true);
    expect(capturedSql).toContain("seed_data, '{}'::jsonb)->'reviewed_ingredient_ids'");
    expect(capturedSql).toContain("seed_data, '{}'::jsonb)->'ingredient_ids'");
    expect(capturedSql).toContain("seed_data, '{}'::jsonb)->'snapshot'->'reviewed_ingredient_ids'");
    expect(capturedSql).toContain("seed_data, '{}'::jsonb)->'snapshot'->'ingredient_ids'");
  });

  test('prefetches hyaluronic strict candidates when reviewed external seed evidence exists', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: 'seed_hyaluronic_serum',
              market: 'US',
              tool: '*',
              destination_url:
                'https://theordinary.com/en-us/hyaluronic-acid-2-b5-serum-with-ceramides-100637.html',
              canonical_url:
                'https://theordinary.com/en-us/hyaluronic-acid-2-b5-serum-with-ceramides-100637.html',
              domain: 'theordinary.com',
              title: 'Hyaluronic Acid 2% + B5 (with Ceramides)',
              image_url: 'https://cdn.example/hyaluronic-serum.jpg',
              price_amount: 14,
              price_currency: 'USD',
              availability: 'in_stock',
              seed_data: {
                title: 'Hyaluronic Acid 2% + B5 (with Ceramides)',
                description: 'Reviewed hyaluronic serum external seed.',
                category: 'Serum',
                brand: 'The Ordinary',
                reviewed_ingredient_ids: ['hyaluronic_acid', 'panthenol', 'glycerin'],
                variants: [
                  {
                    id: 'seed_variant_default',
                    title: 'Default Title',
                    price: 14,
                    availability: 'in_stock',
                  },
                ],
              },
              status: 'active',
              attached_product_key: null,
              created_at: '2026-03-25T00:00:00Z',
              updated_at: '2026-03-25T00:00:00Z',
            },
          ],
        };
      },
    }));

    let capturedBody = null;
    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [],
          total: 0,
          metadata: {
            query_source: 'cache_multi_intent',
            serving_mode: 'eligible_only',
            ingredient_intents: ['hyaluronic_acid'],
            strict_constraint_query: true,
            strict_constraint_reason: 'ingredient',
          },
        };
      });

    const app = require('../../src/server');
    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'hyaluronic serum',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    expect(strictInvoke.isDone()).toBe(true);
    expect(capturedBody?.metadata?.external_seed_prefetch_source).toBe(
      'agent_strict_ingredient_prefetch',
    );
    expect(capturedBody?.metadata?.external_seed_candidates).toHaveLength(1);
    expect(capturedBody?.metadata?.external_seed_candidates?.[0]).toEqual(
      expect.objectContaining({
        source: 'external_seed',
        title: 'Hyaluronic Acid 2% + B5 (with Ceramides)',
        ingredient_ids: expect.arrayContaining(['hyaluronic_acid']),
        external_seed_id: 'seed_hyaluronic_serum',
      }),
    );
  });

  test('treats hyaluronic serum as a strict ingredient query', async () => {
    let capturedBody = null;
    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [],
          total: 0,
          metadata: {
            query_source: 'cache_multi_intent',
            serving_mode: 'eligible_only',
            ingredient_intents: ['hyaluronic_acid'],
            strict_constraint_query: true,
            strict_constraint_reason: 'ingredient',
          },
        };
      });

    const app = require('../../src/server');
    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'hyaluronic serum',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    expect(strictInvoke.isDone()).toBe(true);
    expect(capturedBody?.payload?.search).toEqual(
      expect.objectContaining({
        query: 'hyaluronic serum',
        catalog_surface: 'agent_api',
        commerce_surface: 'agent_api',
      }),
    );
  });

  test('prefetches hyaluronic strict candidates with inferred serum category from canonical url', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: 'seed_hyaluronic_serum',
              market: 'US',
              tool: '*',
              destination_url:
                'https://theordinary.com/en-us/hyaluronic-acid-2-b5-serum-with-ceramides-100637.html',
              canonical_url:
                'https://theordinary.com/en-us/hyaluronic-acid-2-b5-serum-with-ceramides-100637.html',
              domain: 'theordinary.com',
              title: 'Hyaluronic Acid 2% + B5 (with Ceramides)',
              image_url: 'https://cdn.example/hyaluronic-serum.jpg',
              price_amount: 14,
              price_currency: 'USD',
              availability: 'in_stock',
              seed_data: {
                title: 'Hyaluronic Acid 2% + B5 (with Ceramides)',
                description: 'Reviewed hyaluronic external seed.',
                brand: 'The Ordinary',
                reviewed_ingredient_ids: ['hyaluronic_acid', 'panthenol', 'glycerin'],
                variants: [
                  {
                    id: 'seed_variant_default',
                    title: 'Default Title',
                    price: 14,
                    availability: 'in_stock',
                  },
                ],
              },
              status: 'active',
              attached_product_key: null,
              created_at: '2026-03-25T00:00:00Z',
              updated_at: '2026-03-25T00:00:00Z',
            },
          ],
        };
      },
    }));

    let capturedBody = null;
    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [],
          total: 0,
          metadata: {
            query_source: 'cache_multi_intent',
            serving_mode: 'eligible_only',
            ingredient_intents: ['hyaluronic_acid'],
            strict_constraint_query: true,
            strict_constraint_reason: 'ingredient',
          },
        };
      });

    const app = require('../../src/server');
    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'hyaluronic serum',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    expect(strictInvoke.isDone()).toBe(true);
    expect(capturedBody?.metadata?.external_seed_candidates).toHaveLength(1);
    expect(capturedBody?.metadata?.external_seed_candidates?.[0]).toEqual(
      expect.objectContaining({
        title: 'Hyaluronic Acid 2% + B5 (with Ceramides)',
        category: 'Serum',
        product_type: 'Serum',
        ingredient_ids: expect.arrayContaining(['hyaluronic_acid']),
        external_seed_id: 'seed_hyaluronic_serum',
      }),
    );
  });

  test('treats peptide serum as a strict ingredient query', async () => {
    let capturedBody = null;
    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [],
          total: 0,
          metadata: {
            query_source: 'cache_multi_intent',
            serving_mode: 'eligible_only',
            ingredient_intents: ['peptides'],
            strict_constraint_query: true,
            strict_constraint_reason: 'ingredient',
          },
        };
      });

    const app = require('../../src/server');
    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'peptide serum',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    expect(strictInvoke.isDone()).toBe(true);
    expect(capturedBody?.payload?.search).toEqual(
      expect.objectContaining({
        query: 'peptide serum',
        catalog_surface: 'agent_api',
        commerce_surface: 'agent_api',
      }),
    );
  });

  test('treats salicylic serum as a strict ingredient query', async () => {
    let capturedBody = null;
    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [],
          total: 0,
          metadata: {
            query_source: 'cache_multi_intent',
            serving_mode: 'eligible_only',
            ingredient_intents: ['salicylic_acid'],
            strict_constraint_query: true,
            strict_constraint_reason: 'ingredient',
          },
        };
      });

    const app = require('../../src/server');
    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'salicylic serum',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    expect(strictInvoke.isDone()).toBe(true);
    expect(capturedBody?.payload?.search).toEqual(
      expect.objectContaining({
        query: 'salicylic serum',
        catalog_surface: 'agent_api',
        commerce_surface: 'agent_api',
      }),
    );
  });

  test('prefetches strong active solution candidates for salicylic serum queries', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: 'seed_salicylic_solution',
              market: 'US',
              tool: '*',
              destination_url:
                'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
              canonical_url:
                'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
              domain: 'theordinary.com',
              title: 'Salicylic Acid 2% Solution',
              image_url: 'https://cdn.example/salicylic.jpg',
              price_amount: 18,
              price_currency: 'USD',
              availability: 'in_stock',
              seed_data: {
                title: 'Salicylic Acid 2% Solution',
                description: 'Leave-on salicylic acid treatment for blemish-prone skin.',
                reviewed_ingredient_ids: ['Salicylic Acid'],
                variants: [
                  {
                    id: 'seed_variant_default',
                    title: 'Default Title',
                    price: 18,
                    availability: 'in_stock',
                  },
                ],
              },
              status: 'active',
              attached_product_key: null,
              created_at: '2026-03-25T00:00:00Z',
              updated_at: '2026-03-25T00:00:00Z',
            },
          ],
        };
      },
    }));

    let capturedBody = null;
    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [],
          total: 0,
          metadata: {
            query_source: 'cache_multi_intent',
            serving_mode: 'eligible_only',
            ingredient_intents: ['salicylic_acid'],
            strict_constraint_query: true,
            strict_constraint_reason: 'ingredient',
          },
        };
      });

    const app = require('../../src/server');
    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'salicylic acid serum',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    expect(strictInvoke.isDone()).toBe(true);
    expect(capturedBody?.metadata?.external_seed_candidates).toHaveLength(1);
    expect(capturedBody?.metadata?.external_seed_candidates?.[0]).toEqual(
      expect.objectContaining({
        source: 'external_seed',
        product_type: 'Serum',
        category: 'Serum',
        ingredient_ids: ['salicylic_acid'],
        external_seed_id: 'seed_salicylic_solution',
      }),
    );
  });

  test('filters prefetched external seed candidates that lack target surface anchors', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: 'seed_bad_hyaluronic',
              market: 'US',
              tool: '*',
              destination_url: 'https://ole.example/products/banana-bright-vitamin-c-serum',
              canonical_url: 'https://ole.example/products/banana-bright-vitamin-c-serum',
              domain: 'ole.example',
              title: 'Banana Bright 15% Vitamin C Dark Spot Serum',
              image_url: 'https://cdn.example/banana-bright.jpg',
              price_amount: 70,
              price_currency: 'USD',
              availability: 'in_stock',
              seed_data: {
                title: 'Banana Bright 15% Vitamin C Dark Spot Serum',
                description: 'Seed contains hyaluronic acid in reviewed ingredients but no target title anchor.',
                category: 'Serum',
                reviewed_ingredient_ids: ['ascorbic_acid', 'hyaluronic_acid'],
                variants: [],
              },
              status: 'active',
              attached_product_key: null,
              created_at: '2026-03-24T00:00:00Z',
              updated_at: '2026-03-24T00:00:00Z',
            },
          ],
        };
      },
    }));

    let capturedBody = null;
    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [],
          total: 0,
          metadata: {
            query_source: 'cache_multi_intent',
            serving_mode: 'eligible_only',
            ingredient_intents: ['hyaluronic_acid'],
            strict_constraint_query: true,
            strict_constraint_reason: 'ingredient',
          },
        };
      });

    const app = require('../../src/server');
    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'hyaluronic acid serum',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    expect(strictInvoke.isDone()).toBe(true);
    expect(capturedBody?.metadata?.external_seed_candidates).toBeUndefined();
    expect(capturedBody?.metadata?.external_seed_prefetch_source).toBeUndefined();
  });
});
