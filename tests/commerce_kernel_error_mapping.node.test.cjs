'use strict';

// The retry-trap contract. #1829 closed the 404 lane; these pin the 400 lane it left open, and — more
// importantly — pin that NEITHER terminal classification can reach the money ops.
//
// Measured on prod 2026-07-27 against mcp.pivota.cc, before the fix:
//
//   get_product("sig_deadbeefdeadbeefdeadbeefdeadbeef")   -> MERCHANT_UNAVAILABLE, retriable:true
//   get_product("rejuran:healer-turnover-ampoule")        -> MERCHANT_UNAVAILABLE, retriable:true
//   get_product("<gated but real sig>")                   -> NO_MERCHANT_OFFER,    retriable:false  (#1829)
//
// The first two are "try again shortly" for ids that will never resolve, in a tool whose entire job is to be
// chained after search. That is a budget burn with no terminating condition.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapUpstreamErrorToKernelCode,
  COMMERCE_KERNEL_READ_OPS,
  SINGLE_PRODUCT_READ_OPS,
} = require('../src/services/commerceKernelErrorMapping');

const READ_OPS = ['get_product_detail', 'find_products', 'find_products_multi'];
const MONEY_OPS = [
  'preview_quote',
  'create_order',
  'submit_payment',
  'create_payment_link',
  'request_after_sales',
];

test('an unresolvable id on the single-product read is terminal, not a retriable outage', () => {
  assert.equal(
    mapUpstreamErrorToKernelCode({
      operation: 'get_product_detail',
      upstreamCode: 'MISSING_MERCHANT_CONTEXT',
      status: 400,
    }),
    'UNKNOWN_PRODUCT_ID',
  );
});

test('…and NOT on the search reads, where the message would be nonsense', () => {
  // "No product matches that id — search again" is bad advice for an op that was
  // given a query, not an id. MISSING_MERCHANT_CONTEXT provably originates only
  // from the get_pdp_v2 lane today, so this costs nothing and stops the arm from
  // holding an opinion it has no basis for if that ever changes.
  for (const op of ['find_products', 'find_products_multi']) {
    assert.equal(
      mapUpstreamErrorToKernelCode({
        operation: op,
        upstreamCode: 'MISSING_MERCHANT_CONTEXT',
        status: 400,
      }),
      'MERCHANT_UNAVAILABLE',
      op,
    );
  }
});

test('the unknown-id arm wins over the 404 arm when both would apply', () => {
  // Same terminal semantics and the same HTTP 404 either way; this only routes
  // the slice onto the metric that describes it accurately. Pinned so the arm
  // order is a decision, not an accident of where it was pasted.
  assert.equal(
    mapUpstreamErrorToKernelCode({
      operation: 'get_product_detail',
      upstreamCode: 'MISSING_MERCHANT_CONTEXT',
      status: 404,
    }),
    'UNKNOWN_PRODUCT_ID',
  );
});

test('THE GUARD: the same signal on a money op stays a retriable outage', () => {
  // This is the constraint that makes the change safe to ship. `throwCommerceKernelUpstreamError` is shared
  // by every kernel op. Telling a checkout agent "this will never work, do not retry" during a transient
  // condition is the mirror image of the bug being fixed, and it costs an abandoned order rather than a
  // wasted read.
  for (const op of MONEY_OPS) {
    assert.equal(
      mapUpstreamErrorToKernelCode({
        operation: op,
        upstreamCode: 'MISSING_MERCHANT_CONTEXT',
        status: 400,
      }),
      'MERCHANT_UNAVAILABLE',
      op,
    );
  }
});

test('a bare 400 on a read op is NOT treated as an unknown id', () => {
  // A 400 with no identity code is just as likely a malformed request from our own caller (a page_size out
  // of range, say). Calling that "no product matches that id" would be a lie, and a terminal one.
  assert.equal(
    mapUpstreamErrorToKernelCode({ operation: 'find_products', upstreamCode: null, status: 400 }),
    'MERCHANT_UNAVAILABLE',
  );
  assert.equal(
    mapUpstreamErrorToKernelCode({
      operation: 'find_products',
      upstreamCode: 'VALIDATION_ERROR',
      status: 400,
    }),
    'MERCHANT_UNAVAILABLE',
  );
});

test('#1829 behaviour is unchanged', () => {
  // Regression guard: the 404 lane was verified live and is green in the protocol conformance suite.
  for (const op of READ_OPS) {
    assert.equal(
      mapUpstreamErrorToKernelCode({ operation: op, upstreamCode: null, status: 404 }),
      'NO_MERCHANT_OFFER',
      op,
    );
  }
  for (const op of MONEY_OPS) {
    assert.equal(
      mapUpstreamErrorToKernelCode({ operation: op, upstreamCode: null, status: 404 }),
      'MERCHANT_UNAVAILABLE',
      op,
    );
  }
  // The explicit code is unambiguous by name, so it stays op-independent.
  for (const op of [...READ_OPS, ...MONEY_OPS]) {
    assert.equal(
      mapUpstreamErrorToKernelCode({ operation: op, upstreamCode: 'PRODUCT_NOT_FOUND', status: 500 }),
      'NO_MERCHANT_OFFER',
      op,
    );
  }
});

