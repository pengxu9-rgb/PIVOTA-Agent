// ACP REST adapter tests — the ChatGPT path. Proves it authenticates the platform (HMAC Signature + Timestamp
// with a replay window), resolves the buyer from verified context (never the body), binds an ACP session to one
// buyer, maps ACP requests↔canonical ops through the executor→kernel, and never leaks secrets/amounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SafetyKernel } from '../src/kernel.js';
import { InMemoryKvStore } from '../src/stores.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { createAcpRestAdapter, verifyAcpSignature } from '../src/protocol/acpRestAdapter.js';

const SECRET = 'acp-signing-secret-0123456789abcdef';
const KSECRET = 'acp-kernel-secret-0123456789abcdef';
const FIXED_NOW = 1_900_000_000_000;
const quiet = { info() {}, warn() {}, error() {} };
const QUOTE = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: {},
};
const okVerify = async (_a, b) => ({ ok: true, amount: b.amount, currency: b.currency, user_ref: b.user_ref });

function setup({ verify = okVerify, getProducts, quote = QUOTE, publicFeed } = {}) {
  let charges = 0;
  const upstreamCalls = [];
  const kernelUpstream = async (op, payload) => {
    upstreamCalls.push({ op, payload });
    return op === 'preview_quote' ? quote
      : op === 'create_order' ? { order_id: 'o_acp', acp_state: {} }
      : op === 'submit_payment' ? (charges++, { order_id: 'o_acp', payment_id: 'pay1', payment_status: 'succeeded' })
      : {};
  };
  // freeze the kernel clock to FIXED_NOW (the ACP adapter uses it) so a quote can't time-expire/evict between
  // create and complete under heavy parallel-test load — removes a real-time flake source.
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: KSECRET, log: quiet, now: () => FIXED_NOW });
  const executor = createCanonicalExecutor({ kernel, upstream: async () => ({}), verifyPaymentAuthorization: verify });
  const sessionStore = new InMemoryKvStore({ now: () => FIXED_NOW });
  const adapter = createAcpRestAdapter({
    executor, sessionStore, signingSecret: SECRET, publicFeed,
    resolveUserRef: async (req) => req.headers['x-test-buyer'], // simulates a verified buyer credential
    getProducts: getProducts ?? (async () => [{ product_id: 'p1', title: 'Sock', price: '9.99', currency: 'USD', in_stock: true }]),
    now: () => FIXED_NOW,
  });
  return { adapter, sessionStore, charges: () => charges, upstreamCalls };
}

function sign(rawBody, ts) { return createHmac('sha256', SECRET).update(`${ts}.${rawBody}`).digest('hex'); }
function req({ body = {}, id, buyer = 'buyer_1', idem = 'idem-acp-00001', ts = FIXED_NOW, withSig = true } = {}) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(ts);
  const headers = { authorization: 'Bearer platform-key' };
  if (withSig) { headers.timestamp = timestamp; headers.signature = sign(rawBody, timestamp); }
  if (idem) headers['idempotency-key'] = idem;
  if (buyer) headers['x-test-buyer'] = buyer;
  return { headers, rawBody, body, params: id ? { checkout_session_id: id } : {} };
}
const CART = { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] };

