'use strict';

// MCP get_order and cancel_checkout_session, end to end over the real /mcp door.
//
// get_order (the kernel's get_order_status) used to fall through to POST /agent/shop/v1/invoke, which the backend
// answers "Unsupported operation", so no partner could ever read an order. It reads the backend's own order routes
// now. cancel_checkout_session flipped only the gateway row (FIX_PLAN C-11); behind CHECKOUT_CANCEL_UPSTREAM_ENABLED
// it answers what the backend's cancel did.
//
// Real: the /mcp door, api-key introspection (two agents), the strict kernel (in-memory stores), the commerce tool
// surface and the kernel's upstream dispatcher. Stubbed: the network edges only (introspection and the backend, via
// nock). The backend's answers are tests/fixtures/backend_agent_v2_order_routes.backend.json, captured from the
// real backend routes (see its `generated_from`), so the replies here are what the producer emits.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const BACKEND = 'http://backend.get-order-door.test';
const INTROSPECT_BASE = 'https://auth.get-order-door.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const GATEWAY_KEY = 'gateway-service-key-get-order';
const OWNER_KEY = `ak_live_${'e'.repeat(64)}`;
const OTHER_KEY = `ak_live_${'f'.repeat(64)}`;

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'backend_agent_v2_order_routes.backend.json'), 'utf8'),
);
const ORDER_ID = FIXTURE.order_read.order.body.order.order_id;

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.AGENT_CHECKOUT_HOSTED_LINK_ENABLED = '1';
process.env.PIVOTA_API_KEY = GATEWAY_KEY;
process.env.PIVOTA_API_BASE = BACKEND;
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
process.env.AGENT_AUTH_INTROSPECT_TIMEOUT_MS = '1200';
process.env.INVOKE_AUTH_BYPASS_IN_TEST = '0';
delete process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED;
delete process.env.MCP_OAUTH_ENABLED;
delete process.env.PUBLIC_READ_MCP_ENABLED;
delete process.env.DATABASE_URL;

const app = require('../src/server');

test.after(() => {
  nock.cleanAll();
  process.env = { ...ORIGINAL_ENV };
});

for (const [key, agentId] of [[OWNER_KEY, 'agent_partner_a'], [OTHER_KEY, 'agent_partner_b']]) {
  nock(INTROSPECT_BASE)
    .persist()
    .post(INTROSPECT_PATH, (body) => body && body.api_key === key)
    .reply(200, { valid: true, agent_id: agentId, is_active: true, auth_source: 'api_keys' });
}

const BUYER = { user: 'usr_door_buyer', session: 'acp_door_session' };

async function tool(name, args, { key = OWNER_KEY, buyer = BUYER } = {}) {
  const res = await supertest(app)
    .post('/mcp')
    .set('X-Agent-API-Key', key)
    .set('X-Test-User-Ref', buyer.user)
    .set('X-Test-Acp-Session-Id', buyer.session)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  const text = res.body?.result?.content?.[0]?.text;
  return { isError: res.body?.result?.isError === true, body: text ? JSON.parse(text) : null, raw: text };
}

// Every request that reaches the backend, with its headers.
function backend(routes) {
  const seen = [];
  for (const [method, pathname, status, body] of routes) {
    nock(BACKEND)[method](pathname).reply(function reply(uri, requestBody) {
      seen.push({ method: method.toUpperCase(), path: uri, headers: this.req.headers, body: requestBody });
      return [status, body];
    });
  }
  return seen;
}

const ADDRESS = {
  name: 'Buyer A', address_line1: '1 Example St', city: 'Example City', postal_code: '00000', country: 'US',
};

