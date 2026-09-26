'use strict';

// EVERY FRAGRANCE PHRASING MUST REACH A QUERY THAT RETRIEVES FRAGRANCE.
//
// Measured against prod gateway 79790300377d (2026-09-11), POST /v1/reco/generate:
//
//   "recommend an eau de toilette" -> cards ['confidence_notice'], 0 products
//   "recommend an eau de parfum"   -> cards ['confidence_notice'], 0 products
//   "a citrus cologne"             -> cards ['confidence_notice'], 0 products
//   "recommend a fragrance"        -> cards ['confidence_notice'], 0 products
//   "a citrus perfume"             -> cards ['recommendations'],   3 real perfumes
//
// Intent routing was NOT the cause: all five resolve step `fragrance` at `high` confidence with
// step_aware_intent true. The split was the RECALL ANCHOR. The step-aware plan issues the buyer's
// own token first and the family anchor second (`runIf: if_no_primary_viable_or_transient_only`),
// so the family anchor is the single rescue query every phrasing falls back to. That anchor was the
// literal word "fragrance", which in this catalog is what a MOISTURISER says about itself
// ("fragrance-free"): the failing responses' pool signature decodes to
// viable=0 / soft_mismatch=0 / hard_reject=3 — three rows retrieved and all three rejected as
// non-skincare. "perfume" is the noun a fragrance product is actually TITLED, and it was reachable
// only from the one phrasing that happened to write it.
//
// THE CALL SHAPE HERE IS THE PRODUCTION ONE. Every `step_aware` caller in routes.js
// (21105, 29604, 30395) passes `queryLevels` + `targetStepToken` and NEVER `targetContext` —
// recoRecallPlanner.js:940 says so in as many words. An earlier draft of this suite passed
// `targetContext`, which resolves the family differently (`buildStepAwareSemanticContract` falls
// back to `queryLevels[0].queries[0].step` when it is absent) and therefore pinned a plan prod
// never builds. `planQueriesFor` below is deliberately the shape that ships.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STEP_QUERY_ALIASES,
  resolveRecommendationTargetContext,
  buildSameFamilyQueryLevels,
  classifySkincareCandidateDomain,
} = require('../src/auroraBff/recommendationSharedStack.js');
const { buildRecoRecallPlan } = require('../src/auroraBff/recoRecallPlanner.js');
const { resolveStepFamilyQueryAnchor } = require('../src/findProductsMulti/policy.js');
const { normalizeRecoTargetStep } = require('../src/auroraBff/recoTargetStep.js');

const FRAGRANCE_ASKS = Object.freeze([
  'recommend an eau de toilette',
  'recommend an eau de parfum',
  'a citrus cologne',
  'a citrus perfume',
  'recommend a perfume for evenings',
  'recommend a fragrance',
]);

// The controls that matter are the ones this PR's own thesis puts at risk: "fragrance" is claimed to
// be a word SKINCARE uses about itself, so the asks that say it about skincare are exactly where an
// over-broad rewrite would show up. A plain moisturiser ask could never plan a perfume query and so
// could never fail — these can.
const CONTROL_ASKS = Object.freeze([
  ['a fragrance-free moisturizer', 'moisturizer'],
  ['a fragrance free sunscreen for sensitive skin', 'sunscreen'],
  ['a lightweight daily moisturizer', 'moisturizer'],
  ['a fresh gentle exfoliant', 'treatment'],
]);

function planQueriesFor(ask) {
  const targetContext = resolveRecommendationTargetContext({ text: ask, focus: ask, entryType: 'chat' });
  // Exactly routes.js:21105 — queryLevels and the token, no targetContext.
  const plan = buildRecoRecallPlan({
    mode: 'step_aware',
    queryLevels: buildSameFamilyQueryLevels({ targetContext }),
    targetStepToken: targetContext.resolved_target_step_token || '',
  });
  return {
    targetContext,
    queries: (plan.entries || []).map((entry) => String(entry.query || '').trim().toLowerCase()),
  };
}

