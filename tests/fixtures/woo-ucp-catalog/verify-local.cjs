'use strict';

const assert = require('node:assert/strict');
const { probeWooCatalog } = require('./probe-woo-catalog.cjs');

const origin = 'http://127.0.0.1:9463';
const version = '2026-04-08';

async function request(url, payload) {
  const headers = { accept: 'application/json' };
  const options = { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) };
  if (payload) {
    headers['content-type'] = 'application/json';
    options.method = 'POST';
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(url, options);
  assert.equal(response.status, 200, `${new URL(url).pathname}: ${response.status} ${response.headers.get('location') ?? ''}`);
  const type = response.headers.get('content-type');
  assert.match(type, /^application\/json\b/i);
  return { status: response.status, type, body: await response.json() };
}

async function main() {
  const { body: fixture } = await request(`${origin}/ucp-fixture.json`);
  const discovery = await request(`${origin}/.well-known/ucp`);
  const { ucp } = discovery.body;
  assert.equal(fixture.wordpress, '7.1.5');
  assert.equal(fixture.woocommerce, '11.3.1');
  assert.match(fixture.php, /^8\.3\./);
  assert.equal(ucp.version, version);
  const lookup = 'dev.ucp.shopping.catalog.lookup';
  const search = 'dev.ucp.shopping.catalog.search';
  assert.ok(ucp.capabilities[lookup].some((entry) => entry.version === version));
  assert.ok(ucp.capabilities[search].some((entry) => entry.version === version));
  const binding = ucp.services['dev.ucp.shopping'].find((entry) => entry.transport === 'rest');
  assert.equal(binding.endpoint, `${origin}/wp-json/wc/ucp/v1`);
  assert.equal(binding.version, version);

  const found = await request(`${binding.endpoint}/catalog/search`, {
    query: 'UCP Catalog Fixture Mug', pagination: { limit: 1 },
  });
  assert.equal(found.body.ucp.status, 'success');
  assert.equal(found.body.products.length, 1);
  assert.equal(found.body.products[0].id, fixture.product_id);

  async function lookupId(id, currency = 'USD') {
    const reply = await request(`${binding.endpoint}/catalog/lookup`, {
      ids: [id], context: { address_country: 'US', currency },
    });
    assert.equal(reply.body.ucp.version, version);
    assert.equal(reply.body.ucp.status, 'success');
    return reply;
  }

  const exact = await lookupId(fixture.blue_id);
  assert.equal(exact.body.products.length, 1);
  const [item] = exact.body.products;
  assert.equal(item.id, fixture.product_id);
  assert.equal(item.variants.length, 1);
  const [variant] = item.variants;
  assert.equal(variant.id, fixture.blue_id);
  assert.equal(variant.sku, 'UCP-FIX-BLUE');
  assert.deepEqual(variant.inputs, [{ id: fixture.blue_id, match: 'exact' }]);
  assert.deepEqual(variant.price, { amount: 1234, currency: 'USD' });
  assert.equal(variant.availability.available, true);

  const parent = await lookupId(fixture.product_id);
  const featured = parent.body.products[0].variants;
  assert.deepEqual(featured.map(({ id }) => id).sort(), [fixture.blue_id, fixture.green_id].sort());
  assert.ok(featured.every(({ inputs }) => inputs.some(({ match }) => match === 'featured')));

  const sku = await lookupId('UCP-FIX-BLUE');
  assert.deepEqual(sku.body.products, []);
  assert.ok(sku.body.messages.some(({ code }) => code === 'not_found'));

  const currency = await lookupId(fixture.blue_id, 'EUR');
  assert.equal(currency.body.products[0].variants[0].price.currency, 'USD');
  assert.ok(currency.body.messages.some(({ code }) => code === 'currency_not_supported'));

  const adapterOrigin = 'https://woo-fixture.example';
  const adapterProfile = structuredClone(discovery.body);
  adapterProfile.ucp.services['dev.ucp.shopping'][0].endpoint = binding.endpoint.replace(origin, adapterOrigin);
  const gatewayCatalogLookup = await probeWooCatalog({
    origin: adapterOrigin, productId: fixture.product_id, variantId: fixture.blue_id,
    fetchMerchant: (url, options) => {
      if (url === `${adapterOrigin}/.well-known/ucp`) return Response.json(adapterProfile);
      assert.equal(url, `${adapterOrigin}/wp-json/wc/ucp/v1/catalog/lookup`);
      // Translate only the synthetic HTTPS origin to the real loopback Woo response.
      // The default gateway fetch continues to reject loopback addresses.
      return fetch(`${binding.endpoint}/catalog/lookup`, options);
    },
  });
  assert.equal(gatewayCatalogLookup.lookup.variantId, variant.id);
  assert.deepEqual(gatewayCatalogLookup.lookup.price, variant.price);

  let gatewayDiscovery;
  if (process.env.PIVOTA_GATEWAY_ROOT) {
    const { resolve } = require('node:path');
    const { createUcpBuyerAgentClient } = require(resolve(
      process.env.PIVOTA_GATEWAY_ROOT, 'src/services/ucpBuyerAgentClient.js',
    ));
    const gateway = createUcpBuyerAgentClient({
      forceAnonymous: true,
      // Replay the real discovery document into the gateway. Its hardened live
      // HTTPS transport remains untouched and deliberately rejects loopback.
      merchantFetchImpl: async () => new Response(JSON.stringify(discovery.body)),
    });
    const result = await gateway.discoverEndpoint('https://woo-fixture.example');
    assert.equal(result.mcpEndpoint, undefined);
    gatewayDiscovery = { status: result.status, mcpEndpoint: null, method: 'replay of real local discovery response' };
  }

  console.log(JSON.stringify({
    environment: 'loopback WordPress Playground, core WooCommerce direct mode',
    fixture,
    discovery: { http: discovery.status, type: discovery.type, profileVersion: version, binding, capabilities: Object.keys(ucp.capabilities) },
    search: { http: found.status, ucp: found.body.ucp.status, product: found.body.products[0].id },
    exactLookup: { http: exact.status, ucp: exact.body.ucp.status, product: item.id, variant: variant.id, sku: variant.sku, inputs: variant.inputs, price: variant.price, availability: variant.availability },
    parentLookup: { http: parent.status, featured: featured.map(({ id }) => id) },
    skuOnlyLookup: { http: sku.status, matched: 0, code: 'not_found' },
    requestedEUR: { http: currency.status, returned: 'USD', code: 'currency_not_supported' },
    gatewayCatalogLookup,
    gatewayDiscovery,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
