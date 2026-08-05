// Cross-protocol conformance / replay golden-trace tests — the capstone. The SAME logical checkout (cart →
// quote → complete with a verified payment credential) is driven through BOTH the MCP commerce surface
// (Gemini/Claude path) AND the ACP REST adapter (ChatGPT path), against ONE shared kernel + executor + real
// payment verifier. It proves the two ecosystems produce the IDENTICAL kernel money-path: same authoritative
// charge amount, charge-once, replay-safe, amount-from-quote, and the same binding rejections. Any adapter that
// diverged from the canonical flow (passed caller amounts, skipped session/payment binding, double-charged)
// would break here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SafetyKernel } from '../../safety-kernel/src/kernel.js';
import { InMemoryKvStore } from '../../safety-kernel/src/stores.js';
import { createCanonicalExecutor } from '../../safety-kernel/src/protocol/canonicalExecutor.js';
import { createPaymentAuthorizationVerifier } from '../../safety-kernel/src/protocol/paymentAuthorizationVerifier.js';
import { createAcpRestAdapter } from '../../safety-kernel/src/protocol/acpRestAdapter.js';
import { createCommerceToolSurface } from '../src/commerceToolSurface.js';

// This capstone exercises the REAL unified payment-BINDING verifier (createPaymentAuthorizationVerifier) with a
// STUB crypto method verifier — the jose signature/SD-JWT crypto is unit-tested in
// safety-kernel/test/protocolPaymentVerifiers.test.js, and jose is not an mcp-server dep. What matters here is
// that BOTH adapters drive the same kernel money-path + the same binding (amount/session/merchant) outcomes.
const MERCHANT = 'merch_A';
const ACP_SECRET = 'acp-signing-secret-0123456789abcdef';
const K_SECRET = 'kernel-secret-0123456789abcdef-xyz';
const FIXED_NOW = 1_900_000_000_000;
const quiet = { info() {}, warn() {}, error() {} };
const QUOTE = {
  merchant_of_record: MERCHANT, currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: {},
};
// ONE cart, handed to BOTH doors verbatim. `variant_id` is explicit so neither door needs a product read —
// default-variant RESOLUTION has its own dedicated coverage in each door's intake suite; what this file is
// for is the money path below the intake.
const CART_ITEMS = Object.freeze([Object.freeze({ product_id: 'p1', variant_id: 'v1', quantity: 1 })]);
const BUYER_EMAIL = 'conformance@example.com';
// The SAME attested buyer, presented to each door the way that door receives a verified identity: MCP reads
// it from the verified session's `claims`, ACP from its injected `resolveUserRef`. Both land on the shared
// attested-wins rule.
const MCP_CLAIMS = Object.freeze({ iss: 'https://idp.test', sub: 'buyer-1', email: BUYER_EMAIL, email_verified: true });
const mcpSession = (sessionId, user_ref = 'usr_buyer') => ({ user_ref, acp_session_id: sessionId, claims: MCP_CLAIMS });
const cart = () => ({ merchant_id: MERCHANT, items: CART_ITEMS.map((it) => ({ ...it })) });

