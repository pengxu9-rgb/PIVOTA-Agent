'use strict';

// THE ORDER CALL'S 403 WITH THE PRIVATE BACKEND HOP SWITCHED ON (src/services/privateBackendHop.js), through the real
// tool doors over HTTP.
//
// With GATEWAY_BACKEND_ID_TOKEN_AUDIENCE and GATEWAY_BACKEND_ID_TOKEN_TARGET_ORIGIN set, the hop turns every backend
// 401 and 403 into its own `backend_iam_rejected` before the gateway's transport reads a status or a body: it cannot
// tell a refusal of its platform credential from the backend application's own 403. So the backend's named 403
// MERCHANT_NOT_ACCEPTING_ORDERS, which gives a quote's claim back with the hop off, reaches the kernel as a call with
// no readable answer. It must then KEEP the claim, and say only what is known: an unknown outcome, no order id, and the
// same key told the same, with no second order asked for. The hop is off in production today; this guards the day it
// is switched on.
//
// The same fixture as tests/quote_claim_release_door.node.test.cjs, with the backend at a Cloud Run origin (nock) and
// the metadata server's identity token stubbed (nock). Nothing leaves this process. Every name is a placeholder.

const test = require('node:test');
const assert = require('node:assert/strict');
const nock = require('nock');

const fx = require('./_support/quoteClaimReleaseDoor.cjs');

const { IDS, ANSWERS } = fx;
const BACKEND = 'https://backend-fixture-123.us-west1.run.app';
const METADATA = 'http://metadata.google.internal';
const CALLERS = ['mcp_complete', 'mcp_payment_link', 'acp_complete'];
const MARKETS = ['US', 'SG', 'GB'];
let door;
let keys;
let metadataCalls = 0;

