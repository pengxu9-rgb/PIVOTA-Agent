'use strict';

// THE UCP STOREFRONT HAND-OFF RECORD (FIX_PLAN O-02), end to end over the real doors.
//
// Two partners, partner-a and partner-b, check out a storefront row (a seller Pivota does not transact) through the
// real POST /ucp/mcp door with their own api keys, then poll it with get_order through the real POST /mcp door.
// With UCP_STOREFRONT_HANDOFF_RECORD_ENABLED and PARTNER_IDENTITY_FORWARDING_ENABLED on:
//   - each create writes ONE hand-off record, signed for the partner that asked (op ucp_storefront_handoff.record),
//     on the gateway's own key; the esc id handed out carries that record's id;
//   - the checkout says where its totals came from (quote_source: catalogue_fallback, price_as_of, a warning);
//   - get_order on each esc id answers that hand-off to its owner and refuses it to the other partner;
//   - a forged esc id (an unknown record id, a real record id under altered items, no record id at all) is refused.
// With the flags off nothing is recorded and every answer has the bytes it had (the differential against the O-04
// head is scripts-side; see the report).
//
// The real producers: api-key introspection -> req.invokeAuth -> INVOKE_AUTH_CONTEXT -> the UCP door's argument
// adapter -> the commerce surface -> the escalation lane and its memoized product reads -> the canonical executor ->
// invokeCommerceKernelRawUpstream; for get_order, the same executor's get_order. Stubbed are only the network edges:
// introspection, the loopback product page (nock on this process's own origin) and the Python backend's hand-off
// routes (nock on PIVOTA_API_BASE; the backend's own behaviour is tested in pivota-backend
// tests/test_storefront_handoff_record.py, and this stub answers the way those routes do).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const PORT = '3994';
const LOOPBACK = `http://127.0.0.1:${PORT}`;
const BACKEND = 'http://backend.storefront-handoff.test';
const INTROSPECT_BASE = 'https://auth.storefront-handoff.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const SECRET = 'storefront_handoff_test_secret';
const FORWARDING = 'PARTNER_IDENTITY_FORWARDING_ENABLED';
const FLAG = 'UCP_STOREFRONT_HANDOFF_RECORD_ENABLED';
const KEY_A = `ak_live_${'c'.repeat(64)}`;
const KEY_B = `ak_live_${'d'.repeat(64)}`;
const PARTNER_A = 'agent_partner_a';
const PARTNER_B = 'agent_partner_b';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.PORT = PORT;
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED = '1';
process.env.AGENT_CHECKOUT_UCP_ESCALATION_ENABLED = '1';
process.env.UCP_BASE_URL = 'https://shop.pivota.cc';
process.env.PIVOTA_API_BASE = BACKEND;
process.env.PIVOTA_API_KEY = 'gateway-service-key';
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.SELF_INVOKE_TIMEOUT_MS = '6000';
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
process.env.AGENT_AUTH_INTROSPECT_TIMEOUT_MS = '1200';
process.env.INVOKE_AUTH_BYPASS_IN_TEST = '0';
process.env.ISSUING_AGENT_ASSERTION_SECRET = SECRET;
delete process.env.PUBLIC_READ_MCP_ENABLED;
delete process.env.MERCHANT_PURCHASABILITY_GATE_ENABLED;
delete process.env.AGENT_CHECKOUT_UCP_MERCHANT_PRICING_ENABLED;
delete process.env[FORWARDING];
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

function setFlags({ record, forwarding }) {
  if (record) process.env[FLAG] = '1'; else delete process.env[FLAG];
  if (forwarding) process.env[FORWARDING] = '1'; else delete process.env[FORWARDING];
}

function introspect() {
  for (const [key, agentId] of [[KEY_A, PARTNER_A], [KEY_B, PARTNER_B]]) {
    nock(INTROSPECT_BASE)
      .persist()
      .post(INTROSPECT_PATH, (body) => body && body.api_key === key)
      .reply(200, { valid: true, agent_id: agentId, is_active: true, auth_source: 'api_keys' });
  }
}