test('every fragrance phrasing plans a query that retrieves fragrance', () => {
  for (const ask of FRAGRANCE_ASKS) {
    const { targetContext, queries } = planQueriesFor(ask);

    // Preconditions, asserted rather than assumed: if the step ever stops resolving, everything
    // below would pass vacuously against a plan built for some other family.
    assert.equal(targetContext.resolved_target_step, 'fragrance', `"${ask}" lost its step`);
    assert.equal(targetContext.step_aware_intent, true, `"${ask}" left the step-aware lane`);

    assert.ok(queries.length > 0, `"${ask}" planned no recall query at all`);
    assert.ok(
      queries.includes('perfume'),
      `"${ask}" planned ${JSON.stringify(queries)}, none of which retrieves fragrance`,
    );
  }
});

test('no fragrance phrasing is left with the bare family word as its only query', () => {
  // The specific shape that shipped: `recommend a fragrance` planned exactly ["fragrance"] and had
  // nothing to fall back on.
  for (const ask of FRAGRANCE_ASKS) {
    const { queries } = planQueriesFor(ask);
    assert.ok(
      !queries.includes('fragrance'),
      `"${ask}" still spends a query on the dead anchor: ${JSON.stringify(queries)}`,
    );
  }
});

test('the exact production plan for every fragrance phrasing', () => {
  // Pinned in full, because this change also makes three of these plans SHORTER: when the buyer
  // writes the anchor word itself the token is nulled (recommendationSharedStack.js:957-960) and the
  // pack collapses to one query. That is not a lost rescue — see the next test: on main EVERY family
  // plans exactly one arm when the buyer writes its canonical noun, and fragrance was the sole
  // 2-arm outlier precisely BECAUSE its anchor was a different word from its own canonical noun.
  // The second arm was an artifact of the defect, and the query it spent was the dead "fragrance"
  // one measured returning three rows with all three hard-rejected. Pinned rather than left implicit
  // so a future reader sees the arm count is intended, not an accident.
  const expected = {
    'recommend an eau de toilette': ['eau de toilette', 'perfume'],
    'recommend an eau de parfum': ['eau de parfum', 'perfume'],
    'a citrus cologne': ['cologne', 'perfume'],
    'a citrus perfume': ['perfume'],
    'recommend a perfume for evenings': ['perfume'],
    'recommend a fragrance': ['perfume'],
  };
  for (const [ask, queries] of Object.entries(expected)) {
    assert.deepEqual(planQueriesFor(ask).queries, queries, `plan changed for "${ask}"`);
  }
});

test('a canonical-noun ask plans exactly one arm, in EVERY family including fragrance', () => {
  // This is the invariant that makes the shorter fragrance plans correct rather than a regression.
  // Measured on main before this change: bronzer, blush, highlighter, concealer, foundation,
  // lipstick, eyeshadow, cleanser, toner and serum ALL plan exactly ["<noun>"] — one arm — when the
  // buyer writes the family's own canonical noun. `recommend a perfume` was the ONLY 2-arm case in
  // the repo, and its extra arm was the dead "fragrance" query. After this change fragrance matches
  // the other ten. If a future edit gives fragrance a second arm again, it has to justify why
  // fragrance differs from every other family.
  const CANONICAL_NOUN_ASKS = [
    'recommend a bronzer', 'recommend a blush', 'recommend a highlighter',
    'recommend a concealer', 'recommend a foundation', 'recommend a lipstick',
    'recommend an eyeshadow', 'recommend a cleanser', 'recommend a toner',
    'recommend a serum', 'recommend a perfume',
  ];
  for (const ask of CANONICAL_NOUN_ASKS) {
    assert.equal(
      planQueriesFor(ask).queries.length,
      1,
      `"${ask}" no longer plans a single arm: ${JSON.stringify(planQueriesFor(ask).queries)}`,
    );
  }
});

