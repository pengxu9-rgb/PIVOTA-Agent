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

const decisionSignal = {
  signals: [{
    value: { why_it_stands_out: [{ headline: 'Clinically backed', body: '2 studies' }], best_for: [{ label: 'Dry skin' }], evidence_profile: 'seller_plus_formula' },
    evidence: { method: 'published_intel', sources: [{ type: 'product_intel_kb', ref: 'product:p1' }] },
    freshness: { observed_at: '2026-06-01T00:00:00Z', fresh_until: null },
    review_state: 'pass',
  }],
};

test('get_product: attaches inline decision block when include:[decision] and intel exists', async () => {
  let intelCalled = false;
  const executor = createCanonicalExecutor({
    kernel: stubKernel,
    upstream: async (op) => {
      assert.equal(op, 'get_product_detail');
      return { product: { product_id: 'p1', merchant_id: 'm1', title: 'Serum' } };
    },
    localReads: {
      get_intel: async () => { intelCalled = true; return decisionSignal; },
    },
  });
  const out = await executor.execute('get_product', { payload: { product: { product_id: 'p1', merchant_id: 'm1' }, include: ['decision'] } }, {});
  assert.equal(intelCalled, true);
  assert.equal(out.product.title, 'Serum'); // base product preserved
  assert.equal(out.product.decision.evidence_profile, 'seller_plus_formula');
  assert.equal(out.product.decision.why_it_stands_out[0].headline, 'Clinically backed');
  assert.equal(out.product.decision.review_state, 'pass');
});

test('get_product: NO decision block without include:[decision] (intel not called)', async () => {
  let intelCalled = false;
  const executor = createCanonicalExecutor({
    kernel: stubKernel,
    upstream: async () => ({ product: { product_id: 'p1', title: 'Serum' } }),
    localReads: { get_intel: async () => { intelCalled = true; return decisionSignal; } },
  });
  const out = await executor.execute('get_product', { payload: { product: { product_id: 'p1' } } }, {});
  assert.equal(intelCalled, false);
  assert.equal(out.product.decision, undefined);
});

test('get_product: decision block is best-effort — intel throw never breaks the product', async () => {
  const executor = createCanonicalExecutor({
    kernel: stubKernel,
    upstream: async () => ({ product: { product_id: 'p1', title: 'Serum' } }),
    localReads: { get_intel: async () => { throw new Error('intel down'); } },
  });
  const out = await executor.execute('get_product', { payload: { product: { product_id: 'p1' }, include: ['decision'] } }, {});
  assert.equal(out.product.title, 'Serum');
  assert.equal(out.product.decision, undefined);
});

test('get_product: no decision block when intel returns no signal (flag-off / not found)', async () => {
  const executor = createCanonicalExecutor({
    kernel: stubKernel,
    upstream: async () => ({ product: { product_id: 'p1', title: 'Serum' } }),
    localReads: { get_intel: async () => ({ signals: [] }) },
  });
  const out = await executor.execute('get_product', { payload: { product: { product_id: 'p1' }, include: ['decision'] } }, {});
  assert.equal(out.product.decision, undefined);
});
