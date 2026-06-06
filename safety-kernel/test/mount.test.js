// Mount module tests — the single server-wiring entry point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommerceMount, COMMERCE_OPERATIONS } from '../src/mount.js';
import { makeFakePgDb } from './helpers/fakePgDb.js';

const SECRET = 'mount-secret-0123456789abcdef';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE_UPSTREAM = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: { acp_session_id: 'acp_1' },
};
const upstream = async (op) => (
  op === 'preview_quote' ? QUOTE_UPSTREAM
  : op === 'create_order' ? { order_id: 'o1', acp_state: {} }
  : op === 'submit_payment' ? { order_id: 'o1', payment_id: 'pay1', payment_status: 'succeeded' }
  : { results: [] }
);
const quiet = { info() {}, warn() {}, error() {} };

test('strict OFF: handles() is false for everything (legacy path untouched)', () => {
  const m = createCommerceMount({ upstream, secret: SECRET, strict: false, log: quiet });
  for (const op of COMMERCE_OPERATIONS) assert.equal(m.handles(op), false);
  assert.equal(m.handles('find_products'), false);
});

test('strict ON: handles() owns the money ops, not reads', () => {
  const m = createCommerceMount({ upstream, secret: SECRET, strict: true, log: quiet });
  assert.equal(m.handles('create_order'), true);
  assert.equal(m.handles('submit_payment'), true);
  assert.equal(m.handles('find_products'), false);
});

test('strict ON requires a strong secret', () => {
  assert.throws(() => createCommerceMount({ upstream, strict: true, secret: 'short', log: quiet }));
});

