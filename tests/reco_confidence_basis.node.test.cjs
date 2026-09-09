'use strict';

// WHAT THE CONFIDENCE NUMBERS ARE MADE OF.
//
// Only one of the lane's answer paths produces a confidence. `llm_primary` carries the model's own
// self-report. The catalog paths carry `score: Math.max(72, 95 - index * 3)` — a POSITION — and a
// hard-coded top-level 0.9 (0.62 for the transient fallback). With a shortlist of six, 95 - 3i never
// drops below 80, so EVERY catalog item bands to `lane_confidence: high` whatever it is and whatever
// was asked for. Measured on prod 2026-09-09: "a bronzer for contouring my cheekbones" answered with
// three Jurlique/Embryolisse cleansers, all `high`, `confidence_overall: 0.9`, `warnings: []`.
//
// The precedent for the fix is already in recommendProducts.js: an UNGROUNDED item carries no band,
// because "fit-to-catalog is unmeasurable for a product that is not in the catalog; an asserted band
// there is a model claim with no object". A position is the same — an assertion with no object.

process.env.AURORA_BFF_USE_MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRecommendProducts, recommendationItemToSignal } = require('../src/agentSignals/recommendProducts');

const catalogItems = (n) => Array.from({ length: n }, (_, i) => ({
  product_id: `p${i}`, merchant_id: 'm', name: `Cleanser ${i}`, brand: 'Jurlique',
  category: 'Cleanser', price: 44, currency: 'USD', url: 'https://x.test/p',
  image_url: 'https://x.test/i.png', step: 'cleanser', grounding: 'catalog',
  score: Math.max(72, 95 - i * 3),
}));

async function answer({ basis, confidence, count = 3 }) {
  const handler = makeRecommendProducts({
    generate: async () => ({
      norm: {
        payload: {
          recommendations: catalogItems(count),
          confidence,
          recommendation_meta: {
            source_mode: 'catalog_grounded',
            ...(basis === undefined ? {} : { confidence_basis: basis }),
          },
        },
      },
    }),
    isEnabled: () => true,
    verifyPrice: null,
  });
  return handler({ payload: { need: 'a bronzer for contouring my cheekbones', limit: count } }, { agent_id: 'a' });
}

test('a positional score is not reported as certainty', async () => {
  const res = await answer({ basis: 'positional', confidence: 0.9 });
  assert.equal(res.signals.length, 3, 'the items are still returned — this is about the LABEL, not the answer');
  assert.equal(res.metadata.confidence_overall, null, 'a hard-coded 0.9 must not travel as certainty');
  assert.equal(res.metadata.confidence_basis, 'positional');
  for (const signal of res.signals) {
    assert.equal(signal.value.lane_confidence.level, null);
    assert.equal(signal.value.lane_confidence.basis, 'positional');
    // The deprecated alias is the SAME object, so it must not become a way to read the old lie.
    assert.equal(signal.value.fit.level, null);
  }
});

test('every catalog item banded HIGH before this change — that is the defect, stated', () => {
  // Not a test of the fix; a test of the arithmetic that made the fix necessary. If the positional
  // formula ever changes so that it no longer saturates the top band, this fails and someone should
  // re-read whether suppression is still the right call.
  //
  // Tied to the PRODUCTION formula, not to the fixture's copy of it: an earlier version asserted
  // only the numbers this file generates, so it would have gone on passing after routes.js changed.
  const routesSrc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'auroraBff', 'routes.js'), 'utf8');
  // COUNT, not presence: the formula is written out THREE times in routes.js, so an `includes`
  // check goes on passing after one of them changes — which is exactly what a mutant proved.
  const formulaCopies = routesSrc.split('score: Math.max(72, 95 - index * 3)').length - 1;
  assert.equal(formulaCopies, 3,
    'a catalog score formula changed or moved; re-derive the bands below before trusting this test');
  const scores = catalogItems(6).map((item) => item.score);
  assert.deepEqual(scores, [95, 92, 89, 86, 83, 80]);
  assert.ok(scores.every((score) => score >= 80), 'all six land in the top band regardless of the need');
});

test("a model's own estimate still travels, unchanged", async () => {
  const res = await answer({ basis: 'model_self_report', confidence: 0.7 });
  assert.equal(res.metadata.confidence_overall, 0.7);
  assert.equal(res.metadata.confidence_basis, 'model_self_report');
  assert.equal(res.signals[0].value.lane_confidence.level, 'high');
  assert.equal(res.signals[0].value.lane_confidence.basis, 'model_self_report');
});

