const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveFindProductsMultiPrimaryUpstreamTimeoutMs,
} = require('../src/findProductsInvokePrimaryTimeoutPolicy');

test('lookup-style find_products_multi queries keep the short timeout budget', () => {
  const timeoutMs = resolveFindProductsMultiPrimaryUpstreamTimeoutMs({
    queryClass: 'lookup',
    upstreamDefaultTimeoutMs: 10000,
    lookupTimeoutMs: 3500,
    defaultTimeoutMs: 5500,
    beautyMainlineTimeoutMs: 15000,
    strictBeautyDirectSearch: true,
  });

  assert.equal(timeoutMs, 3500);
});

test('beauty mainline direct search gets the extended timeout budget', () => {
  const timeoutMs = resolveFindProductsMultiPrimaryUpstreamTimeoutMs({
    queryClass: 'exploratory',
    upstreamDefaultTimeoutMs: 10000,
    lookupTimeoutMs: 3500,
    defaultTimeoutMs: 5500,
    beautyMainlineTimeoutMs: 15000,
    strictBeautyDirectSearch: true,
  });

  assert.equal(timeoutMs, 15000);
});

test('semantic-owner-controlled broad search gets the extended timeout budget', () => {
  const timeoutMs = resolveFindProductsMultiPrimaryUpstreamTimeoutMs({
    queryClass: 'default',
    upstreamDefaultTimeoutMs: 10000,
    lookupTimeoutMs: 3500,
    defaultTimeoutMs: 5500,
    beautyMainlineTimeoutMs: 15000,
    semanticOwnerControlled: true,
  });

  assert.equal(timeoutMs, 15000);
});

test('non-beauty exploratory search stays on the normal timeout budget', () => {
  const timeoutMs = resolveFindProductsMultiPrimaryUpstreamTimeoutMs({
    queryClass: 'exploratory',
    upstreamDefaultTimeoutMs: 10000,
    lookupTimeoutMs: 3500,
    defaultTimeoutMs: 5500,
    beautyMainlineTimeoutMs: 15000,
  });

  assert.equal(timeoutMs, 5500);
});
