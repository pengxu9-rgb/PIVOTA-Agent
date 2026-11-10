'use strict';

// PARTNER IDENTITY ON THE MCP LANES (FIX_PLAN O-04), end to end over the real /mcp door.
//
// Two partners, partner-a and partner-b, call this one gateway with their own api keys. Before this change the
// backend saw only the gateway on every MCP money call (the kernel upstream forces the gateway's own key), and a
// search's seed links were minted inside the shared search cache, so every caller was served the first caller's
// click id. With PARTNER_IDENTITY_FORWARDING_ENABLED on:
//   - every money call that leaves the process (quote, order, hosted link) carries X-Pivota-Issuing-Agent naming
//     the partner that made it, bound to that call's op, beside the gateway's own key;
//   - the cached loopback search is told to defer its mint, and the commerce surface mints AFTER the cache, per
//     response, signed for that response's caller: two partners served one cached search get two click ids;
//   - with the flag off, nothing of the above happens: the same wire bytes as before.
//
// The real producers throughout: api-key introspection -> req.invokeAuth -> INVOKE_AUTH_CONTEXT -> the commerce
// surface and its read cache -> the canonical executor and kernel -> invokeCommerceKernelRawUpstream. Stubbed are
// only the network edges: introspection, the Python backend (nock on PIVOTA_API_BASE) and the loopback search
// (nock on this process's own origin, as tests/commerce_ucp_search_shared_cache.node.test.cjs does).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const PORT = '3993';
const LOOPBACK = `http://127.0.0.1:${PORT}`;
const BACKEND = 'http://backend.partner-identity.test';
const INTROSPECT_BASE = 'https://auth.partner-identity.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const SECRET = 'partner_identity_test_secret';
const FLAG = 'PARTNER_IDENTITY_FORWARDING_ENABLED';
const KEY_A = `ak_live_${'a'.repeat(64)}`;
const KEY_B = `ak_live_${'b'.repeat(64)}`;
const PARTNER_A = 'agent_partner_a';
const PARTNER_B = 'agent_partner_b';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.PORT = PORT;
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.AGENT_CHECKOUT_HOSTED_LINK_ENABLED = '1';
process.env.PIVOTA_API_BASE = BACKEND;
process.env.PIVOTA_API_KEY = 'gateway-service-key';
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.COMMERCE_READ_CACHE_ENABLED = '1';
process.env.SELF_INVOKE_TIMEOUT_MS = '6000';
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
process.env.AGENT_AUTH_INTROSPECT_TIMEOUT_MS = '1200';
process.env.INVOKE_AUTH_BYPASS_IN_TEST = '0';
process.env.ISSUING_AGENT_ASSERTION_SECRET = SECRET;
delete process.env.PUBLIC_READ_MCP_ENABLED;
delete process.env[FLAG];
for (const prefix of ['COMMERCE_MCP', 'PUBLIC_READ_MCP']) {
  for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`${prefix}_HEARTBEAT_${suffix}`];
}

const app = require('../src/server');

test.after(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  process.env = { ...ORIGINAL_ENV };
});

function setFlag(on) {
  if (on) process.env[FLAG] = '1';
  else delete process.env[FLAG];
}

function introspect() {
  for (const [key, agentId] of [[KEY_A, PARTNER_A], [KEY_B, PARTNER_B]]) {
    nock(INTROSPECT_BASE)
      .persist()
      .post(INTROSPECT_PATH, (body) => body && body.api_key === key)
      .reply(200, { valid: true, agent_id: agentId, is_active: true, auth_source: 'api_keys' });
  }
}

// The REQUEST-BOUND (v2) assertion on one captured request, checked against that request: its path, and the
// hash of the exact body bytes (re-serialised from nock's parsed body, which reproduces the sent string).
function assertionOf(headers, { path, body } = {}) {
  const token = headers['x-pivota-issuing-agent'];
  if (!token) return null;
  const [version, encoded, mac] = String(token).split('.');
  assert.equal(version, 'v2');
  assert.equal(mac, crypto.createHmac('sha256', SECRET).update(`${version}.${encoded}`).digest('base64url'), 'signed with the shared secret');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (path !== undefined) assert.equal(payload.p, path, 'bound to the path it was sent to');
  if (body !== undefined) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    assert.equal(payload.bh, crypto.createHash('sha256').update(raw, 'utf8').digest('hex'), 'bound to the exact body');
  }
  return payload;
}