function assertionOf(headers) {
  const token = headers['x-pivota-issuing-agent'];
  if (!token) return null;
  const [version, body, mac] = String(token).split('.');
  assert.equal(version, 'v1');
  assert.equal(mac, crypto.createHmac('sha256', SECRET).update(`${version}.${body}`).digest('base64url'), 'signed with the shared secret');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

// ---- the storefront row ---------------------------------------------------------------------------------------

const PRODUCT_ID = 'sig_serum_x_handoff';
const REFERRAL_CLICK = 'clk_0123456789abcdef01234567';
const STOREFRONT_URL = `https://shop-a.example.com/products/serum-x?utm_source=pivota&pvt_click_id=${REFERRAL_CLICK}`;
const PRICE_AS_OF = '2026-11-01T10:00:00.000Z';

function interceptProductPage() {
  const reads = [];
  nock(LOOPBACK)
    .persist()
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'get_pdp_v2')
    .reply(function reply(_uri, body) {
      reads.push(body);
      return [200, {
        modules: [{
          type: 'canonical',
          data: { pdp_payload: { product: {
            product_id: PRODUCT_ID,
            merchant_id: 'merch_obs_shop_a',
            title: 'Serum X',
            price: { current: { amount: 25, currency: 'USD' } },
            availability: 'in_stock',
            external_redirect_url: STOREFRONT_URL,
            price_as_of: PRICE_AS_OF,
          } } },
        }],
      }];
    });
  return reads;
}

/** The backend's hand-off routes, answered as pivota-backend routes/agent_storefront_handoffs.py answers them. */
function interceptHandoffBackend() {
  const state = { records: [], reads: [], rows: new Map() };
  const refuse = (status, code) => [status, { detail: { error: code }, error: { code: 'X', message: code, details: { error: code } }, status: 'error' }];
  nock(BACKEND)
    .persist()
    .post('/agent/v2/storefront-handoffs')
    .reply(function reply(_uri, body) {
      const assertion = assertionOf(this.req.headers);
      state.records.push({ headers: { ...this.req.headers }, assertion, body });
      if (!assertion || assertion.op !== 'ucp_storefront_handoff.record') return refuse(403, 'partner_identity_required');
      const existing = state.rows.get(body.record_id);
      if (existing && (existing.partner !== assertion.sub || existing.binding !== body.binding)) return refuse(409, 'handoff_conflict');
      state.rows.set(body.record_id, { partner: assertion.sub, ...body });
      return [200, { record_id: body.record_id, status: 'handed_off' }];
    })
    .post('/agent/v2/storefront-handoffs/read')
    .reply(function reply(_uri, body) {
      const assertion = assertionOf(this.req.headers);
      state.reads.push({ headers: { ...this.req.headers }, assertion, body });
      if (!assertion || assertion.op !== 'ucp_storefront_handoff.read') return refuse(403, 'partner_identity_required');
      const row = state.rows.get(body.record_id);
      if (!row || row.binding !== body.binding) return refuse(404, 'handoff_not_found');
      if (row.partner !== assertion.sub) return refuse(403, 'not_owner');
      return [200, {
        record_id: body.record_id, status: 'handed_off', handed_off_at: '2026-11-08T12:00:00Z',
        seller_host: row.seller_host, quote_source: row.quote_source, price_as_of: row.price_as_of,
        buyer_market: row.buyer_market, quoted_total: { amount: row.quoted_total_minor, currency: row.currency },
      }];
    });
  return state;
}

// ---- the two doors -------------------------------------------------------------------------------------------------

const rpc = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

async function door(path, key, body) {
  const res = await supertest(app)
    .post(path)
    .set('X-Agent-API-Key', key)
    .set('X-Test-User-Ref', `usr_${key.slice(8, 10)}`)
    .set('X-Test-Acp-Session-Id', `acp_${key.slice(8, 10)}`)
    .set('Accept', 'application/json, text/event-stream')
    .send(body);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  assert.ok(res.body.result, JSON.stringify(res.body).slice(0, 400));
  return res.body.result;
}

function payloadOf(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

async function createCheckout(key, tag, { quantity = 1 } = {}) {
  const result = await door('/ucp/mcp', key, rpc('create_checkout', {
    meta: { 'idempotency-key': `idem_handoff_${tag}_${process.pid}` },
    checkout: { line_items: [{ item: { id: PRODUCT_ID }, quantity }], context: { address_country: 'US' } },
  }));
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 600));
  return payloadOf(result);
}

async function getOrder(key, orderId) {
  return door('/mcp', key, rpc('get_order', { order_id: orderId }, 2));
}

function errorOf(result) {
  assert.equal(result.isError, true, JSON.stringify(result).slice(0, 400));
  return payloadOf(result);
}

function escBody(id) {
  return JSON.parse(Buffer.from(id.slice('esc_'.length), 'base64url').toString('utf8'));
}

function escOf(body) {
  return `esc_${Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')}`;
}

// ---- flags on ------------------------------------------------------------------------------------------------------

