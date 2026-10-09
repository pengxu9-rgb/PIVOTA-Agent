'use strict';

// THE CHAT LANE KEYS A CATALOG CALL ON THE BUYER'S MARKET ONLY WHEN THE CHAT REQUEST SAID IT.
//
// Measured 2026-10-09: every Aurora chat find_products_multi reached the backend market-less — the
// skill's client hard-coded its metadata and no chat client sent a buyer_region — so under the
// backend's purchasability gate those cards could never carry a cart, while a wrong default (US
// for everyone) would key a non-US buyer against the US fact. ADR-024's rule, applied end to end:
// the request's resolved buyer_region is the only source, and a DEFAULTED region sends nothing.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';

const { explicitBuyerMarket, resolveBuyerRegion } = require('../src/auroraBff/buyerRegion');

test('explicitBuyerMarket: the region only when the caller said it, upper-cased, else null', () => {
  assert.equal(explicitBuyerMarket({ buyer_region: 'SG', buyer_region_source: 'explicit' }), 'SG');
  assert.equal(explicitBuyerMarket({ buyer_region: 'jp', buyer_region_source: 'explicit' }), 'JP');
  // The defaulted US is a serving choice, not the buyer's market.
  assert.equal(explicitBuyerMarket({ buyer_region: 'US', buyer_region_source: 'defaulted' }), null);
  assert.equal(explicitBuyerMarket({ buyer_region: 'US' }), null);
  assert.equal(explicitBuyerMarket({ buyer_region: 'USA', buyer_region_source: 'explicit' }), null);
  assert.equal(explicitBuyerMarket(null), null);
  assert.equal(explicitBuyerMarket('SG'), null);
  // The pair resolveBuyerRegion hands out is exactly what it reads.
  const r = resolveBuyerRegion('gb');
  assert.equal(explicitBuyerMarket({ buyer_region: r.region, buyer_region_source: r.regionSource }), 'GB');
  const d = resolveBuyerRegion(undefined);
  assert.equal(explicitBuyerMarket({ buyer_region: d.region, buyer_region_source: d.regionSource }), null);
});

test('buildSkillRequest resolves buyer_region (top level, then context) into the skill context', () => {
  const { buildSkillRequest } = require('../src/auroraBff/routes/chat');
  const base = (body) => ({ body: { message: 'serum for dry skin', ...body }, headers: {} });

  const top = buildSkillRequest(base({ buyer_region: 'sg' }));
  assert.equal(top.context.buyer_region, 'SG');
  assert.equal(top.context.buyer_region_source, 'explicit');

  const inContext = buildSkillRequest(base({ context: { buyer_region: 'JP' } }));
  assert.equal(inContext.context.buyer_region, 'JP');
  assert.equal(inContext.context.buyer_region_source, 'explicit');

  const topWins = buildSkillRequest(base({ buyer_region: 'SG', context: { buyer_region: 'JP' } }));
  assert.equal(topWins.context.buyer_region, 'SG');

  const none = buildSkillRequest(base({}));
  assert.equal(none.context.buyer_region, 'US', 'the serving default is recorded…');
  assert.equal(none.context.buyer_region_source, 'defaulted', '…and labelled as a default');
  assert.equal(explicitBuyerMarket(none.context), null);

  const junk = buildSkillRequest(base({ buyer_region: 'usa' }));
  assert.equal(junk.context.buyer_region_source, 'defaulted', 'unreadable degrades, never 400s');
});

test('shopGatewayClient.findProductsMulti sends metadata.market only for a given ISO-2 market', async () => {
  process.env.PIVOTA_BACKEND_BASE_URL = 'http://gateway.test';
  delete require.cache[require.resolve('../src/auroraBff/clients/shopGatewayClient')];
  const { findProductsMulti } = require('../src/auroraBff/clients/shopGatewayClient');
  const sent = [];
  const axios = { post: async (url, body) => { sent.push(body); return { status: 200, data: { products: [] } }; } };

  await findProductsMulti({ query: 'serum', market: 'SG', deps: { axios } });
  await findProductsMulti({ query: 'serum', deps: { axios } });
  await findProductsMulti({ query: 'serum', market: null, deps: { axios } });
  await findProductsMulti({ query: 'serum', market: 'usa', deps: { axios } });

  assert.equal(sent[0].metadata.market, 'SG');
  assert.equal(sent[0].metadata.invoked_by, 'chat.shop_find_products');
  for (const body of sent.slice(1)) assert.equal('market' in body.metadata, false, JSON.stringify(body.metadata));
});

test('the shop skill keys its catalog call on the market only when the request context is explicit', async () => {
  const ShopFindProductsSkill = require('../src/auroraBff/skills/shop_find_products');
  const calls = [];
  const skill = new ShopFindProductsSkill({
    client: { findProductsMulti: async (args) => { calls.push(args); return { ok: true, products: [], metadata: {}, reason: 'no_candidates' }; } },
  });
  const params = { find_products_query: 'acropass patch' };

  await skill.execute({ params, context: { locale: 'en', buyer_region: 'SG', buyer_region_source: 'explicit' } });
  await skill.execute({ params, context: { locale: 'en', buyer_region: 'US', buyer_region_source: 'defaulted' } });
  await skill.execute({ params, context: { locale: 'en' } });
  await skill.execute({ params });

  assert.equal(calls.length, 4);
  assert.equal(calls[0].market, 'SG');
  for (const c of calls.slice(1)) assert.equal(c.market, null, JSON.stringify(c));
});

test('the reco hybrid resolver hands the explicit market to the product resolve, null otherwise', async () => {
  const { runRecoHybridResolveCandidates } = require('../src/auroraBff/usecases/recoHybridResolveCandidates');
  const seen = [];
  const deps = {
    async resolveProduct(args) { seen.push(args); return { ok: false, reason: 'no_match', transient: false }; },
    async searchProducts() { return { ok: true, products: [] }; },
  };
  const candidateOutput = { products: [{ brand: 'ACROPASS', name: 'Retinol Patch', step: 'treatment' }] };

  await runRecoHybridResolveCandidates({
    request: { params: {}, context: { locale: 'en', buyer_region: 'SG', buyer_region_source: 'explicit' } },
    candidateOutput, deps,
  });
  const keyed = seen.length;
  assert.ok(keyed >= 1, 'the resolve ran');
  assert.ok(seen.every((a) => a.market === 'SG'), JSON.stringify(seen));

  seen.length = 0;
  await runRecoHybridResolveCandidates({
    request: { params: {}, context: { locale: 'en', buyer_region: 'US', buyer_region_source: 'defaulted' } },
    candidateOutput, deps,
  });
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((a) => a.market === null), JSON.stringify(seen));
});
