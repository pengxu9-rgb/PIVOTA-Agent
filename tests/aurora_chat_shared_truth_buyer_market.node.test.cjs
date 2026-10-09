'use strict';

// THE BEAUTY SHARED-TRUTH INVOKE KEYS metadata.market ON THE V1 CHAT TURN'S EXPLICIT BUYER REGION,
// and stays silent otherwise. Driven through the real function (exposed via __internal) over a
// stubbed axios, with the shared-truth gates satisfied by env + a beauty/commerce turn.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_BFF_BEAUTY_SHARED_TRUTH_ENABLED = 'true';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';
process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'test_key';

const axios = require('axios');
const { __internal } = require('../src/auroraBff/routes');

const attachOptions = {
  context: {
    normalized_need: {
      beauty_request: { domain: 'skincare', skin_context: 'oily skin', product_context: 'sunscreen' },
    },
  },
};
const responsePayload = { cards: [{ card_type: 'recommendations', items: [] }] };
const req = { headers: {}, get: () => '', protocol: 'https' };
const requestMessage = 'what sunscreen should I buy for oily skin? recommend a product';

async function invokeWith(ctx) {
  const sent = [];
  const realPost = axios.post;
  axios.post = async (url, body) => {
    sent.push({ url, body });
    return { status: 200, data: { beauty_expert_v1: { summary: 'ok' } } };
  };
  try {
    await __internal.fetchAuroraBeautySharedTruthForChat({ req, requestMessage, responsePayload, attachOptions, ctx });
  } finally {
    axios.post = realPost;
  }
  return sent;
}

test('an explicit buyer region on the ctx becomes metadata.market on the shared-truth invoke', async () => {
  const sent = await invokeWith({ buyer_region: 'SG', buyer_region_source: 'explicit', lang: 'EN' });
  assert.equal(sent.length, 1, 'the shared-truth invoke ran (its gates were met)');
  assert.equal(sent[0].body.operation, 'find_products_multi');
  assert.equal(sent[0].body.metadata.market, 'SG');
  assert.equal(sent[0].body.metadata.invoked_by, 'aurora_chat_shared_truth');
});

test('a defaulted region, or none, sends no market: the invoke is silent', async () => {
  for (const ctx of [{ buyer_region: 'US', buyer_region_source: 'defaulted', lang: 'EN' }, { lang: 'EN' }, null]) {
    const sent = await invokeWith(ctx);
    assert.equal(sent.length, 1, 'the shared-truth invoke ran');
    assert.equal('market' in sent[0].body.metadata, false, JSON.stringify(sent[0].body.metadata));
  }
});
