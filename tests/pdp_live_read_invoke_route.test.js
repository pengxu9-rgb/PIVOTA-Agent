// pdp_live_read through the real invoke route: the status codes and the body are the contract the storefront
// reads. The live readers' UCP client is a FAKE set before any reader is built: no store is ever contacted.

process.env.NODE_ENV = 'test';
process.env.INVOKE_AUTH_BYPASS_IN_TEST = '1';
process.env.PIVOTA_API_BASE = 'https://backend.test';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.UCP_LIVE_PDP_READ = 'shadow';
process.env.UCP_LIVE_PDP_REFRESH = 'on';
process.env.UCP_LIVE_PDP_REFRESH_SECRET = 'r'.repeat(48);
delete process.env.UCP_LIVE_PDP_REFRESH_SECRET_PREVIOUS;

const request = require('supertest');
const app = require('../src/server');
const { buildPdpPayload } = require('../src/pdpBuilder');

const LEMON = '48087970185268';
const BERRY = '31760703160372';
const HOST = 'us.laneige.com';
const HANDLE = 'lip-sleeping-mask';

const calls = { discover: 0, lookup: 0 };
app._debug.useUcpLiveClientForTest({
  async discoverEndpoint(base) {
    calls.discover += 1;
    return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 };
  },
  async lookupCatalog(endpoint, { ids }) {
    calls.lookup += 1;
    const vs = [
      { id: `gid://shopify/ProductVariant/${LEMON}`, price: { amount: 2400, currency: 'USD' }, availability: { available: true } },
      { id: `gid://shopify/ProductVariant/${BERRY}`, price: { amount: 2600, currency: 'USD' }, availability: { available: true } },
    ].filter((v) => ids.includes(v.id));
    return {
      ok: true,
      status: 200,
      response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify({ products: [{ id: 'gid://shopify/Product/1', handle: HANDLE, variants: vs }], messages: [] }) }] } },
    };
  },
});

function page() {
  const v = (id, title) => ({
    variant_id: id, title, options: [{ name: 'Flavor', value: title }], price: { amount: 26, currency: 'USD' }, in_stock: false,
  });
  const pdp = buildPdpPayload({
    product: {
      product_id: 'ext_lsm', merchant_id: 'merch_obs_laneige', source: 'external_seed', title: 'Lip Sleeping Mask',
      price: { amount: 26, currency: 'USD' }, currency: 'USD', destination_url: `https://${HOST}/products/${HANDLE}`,
      default_variant_id: LEMON, variants: [v(LEMON, 'Lemon'), v(BERRY, 'Berry')],
    },
    relatedProducts: [],
    entryPoint: 'agent',
  });
  const selector = pdp.modules.find((m) => m.type === 'variant_selector');
  return { status: 'success', modules: [{ type: 'canonical', data: { pdp_payload: pdp } }, { type: 'variant_selector', data: selector.data }] };
}

function invoke(payload, metadata = { market: 'US' }) {
  return request(app)
    .post('/agent/shop/v1/invoke')
    .set('content-type', 'application/json')
    .send({ operation: 'pdp_live_read', payload, metadata });
}

test('a served page that opted in carries the descriptor; one that did not is unchanged', () => {
  const p = page();
  const served = app._debug.withPdpLiveRefreshDescriptor(p, { optedIn: true, market: 'US', cardListingId: 'ext_lsm' });
  expect(served.live_refresh).toMatchObject({ v: 1, market: 'US' });
  expect(served.live_refresh.token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  expect(p.live_refresh).toBeUndefined();
  expect(app._debug.withPdpLiveRefreshDescriptor(p, { optedIn: false, market: 'US' })).toBe(p);
});

test('a valid token and its page answer 200 applied with a patch, read through the fake client', async () => {
  const p = page();
  const { token } = app._debug.withPdpLiveRefreshDescriptor(p, { optedIn: true, market: 'US', cardListingId: 'ext_lsm' }).live_refresh;
  const res = await invoke({ live_refresh_token: token, page: p });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('success');
  expect(res.body.live_refresh).toMatchObject({ mode: 'on', outcome: 'applied', reason: null, source: 'read' });
  expect(res.body.patch.product.set.price.current.amount).toBe(24);
  expect(calls.lookup).toBe(1);
  // The next browser on this instance is answered from the cache.
  const again = await invoke({ live_refresh_token: token, page: p });
  expect(again.body.live_refresh.source).toBe('cache');
  expect(calls.lookup).toBe(1);
  // Another declared market than the token's.
  const moved = await invoke({ live_refresh_token: token, page: p }, { market: 'SG' });
  expect(moved.status).toBe(200);
  expect(moved.body.live_refresh).toMatchObject({ outcome: 'skipped', reason: 'market_changed' });
});

test('a malformed token is a 400 INVALID_LIVE_REFRESH_TOKEN', async () => {
  const res = await invoke({ live_refresh_token: 'v1.nope.nope', page: page() });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('INVALID_LIVE_REFRESH_TOKEN');
  const missing = await invoke({ page: page() });
  expect(missing.status).toBe(400);
});
