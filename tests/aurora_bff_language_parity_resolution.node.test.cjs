const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRequestContext,
  detectTextExplicit,
} = require('../src/auroraBff/requestContext');
const { looksLikeRecommendationRequest } = require('../src/auroraBff/gating');
const { inferTextExplicitTransition } = require('../src/auroraBff/agentStateMachine');

function makeReq(headers = {}) {
  return {
    get(name) {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === String(name || '').toLowerCase());
      return key ? headers[key] : undefined;
    },
  };
}

test('request context resolves matching language from text when UI language differs', () => {
  const req = makeReq({ 'X-Lang': 'EN' });
  const ctx = buildRequestContext(req, { message: '我想买防晒，给我一个方案' });
  assert.equal(ctx.ui_lang, 'EN');
  assert.equal(ctx.match_lang, 'EN');
  assert.equal(ctx.language_mismatch, true);
  assert.equal(ctx.language_resolution_source, 'header');
});

test('request context uses text-detected language without explicit header/body language', () => {
  const req = makeReq({});
  const ctx = buildRequestContext(req, { message: 'I want to buy sunscreen' });
  assert.equal(ctx.ui_lang, 'EN');
  assert.equal(ctx.match_lang, 'EN');
  assert.equal(ctx.language_mismatch, false);
  assert.equal(ctx.language_resolution_source, 'text_detected');
});

test('text explicit detection covers EN plan/buy phrasing', () => {
  assert.equal(detectTextExplicit('give me a plan for acne-safe sunscreen'), true);
  assert.equal(looksLikeRecommendationRequest('i want to buy sunscreen for travel'), true);
});

test('agent state transition infers recommendation from EN buy phrasing', () => {
  const inferred = inferTextExplicitTransition('I want to buy sunscreen for sensitive skin', 'EN');
  assert.equal(inferred && inferred.requested_next_state, 'RECO_GATE');
});
