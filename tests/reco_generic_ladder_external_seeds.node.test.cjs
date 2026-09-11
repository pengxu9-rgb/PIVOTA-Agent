'use strict';

// THE LANE WHERE MAKEUP SUPPLY LIVES WAS SWITCHED OFF FOR THIS DOOR.
//
// The query ladder emitted entries with no source scope at all. The outbound site derives
// `sourceScope` from `entry.source_scope` ONLY, defaulting to 'internal', then sends
// `allowExternalSeed: sourceScope !== 'internal'` — so every recall went out internal-only and
// buildPurchasableFallbackCandidates took its internal branch and returned without supplementing.
// #2174 fixed the external-seed CATEGORY VOCABULARY for `beauty/makeup/face/` correctly, on a lane
// this door could not reach.
//
// THE FIRST VERSION OF THIS TEST BUILT ITS OWN targetContext WITH `step_aware_intent: false`, and
// that single line is why the change under it was a no-op in production and inverted where it was
// not. `step_aware_intent` is set whenever a step resolves at high or medium confidence — which for
// a makeup ask is always — so the branch the fix was attached to is the one a makeup ask never
// takes. Every case below resolves its context through resolveRecommendationTargetContext, the same
// function the runtime calls, so the branch under test is the branch production reaches.

process.env.AURORA_BFF_USE_MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/routes');
const { resolveRecommendationTargetContext } = require('../src/auroraBff/recommendationSharedStack');
const { normalizeRecoTargetStep, resolveRecoStepDomain } = require('../src/auroraBff/recoTargetStep');

function ladderFor(text) {
  const targetContext = resolveRecommendationTargetContext({
    text,
    focus: text,
    entryType: 'direct',
  });
  const levels = __internal.buildRecoCatalogQueryLevels({
    targetContext,
    profileSummary: null,
    ingredientContext: null,
    lang: 'EN',
    needSeedText: text,
    maxGenericQueries: 3,
  }) || [];
  return { targetContext, queries: levels.flatMap((level) => level.queries || []) };
}

// Mirrors the outbound derivation at routes.js (`const sourceScope = ...` → `allowExternalSeed:
// sourceScope !== 'internal'`). Asserted through THIS rather than through `allow_external_seed`
// because an earlier version of this change set only that flag — which the outbound site never
// reads — and produced a ladder that looked external-eligible in every trace while still going out
// internal-only.
// Mirrors `runQueryLevelEntry` in routes.js, which is where the decision is actually made:
//
//     const queryAllowExternalSeed = allowExternalSeed === true && queryEntry?.allow_external_seed === true;
//     source_scope: queryAllowExternalSeed ? 'external_seed' : 'internal'
//
// AN EARLIER VERSION OF THIS HELPER MIRRORED THE WRONG SITE. It read `entry.source_scope` and
// treated it as the decider, which is true only on the recall-plan collector; on the collector this
// ladder reaches, source_scope is OVERWRITTEN from `allow_external_seed`. A test that mirrors the
// wrong site can pass while the wire stays internal-only — the exact failure this file exists to
// catch, one layer up.
function outboundAllowsExternalSeed(entry) {
  return entry?.allow_external_seed === true;
}

function outboundSourceScope(entry) {
  return outboundAllowsExternalSeed(entry) ? 'external_seed' : 'internal';
}

