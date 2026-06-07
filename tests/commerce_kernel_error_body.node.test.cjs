const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const app = require('../src/server');

test('commerce kernel error body preserves redacted diagnostics', () => {
  const body = app._debug.commerceKernelErrorBody({
    code: 'MERCHANT_UNAVAILABLE',
    message: 'The merchant is temporarily unreachable. Please try again shortly.',
    recovery: 'no silent fallback',
    retriable: true,
    details: {
      upstream_code: 'SHOPIFY_PRICING_UNAVAILABLE',
      upstream_detail: {
        details: {
          attempts: [
            {
              engine: 'shopify_storefront_cart',
              message: 'Variant exists in Shopify Admin but is not available to Storefront API.',
              status_code: 403,
              access_token: 'shpat_secret',
              total_amount: '28.24',
            },
          ],
        },
      },
    },
  });

  assert.equal(body.code, 'MERCHANT_UNAVAILABLE');
  assert.equal(body.details.upstream_code, 'SHOPIFY_PRICING_UNAVAILABLE');
  const attempt = body.details.upstream_detail.details.attempts[0];
  assert.equal(attempt.engine, 'shopify_storefront_cart');
  assert.equal(attempt.status_code, 403);
  assert.equal(attempt.access_token, '[REDACTED]');
  assert.equal(attempt.total_amount, '[REDACTED_AMOUNT]');
  assert.match(attempt.message, /Storefront API/);
});
