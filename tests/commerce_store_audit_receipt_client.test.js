'use strict';

const { buildReceipt } = require('../src/services/commerceStoreAuditReceiptClient');

test('sends only structured merchant checkout and SKU cart results', () => {
  expect(buildReceipt({
    auditRunId: 'audit-1', verificationRunId: 'verify-1', workerId: 'worker-1', probeId: 'verify-1:attempt:1',
    result: {
      verification_status: 'succeeded', observed_at: '2026-08-24T00:00:00.000Z',
      platform: { platform: 'cafe24', checkout_provider: 'cafe24' },
      cart: { status: 'verified', quantity: 1, cart_price: 15.2, currency: 'USD', raw_url: 'discarded' },
      checkout: { status: 'security_challenged_pre_address', challenge_stage: 'pre_address', page_text: 'discarded' },
      steps: [
        { step: 'storefront_access', status: 'passed', reason: 'storefront_loaded', page_text: 'discarded' },
        { step: 'add_to_cart', status: 'failed', reason: 'cart_item_not_observed', page_text: 'discarded' },
        { step: 'checkout', status: 'blocked', reason: 'challenge', raw_url: 'discarded' },
      ],
    },
  })).toEqual({
    audit_run_id: 'audit-1', verification_run_id: 'verify-1', worker_id: 'worker-1', probe_id: 'verify-1:attempt:1',
    verifier_id: 'commerce_checkout_probe', verification_status: 'succeeded', observed_at: '2026-08-24T00:00:00.000Z',
    platform: { platform: 'cafe24', checkout_provider: 'cafe24' },
    cart: { status: 'verified', quantity: 1, cart_price: 15.2, currency: 'USD' },
    checkout: { status: 'security_challenged_pre_address', challenge_stage: 'pre_address' },
    steps: [
      { step: 'storefront_access', status: 'passed', reason: 'storefront_loaded' },
      { step: 'add_to_cart', status: 'failed', reason: 'cart_item_not_observed' },
      { step: 'checkout', status: 'blocked', reason: 'challenge' },
    ],
  });
});

test('rejects free-form journey reasons before they reach the backend', () => {
  expect(() => buildReceipt({
    auditRunId: 'audit-1', verificationRunId: 'verify-1', workerId: 'worker-1', probeId: 'verify-1:attempt:1',
    result: {
      verification_status: 'succeeded',
      observed_at: '2026-08-24T00:00:00.000Z',
      checkout: { status: 'guest_route_detected' },
      steps: [{ step: 'checkout', status: 'passed', reason: 'https://secret.example' }],
    },
  })).toThrow('invalid commerce journey step');
});

test('refuses a successful receipt without checkout evidence', () => {
  expect(() => buildReceipt({
    auditRunId: 'audit-1', verificationRunId: 'verify-1', workerId: 'worker-1', probeId: 'verify-1:attempt:1',
    result: { verification_status: 'succeeded', observed_at: '2026-08-24T00:00:00.000Z' },
  })).toThrow('requires checkout evidence');
});