test('a lane that reports no basis behaves exactly as before', async () => {
  // The suppression is opt-IN on a positive report of 'positional'. Any caller that does not know
  // about the basis — including recommendationItemToSignal's other consumers — is unaffected, so
  // this change cannot silently blank bands somewhere it was never reasoned about.
  const res = await answer({ basis: undefined, confidence: 0.9 });
  assert.equal(res.metadata.confidence_overall, 0.9);
  assert.equal(res.metadata.confidence_basis, 'unknown');
  assert.equal(res.signals[0].value.lane_confidence.level, 'high');
  assert.equal(res.signals[0].value.lane_confidence.basis, 'unknown');
});

test('the signal builder defaults to the old behaviour, and suppresses only when told', () => {
  const item = catalogItems(1)[0];
  assert.equal(recommendationItemToSignal(item, {}).value.lane_confidence.level, 'high');
  assert.equal(recommendationItemToSignal(item, { confidenceBasis: 'model_self_report' }).value.lane_confidence.level, 'high');
  assert.equal(recommendationItemToSignal(item, { confidenceBasis: 'positional' }).value.lane_confidence.level, null);
});

test('an ungrounded item is still bandless, and says which kind of nothing it is', () => {
  // The pre-existing suppression must survive, and must stay distinguishable from the new one:
  // 'ungrounded' means the product is not in the catalog, 'positional' means we do not measure this
  // on this answer path. Both give a null band, for different reasons.
  // `grounded` is derived from grounding_status, not from a missing id — checked, not assumed.
  const ungrounded = { name: 'An Invented Serum', score: 95, grounding_status: 'ungrounded', step: 'treatment' };
  const signal = recommendationItemToSignal(ungrounded, { confidenceBasis: 'model_self_report' });
  assert.ok(signal, 'the projection keeps ungrounded items; the SHORTLIST suppresses them later');
  assert.equal(signal.value.lane_confidence.level, null);
  assert.equal(signal.value.lane_confidence.basis, 'ungrounded');
});

test('the description tells an agent how to read a null band', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'mcp-server', 'src', 'commerceToolSurface.js'), 'utf8');
  assert.ok(/A null band means unmeasured, not low/.test(src),
    'a null that reads as "low confidence" is a new wrong answer, not a fixed one');
  assert.ok(/`positional` means the lane has NO certainty estimate/.test(src));
  assert.ok(/lane_confidence\.basis/.test(src));
});

// --- the lane side ------------------------------------------------------------------
//
// Everything above feeds `confidence_basis` in by hand, so the DERIVATION and both plumbing hops
// (engine -> result -> recommendation_meta) are invisible to it. That is the shape of the #2150
// defect: a test that hand-feeds the flag it is meant to be proving. These pin the other end.

const { deriveRecoConfidenceBasis, RECO_CONFIDENCE_BASIS } = require('../src/auroraBff/recoConfidenceBasis');

test('the basis is derived from the answer path, not from the answer', () => {
  assert.equal(deriveRecoConfidenceBasis('llm_primary'), 'model_self_report');
  assert.equal(deriveRecoConfidenceBasis('catalog_grounded'), 'positional');
  // The transient fallback hard-codes 0.62 over a FIXED product list that does not depend on the
  // need at all — the least defensible of the three, and the one most easily left behind.
  assert.equal(deriveRecoConfidenceBasis('catalog_transient_fallback'), 'positional');
  assert.equal(deriveRecoConfidenceBasis('legacy_notice'), 'none');
  assert.equal(deriveRecoConfidenceBasis(null), 'none');
  assert.equal(deriveRecoConfidenceBasis(''), 'none');
  assert.equal(deriveRecoConfidenceBasis('  LLM_PRIMARY '), 'model_self_report');
  // An unknown future source must NOT default to a basis that licenses a band.
  assert.equal(deriveRecoConfidenceBasis('some_new_path_v2'), 'none');
  assert.equal(RECO_CONFIDENCE_BASIS.POSITIONAL, 'positional');
});

const CLIENT_ID = require.resolve('../src/auroraBff/auroraDecisionClient');
const ROUTES_ID = require.resolve('../src/auroraBff/routes');

