'use strict';

// get_order over ONE dispatch, for all four order-id shapes, end to end over the real POST /mcp door (and the REST
// invoke door for the one shape it serves). Status review P1-1 / build item 3.
//
//   shape                  reader                                        a foreign partner gets
//   plain kernel order     the kernel's record, then GET /agent/v2/orders  QUOTE_NOT_FOUND, nothing read upstream
//   pp_ / rp_ purchase     GET /agent/v2/commerce/purchases/{id}           QUOTE_NOT_FOUND (backend 404)
//   esc_ hand-off          POST /agent/v2/storefront-handoffs/read         STATE_LINKAGE_MISMATCH (backend 409)
//
// Real: the /mcp and /agent/shop/v1/invoke doors, api-key introspection (three agents), the strict kernel (in-memory
// stores), the commerce tool surface, the canonical executor's get_order dispatch, the purchase read client, the
// hand-off client (with its request-bound partner assertion) and the kernel's upstream dispatcher. Stubbed: the
// network edges only (introspection and the backend, via nock).
//
// THE BACKEND'S ANSWERS ARE RECORDED, NOT HAND-WRITTEN (status review P2-6): every body and status below is read
// from tests/fixtures/backend_get_order_unified.backend.json, recorded from the merged C-11 + O-02 backend (see its
// `generated_from`). The stubs decide only WHICH recorded answer a request gets, by the backend's own rule for that
// route: the order routes by the calling key's agent, the purchase read by the calling agent key AND buyer token,
// the hand-off read by the partner the verified assertion names.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const BACKEND = 'http://backend.get-order-unified.test';
const INTROSPECT_BASE = 'https://auth.get-order-unified.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const GATEWAY_KEY = 'gateway-service-key-get-order-unified';
const SECRET = 'get_order_unified_assertion_secret_fake';
const KEY_A = `ak_live_${'a'.repeat(64)}`;
const KEY_B = `ak_live_${'b'.repeat(64)}`;
const KEY_ROW_OWNER = `ak_live_${'9'.repeat(64)}`;
const PARTNER_A = 'agent_partner_a';
const PARTNER_B = 'agent_partner_b';
// Buyers sign in with a real (test-issuer) user token: the purchase read forwards it, and the strict door derives the
// buyer from it. One throwaway P-256 key per run; nothing here is a real credential.
const BUYER_ISS = 'https://buyer-idp.get-order-unified.test';
const BUYER_AUD = 'https://agent.get-order-unified.test/mcp';
const BUYER_KEY = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const BUYER_JWK = { ...BUYER_KEY.publicKey.export({ format: 'jwk' }), kid: 'buyer-unified-k1', alg: 'ES256' };
let BUYER_JWT = null;
let OTHER_BUYER_JWT = null;
async function buyerToken(sub) {
  const { SignJWT } = await import('jose');
  return new SignJWT({ email: `${sub}@example.com`, email_verified: true })
    .setProtectedHeader({ alg: 'ES256', kid: BUYER_JWK.kid })
    .setIssuer(BUYER_ISS).setAudience(BUYER_AUD).setSubject(sub)
    .setIssuedAt().setExpirationTime('30m')
    .sign(BUYER_KEY.privateKey);
}
const LANE_FLAGS = ['AGENT_PURCHASE_ORDER_READ_ENABLED', 'UCP_STOREFRONT_HANDOFF_RECORD_ENABLED', 'PARTNER_IDENTITY_FORWARDING_ENABLED'];

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'backend_get_order_unified.backend.json'), 'utf8'),
);
const ORDER_ID = FIXTURE.order_read.order.body.order.order_id;
const ROW_OWNER_AGENT = FIXTURE.order_read.order.body.order.audit.agent_id;
const { purchase_id: PP_ID, rail_purchase_id: RP_ID } = FIXTURE.purchase_read;
const { escalation_id: ESC_ID, record_id: RECORD_ID } = FIXTURE.handoff_read;

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
process.env.IDENTITY_ISSUERS_JSON = JSON.stringify([{ iss: BUYER_ISS, aud: BUYER_AUD, jwks: { keys: [BUYER_JWK] }, algs: ['ES256'] }]);
for (const flag of LANE_FLAGS) delete process.env[flag];
delete process.env.CHECKOUT_CANCEL_UPSTREAM_ENABLED;
delete process.env.MCP_OAUTH_ENABLED;
delete process.env.PUBLIC_READ_MCP_ENABLED;
delete process.env.DATABASE_URL;

const app = require('../src/server');