const jwt = () => `e30.${Buffer.from(JSON.stringify({ aud: BACKEND, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;

test.before(async () => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
  keys = await fx.mintKeys();
  door = fx.bootDoor({
    port: 5671, keys, backendBase: BACKEND,
    env: { GATEWAY_BACKEND_ID_TOKEN_AUDIENCE: BACKEND, GATEWAY_BACKEND_ID_TOKEN_TARGET_ORIGIN: BACKEND },
  });
  nock(METADATA).persist().get(/\/computeMetadata\/v1\/instance\/service-accounts\/default\/identity/)
    .reply(() => { metadataCalls += 1; return [200, jwt()]; });
  await door.listen();
});
test.after(async () => {
  if (door) await door.close();
  nock.enableNetConnect();
});

let seq = 0;
const freshKey = () => { seq += 1; return `idem-hop-${String(seq).padStart(5, '0')}`; };
const buyerFor = (n) => ({ 'X-Test-User-Ref': 'buyer-0001', 'X-Test-Acp-Session-Id': `sess-hop-${String(n).padStart(5, '0')}` });
const cartItems = [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity: 1 }];
const ORDERS = '/agent/v2/orders';

async function open(caller, market) {
  seq += 1;
  if (caller === 'acp_complete') {
    const r = await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER, items: cartItems, fulfillment_address: fx.address(market) }, { key: freshKey() });
    assert.equal(r.http, 201, r.raw.slice(0, 300));
    return { caller, id: r.body.id, currency: r.body.currency, grant: await keys.mintGrant({ sessionId: r.body.id, currency: r.body.currency, maxAmount: r.body.totals.total }) };
  }
  const buyer = buyerFor(seq);
  const r = await door.call('create_checkout_session', { idempotency_key: freshKey(), quote: { merchant_id: IDS.SELLER, items: cartItems, customer_email: 'buyer@example.test', shipping_address: fx.address(market) } }, { buyer });
  assert.equal(r.isError, false, r.raw.slice(0, 300));
  return { caller, id: r.value.session_id, buyer, currency: r.value.currency, grant: await keys.mintGrant({ sessionId: r.value.session_id, currency: r.value.currency, maxAmount: r.value.totals.total }) };
}
/** `{ code, raw, orders }`: the answer's code (null when it ordered), the body as sent, the order calls it made. */
async function attempt(h, key) {
  if (h.caller === 'acp_complete') {
    const r = await door.acp('POST', `/checkout_sessions/${h.id}/complete`, { payment_data: { method: 'acp_delegated_token', token: h.grant } }, { key });
    return { http: r.http, code: r.http === 200 ? null : r.body.code, message: r.body && r.body.message, raw: r.raw, orders: r.upstream.filter((c) => c.path === ORDERS).length };
  }
  const r = h.caller === 'mcp_complete'
    ? await door.call('complete_checkout_session', { idempotency_key: key, session_id: h.id, payment_authorization: { method: 'acp_delegated_token', token: h.grant } }, { buyer: h.buyer })
    : await door.call('create_payment_link', { idempotency_key: key, session_id: h.id, customer_email: 'buyer@example.test' }, { buyer: h.buyer });
  const error = r.isError && r.value && r.value.error;
  return { http: r.http, code: error ? error.code : null, error, message: error && error.message, raw: r.raw, orders: r.upstream.filter((c) => c.path === ORDERS).length };
}

test('the hop is on: every backend call carries its identity token, and an order the backend makes is answered as before', async () => {
  const h = await open('mcp_complete', 'US');
  const ok = await attempt(h, freshKey());
  assert.equal(ok.code, null, ok.raw.slice(0, 300));
  assert.equal(ok.orders, 1);
  assert.ok(metadataCalls >= 1, 'the identity token was asked of the metadata server');
});

test('a backend 403 MERCHANT_NOT_ACCEPTING_ORDERS behind the hop is an unknown outcome with the claim KEPT: no order id, the same key told the same, another key the used session, never a second order', async () => {
  for (const caller of CALLERS) {
    for (const market of MARKETS) {
      for (const answer of ['merchantNotAccepting', 'notAuthorized']) {
        const label = `${caller} ${market} ${answer}`;
        const h = await open(caller, market);
        const made = door.orders.length;
        door.orderScript.push(ANSWERS[answer]());
        const key = freshKey();
        const first = await attempt(h, key);
        assert.equal(first.code, 'CHECKOUT_OUTCOME_UNKNOWN', `${label}: ${first.raw.slice(0, 300)}`);
        assert.equal(first.orders, 1, label);
        // Never the terminal "not taking orders; nothing was ordered": the hop hid the backend's words.
        assert.equal(/not taking orders|nothing was ordered/i.test(first.raw), false, `${label}: ${first.raw.slice(0, 300)}`);
        if (caller === 'acp_complete') {
          assert.equal(first.http, 409, label);
        } else {
          assert.deepEqual([first.error.retriable, first.error.detail], [false, { reason: 'order_create_outcome_unknown', order_id: null }], label);
          assert.match(first.error.recovery, /do not place a new order for this purchase without the buyer/, label);
        }
        const same = await attempt(h, key);
        assert.equal(same.code, 'CHECKOUT_OUTCOME_UNKNOWN', `${label} same key: ${same.raw.slice(0, 300)}`);
        if (caller !== 'acp_complete') assert.equal(same.raw, first.raw, `${label}: the same answer, byte for byte`);
        const other = await attempt(h, freshKey());
        assert.equal(other.code, 'QUOTE_ALREADY_USED', `${label} another key: ${other.raw.slice(0, 300)}`);
        assert.equal(same.orders + other.orders, 0, `${label}: no second order call`);
        assert.equal(door.orders.length, made, `${label}: no order was made`);
      }
    }
  }
});

test('a 429 behind the hop is still the store\'s rate limit: an unknown outcome in its own words, the claim kept', async () => {
  const { KERNEL_ANSWERED_REFUSALS } = await import('../safety-kernel/src/errors.js');
  const h = await open('mcp_complete', 'SG');
  door.orderScript.push(ANSWERS.rateLimited());
  const key = freshKey();
  const first = await attempt(h, key);
  assert.equal(first.code, 'CHECKOUT_OUTCOME_UNKNOWN', first.raw.slice(0, 300));
  assert.equal(first.error.recovery, KERNEL_ANSWERED_REFUSALS.rate_limited.recovery);
  const same = await attempt(h, key);
  assert.equal(same.raw, first.raw);
  assert.equal(same.orders, 0);
});