let seq = 0;
// A kernel order, made the way a partner makes one: a checkout session, then a hosted payment link.
async function placeOrder({ key = OWNER_KEY, buyer = BUYER } = {}) {
  seq += 1;
  backend([
    ['post', '/agent/v2/quotes/preview', 200, {
      quote: {
        quote_id: `q_door_${seq}`,
        expires_at: '2030-12-31T00:00:00Z',
        currency: 'USD',
        price_breakdown: { subtotal: '29.00', discount_total: '0.00', total: '29.00', currency: 'USD' },
        shipping_breakdown: { shipping_fee: '0.00', delivery_options: [] },
        tax_breakdown: { tax: '0.00' },
        line_items: [{ product_id: 'p_1', variant_id: 'v_1', quantity: 1 }],
      },
    }],
  ]);
  const session = await tool('create_checkout_session', {
    idempotency_key: `idem_door_session_${seq}`,
    quote: {
      merchant_id: 'm_shop_a',
      customer_email: 'buyer@example.com',
      items: [{ product_id: 'p_1', variant_id: 'v_1', quantity: 1 }],
      shipping_address: ADDRESS,
    },
  }, { key, buyer });
  assert.equal(session.isError, false, session.raw);
  backend([
    ['post', '/agent/v2/orders', 200, {
      status: 'success',
      order: { order_id: ORDER_ID, quote_id: `q_door_${seq}`, amounts: { total: '29.00', currency: 'USD' } },
    }],
    ['post', '/agent/v2/payments/checkout-sessions', 200, {
      status: 'success',
      checkout_session: {
        checkout_session_id: `ci_door_${seq}`,
        order_id: ORDER_ID,
        state: 'created',
        hosted_url: 'https://checkout.example.com/order?checkout_token=placeholder',
        provider: 'pivota_hosted_checkout',
      },
    }],
  ]);
  const link = await tool('create_payment_link', {
    idempotency_key: `idem_door_link_${seq}`,
    session_id: session.body.session_id,
    customer_email: 'buyer@example.com',
    shipping_address: ADDRESS,
  }, { key, buyer });
  assert.equal(link.isError, false, link.raw);
  assert.equal(link.body.order_id, ORDER_ID);
  nock.cleanAll();
  for (const [k, agentId] of [[OWNER_KEY, 'agent_partner_a'], [OTHER_KEY, 'agent_partner_b']]) {
    nock(INTROSPECT_BASE).persist().post(INTROSPECT_PATH, (b) => b && b.api_key === k)
      .reply(200, { valid: true, agent_id: agentId, is_active: true, auth_source: 'api_keys' });
  }
  return { session_id: session.body.session_id, order_id: ORDER_ID };
}

function orderReadRoutes() {
  const { order, tracking } = FIXTURE.order_read;
  return backend([
    ['get', `/agent/v2/orders/${ORDER_ID}/tracking`, tracking.status, tracking.body],
    ['get', `/agent/v2/orders/${ORDER_ID}`, order.status, order.body],
  ]);
}

// ---- get_order -----------------------------------------------------------------------------------------------

test('get_order: the owner reads the order from the backend order routes, on the kernel\'s own headers', async () => {
  await placeOrder();
  const seen = orderReadRoutes();

  const res = await tool('get_order', { order_id: ORDER_ID });

  assert.equal(res.isError, false, res.raw);
  assert.equal(res.body.status, 'awaiting_checkout', 'the order state, not the envelope "success"');
  assert.equal(res.body.order_id, ORDER_ID);
  assert.equal(res.body.payment_status, 'awaiting_payment');
  assert.equal(res.body.delivery_status, 'not_shipped');
  assert.equal(res.body.total, '29.00');
  assert.equal(res.body.currency, 'USD');
  assert.deepEqual(res.body.pricing, FIXTURE.order_read.tracking.body.tracking.pricing);
  assert.deepEqual(seen.map((r) => `${r.method} ${r.path}`), [
    `GET /agent/v2/orders/${ORDER_ID}/tracking`,
    `GET /agent/v2/orders/${ORDER_ID}`,
  ]);
  for (const r of seen) assert.equal(r.headers['x-api-key'], GATEWAY_KEY, 'buildInvokeUpstreamAuthHeaders, as every kernel op');
  // The order body carries the buyer's contact and address and the PSP client secret: none of it is answered.
  for (const leak of ['buyer@example.com', '1 Example St', 'cs_capture_fake_secret_not_real', 'client_secret', 'buyer_context']) {
    assert.ok(!res.raw.includes(leak), `${leak} is not in the answer`);
  }
  nock.cleanAll();
});

test('get_order answers the shape the REST invoke lane answers for get_order_status', async () => {
  await placeOrder();
  orderReadRoutes();
  const mcp = await tool('get_order', { order_id: ORDER_ID });
  const { tracking } = FIXTURE.order_read;
  nock(BACKEND).get(`/agent/v2/orders/${ORDER_ID}/tracking`).reply(tracking.status, tracking.body);
  const invoke = await supertest(app)
    .post('/agent/shop/v1/invoke')
    .set('X-Agent-API-Key', OWNER_KEY)
    .send({ operation: 'get_order_status', payload: { status: { order_id: ORDER_ID } } });
  assert.equal(invoke.status, 200, JSON.stringify(invoke.body).slice(0, 300));
  const restLane = { ...invoke.body };
  delete restLane.metadata;
  delete restLane.gateway_request_id;
  const sameKeys = Object.keys(restLane).filter((k) => k in mcp.body);
  assert.ok(sameKeys.length >= 10, 'the two lanes share the projection');
  for (const k of sameKeys) {
    if (k === 'status') continue; // the one difference: the order's state instead of the envelope's "success"
    assert.deepEqual(mcp.body[k], restLane[k], k);
  }
  assert.equal(restLane.status, 'success');
  nock.cleanAll();
});

