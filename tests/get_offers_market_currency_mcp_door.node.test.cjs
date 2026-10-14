'use strict';

// A DECLARED BUYER MARKET IS SHOWN ONLY OFFERS PRICED IN ITS CURRENCY (ADR-026). Live probe 2026-10-14:
// get_offers(market="US") on a seed filed under GB returned its GBP offer as `buyer_safe`, and a KR seed's
// KRW offer the same way; market="SG" and no market returned the same thing. The backend's offers.resolve
// keys only its cart-minting gate on `payload.market` and filters nothing, and makeGetOffers projected
// every offer it got back.
//
// END TO END over the real MCP door, as tests/issuing_agent_assertion_mcp_door does: POST /mcp
// tools/call get_offers -> the canonical executor -> makeGetOffers -> the wired fetchOffers ->
// invokeCommerceKernelRawUpstream -> the backend request that leaves the process (nock). Nothing between
// the tool call and the wire is stubbed, so the guard is tested where the tool answers, not in isolation.

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const ISS = 'https://as.pivota.test';
const RESOURCE = 'https://agent.test.example/mcp';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.PIVOTA_API_KEY = 'gateway-service-key';
process.env.PIVOTA_API_BASE = 'http://backend.offers-market.test';
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.MCP_OAUTH_ENABLED = '1';
process.env.MCP_OAUTH_RESOURCE = RESOURCE;
process.env.MCP_OAUTH_AUTHORIZATION_SERVERS = ISS;
delete process.env.PUBLIC_READ_MCP_ENABLED;
delete process.env.MCP_OAUTH_ISSUERS_JSON;
// A proxy in the environment routes the upstream request around nock.
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];

const app = require('../src/server');

test.after(() => {
  nock.cleanAll();
  process.env = { ...ORIGINAL_ENV };
});

let tokenPromise = null;
async function token() {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
      const { publicKey, privateKey } = await generateKeyPair('RS256');
      const pub = await exportJWK(publicKey);
      pub.kid = 'as-1';
      pub.alg = 'RS256';
      process.env.MCP_OAUTH_ISSUERS_JSON = JSON.stringify([{ iss: ISS, jwks: { keys: [pub] }, algs: ['RS256'] }]);
      require('../src/commerceMcpOAuth.js').__resetVerifierCache();
      return new SignJWT({ scope: 'pivota.checkout', token_type: 'access', client_id: 'mcpc_offers_market' })
        .setProtectedHeader({ alg: 'RS256', kid: 'as-1' })
        .setIssuer(ISS).setAudience(RESOURCE).setSubject('buyer-1').setIssuedAt().setExpirationTime('10m')
        .sign(privateKey);
    })();
  }
  return tokenPromise;
}

// The backend's offers.resolve shape for external seed referral offers: each offer carries its own
// `currency`, and every one is an attributed `/r` referral.
function referral(merchantId, price, currency) {
  return {
    merchant_id: merchantId,
    merchant_name: merchantId,
    price,
    currency,
    availability: 'in_stock',
    in_stock: true,
    purchase_route: 'affiliate_outbound',
    affiliate_url: `https://api.pivota.test/r?token=${merchantId}`,
  };
}

const GBP = referral('ext_seed_gb', 16.5, 'GBP');
const KRW = referral('ext_seed_kr', 21000, 'KRW');
const USD = referral('ext_seed_us', 24, 'USD');

/** tools/call get_offers over /mcp; returns { result, upstream } where upstream is the offers.resolve body or null. */
async function callGetOffers(args, offers) {
  let upstream = null;
  nock.cleanAll();
  nock(process.env.PIVOTA_API_BASE)
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'offers.resolve')
    .reply(function reply(_uri, body) {
      upstream = typeof body === 'string' ? JSON.parse(body) : body;
      return [200, { status: 'success', offers }];
    });
  const res = await supertest(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${await token()}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_offers', arguments: args } });
  nock.cleanAll();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const result = res.body && res.body.result;
  assert.ok(result && !result.isError, `get_offers errored: ${JSON.stringify(res.body).slice(0, 500)}`);
  const out = result.structuredContent || JSON.parse(result.content[0].text);
  return { out, upstream };
}

const currencies = (out) => out.signals.map((s) => s.value.currency);

test('market=US on a mixed-currency product: only the USD offer comes back, and best_offer is it', async () => {
  const { out, upstream } = await callGetOffers(
    { merchant_id: 'ext_seed_gb', product_id: 'p_seed', market: 'US' },
    [GBP, KRW, USD],
  );
  assert.ok(upstream, 'the tool reached offers.resolve');
  assert.equal(upstream.payload.market, 'US', 'the stated market still rides to the backend');
  assert.deepEqual(currencies(out), ['USD']);
  assert.equal(out.best_offer.value.currency, 'USD');
  assert.equal(out.best_offer.value.merchant_id, 'ext_seed_us');
  assert.equal(out.metadata.offer_count, 1);
  assert.equal(out.metadata.market, 'US');
  assert.equal(out.metadata.market_currency, 'USD');
  assert.equal(out.metadata.withheld_other_currency_count, 2);
  assert.equal(out.metadata.reason, undefined);
});

