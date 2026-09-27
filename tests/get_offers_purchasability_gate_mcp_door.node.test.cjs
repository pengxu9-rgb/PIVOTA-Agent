'use strict';

// END TO END over the real MCP door: POST /mcp tools/call get_offers with the merchant-purchasability
// gate ON, and what the agent receives. Only the network is stubbed (nock on PIVOTA_API_BASE, which
// serves BOTH the backend `offers.resolve` op and the ops purchasability read). This is the test that
// sees src/server.js's actual wiring — the structural pin in merchant_purchasability_paths only reads it.
//
// get_offers carries no market on either tool schema, so every call is UNKEYABLE: under backend
// enforcement every merchant on it is declined (the client's `unkeyable_enforced` row). Own file,
// because the gate client is a process singleton with a cache.

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const ISS = 'https://as.pivota.test';
const RESOURCE = 'https://agent.test.example/mcp';
const BACKEND = 'http://backend.get-offers-gate.test';
const MERCHANT = 'flowerbeauty.com';

// The backend calls go through axios, which honours HTTP(S)_PROXY and would send them to a proxy
// instead of nock. CI sets none; a developer shell often does. Cleared here, restored in `after`.
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.PIVOTA_API_KEY = 'gateway-service-key';
process.env.PIVOTA_API_BASE = BACKEND;
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.MCP_OAUTH_ENABLED = '1';
process.env.MCP_OAUTH_RESOURCE = RESOURCE;
process.env.MCP_OAUTH_AUTHORIZATION_SERVERS = ISS;
process.env.PIVOTA_OPS_ADMIN_TOKEN = 'ops-admin-jwt-fixture';
delete process.env.MERCHANT_PURCHASABILITY_GATE_ENABLED;
delete process.env.PIVOTA_OPS_OIDC_AUDIENCE;
delete process.env.PUBLIC_READ_MCP_ENABLED;
delete process.env.MCP_OAUTH_ISSUERS_JSON;

const app = require('../src/server');
const { resetMerchantPurchasabilityClientForTest } = require('../src/services/merchantPurchasabilityClient');

test.after(() => {
  nock.cleanAll();
  process.env = { ...ORIGINAL_ENV };
});

async function tokenFor(claims) {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const pub = await exportJWK(publicKey);
  pub.kid = 'as-1';
  pub.alg = 'RS256';
  process.env.MCP_OAUTH_ISSUERS_JSON = JSON.stringify([{ iss: ISS, jwks: { keys: [pub] }, algs: ['RS256'] }]);
  require('../src/commerceMcpOAuth.js').__resetVerifierCache();
  return new SignJWT({ scope: 'pivota.checkout', token_type: 'access', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'as-1' })
    .setIssuer(ISS).setAudience(RESOURCE).setSubject('buyer-1').setIssuedAt().setExpirationTime('10m')
    .sign(privateKey);
}

/** The backend `offers.resolve` external-offer shape (pivota-backend routes/agent_shop_gateway.py). */
const CART_URL = `https://${MERCHANT}/cart/40064041844877:1?attributes[pivota_click_id]=clk_1`;
const PDP_URL = `https://${MERCHANT}/products/lip-gloss?utm_source=pivota&pvt_click_id=clk_1`;
const BACKEND_OFFERS = {
  status: 'success',
  offers: [{
    offer_id: 'o1',
    merchant_id: MERCHANT,
    merchant_name: 'Flower Beauty',
    price: 14.95,
    currency: 'USD',
    in_stock: true,
    purchase_route: 'affiliate_outbound',
    affiliate_url: 'https://api.pivota.cc/r?token=tok_1.sig',
    cart_prefilled: true,
    execution_spec: {
      merchant_domain: MERCHANT,
      pdp_url: PDP_URL,
      cart_url: CART_URL,
      variant_id: '40064041844877',
      rail: 'shopify_cart',
      tracking: { click_id: 'clk_1', param: 'attributes[pivota_click_id]', join_mode: 'cart_permalink' },
    },
  }],
  mapping: { canonical_product_group_id: 'pg_1' },
};