test('get_order: another agent, with the same buyer and session, is told not found and nothing is read', async () => {
  await placeOrder();
  const seen = orderReadRoutes();
  const res = await tool('get_order', { order_id: ORDER_ID }, { key: OTHER_KEY });
  assert.equal(res.isError, true);
  assert.equal(res.body.error.code, 'QUOTE_NOT_FOUND');
  assert.equal(seen.length, 0, 'no backend read for a foreign order');
  nock.cleanAll();
});

test('get_order: another buyer of the same agent is told not found', async () => {
  await placeOrder();
  const seen = orderReadRoutes();
  const res = await tool('get_order', { order_id: ORDER_ID }, { buyer: { user: 'usr_door_other', session: 'acp_door_other' } });
  assert.equal(res.body.error.code, 'QUOTE_NOT_FOUND');
  assert.equal(seen.length, 0);
  nock.cleanAll();
});

test('get_order: an unknown id is not found, without a backend read', async () => {
  const seen = orderReadRoutes();
  const res = await tool('get_order', { order_id: 'ORD_NEVER_PLACED' });
  assert.equal(res.isError, true);
  assert.equal(res.body.error.code, 'QUOTE_NOT_FOUND');
  assert.equal(seen.length, 0);
  nock.cleanAll();
});

test('get_order: an order the backend no longer has is not found, not "try again"', async () => {
  await placeOrder();
  const { unknown_tracking: gone } = FIXTURE.order_read;
  backend([['get', `/agent/v2/orders/${ORDER_ID}/tracking`, gone.status, gone.body]]);
  const res = await tool('get_order', { order_id: ORDER_ID });
  assert.equal(res.body.error.code, 'QUOTE_NOT_FOUND');
  nock.cleanAll();
});

// ---- cancel_checkout_session ----------------------------------------------------------------------------------

function cancelRoute(answer) {
  const { status, body } = FIXTURE.cancel[answer];
  return backend([['post', `/agent/v2/orders/${ORDER_ID}/cancel`, status, body]]);
}

async function cancel(args, opts) {
  return tool('cancel_checkout_session', { idempotency_key: `idem_door_cancel_${(seq += 1)}`, ...args }, opts);
}

test('flag off: cancel answers exactly as before, and calls nothing upstream', async () => {
  delete process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED;
  const { order_id, session_id } = await placeOrder();
  const seen = cancelRoute('canceled');
  const res = await cancel({ order_id, session_id });
  assert.equal(res.isError, false);
  assert.deepEqual(res.body, { session_id, order_id, status: 'canceled' });
  assert.equal(seen.length, 0);
  nock.cleanAll();
});

test('flag on: the backend cancelled it, so the answer is canceled', async () => {
  process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED = '1';
  try {
    const { order_id, session_id } = await placeOrder();
    const seen = cancelRoute('canceled');
    const res = await cancel({ order_id, session_id });
    assert.equal(res.isError, false, res.raw);
    assert.deepEqual(res.body, { session_id, order_id, status: 'canceled' }, 'the existing result shape');
    assert.deepEqual(seen.map((r) => `${r.method} ${r.path}`), [`POST /agent/v2/orders/${ORDER_ID}/cancel`]);
    assert.equal(seen[0].headers['x-api-key'], GATEWAY_KEY);
  } finally {
    delete process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED;
    nock.cleanAll();
  }
});