const rpc = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

async function mcp(key, body) {
  const res = await supertest(app)
    .post('/mcp')
    .set('X-Agent-API-Key', key)
    .set('X-Test-User-Ref', `usr_${key.slice(8, 10)}`)
    .set('X-Test-Acp-Session-Id', `acp_${key.slice(8, 10)}`)
    .set('Accept', 'application/json, text/event-stream')
    .send(body);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  assert.ok(res.body.result, JSON.stringify(res.body).slice(0, 400));
  assert.notEqual(res.body.result.isError, true, JSON.stringify(res.body.result).slice(0, 600));
  return res.body.result.structuredContent ?? JSON.parse(res.body.result.content[0].text);
}

// ---- search: one cached search, a click id per response --------------------------------------------------

const RAW_DESTINATION = 'https://shop-a.example.com/products/serum-x';

function seedSearchPage() {
  return {
    status: 'success',
    success: true,
    products: [{
      product_id: 'ext_serum_x', merchant_id: 'external_seed', title: 'Serum X', price: 20, currency: 'USD',
      source: 'external_seed', platform: 'external', external_seed_id: 'seed_serum_x', destination_url: RAW_DESTINATION,
    }],
    total: 1,
  };
}

function interceptSearch() {
  const state = { loopbackHeaders: [], mints: [] };
  nock(LOOPBACK)
    .persist()
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
    .reply(function reply() {
      state.loopbackHeaders.push({ ...this.req.headers });
      return [200, seedSearchPage()];
    });
  nock(BACKEND)
    .persist()
    .post('/agent/shop/v1/attribution/external-seed-links')
    .reply(function reply(_uri, body) {
      const n = state.mints.length + 1;
      state.mints.push({ headers: { ...this.req.headers }, body });
      const clickId = `clk_${n}`;
      return [200, { links: [{
        external_seed_id: 'seed_serum_x',
        external_redirect_url: `https://api.example.com/r?token=payload${n}.sig${n}`,
        // `sig=` is a query secret the result sanitizer scrubs: the stamped answer takes the same pass a fresh
        // result takes, so it must not reach the agent.
        destination_url: `${RAW_DESTINATION}?pvt_click_id=${clickId}&sig=leak${n}`,
        cart_url: null,
        tracking: { click_id: clickId, param: 'pvt_click_id', join_mode: 'referral_only' },
      }] }];
    });
  return state;
}

const cardOf = (result) => (result.products || result.data?.products || [])[0];

test('flag on: two partners served one cached search each get their own click id, minted for them', async () => {
  setFlag(true);
  nock.cleanAll();
  introspect();
  const state = interceptSearch();
  try {
    const query = `partner-identity-probe-${process.pid}-on`;
    const resultA = await mcp(KEY_A, rpc('search_catalog', { query, market: 'US' }));
    const resultB = await mcp(KEY_B, rpc('search_catalog', { query, market: 'US' }, 2));
    const a = cardOf(resultA);
    const b = cardOf(resultB);
    for (const r of [resultA, resultB]) {
      assert.deepEqual(r.metadata?.external_seed_attribution, { candidates: 1, stamped: 1 }, 'counted as the in-search mint was');
    }

    assert.equal(state.loopbackHeaders.length, 1, 'the second search is a cache hit');
    assert.equal(state.loopbackHeaders[0]['x-pivota-seed-attribution'], 'deferred', 'the cached search mints nothing');
    assert.equal(state.loopbackHeaders[0]['x-pivota-issuing-agent'], undefined, 'the cached lane names no caller');

    assert.equal(state.mints.length, 2, 'one mint per response, after the cache');
    const [ma, mb] = state.mints.map((m) => assertionOf(m.headers, { path: '/agent/shop/v1/attribution/external-seed-links', body: m.body }));
    assert.notEqual(ma.jti, mb.jti, 'one nonce per mint');
    assert.deepEqual([ma.kind, ma.sub, ma.op], ['agent', PARTNER_A, 'external_seed_links.mint']);
    assert.deepEqual([mb.kind, mb.sub, mb.op], ['agent', PARTNER_B, 'external_seed_links.mint']);
    for (const m of state.mints) {
      assert.equal(m.headers['x-api-key'], 'gateway-service-key', 'the mint still goes out on the internal key');
      assert.equal(m.headers['x-buyer-ref'], undefined);
      assert.equal(m.body.candidates[0].destination_url, RAW_DESTINATION, 'minted from the raw cached card');
      assert.equal(m.body.market, 'US', "the request's market rides the mint, as on the in-search mint");
      assert.equal(m.body.tool, 'find_products_multi');
    }

    assert.equal(a.tracking.click_id, 'clk_1');
    assert.equal(b.tracking.click_id, 'clk_2');
    assert.equal(a.external_redirect_url, 'https://api.example.com/r?token=payload1.sig1');
    assert.equal(b.external_redirect_url, 'https://api.example.com/r?token=payload2.sig2');
    assert.ok(!JSON.stringify(b).includes('clk_1'), "partner-b's response carries nothing of partner-a's click");
    for (const card of [a, b]) {
      assert.ok(card.destination_url.startsWith(`${RAW_DESTINATION}?pvt_click_id=clk_`), card.destination_url);
      assert.ok(!card.destination_url.includes('leak'), 'the stamped answer is sanitized like a fresh one');
    }

    // A third response, partner-a again: still a fresh click, never a replay of an earlier one.
    const a2 = cardOf(await mcp(KEY_A, rpc('search_catalog', { query, market: 'US' }, 3)));
    assert.equal(state.loopbackHeaders.length, 1);
    assert.equal(a2.tracking.click_id, 'clk_3');
  } finally {
    nock.cleanAll();
    setFlag(false);
  }
});

