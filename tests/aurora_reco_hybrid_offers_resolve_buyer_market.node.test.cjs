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
