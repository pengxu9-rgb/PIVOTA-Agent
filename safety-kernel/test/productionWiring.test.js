// Production composition-root tests — proves the wiring fails CLOSED on misconfig, builds a correct backend
// HTTP upstream (probed contract, money-normalized), resolves per-buyer identity from a verified token, and
// runs an end-to-end checkout through BOTH doors over the real kernel/executor/payment-verifier. Uses stub
// fetch + locally-minted JWKS (no network, no real backend). The MCP surface is injected from the sibling
// mcp-server package (jose-free), exactly as a real deployment would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { composeProductionCommerce, createHttpBackendUpstream, WiringConfigError } from '../src/protocol/productionWiring.js';
import { InMemoryKvStore } from '../src/stores.js';
import { createCommerceToolSurface } from '../../mcp-server/src/commerceToolSurface.js';

const MERCHANT = 'merch_A';
const SECRET = 'confirmation-secret-0123456789-xyz';
const ACP_SECRET = 'acp-signing-secret-0123456789abcdef';
const WH_SECRET = 'payment-webhook-secret-0123456789';
const ISS = 'https://idp.example';
const PAY_ISS = 'https://psp.example';
const AUD = 'pivota';
const FIXED_NOW = 1_900_000_000_000;
const quiet = { info() {}, warn() {}, error() {} };

async function keypair() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey); jwk.alg = 'ES256'; jwk.use = 'sig'; jwk.kid = 'k1';
  return { privateKey, jwks: { keys: [jwk] } };
}

// a fake merchant backend (the probed operation-invoke contract) returning MAJOR-decimal strings like the real one
function fakeBackendFetch({ onCall } = {}) {
  return async (url, opts) => {
    const { operation, payload } = JSON.parse(opts.body);
    onCall?.({ operation, payload, headers: opts.headers });
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });
    // real contract: top-level `currency`; pricing uses `shipping_fee`; amounts are MAJOR-decimal strings
    if (operation === 'preview_quote') return reply({ merchant_of_record: MERCHANT, currency: 'USD', pricing: { subtotal: '100.00', tax: '8.00', shipping_fee: '5.00', total: '113.00' }, line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: {} });
    if (operation === 'create_order') return reply({ order: { order_id: 'o_be', amounts: { total: '113.00', currency: 'USD' } }, acp_state: {} });
    if (operation === 'submit_payment') return reply({ order_id: 'o_be', payment_id: 'pay_be', payment_status: 'succeeded' });
    if (operation === 'find_products') return reply({ products: [{ product_id: 'p1', title: 'Sock', price: '9.99', currency: 'USD', in_stock: true }] });
    if (operation === 'get_product_detail') return reply({ product_id: 'p1', title: 'Sock', merchant_id: MERCHANT });
    return reply({});
  };
}

function baseConfig(jwks, fetchImpl, extra = {}) {
  return {
    merchantId: MERCHANT, confirmationSecret: SECRET, acpSigningSecret: ACP_SECRET, paymentWebhookSecret: WH_SECRET,
    backend: { baseUrl: 'https://backend.example', authToken: 'be-token', fetchImpl },
    paymentIssuers: [{ iss: PAY_ISS, aud: AUD, jwks, algs: ['ES256'] }],
    identityIssuers: [{ iss: ISS, aud: AUD, jwks, algs: ['ES256'] }],
    createMcpSurface: createCommerceToolSurface,
    now: () => FIXED_NOW, log: quiet, ...extra,
  };
}

// async PSP: submit_payment returns requires_action + a payment_id → order stays charge_pending until webhook
function fakeAsyncBackendFetch() {
  return async (url, opts) => {
    const { operation } = JSON.parse(opts.body);
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });
    if (operation === 'preview_quote') return reply({ merchant_of_record: MERCHANT, currency: 'USD', pricing: { subtotal: '100.00', tax: '8.00', shipping_fee: '5.00', total: '113.00' }, line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: {} });
    if (operation === 'create_order') return reply({ order: { order_id: 'o_async', amounts: { total: '113.00', currency: 'USD' } }, acp_state: {} });
    if (operation === 'submit_payment') return reply({ order_id: 'o_async', payment_id: 'pi_async', payment_status: 'requires_action', redirect_url: 'https://psp.example/3ds?token=EC-1' });
    return reply({});
  };
}
const signWebhook = (raw) => createHmac('sha256', WH_SECRET).update(Buffer.from(raw, 'utf8')).digest('base64');

