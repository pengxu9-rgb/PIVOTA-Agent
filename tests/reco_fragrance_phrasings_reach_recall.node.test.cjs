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
// This suite pins the anchor, not the wording of any one ask.

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

// The four phrasings from the report, plus the one that already worked. The bare-noun skincare asks
// are the CONTROL: they were never broken, and a fix that moves them has changed the wrong thing.
const FRAGRANCE_ASKS = Object.freeze([
  'recommend an eau de toilette',
  'recommend an eau de parfum',
  'a citrus cologne',
  'a citrus perfume',
  'recommend a perfume for evenings',
  'recommend a fragrance',
]);

const CONTROL_ASKS = Object.freeze([
  ['a lightweight daily moisturizer', 'moisturizer'],
  ['a fresh gentle exfoliant', 'treatment'],
]);

function planQueriesFor(ask) {
  const targetContext = resolveRecommendationTargetContext({ text: ask, focus: ask, entryType: 'chat' });
  const plan = buildRecoRecallPlan({
    mode: 'step_aware',
    targetContext,
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

    // Precondition, asserted rather than assumed: if the step ever stops resolving, the rest of
    // this test would pass vacuously against a plan for some other family.
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
  // no second query to rescue it. An anchor that is merely PRESENT is not enough — it has to be the
  // one the plan falls back to.
  for (const ask of FRAGRANCE_ASKS) {
    const { queries } = planQueriesFor(ask);
    assert.notDeepEqual(queries, ['fragrance'], `"${ask}" has only the dead anchor to fall back to`);
    assert.equal(
      queries[queries.length - 1],
      'perfume',
      `"${ask}" rescues with ${JSON.stringify(queries[queries.length - 1])}, not "perfume"`,
    );
  }
});

test('the fragrance family anchor is "perfume" on BOTH sides of the contract', () => {
  // Planner side and search side keep separate tables; reco_recall_honest_queries asserts they
  // agree, and this asserts the VALUE they agree on. Mutant killed: restoring 'fragrance' to the
  // head of the alias list (which is what shipped) fails here even though the two tables still
  // agree with each other.
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
  // Without the requested step, this same classifier calls them explicit_non_skincare — which is
  // why an empty/mis-resolved step would empty the pool even with recall fixed.
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
