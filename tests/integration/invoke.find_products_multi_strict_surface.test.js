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

  test('routes explicit agent_api surface to strict shopping invoke without accepting cache-stage results', async () => {
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
    expect(res.body.products).toHaveLength(0);
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_error_fallback',
        serving_mode: 'eligible_only',
        strict_constraint_query: true,
        strict_constraint_reason: 'ingredient',
        shopping_mainline_cache_blocked: true,
        contract_bridge: expect.objectContaining({
          resolved_contract: 'shop_invoke_strict',
          legacy_fallback: false,
        }),
      }),
    );
  });

  test('strict surfaces skip resolver-first and keep strict invoke as sole owner', async () => {
    const prevResolverFirstEnabled = process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
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

    const queryText = 'The Ordinary Niacinamide 10% + Zinc 1%';

    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'prod_strict_1',
            merchant_id: 'merch_strict_1',
            title: queryText,
            price: 18,
            currency: 'USD',
            in_stock: true,
          },
        ],
        total: 1,
        metadata: {
          query_source: 'agent_products_search',
          serving_mode: 'eligible_only',
          strict_constraint_query: true,
          strict_constraint_reason: 'agent_api_surface',
        },
      });

    const legacySearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .reply(200, {
        status: 'success',
        products: [
          {
            id: 'legacy_1',
            merchant_id: 'legacy_m',
            title: 'Legacy Serum',
          },
        ],
        total: 1,
      });

    try {
      const app = require('../../src/server');
      const res = await request(app)
        .post('/agent/shop/v1/invoke')
        .send({
          operation: 'find_products_multi',
          payload: {
            search: {
              query: queryText,
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
      expect(resolveProductRef).not.toHaveBeenCalled();
      expect(res.body.metadata).toEqual(
        expect.objectContaining({
          contract_bridge: expect.objectContaining({
            resolved_contract: 'shop_invoke_strict',
            legacy_fallback: false,
          }),
          gate_trace: expect.arrayContaining([
            expect.objectContaining({
              gate_id: 'resolver_first',
              applied: false,
              reason: 'strict_main_path',
            }),
          ]),
        }),
      );
    } finally {
      if (prevResolverFirstEnabled === undefined) delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
      else process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = prevResolverFirstEnabled;
    }
  });

  test('strict surfaces rescue raw exact-title external-seed matches before clarify finalizes', async () => {
    process.env.DATABASE_URL = 'postgres://strict-exact-title-rescue';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (!text.includes('external_seed_exact_title_recall')) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: 'seed_multicalm_exact',
              external_product_id: 'ext_multicalm_exact',
              destination_url: 'https://seed.example.com/products/multi-calm-cream-cleanser',
              canonical_url: 'https://seed.example.com/products/multi-calm-cream-cleanser',
              domain: 'seed.example.com',
              title: 'Multi-Calm Cream Cleanser',
              image_url: 'https://cdn.example.com/multi-calm.jpg',
              price_amount: '29',
              price_currency: 'USD',
              availability: 'in stock',
              seed_data: {
                brand: 'Seed Beauty',
                snapshot: {
                  title: 'Multi-Calm Cream Cleanser',
                  brand: 'Seed Beauty',
                  destination_url: 'https://seed.example.com/products/multi-calm-cream-cleanser',
                  canonical_url: 'https://seed.example.com/products/multi-calm-cream-cleanser',
                },
              },
              updated_at: '2025-01-01T00:00:00.000Z',
              created_at: '2025-01-01T00:00:00.000Z',
            },
          ],
        };
      }),
    }));

    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        clarification: {
          question: 'Which cleanser format do you want?',
        },
        metadata: {
          query_source: 'agent_products_recall_clarify',
          strict_constraint_query: true,
          strict_constraint_reason: 'agent_api_surface',
        },
      });

    const app = require('../../src/server');
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'Multi-Calm Cream Cleanser',
            limit: 10,
            page: 1,
            in_stock_only: true,
            allow_external_seed: true,
            allow_stale_cache: false,
            external_seed_strategy: 'unified_relevance',
            catalog_surface: 'agent_api',
            commerce_surface: 'agent_api',
          },
        },
        metadata: {
          source: 'shopping_agent',
          catalog_surface: 'agent_api',
          commerce_surface: 'agent_api',
        },
      })
      .expect(200);

    expect(strictInvoke.isDone()).toBe(true);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'ext_multicalm_exact',
        merchant_id: 'external_seed',
        title: 'Multi-Calm Cream Cleanser',
      }),
    );
    expect(res.body.clarification).toBeUndefined();
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_search_exact_title_supplemented',
        shopping_exact_title_external_seed_applied: true,
        shopping_exact_title_external_seed_match_count: 1,
        contract_bridge: expect.objectContaining({
          resolved_contract: 'shop_invoke_strict',
          legacy_fallback: false,
        }),
      }),
    );
  });

  test('blocks strict cache-stage empty responses instead of treating them as mainline success', async () => {
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
        query_source: 'agent_products_error_fallback',
        serving_mode: 'eligible_only',
        ingredient_intents: ['ascorbic_acid'],
        strict_constraint_query: true,
        strict_constraint_reason: 'multi_constraint',
        strict_empty: true,
        shopping_mainline_cache_blocked: true,
        contract_bridge: expect.objectContaining({
          resolved_contract: 'shop_invoke_strict',
          legacy_fallback: false,
        }),
      }),
    );
  });

  test('strict surface exceptions do not invoke resolver fallback', async () => {
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

    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(502, {
        detail: 'upstream exploded',
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
            query: 'vitamin c serum',
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
    expect(resolveProductRef).not.toHaveBeenCalled();
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(0);
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_error_fallback',
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

  test('blocks strict cache-stage external seed responses instead of accepting them as success', async () => {
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
              product_id: 'seed_vitc_1',
              merchant_id: 'external_seed',
              source: 'external_seed',
              platform: 'external',
              external_seed_id: 'seed_vitc_1',
              title: 'Vitamin-C Serum',
              price: 24.5,
              currency: 'USD',
              in_stock: true,
              url: 'https://example.com/products/vitamin-c-serum',
            },
          ],
          total: 1,
          metadata: {
            query_source: 'cache_multi_intent',
            serving_mode: 'eligible_only',
            strict_constraint_query: true,
            strict_constraint_reason: 'multi_constraint',
            budget_fx_applied: true,
            budget_fx_rate: 0.9174311926605504,
            budget_fx_source: 'static_default',
            budget_fx_candidate_currency: 'USD',
            budget_fx_unresolved: false,
            external_seed_returned_count: 1,
            source_breakdown: {
              external_seed_count: 1,
            },
            route_health: {
              fallback_triggered: false,
              primary_path_used: 'cache_multi_intent',
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
    expect(res.body.total).toBe(0);
    expect(res.body.products).toHaveLength(0);
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_error_fallback',
        strict_constraint_query: true,
        strict_constraint_reason: 'multi_constraint',
        budget_fx_applied: true,
        budget_fx_candidate_currency: 'USD',
        budget_fx_unresolved: false,
        shopping_mainline_cache_blocked: true,
        route_health: expect.objectContaining({
          fallback_triggered: true,
        }),
        contract_bridge: expect.objectContaining({
          resolved_contract: 'shop_invoke_strict',
          legacy_fallback: false,
        }),
      }),
    );
    expect(Number(res.body.metadata?.budget_fx_rate || 0)).toBeGreaterThan(0);
    expect(['static_default', 'strict_request_context']).toContain(
      String(res.body.metadata?.budget_fx_source || ''),
    );
  });

  test('shopping strict budget queries do not recover from prefetched external seeds on the main path', async () => {
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
              id: 'seed_vitc_recover',
              market: 'US',
              tool: '*',
              destination_url: 'https://example.com/products/vitamin-c-serum',
              canonical_url: 'https://example.com/products/vitamin-c-serum',
              domain: 'example.com',
              title: 'Vitamin-C Serum',
              image_url: 'https://cdn.example/vitamin-c-serum.jpg',
              price_amount: 24.5,
              price_currency: 'USD',
              availability: 'in_stock',
              seed_data: {
                title: 'Vitamin-C Serum',
                description: 'Reviewed vitamin c serum external seed.',
                category: 'Serum',
                brand: 'Example Brand',
                reviewed_ingredient_ids: ['ascorbic_acid'],
                variants: [
                  {
                    id: 'seed_variant_default',
                    title: 'Default Title',
                    price: 24.5,
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
          ingredient_intents: ['ascorbic_acid'],
          strict_constraint_query: true,
          strict_constraint_reason: 'multi_constraint',
          strict_empty: true,
          strict_empty_reason: 'cache_miss_strict_empty',
          route_health: {
            fallback_triggered: false,
            primary_path_used: 'cache_multi_intent',
          },
          search_trace: {
            final_decision: 'strict_empty',
          },
        },
      });

    const legacySearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .reply(200, {
        status: 'success',
        products: [{ id: 'legacy_1', merchant_id: 'legacy_m', title: 'Legacy Vitamin C Serum' }],
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
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(0);
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_error_fallback',
        strict_constraint_query: true,
        strict_constraint_reason: 'multi_constraint',
        ingredient_intents: ['ascorbic_acid'],
        budget_fx_applied: true,
        budget_fx_source: expect.any(String),
        budget_fx_candidate_currency: 'USD',
        budget_fx_unresolved: false,
        service_version: expect.objectContaining({
          commit: expect.any(String),
        }),
        route_trace: expect.objectContaining({
          authoritative_endpoint: '/agent/shop/v1/invoke',
        }),
        route_health: expect.objectContaining({
          fallback_triggered: true,
        }),
        search_trace: expect.objectContaining({
          final_decision: expect.any(String),
        }),
        contract_bridge: expect.objectContaining({
          resolved_contract: 'shop_invoke_strict',
          legacy_fallback: false,
        }),
      }),
    );
    expect(res.body.metadata?.strict_prefetch_recovered).not.toBe(true);
    expect(res.body.metadata?.strict_prefetch_recovery_source).toBeUndefined();
    expect(res.body.metadata?.matched_ingredient_ids || []).toEqual([]);
  });

  test('defaults beauty shade queries to strict shopping invoke without accepting cache mainline results', async () => {
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
        query_source: 'agent_products_error_fallback',
        serving_mode: 'eligible_only',
        visible_option_intents: ['shade_210'],
        strict_constraint_query: true,
        strict_constraint_reason: 'shade',
        strict_empty: true,
        contract_bridge: expect.objectContaining({
          resolved_contract: 'shop_invoke_strict',
          legacy_fallback: false,
        }),
        route_health: expect.objectContaining({
          fallback_triggered: true,
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

  test('shopping strict ingredient invoke does not recover soft fallback into prefetched seed results', async () => {
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
              id: 'seed_fenty_watch_ya_tone',
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
            },
          ],
        };
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
          query_source: 'agent_products_error_fallback',
          source_breakdown: {
            internal_count: 0,
            external_seed_count: 0,
          },
          route_health: {
            fallback_triggered: true,
            primary_path_used: 'upstream_stage',
            fallback_reason: 'error_soft_fallback',
          },
        },
      });

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
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    expect(strictInvoke.isDone()).toBe(true);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(0);
    expect(res.body.metadata?.query_source).toBe('agent_products_error_fallback');
    expect(res.body.metadata?.strict_constraint_query).toBe(true);
    expect(res.body.metadata?.strict_constraint_reason).toBe('ingredient');
    expect(res.body.metadata?.strict_prefetch_recovered).not.toBe(true);
    expect(res.body.metadata?.strict_prefetch_recovery_source).toBeUndefined();
    expect(res.body.metadata?.ingredient_intents).toEqual(['niacinamide']);
    expect(res.body.metadata?.matched_ingredient_ids || []).toEqual([]);
    expect(res.body.metadata?.contract_bridge).toEqual(
      expect.objectContaining({
        resolved_contract: 'shop_invoke_strict',
        legacy_fallback: false,
      }),
    );
    expect(res.body.metadata?.route_health).toEqual(
      expect.objectContaining({
        fallback_triggered: true,
      }),
    );
    expect(res.body.metadata?.search_trace).toEqual(expect.objectContaining({}));
    expect(res.body.metadata?.service_version).toEqual(
      expect.objectContaining({
        commit: expect.any(String),
      }),
    );
  });

  test('shopping strict cache success responses are blocked instead of being cleaned into success', async () => {
    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'prod_watch_ya_tone',
            product_id: 'prod_watch_ya_tone',
            merchant_id: 'merch_skin',
            title: 'Watch Ya Tone Niacinamide Dark Spot Serum',
            source: 'shopify',
          },
          {
            id: 'prod_ordinary',
            product_id: 'prod_ordinary',
            merchant_id: 'merch_skin',
            title: 'The Ordinary Niacinamide 10% + Zinc 1%',
            source: 'shopify',
          },
        ],
        total: 2,
        metadata: {
          query_source: 'cache_multi_intent',
          upstream_status: 200,
          strict_constraint_query: true,
          strict_constraint_reason: 'ingredient',
          ingredient_intents: ['niacinamide'],
          matched_ingredient_ids: ['niacinamide'],
          proxy_search_fallback: {
            applied: true,
            reason: null,
          },
          route_health: {
            fallback_triggered: true,
            fallback_reason: null,
            primary_path_used: 'cache_stage',
          },
          search_trace: {
            final_decision: 'cache_returned',
            fallback_reason: null,
            primary_path_used: 'cache_stage',
          },
          search_decision: {
            final_decision: 'cache_returned',
            fallback_reason: null,
            primary_path_used: 'cache_stage',
          },
        },
      });

    const app = require('../../src/server');
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'niacinamide serum',
            limit: 5,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      })
      .expect(200);

    expect(strictInvoke.isDone()).toBe(true);
    expect(res.body.products).toHaveLength(0);
    expect(res.body.metadata?.query_source).toBe('agent_products_error_fallback');
    expect(res.body.metadata?.shopping_mainline_cache_blocked).toBe(true);
    expect(res.body.metadata?.proxy_search_fallback).toEqual(
      expect.objectContaining({
        applied: true,
        reason: 'shopping_mainline_cache_blocked',
      }),
    );
    expect(res.body.metadata?.route_health).toEqual(
      expect.objectContaining({
        fallback_triggered: true,
        fallback_reason: 'shopping_mainline_cache_blocked',
      }),
    );
    expect(res.body.metadata?.search_trace).toEqual(
      expect.objectContaining({
        final_decision: 'strict_empty',
      }),
    );
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
