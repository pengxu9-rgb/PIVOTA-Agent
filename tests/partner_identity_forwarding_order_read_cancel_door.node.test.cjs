'use strict';

// PARTNER-OWNED ORDERS ARE READ AND CANCELLED AS THEIR PARTNER (review 11-11 P2-A, audit 11-22 F5), end to end over
// the real /mcp door with PARTNER_IDENTITY_FORWARDING_ENABLED on.
//
// With forwarding on, the backend makes the partner that signed create_order the order's owner. The kernel's order
// read (get_order -> GET .../tracking, then GET the order) and its cancel (POST .../cancel) used to go UNSIGNED on
// this gateway's key, so at the backend the order was another agent's: /tracking's strict owner check answered 403,
// which the kernel turns into QUOTE_NOT_FOUND ("that quote is no longer available"): the agent re-quotes and a buyer
// can pay twice. They are signed now (get_order_status, cancel_order in PARTNER_IDENTITY_OPS).
//
// The backend stub below applies the backend's OWN rule with its flag on (pivota-backend routes/agent_v2.py and
// routes/agent_forwarded_owner.py): a create signed for a partner is that partner's; /tracking and /cancel serve the
// owner (a request signed for it, bound to that request); GET /orders/{id} also serves the vouching gateway unsigned.
// So this test FAILS on the gateway without the signing (QUOTE_NOT_FOUND) whatever the backend's own fix does.
//
// Real: the /mcp door, api-key introspection, the strict kernel (in-memory stores), the commerce surface, the kernel
// upstream and its per-attempt signer. Stubbed: introspection and the backend (nock), with the recorded answers of
// tests/fixtures/backend_agent_v2_order_routes.backend.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const BACKEND = 'http://backend.partner-order-read.test';
const INTROSPECT_BASE = 'https://auth.partner-order-read.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const GATEWAY_KEY = 'gateway-service-key-partner-order-read';
const SECRET = 'partner_order_read_test_secret';
const FLAG = 'PARTNER_IDENTITY_FORWARDING_ENABLED';
const KEY_A = `ak_live_${'c'.repeat(64)}`;
const PARTNER_A = 'agent_partner_a';
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
process.env.ISSUING_AGENT_ASSERTION_SECRET = SECRET;
process.env[FLAG] = '1';
delete process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED;
delete process.env.MCP_OAUTH_ENABLED;
delete process.env.PUBLIC_READ_MCP_ENABLED;
delete process.env.DATABASE_URL;

const app = require('../src/server');

test.after(() => {
  nock.cleanAll();
  process.env = { ...ORIGINAL_ENV };
});

function introspect() {
  nock(INTROSPECT_BASE).persist().post(INTROSPECT_PATH, (body) => body && body.api_key === KEY_A)
    .reply(200, { valid: true, agent_id: PARTNER_A, is_active: true, auth_source: 'api_keys' });
}

const BUYER = { user: 'usr_partner_order_read', session: 'acp_partner_order_read' };

async function tool(name, args) {
  const res = await supertest(app)
    .post('/mcp')
    .set('X-Agent-API-Key', KEY_A)
    .set('X-Test-User-Ref', BUYER.user)
    .set('X-Test-Acp-Session-Id', BUYER.session)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  const text = res.body?.result?.content?.[0]?.text;
  return { isError: res.body?.result?.isError === true, body: text ? JSON.parse(text) : null, raw: text };
}

// The v2 assertion on one request, verified as the backend verifies it: MAC, op, the path and the body it was sent
// with, and the resource it names. null when the request carries none or it does not verify for that request.
function verifiedPartner(headers, { op, path: sentPath, rid, raw }) {
  const token = headers['x-pivota-issuing-agent'];
  if (!token) return null;
  const [version, encoded, mac] = String(token).split('.');
  if (version !== 'v2') return null;
  if (mac !== crypto.createHmac('sha256', SECRET).update(`${version}.${encoded}`).digest('base64url')) return null;
  const p = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const bh = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  if (p.op !== op || p.p !== sentPath || p.rid !== rid || p.bh !== bh) return null;
  return p.sub;
}

