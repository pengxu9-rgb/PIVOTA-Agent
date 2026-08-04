'use strict';

// POST /acp/agentic_commerce/delegate_payment on the LIVE gateway app — the permanent, spec-aware refusal of
// delegated-payment vaulting.
//
// Why this suite exists, beyond the safety-kernel unit tests: this endpoint is the one place in the whole
// gateway where a caller sends Pivota a raw PAN and CVC. The kernel-side tests prove the refusal constant is
// right; only a route-level test proves that nothing between the socket and that constant — express.json's
// rawBody stash, the ACP adapter's HMAC auth, the app's logger — ever touches the cardholder data.
//
// Booted with EVERY ACP/checkout door flag OFF (AGENT_CHECKOUT_STRICT, AGENT_CHECKOUT_ACP_REST_ENABLED, …).
// That is the point: this refusal is an architectural fact, not a capability, so it must answer identically in
// every configuration — including the one where all five real ACP checkout endpoints 404.
//
// Conventions: env set BEFORE require('../src/server'); supertest against the exported app
// (model: tests/ucp_order_webhook_receiver.node.test.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');

// The ACP 2026-04-17 / OpenAI Delegated Payment Spec request shape, shared verbatim with the safety-kernel
// conformance test so the two can never drift.
const SPEC_REQUEST = require('../safety-kernel/test/fixtures/acp_delegate_payment_request_2026-04-17.json');
const PAN = SPEC_REQUEST.payment_method.number;
const CVC = SPEC_REQUEST.payment_method.cvc;

// ---- app boot (env BEFORE require) ------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
// Every money-path door dark. The refusal must still answer.
delete process.env.AGENT_CHECKOUT_STRICT;
delete process.env.AGENT_CHECKOUT_ACP_REST_ENABLED;
delete process.env.AGENT_CHECKOUT_ACP_FEED_ENABLED;
delete process.env.AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED;

const app = require('../src/server');
const { shouldCaptureAcpRawBody } = require('../src/server')._debug;
const logger = require('../src/logger');

// ---- log capture -------------------------------------------------------------------------------------
// The app logs through this one shared pino instance, so wrapping its methods records everything the request
// emits. (pino writes to fd 1 via sonic-boom, bypassing process.stdout.write — intercepting at the logger is
// what actually sees the payloads.)

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
function captureLogs(fn) {
  const lines = [];
  const original = {};
  for (const level of LOG_LEVELS) {
    if (typeof logger[level] !== 'function') continue;
    original[level] = logger[level];
    logger[level] = (...args) => {
      try { lines.push(JSON.stringify(args)); } catch { lines.push(String(args)); }
      return original[level].apply(logger, args);
    };
  }
  const restore = () => { for (const [level, impl] of Object.entries(original)) logger[level] = impl; };
  return Promise.resolve()
    .then(fn)
    .then((result) => { restore(); return { result, logged: lines.join('\n') }; },
      (err) => { restore(); throw err; });
}

// ---- the refusal -------------------------------------------------------------------------------------

test('spec-shaped delegate_payment is refused 501 with the named reason and the PSP / Stripe SPT pointer', async () => {
  const res = await supertest(app)
    .post('/acp/agentic_commerce/delegate_payment')
    .set('content-type', 'application/json')
    .send(SPEC_REQUEST);

  // 501 Not Implemented: the request is well-formed (so not 4xx) and nothing is down (so not 503 — a retry
  // would only resend cardholder data).
  assert.equal(res.status, 501);
  // The ACP error envelope this adapter emits everywhere else: { type, code, message } (+ additive detail).
  assert.equal(res.body.type, 'error');
  assert.equal(res.body.code, 'OPERATION_NOT_ALLOWED');
  assert.equal(res.body.detail.reason, 'delegated_payment_vaulting_not_supported');
  assert.equal(res.body.detail.permanent, true);
  assert.equal(res.body.detail.endpoint_owner, 'merchant_psp');
  assert.equal(res.body.detail.delegated_payment_rail, 'stripe_shared_payment_token');
  assert.equal(res.body.detail.delegated_payment_rail_recipient, 'merchant_stripe_account');
  assert.equal(res.body.detail.merchant_of_record, false);
  assert.equal(res.body.detail.payment_vault, false);
  assert.match(res.body.message, /SharedPaymentToken/);
  assert.match(res.body.message, /PSP/);
});

