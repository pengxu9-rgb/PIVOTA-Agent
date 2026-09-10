'use strict';

// THE LANE WHERE MAKEUP SUPPLY LIVES WAS SWITCHED OFF FOR THIS DOOR.
//
// The generic query ladder emitted entries with no source scope at all. The outbound site derives
// `sourceScope` from `entry.source_scope` ONLY, defaulting to 'internal', then sends
// `allowExternalSeed: sourceScope !== 'internal'` — so every generic recall went out internal-only
// and buildPurchasableFallbackCandidates took its internal branch and returned without
// supplementing. #2174 fixed the external-seed CATEGORY VOCABULARY for `beauty/makeup/face/`
// correctly, on a lane this door could not reach.
//
// Item 3 of the makeup chain. Scoped to the domains the internal catalog is thin on, using the same
// step→domain map the taxonomy owns (#2178) rather than a fresh word list.

process.env.AURORA_BFF_USE_MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/routes');

function genericQueries(needSeedText, resolvedStep) {
  const levels = __internal.buildRecoCatalogQueryLevels({
    targetContext: { framework_roles: [], step_aware_intent: false, resolved_target_step: resolvedStep || null },
    profileSummary: null,
    ingredientContext: null,
    lang: 'EN',
    needSeedText,
    maxGenericQueries: 3,
  }) || [];
  const generic = levels.find((l) => l.ladder_level === 'generic_catalog');
  return (generic && generic.queries) || [];
}

// Mirrors the outbound derivation at routes.js (`const sourceScope = ...` → `allowExternalSeed:
// sourceScope !== 'internal'`). Asserted through THIS rather than through `allow_external_seed`
// because the first version of this change set only that flag — which the outbound site never reads
// — and produced a ladder that looked external-eligible in every trace while still going out
// internal-only. The entry flag is asserted too, but it is not what decides.
function outboundAllowsExternalSeed(entry) {
  const normalized = String(entry?.source_scope || 'internal').trim().toLowerCase();
  const sourceScope = normalized === 'external_seed' ? 'external_seed'
    : normalized === 'hybrid' ? 'hybrid' : 'internal';
  return sourceScope !== 'internal';
}

test('a makeup need reaches the external-seed lane', () => {
  const queries = genericQueries('warm toned bronzer contouring', 'bronzer');
  assert.ok(queries.length > 0, 'the generic ladder must produce queries for a bronzer need');
  for (const entry of queries) {
    assert.equal(outboundAllowsExternalSeed(entry), true,
      'the OUTBOUND request must allow external seeds, not merely the entry flag');
    assert.equal(entry.source_scope, 'hybrid',
      'hybrid, not external_seed — internal candidates still run and external seeds supplement');
    assert.equal(entry.allow_external_seed, true);
    assert.equal(entry.external_seed_strategy, 'supplement_internal_first');
  }
});

test('a fragrance need reaches it too', () => {
  const queries = genericQueries('fresh citrus eau de toilette for daytime', 'eau de toilette');
  assert.ok(queries.length > 0);
  assert.ok(queries.every(outboundAllowsExternalSeed));
});

test('a SKINCARE need is byte-identical to before — no supplement, no new keys', () => {
  // The blast-radius control. This ladder is shared by chat and the consumer lane, and turning the
  // external lane on for skincare would change recall for every existing buyer.
  const queries = genericQueries('a gentle retinol for beginners', 'treatment');
  assert.ok(queries.length > 0);
  for (const entry of queries) {
    assert.equal(outboundAllowsExternalSeed(entry), false, 'skincare must stay internal-only');
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'source_scope'), false,
      'no source_scope key at all — the entry must be untouched, not set to internal');
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'allow_external_seed'), false);
  }
});

test('a need with no resolvable step stays internal-only', () => {
  // Absent a domain we do not widen recall on a guess.
  for (const need of ['something nice for my face', '']) {
    for (const entry of genericQueries(need, null)) {
      assert.equal(outboundAllowsExternalSeed(entry), false, `"${need}" must not widen recall`);
    }
  }
});

test('the framework branch is untouched', () => {
  // It sets its own source_scope from its stage plan; this change must not reach it.
  const levels = __internal.buildRecoCatalogQueryLevels({
    targetContext: {
      framework_roles: [{ role_id: 'oil_control_treatment', rank: 1, preferred_step: 'treatment' }],
      step_aware_intent: false,
    },
    profileSummary: null, ingredientContext: null, lang: 'EN',
    needSeedText: 'warm toned bronzer contouring', maxGenericQueries: 3,
  }) || [];
  assert.ok(!levels.some((l) => l.ladder_level === 'generic_catalog'),
    'a framework ask does not use the generic ladder, so it cannot be widened by this change');
});