test('a makeup need takes the STEP-AWARE branch, and that is the branch that must reach external seeds', () => {
  for (const text of [
    'a warm toned bronzer for contouring my cheekbones',
    'recommend a lipstick for a warm undertone',
    'recommend a setting powder that will not flash back',
    'a fresh citrus eau de toilette',
  ]) {
    const { targetContext, queries } = ladderFor(text);
    assert.equal(targetContext.step_aware_intent, true,
      `${text}: a resolved beauty step sets step_aware_intent — this is why the generic branch is unreachable`);
    assert.ok(queries.length > 0, `${text}: the ladder must issue queries`);
    for (const entry of queries) {
      assert.equal(outboundAllowsExternalSeed(entry), true,
        `${text}: the OUTBOUND request must allow external seeds, not merely the entry flag`);
      assert.equal(outboundSourceScope(entry), 'external_seed',
        'the query-levels collector rewrites the scope from allow_external_seed');
      assert.equal(entry.allow_external_seed, true);
      // Set for the OTHER collector, executeRecoRecallPlanEntry, which reads source_scope directly.
      assert.equal(entry.source_scope, 'hybrid');
      assert.equal(entry.external_seed_strategy, 'supplement_internal_first',
        'external seeds supplement internal candidates rather than replacing them');
      // The outbound external-seed arm derives targetStepFamily from `preferred_step` alone.
      // The ladder's own alias ('lipstick' for lip_colour) is what the backend can query, so the
      // assertion is that the field is PRESENT and in the requested family, not that it is the
      // family label.
      assert.ok(entry.preferred_step, 'preferred_step must be set — the external-seed arm derives targetStepFamily from it alone');
      assert.equal(normalizeRecoTargetStep(entry.preferred_step), targetContext.resolved_target_step,
        `${entry.preferred_step} must normalise back to the requested step`);
    }
  }
});

test('a skincare need is byte-identical to before — no key, no supplement', () => {
  for (const text of [
    'a gentle exfoliant for sensitive skin',
    'a niacinamide serum for post-acne marks',
    'a broad spectrum sunscreen that does not pill',
    // THE INVERTED CASE, and the one that proves the seed-text fallback had to go. Reading the need
    // TEXT for a domain made "fragrance-free" a fragrance request, so the only need that reached
    // the external-seed lane was a skincare one.
    'a fragrance-free moisturizer for sensitive skin',
  ]) {
    const { queries } = ladderFor(text);
    assert.ok(queries.length > 0, `${text}: the ladder must still issue queries`);
    for (const entry of queries) {
      assert.equal(outboundAllowsExternalSeed(entry), false,
        `${text}: a skincare need must not acquire an external-seed lane`);
      assert.equal(entry.source_scope, undefined, `${text}: and must not acquire a source scope at all`);
    }
  }
});

test('a need with NO resolved step reaches the generic branch and stays internal', () => {
  // THE FALLBACK THIS GUARDS IS NOW DEAD TWICE OVER, and the test says so rather than pretending to
  // catch it. Eligibility reads the resolved step only; and `normalizeRecoTargetStep` shares the
  // denial mask, so "fragrance-free" no longer looks like a fragrance to it either. Both had to be
  // true — the first version of this change read the need TEXT and routed exactly these asks to the
  // makeup supply lane.
  for (const text of [
    'something gentle and fragrance-free, nothing too rich',
    'a fragrance-free option under $30',
    'something soothing without perfume',
  ]) {
    const { targetContext, queries } = ladderFor(text);
    assert.equal(targetContext.resolved_target_step, null, `${text}: no step resolves`);
    assert.equal(resolveRecoStepDomain(text), '', `${text}: and the raw text no longer reads as a domain either`);
    assert.ok(queries.length > 0, `${text}: the generic ladder must still issue queries`);
    for (const entry of queries) {
      assert.equal(outboundAllowsExternalSeed(entry), false,
        `${text}: a need with no resolved step must not be routed to the makeup supply lane`);
      assert.equal(entry.source_scope, undefined);
    }
  }
});

test('the domain comes from the RESOLVED STEP, never from the need text', () => {
  // 'fragrance-free' contains the word the fragrance domain is named after. The eligibility test
  // reads the step the taxonomy resolved, which is `moisturizer`, and nothing else.
  const { targetContext } = ladderFor('a fragrance-free moisturizer for sensitive skin');
  assert.equal(targetContext.resolved_target_step, 'moisturizer');
  const fragrance = ladderFor('a fresh citrus eau de toilette');
  assert.equal(fragrance.targetContext.resolved_target_step, 'fragrance');
});