test('the quote/stock arms are untouched and still win over everything else', () => {
  assert.equal(
    mapUpstreamErrorToKernelCode({ operation: 'preview_quote', upstreamCode: 'QUOTE_EXPIRED', status: 409 }),
    'QUOTE_EXPIRED',
  );
  assert.equal(
    mapUpstreamErrorToKernelCode({ operation: 'preview_quote', upstreamCode: 'QUOTE_MISMATCH', status: 409 }),
    'PRICE_CHANGED',
  );
  assert.equal(
    mapUpstreamErrorToKernelCode({ operation: 'create_order', upstreamCode: 'OUT_OF_STOCK', status: 409 }),
    'OUT_OF_STOCK',
  );
});

test('anything unrecognised still falls back to the retriable outage', () => {
  assert.equal(
    mapUpstreamErrorToKernelCode({ operation: 'get_product_detail', upstreamCode: null, status: 503 }),
    'MERCHANT_UNAVAILABLE',
  );
  assert.equal(mapUpstreamErrorToKernelCode({}), 'MERCHANT_UNAVAILABLE');
});

test('the op sets are exactly what they claim', () => {
  // Pinned because both terminal classifications key off them. Adding a money op to either would silently
  // widen "never retry" onto the charge path.
  assert.deepEqual([...COMMERCE_KERNEL_READ_OPS].sort(), [...READ_OPS].sort());
  assert.deepEqual([...SINGLE_PRODUCT_READ_OPS], ['get_product_detail']);
});

test('UNKNOWN_PRODUCT_ID is a real, non-retriable code with an honest message', async () => {
  const { ERROR_CATALOG, isPivotaErrorCode, PivotaCommerceError } = await import(
    '../safety-kernel/src/errors.js'
  );
  const { toToolError } = await import('../mcp-server/src/commerceToolSurface.js');

  assert.ok(isPivotaErrorCode('UNKNOWN_PRODUCT_ID'));
  assert.equal(ERROR_CATALOG.UNKNOWN_PRODUCT_ID.retriable, false);

  const msg = ERROR_CATALOG.UNKNOWN_PRODUCT_ID.userMessage.toLowerCase();
  assert.ok(!msg.includes('try again shortly'), 'must not promise a retry');
  assert.ok(!msg.includes('temporarily'), 'must not describe a transient outage');

  // It must be distinguishable from NO_MERCHANT_OFFER: that one says the product exists but has no offer,
  // which is an active lie about an id that resolves to nothing.
  assert.notEqual(
    ERROR_CATALOG.UNKNOWN_PRODUCT_ID.userMessage,
    ERROR_CATALOG.NO_MERCHANT_OFFER.userMessage,
  );

  // And the MCP body must carry the classification, not just the code — an agent seeing an unfamiliar code
  // has no way to tell "back off" from "this will never work", so it retries.
  const body = JSON.parse(toToolError(new PivotaCommerceError('UNKNOWN_PRODUCT_ID', {})).content[0].text);
  assert.equal(body.error.code, 'UNKNOWN_PRODUCT_ID');
  assert.equal(body.error.retriable, false);
});

test('the new code is wired into audit + observability, not just the catalog', async () => {
  const { AUDIT_EVENTS } = await import('../safety-kernel/src/audit.js');
  const { ERROR_OBSERVABILITY } = await import('../safety-kernel/src/invokeHandler.js');

  assert.ok(AUDIT_EVENTS.includes('unknown_product_id'));
  assert.deepEqual(ERROR_OBSERVABILITY.UNKNOWN_PRODUCT_ID, {
    event: 'unknown_product_id',
    metric: 'unknown_product_id',
  });
  // A SEPARATE metric on purpose. no_merchant_offer counts ids WE advertised with nothing behind them — a
  // coverage gap we own. Folding stale/invented ids into it would make that metric unreadable.
  assert.notEqual(
    ERROR_OBSERVABILITY.UNKNOWN_PRODUCT_ID.metric,
    ERROR_OBSERVABILITY.NO_MERCHANT_OFFER.metric,
  );
});

test('every door answers 404 for the terminal read outcomes, not 400', () => {
  // A door that says 400 tells the caller its REQUEST was malformed and points it
  // at fixing the payload — a different lie in the same family as the retry trap.
  // The ACP adapter's STATUS_BY_CODE had no entry for either terminal code, so
  // both fell to its `?? 400` default while src/server.js correctly said 404.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'safety-kernel', 'src', 'protocol', 'acpRestAdapter.js'),
    'utf8',
  );
  const table = src.split('const STATUS_BY_CODE')[1].split('});')[0];
  for (const code of ['NO_MERCHANT_OFFER', 'UNKNOWN_PRODUCT_ID']) {
    assert.match(table, new RegExp(`${code}:\\s*404`), `${code} must map to 404 on the ACP door`);
  }
});
