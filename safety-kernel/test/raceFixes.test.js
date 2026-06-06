// Regression tests for the P0/P1 race defects Codex found in the registry→store conversion
// (REVIEW_by_codex_of_RegistryConversion.md). These pin the atomic charge-once + claim-ownership fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { IdempotencyLedger } from '../src/idempotencyLedger.js';
import { InMemoryKvStore } from '../src/stores.js';

const SECRET = 'race-secret-0123456789abcdef';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE_UPSTREAM = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: { acp_session_id: 'acp_1' },
};

function makeKernel(onCharge) {
  let charges = 0;
  const upstream = async (op) => {
    if (op === 'preview_quote') return QUOTE_UPSTREAM;
    if (op === 'create_order') return { order_id: 'o_race', acp_state: {} };
    if (op === 'submit_payment') { charges += 1; if (onCharge) await onCharge(); return { order_id: 'o_race', payment_id: 'pay1', payment_status: 'succeeded' }; }
    return {};
  };
  const kernel = new SafetyKernel({ upstream, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  return { kernel, charges: () => charges };
}

async function orderAndTokens(kernel, n = 2) {
  const q = await kernel.previewQuote({ quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const o = await kernel.createOrder({ idempotency_key: 'idem-race-order', order: { quote_id: q.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  const tokens = [];
  for (let i = 0; i < n; i++) tokens.push(await kernel.mintConfirmation({ order_id: o.order_id }, CTX));
  return { order_id: o.order_id, tokens };
}

test('P0-2: two different idem keys + two valid tokens for the same order charge ONCE', async () => {
  const { kernel, charges } = makeKernel();
  const { order_id, tokens } = await orderAndTokens(kernel, 2);
  const pay1 = await kernel.submitPayment({ idempotency_key: 'idem-pay-A1', confirmation_token: tokens[0], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  assert.equal(pay1.payment_status, 'succeeded');
  // Second valid token, different idem key → must be refused; order already paid.
  await assert.rejects(
    kernel.submitPayment({ idempotency_key: 'idem-pay-A2', confirmation_token: tokens[1], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(charges(), 1, 'upstream charged exactly once for the order');
});

test('P0-2: CONCURRENT charges for the same order (different keys) charge ONCE', async () => {
  // Make the upstream charge slow so both attempts overlap inside the op.
  let release; const gate = new Promise((r) => { release = r; });
  let started = 0;
  const { kernel, charges } = makeKernel(async () => { started += 1; if (started === 1) await gate; });
  const { order_id, tokens } = await orderAndTokens(kernel, 2);

  const p1 = kernel.submitPayment({ idempotency_key: 'idem-cc-1', confirmation_token: tokens[0], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  // Give p1 a tick to claim the charge lock, then fire p2 concurrently.
  await new Promise((r) => setImmediate(r));
  const p2 = kernel.submitPayment({ idempotency_key: 'idem-cc-2', confirmation_token: tokens[1], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  release();
  const [r1, r2] = await Promise.allSettled([p1, p2]);

  const ok = [r1, r2].filter((r) => r.status === 'fulfilled');
  const rejected = [r1, r2].filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'exactly one payment succeeds');
  assert.equal(rejected.length, 1, 'the concurrent one is refused');
  assert.equal(rejected[0].reason.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(charges(), 1, 'upstream charged exactly once despite concurrency');
});

test('P0-1/P1-1: a ledger claim is owner-scoped — failure releases only OUR claim', async () => {
  const store = new InMemoryKvStore();
  const ledger = new IdempotencyLedger({ store });
  // First attempt fails BEFORE any side effect → claim released, retry can proceed.
  await assert.rejects(ledger.run('k-owner-1', { a: 1 }, async () => { throw new Error('pre-effect fail'); }), /pre-effect fail/);
  const r = await ledger.run('k-owner-1', { a: 1 }, async () => 'ok-after-retry');
  assert.equal(r.result, 'ok-after-retry');
});

test('P1-2: a post-side-effect failure marks the key ambiguous (retry does NOT re-execute)', async () => {
  const store = new InMemoryKvStore();
  const ledger = new IdempotencyLedger({ store });
  // op signals it performed the irreversible side effect, then throws.
  await assert.rejects(
    ledger.run('k-ambig-1', { a: 1 }, async (ctx) => { ctx.sideEffectDone = true; throw new Error('post-effect bookkeeping fail'); }),
    /post-effect/,
  );
  // A retry must NOT re-run the op — it sees the ambiguous record and conflicts.
  let reran = false;
  await assert.rejects(
    ledger.run('k-ambig-1', { a: 1 }, async () => { reran = true; return 'x'; }),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(reran, false, 'op must not re-execute after an ambiguous prior attempt');
});
