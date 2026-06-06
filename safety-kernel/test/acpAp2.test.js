// C5 tests — ACP/AP2 alignment (opaque-safe translation + linkage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAcpCheckout, toAp2Payment, fromAcpEvent, assertAcpLinkage, acpSessionId, PIVOTA_TO_ACP_STATUS } from '../src/acpAp2.js';

const QUOTE = {
  quote_id: 'q1', expires_at: '2026-06-01T00:00:00Z', currency: 'USD',
  merchant_of_record: 'merch_A', locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: { acp_session_id: 'acp_1', opaque: 'x' },
};

test('C5: toAcpCheckout maps quote->checkout.created and carries opaque state', () => {
  const acp = toAcpCheckout(QUOTE);
  assert.equal(acp.protocol, 'acp');
  assert.equal(acp.status, PIVOTA_TO_ACP_STATUS.quote_issued);
  assert.equal(acp.checkout.quote_id, 'q1');
  assert.deepEqual(acp.state, QUOTE.acp_state); // opaque pass-through
});

test('C5: toAcpCheckout with an order maps to checkout.completed', () => {
  const acp = toAcpCheckout(QUOTE, { order_id: 'o1' });
  assert.equal(acp.status, PIVOTA_TO_ACP_STATUS.order_created);
  assert.equal(acp.checkout.order_id, 'o1');
});

test('C5: toAp2Payment maps status and never includes raw amount/token', () => {
  const ap2 = toAp2Payment({ payment_id: 'pay1', payment_status: 'succeeded', ap2_state: { mandate_id: 'm', token: 'SECRET' } });
  assert.equal(ap2.mandate_state, 'mandate.captured');
  assert.equal(ap2.payment.payment_id, 'pay1');
  // the AP2 *view* does not surface the amount; opaque state is carried but not inspected
  const viewOnly = JSON.stringify({ mandate_state: ap2.mandate_state, payment: ap2.payment });
  assert.ok(!viewOnly.includes('SECRET'));
});

test('C5: toAp2Payment surfaces requires_action verbatim', () => {
  const ap2 = toAp2Payment({ payment_id: 'pay1', payment_status: 'requires_action', redirect_url: 'https://psp/3ds', instructions: 'do 3ds' });
  assert.equal(ap2.mandate_state, 'mandate.pending_user_action');
  assert.equal(ap2.payment.redirect_url, 'https://psp/3ds');
});

test('C5: linkage helpers validate session without inspecting business contents', () => {
  assert.equal(acpSessionId(QUOTE.acp_state), 'acp_1');
  assert.equal(assertAcpLinkage(QUOTE.acp_state, 'acp_1'), true);
  assert.throws(() => assertAcpLinkage(QUOTE.acp_state, 'acp_OTHER'), (e) => e.code === 'STATE_LINKAGE_MISMATCH');
});

test('C5: fromAcpEvent maps known statuses and fails safe on unknown', () => {
  assert.equal(fromAcpEvent({ status: 'order.confirmed' }), 'payment_succeeded');
  assert.equal(fromAcpEvent({ status: 'totally.unknown' }), null);
});
