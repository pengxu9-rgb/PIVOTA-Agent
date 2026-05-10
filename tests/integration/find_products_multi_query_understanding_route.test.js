const nock = require('nock');
const request = require('supertest');

function extractCapturedQuery(uri, body) {
  const url = new URL(uri, 'http://pivota.test');
  return String(url.searchParams.get('query') || body?.query || '').trim();
}

function mockSearch(capturedQueries, products = null) {
  return nock('http://pivota.test')
    .persist()
    .post(/\/agent\/v2\/products\/search.*/)
    .reply(200, function reply(uri, body) {
      capturedQueries.push(extractCapturedQuery(uri, body));
      const safeProducts = Array.isArray(products) && products.length
        ? products
        : [
            {
              id: 'tf_fragrance_1',
              product_id: 'tf_fragrance_1',
              merchant_id: 'external_seed',
              source: 'external_seed',
              title: 'Tom Ford Noir Extreme Eau de Parfum',
              description: 'fragrance perfume for date night',
              price: 168,
              currency: 'USD',
              in_stock: true,
              inventory_quantity: 8,
              status: 'published',
            },
          ];
      return {
        status: 'success',
        success: true,
        total: safeProducts.length,
        products: safeProducts,
      };
    });
}

describe('find_products_multi query understanding route wiring', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
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
      FIND_PRODUCTS_MULTI_VECTOR_ENABLED: process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED,
      SEARCH_AMBIGUITY_GATE_ENABLED: process.env.SEARCH_AMBIGUITY_GATE_ENABLED,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    delete process.env.DATABASE_URL;
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = 'false';
    process.env.SEARCH_AMBIGUITY_GATE_ENABLED = 'true';
  });

  afterEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();

    Object.entries(prevEnv || {}).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });

  test('corrects Tom Ford fragrance typo before recall routing', async () => {
    const capturedQueries = [];
    mockSearch(capturedQueries);

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'tom ford fragarance',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'agent_sdk_fixed_delegate',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.clarification).toBeUndefined();
    expect(resp.body.products?.length).toBeGreaterThan(0);
    expect(capturedQueries.some((query) => /tom ford fragrance/i.test(query))).toBe(true);
    expect(capturedQueries.every((query) => !/fragarance/i.test(query))).toBe(true);
  });

  test('binds generic fragrance follow-up to current conversation only', async () => {
    const capturedQueries = [];
    mockSearch(capturedQueries);

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'fragrance',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
          messages: [
            { role: 'user', content: 'tom ford fragarance' },
            { role: 'assistant', content: 'I found Tom Ford fragrance options.' },
            { role: 'user', content: 'fragrance' },
          ],
        },
        metadata: {
          source: 'agent_sdk_fixed_delegate',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.clarification).toBeUndefined();
    expect(resp.body.products?.length).toBeGreaterThan(0);
    expect(capturedQueries.some((query) => /tom ford fragrance/i.test(query))).toBe(true);
  });

  test('does not bind generic fragrance to session recent query by default', async () => {
    const capturedQueries = [];
    mockSearch(capturedQueries);

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'fragrance',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
          user: {
            session_recent_queries: ['tom ford fragarance'],
          },
        },
        metadata: {
          source: 'agent_sdk_fixed_delegate',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.clarification).toBeUndefined();
    expect(resp.body.products?.length).toBeGreaterThan(0);
    expect(capturedQueries.some((query) => /tom ford/i.test(query))).toBe(false);
    expect(capturedQueries.some((query) => /^fragrance\b/i.test(query))).toBe(true);
  });

  test('binds session recent query when continuation is explicit', async () => {
    const capturedQueries = [];
    mockSearch(capturedQueries);

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'continue previous search',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
          user: {
            session_recent_queries: ['tom ford fragarance'],
          },
        },
        metadata: {
          source: 'agent_sdk_fixed_delegate',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.clarification).toBeUndefined();
    expect(resp.body.products?.length).toBeGreaterThan(0);
    expect(capturedQueries.some((query) => /tom ford fragrance/i.test(query))).toBe(true);
  });

  test('binds acne clarification follow-up skin and location slots before recall routing', async () => {
    const capturedQueries = [];
    mockSearch(capturedQueries, [
      {
        id: 'acne_treatment_1',
        product_id: 'acne_treatment_1',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Salicylic Acid Acne Treatment Serum for Oily Skin',
        description: 'acne blemish treatment serum for oily skin',
        price: 19,
        currency: 'USD',
        in_stock: true,
        inventory_quantity: 8,
        status: 'published',
      },
    ]);

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'i think i am aoily skin, and i live in SF.',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
          messages: [
            { role: 'user', content: 'i have acne issue, recommend some products to take care of it' },
            {
              role: 'assistant',
              content:
                'I need a bit more context before narrowing products: skin_type, environment. A skin analysis can help if you want a more precise routine, but it is not required to continue.',
            },
            { role: 'user', content: 'i think i am aoily skin, and i live in SF.' },
          ],
        },
        metadata: {
          source: 'agent_sdk_fixed_delegate',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products?.length).toBeGreaterThan(0);
    expect(capturedQueries.some((query) => /acne/i.test(query) && /oily skin/i.test(query))).toBe(true);
    expect(capturedQueries.every((query) => !/aoily/i.test(query))).toBe(true);
    expect(resp.body.metadata?.query_understanding).toEqual(
      expect.objectContaining({
        context_scope: 'conversation',
        decision: 'apply_conversation_context',
      }),
    );
    expect(resp.body.metadata?.query_understanding?.context_binding).toEqual(
      expect.objectContaining({
        reason: 'beauty_slot_followup_conversation_context',
      }),
    );
  });
});
