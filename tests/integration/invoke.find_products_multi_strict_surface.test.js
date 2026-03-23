process.env.PIVOTA_API_BASE = 'http://pivota.test';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.API_MODE = 'REAL';

const request = require('supertest');
const nock = require('nock');

describe('/agent/shop/v1/invoke find_products_multi strict surfaces', () => {
  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => {
      const value = String(host || '');
      return value.includes('127.0.0.1') || value.includes('localhost') || value === '::1';
    });
  });

  afterEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
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
            },
          ],
          total: 1,
          metadata: {
            query_source: 'cache_multi_intent',
            serving_mode: 'eligible_only',
            catalog_surface: 'agent_api',
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
        }),
      }),
    );
    expect(capturedBody?.payload?.search).toEqual(
      expect.objectContaining({
        catalog_surface: 'agent_api',
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
        }),
      }),
    );
    expect(capturedBody?.payload?.search).toEqual(
      expect.objectContaining({
        catalog_surface: 'agent_api',
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
        limit: 10,
      }),
    );
    expect(res.body.products).toEqual([]);
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        serving_mode: 'eligible_only',
        visible_option_intents: ['shade_210'],
        contract_bridge: expect.objectContaining({
          resolved_contract: 'shop_invoke_strict',
          legacy_fallback: false,
        }),
      }),
    );
  });
});