test('mount drives a full quote->order->confirm->pay through the kernel', async () => {
  const m = createCommerceMount({ upstream, secret: SECRET, strict: true, log: quiet });
  const q = await m.handle('preview_quote', { quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  assert.equal(q.ok, true);
  const o = await m.handle('create_order', { idempotency_key: 'idem-mount-1', order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  assert.equal(o.ok, true);
  const token = await m.mintConfirmation({ order_id: o.data.order_id }, CTX);
  const pay = await m.handle('submit_payment', { idempotency_key: 'idem-mount-2', confirmation_token: token, payment: { order_id: o.data.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  assert.equal(pay.ok, true);
  assert.equal(pay.data.payment_status, 'succeeded');
});

test('identityFromRequest reads verified auth, not the body', () => {
  const m = createCommerceMount({ upstream, secret: SECRET, strict: true, log: quiet });
  const ctx = m.identityFromRequest({ auth: { user_ref: 'usr_real', acp_session_id: 'acp_1' }, body: { payload: { user_ref: 'usr_FAKE' } } });
  assert.equal(ctx.user_ref, 'usr_real');
});

test('mount reports durable=false with no db, true with a db', () => {
  const memMount = createCommerceMount({ upstream, secret: SECRET, strict: true, log: quiet });
  assert.equal(memMount.durable, false);
  const dbMount = createCommerceMount({ upstream, secret: SECRET, strict: true, log: quiet, db: { query: async () => ({ rows: [] }) } });
  assert.equal(dbMount.durable, true);
});

test('normalizeRealUpstream: mount consumes the REAL backend contract end-to-end', async () => {
  // Raw upstream returns the REAL shapes (pricing strings, nested order_id) — the flag normalizes them.
  const realUpstream = async (op) => (
    op === 'preview_quote'
      ? { quote_id: 'q_r', currency: 'USD', pricing: { subtotal: '100.00', shipping_fee: '5.00', tax: '0.00', total: '95.00' }, line_items: [] }
      : op === 'create_order' ? { status: 'success', order: { order_id: 'ORD_R', amounts: { total: '95.00', currency: 'USD' } } } // 9500 minor == $95.00 quote (cross-check passes)
      : { payment_status: 'succeeded', payment_id: 'pay_r' }
  );
  const m = createCommerceMount({ upstream: realUpstream, secret: SECRET, strict: true, log: quiet, normalizeRealUpstream: true });
  const q = await m.handle('preview_quote', { quote: { merchant_id: 'm_123', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  assert.equal(q.ok, true, q.error?.code);
  assert.equal(q.data.merchant_of_record, 'm_123');
  assert.equal(q.data.locked_totals.total, 9500); // $95.00 → 9500 minor units
  const o = await m.handle('create_order', { idempotency_key: 'idem-real-1', order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  assert.equal(o.ok, true, o.error?.code);
  assert.equal(o.data.order_id, 'ORD_R');
});

test('auditSink receives money-path events', async () => {
  const events = [];
  const m = createCommerceMount({ upstream, secret: SECRET, strict: true, log: quiet, auditSink: (e) => events.push(e.event) });
  await m.handle('preview_quote', { quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  assert.ok(events.includes('quote_issued'));
});

test('INTEGRATION: mount({db}) wires Postgres THROUGH to the kernel registries (not just the flag)', async () => {
  // This closes the "green tests != actually wired" gap: prove a db passed to createCommerceMount
  // actually backs the kernel's quote/order/idempotency stores, by running the full flow and then
  // asserting the rows physically landed in the (fake) Postgres, namespaced per registry.
  let t = 5_000_000;
  const db = makeFakePgDb(() => t);
  const m = createCommerceMount({ upstream, secret: SECRET, strict: true, log: quiet, db, now: () => t });
  assert.equal(m.durable, true);

  const q = await m.handle('preview_quote', { quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  assert.equal(q.ok, true);
  const o = await m.handle('create_order', { idempotency_key: 'idem-mount-db-1', order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  assert.equal(o.ok, true);
  const token = await m.mintConfirmation({ order_id: o.data.order_id }, CTX);
  const pay = await m.handle('submit_payment', { idempotency_key: 'idem-mount-db-2', confirmation_token: token, payment: { order_id: o.data.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  assert.equal(pay.ok, true);
  assert.equal(pay.data.payment_status, 'succeeded');

  // Now PROVE it went to Postgres: the quote, order, idempotency, and confirmation keys exist under
  // their namespaces. (The fake's ns/key separator is opaque, so match on namespace prefix + content.)
  const keys = [...db.rows.keys()];
  const inNs = (ns, contains) => keys.some((k) => k.startsWith(ns) && k.includes(contains));
  assert.ok(inNs('quotes', q.data.quote_id), 'quote row in Postgres');
  assert.ok(inNs('orders', o.data.order_id), 'order row in Postgres');
  assert.ok(inNs('idempotency', 'idem-mount-db-1'), 'create_order idempotency row in Postgres');
  assert.ok(inNs('idempotency', 'idem-mount-db-2'), 'submit_payment idempotency row in Postgres');
  assert.ok(inNs('confirmations', 'jti:'), 'consumed confirmation jti in Postgres');
});

test('namespacePrefix isolates ALL mount rows under one prefix (staging-cleanup safety)', async () => {
  // Codex P1 fix: with a prefix, every kernel store namespace is prefixed, so a single
  // `DELETE WHERE ns LIKE prefix%` cleans everything — no broad delete of default namespaces.
  let t = 7_000_000;
  const db = makeFakePgDb(() => t);
  const m = createCommerceMount({ upstream, secret: SECRET, strict: true, log: quiet, db, now: () => t, namespacePrefix: 'val_run1_' });
  const q = await m.handle('preview_quote', { quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const o = await m.handle('create_order', { idempotency_key: 'idem-prefix-1', order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  const token = await m.mintConfirmation({ order_id: o.data.order_id }, CTX);
  await m.handle('submit_payment', { idempotency_key: 'idem-prefix-2', confirmation_token: token, payment: { order_id: o.data.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  // EVERY row's namespace must start with the prefix — nothing under a bare default namespace.
  const namespaces = [...db.rows.keys()].map((k) => k.split('\0')[0]);
  assert.ok(namespaces.length > 0);
  assert.ok(namespaces.every((ns) => ns.startsWith('val_run1_')), `all namespaces prefixed: ${[...new Set(namespaces)]}`);
});

test('INTEGRATION: a second mount on the SAME db rejects a replayed order (cross-instance via the mount)', async () => {
  let t = 6_000_000;
  const db = makeFakePgDb(() => t);
  const a = createCommerceMount({ upstream, secret: SECRET, strict: true, log: quiet, db, now: () => t });
  const b = createCommerceMount({ upstream, secret: SECRET, strict: true, log: quiet, db, now: () => t });
  const q = await a.handle('preview_quote', { quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const args = { idempotency_key: 'idem-mount-cross', order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } };
  const r1 = await a.handle('create_order', args, CTX);
  const r2 = await b.handle('create_order', args, CTX); // replay on the OTHER mount → same order, not a dup
  assert.equal(r1.ok && r2.ok, true);
  assert.equal(r1.data.order_id, r2.data.order_id);
});
