'use strict';

const { classifyCheckoutPage, httpsUrl, platformFromGenerator } = require('../src/services/commerceStorefrontAudit');

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
});