// --- fail-closed config ----------------------------------------------------------------------------------

test('fail-closed: strict mode refuses to boot without the security-critical seams', () => {
  assert.throws(() => composeProductionCommerce({ strict: true }),
    (e) => e instanceof WiringConfigError
      && /merchantId/.test(e.message) && /confirmationSecret/.test(e.message)
      && /paymentIssuers/.test(e.message) && /identityIssuers/.test(e.message)
      && /backend/.test(e.message) && /acpSigningSecret/.test(e.message)
      && /paymentWebhookSecret/.test(e.message));
});

test('fail-closed: strict requires a payment webhook secret unless syncChargesOnly===true (no truthy bypass)', async () => {
  const { jwks } = await keypair();
  // strict, durable opt-out, no webhook secret, not sync-only → rejected
  assert.throws(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { strict: true, allowEphemeralState: true, now: undefined, paymentWebhookSecret: undefined })),
    (e) => e instanceof WiringConfigError && /paymentWebhookSecret/.test(e.message));
  // a TRUTHY-but-not-true syncChargesOnly (e.g. the string "false" from env parsing) must NOT bypass (Codex P0)
  assert.throws(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { strict: true, allowEphemeralState: true, now: undefined, paymentWebhookSecret: undefined, syncChargesOnly: 'false' })),
    (e) => e instanceof WiringConfigError && /paymentWebhookSecret/.test(e.message));
  // ONLY an exact boolean true opts out
  assert.doesNotThrow(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { strict: true, allowEphemeralState: true, now: undefined, paymentWebhookSecret: undefined, syncChargesOnly: true })));
});

test('fail-closed: strict accepts a PSP-native completion path (Stripe/Adyen) in lieu of the normalized webhook secret', async () => {
  const { jwks } = await keypair();
  // no normalized paymentWebhookSecret, but a Stripe webhook secret IS configured → strict boots (Codex P2)
  assert.doesNotThrow(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { strict: true, allowEphemeralState: true, now: undefined, paymentWebhookSecret: undefined, stripeWebhookSecret: 'whsec_strict_0123456789' })));
  // Adyen HMAC key also counts
  assert.doesNotThrow(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { strict: true, allowEphemeralState: true, now: undefined, paymentWebhookSecret: undefined, adyenHmacKey: '0123456789abcdef'.repeat(4) })));
  // none of the three + not sync → still rejected
  assert.throws(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { strict: true, allowEphemeralState: true, now: undefined, paymentWebhookSecret: undefined })),
    (e) => e instanceof WiringConfigError && /async-completion path/.test(e.message));
});

test('fail-closed: a short confirmation secret is rejected', async () => {
  const { jwks } = await keypair();
  assert.throws(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { confirmationSecret: 'short' })), (e) => e instanceof WiringConfigError && /confirmationSecret/.test(e.message));
});

test('fail-closed: enableAp2 without verifyCheckoutHash is rejected', async () => {
  const { jwks } = await keypair();
  assert.throws(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { enableAp2: true })), (e) => /verifyCheckoutHash/.test(e.message));
});

test('fail-closed: a non-https JWKS uri in the payment issuer registry is rejected at boot', async () => {
  const { jwks } = await keypair();
  assert.throws(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { paymentIssuers: [{ iss: PAY_ISS, aud: AUD, jwksUri: 'http://insecure/jwks' }] })), /https/);
});

// --- backend HTTP upstream -------------------------------------------------------------------------------

test('createHttpBackendUpstream: posts the probed contract with Bearer auth + forwards Idempotency-Key', async () => {
  let seen;
  const up = createHttpBackendUpstream({ baseUrl: 'https://backend.example/', authToken: 'be-token', fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, json: async () => ({ ok: 1 }) }; } });
  await up('preview_quote', { quote: { merchant_id: MERCHANT } }, { 'Idempotency-Key': 'idem-123' });
  assert.equal(seen.url, 'https://backend.example/agent/shop/v1/invoke');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.authorization, 'Bearer be-token');
  assert.equal(seen.opts.headers['idempotency-key'], 'idem-123');
  assert.deepEqual(JSON.parse(seen.opts.body), { operation: 'preview_quote', payload: { quote: { merchant_id: MERCHANT } } });
});

