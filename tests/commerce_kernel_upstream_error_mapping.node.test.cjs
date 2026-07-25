const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.PIVOTA_API_KEY = process.env.PIVOTA_API_KEY || 'backend_test_key';

const app = require('../src/server');
const { throwCommerceKernelUpstreamError } = app._debug;

// Build a fake axios-style upstream error with the Pivota unified error envelope.
function upstreamErr({ status, code, message, details }) {
  return {
    message: message || 'Request failed',
    response: {
      status,
      data: { status: 'error', error: { code: code || 'INTERNAL_SERVER_ERROR', message: message || '', details } },
    },
  };
}

async function mappedCode(err) {
  let thrown;
  await assert.rejects(throwCommerceKernelUpstreamError('create_order', err), (e) => { thrown = e; return true; });
  return thrown;
}

test('400 INVALID_BUYER_CONTEXT → UPSTREAM_REJECTED (non-retriable), NOT MERCHANT_UNAVAILABLE', async () => {
  // The exact prod case: missing shipping_address. Was masked as MERCHANT_UNAVAILABLE (retriable, "try again").
  const e = await mappedCode(upstreamErr({
    status: 400,
    code: 'INVALID_REQUEST',
    message: 'INVALID_BUYER_CONTEXT',
    details: { error: 'INVALID_BUYER_CONTEXT', message: 'buyer_context.shipping_address is required for order creation' },
  }));
  assert.equal(e.code, 'UPSTREAM_REJECTED');
  assert.equal(e.retriable, false, 'a 400 client error must NOT be advertised as retriable');
  // The real reason is preserved in detail for logs/diagnostics (never the curated userMessage).
  assert.match(String(e.detail?.message || ''), /shipping_address is required/);
});

test('no HTTP response (network/timeout) → MERCHANT_UNAVAILABLE (retriable)', async () => {
  const e = await mappedCode({ message: 'socket hang up' /* no response */ });
  assert.equal(e.code, 'MERCHANT_UNAVAILABLE');
  assert.equal(e.retriable, true);
});

test('5xx backend error → MERCHANT_UNAVAILABLE (retriable)', async () => {
  const e = await mappedCode(upstreamErr({ status: 503, code: 'UPSTREAM_DOWN', message: 'bad gateway' }));
  assert.equal(e.code, 'MERCHANT_UNAVAILABLE');
  assert.equal(e.retriable, true);
});

test('429 rate limit → MERCHANT_UNAVAILABLE (retriable)', async () => {
  const e = await mappedCode(upstreamErr({ status: 429, code: 'RATE_LIMITED', message: 'slow down' }));
  assert.equal(e.code, 'MERCHANT_UNAVAILABLE');
});

test('known business codes still pass through', async () => {
  assert.equal((await mappedCode(upstreamErr({ status: 409, code: 'QUOTE_MISMATCH', message: 'drift' }))).code, 'PRICE_CHANGED');
  assert.equal((await mappedCode(upstreamErr({ status: 409, code: 'PRICE_CHANGED', message: 'changed' }))).code, 'PRICE_CHANGED');
  assert.equal((await mappedCode(upstreamErr({ status: 409, code: 'QUOTE_EXPIRED', message: 'old' }))).code, 'QUOTE_EXPIRED');
  assert.equal((await mappedCode(upstreamErr({ status: 409, code: 'OUT_OF_STOCK', message: 'gone' }))).code, 'OUT_OF_STOCK');
  assert.equal((await mappedCode(upstreamErr({ status: 404, code: 'QUOTE_NOT_FOUND', message: 'nope' }))).code, 'QUOTE_NOT_FOUND');
});

test('403 ownership/auth rejection → UPSTREAM_REJECTED (non-retriable), not a retriable outage', async () => {
  const e = await mappedCode(upstreamErr({ status: 403, code: 'FORBIDDEN', message: 'Not authorized for this order' }));
  assert.equal(e.code, 'UPSTREAM_REJECTED');
  assert.equal(e.retriable, false);
});

test('409 CHECKOUT_SESSION_NOT_ALLOWED → UPSTREAM_REJECTED (non-retriable)', async () => {
  const e = await mappedCode(upstreamErr({ status: 409, code: 'CHECKOUT_SESSION_NOT_ALLOWED', message: 'wrong state' }));
  assert.equal(e.code, 'UPSTREAM_REJECTED');
});