async function callGetOffers({ enforced }) {
  const factReads = [];
  nock.cleanAll();
  const scope = nock(BACKEND);
  scope.post('/agent/shop/v1/invoke', (body) => body && body.operation === 'offers.resolve')
    .reply(200, BACKEND_OFFERS);
  scope.get('/ops/merchant-purchasability').query(true).optionally().times(5)
    .reply(function reply(uri) {
      const q = new URL(uri, BACKEND).searchParams;
      factReads.push(Object.fromEntries(q.entries()));
      // pivota-backend #2352's answer to a market-less read.
      return [200, {
        domain: q.get('domain'), market: q.get('market'), tier: 'browse_only', reason: 'market_unknown',
        enforced, sweep_enabled: true, facts: [],
      }];
    });
  const res = await supertest(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${await tokenFor({ client_id: 'mcpc_1' })}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_offers', arguments: { merchant_id: 'm_1', product_id: 'p_1' } },
    });
  nock.cleanAll();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const result = res.body && res.body.result;
  assert.ok(result && !result.isError, JSON.stringify(res.body).slice(0, 600));
  const out = result.structuredContent || JSON.parse(result.content[0].text);
  return { out, factReads, wire: JSON.stringify(res.body) };
}

function onlyOffer(out) {
  const signals = (out && (out.signals || (out.data && out.data.signals))) || [];
  assert.equal(signals.length, 1, JSON.stringify(out).slice(0, 600));
  return signals[0];
}

test('MCP door, switch OFF: get_offers relays the backend cart exactly as today, and asks nothing', async () => {
  delete process.env.MERCHANT_PURCHASABILITY_GATE_ENABLED;
  resetMerchantPurchasabilityClientForTest();
  const { out, factReads, wire } = await callGetOffers({ enforced: true });
  assert.equal(factReads.length, 0);
  assert.equal(onlyOffer(out).value.execution_spec.cart_url, CART_URL);
  assert.ok(wire.includes('/cart/40064041844877'));
});

test('MCP door, switch ON + enforcing backend: the unkeyable get_offers declines the merchant — the cart is gone, the offer is not', async () => {
  process.env.MERCHANT_PURCHASABILITY_GATE_ENABLED = '1';
  resetMerchantPurchasabilityClientForTest();
  const { out, factReads, wire } = await callGetOffers({ enforced: true });
  assert.equal(factReads.length, 1, 'one market-less enforcement read');
  assert.equal(factReads[0].domain, MERCHANT, 'asked about the merchant, not api.pivota.cc');
  assert.equal(Object.prototype.hasOwnProperty.call(factReads[0], 'market'), false, 'never a defaulted market');
  const signal = onlyOffer(out);
  assert.equal(signal.value.execution_spec.cart_url, null);
  assert.equal(signal.value.execution_spec.rail, null);
  assert.equal(signal.value.execution_spec.variant_id, null);
  assert.equal(signal.value.cart_prefilled, null);
  assert.equal(signal.value.affiliate_url, null, 'this hop was signed with primary = cart_url');
  assert.equal(signal.value.execution_spec.pdp_url, PDP_URL, 'the browse link is the fallback, and it stays');
  assert.equal(signal.value.price, 14.95);
  assert.ok(!wire.includes('/cart/'), 'the merchant cart reached the agent');
  assert.ok(!wire.includes('/r?token='), 'the hop into the merchant cart reached the agent');
  assert.ok(!wire.includes('40064041844877'), 'the variant an agent would rebuild the cart from reached the agent');
});

test('MCP door, switch ON + backend NOT enforcing: today\'s answer', async () => {
  process.env.MERCHANT_PURCHASABILITY_GATE_ENABLED = '1';
  resetMerchantPurchasabilityClientForTest();
  const { out } = await callGetOffers({ enforced: false });
  assert.equal(onlyOffer(out).value.execution_spec.cart_url, CART_URL);
});