async function laneBasis(chatImpl) {
  // routes.js destructures auroraChat at load, so the stub goes in before the require.
  delete require.cache[ROUTES_ID];
  delete require.cache[CLIENT_ID];
  const client = require('../src/auroraBff/auroraDecisionClient');
  const original = client.auroraChat;
  client.auroraChat = chatImpl;
  try {
    const { __internal } = require('../src/auroraBff/routes');
    const res = await __internal.generateProductRecommendations({
      ctx: {
        request_id: 'req_conf', trace_id: 'trace_conf', aurora_uid: 'agent:test',
        lang: 'EN', trigger_source: 'agent_tool', state: null, backend_auth_headers: {},
      },
      profile: null, recentLogs: [], message: 'a gentle retinol for beginners',
      focus: 'a gentle retinol for beginners', includeAlternatives: false,
      debug: true, logger: null, budgetMs: 4000, entryType: 'direct', recoTriggerSource: 'agent_tool',
    });
    return res?.norm?.payload?.recommendation_meta?.confidence_basis;
  } finally {
    client.auroraChat = original;
    delete require.cache[ROUTES_ID];
    delete require.cache[CLIENT_ID];
  }
}

test('the derived basis reaches recommendation_meta through the real lane', async () => {
  // TWO paths, because one would let a hard-coded constant pass. The lane does not expose
  // structuredSource on its result, so the discrimination has to come from driving it twice.
  const answered = await laneBasis(async () => ({
    answer: JSON.stringify({
      recommendations: [{ brand: 'X', name: 'Y', step: 'treatment', query_terms: ['salicylic acid'], reasons: ['r'] }],
      confidence: 0.7, warnings: [], missing_info: [],
    }),
  }));
  assert.equal(answered, 'model_self_report', 'a model answer carries the model\'s own estimate');

  const deadLeg = await laneBasis(async () => {
    const err = new Error('Upstream status 400');
    err.status = 400;
    throw err;
  });
  assert.equal(deadLeg, 'none', 'no answer path ran, so there is no basis to claim');

  assert.notEqual(answered, deadLeg, 'a constant would satisfy neither assertion honestly');
});

test('a MIXED answer reports each row honestly', async () => {
  // With a price ceiling set and the model's conforming picks short of the limit,
  // applyStrictConformingTopUp appends catalog rows into an llm_primary answer. Measured before
  // this fix: the model's own pick banded `medium` (score 61) while two positional fillers banded
  // `high` (95, 92) — all three labelled `model_self_report`, the fillers outranking the real pick
  // and the label vouching for them.
  const model = { product_id: 'a', merchant_id: 'm', name: 'Model pick', brand: 'B', price: 10,
    currency: 'USD', url: 'https://x.test/p', image_url: 'https://x.test/i.png',
    step: 'cleanser', grounding: 'catalog', score: 61 };
  // The filler is produced by the REAL top-up, not hand-stamped: hand-feeding `score_basis` here
  // left the stamp itself unpinned, which is the same hand-fed-flag defect this workstream keeps
  // repeating. applyStrictConformingTopUp is what knows which rows were filler.
  const { applyStrictConformingTopUp } = require('../src/auroraBff/legacyRecoMainlineExecution');
  const toppedUp = applyStrictConformingTopUp({
    structured: { recommendations: [model] },
    catalogStructured: {
      recommendations: [{ ...model, product_id: 'b', name: 'Top-up filler', score: 95 }],
    },
    priceCeiling: { limit: 50, currency: 'USD' },
    shortlistTarget: 2,
  });
  assert.equal(toppedUp.appendedCount, 1, 'the top-up must actually have appended a row');
  const [, filler] = toppedUp.structured.recommendations;
  assert.equal(filler.score_basis, 'positional', 'the top-up must stamp what its rows are');
  const handler = makeRecommendProducts({
    generate: async () => ({ norm: { payload: {
      recommendations: [model, filler], confidence: 0.7,
      recommendation_meta: { source_mode: 'llm_primary', confidence_basis: 'model_self_report' },
    } } }),
    isEnabled: () => true, verifyPrice: null,
  });
  const res = await handler({ payload: { need: 'a gentle cleanser under $50', limit: 2 } }, { agent_id: 'a' });
  const [first, second] = res.signals;
  assert.equal(first.value.lane_confidence.level, 'medium');
  assert.equal(first.value.lane_confidence.basis, 'model_self_report');
  assert.equal(second.value.lane_confidence.level, null, 'filler must not outrank the model\'s own pick');
  assert.equal(second.value.lane_confidence.basis, 'positional');
  // The answer-level number still describes the answer, which really was model-primary.
  assert.equal(res.metadata.confidence_basis, 'model_self_report');
});
