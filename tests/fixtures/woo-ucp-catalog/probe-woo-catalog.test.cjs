'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWooUcpCatalogClient } = require('../../../src/services/wooUcpCatalogClient');
const { probeWooCatalog } = require('./probe-woo-catalog.cjs');

const origin = 'https://woo-fixture.example';
const version = '2026-04-08';
const base = `${origin}/wp-json/wc/ucp/v1`;
const capabilities = { 'dev.ucp.shopping.catalog.lookup': [{ version }] };
const query = { productId: '10', variantId: '11', country: 'US', currency: 'USD' };

function fake({ endpoint = base, lookupStatus = 200, match = 'exact', amount = 1234, available = true,
  empty = false, messages = [], protocolStatus = 'success', profileVersion = version } = {}) {
  const calls = [];
  const profile = { ucp: {
    version: profileVersion,
    capabilities,
    services: { 'dev.ucp.shopping': [{ version, transport: 'rest', endpoint }] },
  } };
  const result = { ucp: { version, status: protocolStatus, capabilities }, messages, products: empty ? [] : [{ id: '10', variants: [{
    id: '11', sku: 'UCP-FIX-BLUE', price: { amount, currency: 'USD' },
    availability: { available }, inputs: [{ id: '11', match }],
  }] }] };
  const fetchMerchant = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? Response.json(profile) : Response.json(result, { status: lookupStatus, headers: { 'retry-after': '30' } });
  };
  const run = () => probeWooCatalog({ origin, ...query, fetchMerchant });
  const lookupVariant = (params = query) => createWooUcpCatalogClient({ merchantOrigin: origin, fetchMerchant }).lookupVariant(params);
  return { calls, run, lookupVariant };
}

test('uses only the advertised local REST binding and proves exact identity', async () => {
  const { run, calls } = fake();
  const result = await run();
  assert.equal(result.status, 'pass');
  assert.deepEqual(calls.map(({ url, options }) => [url, options.method ?? 'GET', options.redirect]), [
    [`${origin}/.well-known/ucp`, 'GET', 'manual'], [`${base}/catalog/lookup`, 'POST', 'manual'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { ids: ['11'], context: { address_country: 'US', currency: 'USD' } });
  assert.equal('authorization' in calls[1].options.headers, false);
  assert.equal('cookie' in calls[1].options.headers, false);
});

test('classifies a cross-origin binding before sending lookup', async () => {
  const { run, calls } = fake({ endpoint: 'https://proxy.example/v1' });
  await assert.rejects(run, { code: 'proxy_or_external_binding' });
  assert.equal(calls.length, 1);
});

test('401 reports authentication required and 429 reports retry delay without retrying', async () => {
  const denied = fake({ lookupStatus: 401 });
  await assert.rejects(denied.run, { code: 'authentication_required' });
  assert.equal(denied.calls.length, 2);
  const throttled = fake({ lookupStatus: 429 });
  await assert.rejects(throttled.run, (error) => error.code === 'rate_limited' && error.evidence.retryAfter === '30');
  assert.equal(throttled.calls.length, 2);
});

test('HTTP success with a featured result does not prove exact variant selection', async () => {
  await assert.rejects(fake({ match: 'featured' }).run, { code: 'exact_variant_not_returned' });
});

test('distinguishes a hidden or missing product from an unavailable REST route and a business error', async () => {
  await assert.rejects(fake({ empty: true, messages: [{ code: 'not_found' }] }).run, { code: 'not_found' });
  await assert.rejects(fake({ lookupStatus: 404 }).run, { code: 'route_unavailable' });
  await assert.rejects(fake({ protocolStatus: 'error' }).run, { code: 'lookup_ucp_failure' });
});

test('keeps zero minor units and explicit unavailable, and refuses a currency mismatch or late warning', async () => {
  const result = await fake({ amount: 0, available: false }).lookupVariant();
  assert.deepEqual(result.lookup.price, { amount: 0, currency: 'USD' });
  assert.equal(result.lookup.available, false);
  await assert.rejects(fake().lookupVariant({ ...query, currency: 'EUR' }), { code: 'currency_mismatch' });
  const messages = Array.from({ length: 16 }, () => ({ code: 'info' })).concat({ code: 'currency_not_supported' });
  await assert.rejects(fake({ messages }).run, { code: 'currency_mismatch' });
});

test('unsupported discovery and untrusted Woo bindings never get a lookup', async () => {
  const changed = fake({ profileVersion: '2026-08-25' });
  await assert.rejects(changed.run, { code: 'discovery_version_unsupported' });
  assert.equal(changed.calls.length, 1);
  const unrelatedPath = fake({ endpoint: `${origin}/wp-json/wc/store/v1` });
  await assert.rejects(unrelatedPath.run, { code: 'unexpected_woo_binding' });
  assert.equal(unrelatedPath.calls.length, 1);
  const emptyQuery = fake({ endpoint: `${base}?` });
  await assert.rejects(emptyQuery.run, { code: 'unexpected_woo_binding' });
  assert.equal(emptyQuery.calls.length, 1);
});

test('ported Shopify IDs and missing market are refused before any request', async () => {
  const variant = fake();
  await assert.rejects(variant.lookupVariant({ ...query, variantId: 'gid://shopify/ProductVariant/11' }),
    { code: 'expected_distinct_numeric_woo_ids' });
  await assert.rejects(variant.lookupVariant({ ...query, country: undefined }), { code: 'expected_market_and_currency' });
  assert.equal(variant.calls.length, 0);
});