test('createHttpBackendUpstream: HTTP error / network failure → MERCHANT_UNAVAILABLE PivotaCommerceError (retriable, no fallback)', async () => {
  const httpErr = createHttpBackendUpstream({ baseUrl: 'https://b.example', authToken: 't', fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }) });
  await assert.rejects(httpErr('preview_quote', {}), (e) => e.name === 'PivotaCommerceError' && e.code === 'MERCHANT_UNAVAILABLE' && e.retriable === true && e.detail?.status === 502);
  const netErr = createHttpBackendUpstream({ baseUrl: 'https://b.example', authToken: 't', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(netErr('preview_quote', {}), (e) => e.name === 'PivotaCommerceError' && e.code === 'MERCHANT_UNAVAILABLE');
});

test('createHttpBackendUpstream: missing baseUrl/authToken, non-https, and malformed URL rejected', () => {
  assert.throws(() => createHttpBackendUpstream({ authToken: 't' }), WiringConfigError);
  assert.throws(() => createHttpBackendUpstream({ baseUrl: 'https://b' }), WiringConfigError);
  // P1: plaintext http is refused (token would go over the wire); credentials/fragment refused; bad URL refused
  assert.throws(() => createHttpBackendUpstream({ baseUrl: 'http://insecure.example', authToken: 't' }), (e) => e instanceof WiringConfigError && /https/.test(e.message));
  assert.throws(() => createHttpBackendUpstream({ baseUrl: 'https://user:pass@b.example', authToken: 't' }), (e) => /credentials/.test(e.message));
  assert.throws(() => createHttpBackendUpstream({ baseUrl: 'not a url', authToken: 't' }), (e) => /valid URL/.test(e.message));
  // http allowed ONLY with the explicit opt-in AND a loopback host
  assert.doesNotThrow(() => createHttpBackendUpstream({ baseUrl: 'http://localhost:3000', authToken: 't', allowInsecureHttp: true }));
  assert.doesNotThrow(() => createHttpBackendUpstream({ baseUrl: 'http://127.0.0.1:3000', authToken: 't', allowInsecureHttp: true }));
  // a NON-loopback http host is rejected even WITH allowInsecureHttp (would ship the token plaintext)
  assert.throws(() => createHttpBackendUpstream({ baseUrl: 'http://merchant.prod.example', authToken: 't', allowInsecureHttp: true }), (e) => e instanceof WiringConfigError && /https/.test(e.message));
});

test('fail-closed: strict forbids allowInsecureHttp on the backend (no plaintext token, even loopback)', async () => {
  const { jwks } = await keypair();
  assert.throws(() => composeProductionCommerce({
    merchantId: MERCHANT, confirmationSecret: SECRET, acpSigningSecret: ACP_SECRET, strict: true, allowEphemeralState: true,
    backend: { baseUrl: 'http://localhost:3000', authToken: 't', allowInsecureHttp: true },
    paymentIssuers: [{ iss: PAY_ISS, aud: AUD, jwks, algs: ['ES256'] }],
    identityIssuers: [{ iss: ISS, aud: AUD, jwks, algs: ['ES256'] }],
    createMcpSurface: createCommerceToolSurface, log: quiet,
  }), (e) => e instanceof WiringConfigError && /allowInsecureHttp is forbidden in strict/.test(e.message));
});

test('createHttpBackendUpstream: builds the endpoint from origin + base path, dropping any query', async () => {
  let seen;
  const up = createHttpBackendUpstream({ baseUrl: 'https://b.example/api?x=1', authToken: 't', fetchImpl: async (url) => { seen = url; return { ok: true, status: 200, json: async () => ({}) }; } });
  await up('preview_quote', {});
  assert.equal(seen, 'https://b.example/api/agent/shop/v1/invoke');
});

// a durable store is recognized by the `durable === true` MARKER, not its shape (InMemoryKvStore also has
// putIfAbsent). Simulate a durable backend (like PostgresKvStore) with the marker set.
function durableStore() { const s = new InMemoryKvStore({}); Object.defineProperty(s, 'durable', { value: true }); return s; }