test.before(async () => {
  BUYER_JWT = await buyerToken('buyer-a');
  OTHER_BUYER_JWT = await buyerToken('buyer-b');
});

test.after(() => {
  nock.cleanAll();
  process.env = { ...ORIGINAL_ENV };
});

function lanes(on) {
  for (const flag of LANE_FLAGS) {
    if (on) process.env[flag] = '1'; else delete process.env[flag];
  }
}

const AGENT_OF_KEY = { [KEY_A]: PARTNER_A, [KEY_B]: PARTNER_B, [KEY_ROW_OWNER]: ROW_OWNER_AGENT };
function introspect() {
  for (const [key, agentId] of Object.entries(AGENT_OF_KEY)) {
    nock(INTROSPECT_BASE).persist().post(INTROSPECT_PATH, (b) => b && b.api_key === key)
      .reply(200, { valid: true, agent_id: agentId, is_active: true, auth_source: 'api_keys' });
  }
}

const BUYER = { session: 'acp_door_session', jwt: () => BUYER_JWT };
const OTHER_BUYER = { session: 'acp_door_session', jwt: () => OTHER_BUYER_JWT };

async function tool(name, args, { key = KEY_A, buyer = BUYER } = {}) {
  const req = supertest(app)
    .post('/mcp')
    .set('X-Agent-API-Key', key)
    .set('X-Agent-User-JWT', buyer.jwt())
    .set('X-Test-Acp-Session-Id', buyer.session)
    .set('Accept', 'application/json, text/event-stream');
  const res = await req.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  const text = res.body?.result?.content?.[0]?.text;
  return { isError: res.body?.result?.isError === true, body: text ? JSON.parse(text) : null, raw: text || '' };
}

function getOrder(orderId, opts) {
  return tool('get_order', { order_id: orderId }, opts);
}

// ---- the backend, answering each request with the recording its own rule picks --------------------------------

const seen = [];
const reply = (recorded) => [recorded.status, recorded.body];

function orderRoutes() {
  const { order, tracking, other_agent_order: otherOrder, other_agent_tracking: otherTracking } = FIXTURE.order_read;
  // The backend's rule on both routes: the row's agent must be the calling key's agent (403 otherwise).
  const ownerKeys = new Set([GATEWAY_KEY, KEY_ROW_OWNER]);
  nock(BACKEND).persist()
    .get(`/agent/v2/orders/${ORDER_ID}/tracking`)
    .reply(function r(uri) {
      seen.push({ path: uri, key: this.req.headers['x-api-key'] });
      return reply(ownerKeys.has(this.req.headers['x-api-key']) ? tracking : otherTracking);
    })
    .get(`/agent/v2/orders/${ORDER_ID}`)
    .reply(function r(uri) {
      seen.push({ path: uri, key: this.req.headers['x-api-key'] });
      return reply(ownerKeys.has(this.req.headers['x-api-key']) ? order : otherOrder);
    });
}

function purchaseRoutes() {
  const rec = FIXTURE.purchase_read;
  // The backend's rule: the purchase is answered only to its agent (the API key) AND its buyer (the user token).
  for (const id of [PP_ID, RP_ID]) {
    nock(BACKEND).persist().get(`/agent/v2/commerce/purchases/${id}`).reply(function r(uri) {
      const key = this.req.headers['x-api-key'];
      const jwt = this.req.headers['x-agent-user-jwt'];
      seen.push({ path: uri, key, jwt });
      if (key !== KEY_A) return reply(id === RP_ID ? rec.other_agent_rp : rec.other_agent);
      if (jwt !== BUYER_JWT) return reply(rec.other_buyer);
      return reply(id === RP_ID ? rec.owner_by_rp : rec.owner_by_pp);
    });
  }
}

// The request-bound (v2) assertion's subject, verified the way the backend verifies it (MAC, method, path, rid,
// body hash). A request that does not verify names no partner.
function assertedPartner(headers, uri, body) {
  const token = headers['x-pivota-issuing-agent'];
  if (!token) return null;
  const [version, encoded, mac] = String(token).split('.');
  if (version !== 'v2') return null;
  if (mac !== crypto.createHmac('sha256', SECRET).update(`${version}.${encoded}`).digest('base64url')) return null;
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  if (payload.m !== 'POST' || payload.p !== uri.split('?')[0] || payload.rid !== parsed.record_id) return null;
  if (payload.bh !== crypto.createHash('sha256').update(raw, 'utf8').digest('hex')) return null;
  return payload.sub;
}

