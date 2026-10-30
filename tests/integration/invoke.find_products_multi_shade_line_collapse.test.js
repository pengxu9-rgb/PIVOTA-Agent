const nock = require('nock');
const request = require('supertest');

// find_products_multi through the invoke door: the shade-line card collapse is wired after the
// identity-graph rescue and reads identity rows only when SHADE_LINE_CARD_COLLAPSE_ENABLED is on.
// Invented store and brand.
describe('/agent/shop/v1/invoke find_products_multi shade line collapse', () => {
  const LINE = 'pl_dddddddddddddddddddddddd';
  const KEYS = ['PIVOTA_API_BASE', 'PIVOTA_API_KEY', 'API_MODE', 'DATABASE_URL', 'FIND_PRODUCTS_MULTI_VECTOR_ENABLED',
    'AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED', 'SHADE_LINE_CARD_COLLAPSE_ENABLED'];
  let prevEnv;
  let identitySqlCalls;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => /127\.0\.0\.1|localhost|::1/.test(String(host || '')));
    prevEnv = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = 'false';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    delete process.env.SHADE_LINE_CARD_COLLAPSE_ENABLED;

    identitySqlCalls = 0;
    const identityRow = (productId) => ({
      source_listing_ref: `merch_shopone:${productId}`,
      merchant_id: 'merch_shopone',
      product_id: productId,
      source_kind: 'internal',
      source_tier: 'merchant',
      live_read_enabled: true,
      sellable_item_group_id: `sig_${productId}`,
      product_line_id: LINE,
      review_family_id: 'rf_line',
      identity_status: 'approved',
      identity_confidence: 0.8,
      match_basis: ['official_url:https://shop-one.example/products/x'],
      shade_line: { rule_version: 'shade_line_v2', status: 'approved', product_line_id: LINE, store: 'merch_shopone@shop-one.example' },
    });
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM pdp_identity_listing pil') && text.includes('pil.source_listing_ref = ANY')) {
          identitySqlCalls += 1;
          // The decision comes only from the column the reader selects (soft_identity->'shade_line').
          const selectsDecision = text.includes("soft_identity->'shade_line' AS shade_line");
          return {
            rows: ['k2207', 't415', 'p380'].map(identityRow).map(({ shade_line: decision, ...row }) =>
              selectsDecision ? { ...row, shade_line: decision } : row,
            ),
          };
        }
        return { rows: [] };
      },
    }));
  });

  afterEach(() => {
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
    for (const key of KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
  });

  const shade = (productId, price) => ({
    id: productId,
    product_id: productId,
    merchant_id: 'merch_shopone',
    title: `BRANDA Gel Polish ${productId.toUpperCase()}`,
    brand: 'BRANDA',
    status: 'published',
    inventory_quantity: 9,
    price,
    currency: 'USD',
    image_url: `https://shop-one.example/images/${productId}.jpg`,
  });

  async function search({ limit = 10, extra = [], page = 1 } = {}) {
    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [shade('k2207', 18), shade('t415', 16), shade('p380', 14), ...extra],
        total: 3 + extra.length,
      });
    const app = require('../../src/server');
    return request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: { search: { query: 'BRANDA gel polish', page, limit, in_stock_only: true } },
        metadata: { source: 'creator_agent' },
      });
  }

  test('flag off: three shade cards, and the collapse reads no identity rows', async () => {
    const resp = await search();
    expect(resp.status).toBe(200);
    const ids = (resp.body.products || []).map((product) => product.product_id);
    expect(ids).toEqual(expect.arrayContaining(['k2207', 't415', 'p380']));
    expect((resp.body.products || []).some((product) => product.shade_line)).toBe(false);
    expect(resp.body.metadata?.shade_line_collapse).toBeUndefined();
    expect(identitySqlCalls).toBe(0);
  });

  test('flag on: one line card in the buyer currency with the shade count, priced as its own listing', async () => {
    process.env.SHADE_LINE_CARD_COLLAPSE_ENABLED = 'true';
    // A page of one over a pool of three: the pool spares two cards, exactly what the fold drops.
    const resp = await search({ limit: 1 });
    expect(resp.status).toBe(200);
    expect(identitySqlCalls).toBeGreaterThan(0);
    const products = resp.body.products || [];
    expect(products).toHaveLength(1);
    expect(products[0].shade_line).toMatchObject({ product_line_id: LINE, shade_count: 3 });
    expect(products[0].shade_line).not.toHaveProperty('from_price');
    expect(products[0].price).toBe(18);
    expect(resp.body.metadata?.shade_line_collapse).toMatchObject({ applied: true, lines_collapsed: 1, cards_dropped: 2 });
  });

  test('flag on, no over-fetch (the pool is no wider than the page): nothing folds, the page stays full', async () => {
    process.env.SHADE_LINE_CARD_COLLAPSE_ENABLED = 'true';
    const resp = await search({ limit: 10 });
    const products = resp.body.products || [];
    expect(products.map((product) => product.product_id)).toEqual(expect.arrayContaining(['k2207', 't415', 'p380']));
    expect(products.some((product) => product.shade_line)).toBe(false);
  });

  test('flag on, page 2: nothing folds and no identity row is read for the collapse', async () => {
    process.env.SHADE_LINE_CARD_COLLAPSE_ENABLED = 'true';
    const resp = await search({ limit: 1, page: 2 });
    expect(resp.status).toBe(200);
    expect((resp.body.products || []).some((product) => product.shade_line)).toBe(false);
    expect(resp.body.metadata?.shade_line_collapse).toBeUndefined();
    expect(identitySqlCalls).toBe(0);
  });

  test('flag on: the collapse runs on the wide pool before the page-size trim, so freed slots are refilled', async () => {
    process.env.SHADE_LINE_CARD_COLLAPSE_ENABLED = 'true';
    const others = ['n101', 'n102', 'n103'].map((id) => ({ ...shade(id, 20), title: `BRANDA Gel Polish Other ${id}` }));
    const resp = await search({ limit: 3, extra: others });
    expect(resp.status).toBe(200);
    const products = resp.body.products || [];
    expect(products).toHaveLength(3);
    expect(products.filter((product) => product.shade_line)).toHaveLength(1);
    expect(products.filter((product) => ['n101', 'n102', 'n103'].includes(product.product_id))).toHaveLength(2);
  });

  test('flag on: a pool of 12 for a page of 10 where the currency guard drops 2 cards still serves a full page', async () => {
    process.env.SHADE_LINE_CARD_COLLAPSE_ENABLED = 'true';
    const usdOthers = ['n101', 'n102', 'n103', 'n104', 'n105', 'n106', 'n107'].map((id) => ({ ...shade(id, 20), title: `BRANDA Gel Polish Other ${id}` }));
    const sgdOthers = ['s201', 's202'].map((id) => ({ ...shade(id, 20), currency: 'SGD', title: `BRANDA Gel Polish Import ${id}` }));
    const resp = await search({ limit: 10, extra: [...usdOthers, ...sgdOthers] });
    expect(resp.status).toBe(200);
    const products = resp.body.products || [];
    expect(products.some((product) => product.currency === 'SGD')).toBe(false);
    expect(products).toHaveLength(10);
  });
});