test('the probe: market=US and market=SG on a GBP-only seed return no offer, reason named; no GBP `/r` link leaks', async () => {
  for (const market of ['US', 'SG', 'us']) {
    const { out } = await callGetOffers({ merchant_id: 'ext_seed_gb', product_id: 'p_seed', market }, [GBP]);
    assert.deepEqual(out.signals, [], market);
    assert.equal(out.best_offer, null, market);
    assert.equal(out.metadata.offer_count, 0, market);
    assert.equal(out.metadata.withheld_other_currency_count, 1, market);
    assert.equal(out.metadata.reason, 'no_offer_in_market_currency', market);
    assert.equal(JSON.stringify(out).includes('token=ext_seed_gb'), false, `${market}: the GBP referral link is not served`);
  }
});

test('market=US on a KRW-only seed returns no offer', async () => {
  const { out } = await callGetOffers({ merchant_id: 'ext_seed_kr', product_id: 'p_seed_kr', market: 'US' }, [KRW]);
  assert.deepEqual(out.signals, []);
  assert.equal(out.metadata.reason, 'no_offer_in_market_currency');
});

test('the seed\'s own market keeps its offer: market=GB returns the GBP offer, market=KR the KRW one', async () => {
  const gb = await callGetOffers({ merchant_id: 'ext_seed_gb', product_id: 'p_seed', market: 'GB' }, [GBP, KRW, USD]);
  assert.deepEqual(currencies(gb.out), ['GBP']);
  assert.equal(gb.out.best_offer.value.price, 16.5);
  const kr = await callGetOffers({ merchant_id: 'ext_seed_kr', product_id: 'p_seed_kr', market: 'KR' }, [GBP, KRW, USD]);
  assert.deepEqual(currencies(kr.out), ['KRW']);
});

test('an offer with no currency is never shown to a declared market', async () => {
  const { out } = await callGetOffers(
    { merchant_id: 'm', product_id: 'p', market: 'US' },
    [{ ...USD, currency: null }, { ...USD, merchant_id: 'blank', currency: '' }],
  );
  assert.deepEqual(out.signals, []);
  assert.equal(out.metadata.withheld_other_currency_count, 2);
});

test('no market declared: today\'s referral-only answer, every currency, and no market fields', async () => {
  const { out, upstream } = await callGetOffers({ merchant_id: 'ext_seed_gb', product_id: 'p_seed' }, [GBP, KRW, USD]);
  assert.equal(Object.prototype.hasOwnProperty.call(upstream.payload, 'market'), false);
  assert.deepEqual(currencies(out).sort(), ['GBP', 'KRW', 'USD']);
  assert.equal(out.metadata.offer_count, 3);
  for (const k of ['market', 'market_currency', 'withheld_other_currency_count', 'reason']) {
    assert.equal(Object.prototype.hasOwnProperty.call(out.metadata, k), false, k);
  }
});

test('a declared market nothing is priced in returns no offer and makes no backend call', async () => {
  const { out, upstream } = await callGetOffers({ merchant_id: 'ext_seed_gb', product_id: 'p_seed', market: 'ZZ' }, [GBP]);
  assert.equal(upstream, null, 'no offers.resolve call');
  assert.deepEqual(out.signals, []);
  assert.equal(out.metadata.market, 'ZZ');
  assert.equal(out.metadata.market_currency, null);
  assert.equal(out.metadata.reason, 'market_not_priced');
});

test('the filter runs on the widest page the wiring allows, and the caller\'s limit still caps the answer', async () => {
  const many = [...Array.from({ length: 6 }, (_, i) => referral(`gb_${i}`, 10 + i, 'GBP')), referral('us_0', 30, 'USD'), referral('us_1', 31, 'USD')];
  const { out, upstream } = await callGetOffers({ merchant_id: 'm', product_id: 'p', market: 'US', limit: 1 }, many);
  assert.equal(upstream.payload.limit, 30, 'a declared market fetches the full page before filtering');
  assert.deepEqual(currencies(out), ['USD']);
  assert.equal(out.metadata.offer_count, 2);
  const silent = await callGetOffers({ merchant_id: 'm', product_id: 'p', limit: 1 }, many);
  assert.equal(silent.upstream.payload.limit, 1, 'no market: the fetch is unchanged');
});