test('the plan\'s preferred_step is non-canonical for six families and normalizes back for all six', () => {
  // On the production call shape the contract derives the family from the alias HEAD, so a plan's
  // `preferred_step` is the searchable noun, not the family key. That is pre-existing for five
  // families; fragrance becomes the sixth. It is inert ONLY because normalizeRecoTargetStep collapses
  // the noun back to the family key at every wire boundary — so that collapse is the thing to pin.
  // NOTE: this repo has more than one function named normalizeRecoTargetStep (recoTargetStep.js is
  // the one routes.js imports); the copies in concernPlannerNormalizer.js and
  // beautyChatMainlineEnvelope.js do NOT collapse these nouns. Anything grouping by step family must
  // normalize with the recoTargetStep.js one.
  const cases = [
    ['recommend a lipstick', 'lipstick', 'lip_colour'],
    ['recommend an eyeshadow', 'eyeshadow', 'eye_colour'],
    ['a nourishing face oil', 'face oil', 'oil'],
    ['recommend a setting powder', 'setting powder', 'face_powder'],
    ['recommend a perfume', 'perfume', 'fragrance'],
    ['recommend an eau de toilette', 'perfume', 'fragrance'],
  ];
  for (const [ask, expectedPreferred, expectedFamily] of cases) {
    const targetContext = resolveRecommendationTargetContext({ text: ask, focus: ask, entryType: 'chat' });
    const plan = buildRecoRecallPlan({
      mode: 'step_aware',
      queryLevels: buildSameFamilyQueryLevels({ targetContext }),
      targetStepToken: targetContext.resolved_target_step_token || '',
    });
    const preferred = [...new Set((plan.entries || []).map((entry) => entry.preferred_step))];
    assert.deepEqual(preferred, [expectedPreferred], `preferred_step changed for "${ask}"`);
    assert.equal(
      normalizeRecoTargetStep(preferred[0]),
      expectedFamily,
      `"${ask}" preferred_step ${preferred[0]} no longer normalizes back to ${expectedFamily}`,
    );
  }
});

test('the fragrance family anchor is "perfume" on BOTH sides of the contract', () => {
  // Planner side and search side keep separate tables; reco_recall_honest_queries asserts they
  // AGREE, and this asserts the VALUE they agree on. Mutant killed: reverting either file alone
  // fails here. Note the search-side table is what keeps that invariant satisfied — on the
  // production call shape the family already resolves to 'perfume' via the alias head, so without
  // this entry the two tables would simply disagree and the other suite would fail.
  assert.equal(STEP_QUERY_ALIASES.fragrance[0], 'perfume');
  assert.equal(resolveStepFamilyQueryAnchor('fragrance'), 'perfume');
});

test('the rewrite is confined to the fragrance family', () => {
  for (const [ask, expectedStep] of CONTROL_ASKS) {
    const { targetContext, queries } = planQueriesFor(ask);
    assert.equal(targetContext.resolved_target_step, expectedStep, `control "${ask}" changed step`);
    assert.ok(
      !queries.includes('perfume'),
      `control "${ask}" planned a perfume query: ${JSON.stringify(queries)}`,
    );
  }
});

test('a real perfume row survives the domain gate on a fragrance ask', () => {
  // The other half of the round trip. These three titles are the rows prod actually serves for
  // "a citrus perfume", so they are what the repaired anchor now retrieves for the other phrasings.
  // Without the requested step this same classifier calls them explicit_non_skincare — which is why
  // an empty or mis-resolved step would empty the pool even with recall fixed.
  const rows = [
    'PixiPerfume Eau de Parfum - PixiMimosa',
    'Rare Eau de Parfum Travel Spray',
    'cosmic kylie jenner eau de parfum pen spray',
  ].map((title) => ({ product_id: title, title, name: title, category: 'Fragrance', product_type: 'Fragrance' }));

  for (const row of rows) {
    assert.equal(
      classifySkincareCandidateDomain(row, { requestedStep: 'fragrance' }),
      'explicit_requested_beauty_category',
      `${row.title} would be hard-rejected on a fragrance ask`,
    );
    // Control: the admission is EARNED by the requested step, not unconditional.
    assert.equal(
      classifySkincareCandidateDomain(row, { requestedStep: '' }),
      'explicit_non_skincare',
      `${row.title} is admitted with no requested step, so the gate above proves nothing`,
    );
  }
});

test('"body mist" is in the fragrance alias list but does NOT resolve to the fragrance lane', () => {
  // Documented, not fixed. It sits at position 5 of STEP_QUERY_ALIASES.fragrance and this change did
  // not move it, but a suite claiming to cover "every fragrance phrasing" should not quietly omit
  // the one alias in the table it reordered that resolves somewhere else entirely. A buyer asking
  // for a body mist gets the toner lane, and the fragrance ladder's alias-expansion level issues
  // "body mist" as a fragrance query while the catalog files those rows under toner.
  const { targetContext } = planQueriesFor('recommend a body mist');
  assert.equal(targetContext.resolved_target_step, 'toner');
});