function handoffRoutes() {
  const rec = FIXTURE.handoff_read;
  const binding = crypto.createHash('sha256').update(ESC_ID, 'utf8').digest('hex');
  nock(BACKEND).persist().post('/agent/v2/storefront-handoffs/read').reply(function r(uri, body) {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    const partner = assertedPartner(this.req.headers, uri, body);
    seen.push({ path: uri, key: this.req.headers['x-api-key'], partner, body: parsed });
    if (parsed.record_id !== RECORD_ID || parsed.binding !== binding) return reply(rec.unknown_record);
    return reply(partner === PARTNER_A ? rec.owner : rec.other_partner);
  });
}

function backend() {
  seen.length = 0;
  nock.cleanAll();
  introspect();
  orderRoutes();
  purchaseRoutes();
  handoffRoutes();
}

// ---- a kernel order, placed the way a partner places one --------------------------------------------------------

const ADDRESS = { name: 'Buyer A', address_line1: '1 Example St', city: 'Example City', postal_code: '00000', country: 'US' };
let seq = 0;
async function placeOrder({ key = KEY_A } = {}) {
  seq += 1;
  nock(BACKEND).post('/agent/v2/quotes/preview').reply(200, {
    quote: {
      quote_id: `q_unified_${seq}`, expires_at: '2030-12-31T00:00:00Z', currency: 'USD',
      price_breakdown: { subtotal: '29.00', discount_total: '0.00', total: '29.00', currency: 'USD' },
      shipping_breakdown: { shipping_fee: '0.00', delivery_options: [] }, tax_breakdown: { tax: '0.00' },
      line_items: [{ product_id: 'p_1', variant_id: 'v_1', quantity: 1 }],
    },
  });
  const session = await tool('create_checkout_session', {
    idempotency_key: `idem_unified_session_${seq}`,
    quote: { merchant_id: 'm_shop_a', customer_email: 'buyer@example.com', items: [{ product_id: 'p_1', variant_id: 'v_1', quantity: 1 }], shipping_address: ADDRESS },
  }, { key });
  assert.equal(session.isError, false, session.raw);
  nock(BACKEND)
    .post('/agent/v2/orders').reply(200, { status: 'success', order: { order_id: ORDER_ID, quote_id: `q_unified_${seq}`, amounts: { total: '29.00', currency: 'USD' } } })
    .post('/agent/v2/payments/checkout-sessions').reply(200, {
      status: 'success',
      checkout_session: { checkout_session_id: `ci_unified_${seq}`, order_id: ORDER_ID, state: 'created', hosted_url: 'https://checkout.example.com/order?checkout_token=placeholder', provider: 'pivota_hosted_checkout' },
    });
  const link = await tool('create_payment_link', {
    idempotency_key: `idem_unified_link_${seq}`, session_id: session.body.session_id, customer_email: 'buyer@example.com', shipping_address: ADDRESS,
  }, { key });
  assert.equal(link.isError, false, link.raw);
  assert.equal(link.body.order_id, ORDER_ID);
}

function codeOf(res) {
  assert.equal(res.isError, true, res.raw.slice(0, 400));
  return res.body.error.code;
}

// The owner's data that must never reach anyone else.
const OWNER_ONLY = ['shop-a.example.com', 'catalogue_fallback', 'buyer@example.com', '1 Example St', PP_ID, '"total"'];
function assertNothingOfTheOwners(res, except = []) {
  for (const leak of OWNER_ONLY.filter((v) => !except.includes(v))) {
    assert.ok(!res.raw.includes(leak), `${leak} must not reach a caller that does not own it: ${res.raw.slice(0, 300)}`);
  }
}

// ---- lanes on: the four shapes, owner and foreign ------------------------------------------------------------------

test('lanes on: a plain kernel order is answered to its owner from the backend order routes, on the gateway key', async () => {
  lanes(true);
  try {
    backend();
    await placeOrder();
    seen.length = 0;
    const own = await getOrder(ORDER_ID);
    assert.equal(own.isError, false, own.raw);
    assert.equal(own.body.order_id, ORDER_ID);
    assert.equal(own.body.status, FIXTURE.order_read.order.body.order.state, 'the order state from GET /agent/v2/orders/{id}');
    assert.equal(own.body.payment_status, FIXTURE.order_read.tracking.body.tracking.payment_status);
    assert.equal(own.body.total, FIXTURE.order_read.tracking.body.tracking.total);
    assert.deepEqual(seen.map((s) => [s.path, s.key]), [
      [`/agent/v2/orders/${ORDER_ID}/tracking`, GATEWAY_KEY],
      [`/agent/v2/orders/${ORDER_ID}`, GATEWAY_KEY],
    ], 'only the order routes, on the gateway\'s own key (P2-5: the kernel record is the isolation)');
    for (const leak of ['buyer@example.com', '1 Example St', 'client_secret']) assert.ok(!own.raw.includes(leak), leak);
  } finally {
    lanes(false);
    nock.cleanAll();
  }
});