test('flags on: two partners through the real UCP door each get their own hand-off record', async () => {
  setFlags({ record: true, forwarding: true });
  nock.cleanAll();
  introspect();
  interceptProductPage();
  const backend = interceptHandoffBackend();
  try {
    const a = await createCheckout(KEY_A, 'on_a');
    const b = await createCheckout(KEY_B, 'on_b', { quantity: 2 });
    for (const checkout of [a, b]) {
      assert.equal(checkout.status, 'requires_escalation');
      assert.ok(checkout.id.startsWith('esc_'));
      assert.match(escBody(checkout.id).r, /^esh_[A-Za-z0-9_-]{22}$/, 'the esc id carries its record id');
      // THE LABEL: not the seller's live cart.
      assert.equal(checkout.quote_source, 'catalogue_fallback');
      assert.equal(checkout.price_as_of, PRICE_AS_OF);
      const warning = checkout.messages.find((m) => m.code === 'checkout.quote_source.catalogue_fallback');
      assert.ok(warning, JSON.stringify(checkout.messages));
      assert.equal(warning.type, 'warning');
      assert.match(warning.content, /not the seller's live cart/);
    }
    assert.notEqual(escBody(a.id).r, escBody(b.id).r);

    assert.equal(backend.records.length, 2, 'one record per hand-off');
    const [ra, rb] = backend.records;
    assert.deepEqual([ra.assertion.sub, ra.assertion.op], [PARTNER_A, 'ucp_storefront_handoff.record']);
    assert.deepEqual([rb.assertion.sub, rb.assertion.op], [PARTNER_B, 'ucp_storefront_handoff.record']);
    for (const [rec, checkout, qty] of [[ra, a, 1], [rb, b, 2]]) {
      assert.equal(rec.headers['x-api-key'], 'gateway-service-key', "the gateway's own key; the partner is the assertion");
      assert.equal(rec.headers['x-agent-user-jwt'], undefined);
      assert.equal(rec.headers['x-buyer-ref'], undefined);
      assert.deepEqual(rec.body, {
        record_id: escBody(checkout.id).r,
        binding: crypto.createHash('sha256').update(checkout.id).digest('hex'),
        seller_host: 'shop-a.example.com',
        currency: 'USD',
        quoted_total_minor: 2500 * qty,
        quote_source: 'catalogue_fallback',
        buyer_market: 'US',
        referral_click_id: REFERRAL_CLICK,
        price_as_of: PRICE_AS_OF,
        merchant_id: 'merch_obs_shop_a',
      });
      assert.equal(checkout.totals.find((t) => t.type === 'total').amount, 2500 * qty, 'the recorded total is the one shown');
      assert.ok(!('partner_agent_id' in rec.body) && !('agent_id' in rec.body), 'the owner is never a body field');
    }

    // GET_ORDER: its owner reads it, the other partner is refused.
    const ownA = payloadOf(await getOrder(KEY_A, a.id));
    const ownB = payloadOf(await getOrder(KEY_B, b.id));
    for (const [own, checkout, qty] of [[ownA, a, 1], [ownB, b, 2]]) {
      assert.equal(own.order_id, checkout.id);
      assert.equal(own.status, 'handed_off');
      assert.equal(own.source, 'storefront_handoff');
      assert.equal(own.completes_on, 'seller_storefront');
      assert.equal(own.handoff.quote_source, 'catalogue_fallback');
      assert.equal(own.handoff.price_as_of, PRICE_AS_OF);
      assert.deepEqual(own.handoff.quoted_total, { amount: 2500 * qty, currency: 'USD' });
      assert.equal(own.handoff.seller_host, 'shop-a.example.com');
    }
    const crossA = errorOf(await getOrder(KEY_B, a.id));
    const crossB = errorOf(await getOrder(KEY_A, b.id));
    for (const err of [crossA, crossB]) {
      assert.equal(err.error?.code ?? err.code, 'STATE_LINKAGE_MISMATCH', JSON.stringify(err));
      assert.ok(!JSON.stringify(err).includes('shop-a.example.com'), 'nothing of the hand-off reaches the other partner');
    }
    const readers = backend.reads.map((r) => [r.assertion.sub, r.assertion.op, r.headers['x-api-key']]);
    assert.deepEqual(readers, [
      [PARTNER_A, 'ucp_storefront_handoff.read', 'gateway-service-key'],
      [PARTNER_B, 'ucp_storefront_handoff.read', 'gateway-service-key'],
      [PARTNER_B, 'ucp_storefront_handoff.read', 'gateway-service-key'],
      [PARTNER_A, 'ucp_storefront_handoff.read', 'gateway-service-key'],
    ]);

    // The stateless re-read still answers the recorded id, with the same label.
    const reread = payloadOf(await door('/ucp/mcp', KEY_A, rpc('get_checkout', { meta: {}, id: a.id }, 3)));
    assert.equal(reread.id, a.id);
    assert.equal(reread.quote_source, 'catalogue_fallback');
  } finally {
    nock.cleanAll();
    setFlags({});
  }
});

test('flags on: a forged esc id is refused, never read as a hand-off', async () => {
  setFlags({ record: true, forwarding: true });
  nock.cleanAll();
  introspect();
  interceptProductPage();
  const backend = interceptHandoffBackend();
  try {
    const real = await createCheckout(KEY_A, 'forge_a');
    const body = escBody(real.id);
    // 1. a record id nobody minted
    const unknown = errorOf(await getOrder(KEY_A, escOf({ ...body, r: `esh_${'Z'.repeat(22)}` })));
    assert.equal(unknown.error?.code ?? unknown.code, 'QUOTE_NOT_FOUND', JSON.stringify(unknown));
    // 2. the real record id lifted into an esc id for other items (another quantity)
    const lifted = errorOf(await getOrder(KEY_A, escOf({ ...body, i: [[PRODUCT_ID, 9]] })));
    assert.equal(lifted.error?.code ?? lifted.code, 'QUOTE_NOT_FOUND', JSON.stringify(lifted));
    // 3. a well-formed esc id with no record: not "not found" (it may be real), but no status either
    const { r: _r, ...bare } = body;
    const unrecorded = errorOf(await getOrder(KEY_A, escOf(bare)));
    assert.equal(unrecorded.error?.code ?? unrecorded.code, 'OPERATION_NOT_ALLOWED', JSON.stringify(unrecorded));
    assert.match(JSON.stringify(unrecorded), /storefront_handoff_unrecorded/);
    // The real one still reads.
    assert.equal(payloadOf(await getOrder(KEY_A, real.id)).status, 'handed_off');
    assert.equal(backend.reads.length, 3, 'the unrecorded id never reaches the backend');
  } finally {
    nock.cleanAll();
    setFlags({});
  }
});

test('flags on: a record the backend does not confirm leaves the id unrecorded, and the checkout is still handed out', async () => {
  setFlags({ record: true, forwarding: true });
  nock.cleanAll();
  introspect();
  interceptProductPage();
  nock(BACKEND).persist().post('/agent/v2/storefront-handoffs').reply(503, { detail: { error: 'handoff_store_unavailable' } });
  try {
    const checkout = await createCheckout(KEY_A, 'down_a');
    assert.equal(checkout.status, 'requires_escalation');
    assert.equal(escBody(checkout.id).r, undefined, 'no record, no record id');
    assert.equal(checkout.quote_source, 'catalogue_fallback', 'the label does not depend on the record');
  } finally {
    nock.cleanAll();
    setFlags({});
  }
});

// ---- flags off -------------------------------------------------------------------------------------------------------

for (const flags of [{}, { forwarding: true }, { record: true }]) {
  const label = JSON.stringify(flags);
  test(`flags ${label}: no record is written and the esc id carries none`, async () => {
    setFlags(flags);
    nock.cleanAll();
    introspect();
    interceptProductPage();
    const backend = interceptHandoffBackend();
    try {
      const checkout = await createCheckout(KEY_A, `off_${Object.keys(flags).join('_') || 'all'}`);
      assert.equal(checkout.status, 'requires_escalation');
      assert.equal(escBody(checkout.id).r, undefined);
      assert.deepEqual(escBody(checkout.id), { v: 1, i: [[PRODUCT_ID, 1]] }, 'the id it always was');
      assert.equal(backend.records.length, 0);
      if (flags.record) {
        assert.equal(checkout.quote_source, 'catalogue_fallback', 'the label rides its own flag');
      } else {
        assert.equal('quote_source' in checkout, false);
        assert.equal('price_as_of' in checkout, false);
        assert.ok(!checkout.messages.some((m) => m.code === 'checkout.quote_source.catalogue_fallback'));
      }
      // get_order on it takes the kernel path, as before: QUOTE_NOT_FOUND (forwarding alone records nothing).
      if (!flags.record || !flags.forwarding) {
        const err = errorOf(await getOrder(KEY_A, checkout.id));
        assert.equal(err.error?.code ?? err.code, 'QUOTE_NOT_FOUND', JSON.stringify(err));
      }
      assert.equal(backend.reads.length, 0);
    } finally {
      nock.cleanAll();
      setFlags({});
    }
  });
}
