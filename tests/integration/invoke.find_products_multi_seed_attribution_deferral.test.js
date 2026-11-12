// FIX_PLAN O-04: the invoke route's in-search seed-link mint is DEFERRED, and only then, when
// PARTNER_IDENTITY_FORWARDING_ENABLED is on AND a loopback self-call (the MCP surface's cached search) asks
// for it with X-Pivota-Seed-Attribution: deferred. The MCP surface then mints per response, after its cache
// (tests/partner_identity_forwarding_mcp_door.node.test.cjs). Everything else mints exactly as before.
//
// Drives the real /agent/shop/v1/invoke find_products_multi route with the same stubs the stamp tests in
// invoke.find_products_multi_strict_surface.test.js use: a mocked DB returning one seed row and a nocked mint.

process.env.PIVOTA_API_BASE = 'http://pivota.test';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.API_MODE = 'REAL';

const request = require('supertest');
const nock = require('nock');

const RAW_DESTINATION = 'https://shop-a.example.com/products/niacinamide-serum-x';
const ATTRIBUTED_DESTINATION = `${RAW_DESTINATION}?utm_source=pivota&pvt_click_id=clk_1`;

function mockDbRows(rows) {
  jest.doMock('../../src/db', () => ({
    query: jest.fn(async (sql) => {
      const text = String(sql || '');
      if (!text.includes('FROM external_product_seeds')) return { rows: [] };
      return { rows };
    }),
  }));
}

function seedRow() {
  return {
    id: 'seed_serum_x',
    market: 'US',
    tool: '*',
    destination_url: RAW_DESTINATION,
    canonical_url: RAW_DESTINATION,
    domain: 'shop-a.example.com',
    title: 'Niacinamide Serum X',
    image_url: 'https://cdn.example.com/serum-x.jpg',
    price_amount: 22,
    price_currency: 'USD',
    availability: 'in_stock',
    seed_data: {
      title: 'Niacinamide Serum X',
      description: 'Placeholder niacinamide serum external seed.',
      category: 'Serum',
      brand: 'Brand X',
      reviewed_ingredient_ids: ['niacinamide'],
      variants: [{ id: 'seed_variant_default', title: 'Default Title', price: 22, availability: 'in_stock' }],
    },
    status: 'active',
    attached_product_key: null,
    created_at: '2026-03-23T00:00:00Z',
    updated_at: '2026-03-23T00:00:00Z',
  };
}

function interceptMint() {
  const state = { calls: 0 };
  state.scope = nock('http://pivota.test')
    .persist()
    .post('/agent/shop/v1/attribution/external-seed-links')
    .reply(200, () => {
      state.calls += 1;
      return {
        links: [{
          external_seed_id: 'seed_serum_x',
          external_redirect_url: 'https://api.example.com/r?token=abc.def',
          destination_url: ATTRIBUTED_DESTINATION,
          cart_url: null,
          tracking: { click_id: 'clk_1', param: 'pvt_click_id', join_mode: 'referral_only' },
        }],
      };
    });
  return state;
}

async function search(app, headers = {}) {
  const pending = request(app).post('/agent/shop/v1/invoke');
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  const res = await pending
    .send({
      operation: 'find_products_multi',
      payload: { search: { query: 'niacinamide serum under €30', limit: 10, in_stock_only: true } },
      metadata: { source: 'shopping_agent' },
    })
    .expect(200);
  return res.body;
}

describe('find_products_multi seed attribution deferral (PARTNER_IDENTITY_FORWARDING_ENABLED)', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.dontMock('../../src/db');
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => /127\.0\.0\.1|localhost|::1/.test(String(host || '')));
    prevEnv = {
      DATABASE_URL: process.env.DATABASE_URL,
      PARTNER_IDENTITY_FORWARDING_ENABLED: process.env.PARTNER_IDENTITY_FORWARDING_ENABLED,
      EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED: process.env.EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED,
      PIVOTA_BACKEND_BASE_URL: process.env.PIVOTA_BACKEND_BASE_URL,
    };
    process.env.DATABASE_URL = 'postgres://seed-deferral-test';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED;
    delete process.env.PARTNER_IDENTITY_FORWARDING_ENABLED;
    mockDbRows([seedRow()]);
  });

  afterEach(() => {
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('flag on + the loopback deferral header: no in-search mint, the raw card is returned', async () => {
    process.env.PARTNER_IDENTITY_FORWARDING_ENABLED = '1';
    const mint = interceptMint();
    const app = require('../../src/server');
    const body = await search(app, { 'X-Pivota-Seed-Attribution': 'deferred' });
    expect(mint.calls).toBe(0);
    expect(body.products).toHaveLength(1);
    expect(body.products[0].destination_url).toBe(RAW_DESTINATION);
    expect(body.products[0]).not.toHaveProperty('external_redirect_url');
    expect(body.products[0]).not.toHaveProperty('tracking');
    expect(body.metadata).not.toHaveProperty('external_seed_attribution');
  });

  test('flag on, no deferral header: the in-search mint runs exactly as before', async () => {
    process.env.PARTNER_IDENTITY_FORWARDING_ENABLED = '1';
    const mint = interceptMint();
    const app = require('../../src/server');
    const body = await search(app);
    expect(mint.calls).toBe(1);
    expect(body.products[0].external_redirect_url).toBe('https://api.example.com/r?token=abc.def');
    expect(body.products[0].destination_url).toBe(ATTRIBUTED_DESTINATION);
    expect(body.metadata.external_seed_attribution).toEqual({ candidates: 1, stamped: 1 });
  });

  test('flag on, the header from a caller that is not this process: ignored, the mint runs', async () => {
    process.env.PARTNER_IDENTITY_FORWARDING_ENABLED = '1';
    const mint = interceptMint();
    const app = require('../../src/server');
    // A forwarded request is not a loopback self-call, whatever socket it arrived on.
    const body = await search(app, { 'X-Pivota-Seed-Attribution': 'deferred', 'X-Forwarded-For': '203.0.113.7' });
    expect(mint.calls).toBe(1);
    expect(body.products[0].external_redirect_url).toBe('https://api.example.com/r?token=abc.def');
  });

  test('flag off: the deferral header is ignored and the answer is the undeferred one, byte for byte', async () => {
    const mint = interceptMint();
    const app = require('../../src/server');
    const withHeader = await search(app, { 'X-Pivota-Seed-Attribution': 'deferred' });
    const without = await search(app);
    expect(mint.calls).toBe(2);
    const strip = (b) => JSON.stringify({ ...b, metadata: { ...b.metadata, gateway_request_id: null, latency_ms: null } },
      (k, v) => (/(_ms|_at|request_id|timestamp)$/i.test(k) ? null : v));
    expect(strip(withHeader)).toBe(strip(without));
    expect(withHeader.products[0].external_redirect_url).toBe('https://api.example.com/r?token=abc.def');
  });
});
