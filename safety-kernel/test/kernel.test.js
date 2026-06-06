// C2 tests — assert INV-1..INV-5 hold. No network: upstream is a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { PivotaCommerceError } from '../src/errors.js';
import { redact } from '../src/redact.js';

const SECRET = 'test-secret-please-rotate-0123456789';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };

function makeKernel(upstreamImpl) {
  const calls = [];
  const upstream = async (op, payload, headers) => {
    calls.push({ op, payload, headers });
    return upstreamImpl(op, payload, headers);
  };
  const kernel = new SafetyKernel({ upstream, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  return { kernel, calls };
}

const QUOTE_UPSTREAM = () => ({
  merchant_of_record: 'merch_A',
  currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }],
  acp_state: { acp_session_id: 'acp_1' },
});

async function quoteAndOrder(kernel) {
  const quote = await kernel.previewQuote({ quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const order = await kernel.createOrder({ idempotency_key: 'idem-order-0001', order: { quote_id: quote.quote_id, shipping_address: {} } }, CTX);
  return { quote, order };
}

test('INV-1 single-use: one quote backs exactly one order (a 2nd create, different key, is refused)', async () => {
  let orders = 0;
  const { kernel } = makeKernel((op) => (op === 'create_order' ? { order_id: `o_${++orders}`, acp_state: {} } : QUOTE_UPSTREAM()));
  const quote = await kernel.previewQuote({ quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  await kernel.createOrder({ idempotency_key: 'idem-order-A', order: { quote_id: quote.quote_id, shipping_address: {} } }, CTX);
  // a same-key retry replays the SAME order (idempotency ledger short-circuits before the quote claim)
  const replay = await kernel.createOrder({ idempotency_key: 'idem-order-A', order: { quote_id: quote.quote_id, shipping_address: {} } }, CTX);
  assert.equal(replay.order_id, 'o_1');
  // a DIFFERENT key on the same quote must be refused — it would otherwise mint a 2nd order = double charge
  await assert.rejects(
    kernel.createOrder({ idempotency_key: 'idem-order-B', order: { quote_id: quote.quote_id, shipping_address: {} } }, CTX),
    (e) => e instanceof PivotaCommerceError && e.code === 'QUOTE_ALREADY_USED',
  );
  assert.equal(orders, 1, 'exactly one upstream order created from one quote');
});

test('INV-1: create_order without quote_id is refused', async () => {
  const { kernel } = makeKernel(QUOTE_UPSTREAM);
  await assert.rejects(
    kernel.createOrder({ idempotency_key: 'idem-x-0001', order: { shipping_address: {} } }, CTX),
    (e) => e instanceof PivotaCommerceError && e.code === 'QUOTE_REQUIRED',
  );
});

test('INV-1: expired quote is refused', async () => {
  let t = 1000;
  const { kernel } = makeKernel(QUOTE_UPSTREAM);
  // override clock
  kernel._now = () => t;
  kernel.quotes._now = () => t;
  const quote = await kernel.previewQuote({ quote: {} }, CTX);
  t += 11 * 60 * 1000; // past 10m TTL
  await assert.rejects(
    kernel.createOrder({ idempotency_key: 'idem-exp-0001', order: { quote_id: quote.quote_id, shipping_address: {} } }, CTX),
    (e) => e.code === 'QUOTE_EXPIRED',
  );
});

test('INV-1/§6: quote bound to another user/session is refused', async () => {
  const { kernel } = makeKernel(QUOTE_UPSTREAM);
  const quote = await kernel.previewQuote({ quote: {} }, CTX);
  await assert.rejects(
    kernel.createOrder(
      { idempotency_key: 'idem-link-0001', order: { quote_id: quote.quote_id, shipping_address: {} } },
      { user_ref: 'user_2', acp_session_id: 'acp_1' },
    ),
    (e) => e.code === 'STATE_LINKAGE_MISMATCH',
  );
});

test('INV-5: order amount comes from quote snapshot, not the model', async () => {
  const { kernel } = makeKernel((op) => (op === 'preview_quote' ? QUOTE_UPSTREAM() : { order_id: 'o1', acp_state: {} }));
  const { order } = await quoteAndOrder(kernel);
  assert.equal(order.amount_total, 113);
  assert.equal(order.currency, 'USD');
  assert.equal(order.merchant_of_record, 'merch_A');
});

test('INV-4: replaying create_order with same key does not duplicate', async () => {
  let made = 0;
  const { kernel } = makeKernel((op) => (op === 'preview_quote' ? QUOTE_UPSTREAM() : (made++, { order_id: 'o1', acp_state: {} })));
  const quote = await kernel.previewQuote({ quote: {} }, CTX);
  const args = { idempotency_key: 'idem-dup-0001', order: { quote_id: quote.quote_id, shipping_address: {} } };
  const a = await kernel.createOrder(args, CTX);
  const b = await kernel.createOrder(args, CTX);
  assert.equal(a.order_id, b.order_id);
  assert.equal(made, 1, 'upstream create called exactly once');
});

test('INV-4: same key + different body => conflict', async () => {
  const { kernel } = makeKernel((op) => (op === 'preview_quote' ? QUOTE_UPSTREAM() : { order_id: 'o1', acp_state: {} }));
  const quote = await kernel.previewQuote({ quote: {} }, CTX);
  await kernel.createOrder({ idempotency_key: 'k-conflict-1', order: { quote_id: quote.quote_id, shipping_address: { city: 'A' } } }, CTX);
  await assert.rejects(
    kernel.createOrder({ idempotency_key: 'k-conflict-1', order: { quote_id: quote.quote_id, shipping_address: { city: 'B' } } }, CTX),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('INV-3: submit_payment without a confirmation token is refused', async () => {
  const { kernel } = makeKernel((op) => (op === 'preview_quote' ? QUOTE_UPSTREAM() : { order_id: 'o1', acp_state: {}, payment_status: 'succeeded', payment_id: 'pay1' }));
  const { order } = await quoteAndOrder(kernel);
  await assert.rejects(
    kernel.submitPayment(
      { idempotency_key: 'idem-pay-0001', payment: { order_id: order.order_id, expected_amount: 113, currency: 'USD' } },
      CTX,
    ),
    (e) => e.code === 'CONFIRMATION_REQUIRED',
  );
});

test('INV-2: expected_amount mismatch => PRICE_CHANGED (amount from kernel order store, not ctx)', async () => {
  const { kernel } = makeKernel((op) => (op === 'preview_quote' ? QUOTE_UPSTREAM() : { order_id: 'o1', acp_state: {}, payment_status: 'succeeded', payment_id: 'pay1' }));
  const { order } = await quoteAndOrder(kernel);
  const token = await kernel.mintConfirmation({ order_id: order.order_id }, CTX);
  await assert.rejects(
    kernel.submitPayment(
      { idempotency_key: 'idem-pay-0002', confirmation_token: token, payment: { order_id: order.order_id, expected_amount: 1, currency: 'USD' } },
      CTX,
    ),
    (e) => e.code === 'PRICE_CHANGED',
  );
});

test('INV-2 (Codex B1 fix): a lying caller cannot lower the charge — no ctx.orderAmount path exists', async () => {
  const { kernel } = makeKernel((op) => (op === 'preview_quote' ? QUOTE_UPSTREAM() : { order_id: 'o1', acp_state: {}, payment_status: 'succeeded', payment_id: 'pay1' }));
  const { order } = await quoteAndOrder(kernel);
  // Attacker mints with no amount (kernel derives 113 from its store) and pays claiming 1.
  const token = await kernel.mintConfirmation({ order_id: order.order_id }, CTX);
  await assert.rejects(
    // even passing a forged orderAmount in ctx must be ignored
    kernel.submitPayment(
      { idempotency_key: 'idem-pay-lie', confirmation_token: token, payment: { order_id: order.order_id, expected_amount: 1, currency: 'USD' } },
      { ...CTX, orderAmount: 1, orderCurrency: 'USD' },
    ),
    (e) => e.code === 'PRICE_CHANGED',
  );
});

test('S3: missing expected_amount fails closed', async () => {
  const { kernel } = makeKernel((op) => (op === 'preview_quote' ? QUOTE_UPSTREAM() : { order_id: 'o1', acp_state: {}, payment_status: 'succeeded', payment_id: 'pay1' }));
  const { order } = await quoteAndOrder(kernel);
  const token = await kernel.mintConfirmation({ order_id: order.order_id }, CTX);
  await assert.rejects(
    kernel.submitPayment({ idempotency_key: 'idem-pay-noamt', confirmation_token: token, payment: { order_id: order.order_id, currency: 'USD' } }, CTX),
    (e) => e.code === 'PRICE_CHANGED',
  );
});

test('INV-3: happy path pays once with a valid token, and token is single-use', async () => {
  const { kernel } = makeKernel((op) => (op === 'preview_quote' ? QUOTE_UPSTREAM() : (op === 'create_order' ? { order_id: 'o1', acp_state: {} } : { order_id: 'o1', payment_id: 'pay1', payment_status: 'succeeded', ap2_state: { mandate_id: 'm1' } })));
  const { order } = await quoteAndOrder(kernel);
  const token = await kernel.mintConfirmation({ order_id: order.order_id }, CTX);
  const res = await kernel.submitPayment({ idempotency_key: 'idem-pay-0003', confirmation_token: token, payment: { order_id: order.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  assert.equal(res.payment_status, 'succeeded');
  // reuse the same token (new idem key) => REFUSED. With the per-order charge-once lock (Codex P0-2),
  // a paid order is rejected as IDEMPOTENCY_CONFLICT (order_already_paid) before the token is even
  // re-checked. Either that or CONFIRMATION_INVALID is a correct refusal — what matters: not charged twice.
  await assert.rejects(
    kernel.submitPayment({ idempotency_key: 'idem-pay-0004', confirmation_token: token, payment: { order_id: order.order_id, expected_amount: 113, currency: 'USD' } }, CTX),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT' || e.code === 'CONFIRMATION_INVALID',
  );
});

test('M4: requires_action is surfaced verbatim, not fabricated', async () => {
  const { kernel } = makeKernel((op) => (
    op === 'preview_quote' ? QUOTE_UPSTREAM()
    : op === 'create_order' ? { order_id: 'o1', acp_state: {} }
    : { order_id: 'o1', payment_id: 'pay1', payment_status: 'requires_action', redirect_url: 'https://psp.example/3ds/abc', instructions: 'Complete 3DS' }
  ));
  const { order } = await quoteAndOrder(kernel);
  const token = await kernel.mintConfirmation({ order_id: order.order_id }, CTX);
  const res = await kernel.submitPayment({ idempotency_key: 'idem-pay-ra', confirmation_token: token, payment: { order_id: order.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  assert.equal(res.payment_status, 'requires_action');
  assert.equal(res.redirect_url, 'https://psp.example/3ds/abc');
  assert.equal(res.instructions, 'Complete 3DS');
});

test('USER_AUTH_REQUIRED when user_ref missing on a write', async () => {
  const { kernel } = makeKernel(QUOTE_UPSTREAM);
  await assert.rejects(kernel.previewQuote({ quote: {} }, {}), (e) => e.code === 'USER_AUTH_REQUIRED');
});

test('Codex P0: submit_payment replay after success returns cached result, charges once, token not re-consumed', async () => {
  let charges = 0;
  const { kernel } = makeKernel((op) => (
    op === 'preview_quote' ? QUOTE_UPSTREAM()
    : op === 'create_order' ? { order_id: 'o1', acp_state: {} }
    : (charges++, { order_id: 'o1', payment_id: 'pay1', payment_status: 'succeeded', ap2_state: { mandate_id: 'm1' } })
  ));
  const { order } = await quoteAndOrder(kernel);
  const token = await kernel.mintConfirmation({ order_id: order.order_id }, CTX);
  const args = { idempotency_key: 'idem-pay-replay', confirmation_token: token, payment: { order_id: order.order_id, expected_amount: 113, currency: 'USD' } };
  const first = await kernel.submitPayment(args, CTX);
  const second = await kernel.submitPayment(args, CTX); // network-timeout retry, same key + body + token
  assert.equal(first.payment_id, second.payment_id);
  assert.equal(charges, 1, 'upstream charged exactly once');
});

test('Codex P1: create_order replay after quote expiry returns original order, not QUOTE_EXPIRED', async () => {
  let t = 1000;
  let made = 0;
  const { kernel } = makeKernel((op) => (op === 'preview_quote' ? QUOTE_UPSTREAM() : (made++, { order_id: 'o1', acp_state: {} })));
  kernel._now = () => t; kernel.quotes._now = () => t;
  const quote = await kernel.previewQuote({ quote: {} }, CTX);
  const args = { idempotency_key: 'idem-order-replay', order: { quote_id: quote.quote_id, shipping_address: {} } };
  const a = await kernel.createOrder(args, CTX);
  t += 11 * 60 * 1000; // quote now expired
  const b = await kernel.createOrder(args, CTX); // replay
  assert.equal(a.order_id, b.order_id);
  assert.equal(made, 1, 'upstream create called once despite expiry on replay');
});

test('Codex P1: submit_payment same key + different body => IDEMPOTENCY_CONFLICT', async () => {
  const { kernel } = makeKernel((op) => (
    op === 'preview_quote' ? QUOTE_UPSTREAM()
    : op === 'create_order' ? { order_id: 'o1', acp_state: {} }
    : { order_id: 'o1', payment_id: 'pay1', payment_status: 'succeeded' }
  ));
  const { order } = await quoteAndOrder(kernel);
  const token = await kernel.mintConfirmation({ order_id: order.order_id }, CTX);
  await kernel.submitPayment({ idempotency_key: 'k-pay-conflict', confirmation_token: token, payment: { order_id: order.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  await assert.rejects(
    kernel.submitPayment({ idempotency_key: 'k-pay-conflict', confirmation_token: token, payment: { order_id: order.order_id, expected_amount: 113, currency: 'EUR' } }, CTX),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('Codex P1-3: write without acp_session_id is refused (no undefined===undefined linkage)', async () => {
  const { kernel } = makeKernel(QUOTE_UPSTREAM);
  await assert.rejects(
    kernel.previewQuote({ quote: {} }, { user_ref: 'user_1' }),
    (e) => e.code === 'STATE_LINKAGE_MISMATCH',
  );
});

test('redact() masks ap2_state, tokens, PANs and amounts', () => {
  const out = redact({ ap2_state: { mandate_id: 'm' }, confirmation_token: 'abc.def', expected_amount: 113, note: 'card 4111 1111 1111 1111', ok: 'visible' });
  assert.equal(out.ap2_state, '[REDACTED]');
  assert.equal(out.confirmation_token, '[REDACTED]');
  assert.equal(out.expected_amount, '[REDACTED_AMOUNT]');
  assert.match(out.note, /\[REDACTED_PAN\]/);
  assert.equal(out.ok, 'visible');
});