test('fail-closed: strict requires DURABLE storeFactory + sessionStore — an in-memory store is rejected (marker, not shape)', async () => {
  const { jwks } = await keypair();
  // strict, no durable state, no opt-out → rejected
  assert.throws(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { strict: true, now: undefined })),
    (e) => e instanceof WiringConfigError && /storeFactory/.test(e.message) && /sessionStore/.test(e.message));
  // strict with an explicit IN-MEMORY store (has putIfAbsent but durable!==true) → STILL rejected
  assert.throws(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), {
    strict: true, now: undefined, storeFactory: () => new InMemoryKvStore({}), sessionStore: new InMemoryKvStore({}),
  })), (e) => e instanceof WiringConfigError && /DURABLE/.test(e.message));
  // strict WITH durable-MARKED stores → ok
  assert.doesNotThrow(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), {
    strict: true, now: undefined, storeFactory: () => durableStore(), sessionStore: durableStore(),
  })));
  // strict WITH explicit ephemeral opt-out → ok (audited single-instance/dev)
  assert.doesNotThrow(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { strict: true, now: undefined, allowEphemeralState: true })));
});

test('fail-closed: strict rejects a short acpSigningSecret and a custom now()', async () => {
  const { jwks } = await keypair();
  assert.throws(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { strict: true, allowEphemeralState: true, now: undefined, acpSigningSecret: 'short' })),
    (e) => /acpSigningSecret/.test(e.message));
  assert.throws(() => composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { strict: true, allowEphemeralState: true })), // baseConfig sets now: FIXED_NOW
    (e) => /custom now/.test(e.message));
});

// --- end to end through both doors -----------------------------------------------------------------------

async function mintBuyerToken(privateKey, sub = 'buyer-1') {
  return new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(ISS).setAudience(AUD).setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(privateKey);
}
async function mintGrant(privateKey, checkout_session_id, { maxAmount = 50000 } = {}) {
  // exp is anchored to FIXED_NOW (the binding verifier's clock) so the allowance isn't seen as expired; iat is
  // real-now (jose crypto verifies signatures/exp against real time, and the far-future exp passes that too).
  return new SignJWT({ allowance: { max_amount: maxAmount, currency: 'USD', merchant_id: MERCHANT, checkout_session_id } })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(PAY_ISS).setAudience(AUD).setIssuedAt().setExpirationTime(Math.floor(FIXED_NOW / 1000) + 3600).setJti('g1').sign(privateKey);
}

test('E2E MCP door: identity from session claims → checkout charges the BACKEND quote total once', async () => {
  const { privateKey, jwks } = await keypair();
  const calls = [];
  const wired = composeProductionCommerce(baseConfig(jwks, fakeBackendFetch({ onCall: (c) => calls.push(c.operation) })));
  const sess = { user_ref: 'usr_mcp', acp_session_id: 'sess_mcp' };
  const created = await wired.mcp.callTool('create_checkout_session', { idempotency_key: 'mc-create-1', quote: { merchant_id: MERCHANT, items: [{ product_id: 'p1', quantity: 1 }] } }, sess);
  // backend returned MAJOR "113.00" → wrapUpstream normalized to minor 11300
  assert.equal(created.totals.total, 11300);
  // the grant binds the SESSION id (ctx.acp_session_id), not the quote/session_id param
  const grant = await mintGrant(privateKey, sess.acp_session_id);
  const out = await wired.mcp.callTool('complete_checkout_session', { idempotency_key: 'mc-pay-1', session_id: created.session_id, payment_authorization: { method: 'acp_delegated_token', token: grant } }, sess);
  assert.equal(out.payment.order_status, 'paid');
  assert.equal(out.order.amount_total, 11300); // authoritative from the backend quote, not the caller
  assert.ok(calls.includes('preview_quote') && calls.includes('create_order') && calls.includes('submit_payment'));
});