async function open(adapter, buyer = 'buyer_1') {
  const r = await adapter.createCheckoutSession(req({ body: CART, idem: `idem-open-${buyer}`, buyer }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}

test('verifyAcpSignature: valid passes; bad/stale/missing throw', () => {
  const rawBody = JSON.stringify({ a: 1 });
  const ts = String(FIXED_NOW);
  assert.ok(verifyAcpSignature({ signature: sign(rawBody, ts), timestamp: ts, rawBody, secret: SECRET, now: () => FIXED_NOW }));
  assert.throws(() => verifyAcpSignature({ signature: 'deadbeef', timestamp: ts, rawBody, secret: SECRET, now: () => FIXED_NOW }), (e) => e.code === 'USER_AUTH_REQUIRED');
  assert.throws(() => verifyAcpSignature({ signature: sign(rawBody, ts), timestamp: String(FIXED_NOW - 10 * 60 * 1000), rawBody, secret: SECRET, now: () => FIXED_NOW }), (e) => e.detail?.reason === 'stale_timestamp');
  assert.throws(() => verifyAcpSignature({ timestamp: ts, rawBody, secret: SECRET, now: () => FIXED_NOW }), (e) => e.detail?.reason === 'missing_signature_or_timestamp');
});

test('unsigned / bad-signature requests are refused (401) before any work', async () => {
  const { adapter, charges } = setup();
  const unsigned = await adapter.createCheckoutSession(req({ body: CART, withSig: false }));
  assert.equal(unsigned.status, 401);
  // tamper the body after signing → signature mismatch
  const r = req({ body: CART });
  r.body = { ...CART, items: [{ product_id: 'p1', quantity: 99 }] }; r.rawBody = JSON.stringify(r.body);
  const tampered = await adapter.createCheckoutSession(r);
  assert.equal(tampered.status, 401);
  assert.equal(charges(), 0);
});

test('create requires a verified buyer and an idempotency key', async () => {
  const { adapter } = setup();
  const noBuyer = await adapter.createCheckoutSession(req({ body: CART, buyer: null }));
  assert.equal(noBuyer.status, 401);
  assert.equal(noBuyer.body.code, 'USER_AUTH_REQUIRED');
  const noIdem = await adapter.createCheckoutSession(req({ body: CART, idem: null }));
  assert.equal(noIdem.status, 409);
  assert.equal(noIdem.body.code, 'IDEMPOTENCY_CONFLICT');
});

test('create → ACP checkout_session with id, totals, status; session bound to the buyer', async () => {
  const { adapter, sessionStore } = setup();
  const r = await adapter.createCheckoutSession(req({ body: CART }));
  assert.equal(r.status, 201);
  assert.equal(r.body.object, 'checkout_session');
  assert.ok(r.body.id);
  assert.equal(r.body.status, 'checkout.created');
  assert.equal(r.body.totals.total, 113);
  assert.equal(r.body.currency, 'USD');
  const stored = await sessionStore.get(r.body.id);
  assert.equal(stored.user_ref, 'buyer_1');
  assert.ok(stored.quote_id);
});

test('amount injection: a caller-set total/price in the body never reaches pricing (allowlist)', async () => {
  const { adapter, upstreamCalls } = setup();
  await adapter.createCheckoutSession(req({ body: { ...CART, total: 1, items: [{ product_id: 'p1', quantity: 1, price: 1, amount: 1 }] } }));
  const pq = upstreamCalls.find((c) => c.op === 'preview_quote');
  assert.ok(pq, 'preview_quote called');
  const q = pq.payload.quote;
  assert.equal(q.total, undefined);
  assert.equal(q.items[0].price, undefined);
  assert.equal(q.items[0].amount, undefined);
  assert.deepEqual(q.items[0], { product_id: 'p1', quantity: 1 });
});

test('full flow: create → complete charges once; ACP order returned; verifier saw the bound total', async () => {
  let seen;
  const { adapter, charges } = setup({ verify: async (_a, b) => { seen = b; return { ok: true, amount: b.amount, currency: b.currency, user_ref: b.user_ref }; } });
  const id = await open(adapter);
  const r = await adapter.completeCheckoutSession(req({ id, body: { payment_data: { token: 'spt_123' } }, idem: 'idem-complete-1' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'order.confirmed');
  assert.equal(r.body.order.id, 'o_acp');
  assert.equal(r.body.order.amount_total, 113);
  assert.equal(charges(), 1);
  assert.equal(seen.amount, 113);
  assert.equal(seen.user_ref, 'buyer_1');
});

test('complete passes payment_data to the verifier; a failed verify never charges', async () => {
  const { adapter, charges } = setup({ verify: async () => { throw new Error('authorization rejected'); } });
  const id = await open(adapter);
  const r = await adapter.completeCheckoutSession(req({ id, body: { payment_data: { token: 'bad' } }, idem: 'idem-complete-2' }));
  assert.equal(r.status, 500); // verifier threw a non-Pivota error → generic, no leak
  assert.ok(!JSON.stringify(r.body).includes('authorization rejected'));
  assert.equal(charges(), 0);
});

test('ownership: buyer B cannot read/complete buyer A’s checkout session', async () => {
  const { adapter, charges } = setup();
  const idA = await open(adapter, 'buyer_A');
  const get = await adapter.getCheckoutSession(req({ id: idA, buyer: 'buyer_B', idem: null }));
  assert.equal(get.status, 409);
  assert.equal(get.body.code, 'STATE_LINKAGE_MISMATCH');
  const comp = await adapter.completeCheckoutSession(req({ id: idA, buyer: 'buyer_B', body: { payment_data: { token: 't' } }, idem: 'idem-x-1' }));
  assert.equal(comp.status, 409);
  assert.equal(charges(), 0);
});

test('get on an unknown session → 404', async () => {
  const { adapter } = setup();
  const r = await adapter.getCheckoutSession(req({ id: 'cs_nope', idem: null }));
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'QUOTE_NOT_FOUND');
});

test('complete twice on one session (different idem keys) cannot double-charge', async () => {
  const { adapter, charges } = setup();
  const id = await open(adapter);
  await adapter.completeCheckoutSession(req({ id, body: { payment_data: { token: 't' } }, idem: 'idem-c-A' }));
  const second = await adapter.completeCheckoutSession(req({ id, body: { payment_data: { token: 't' } }, idem: 'idem-c-B' }));
  assert.equal(second.status, 409); // QUOTE_ALREADY_USED
  assert.equal(charges(), 1);
});

test('cancel a created session → canceled', async () => {
  const { adapter } = setup();
  const id = await open(adapter);
  const r = await adapter.cancelCheckoutSession(req({ id, idem: 'idem-cancel-1' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'canceled');
});

test('requires_action handoff surfaced verbatim; raw client_secret never echoed', async () => {
  const { adapter } = setup();
  // make submit_payment return a redirect handoff + a raw client_secret
  const redirect = 'https://paypal.example/checkoutnow?token=EC-9&code=AUTH';
  const adp = createAcpRestAdapter({
    executor: createCanonicalExecutor({
      kernel: new SafetyKernel({
        upstream: async (op) => op === 'preview_quote' ? QUOTE : op === 'create_order' ? { order_id: 'o_acp', acp_state: {} }
          : op === 'submit_payment' ? { payment_id: 'pay1', payment_status: 'requires_action', redirect_url: redirect, client_secret: 'cs_raw_secret', qr_code: 'qr-data' } : {},
        secret: KSECRET, log: quiet, now: () => FIXED_NOW,
      }),
      upstream: async () => ({}), verifyPaymentAuthorization: okVerify,
    }),
    sessionStore: new InMemoryKvStore({ now: () => FIXED_NOW }), signingSecret: SECRET,
    resolveUserRef: async (r) => r.headers['x-test-buyer'], now: () => FIXED_NOW,
  });
  const id = await open(adp);
  const r = await adp.completeCheckoutSession(req({ id, body: { payment_data: { token: 't' } }, idem: 'idem-ra-1' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.requires_action.redirect_url, redirect); // verbatim — token=/code= preserved for the buyer
  assert.equal(r.body.requires_action.qr_code, 'qr-data');
  assert.ok(!JSON.stringify(r.body).includes('cs_raw_secret'), 'raw client_secret leaked into ACP response');
});

test('product feed returns mapped ACP items', async () => {
  const { adapter } = setup({ getProducts: async () => [{ product_id: 'p1', title: 'Sock', description: 'warm', price: '9.99', currency: 'USD', in_stock: true, images: ['http://img/1'] }] });
  const r = await adapter.productFeed(req({ body: {}, idem: null }));
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 1);
  assert.equal(r.body.products[0].id, 'p1');
  assert.equal(r.body.products[0].title, 'Sock');
  assert.equal(r.body.products[0].availability, 'in_stock');
  assert.equal(r.body.products[0].image_link, 'http://img/1');
});

test('P0 body integrity: the adapter prices from the SIGNED rawBody, not a mutated parsed body', async () => {
  const { adapter, upstreamCalls } = setup();
  const r = req({ body: CART }); // signs over rawBody=JSON(CART) (quantity 1)
  r.body = { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 99 }] }; // middleware tampers parsed body
  // rawBody (signed) is unchanged → signature still valid → adapter must use rawBody's quantity 1
  const res = await adapter.createCheckoutSession(r);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const pq = upstreamCalls.find((c) => c.op === 'preview_quote');
  assert.equal(pq.payload.quote.items[0].quantity, 1, 'must price the SIGNED body, not the tampered parsed body');
});

test('P0 body integrity: a body-bearing request with no signed raw body fails closed', async () => {
  const { adapter } = setup();
  const ts = String(FIXED_NOW);
  // sign over an EMPTY body, then send no rawBody — auth passes but there is no signed body to act on
  const r = { headers: { timestamp: ts, signature: sign('', ts), 'idempotency-key': 'idem-norb-1', 'x-test-buyer': 'buyer_1' }, rawBody: '', body: CART, params: {} };
  const res = await adapter.createCheckoutSession(r);
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'USER_AUTH_REQUIRED');
});

test('P0 leak: secrets in merchant line_items/totals are scrubbed from the ACP session response', async () => {
  const dirtyQuote = {
    merchant_of_record: 'merch_A', currency: 'USD',
    locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113, debug_secret: 'sk_live_LEAK1234' },
    line_items: [{ product_id: 'p1', quantity: 1, supplier_token: 'tok_leak', note: 'pay 4111 1111 1111 1111' }],
    acp_state: {},
  };
  const { adapter } = setup({ quote: dirtyQuote });
  const r = await adapter.createCheckoutSession(req({ body: CART }));
  assert.equal(r.status, 201);
  const blob = JSON.stringify(r.body);
  assert.ok(!blob.includes('sk_live_LEAK1234'), 'totals secret leaked');
  assert.ok(!blob.includes('tok_leak'), 'line_item token leaked');
  assert.ok(!blob.includes('4111 1111'), 'PAN leaked');
  assert.equal(r.body.line_items[0].product_id, 'p1'); // benign data preserved
  assert.equal(r.body.totals.total, 113);
});

test('P1 create idempotency: a replayed (buyer, key) returns the ORIGINAL session, no new one minted', async () => {
  const { adapter, sessionStore, upstreamCalls } = setup();
  const first = await adapter.createCheckoutSession(req({ body: CART, idem: 'idem-dedup-1' }));
  const second = await adapter.createCheckoutSession(req({ body: CART, idem: 'idem-dedup-1' }));
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);          // replay
  assert.equal(second.body.id, first.body.id); // SAME ACP session id
  // only the FIRST create minted a quote; the replay returned the original via a read (no new preview_quote)
  assert.equal(upstreamCalls.filter((c) => c.op === 'preview_quote').length, 1);
});

test('P1 feed auth: /feed requires auth by default; publicFeed:true serves unauthenticated', async () => {
  const guarded = setup(); // publicFeed not set → default false
  const denied = await guarded.adapter.productFeed({ headers: {}, rawBody: '', body: {}, params: {} });
  assert.equal(denied.status, 401);
  const open = setup({ publicFeed: true });
  const served = await open.adapter.productFeed({ headers: {}, rawBody: '', body: {}, params: {} });
  assert.equal(served.status, 200);
  assert.equal(served.body.count, 1);
});

test('P2 validation: empty items / non-object body are rejected before pricing', async () => {
  const { adapter, upstreamCalls } = setup();
  const empty = await adapter.createCheckoutSession(req({ body: { merchant_id: 'merch_A', items: [] }, idem: 'idem-empty-1' }));
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'QUOTE_REQUIRED');
  const badQty = await adapter.createCheckoutSession(req({ body: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 0 }] }, idem: 'idem-bq-1' }));
  assert.equal(badQty.status, 400);
  // non-object signed body
  const ts = String(FIXED_NOW);
  const rawBody = '[]';
  const arr = { headers: { timestamp: ts, signature: sign(rawBody, ts), 'idempotency-key': 'idem-arr-1', 'x-test-buyer': 'buyer_1' }, rawBody, body: [], params: {} };
  const arrRes = await adapter.createCheckoutSession(arr);
  assert.equal(arrRes.status, 400);
  assert.equal(upstreamCalls.filter((c) => c.op === 'preview_quote').length, 0, 'pricing never called for invalid bodies');
});

