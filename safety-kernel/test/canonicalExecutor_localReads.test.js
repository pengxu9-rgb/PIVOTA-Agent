// Executor coverage for the read-only intelligence ops (get_alternatives/get_offers) injected as localReads.
// Asserts: routing to the injected handler, NO identity gate (read-only), and FAIL-CLOSED when no handler is
// wired — the safety-relevant behavior on the money-adjacent /mcp surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';

const stubKernel = { previewQuote: async () => ({}) }; // satisfies the constructor; never invoked for reads

test('localReads: get_alternatives routes to the injected handler and returns its value', async () => {
  let received;
  const executor = createCanonicalExecutor({
    kernel: stubKernel,
    localReads: {
      get_alternatives: async (params, ctx) => {
        received = { params, ctx };
        return { subject: { kind: 'product', id: 'p1' }, signals: ['sig'] };
      },
    },
  });
  const out = await executor.execute('get_alternatives', { payload: { product_id: 'p1' } }, {});
  assert.deepEqual(out.signals, ['sig']);
  assert.equal(received.params.payload.product_id, 'p1');
});

test('localReads: a read-only op succeeds with NO user_ref (not identity-gated)', async () => {
  const executor = createCanonicalExecutor({
    kernel: stubKernel,
    localReads: { get_offers: async () => ({ signals: [], best_offer: null }) },
  });
  // ctx carries no user_ref / acp_session_id — must NOT throw USER_AUTH_REQUIRED.
  const out = await executor.execute('get_offers', { payload: {} }, {});
  assert.deepEqual(out, { signals: [], best_offer: null });
});

test('localReads: FAILS CLOSED (MERCHANT_UNAVAILABLE) when no localReads is wired', async () => {
  const executor = createCanonicalExecutor({ kernel: stubKernel });
  await assert.rejects(
    () => executor.execute('get_alternatives', { payload: {} }, {}),
    (err) => err && err.code === 'MERCHANT_UNAVAILABLE',
  );
});

test('localReads: FAILS CLOSED when the handler for the called op is missing', async () => {
  const executor = createCanonicalExecutor({
    kernel: stubKernel,
    localReads: { get_alternatives: async () => ({}) }, // only get_alternatives wired
  });
  await assert.rejects(
    () => executor.execute('get_offers', { payload: {} }, {}),
    (err) => err && err.code === 'MERCHANT_UNAVAILABLE',
  );
});
