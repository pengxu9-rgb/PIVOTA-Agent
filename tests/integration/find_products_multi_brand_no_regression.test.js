const nock = require('nock');
const request = require('supertest');

describe('find_products_multi canonical path brand no-regression', () => {
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
    process.env.DATABASE_URL = 'postgres://canonical-brand-test';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    process.env = prevEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test('Glossier seed-side win remains visible when canonical path also returns rows', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM catalog_products p')) {
          return {
            rows: [{
              merchant_id: 'external_seed',
              product_key: 'prod::external_seed::external_seed::ext_other_spf',
              platform: 'external_seed',
              source_product_id: 'ext_other_spf',
              pivota_signature_id: 'sig_other_spf',
              product_title: 'Other Brand Daily Sunscreen SPF 50',
              product_description: 'Canonical sunscreen row.',
              brand: 'Other Brand',
              product_type: 'Sunscreen',
              category: 'Sunscreen',
              category_path: 'beauty/skincare/sun/sunscreen',
              product_image_url: 'https://cdn.example.com/other-spf.jpg',
              product_payload: { seed_data: { price_amount: '18.00', price_currency: 'USD' } },
              rank_score: 90,
            }],
          };
        }
        if (text.includes('FROM external_product_seeds')) {
          const now = new Date().toISOString();
          return {
            rows: [{
              id: 'seed_glossier_spf',
              external_product_id: 'ext_glossier_spf',
              market: 'US',
              tool: '*',
              title: 'Glossier Invisible Shield Sunscreen SPF 35',
              canonical_url: 'https://glossier.example/products/invisible-shield',
              destination_url: 'https://glossier.example/products/invisible-shield',
              image_url: 'https://cdn.example.com/glossier-spf.jpg',
              price_amount: '25.00',
              price_currency: 'USD',
              availability: 'in stock',
              seed_data: { brand: 'Glossier', category: 'sunscreen' },
              updated_at: now,
              created_at: now,
            }],
          };
        }
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: { search: { query: 'Glossier sunscreen', page: 1, limit: 6, market: 'US' } },
        metadata: { source: 'beauty_cross_agent_batch', market: 'US' },
      });

    const ids = (resp.body.products || []).map((item) => item.product_id);
    expect(resp.status).toBe(200);
    expect(ids).toContain('ext_glossier_spf');
    expect(resp.body.products[0].brand).toBe('Glossier');
    expect(resp.body.metadata?.canonical_path_executed).toBe(true);
  });
});