// The backend with its forwarding flag on: who owns the order, and who each order route serves.
function backendWithTheOwnerRule() {
  const seen = [];
  const state = { owner: null };
  const raw = (body) => (body === undefined || body === '' ? '' : (typeof body === 'string' ? body : JSON.stringify(body)));
  let n = 0;
  nock(BACKEND).persist()
    .post('/agent/v2/quotes/preview').reply(function preview() {
      n += 1;
      return [200, { quote: {
        quote_id: `q_por_${n}`, expires_at: '2030-12-31T00:00:00Z', currency: 'USD',
        price_breakdown: { subtotal: '29.00', discount_total: '0.00', total: '29.00', currency: 'USD' },
        shipping_breakdown: { shipping_fee: '0.00', delivery_options: [] }, tax_breakdown: { tax: '0.00' },
        line_items: [{ product_id: 'p_1', variant_id: 'v_1', quantity: 1 }],
      } }];
    })
    .post('/agent/v2/orders').reply(function create(uri, body) {
      const partner = verifiedPartner(this.req.headers, { op: 'create_order', path: uri, rid: body.quote_id, raw: raw(body) });
      state.owner = partner || 'gateway';
      seen.push(`POST orders owner=${state.owner}`);
      return [200, { status: 'success', order: { order_id: ORDER_ID, quote_id: body.quote_id, amounts: { total: '29.00', currency: 'USD' } } }];
    })
    .post('/agent/v2/payments/checkout-sessions').reply(200, {
      status: 'success',
      checkout_session: { checkout_session_id: 'ci_por', order_id: ORDER_ID, state: 'created',
        hosted_url: 'https://checkout.example.com/order?checkout_token=placeholder', provider: 'pivota_hosted_checkout' },
    })
    .get(`/agent/v2/orders/${ORDER_ID}/tracking`).reply(function tracking(uri) {
      const caller = verifiedPartner(this.req.headers, { op: 'get_order_status', path: uri, rid: ORDER_ID, raw: '' }) || 'gateway';
      seen.push(`GET tracking as=${caller}`);
      // Strict owner (the backend before its own /tracking fix): only the owner is served.
      if (caller !== state.owner) return [403, { detail: 'Not authorized for this order' }];
      return [FIXTURE.order_read.tracking.status, FIXTURE.order_read.tracking.body];
    })
    .get(`/agent/v2/orders/${ORDER_ID}`).reply(function read(uri) {
      const caller = verifiedPartner(this.req.headers, { op: 'get_order_status', path: uri, rid: ORDER_ID, raw: '' }) || 'gateway';
      seen.push(`GET order as=${caller}`);
      // order_access_allowed: the owner, or the vouching gateway unsigned.
      if (caller !== state.owner && caller !== 'gateway') return [403, { detail: 'Not authorized for this order' }];
      return [FIXTURE.order_read.order.status, FIXTURE.order_read.order.body];
    })
    .post(`/agent/v2/orders/${ORDER_ID}/cancel`).reply(function cancelRoute(uri, body) {
      const caller = verifiedPartner(this.req.headers, { op: 'cancel_order', path: uri, rid: ORDER_ID, raw: raw(body) }) || 'gateway';
      seen.push(`POST cancel as=${caller}`);
      // Strict owner (the backend's cancel before its own fix): another agent's order is not found.
      if (caller !== state.owner) return [FIXTURE.cancel.not_found.status, FIXTURE.cancel.not_found.body];
      return [FIXTURE.cancel.canceled.status, FIXTURE.cancel.canceled.body];
    });
  return { seen, state };
}

let seq = 0;
async function placeOrderAsPartnerA() {
  seq += 1;
  const session = await tool('create_checkout_session', {
    idempotency_key: `idem_por_session_${seq}`,
    quote: {
      merchant_id: 'm_shop_a', customer_email: 'buyer@example.com',
      items: [{ product_id: 'p_1', variant_id: 'v_1', quantity: 1 }],
      shipping_address: { name: 'Buyer A', address_line1: '1 Example St', city: 'Example City', postal_code: '00000', country: 'US' },
    },
  });
  assert.equal(session.isError, false, session.raw);
  const link = await tool('create_payment_link', {
    idempotency_key: `idem_por_link_${seq}`, session_id: session.body.session_id, customer_email: 'buyer@example.com',
  });
  assert.equal(link.isError, false, link.raw);
  return { session_id: session.body.session_id, order_id: link.body.order_id };
}

test('flag on: the partner reads its own order back (no QUOTE_NOT_FOUND), both GETs signed for it', async () => {
  nock.cleanAll();
  introspect();
  const { seen, state } = backendWithTheOwnerRule();
  try {
    const { order_id } = await placeOrderAsPartnerA();
    assert.equal(state.owner, PARTNER_A, 'the backend made the partner the owner on create');
    const res = await tool('get_order', { order_id });
    assert.equal(res.isError, false, res.raw);
    assert.notEqual(res.body?.error?.code, 'QUOTE_NOT_FOUND');
    assert.equal(res.body.order_id, ORDER_ID);
    assert.equal(res.body.status, 'awaiting_checkout');
    assert.deepEqual(seen.filter((s) => s.startsWith('GET')), [`GET tracking as=${PARTNER_A}`, `GET order as=${PARTNER_A}`]);
  } finally {
    nock.cleanAll();
  }
});

test('flag on, cancel on: the partner cancels its own order, signed for it, and it is canceled', async () => {
  process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED = '1';
  nock.cleanAll();
  introspect();
  const { seen } = backendWithTheOwnerRule();
  try {
    const { order_id, session_id } = await placeOrderAsPartnerA();
    const res = await tool('cancel_checkout_session', { idempotency_key: `idem_por_cancel_${seq}`, order_id, session_id });
    assert.equal(res.isError, false, res.raw);
    assert.deepEqual(res.body, { session_id, order_id, status: 'canceled' });
    assert.deepEqual(seen.filter((s) => s.startsWith('POST cancel')), [`POST cancel as=${PARTNER_A}`]);
  } finally {
    delete process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED;
    nock.cleanAll();
  }
});
