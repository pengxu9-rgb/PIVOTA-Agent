'use strict';

// THE REQUEST TEXT IS PART OF THE PROMPT, and it carried its own copy of the domain rule.
//
// The widened agent-door prompt states its domain in five places: the v1_3 system file, the query
// Task line, the hard_rules embedded in the user_schema, two in-code fallbacks — and the USER ASK,
// which is the one the model reads as the buyer's own words. Only the ask did not follow
// `wide_template_active`.
//
// Armed, that meant the door sent v1_3's "Recommend skincare (including body care), makeup, and
// fragrance" system prompt wrapped around "Recommend a few skincare products for me". Measured
// against the live door 2026-09-10: bronzer, lipstick, blush and eau de toilette each returned
// ZERO, every one citing the skincare framing in the request text; a moisturizer control served
// normally. The model was not failing — it was obeying CATEGORY FIDELITY against a request that
// named skincare.
//
// The ask follows the GRANT, never the ask-for-it: promptDomainScope 'beauty' is inert until
// RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID names a template different from the narrow one (routes.js:823,
// "Inheriting makes 'off' true by construction"). Framing a request as beauty while v1_2
// ("Recommend skincare only") is loaded would invert the same defect.

process.env.AURORA_BFF_USE_MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

// Resolve under a NAMED configuration rather than whatever the shell exports: the template id is
// read once at module load, so arming it means reloading the module.
function withRoutesEnv(env, fn) {
  const moduleId = require.resolve('../src/auroraBff/routes');
  const before = {};
  for (const [k, v] of Object.entries(env)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[moduleId];
  try {
    const out = fn(require('../src/auroraBff/routes').__internal);
    if (out && typeof out.then === 'function') {
      throw new Error('withRoutesEnv is synchronous: an async fn would assert against the restored env');
    }
    return out;
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[moduleId];
  }
}

const BRONZER = 'a warm-toned bronzer for contouring my cheekbones';

test('ARMED: the agent door asks for BEAUTY, so a makeup need is not self-contradictory', () => {
  const asks = withRoutesEnv({ RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID: 'reco_main_v1_3' }, (internal) => ({
    agent: internal.buildRecoGenerateUserAsk({ focus: BRONZER, lang: 'EN', promptDomainScope: 'beauty' }),
    agentCn: internal.buildRecoGenerateUserAsk({ focus: BRONZER, lang: 'CN', promptDomainScope: 'beauty' }),
    consumer: internal.buildRecoGenerateUserAsk({ focus: BRONZER, lang: 'EN' }),
    spec: internal.resolveRecoMainPromptSpec({ promptDomainScope: 'beauty' }),
  }));

  assert.equal(asks.spec.wide_template_active, true, 'the fixture must actually arm the wide template');
  assert.match(asks.agent, /^Recommend a few beauty products for me/,
    'the request the model reads must not contradict the system prompt it was given');
  assert.doesNotMatch(asks.agent, /skincare products/,
    'the skincare framing is exactly what made the model refuse a bronzer');
  assert.match(asks.agentCn, /^给我推荐几款美妆产品/, 'the CN twin carries the same rule');

  // THE CONSUMER LANE IS UNTOUCHED. It never asks for the wide template, so it never gets the wide
  // framing — its buyers are on a skincare surface and v1_2 is what it loads.
  assert.match(asks.consumer, /^Recommend a few skincare products for me/);
});

test('DISARMED: the beauty ask is inert, so the framing stays skincare', () => {
  // The ask-vs-grant distinction, in the one place a mistake would be invisible: with the wide id
  // inheriting the narrow one, asking for beauty grants nothing, and a beauty-framed request around
  // v1_2's "Recommend skincare only" would be the same defect pointed the other way.
  for (const env of [{ RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID: undefined },
                     { RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID: 'reco_main_v1_2' }]) {
    const out = withRoutesEnv(env, (internal) => ({
      ask: internal.buildRecoGenerateUserAsk({ focus: BRONZER, lang: 'EN', promptDomainScope: 'beauty' }),
      askCn: internal.buildRecoGenerateUserAsk({ focus: BRONZER, lang: 'CN', promptDomainScope: 'beauty' }),
      spec: internal.resolveRecoMainPromptSpec({ promptDomainScope: 'beauty' }),
    }));
    const label = JSON.stringify(env.RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID);
    assert.equal(out.spec.wide_template_active, false, `${label} must not grant the wide template`);
    assert.match(out.ask, /^Recommend a few skincare products for me/,
      `${label}: the ask must follow the template actually loaded, not the scope asked for`);
    assert.match(out.askCn, /^给我推荐几款护肤产品/);
  }
});

test('the focus text survives either framing — the need is not rewritten', () => {
  // The framing changes; the buyer's own words must not. A fix that dropped or paraphrased `focus`
  // would trade one wrong answer for another.
  const both = withRoutesEnv({ RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID: 'reco_main_v1_3' }, (internal) => [
    internal.buildRecoGenerateUserAsk({ focus: BRONZER, lang: 'EN', promptDomainScope: 'beauty' }),
    internal.buildRecoGenerateUserAsk({ focus: BRONZER, lang: 'EN' }),
  ]);
  for (const ask of both) {
    assert.ok(ask.includes(BRONZER), 'the need must reach the model verbatim in either framing');
  }
});

test('the agent bridge actually passes the scope to the ask', () => {
  // The wiring, not just the builder. This is a five-hop domain rule and the previous four were all
  // threaded correctly while this one was not; a builder that CAN widen but is never told to is the
  // same bug with an extra step.
  const { makeRecommendProducts } = require('../src/agentSignals/recommendProducts');
  let seen = null;
  const handler = makeRecommendProducts({
    buildAsk: (args) => { seen = args; return 'ASK'; },
    generate: async () => ({ norm: { payload: { recommendations: [] } } }),
    isEnabled: () => true,
  });
  return handler({ payload: { need: BRONZER } }, { agent_id: 'a' }).then(() => {
    assert.ok(seen, 'the bridge must build an ask');
    assert.equal(seen.promptDomainScope, 'beauty',
      'the bridge sets promptDomainScope everywhere else; the ask is the copy that was missed');
  });
});
