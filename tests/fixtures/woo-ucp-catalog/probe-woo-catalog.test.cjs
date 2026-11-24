'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { probeWooCatalog } = require('./probe-woo-catalog.cjs');

const origin = 'https://woo-fixture.example';
const version = '2026-04-08';
const base = `${origin}/wp-json/wc/ucp/v1`;

function fake({ endpoint = base, lookupStatus = 200, match = 'exact' } = {}) {
  const calls = [];
  const profile = { ucp: {
    version,
    capabilities: { 'dev.ucp.shopping.catalog.lookup': [{ version }] },
    services: { 'dev.ucp.shopping': [{ version, transport: 'rest', endpoint }] },
  } };
  const result = { ucp: { version, status: 'success' }, products: [{ id: '10', variants: [{
    id: '11', sku: 'UCP-FIX-BLUE', price: { amount: 1234, currency: 'USD' },
    availability: { available: true }, inputs: [{ id: '11', match }],
  }] }] };
  const run = () => probeWooCatalog({ origin, productId: '10', variantId: '11', fetchMerchant: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? Response.json(profile) : Response.json(result, { status: lookupStatus, headers: { 'retry-after': '30' } });
  } });
  return { calls, run };
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
  await assert.rejects(fake({ match: 'featured' }).run, { code: 'exact_fixture_variant_not_returned' });
});
