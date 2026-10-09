'use strict';

// THE RECO CATALOG SEARCH (source 'shopping-agent' by default — the largest live market-less
// emitter in the 2026-10-09 census) sends `market` on the search door only for an explicit buyer
// market, through the real function over a stubbed axios.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';
process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'test_key';

const axios = require('axios');
const { __internal } = require('../src/auroraBff/routes');

async function searchWith(buyerMarket) {
  const sent = [];
  const realGet = axios.get;
  axios.get = async (url, config) => {
    sent.push({ url, params: config && config.params ? config.params : {} });
    return { status: 200, data: { products: [] } };
  };
  try {
    await __internal.searchPivotaBackendProducts({ query: 'retinol serum', limit: 4, logger: null, mode: 'main_path', buyerMarket });
  } finally {
    axios.get = realGet;
  }
  return sent;
}

test('an explicit buyer market rides as `market` on the search door, upper-cased', async () => {
  const sent = await searchWith('sg');
  assert.ok(sent.length >= 1, 'the search ran');
  for (const s of sent) assert.equal(s.params.market, 'SG', JSON.stringify(s));
  assert.ok(sent.every((s) => s.params.source), 'the source profile is untouched');
});

test('no market, or junk, sends none: the search is silent', async () => {
  for (const value of [null, undefined, 'usa', 'en-US', 7]) {
    const sent = await searchWith(value);
    assert.ok(sent.length >= 1);
    for (const s of sent) assert.equal('market' in s.params, false, `${String(value)}: ${JSON.stringify(s.params)}`);
  }
});