test('E2E ACP door: signed request + verified buyer token → checkout completes; amount from backend quote', async () => {
  const { privateKey, jwks } = await keypair();
  const wired = composeProductionCommerce(baseConfig(jwks, fakeBackendFetch()));
  const buyerToken = await mintBuyerToken(privateKey);
  const sign = (raw, ts) => createHmac('sha256', ACP_SECRET).update(`${ts}.${raw}`).digest('hex');
  const req = (body, id, idem) => {
    const raw = JSON.stringify(body); const ts = String(FIXED_NOW);
    return { headers: { authorization: 'Bearer platform', timestamp: ts, signature: sign(raw, ts), 'idempotency-key': idem, 'x-buyer-authorization': `Bearer ${buyerToken}` }, rawBody: raw, body, params: id ? { checkout_session_id: id } : {} };
  };
  const created = await wired.acp.createCheckoutSession(req({ merchant_id: MERCHANT, items: [{ product_id: 'p1', quantity: 1 }] }, null, 'ac-create-1'));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.totals.total, 11300);
  const grant = await mintGrant(privateKey, created.body.id);
  const done = await wired.acp.completeCheckoutSession(req({ payment_data: { method: 'acp_delegated_token', token: grant } }, created.body.id, 'ac-pay-1'));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.order.amount_total, 11300);
});

test('E2E ACP door: a request with NO verified buyer token is refused (resolveUserRef → undefined → USER_AUTH_REQUIRED)', async () => {
  const { jwks } = await keypair();
  const wired = composeProductionCommerce(baseConfig(jwks, fakeBackendFetch()));
  const sign = (raw, ts) => createHmac('sha256', ACP_SECRET).update(`${ts}.${raw}`).digest('hex');
  const raw = JSON.stringify({ merchant_id: MERCHANT, items: [{ product_id: 'p1', quantity: 1 }] }); const ts = String(FIXED_NOW);
  const res = await wired.acp.createCheckoutSession({ headers: { authorization: 'Bearer platform', timestamp: ts, signature: sign(raw, ts), 'idempotency-key': 'nb-1' }, rawBody: raw, body: JSON.parse(raw), params: {} });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'USER_AUTH_REQUIRED');
});

test('identity: an unverifiable buyer token does not resolve a user_ref (fail closed, no throw to caller)', async () => {
  const { jwks } = await keypair();
  const wired = composeProductionCommerce(baseConfig(jwks, fakeBackendFetch()));
  const ref = await wired.resolveUserRef({ headers: { 'x-buyer-authorization': 'Bearer not-a-jwt' } });
  assert.equal(ref, undefined);
});

test('E2E webhook: an async charge (charge_pending) is finalized to paid by a SIGNED webhook on this kernel', async () => {
  const { privateKey, jwks } = await keypair();
  const wired = composeProductionCommerce(baseConfig(jwks, fakeAsyncBackendFetch()));
  const sess = { user_ref: 'usr_mcp', acp_session_id: 'sess_mcp' };
  const created = await wired.mcp.callTool('create_checkout_session', { idempotency_key: 'wh-create-1', quote: { merchant_id: MERCHANT, items: [{ product_id: 'p1', quantity: 1 }] } }, sess);
  const grant = await mintGrant(privateKey, sess.acp_session_id);
  const out = await wired.mcp.callTool('complete_checkout_session', { idempotency_key: 'wh-pay-1', session_id: created.session_id, payment_authorization: { method: 'acp_delegated_token', token: grant } }, sess);
  // the PSP returned requires_action → the order is charge_pending, NOT yet paid (no double-finalize)
  assert.equal(out.payment.order_status, 'charge_pending');
  assert.equal(out.order.order_id, 'o_async');

  // a forged webhook signature is rejected (no transition)
  const evt = JSON.stringify({ order_id: 'o_async', payment_id: 'pi_async', status: 'succeeded' });
  const forged = await wired.paymentWebhook({ headers: { 'x-pivota-webhook-signature': 'nope' }, rawBody: evt });
  assert.equal(forged.status, 401);

  // the correctly-signed completion webhook finalizes charge_pending → paid (correlated by payment_id)
  const ok = await wired.paymentWebhook({ headers: { 'x-pivota-webhook-signature': signWebhook(evt) }, rawBody: evt });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.transitioned, 'paid');
  // a duplicate webhook is idempotent (already paid), not a re-transition
  const dup = await wired.paymentWebhook({ headers: { 'x-pivota-webhook-signature': signWebhook(evt) }, rawBody: evt });
  assert.equal(dup.body.idempotent, true);
});