test('lanes on: a plain kernel order is not found for a foreign partner and for another buyer, with nothing read', async () => {
  lanes(true);
  try {
    backend();
    await placeOrder();
    seen.length = 0;
    const foreign = await getOrder(ORDER_ID, { key: KEY_B });
    assert.equal(codeOf(foreign), 'QUOTE_NOT_FOUND');
    assertNothingOfTheOwners(foreign);
    const otherBuyer = await getOrder(ORDER_ID, { buyer: OTHER_BUYER });
    assert.equal(codeOf(otherBuyer), 'QUOTE_NOT_FOUND');
    assert.equal(seen.length, 0, 'the kernel refuses before any backend read');
    // The same answer an id nobody placed gets: the two cannot be told apart.
    const never = await getOrder('ORD_NEVER_PLACED_UNIFIED');
    assert.deepEqual(never.body, foreign.body);
  } finally {
    lanes(false);
    nock.cleanAll();
  }
});

test('lanes on: a kernel order the backend refuses (recorded 403 for another key) is not found, never "exists"', async () => {
  lanes(true);
  try {
    backend();
    await placeOrder();
    nock.cleanAll();
    introspect();
    const { other_agent_tracking: refused } = FIXTURE.order_read;
    nock(BACKEND).get(`/agent/v2/orders/${ORDER_ID}/tracking`).reply(refused.status, refused.body);
    const res = await getOrder(ORDER_ID);
    assert.equal(codeOf(res), 'QUOTE_NOT_FOUND');
    assert.equal(res.body.error.retriable, false);
  } finally {
    lanes(false);
    nock.cleanAll();
  }
});

for (const [label, id, recordedOwner] of [
  ['pp_', () => PP_ID, () => FIXTURE.purchase_read.owner_by_pp],
  ['rp_', () => RP_ID, () => FIXTURE.purchase_read.owner_by_rp],
]) {
  test(`lanes on: a ${label} purchase is the backend ledger read: its owner reads it, a foreign partner or buyer is not found`, async () => {
    lanes(true);
    try {
      backend();
      const own = await getOrder(id());
      assert.equal(own.isError, false, own.raw);
      assert.equal(own.body.source, 'agent_purchase');
      assert.equal(own.body.order_id, PP_ID, 'answered under the rail-neutral id');
      assert.equal(own.body.status, recordedOwner().body.state);
      assert.equal(own.body.rail_purchase_id, RP_ID);
      const [read] = seen;
      assert.deepEqual([read.path, read.key, read.jwt], [`/agent/v2/commerce/purchases/${id()}`, KEY_A, BUYER_JWT],
        'the caller\'s own key and buyer token, never the gateway key');

      seen.length = 0;
      const foreign = await getOrder(id(), { key: KEY_B });
      assert.equal(codeOf(foreign), 'QUOTE_NOT_FOUND', 'the backend 404 purchase_not_found');
      assert.equal(foreign.body.error.retriable, false);
      assertNothingOfTheOwners(foreign, id() === PP_ID ? [PP_ID] : []);
      assert.deepEqual(seen.map((s) => s.key), [KEY_B], 'the foreign partner reads on its own key, and is refused');

      const otherBuyer = await getOrder(id(), { buyer: OTHER_BUYER });
      assert.equal(codeOf(otherBuyer), 'QUOTE_NOT_FOUND');
      // Not found looks exactly like a kernel id nobody placed.
      const never = await getOrder('ORD_NEVER_PLACED_UNIFIED');
      assert.equal(codeOf(never), 'QUOTE_NOT_FOUND');
      assert.equal(foreign.body.error.message, never.body.error.message);
      assert.equal(seen.filter((s) => s.path.startsWith('/agent/v2/orders')).length, 0, 'a purchase never reaches the order routes');
    } finally {
      lanes(false);
      nock.cleanAll();
    }
  });
}