// One shared kernel + executor + REAL unified payment-binding verifier (stub crypto); both adapters mount on it.
async function harness() {
  const charges = [];
  const previewQuotes = [];
  let orderSeq = 0;
  const kernelUpstream = async (op, payload) => {
    if (op === 'preview_quote') {
      const q = payload?.quote ?? {};
      previewQuotes.push(q);
      // ADVERSARIAL pricing: if any caller-supplied amount leaked into the pricing input, POISON the quote
      // (total: 1) so a leaking adapter would charge the wrong amount and the 113 assertion fails. Without
      // this, the amount-from-quote conformance test is hollow (Codex P0).
      const leaked = q.total != null || q.amount_total != null || q.amount != null
        || (Array.isArray(q.items) && q.items.some((it) => it && (it.price != null || it.amount != null || it.total != null)));
      if (leaked) return { ...QUOTE, locked_totals: { ...QUOTE.locked_totals, total: 1 } };
      return QUOTE;
    }
    if (op === 'create_order') return { order_id: `o_${++orderSeq}`, acp_state: {} };
    if (op === 'submit_payment') {
      charges.push({ order_id: payload?.payment?.order_id, amount: payload?.payment?.expected_amount, currency: payload?.payment?.currency });
      return { order_id: payload.payment.order_id, payment_id: `pay_${charges.length}`, payment_status: 'succeeded' };
    }
    return {};
  };
  // Freeze the kernel clock to FIXED_NOW too (the ACP adapter already uses it). Otherwise the kernel's quote
  // TTL runs on real time while the test's clock is fixed; under heavy parallel load a scheduling stall between
  // create and complete could time-expire the quote and flake the replay (Codex round-3 runner-stability note).
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: K_SECRET, log: quiet, now: () => FIXED_NOW });
  // REAL binding verifier; the crypto method is a stub that returns the credential's allowance as "verified"
  // claims (jose crypto covered in protocolPaymentVerifiers.test.js). The BINDING — merchant/amount/session/
  // currency/expiry — is the real, shared logic both adapters exercise identically.
  const paymentVerifier = createPaymentAuthorizationVerifier({
    merchantId: MERCHANT,
    now: () => FIXED_NOW,
    methods: {
      acp_delegated_token: async (authz) => {
        const g = authz?.token ?? {};
        return { max_amount: g.max_amount, currency: g.currency, merchant_id: g.merchant_id, checkout_session_id: g.checkout_session_id, expires_at: FIXED_NOW + 60_000, id: 'g1' };
      },
    },
  });
  const executor = createCanonicalExecutor({ kernel, upstream: async () => ({}), verifyPaymentAuthorization: paymentVerifier });

  const mcp = createCommerceToolSurface(executor);
  const acp = createAcpRestAdapter({
    executor, sessionStore: new InMemoryKvStore({ now: () => FIXED_NOW }), signingSecret: ACP_SECRET,
    // Object form: the same buyer, with the same ATTESTED email the MCP session carries in its claims.
    resolveUserRef: async (req) => ({ user_ref: req.headers['x-test-buyer'], customer_email: BUYER_EMAIL }),
    now: () => FIXED_NOW,
  });

  // a delegated-token allowance grant bound to a specific checkout session
  const mintGrant = async (checkout_session_id, { maxAmount = 500, currency = 'USD', merchant_id = MERCHANT } = {}) => ({ max_amount: maxAmount, currency, merchant_id, checkout_session_id });

  return { mcp, acp, mintGrant, charges: () => charges, previewQuotes: () => previewQuotes };
}

// ---- protocol drivers: each runs cart → quote → complete and returns a normalized money outcome -----------

async function mcpFlow({ mcp, mintGrant }, { idem = 'idem-mcp-1', sessionId = 'sess_mcp', maxAmount } = {}) {
  const sess = mcpSession(sessionId);
  const created = await mcp.callTool('create_checkout_session', { idempotency_key: `${idem}-c`, quote: cart() }, sess);
  const grant = await mintGrant(created.session_id, { maxAmount });
  const out = await mcp.callTool('complete_checkout_session', { idempotency_key: idem, session_id: created.session_id, payment_authorization: { method: 'acp_delegated_token', token: grant } }, sess);
  return { order_id: out.order.order_id, amount: out.order.amount_total, status: out.payment.order_status };
}

// The two doors are now fed the IDENTICAL cart and the IDENTICAL attested buyer.
//
// They were NOT, and the note that used to sit here said so: the ACP bodies carried `buyer.email` and a real
// `variant_id` while the MCP calls carried neither, "because the ACP door has PROTOCOL-LEVEL intake
// validation that the MCP door does not". That asymmetry was not a property of the protocols — it was the
// MCP door's missing intake, and it meant this capstone could not have caught an intake divergence: it was
// constructed to route around the exact gap. Both doors now import the same intake (buyerIntake.js), so the
// inputs are like-for-like and `CONFORMANCE intake parity` below asserts that the canonical quote the kernel
// prices is BYTE-IDENTICAL from either door.
function acpReq({ body = {}, id, buyer = 'usr_buyer', idem = 'idem-acp-1' } = {}) {
  const rawBody = JSON.stringify(body);
  const ts = String(FIXED_NOW);
  const headers = { authorization: 'Bearer p', timestamp: ts, signature: createHmac('sha256', ACP_SECRET).update(`${ts}.${rawBody}`).digest('hex') };
  if (idem) headers['idempotency-key'] = idem;
  if (buyer) headers['x-test-buyer'] = buyer;
  return { headers, rawBody, body, params: id ? { checkout_session_id: id } : {} };
}

