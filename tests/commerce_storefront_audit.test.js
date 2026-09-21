'use strict';

const {
  classifyCheckoutPage,
  httpsUrl,
  journeySteps,
  platformFromGenerator,
  sanitizeSearchQuery,
  validatePublicBrowserUrl,
} = require('../src/services/commerceStorefrontAudit');

test('recognizes Cafe24 pre-address security challenge without retaining its URL', () => {
  expect(classifyCheckoutPage({
    url: 'https://veritas-hub.cafe24.com/challenge',
    text: 'For a secure experience, please check your access.',
  })).toEqual({ status: 'security_challenged_pre_address', challenge_stage: 'pre_address' });
});

test('recognizes a guest checkout route and supported platform metadata', () => {
  expect(classifyCheckoutPage({ url: 'https://merchant.example/order/orderform.html', text: '' }))
    .toEqual({ status: 'guest_route_detected' });
  expect(platformFromGenerator('Cafe24')).toEqual({ platform: 'cafe24', checkout_provider: 'cafe24' });
});

test('accepts only non-sensitive canonical storefront targets', () => {
  expect(httpsUrl('https://merchant.example/product/a')).toBe('https://merchant.example/product/a');
  expect(httpsUrl('https://merchant.example/product/a?token=secret')).toBeNull();
  expect(httpsUrl('http://merchant.example/product/a')).toBeNull();
  expect(httpsUrl('https://127.0.0.1/product/a')).toBeNull();
});

test('blocks private DNS targets and validates redirect destinations before browser navigation', async () => {
  await expect(validatePublicBrowserUrl('https://merchant.example/a', {
    validateUrl: async () => ({ ok: false }),
  })).resolves.toEqual({ ok: false });
  await expect(validatePublicBrowserUrl('https://127.0.0.1/a')).resolves.toEqual({ ok: false });
});

test('builds a complete six-step journey without retaining page content', () => {
  expect(sanitizeSearchQuery('Hero Serum — JudyDoll')).toBe('Hero Serum');
  expect(journeySteps({
    storefront_access: { status: 'passed', reason: 'storefront_loaded' },
  })).toEqual([
    { step: 'storefront_access', status: 'passed', reason: 'storefront_loaded' },
    { step: 'product_search', status: 'not_run', reason: 'not_attempted' },
    { step: 'product_detail', status: 'not_run', reason: 'not_attempted' },
    { step: 'add_to_cart', status: 'not_run', reason: 'not_attempted' },
    { step: 'shipping_address', status: 'not_run', reason: 'not_attempted' },
    { step: 'checkout', status: 'not_run', reason: 'not_attempted' },
  ]);
});