test('flag off: the cached search is not deferred and no per-response mint is made', async () => {
  setFlag(false);
  nock.cleanAll();
  introspect();
  const state = interceptSearch();
  try {
    const query = `partner-identity-probe-${process.pid}-off`;
    const a = cardOf(await mcp(KEY_A, rpc('search_catalog', { query })));
    const b = cardOf(await mcp(KEY_B, rpc('search_catalog', { query }, 2)));
    assert.equal(state.loopbackHeaders.length, 1);
    assert.equal(state.loopbackHeaders[0]['x-pivota-seed-attribution'], undefined);
    assert.equal(state.mints.length, 0);
    assert.deepEqual(a, b, 'one cached answer for both, as before');
    assert.equal(a.external_redirect_url, undefined);
  } finally {
    nock.cleanAll();
  }
});

// ---- money: quote, order and hosted link carry the partner that made them ----------------------------------

function interceptMoney() {
  const calls = [];
  let n = 0;
  const record = (path) => function reply(uri, body) {
    calls.push({ path, uri, headers: { ...this.req.headers }, body });
    n += 1;
    if (path === 'quote') {
      return [200, { quote: {
        quote_id: `q_${n}`, expires_at: '2099-12-31T00:00:00Z', currency: 'USD',
        price_breakdown: { subtotal: '29.00', discount_total: '0.00', total: '29.00', currency: 'USD' },
        shipping_breakdown: { shipping_fee: '0.00', delivery_options: [] }, tax_breakdown: { tax: '0.00' },
        line_items: [{ product_id: 'p_1', variant_id: 'v_1', quantity: 1 }],
      } }];
    }
    if (path === 'order') {
      return [200, { status: 'success', order: { order_id: `ORD_${n}`, amounts: { total: '29.00', currency: 'USD' } } }];
    }
    if (path === 'order_tracking') return [200, { status: 'success', tracking: { order_id: uri.split('/')[4], payment_status: 'awaiting_payment' } }];
    if (path === 'order_read') return [200, { status: 'success', order: { order_id: uri.split('/')[4], state: 'awaiting_checkout' } }];
    if (path === 'after_sales') return [200, { status: 'success', refund: { refund_id: `rf_${n}`, state: 'requested' } }];
    return [200, { status: 'success', checkout_session: {
      checkout_session_id: `cs_${n}`, hosted_url: `https://checkout.example.com/s/${n}`, state: 'created',
    } }];
  };
  nock(BACKEND).persist()
    .post('/agent/v2/quotes/preview').reply(record('quote'))
    .post('/agent/v2/orders').reply(record('order'))
    .post('/agent/v2/payments/checkout-sessions').reply(record('session'))
    // The kernel's order read: GET .../tracking, then GET the order (FIX_PLAN C-11, gateway half).
    .get(/\/agent\/v2\/orders\/[^/]+\/tracking$/).reply(record('order_tracking'))
    .get(/\/agent\/v2\/orders\/[^/]+$/).reply(record('order_read'))
    .post(/\/agent\/v2\/orders\/[^/]+\/refunds$/).reply(record('after_sales'));
  return calls;
}

