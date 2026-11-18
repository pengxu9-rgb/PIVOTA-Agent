'use strict';

// THE RECO HYBRID RESOLVER'S REAL offers.resolve CALL carries payload.market only for an explicit
// buyer region on the request context. Driven through the real defaultResolveProduct over a
// stubbed axios (the injected-resolver test cannot see this payload).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';
process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'test_key';

const axios = require('axios');
const { runRecoHybridResolveCandidates } = require('../src/auroraBff/usecases/recoHybridResolveCandidates');

async function resolveWith(context) {
  const sent = [];
  const realPost = axios.post;
  axios.post = async (url, body) => {
    sent.push({ url, body });
    // offers.resolve: no canonical match; search: nothing — the resolver falls through cleanly.
    return { status: 200, data: { status: 'empty', products: [] } };
  };
  try {
    await runRecoHybridResolveCandidates({
      request: { params: {}, context },
      candidateOutput: { products: [{ brand: 'ACROPASS', name: 'Retinol Patch', step: 'treatment' }] },
      deps: { async searchProducts() { return { ok: true, products: [] }; } },
    });
  } finally {
    axios.post = realPost;
  }
  return sent.filter((s) => s.body && s.body.operation === 'offers.resolve');
}

test('an explicit buyer region reaches the real offers.resolve payload as market', async () => {
  const calls = await resolveWith({ locale: 'en', buyer_region: 'SG', buyer_region_source: 'explicit' });
  assert.ok(calls.length >= 1, 'offers.resolve was called');
  for (const c of calls) {
    assert.equal(c.body.payload.market, 'SG');
    assert.equal(c.body.metadata.invoked_by, 'reco_hybrid.resolve_product');
  }
});

test('a defaulted region sends no market on offers.resolve', async () => {
  const calls = await resolveWith({ locale: 'en', buyer_region: 'US', buyer_region_source: 'defaulted' });
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.equal('market' in c.body.payload, false, JSON.stringify(c.body.payload));
});

// AN EXPLICIT MARKET THIS GATEWAY CANNOT PRICE IS NOT SENT. The backend refuses a market it does not list
// (`market_not_priced`), which would turn the reco's resolve into a refusal and send the buyer to the
// products/resolve fallback. The same rule get_offers applies (buyerRegion.pricedBuyerRegion): a priced market is
// sent unchanged; DE, ZZ and other unpriced codes go without one, as no market already does.
test('an explicit market this gateway does not price (DE, ZZ) is not sent on offers.resolve; US, SG, GB are sent unchanged', async () => {
  for (const region of ['DE', 'ZZ']) {
    const calls = await resolveWith({ locale: 'en', buyer_region: region, buyer_region_source: 'explicit' });
    assert.ok(calls.length >= 1, region);
    for (const c of calls) assert.equal('market' in c.body.payload, false, `${region}: ${JSON.stringify(c.body.payload)}`);
  }
  for (const region of ['US', 'SG', 'GB']) {
    const calls = await resolveWith({ locale: 'en', buyer_region: region, buyer_region_source: 'explicit' });
    assert.ok(calls.length >= 1, region);
    for (const c of calls) assert.equal(c.body.payload.market, region, region);
  }
});

test('pricedBuyerRegion: the normalised code when priced, else null; never a default', () => {
  const { pricedBuyerRegion } = require('../src/auroraBff/buyerRegion');
  assert.equal(pricedBuyerRegion('US'), 'US');
  assert.equal(pricedBuyerRegion(' sg '), 'SG');
  assert.equal(pricedBuyerRegion('gb'), 'GB');
  for (const raw of ['DE', 'ZZ', 'USA', 'en-US', '', '  ', null, undefined, 123, ['US']]) {
    assert.equal(pricedBuyerRegion(raw), null, JSON.stringify(raw));
  }
});