test('the PAN and CVC appear in neither the response nor anything the gateway logs', async () => {
  const { result: res, logged } = await captureLogs(() => supertest(app)
    .post('/acp/agentic_commerce/delegate_payment')
    .set('content-type', 'application/json')
    // Headers a real ACP platform would send. They must not be read either — authenticating this request
    // would mean HMAC'ing the cardholder bytes.
    .set('signature', 'deadbeef')
    .set('timestamp', String(Math.floor(Date.now() / 1000)))
    .set('x-buyer-authorization', 'Bearer not-a-real-token')
    .set('idempotency-key', 'idem-delegate-1')
    .send(SPEC_REQUEST));

  assert.equal(res.status, 501);

  const responseText = `${res.text}\n${JSON.stringify(res.body)}`;
  assert.ok(!responseText.includes(PAN), 'PAN must not appear in the response');
  assert.ok(!responseText.includes(CVC), 'CVC must not appear in the response');
  assert.ok(!responseText.includes(SPEC_REQUEST.billing_address.postal_code), 'no request field is echoed');
  assert.ok(!responseText.includes(SPEC_REQUEST.allowance.checkout_session_id), 'no request field is echoed');

  assert.ok(!logged.includes(PAN), 'PAN must not be logged');
  assert.ok(!logged.includes(CVC), 'CVC must not be logged');
  assert.ok(!logged.includes(SPEC_REQUEST.billing_address.recipient_name), 'buyer name must not be logged');
  assert.ok(!logged.includes('deadbeef'), 'signature header must not be logged');
});

test('the raw wire bytes of a delegate_payment request are NEVER stashed on req.rawBody', () => {
  // The stash exists so the ACP adapter can HMAC the exact signed bytes. The refusal never authenticates, so
  // for this one path the stash would have no consumer and would only keep a PAN alive on the request object.
  assert.equal(shouldCaptureAcpRawBody('/acp/agentic_commerce/delegate_payment'), false);
  assert.equal(shouldCaptureAcpRawBody('/acp/agentic_commerce/delegate_payment/'), false);
  assert.equal(shouldCaptureAcpRawBody('/ACP/Agentic_Commerce/Delegate_Payment'), false);
  assert.equal(shouldCaptureAcpRawBody('/acp/agentic_commerce/delegate_payment?x=1'), false);
  // …while every OTHER signed door still gets its exact bytes (the carve-out must not disarm the signature
  // verification the real endpoints depend on).
  assert.equal(shouldCaptureAcpRawBody('/acp/checkout_sessions'), true);
  assert.equal(shouldCaptureAcpRawBody('/acp/checkout_sessions/cs_1/complete'), true);
  assert.equal(shouldCaptureAcpRawBody('/acp/feed'), true);
  assert.equal(shouldCaptureAcpRawBody('/ucp/order-webhook'), true);
  assert.equal(shouldCaptureAcpRawBody('/v1/chat'), false);
});

test('the refusal answers with every ACP door flag OFF — a refusal is not a capability', async () => {
  // Positive control from the same boot: the real ACP checkout endpoints are dark and 404 here.
  const dark = await supertest(app)
    .post('/acp/checkout_sessions')
    .send({ items: [{ product_id: 'p1', quantity: 1 }] });
  assert.equal(dark.status, 404, 'ACP checkout door is dark in this configuration');

  // Yet the refusal still answers, because it will never become available in any configuration.
  const res = await supertest(app).post('/acp/agentic_commerce/delegate_payment').send(SPEC_REQUEST);
  assert.equal(res.status, 501);
  assert.equal(res.body.code, 'OPERATION_NOT_ALLOWED');
});

test('an empty body is refused identically (nothing about the answer depends on the request)', async () => {
  const res = await supertest(app)
    .post('/acp/agentic_commerce/delegate_payment')
    .set('content-type', 'application/json')
    .send({});
  assert.equal(res.status, 501);
  const full = await supertest(app).post('/acp/agentic_commerce/delegate_payment').send(SPEC_REQUEST);
  assert.deepEqual(res.body, full.body);
});

test('GET on the delegate_payment path is not a door (only the POST refusal is mounted)', async () => {
  const res = await supertest(app).get('/acp/agentic_commerce/delegate_payment');
  assert.notEqual(res.status, 501);
});