test('P2 namespace: a signed webhook whose order_id is an ACP session id (not the kernel order id) does NOT finalize', async () => {
  const { privateKey, jwks } = await keypair();
  const wired = composeProductionCommerce(baseConfig(jwks, fakeAsyncBackendFetch()));
  const sess = { user_ref: 'usr_mcp', acp_session_id: 'sess_mcp' };
  const created = await wired.mcp.callTool('create_checkout_session', { idempotency_key: 'ns-create-1', quote: { merchant_id: MERCHANT, items: [{ product_id: 'p1', quantity: 1 }] } }, sess);
  await wired.mcp.callTool('complete_checkout_session', { idempotency_key: 'ns-pay-1', session_id: created.session_id, payment_authorization: { method: 'acp_delegated_token', token: await mintGrant(privateKey, sess.acp_session_id) } }, sess);
  // wrong namespace: use the SESSION id (or the MCP session_id/quote id) as order_id → kernel has no such order
  const wrong = JSON.stringify({ order_id: 'sess_mcp', payment_id: 'pi_async', status: 'succeeded' });
  const res = await wired.paymentWebhook({ headers: { 'x-pivota-webhook-signature': signWebhook(wrong) }, rawBody: wrong });
  assert.equal(res.status, 404); // unknown_order → retryable 404, never a wrong finalize
  assert.equal(res.body.reason, 'unknown_order');
});

test('P0 reconcile: an object-returning queryPaymentStatus transitions a stuck charge_pending → paid', async () => {
  const { privateKey, jwks } = await keypair();
  let queried;
  const wired = composeProductionCommerce(baseConfig(jwks, fakeAsyncBackendFetch(), {
    reconcileMaxAgeMs: 0,
    // the kernel order is o_async / pi_async after the async complete below
    listPendingOrders: async () => [{ order_id: 'o_async', payment_id: 'pi_async', charge_pending_at: FIXED_NOW - 1000 }],
    // returns the OBJECT shape the JSDoc documents — the adapter must extract the scalar status (Codex P0)
    queryPaymentStatus: async (order) => { queried = order; return { status: 'succeeded', payment_id: 'pi_async' }; },
  }));
  const sess = { user_ref: 'usr_mcp', acp_session_id: 'sess_mcp' };
  const created = await wired.mcp.callTool('create_checkout_session', { idempotency_key: 'rc-create-1', quote: { merchant_id: MERCHANT, items: [{ product_id: 'p1', quantity: 1 }] } }, sess);
  const out = await wired.mcp.callTool('complete_checkout_session', { idempotency_key: 'rc-pay-1', session_id: created.session_id, payment_authorization: { method: 'acp_delegated_token', token: await mintGrant(privateKey, sess.acp_session_id) } }, sess);
  assert.equal(out.payment.order_status, 'charge_pending'); // stuck until reconcile

  const res = await wired.reconcile();
  assert.equal(queried.order_id, 'o_async');
  assert.deepEqual(res.reconciled, [{ order_id: 'o_async', to: 'paid' }]); // object→scalar adapter worked + transitioned
});

test('P0 reconcile: a present-but-malformed/foreign payment_id is HELD BACK (never finalizes the wrong attempt)', async () => {
  const { privateKey, jwks } = await keypair();
  // each sub-case: queryPaymentStatus asserts a payment_id that is not a matching non-empty string → no transition
  for (const badId of [123, { id: 'pi_old' }, 'pi_WRONG', '']) {
    const wired = composeProductionCommerce(baseConfig(jwks, fakeAsyncBackendFetch(), {
      reconcileMaxAgeMs: 0,
      listPendingOrders: async () => [{ order_id: 'o_async', payment_id: 'pi_async', charge_pending_at: FIXED_NOW - 1000 }],
      queryPaymentStatus: async () => ({ status: 'succeeded', payment_id: badId }),
    }));
    const sess = { user_ref: 'usr_mcp', acp_session_id: 'sess_mcp' };
    const created = await wired.mcp.callTool('create_checkout_session', { idempotency_key: 'bm-create', quote: { merchant_id: MERCHANT, items: [{ product_id: 'p1', quantity: 1 }] } }, sess);
    await wired.mcp.callTool('complete_checkout_session', { idempotency_key: 'bm-pay', session_id: created.session_id, payment_authorization: { method: 'acp_delegated_token', token: await mintGrant(privateKey, sess.acp_session_id) } }, sess);
    const res = await wired.reconcile();
    assert.equal(res.reconciled.length, 0, `badId=${JSON.stringify(badId)} must NOT finalize`);
    assert.ok(res.stillPending.some((p) => p.order_id === 'o_async'), `badId=${JSON.stringify(badId)} held back`);
  }
});