async function acpFlow({ acp, mintGrant }, { idem = 'idem-acp-1', maxAmount } = {}) {
  const created = await acp.createCheckoutSession(acpReq({ body: cart(), idem: `${idem}-c` }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const acpSid = created.body.id;
  const grant = await mintGrant(acpSid, { maxAmount });
  const completed = await acp.completeCheckoutSession(acpReq({ id: acpSid, body: { payment_data: { method: 'acp_delegated_token', token: grant } }, idem }));
  return { httpStatus: completed.status, body: completed.body };
}

// ---- conformance --------------------------------------------------------------------------------------------

test('CONFORMANCE: MCP and ACP drive the SAME kernel money-path — both charge exactly the quote total, once each', async () => {
  const h = await harness();
  const m = await mcpFlow(h);
  const a = await acpFlow(h);

  // MCP outcome
  assert.equal(m.amount, 113);
  assert.equal(m.status, 'paid');
  // ACP outcome
  assert.equal(a.httpStatus, 200, JSON.stringify(a.body));
  assert.equal(a.body.order.amount_total, 113);
  assert.equal(a.body.payment_status, 'succeeded');

  // the GOLDEN TRACE at the kernel: exactly two charges (one per ecosystem), each for the authoritative 113/USD
  const charges = h.charges();
  assert.equal(charges.length, 2, 'exactly one charge per ecosystem');
  for (const c of charges) { assert.equal(c.amount, 113); assert.equal(c.currency, 'USD'); }
  // distinct orders (independent sessions), same amount — identical money behavior across protocols
  assert.notEqual(charges[0].order_id, charges[1].order_id);
});

test('CONFORMANCE: replay is charge-once in BOTH ecosystems (same idempotency key → no second charge)', async () => {
  const h = await harness();
  // MCP: complete twice with the same key
  const sess = mcpSession('sess_mcp');
  const created = await h.mcp.callTool('create_checkout_session', { idempotency_key: 'k-c', quote: cart() }, sess);
  const grant = await h.mintGrant(created.session_id);
  const args = { idempotency_key: 'k-pay', session_id: created.session_id, payment_authorization: { method: 'acp_delegated_token', token: grant } };
  const first = await h.mcp.callTool('complete_checkout_session', args, sess);
  const second = await h.mcp.callTool('complete_checkout_session', args, sess); // replay
  // the replay returns the ORIGINAL result (not just the same order id) — full body equality
  assert.deepEqual(second, first);

  // ACP: complete twice with the same key on the same session
  const aCreated = await h.acp.createCheckoutSession(acpReq({ body: cart(), idem: 'ak-c' }));
  const aGrant = await h.mintGrant(aCreated.body.id);
  const aArgs = acpReq({ id: aCreated.body.id, body: { payment_data: { method: 'acp_delegated_token', token: aGrant } }, idem: 'ak-pay' });
  const aFirst = await h.acp.completeCheckoutSession(aArgs);
  const aSecond = await h.acp.completeCheckoutSession(acpReq({ id: aCreated.body.id, body: { payment_data: { method: 'acp_delegated_token', token: aGrant } }, idem: 'ak-pay' }));
  assert.equal(aFirst.status, 200);
  assert.equal(aSecond.status, 200);
  // replay returns the byte-identical body, not merely a 200-shaped response
  assert.deepEqual(aSecond.body, aFirst.body);

  // charge-once across BOTH replays: exactly 2 charges total (one MCP order, one ACP order)
  assert.equal(h.charges().length, 2, 'replays must not add charges in either ecosystem');
});

test('CONFORMANCE isolation: a session/checkout id from one protocol cannot be driven through the other', async () => {
  const h = await harness();
  const sess = mcpSession('sess_mcp');
  // an MCP checkout session (a kernel quote_id)
  const mcpCreated = await h.mcp.callTool('create_checkout_session', { idempotency_key: 'iso-mc', quote: cart() }, sess);
  // an ACP checkout session (an adapter-minted acpSid)
  const acpCreated = await h.acp.createCheckoutSession(acpReq({ body: cart(), idem: 'iso-ac' }));

  // ACP cannot resolve/complete an MCP session id (it isn't in the ACP session store) → 404, no charge
  const acpOnMcp = await h.acp.completeCheckoutSession(acpReq({ id: mcpCreated.session_id, body: { payment_data: { method: 'acp_delegated_token', token: await h.mintGrant(mcpCreated.session_id) } }, idem: 'iso-x1' }));
  assert.equal(acpOnMcp.status, 404);

  // MCP cannot complete using an ACP checkout id (it isn't a kernel quote_id) → rejected, no charge
  await assert.rejects(
    h.mcp.callTool('complete_checkout_session', { idempotency_key: 'iso-x2', session_id: acpCreated.body.id, payment_authorization: { method: 'acp_delegated_token', token: await h.mintGrant(acpCreated.body.id) } }, sess),
    (e) => e.code === 'QUOTE_NOT_FOUND' || e.code === 'STATE_LINKAGE_MISMATCH',
  );
  assert.equal(h.charges().length, 0, 'no cross-protocol session hijack charged anything');
});

test('CONFORMANCE isolation: the SAME raw idempotency key across protocols does not cross-leak (per-buyer/session scoped)', async () => {
  const h = await harness();
  const KEY = 'shared-raw-key-123';
  // MCP complete with KEY
  const sess = mcpSession('sess_mcp');
  const mc = await h.mcp.callTool('create_checkout_session', { idempotency_key: `${KEY}-mc`, quote: cart() }, sess);
  const mOut = await h.mcp.callTool('complete_checkout_session', { idempotency_key: KEY, session_id: mc.session_id, payment_authorization: { method: 'acp_delegated_token', token: await h.mintGrant(mc.session_id) } }, sess);
  // ACP complete with the SAME raw KEY — must run its OWN flow, not replay MCP's cached result
  const ac = await h.acp.createCheckoutSession(acpReq({ body: cart(), idem: `${KEY}-ac` }));
  const aOut = await h.acp.completeCheckoutSession(acpReq({ id: ac.body.id, body: { payment_data: { method: 'acp_delegated_token', token: await h.mintGrant(ac.body.id) } }, idem: KEY }));
  assert.equal(aOut.status, 200);
  assert.notEqual(aOut.body.order.id, mOut.order.order_id); // distinct orders — no cross-protocol replay/leak
  assert.equal(h.charges().length, 2);
});

test('CONFORMANCE edge parity: a missing idempotency key on a mutation is refused by BOTH', async () => {
  const h = await harness();
  const sess = mcpSession('sess_mcp');
  await assert.rejects(
    h.mcp.callTool('create_checkout_session', { quote: cart() }, sess),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
  const aRes = await h.acp.createCheckoutSession(acpReq({ body: cart(), idem: null }));
  assert.equal(aRes.status, 409);
  assert.equal(aRes.body.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(h.charges().length, 0);
});

test('CONFORMANCE edge parity: a user-scoped op with no verified session id is refused by BOTH', async () => {
  const h = await harness();
  // MCP: user_ref but no acp_session_id
  await assert.rejects(
    h.mcp.callTool('create_checkout_session', { idempotency_key: 'ns-mc', quote: cart() }, { user_ref: 'usr_buyer' }),
    (e) => e.code === 'USER_AUTH_REQUIRED',
  );
  // ACP: no verified buyer at all
  const aRes = await h.acp.createCheckoutSession(acpReq({ body: cart(), buyer: null, idem: 'ns-ac' }));
  assert.equal(aRes.status, 401);
  assert.equal(h.charges().length, 0);
});

test('CONFORMANCE binding parity: wrong currency AND wrong merchant are rejected through BOTH adapters', async () => {
  const h = await harness();
  const sess = mcpSession('sess_mcp');
  // helper: open an MCP session and attempt complete with a poisoned grant → must reject
  const mcpReject = async (tag, grantOpts) => {
    const c = await h.mcp.callTool('create_checkout_session', { idempotency_key: `b-mc-${tag}`, quote: cart() }, sess);
    await assert.rejects(
      h.mcp.callTool('complete_checkout_session', { idempotency_key: `b-mp-${tag}`, session_id: c.session_id, payment_authorization: { method: 'acp_delegated_token', token: await h.mintGrant(c.session_id, grantOpts) } }, sess),
      (e) => e.code === 'CONFIRMATION_INVALID',
    );
  };
  const acpReject = async (tag, grantOpts) => {
    const c = await h.acp.createCheckoutSession(acpReq({ body: cart(), idem: `b-ac-${tag}` }));
    const r = await h.acp.completeCheckoutSession(acpReq({ id: c.body.id, body: { payment_data: { method: 'acp_delegated_token', token: await h.mintGrant(c.body.id, grantOpts) } }, idem: `b-ap-${tag}` }));
    assert.equal(r.status, 402);
  };
  // full symmetric matrix: wrong currency AND wrong merchant, each through BOTH adapters
  await mcpReject('cur', { currency: 'EUR' });
  await mcpReject('mer', { merchant_id: 'merch_OTHER' });
  await acpReject('cur', { currency: 'EUR' });
  await acpReject('mer', { merchant_id: 'merch_OTHER' });
  assert.equal(h.charges().length, 0, 'no mismatched-binding credential charged anything in either ecosystem');
});

test('CONFORMANCE surface parity: get returns the owned session; cancel works unpaid and refuses paid — in BOTH', async () => {
  const h = await harness();
  const sess = mcpSession('sess_mcp');
  // MCP: create → get → cancel (unpaid)
  const mc = await h.mcp.callTool('create_checkout_session', { idempotency_key: 'sp-mc', quote: cart() }, sess);
  const got = await h.mcp.callTool('get_checkout_session', { session_id: mc.session_id }, sess);
  assert.equal(got.session_id, mc.session_id);
  const cxl = await h.mcp.callTool('cancel_checkout_session', { idempotency_key: 'sp-cxl', session_id: mc.session_id }, sess);
  assert.equal(cxl.status, 'canceled');
  // ACP: create → get → cancel (unpaid)
  const ac = await h.acp.createCheckoutSession(acpReq({ body: cart(), idem: 'sp-ac' }));
  const aGot = await h.acp.getCheckoutSession(acpReq({ id: ac.body.id, idem: null }));
  assert.equal(aGot.status, 200);
  assert.equal(aGot.body.id, ac.body.id);
  const aCxl = await h.acp.cancelCheckoutSession(acpReq({ id: ac.body.id, idem: 'sp-acxl' }));
  assert.equal(aCxl.status, 200);
  assert.equal(aCxl.body.status, 'canceled');

  // a PAID order refuses cancellation — in BOTH
  // MCP: complete then cancel the resulting order → refused
  const mp = await h.mcp.callTool('create_checkout_session', { idempotency_key: 'sp-mp', quote: cart() }, sess);
  const mPaid = await h.mcp.callTool('complete_checkout_session', { idempotency_key: 'sp-mpay', session_id: mp.session_id, payment_authorization: { method: 'acp_delegated_token', token: await h.mintGrant(mp.session_id) } }, sess);
  await assert.rejects(
    h.mcp.callTool('cancel_checkout_session', { idempotency_key: 'sp-mcxl2', order_id: mPaid.order.order_id }, sess),
    (e) => e.code === 'OPERATION_NOT_ALLOWED',
  );
  // ACP: complete then cancel the same checkout session → refused
  const ap = await h.acp.createCheckoutSession(acpReq({ body: cart(), idem: 'sp-apc' }));
  await h.acp.completeCheckoutSession(acpReq({ id: ap.body.id, body: { payment_data: { method: 'acp_delegated_token', token: await h.mintGrant(ap.body.id) } }, idem: 'sp-apay' }));
  const aPaidCxl = await h.acp.cancelCheckoutSession(acpReq({ id: ap.body.id, idem: 'sp-acxl2' }));
  assert.equal(aPaidCxl.status, 409); // OPERATION_NOT_ALLOWED → 409

  assert.equal(h.charges().length, 2, 'only the two PAID completes charged; the unpaid cancels did not');
});

test('CONFORMANCE: an under-covering credential is rejected by BOTH (amount binding is identical)', async () => {
  const h = await harness();
  // MCP: grant allowance below the 113 total
  const sess = mcpSession('sess_mcp');
  const created = await h.mcp.callTool('create_checkout_session', { idempotency_key: 'u-c', quote: cart() }, sess);
  const smallGrant = await h.mintGrant(created.session_id, { maxAmount: 100 });
  await assert.rejects(
    h.mcp.callTool('complete_checkout_session', { idempotency_key: 'u-pay', session_id: created.session_id, payment_authorization: { method: 'acp_delegated_token', token: smallGrant } }, sess),
    (e) => e.code === 'CONFIRMATION_INVALID',
  );
  // ACP: same under-covering grant
  const aCreated = await h.acp.createCheckoutSession(acpReq({ body: cart(), idem: 'au-c' }));
  const aSmall = await h.mintGrant(aCreated.body.id, { maxAmount: 100 });
  const aRes = await h.acp.completeCheckoutSession(acpReq({ id: aCreated.body.id, body: { payment_data: { method: 'acp_delegated_token', token: aSmall } }, idem: 'au-pay' }));
  assert.equal(aRes.status, 402); // CONFIRMATION_INVALID → 402

  assert.equal(h.charges().length, 0, 'neither ecosystem charged on an under-covering credential');
});

test('CONFORMANCE: a credential bound to ANOTHER session is rejected by BOTH (session binding is identical)', async () => {
  const h = await harness();
  // MCP: grant bound to a different session id
  const sess = mcpSession('sess_mcp');
  const created = await h.mcp.callTool('create_checkout_session', { idempotency_key: 'x-c', quote: cart() }, sess);
  const wrongGrant = await h.mintGrant('sess_SOMEONE_ELSE');
  await assert.rejects(
    h.mcp.callTool('complete_checkout_session', { idempotency_key: 'x-pay', session_id: created.session_id, payment_authorization: { method: 'acp_delegated_token', token: wrongGrant } }, sess),
    (e) => e.code === 'CONFIRMATION_INVALID',
  );
  // ACP: grant for a different session than the one created
  const aCreated = await h.acp.createCheckoutSession(acpReq({ body: cart(), idem: 'ax-c' }));
  const aWrong = await h.mintGrant('cs_not_this_one');
  const aRes = await h.acp.completeCheckoutSession(acpReq({ id: aCreated.body.id, body: { payment_data: { method: 'acp_delegated_token', token: aWrong } }, idem: 'ax-pay' }));
  assert.equal(aRes.status, 402);
  assert.equal(h.charges().length, 0);
});

test('CONFORMANCE: amount-from-quote — a caller-injected amount is STRIPPED by BOTH (adversarial pricing stub)', async () => {
  const h = await harness();
  // ONE poisoned cart, both doors. The surface schema has no amount field; a stuffed one is dropped by the
  // allowlist on either side.
  const poisoned = () => ({ ...cart(), total: 1, items: CART_ITEMS.map((it) => ({ ...it, price: 1 })) });
  const sess = mcpSession('sess_mcp');
  const created = await h.mcp.callTool('create_checkout_session', { idempotency_key: 'q-c', amount_total: 1, quote: poisoned() }, sess);
  const grant = await h.mintGrant(created.session_id);
  const out = await h.mcp.callTool('complete_checkout_session', { idempotency_key: 'q-pay', session_id: created.session_id, payment_authorization: { method: 'acp_delegated_token', token: grant } }, sess);
  assert.equal(out.order.amount_total, 113); // the adversarial stub would have priced this 1 if total/price leaked
  // ACP: stuffed amount in the (signed) body is dropped by the allowlist
  const aCreated = await h.acp.createCheckoutSession(acpReq({ body: poisoned(), idem: 'aq-c' }));
  const aGrant = await h.mintGrant(aCreated.body.id);
  const aRes = await h.acp.completeCheckoutSession(acpReq({ id: aCreated.body.id, body: { payment_data: { method: 'acp_delegated_token', token: aGrant } }, idem: 'aq-pay' }));
  assert.equal(aRes.body.order.amount_total, 113);
  for (const c of h.charges()) assert.equal(c.amount, 113); // never the injected 1
  // and PROVE it: NO caller amount field ever reached pricing input in either ecosystem
  for (const q of h.previewQuotes()) {
    assert.equal(q.total, undefined); assert.equal(q.amount_total, undefined);
    for (const it of (q.items ?? [])) { assert.equal(it.price, undefined); assert.equal(it.amount, undefined); }
  }
});

test('CONFORMANCE: a missing/absent payment authorization is refused by BOTH before any charge', async () => {
  const h = await harness();
  const sess = mcpSession('sess_mcp');
  const created = await h.mcp.callTool('create_checkout_session', { idempotency_key: 'n-c', quote: cart() }, sess);
  await assert.rejects(
    h.mcp.callTool('complete_checkout_session', { idempotency_key: 'n-pay', session_id: created.session_id }, sess),
    (e) => e.code === 'CONFIRMATION_INVALID',
  );
  const aCreated = await h.acp.createCheckoutSession(acpReq({ body: cart(), idem: 'an-c' }));
  const aRes = await h.acp.completeCheckoutSession(acpReq({ id: aCreated.body.id, body: {}, idem: 'an-pay' }));
  assert.equal(aRes.status, 402);
  assert.equal(h.charges().length, 0);
});

// ---- intake parity --------------------------------------------------------------------------------------
//
// These are the assertions the old "the MCP door has no intake" note made impossible. They compare the two
// doors on the ONE thing that used to differ: what each hands the kernel to price.

test('CONFORMANCE intake parity: the SAME cart + SAME attested buyer yields a BYTE-IDENTICAL canonical quote', async () => {
  const h = await harness();
  await h.mcp.callTool('create_checkout_session', { idempotency_key: 'par-m', quote: cart() }, mcpSession('sess_par'));
  const acpCreated = await h.acp.createCheckoutSession(acpReq({ body: cart(), idem: 'par-a' }));
  assert.equal(acpCreated.status, 201, JSON.stringify(acpCreated.body));

  const [fromMcp, fromAcp] = h.previewQuotes();
  assert.deepEqual(fromMcp, fromAcp, 'the two doors must price the identical canonical quote');
  // and it is the RIGHT quote: the attested buyer reached buyer_context, the cart reached offer_refs.
  assert.equal(fromMcp.customer_email, BUYER_EMAIL);
  assert.deepEqual(fromMcp.items, [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }]);
});

test('CONFORMANCE intake parity: an ATTESTED email beats a caller-supplied one at BOTH doors', async () => {
  const h = await harness();
  const HOSTILE = 'model-asserted@evil.example';
  await h.mcp.callTool(
    'create_checkout_session',
    { idempotency_key: 'att-m', quote: { ...cart(), customer_email: HOSTILE } },
    mcpSession('sess_att'),
  );
  const acpCreated = await h.acp.createCheckoutSession(acpReq({ body: { ...cart(), customer_email: HOSTILE }, idem: 'att-a' }));
  assert.equal(acpCreated.status, 201, JSON.stringify(acpCreated.body));

  const [fromMcp, fromAcp] = h.previewQuotes();
  for (const q of [fromMcp, fromAcp]) assert.equal(q.customer_email, BUYER_EMAIL);
  assert.deepEqual(fromMcp, fromAcp);
});

test('CONFORMANCE intake parity: BOTH doors refuse the same defective carts, with the same code + reason', async () => {
  const h = await harness();
  const cases = [
    { name: 'sku_id only (would price an EMPTY cart)', items: [{ sku_id: 's1', quantity: 1 }], reason: 'acp_item_identity_required' },
    { name: 'no items at all', items: [], reason: undefined },
  ];
  for (const c of cases) {
    const mcpErr = await h.mcp
      .callTool('create_checkout_session', { idempotency_key: `neg-m-${c.name}`, quote: { merchant_id: MERCHANT, items: c.items } }, mcpSession('sess_neg'))
      .then(() => null, (e) => e);
    const acpRes = await h.acp.createCheckoutSession(acpReq({ body: { merchant_id: MERCHANT, items: c.items }, idem: `neg-a-${c.name}` }));
    assert.ok(mcpErr, `${c.name}: MCP must refuse`);
    assert.equal(mcpErr.code, 'QUOTE_REQUIRED', c.name);
    assert.equal(acpRes.status, 400, c.name);
    assert.equal(acpRes.body.code, mcpErr.code, `${c.name}: both doors answer the same code`);
    if (c.reason) assert.equal(acpRes.body.detail.reason, c.reason, c.name);
  }
  assert.equal(h.previewQuotes().length, 0, 'nothing was priced by either door');
});

test('CONFORMANCE intake parity: a partial shipping address is refused by BOTH, naming the same missing fields', async () => {
  const h = await harness();
  const partial = { city: 'London' };
  const mcpErr = await h.mcp
    .callTool('create_checkout_session', { idempotency_key: 'addr-m', quote: { ...cart(), shipping_address: partial } }, mcpSession('sess_addr'))
    .then(() => null, (e) => e);
  const acpRes = await h.acp.createCheckoutSession(acpReq({ body: { ...cart(), shipping_address: partial }, idem: 'addr-a' }));

  assert.ok(mcpErr);
  assert.equal(mcpErr.code, 'QUOTE_REQUIRED');
  assert.equal(acpRes.status, 400);
  assert.deepEqual(
    mcpErr.detail.acp_detail.missing_fields,
    acpRes.body.detail.missing_fields,
    'one required-address field set, one answer',
  );
  assert.deepEqual(acpRes.body.detail.missing_fields, ['name', 'address_line1', 'postal_code', 'country']);
  assert.equal(h.previewQuotes().length, 0, 'a partial destination must never price shipping/tax');
});