const QUOTE = {
  merchant_id: 'm_shop_a',
  items: [{ product_id: 'p_1', variant_id: 'v_1', quantity: 1 }],
  customer_email: 'buyer@example.com',
  shipping_address: {
    name: 'Buyer', address_line1: '1 Example St', city: 'Example City', state: 'CA', postal_code: '94105', country: 'US',
  },
};

async function buyWithHostedLink(key, tag) {
  const session = await mcp(key, rpc('create_checkout_session', { idempotency_key: `idem_session_${tag}`, quote: QUOTE }));
  assert.ok(session.session_id, JSON.stringify(session).slice(0, 300));
  const link = await mcp(key, rpc('create_payment_link', {
    idempotency_key: `idem_link_${tag}`, session_id: session.session_id, customer_email: 'buyer@example.com',
  }, 2));
  // The order's follow-ups: the read and the after-sales request (the backend refuses to execute a refund
  // itself, D-03; what matters here is who the request is made as).
  await mcp(key, rpc('get_order', { order_id: link.order_id }, 3));
  await mcp(key, rpc('request_after_sales', {
    idempotency_key: `idem_after_${tag}`, status: { order_id: link.order_id, requested_action: 'refund', reason: 'damaged' },
  }, 4));
  return link;
}

test('flag on: each partner\'s quote, order and hosted link reach the backend signed for that partner', async () => {
  setFlag(true);
  nock.cleanAll();
  introspect();
  const calls = interceptMoney();
  try {
    const linkA = await buyWithHostedLink(KEY_A, 'on_a');
    const linkB = await buyWithHostedLink(KEY_B, 'on_b');
    assert.match(linkA.checkout_url, /^https:\/\/checkout\.example\.com\//);
    assert.match(linkB.checkout_url, /^https:\/\/checkout\.example\.com\//);

    const seen = calls.map((c) => {
      const a = assertionOf(c.headers, { path: c.uri.split('?')[0], body: c.body });
      return [c.path, a && a.sub, a && a.op, a && a.rid, c.headers['x-api-key']];
    });
    const orderOf = (i) => calls.filter((c) => c.path === 'order')[i];
    const ridOf = (i) => JSON.parse(JSON.stringify(orderOf(i).body)).quote_id;
    const steps = (partner, i) => [
      ['quote', partner, 'preview_quote', null, 'gateway-service-key'],
      ['order', partner, 'create_order', ridOf(i), 'gateway-service-key'],
      ['session', partner, 'create_payment_link', calls.filter((c) => c.path === 'session')[i].body.order_id, 'gateway-service-key'],
      // The kernel's order read (two GETs on the order routes) is not a partner-identity op: unsigned.
      ['order_tracking', null, null, null, 'gateway-service-key'],
      ['order_read', null, null, null, 'gateway-service-key'],
      ['after_sales', partner, 'request_after_sales', calls.filter((c) => c.path === 'after_sales')[i].uri.split('/')[4], 'gateway-service-key'],
    ];
    assert.deepEqual(seen, [...steps(PARTNER_A, 0), ...steps(PARTNER_B, 1)]);
    assert.ok(ridOf(0) && ridOf(1), 'the order names the quote it is created from');
    const nonces = calls.map((c) => c.headers['x-pivota-issuing-agent']).filter(Boolean)
      .map((t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')).jti);
    assert.equal(new Set(nonces).size, nonces.length, 'every signed call has its own nonce');
  } finally {
    nock.cleanAll();
    setFlag(false);
  }
});

test('flag off: the same money calls carry no partner assertion (the upstream sees only the gateway)', async () => {
  setFlag(false);
  nock.cleanAll();
  introspect();
  const calls = interceptMoney();
  try {
    await buyWithHostedLink(KEY_A, 'off_a');
    assert.deepEqual(calls.map((c) => c.path), ['quote', 'order', 'session', 'order_tracking', 'order_read', 'after_sales']);
    for (const c of calls) {
      assert.equal(c.headers['x-pivota-issuing-agent'], undefined, c.path);
      assert.equal(c.headers['x-api-key'], 'gateway-service-key');
    }
  } finally {
    nock.cleanAll();
  }
});