test('P2 malformed session record fails closed', async () => {
  const { adapter, sessionStore } = setup();
  await sessionStore.set('cs_bad', { user_ref: 'buyer_1' }); // missing quote_id
  const r = await adapter.getCheckoutSession(req({ id: 'cs_bad', idem: null }));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'STATE_LINKAGE_MISMATCH');
});

test('P2 session response does NOT preserve a merchant handoff-named string verbatim (no payment redirect in a quote)', async () => {
  const dirtyQuote = {
    merchant_of_record: 'merch_A', currency: 'USD',
    locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
    line_items: [{ product_id: 'p1', quantity: 1, redirect_url: 'https://m/debug?client_secret=cs_live&token=tok_live' }],
    acp_state: {},
  };
  const { adapter } = setup({ quote: dirtyQuote });
  const r = await adapter.createCheckoutSession(req({ body: CART }));
  assert.equal(r.status, 201);
  // a session response is NOT a payment handoff → the merchant redirect_url's secrets are scrubbed
  const url = r.body.line_items[0].redirect_url;
  assert.ok(!url.includes('cs_live'), 'session line_item redirect secret leaked');
  assert.ok(!url.includes('tok_live'), 'session line_item token leaked');
});

test('P2 create-dedup key is collision-safe across buyers/keys containing spaces', async () => {
  const { adapter } = setup();
  const a = await adapter.createCheckoutSession(req({ body: CART, buyer: 'a b', idem: 'c' }));
  const b = await adapter.createCheckoutSession(req({ body: CART, buyer: 'a', idem: 'b c' }));
  assert.equal(a.status, 201);
  assert.equal(b.status, 201, 'distinct (buyer,key) must not collide on the dedup key');
  assert.notEqual(a.body.id, b.body.id);
});

test('P2 authenticated feed derives the filter query from the SIGNED body, not an unsigned parsed body', async () => {
  let seenQuery;
  const { adapter } = setup({ getProducts: async (q) => { seenQuery = q; return []; } });
  const r = req({ body: { query: { q: 'shoes' } }, idem: null });
  r.body = { query: { q: 'UNSIGNED_TAMPER' } }; // middleware tampers the parsed body after signing
  const res = await adapter.productFeed(r);
  assert.equal(res.status, 200);
  assert.deepEqual(seenQuery, { q: 'shoes' }, 'feed must use the SIGNED query, not the tampered parsed body');
});

test('construction refuses to run unauthenticated (no signingSecret and no authenticate)', () => {
  assert.throws(() => createAcpRestAdapter({
    executor: { execute: async () => ({}) }, sessionStore: new InMemoryKvStore({ now: () => FIXED_NOW }), resolveUserRef: async () => 'u',
  }), /unauthenticated/);
});