for (const [answer, code, reason, retriable] of [
  ['not_canceled_paid', 'OPERATION_NOT_ALLOWED', 'order_paid_not_canceled', false],
  ['not_canceled_processing', 'OPERATION_NOT_ALLOWED', 'payment_processing_not_canceled', false],
  ['not_confirmed', 'MERCHANT_UNAVAILABLE', 'cancel_not_confirmed', true],
  ['route_off', 'MERCHANT_UNAVAILABLE', 'cancel_not_confirmed', true],
]) {
  test(`flag on: backend "${answer}" is never answered as canceled`, async () => {
    process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED = '1';
    try {
      const { order_id, session_id } = await placeOrder();
      cancelRoute(answer);
      const res = await cancel({ order_id, session_id });
      assert.equal(res.isError, true, res.raw);
      assert.equal(res.body.error.code, code);
      assert.equal(res.body.error.retriable, retriable);
      assert.deepEqual(res.body.error.detail, { reason, canceled: false });
      assert.match(res.body.error.recovery, /do not tell the buyer the order was canceled|retry with the same idempotency_key/);
      if (answer === 'not_canceled_paid') {
        assert.match(res.body.error.message, /already paid/);
        assert.match(res.body.error.recovery, /merchant/);
        assert.doesNotMatch(res.raw, /refund_id|refunded/);
      }
    } finally {
      delete process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED;
      nock.cleanAll();
    }
  });
}

test('flag on: an upstream that does not answer is not confirmed', async () => {
  process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED = '1';
  try {
    const { order_id } = await placeOrder();
    nock(BACKEND).post(`/agent/v2/orders/${ORDER_ID}/cancel`).replyWithError('socket hang up');
    const res = await cancel({ order_id });
    assert.equal(res.body.error.code, 'MERCHANT_UNAVAILABLE');
    assert.equal(res.body.error.detail.reason, 'cancel_not_confirmed');
  } finally {
    delete process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED;
    nock.cleanAll();
  }
});

test('flag on: a foreign agent\'s cancel is refused as not found and reaches nothing', async () => {
  process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED = '1';
  try {
    const { order_id } = await placeOrder();
    const seen = cancelRoute('canceled');
    const res = await cancel({ order_id }, { key: OTHER_KEY });
    assert.equal(res.body.error.code, 'QUOTE_NOT_FOUND');
    assert.equal(seen.length, 0);
    const unknown = await cancel({ order_id: 'ORD_NEVER_PLACED' });
    assert.equal(unknown.body.error.code, 'QUOTE_NOT_FOUND', 'an untracked id is no longer answered "canceled"');
  } finally {
    delete process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED;
    nock.cleanAll();
  }
});

test('flag on: a session-only cancel makes the session unusable, and says so when it already became an order', async () => {
  process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED = '1';
  try {
    // A session that never became an order.
    seq += 1;
    backend([['post', '/agent/v2/quotes/preview', 200, {
      quote: {
        quote_id: `q_door_${seq}`, expires_at: '2030-12-31T00:00:00Z', currency: 'USD',
        price_breakdown: { subtotal: '29.00', discount_total: '0.00', total: '29.00', currency: 'USD' },
        shipping_breakdown: { shipping_fee: '0.00', delivery_options: [] }, tax_breakdown: { tax: '0.00' },
        line_items: [{ product_id: 'p_1', variant_id: 'v_1', quantity: 1 }],
      },
    }]]);
    const session = await tool('create_checkout_session', {
      idempotency_key: `idem_door_session_${seq}`,
      quote: { merchant_id: 'm_shop_a', customer_email: 'buyer@example.com', items: [{ product_id: 'p_1', variant_id: 'v_1', quantity: 1 }], shipping_address: ADDRESS },
    });
    const canceled = await cancel({ session_id: session.body.session_id });
    assert.deepEqual(canceled.body, { session_id: session.body.session_id, order_id: null, status: 'canceled' });
    const seen = backend([['post', '/agent/v2/orders', 200, {}]]);
    const link = await tool('create_payment_link', {
      idempotency_key: `idem_door_link_after_cancel_${seq}`, session_id: session.body.session_id,
      customer_email: 'buyer@example.com', shipping_address: ADDRESS,
    });
    assert.equal(link.body.error.code, 'QUOTE_ALREADY_USED', 'a canceled session can no longer become an order');
    assert.equal(seen.length, 0);
    nock.cleanAll();

    // A session that did become an order: cancelling the session alone is refused, naming why.
    const placed = await placeOrder();
    const sessionOnly = await cancel({ session_id: placed.session_id });
    assert.equal(sessionOnly.body.error.code, 'OPERATION_NOT_ALLOWED');
    assert.deepEqual(sessionOnly.body.error.detail, { reason: 'session_already_ordered', canceled: false });
  } finally {
    delete process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED;
    nock.cleanAll();
  }
});
