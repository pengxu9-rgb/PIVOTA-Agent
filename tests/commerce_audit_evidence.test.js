'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ROUTE_AGENT_CHECKOUT,
  ROUTE_USER_TAKEOVER,
  buildCommerceAuditEvidence,
  resolveCommerceCapabilities,
} = require('../src/services/commerceAuditEvidence');

const OBSERVED_AT = '2026-08-24T00:00:00.000Z';

test('JOLSE-style cart evidence resolves to user takeover, not autonomous checkout', () => {
  const evidence = buildCommerceAuditEvidence({
    merchant_id: 'public:jolse',
    sku_id: 'jolse:97579',
    audit_run_id: 'audit_jolse_001',
    market: 'US',
    observed_at: OBSERVED_AT,
    platform: 'cafe24',
    checkout_provider: 'cafe24',
    cart: { status: 'verified', quantity: 1, price: 15.2, currency: 'USD' },
    guest_checkout: {
      status: 'security_challenged_pre_address',
      challenge_stage: 'pre_address',
    },
  });
  const resolved = resolveCommerceCapabilities({
    merchant_id: 'public:jolse',
    sku_id: 'jolse:97579',
    evidence,
    now: '2026-08-24T01:00:00.000Z',
  });

  assert.equal(resolved.sku.cartability_status, 'verified');
  assert.equal(resolved.sku.cart_price, 15.2);
  assert.equal(resolved.sku.orderability_status, 'cart_verified_not_checkout_verified');
  assert.equal(resolved.merchant.agent_route_policy, ROUTE_USER_TAKEOVER);
  assert.equal(resolved.merchant.payment_capability, 'unverified');
});

test('only merchant-authorized integration evidence can enable agent checkout', () => {
  const evidence = buildCommerceAuditEvidence({
    merchant_id: 'merchant:authorized',
    observed_at: OBSERVED_AT,
    integration: { mode: 'ucp', agent_checkout_authorized: true },
  });
  const resolved = resolveCommerceCapabilities({
    merchant_id: 'merchant:authorized',
    evidence,
    now: '2026-08-24T01:00:00.000Z',
  });

  assert.equal(resolved.merchant.agent_route_policy, ROUTE_AGENT_CHECKOUT);
  assert.equal(resolved.merchant.payment_capability, 'merchant_authorized_revalidation_required');
});

test('audit evidence refuses buyer and session data', () => {
  assert.throws(() => buildCommerceAuditEvidence({
    merchant_id: 'public:unsafe',
    sku_id: 'unsafe:1',
    cart: { status: 'verified', email: 'buyer@example.com' },
  }), /sensitive data/);
});
