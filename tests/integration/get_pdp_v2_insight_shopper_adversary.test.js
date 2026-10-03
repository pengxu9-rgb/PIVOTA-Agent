const request = require('supertest');
const nock = require('nock');
const legacy = require('../fixtures/judydoll_product_intel_legacy_review_copy.json');

jest.setTimeout(30000);

describe('real public PDP Insights transport boundary', () => {
  let app;
  const previousEnv = { ...process.env };
  const base = 'http://insight-adversary.test';
  const sentinel = 'PRIVATE_OPERATOR_SENTINEL';
  beforeAll(() => {
    jest.resetModules();
    process.env.API_MODE = 'REAL';
    process.env.PIVOTA_API_BASE = base;
    process.env.PIVOTA_BACKEND_BASE_URL = base;
    process.env.PIVOTA_API_KEY = 'test-token';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    process.env.PDP_SELF_OFFER_FALLBACK_ENABLED = 'true';
    delete process.env.DATABASE_URL;
    app = require('../../src/server');
  });
  afterEach(() => nock.cleanAll());
  afterAll(() => { process.env = previousEnv; });

  test.each([
    ['raw', []], ['raw_detail', ['product_intel']], ['raw_payload', ['product_intel', 'product_overview']],
  ])('public request excludes internal Insights in canonical %s with include=%j', async (alias, include) => {
    const intel = JSON.parse(JSON.stringify(legacy));
    intel.provenance.generator = sentinel;
    intel.agent_context = { guardrails: { review_standard: sentinel } };
    const product = {
      merchant_id: 'merchant_insight_test', product_id: `insight_${alias}`,
      title: 'Judydoll Silky Matte Lip Ink', brand: 'Judydoll',
      description: 'A lightweight matte lip color.', category: 'Beauty', product_type: 'Lip color',
      price: 12, currency: 'USD', in_stock: true,
      image_url: 'https://cdn.example.test/lip.png',
      product_intel: intel,
      [alias]: { product_intel: intel, productIntel: intel, nested: { agent_context: { review_standard: sentinel } } },
    };
    nock(base).persist().post('/agent/shop/v1/invoke', (b) => b.operation === 'get_product_detail')
      .reply(200, { status: 'success', success: true, product });
    nock(base).persist().get(`/agent/v1/products/${product.merchant_id}/${product.product_id}`)
      .reply(200, { product });
    nock(base).persist().get('/agent/v1/product-groups/resolve').query(true)
      .reply(404, { error: 'PRODUCT_GROUP_NOT_FOUND' });
    nock(base).persist().post('/agent/shop/v1/invoke', (b) => b.operation === 'find_similar_products')
      .reply(200, { status: 'success', products: [] });
    const response = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'get_pdp_v2',
      payload: { product_ref: { merchant_id: product.merchant_id, product_id: product.product_id }, include,
        options: { allow_ineligible: true } },
    });
    expect(response.status).toBe(200);
    const canonical = response.body.modules.find((m) => m.type === 'canonical');
    expect(canonical.data.pdp_payload.product.title).toContain('Judydoll');
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(JSON.stringify(response.body)).not.toContain('Reviewed lip cues');
    expect(JSON.stringify(response.body)).not.toContain('reducing ambiguity');
    if (include.includes('product_intel')) {
      const module = response.body.modules.find((m) => m.type === 'product_intel');
      expect(module.data.public_display_eligible).toBe(true);
      expect(module.data).not.toHaveProperty('provenance');
      expect(module.data).not.toHaveProperty('agent_context');
    }
  });
});
