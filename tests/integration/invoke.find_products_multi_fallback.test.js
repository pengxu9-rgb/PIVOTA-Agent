const nock = require('nock');
const request = require('supertest');

describe('/agent/shop/v1/invoke find_products_multi legacy fallback isolation', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.dontMock('../../src/services/productGroundingResolver');
    jest.doMock('../../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => {
      const h = String(host || '');
      return h.includes('127.0.0.1') || h.includes('localhost') || h === '::1';
    });

    prevEnv = {
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      API_MODE: process.env.API_MODE,
      DATABASE_URL: process.env.DATABASE_URL,
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
      PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY:
        process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
      PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED:
        process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED,
      PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED:
        process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED,
      PROXY_SEARCH_INVOKE_FALLBACK_ENABLED: process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED,
      FIND_PRODUCTS_MULTI_EXPANSION_MODE: process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE,
      FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE:
        process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
      STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED:
        process.env.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED,
      UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT:
        process.env.UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT,
      FIND_PRODUCTS_MULTI_UPSTREAM_LOOKUP_TIMEOUT_MS:
        process.env.FIND_PRODUCTS_MULTI_UPSTREAM_LOOKUP_TIMEOUT_MS,
      FIND_PRODUCTS_MULTI_UPSTREAM_DEFAULT_TIMEOUT_MS:
        process.env.FIND_PRODUCTS_MULTI_UPSTREAM_DEFAULT_TIMEOUT_MS,
      UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS:
        process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'true';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'true';
    process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE = 'off';
    process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE = 'off';
    process.env.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED = 'false';
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    jest.dontMock('../../src/services/productGroundingResolver');
    jest.resetModules();

    if (!prevEnv) return;
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('creator_agent beauty mainline invoke no longer enters resolver-first owner switch by default', async () => {
    const queryText = 'ipsa';
    const productId = '9886500127048';
    const merchantId = 'merch_efbc46b4619cfbdf';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';

    const resolveProductRef = jest.fn().mockResolvedValue({
      resolved: true,
      product_ref: {
        merchant_id: 'resolver_merch_should_not_run',
        product_id: 'resolver_prod_should_not_run',
      },
      confidence: 0.99,
      reason: 'stable_alias_ref',
      metadata: { latency_ms: 10 },
    });
    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef,
    }));

    const primaryScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            merchant_id: merchantId,
            product_id: productId,
            title: 'IPSA Time Reset Aqua',
          },
        ],
        total: 1,
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: queryText,
            limit: 10,
            in_stock_only: false,
          },
        },
        metadata: {
          scope: { catalog: 'global', region: 'US', language: 'en-US' },
          entry: 'home',
          source: 'creator_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resolveProductRef).not.toHaveBeenCalled();
    expect(primaryScope.isDone()).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: productId,
        merchant_id: merchantId,
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'legacy_internal',
        legacy_contract: true,
        primary_lane: 'beauty_discovery_mainline',
        query_source: 'agent_products_search',
      }),
    );
    expect(resp.body.metadata?.search_request_contract?.primary_lane).toBe('beauty_discovery_mainline');
    expect(resp.body.metadata?.proxy_search_fallback?.applied).not.toBe(true);
  });

  test('creator_agent explicit legacy_contracts can still use resolver-first legacy fallback', async () => {
    const queryText = 'ipsa';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886500127048';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 0.99,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 10 },
      }),
    }));

    const primaryScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: queryText,
            limit: 10,
            in_stock_only: false,
          },
        },
        metadata: {
          scope: { catalog: 'global', region: 'US', language: 'en-US' },
          entry: 'home',
          source: 'creator_agent',
          legacy_contracts: true,
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: resolvedProductId,
        merchant_id: resolvedMerchantId,
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'legacy_internal',
        legacy_contract: true,
        query_source: 'agent_products_resolver_fallback',
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'resolver_first',
        }),
      }),
    );
    expect(primaryScope.isDone()).toBe(false);
  });

  test('creator_agent broad beauty mainline generic concern uses internal primitive transport instead of legacy GET search', async () => {
    const queryText = 'i have oily skin, what products should i use';
    let internalPrimitiveRequestBody = null;

    const legacyScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            merchant_id: 'legacy_merch_should_not_run',
            product_id: 'legacy_prod_should_not_run',
            title: 'Legacy GET should not run',
          },
        ],
        total: 1,
      });

    const primaryScope = nock('http://pivota.test')
      .post('/agent/internal/products/search')
      .reply(200, function replyInternalPrimitive(_, body) {
        internalPrimitiveRequestBody = body;
        return {
          status: 'success',
          success: true,
          products: [
            {
              merchant_id: 'merch_generic_1',
              product_id: 'prod_generic_1',
              title: 'Oil Control Cleanser',
            },
            {
              merchant_id: 'merch_generic_2',
              product_id: 'prod_generic_2',
              title: 'Lightweight Moisturizer',
            },
          ],
          total: 2,
          metadata: {
            query_source: 'internal_products_search_primitive_cache',
            transport_owner: 'internal_products_search_primitive',
          },
        };
      })
      ;

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: queryText,
            catalog_surface: 'beauty',
            commerce_surface: 'beauty',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'creator_agent',
          catalog_surface: 'beauty',
          commerce_surface: 'beauty',
        },
      });

    expect(resp.status).toBe(200);
    expect(primaryScope.isDone()).toBe(true);
    expect(legacyScope.isDone()).toBe(false);
    expect(internalPrimitiveRequestBody).toEqual(
      expect.objectContaining({
        query: 'oil control treatment',
        catalog_surface: 'beauty',
        search_all_merchants: true,
        target_step_family: 'treatment',
        semantic_family: 'oil_control',
      }),
    );
    expect(typeof internalPrimitiveRequestBody?.trace_id).toBe('string');
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'legacy_internal',
        legacy_contract: true,
        primary_lane: 'beauty_discovery_mainline',
      }),
    );
    expect(resp.body.metadata?.search_request_contract?.primary_lane).toBe('beauty_discovery_mainline');
    expect(resp.body.metadata?.search_request_contract?.request_class).toBe('beauty_discovery');
    expect(resp.body.metadata?.search_request_contract?.semantic_contract?.request_class).toBe(
      'generic_concern',
    );
    expect(resp.body.metadata?.search_trace?.expanded_query).toBe('oil control treatment');
  });

  test('public search defaults external seed contract on the real invoke -> v2 upstream path', async () => {
    let upstreamRequestBody = null;
    let upstreamQuery = null;

    const primaryScope = nock('http://pivota.test')
      .post('/agent/v2/products/search', (body) => {
        upstreamRequestBody = body;
        return true;
      })
      .query((query) => {
        upstreamQuery = query;
        return (
          String(query.search_all_merchants || '') === 'true' &&
          String(query.query || '') === 'lip balm' &&
          String(query.allow_external_seed || '') === 'true' &&
          String(query.external_seed_strategy || '') === 'unified_relevance'
        );
      })
      .reply(200, function replySearchV2(_, body) {
        return {
          status: 'success',
          success: true,
          products: [
            {
              merchant_id: 'external_seed',
              product_id: 'ext_lip_balm_1',
              source: 'external_seed',
              title: 'Barrier Repair Lip Balm',
            },
          ],
          total: 1,
          metadata: {
            query_source: 'agent_products_v2',
          },
        };
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'lip balm',
            limit: 1,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    expect(resp.status).toBe(200);
    expect(primaryScope.isDone()).toBe(true);
    expect(upstreamQuery).toEqual(
      expect.objectContaining({
        query: 'lip balm',
        search_all_merchants: 'true',
        allow_external_seed: 'true',
        external_seed_strategy: 'unified_relevance',
      }),
    );
    expect(upstreamRequestBody).toEqual(
      expect.objectContaining({
        query: 'lip balm',
        search_all_merchants: true,
        allow_external_seed: true,
        external_seed_strategy: 'unified_relevance',
      }),
    );
    expect(resp.body.metadata?.search_request_contract).toEqual(
      expect.objectContaining({
        policy: expect.objectContaining({
          allow_external_seed: true,
        }),
        supplement_lanes: expect.arrayContaining([
          'external_seed_supplement',
          'coverage_supplement',
        ]),
      }),
    );
  });

  test('public search with explicit beauty surface uses discovery bridge instead of v2 upstream', async () => {
    let discoveryPayload = null;
    const getDiscoveryFeedMock = jest.fn(async (payload) => {
      discoveryPayload = payload;
      return {
        products: Array.from({ length: 12 }, (_, idx) => ({
          merchant_id: `hair_${idx + 1}`,
          product_id: `shampoo_${idx + 1}`,
          title: `Repair Shampoo ${idx + 1}`,
          brand: 'Hair Lab',
          category: 'Hair Care',
          product_type: 'Shampoo',
          inventory_quantity: 10,
          status: 'active',
        })),
        total: 12,
        metadata: {
          candidate_source: 'external_seed_query_mainline',
          route_health: {
            primary_quality_gate_passed: true,
          },
        },
      };
    });
    jest.doMock('../../src/services/discoveryFeed', () => {
      const actual = jest.requireActual('../../src/services/discoveryFeed');
      return {
        ...actual,
        getDiscoveryFeed: getDiscoveryFeedMock,
      };
    });
    const v2Scope = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(418, { error: 'should_not_call_v2' });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'shampoo',
            limit: 12,
            in_stock_only: true,
            catalog_surface: 'beauty',
            commerce_surface: 'beauty',
            allow_external_seed: true,
            external_seed_strategy: 'unified_relevance',
          },
        },
        metadata: {
          source: 'search',
          catalog_surface: 'beauty',
          commerce_surface: 'beauty',
        },
      });

    jest.dontMock('../../src/services/discoveryFeed');

    expect(resp.status).toBe(200);
    expect(v2Scope.isDone()).toBe(false);
    expect(getDiscoveryFeedMock).toHaveBeenCalledTimes(1);
    expect(discoveryPayload).toEqual(
      expect.objectContaining({
        surface: 'browse_products',
        limit: 12,
        query: { text: 'shampoo' },
      }),
    );
    expect(resp.body.products).toHaveLength(12);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'beauty_discovery_mainline',
        primary_lane: 'beauty_discovery_mainline',
        primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
        public_search_discovery_bridge: true,
        bridged_operation: 'get_discovery_feed',
      }),
    );
    expect(resp.body.metadata?.route_health).toEqual(
      expect.objectContaining({
        primary_path_used: 'beauty_discovery_mainline',
        fallback_triggered: false,
        primary_quality_gate_passed: true,
      }),
    );
  });

  test('public brand search bridges to discovery with brand scope instead of v2 upstream', async () => {
    let discoveryPayload = null;
    const getDiscoveryFeedMock = jest.fn(async (payload) => {
      discoveryPayload = payload;
      return {
        products: [
          {
            merchant_id: 'external_seed',
            product_id: 'tom_ford_lost_cherry',
            source: 'external_seed',
            title: 'Lost Cherry Eau de Parfum',
            brand: 'Tom Ford Beauty',
          },
        ],
        total: 1,
        metadata: {
          candidate_source: 'brand_direct_primary',
          primary_path_used: 'brand_direct_pool',
          route_health: {
            primary_quality_gate_passed: true,
          },
        },
      };
    });
    jest.doMock('../../src/services/discoveryFeed', () => {
      const actual = jest.requireActual('../../src/services/discoveryFeed');
      return {
        ...actual,
        getDiscoveryFeed: getDiscoveryFeedMock,
      };
    });

    const v2Scope = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(418, { error: 'should_not_call_v2' });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'tom ford',
            limit: 24,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    jest.dontMock('../../src/services/discoveryFeed');

    expect(resp.status).toBe(200);
    expect(v2Scope.isDone()).toBe(false);
    expect(getDiscoveryFeedMock).toHaveBeenCalledTimes(1);
    expect(discoveryPayload).toEqual(
      expect.objectContaining({
        surface: 'browse_products',
        limit: 24,
        query: { text: 'tom ford' },
        scope: {
          brand_names: ['tom ford'],
        },
      }),
    );
    expect(resp.body.products).toHaveLength(1);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'beauty_discovery_mainline',
        primary_lane: 'beauty_discovery_mainline',
        public_search_brand_mainline: true,
        public_search_brand_scope_applied: ['tom ford'],
        public_search_discovery_bridge: true,
      }),
    );
  });

  test('public skincare brand search bridges to discovery even without explicit beauty surface', async () => {
    let discoveryPayload = null;
    const getDiscoveryFeedMock = jest.fn(async (payload) => {
      discoveryPayload = payload;
      return {
        products: [
          {
            merchant_id: 'external_seed',
            product_id: 'the_ordinary_niacinamide',
            source: 'external_seed',
            title: 'Niacinamide 10% + Zinc 1%',
            brand: 'The Ordinary',
          },
        ],
        total: 1,
        metadata: {
          candidate_source: 'brand_direct_primary',
          primary_path_used: 'brand_direct_pool',
          route_health: {
            primary_quality_gate_passed: true,
          },
        },
      };
    });
    jest.doMock('../../src/services/discoveryFeed', () => {
      const actual = jest.requireActual('../../src/services/discoveryFeed');
      return {
        ...actual,
        getDiscoveryFeed: getDiscoveryFeedMock,
      };
    });

    const v2Scope = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(418, { error: 'should_not_call_v2' });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'the ordinary',
            limit: 24,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    jest.dontMock('../../src/services/discoveryFeed');

    expect(resp.status).toBe(200);
    expect(v2Scope.isDone()).toBe(false);
    expect(getDiscoveryFeedMock).toHaveBeenCalledTimes(1);
    expect(discoveryPayload).toEqual(
      expect.objectContaining({
        surface: 'browse_products',
        limit: 24,
        query: { text: 'the ordinary' },
        scope: {
          brand_names: ['the ordinary'],
        },
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'beauty_discovery_mainline',
        primary_lane: 'beauty_discovery_mainline',
        public_search_brand_mainline: true,
        public_search_brand_scope_applied: ['the ordinary'],
        public_search_discovery_bridge: true,
      }),
    );
  });

  test('public short beauty brand search bridges to discovery without cache fallback', async () => {
    let discoveryPayload = null;
    const getDiscoveryFeedMock = jest.fn(async (payload) => {
      discoveryPayload = payload;
      return {
        products: [
          {
            merchant_id: 'external_seed',
            product_id: 'mac_lipstick',
            source: 'external_seed',
            title: 'MAC Lipstick',
            brand: 'MAC Cosmetics',
          },
        ],
        total: 1,
        metadata: {
          candidate_source: 'brand_direct_primary',
          primary_path_used: 'brand_direct_pool',
          route_health: {
            primary_quality_gate_passed: true,
          },
        },
      };
    });
    jest.doMock('../../src/services/discoveryFeed', () => {
      const actual = jest.requireActual('../../src/services/discoveryFeed');
      return {
        ...actual,
        getDiscoveryFeed: getDiscoveryFeedMock,
      };
    });

    const v2Scope = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(418, { error: 'should_not_call_v2' });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'mac',
            limit: 24,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    jest.dontMock('../../src/services/discoveryFeed');

    expect(resp.status).toBe(200);
    expect(v2Scope.isDone()).toBe(false);
    expect(getDiscoveryFeedMock).toHaveBeenCalledTimes(1);
    expect(discoveryPayload).toEqual(
      expect.objectContaining({
        surface: 'browse_products',
        limit: 24,
        query: { text: 'mac' },
        scope: {
          brand_names: ['mac cosmetics', 'mac'],
        },
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'beauty_discovery_mainline',
        primary_lane: 'beauty_discovery_mainline',
        public_search_brand_mainline: true,
        public_search_brand_scope_applied: ['mac cosmetics', 'mac'],
        public_search_discovery_bridge: true,
      }),
    );
  });

  test('public search category uses a single-pass upstream timeout without timeout retry', async () => {
    process.env.UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT = 'true';
    process.env.FIND_PRODUCTS_MULTI_UPSTREAM_LOOKUP_TIMEOUT_MS = '3500';
    process.env.FIND_PRODUCTS_MULTI_UPSTREAM_DEFAULT_TIMEOUT_MS = '4500';
    process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS = '6500';

    const primaryScope = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query((query) => {
        return (
          String(query.search_all_merchants || '') === 'true' &&
          String(query.query || '') === 'hair oil' &&
          String(query.allow_external_seed || '') === 'true' &&
          String(query.external_seed_strategy || '') === 'unified_relevance'
        );
      })
      .delay(4000)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            merchant_id: 'external_seed',
            product_id: 'ext_hair_oil_1',
            source: 'external_seed',
            title: 'Repair Hair Oil',
          },
          {
            merchant_id: 'external_seed',
            product_id: 'ext_hair_oil_2',
            source: 'external_seed',
            title: 'Rosemary Scalp Hair Oil',
          },
          {
            merchant_id: 'external_seed',
            product_id: 'ext_hair_oil_3',
            source: 'external_seed',
            title: 'Shine Finish Hair Oil',
          },
          {
            merchant_id: 'external_seed',
            product_id: 'ext_hair_oil_4',
            source: 'external_seed',
            title: 'Argan Repair Hair Oil',
          },
          {
            merchant_id: 'external_seed',
            product_id: 'ext_hair_oil_5',
            source: 'external_seed',
            title: 'Overnight Bonding Hair Oil',
          },
          {
            merchant_id: 'external_seed',
            product_id: 'ext_hair_oil_6',
            source: 'external_seed',
            title: 'Lightweight Hair Oil Mist',
          },
        ],
        total: 6,
        metadata: {
          query_source: 'agent_products_v2',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'hair oil',
            limit: 6,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    expect(resp.status).toBe(200);
    expect(primaryScope.isDone()).toBe(true);
    expect(resp.body.products).toHaveLength(6);
    expect(resp.body.products[0]).toEqual(expect.objectContaining({ merchant_id: 'external_seed' }));
    expect(resp.body.metadata?.strict_empty).not.toBe(true);
    expect(resp.body.metadata?.semantic_retry_applied).not.toBe(true);
    expect(resp.body.metadata?.fallback_route).toBeFalsy();
    expect(resp.body.metadata?.route_health?.primary_quality_gate_passed).toBe(true);
    expect(resp.body.metadata?.route_health?.primary_latency_ms).toBeGreaterThanOrEqual(4000);
    expect(resp.body.metadata?.route_health?.primary_latency_ms).toBeLessThan(7000);
  });

  test('public search underfilled exact beauty intent returns partial products without fallback', async () => {
    const primaryScope = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query((query) => {
        return (
          String(query.search_all_merchants || '') === 'true' &&
          String(query.query || '') === 'hair oil' &&
          String(query.allow_external_seed || '') === 'true' &&
          String(query.external_seed_strategy || '') === 'unified_relevance'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'ext_hair_oil_1',
            merchant_id: 'external_seed',
            source: 'external_seed',
            title: 'Repair Hair Oil',
          },
          {
            product_id: 'ext_hair_oil_2',
            merchant_id: 'external_seed',
            source: 'external_seed',
            title: 'Rosemary Hair Oil',
          },
        ],
        total: 2,
        metadata: {
          query_source: 'agent_products_v2',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'hair oil',
            limit: 6,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

	    expect(resp.status).toBe(200);
	    expect(primaryScope.isDone()).toBe(true);
	    expect(resp.body.clarification).toBeFalsy();
	    expect(resp.body.reason_codes || []).not.toContain('AMBIGUITY_CLARIFY');
	    expect(resp.body.products).toHaveLength(2);
	    expect(resp.body.metadata).toEqual(
	      expect.objectContaining({
	        query_source: 'agent_products_v2',
	        compound_intent: 'hair_oil',
	        underfilled_reason: 'public_search_underfilled_exact_intent',
	        primary_underfilled_public_beauty_unified: false,
	        primary_exact_intent_underfilled_public_beauty: true,
	      }),
	    );
	    expect(resp.body.metadata?.strict_empty).not.toBe(true);
	    expect(resp.body.metadata?.route_health?.primary_quality_gate_passed).toBe(false);
	    expect(resp.body.metadata?.route_health?.underfilled_reason).toBe('public_search_underfilled_exact_intent');
	    expect(resp.body.metadata?.route_health?.fallback_triggered).toBe(false);
	    expect(resp.body.metadata?.supplement_attempted).toBe(false);
	    expect(resp.body.metadata?.proxy_search_fallback?.applied).not.toBe(true);
	  });

  test('shopping_agent explicit legacy_contracts is isolated as legacy_internal', async () => {
    const queryText = 'ipsa';
    const productId = '9886500127048';
    const merchantId = 'merch_efbc46b4619cfbdf';

    const modernScope = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const primaryScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            merchant_id: merchantId,
            product_id: productId,
            title: 'IPSA Time Reset Aqua',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: queryText,
            limit: 10,
            in_stock_only: false,
          },
        },
        metadata: {
          scope: { catalog: 'global', region: 'US', language: 'en-US' },
          entry: 'home',
          source: 'shopping_agent',
          legacy_contracts: true,
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: productId,
        merchant_id: merchantId,
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'legacy_internal',
        legacy_contract: true,
        query_source: 'agent_products_search',
      }),
    );
    expect(modernScope.isDone()).toBe(false);
    expect(primaryScope.isDone()).toBe(true);
  });

  test('shopping_agent authoritative rail does not enter resolver-first fallback', async () => {
    const queryText = 'ipsa';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';

    const resolveProductRef = jest.fn().mockResolvedValue({
      resolved: true,
      product_ref: {
        merchant_id: 'merch_efbc46b4619cfbdf',
        product_id: '9886500127048',
      },
      confidence: 0.99,
      reason: 'stable_alias_ref',
      metadata: { latency_ms: 10 },
    });
    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef,
    }));

    const legacyScope = nock('http://pivota.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });
    const primaryScope = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: queryText,
            limit: 10,
            in_stock_only: false,
          },
        },
        metadata: {
          scope: { catalog: 'global', region: 'US', language: 'en-US' },
          entry: 'home',
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resolveProductRef).not.toHaveBeenCalled();
    expect(primaryScope.isDone()).toBe(true);
    legacyScope.persist(false);
    expect(legacyScope.isDone()).toBe(false);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'authoritative_shopping',
        legacy_contract: false,
        query_source: 'agent_products_search',
        route_health: expect.objectContaining({
          fallback_triggered: false,
        }),
      }),
    );
    expect(resp.body.metadata?.proxy_search_fallback?.applied).not.toBe(true);
  });

  test('aurora beauty mainline invoke primary exception skips resolver and invoke fallback owner switches', async () => {
    const queryText = 'best sunscreen for oily skin';
    const resolveProductRef = jest.fn().mockResolvedValue({
      resolved: true,
      product_ref: {
        merchant_id: 'resolver_merch_should_not_run',
        product_id: 'resolver_prod_should_not_run',
      },
      confidence: 0.99,
      reason: 'stable_alias_ref',
      metadata: { latency_ms: 10 },
    });
    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef,
    }));

    const primaryScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(502, {
        error: 'UPSTREAM_UNAVAILABLE',
        message: 'legacy search failed',
      });

    const invokeFallbackScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'invoke_fallback_should_not_run',
            merchant_id: 'fallback_merch',
            title: 'Invoke fallback should not run',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: queryText,
            catalog_surface: 'beauty',
            commerce_surface: 'beauty',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'aurora-bff',
          catalog_surface: 'beauty',
          commerce_surface: 'beauty',
        },
      });

    expect(resp.status).toBe(200);
    expect(resolveProductRef).not.toHaveBeenCalled();
    expect(primaryScope.isDone()).toBe(true);
    expect(invokeFallbackScope.isDone()).toBe(false);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'legacy_internal',
        legacy_contract: true,
        primary_lane: 'beauty_discovery_mainline',
        strict_empty: true,
        strict_empty_reason: 'beauty_discovery_mainline_exception',
      }),
    );
    expect(resp.body.metadata?.search_request_contract?.primary_lane).toBe('beauty_discovery_mainline');
    expect(resp.body.metadata?.proxy_search_fallback?.applied).not.toBe(true);
  });

  test('creator_agent beauty mainline primary exception skips resolver and invoke fallback owner switches', async () => {
    const queryText = 'ipsa';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';

    const resolveProductRef = jest.fn().mockResolvedValue({
      resolved: true,
      product_ref: {
        merchant_id: 'resolver_merch_should_not_run',
        product_id: 'resolver_prod_should_not_run',
      },
      confidence: 0.99,
      reason: 'stable_alias_ref',
      metadata: { latency_ms: 10 },
    });
    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef,
    }));

    const primaryScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(502, {
        error: 'UPSTREAM_UNAVAILABLE',
        message: 'legacy search failed',
      });

    const invokeFallbackScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'invoke_fallback_should_not_run',
            merchant_id: 'fallback_merch',
            title: 'Invoke fallback should not run',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: queryText,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'creator_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resolveProductRef).not.toHaveBeenCalled();
    expect(primaryScope.isDone()).toBe(true);
    expect(invokeFallbackScope.isDone()).toBe(false);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'legacy_internal',
        legacy_contract: true,
        primary_lane: 'beauty_discovery_mainline',
        strict_empty: true,
        strict_empty_reason: 'beauty_discovery_mainline_exception',
      }),
    );
    expect(resp.body.metadata?.search_request_contract?.primary_lane).toBe('beauty_discovery_mainline');
    expect(resp.body.metadata?.proxy_search_fallback?.applied).not.toBe(true);
  });

  test('aurora beauty mainline primary miss does not enter resolver or invoke fallback owner switches', async () => {
    const queryText = 'IPSA related products';
    const resolveProductRef = jest.fn().mockResolvedValue({
      resolved: true,
      product_ref: {
        merchant_id: 'resolver_merch_should_not_run',
        product_id: 'resolver_prod_should_not_run',
      },
      confidence: 0.99,
      reason: 'stable_alias_ref',
      metadata: { latency_ms: 10 },
    });
    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef,
    }));

    const primaryScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'irrelevant_brush_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Round Powder Brush',
          },
        ],
        total: 1,
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const invokeFallbackScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'invoke_fallback_should_not_run',
            merchant_id: 'fallback_merch',
            title: 'Invoke fallback should not run',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: queryText,
            catalog_surface: 'beauty',
            commerce_surface: 'beauty',
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'aurora-bff',
          catalog_surface: 'beauty',
          commerce_surface: 'beauty',
        },
      });

    expect(resp.status).toBe(200);
    expect(resolveProductRef).not.toHaveBeenCalled();
    expect(primaryScope.isDone()).toBe(true);
    expect(invokeFallbackScope.isDone()).toBe(false);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'legacy_internal',
        legacy_contract: true,
        primary_lane: 'beauty_discovery_mainline',
        query_source: 'agent_products_error_fallback',
        proxy_search_fallback: expect.objectContaining({
          reason: 'primary_irrelevant_no_fallback',
        }),
      }),
    );
    expect(resp.body.metadata?.search_request_contract?.primary_lane).toBe('beauty_discovery_mainline');
  });
});
