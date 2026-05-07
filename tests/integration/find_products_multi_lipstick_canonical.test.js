const nock = require('nock');
const request = require('supertest');

function canonicalLipstickRows(count = 18) {
  return Array.from({ length: count }, (_, index) => ({
    merchant_id: 'external_seed',
    product_key: `prod::external_seed::external_seed::ext_lipstick_${index}`,
    platform: 'external_seed',
    source_product_id: `ext_lipstick_${index}`,
    pivota_signature_id: `sig_lipstick_${index}`,
    pivota_canonical_url: `https://agent.pivota.cc/products/sig_lipstick_${index}`,
    product_title: `Fenty Icon Lipstick Shade ${index}`,
    product_description: 'A canonical lipstick row from catalog_products.',
    brand: index % 2 ? 'Fenty Beauty' : 'MAC',
    product_type: 'Lipstick',
    category: 'Lipstick',
    category_path: 'beauty/makeup/lip/lipstick',
    canonical_url: `https://brand.example/products/lipstick-${index}`,
    product_image_url: `https://cdn.example.com/lipstick-${index}.jpg`,
    catalog_track: 'external_referral',
    truth_tier: 'observed',
    readiness_tier: 'referral_only',
    pdp_scope: 'unverified',
    product_payload: {
      seed_data: {
        price_amount: '24.00',
        price_currency: 'USD',
        availability: 'in stock',
      },
    },
    rank_score: 90,
  }));
}

describe('find_products_multi canonical lipstick recall', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => String(host || '').includes('127.0.0.1') || String(host || '').includes('localhost'));
    prevEnv = { ...process.env };
    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://canonical-test';
    process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = '1';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    process.env = prevEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test('lipstick query returns canonical-chain catalog rows with telemetry', async () => {
    const observedSql = [];
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        observedSql.push(text);
        if (text.includes('FROM catalog_products p')) return { rows: canonicalLipstickRows(18) };
        if (text.includes('FROM external_product_seeds')) return { rows: [] };
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: { search: { query: 'lipstick', page: 1, limit: 20, market: 'US' } },
        metadata: { source: 'shopping_agent', market: 'US' },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products.length).toBeGreaterThanOrEqual(15);
    expect(resp.body.products.every((item) => item.source === 'canonical_chain')).toBe(true);
    expect(resp.body.metadata).toEqual(expect.objectContaining({
      canonical_path_executed: true,
      canonical_raw_count: 18,
      canonical_dedupe_count: 0,
    }));
    expect(resp.body.metadata?.route_health).toEqual(expect.objectContaining({
      canonical_path_executed: true,
      canonical_raw_count: 18,
      canonical_dedupe_count: 0,
    }));
    expect(observedSql.some((sql) => sql.includes('FROM catalog_products p'))).toBe(true);
  });

  test('shopping query keeps upstream result while exposing canonical telemetry', async () => {
    const observedSql = [];
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        observedSql.push(String(sql || ''));
        return { rows: [] };
      },
    }));
    nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [{
          product_id: 'prod_airpods',
          merchant_id: 'merch_audio',
          platform: 'shopify',
          title: 'Apple AirPods Pro',
          brand: 'Apple',
          product_type: 'Electronics',
          category: 'Electronics',
          image_url: 'https://cdn.example.com/airpods.jpg',
          price: 199,
          currency: 'USD',
        }],
        total: 1,
      });
    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        product: {},
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: { search: { query: 'Apple AirPods', page: 1, limit: 12, market: 'US' } },
        metadata: { source: 'shopping_agent', market: 'US' },
      });

    expect(resp.status).toBe(200);
    expect((resp.body.products || []).map((item) => item.product_id)).toContain('prod_airpods');
    expect(resp.body.metadata).toEqual(expect.objectContaining({
      canonical_path_executed: true,
      canonical_raw_count: 0,
      canonical_dedupe_count: 0,
    }));
    expect(resp.body.metadata?.route_health).toEqual(expect.objectContaining({
      canonical_path_executed: true,
      canonical_raw_count: 0,
      canonical_dedupe_count: 0,
    }));
    expect(observedSql.some((sql) => sql.includes('FROM catalog_products p'))).toBe(true);
  });
});