test('webhook: not built when no secret configured (synchronous-only deploys); reconcile null without query fns', async () => {
  const { jwks } = await keypair();
  const wired = composeProductionCommerce(baseConfig(jwks, fakeBackendFetch(), { paymentWebhookSecret: undefined }));
  assert.equal(wired.paymentWebhook, null);
  assert.equal(wired.reconcile, null);
});

test('reconcile: wired when listPendingOrders + queryPaymentStatus are supplied', async () => {
  const { jwks } = await keypair();
  const wired = composeProductionCommerce(baseConfig(jwks, fakeAsyncBackendFetch(), {
    listPendingOrders: async () => [], // nothing pending → clean sweep
    queryPaymentStatus: async () => ({ status: 'succeeded' }),
  }));
  assert.equal(typeof wired.reconcile, 'function');
  const res = await wired.reconcile();
  assert.ok(res && Array.isArray(res.reconciled));
});

test('PSP webhooks: built only when configured; Stripe webhook finalizes an async charge through the composed root', async () => {
  const { privateKey, jwks } = await keypair();
  const STRIPE_SECRET = 'whsec_compose_0123456789';
  // not configured → null
  const plain = composeProductionCommerce(baseConfig(jwks, fakeAsyncBackendFetch()));
  assert.equal(plain.stripeWebhook, null);
  assert.equal(plain.adyenWebhook, null);
  // configured → built + bound to the same kernel
  const wired = composeProductionCommerce(baseConfig(jwks, fakeAsyncBackendFetch(), { stripeWebhookSecret: STRIPE_SECRET, adyenHmacKey: '0123456789abcdef'.repeat(4) }));
  assert.equal(typeof wired.stripeWebhook, 'function');
  assert.equal(typeof wired.adyenWebhook, 'function');
  // drive an async charge to charge_pending, then finalize via the Stripe webhook on the SAME kernel
  const sess = { user_ref: 'usr_mcp', acp_session_id: 'sess_mcp' };
  const created = await wired.mcp.callTool('create_checkout_session', { idempotency_key: 'psp-create', quote: { merchant_id: MERCHANT, items: [{ product_id: 'p1', quantity: 1 }] } }, sess);
  const out = await wired.mcp.callTool('complete_checkout_session', { idempotency_key: 'psp-pay', session_id: created.session_id, payment_authorization: { method: 'acp_delegated_token', token: await mintGrant(privateKey, sess.acp_session_id) } }, sess);
  assert.equal(out.payment.order_status, 'charge_pending');
  // the kernel order is o_async / pi_async (from fakeAsyncBackendFetch); Stripe event carries those in metadata + PI id
  const body = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { object: 'payment_intent', id: 'pi_async', status: 'succeeded', metadata: { order_id: 'o_async' } } } });
  const tNow = Math.floor(FIXED_NOW / 1000);
  const sig = `t=${tNow},v1=${createHmac('sha256', STRIPE_SECRET).update(`${tNow}.${body}`).digest('hex')}`;
  // forged → 401
  assert.equal((await wired.stripeWebhook({ headers: { 'stripe-signature': `t=${tNow},v1=bad` }, rawBody: body })).status, 401);
  // valid → paid (the composed Stripe handler is threaded now:FIXED_NOW, so the t=FIXED_NOW sig is in-window)
  const res = await wired.stripeWebhook({ headers: { 'stripe-signature': sig }, rawBody: body });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.transitioned, 'paid');
});

test('identity: the same verified buyer token yields a stable user_ref across both doors', async () => {
  const { privateKey, jwks } = await keypair();
  const wired = composeProductionCommerce(baseConfig(jwks, fakeBackendFetch()));
  const token = await mintBuyerToken(privateKey, 'buyer-shared');
  const acpRef = await wired.resolveUserRef({ headers: { 'x-buyer-authorization': `Bearer ${token}` } });
  const direct = (await wired.verifyUserToken(token)).user_ref;
  assert.ok(acpRef?.startsWith('usr_'));
  assert.equal(acpRef, direct);
});