test('lanes on: an esc_ hand-off is its record: its partner reads it, a foreign partner gets the backend\'s 409, an unknown record is not found', async () => {
  lanes(true);
  try {
    backend();
    const own = await getOrder(ESC_ID);
    assert.equal(own.isError, false, own.raw);
    const recorded = FIXTURE.handoff_read.owner.body;
    assert.equal(own.body.order_id, ESC_ID);
    assert.equal(own.body.status, recorded.status);
    assert.equal(own.body.source, 'storefront_handoff');
    assert.equal(own.body.handoff.seller_host, recorded.seller_host);
    assert.deepEqual(own.body.handoff.quoted_total, recorded.quoted_total);
    assert.equal(own.body.handoff.quote_source, recorded.quote_source);
    const [read] = seen;
    assert.deepEqual([read.path, read.key, read.partner], ['/agent/v2/storefront-handoffs/read', GATEWAY_KEY, PARTNER_A],
      'the gateway\'s key, the asking partner in a verified request-bound assertion');

    seen.length = 0;
    const foreign = await getOrder(ESC_ID, { key: KEY_B });
    assert.equal(codeOf(foreign), 'STATE_LINKAGE_MISMATCH', 'the backend\'s 409 not_owner');
    assert.equal(foreign.body.error.retriable, false);
    assertNothingOfTheOwners(foreign);
    assert.deepEqual(seen.map((s) => s.partner), [PARTNER_B]);

    // A record id nobody stored, in an id the real encoder minted: not found.
    const { encodeEscalationId } = await import('../mcp-server/src/ucpCheckoutEscalation.js');
    const unknownId = encodeEscalationId([{ product_id: 'sig_serum_x_handoff', quantity: 1 }], undefined, undefined, { code: 'US' }, `esh_${'Q'.repeat(22)}`);
    const unknown = await getOrder(unknownId);
    assert.equal(codeOf(unknown), 'QUOTE_NOT_FOUND');
    assertNothingOfTheOwners(unknown);
  } finally {
    lanes(false);
    nock.cleanAll();
  }
});

test('the recorded esc_ id is the one the real encoder mints for that record', async () => {
  const { encodeEscalationId, escalationRecordIdOf } = await import('../mcp-server/src/ucpCheckoutEscalation.js');
  assert.equal(encodeEscalationId([{ product_id: 'sig_serum_x_handoff', quantity: 1 }], undefined, undefined, { code: 'US' }, RECORD_ID), ESC_ID);
  assert.equal(escalationRecordIdOf(ESC_ID), RECORD_ID);
});

// ---- lanes off: every shape answers exactly as before the lanes existed ---------------------------------------------

test('lanes off: pp_, rp_ and esc_ take the kernel path (not found, nothing read); a plain order reads as before', async () => {
  lanes(false);
  backend();
  try {
    for (const id of [PP_ID, RP_ID, ESC_ID]) {
      const res = await getOrder(id);
      assert.equal(codeOf(res), 'QUOTE_NOT_FOUND', id);
    }
    assert.equal(seen.length, 0, 'no lane reached the backend');
    await placeOrder();
    seen.length = 0;
    const own = await getOrder(ORDER_ID);
    assert.equal(own.isError, false, own.raw);
    assert.equal(own.body.order_id, ORDER_ID);
    assert.equal(codeOf(await getOrder(ORDER_ID, { key: KEY_B })), 'QUOTE_NOT_FOUND');
  } finally {
    nock.cleanAll();
  }
});

// ---- the REST invoke door: get_order_status serves the plain shape only, and the backend is the owner check -------

async function restGetOrderStatus(key, orderId) {
  return supertest(app)
    .post('/agent/shop/v1/invoke')
    .set('X-Agent-API-Key', key)
    .send({ operation: 'get_order_status', payload: { status: { order_id: orderId } } });
}

test('REST door: get_order_status is the backend\'s answer on the caller\'s own key: its owner reads it, a foreign partner is refused', async () => {
  backend();
  try {
    const own = await restGetOrderStatus(KEY_ROW_OWNER, ORDER_ID);
    assert.equal(own.status, 200, JSON.stringify(own.body).slice(0, 300));
    assert.equal(own.body.order_id, ORDER_ID);
    assert.equal(own.body.payment_status, FIXTURE.order_read.tracking.body.tracking.payment_status);
    const foreign = await restGetOrderStatus(KEY_B, ORDER_ID);
    assert.equal(foreign.status, FIXTURE.order_read.other_agent_tracking.status, 'the backend\'s own refusal, passed through');
    assert.ok(!JSON.stringify(foreign.body).includes('"payment_status"'), 'nothing of the order');
    assert.deepEqual(seen.map((s) => s.key), [KEY_ROW_OWNER, KEY_B], 'each caller on its own key');
  } finally {
    nock.cleanAll();
  }
});
