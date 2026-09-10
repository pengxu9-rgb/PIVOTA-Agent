'use strict';

// A LOOFAH IS NOT A GENTLE EXFOLIANT.
//
// Live 2026-08-21, after #2062 deployed. Founder probe, PRICE_MAX=40, "a gentle exfoliant for
// sensitive skin under $40". Slots 1-2 were finally right (The Ordinary Salicylic 2% $5.16, Naturium
// BHA 2% $19 -- chemical and conforming). Slot 3 was:
//
//     kylie cosmetics -- "Loofah", $4, fit=high
//
// A bath IMPLEMENT. No formulation, maximally abrasive, recommended as gentle for sensitive skin.
// The catalog row (sig_b2fcb53af3a73ab15b2bd0d32a5003ec): title="Loofah", brand="kylie cosmetics",
// category="Beauty Product", category_path="beauty", category_label="Body Care".
//
// TWO defects, both verified against the shipped code before changing it:
//
//   A. Implements are not classified as out of scope. "loofah" is in no vocabulary, so the row came
//      back `ambiguous` -- admissible with a 0.18 penalty.
//   B. The row's ONLY body signal lives in `category_label`, and productText never read that field.
//      It also skipped `category_path` unless it was an Array, and this row's is the string "beauty".
//      NON_FACE_SUPPORT_RE does match "body" -- it just never saw the field that said so. Measured:
//      the same row with category:"Body Care" DID classify explicit_non_face_supportive on main.
//
// Plus C, defense in depth: "loofah" was absent from #2062's abrasion vocabulary, so it classified
// UNKNOWN -> neutral tier -> it out-ranked the actual scrubs it should have lost to.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/usecases/recoHybridResolveCandidates');
const { classifyRecoCandidateAbrasion, resolveRecoGentlenessRankTier } =
  require('../src/auroraBff/recoGentlenessSignals');
const {
  resolveRecommendationTargetContext,
  finalizeRecommendationCandidatePools,
} = require('../src/auroraBff/recommendationSharedStack');

const classify = (row) => __internal.classifySkincareCandidate(row);
const domainOf = (row) => classify(row).classification;

// The founder's row, field for field.
const FOUNDER_LOOFAH = Object.freeze({
  title: 'Loofah',
  brand: 'kylie cosmetics',
  category: 'Beauty Product',
  category_path: 'beauty',
  category_label: 'Body Care',
});

const GENTLE_NEED = 'a gentle exfoliant for sensitive skin under $40';
const USD40 = Object.freeze({ limit: 40, currency: 'USD' });
const ctxFor = (text) => resolveRecommendationTargetContext({ text, entryType: 'direct' });
const ids = (rows) => rows.map((r) => r.product_id).join(',');

function candidate(product_id, name, price_amount, extra = {}) {
  return {
    product_id,
    merchant_id: 'm1',
    name,
    product_type: 'treatment',
    price_amount,
    currency: 'USD',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. The founder's row is never recommendable
// ---------------------------------------------------------------------------

test("the founder's loofah row is explicitly out of scope, not merely penalised", () => {
  const result = classify(FOUNDER_LOOFAH);
  // Mutant killed: reverting the implement rule. On main this row classified `ambiguous` -- a 0.18
  // penalty, i.e. admissible, which is how it reached slot 3.
  assert.equal(result.classification, 'explicit_non_skincare');
  // explicit_non_skincare, NOT explicit_non_face_supportive. Only this class carries hard_reject at
  // the SOURCE, so every consumer honours it -- non_face_supportive is a 0.28 demotion, which would
  // leave a loofah recommendable whenever the pool was thin.
  // Mutant killed: classifying implements as explicit_non_face_supportive.
  assert.equal(result.hard_reject, true);
  assert.equal(result.penalty, 1);
  assert.equal(result.reason, 'explicit_non_skincare_implement');
});

test("the founder's loofah never reaches the viable pool", () => {
  const pool = [
    candidate('ord', 'The Ordinary Salicylic Acid 2% Solution', 5.16),
    candidate('nat', 'Naturium BHA 2% Liquid Exfoliant', 19),
    candidate('loofah', 'Loofah', 4, {
      brand: 'kylie cosmetics',
      category: 'Beauty Product',
      category_path: 'beauty',
      category_label: 'Body Care',
    }),
    candidate('nuxe', 'NUXE Radiance Face Scrub', 29),
    candidate('axis', 'AXIS-Y PHA Resurfacing Glow Peel', 6),
  ];
  const state = finalizeRecommendationCandidatePools(pool, {
    targetContext: ctxFor(GENTLE_NEED),
    priceCeiling: USD40,
  });
  // Mutant killed: any change that leaves implements admissible. The shortlist is three chemical
  // exfoliants; the loofah is hard-rejected and the real scrub is demoted but KEPT.
  assert.equal(ids(state.selected_recommendations), 'ord,nat,axis');
  assert.ok(!ids(state.viable_candidate_pool).includes('loofah'));
  assert.equal(state.hard_reject_count, 1);
  // Regression on #2062: chemical still leads, the scrub is still present and still last.
  assert.equal(ids(state.viable_candidate_pool), 'ord,nat,axis,nuxe');
});

test('C: an admitted implement would still rank LAST under a gentleness need', () => {
  // Defense in depth: the classifier above is the real guard, but if a lane ever admits one it must
  // not sit neutral above the scrubs.
  // Mutant killed: reverting the abrasion vocabulary addition -- "Loofah" would read UNKNOWN, whose
  // tier (1) out-ranks physical (2). That is exactly how it beat the scrubs on the live run.
  assert.equal(classifyRecoCandidateAbrasion({ name: 'Loofah' }), 'physical');
  assert.equal(classifyRecoCandidateAbrasion({ name: 'Konjac Sponge' }), 'physical');
  assert.equal(classifyRecoCandidateAbrasion({ name: 'Exfoliating Mitt' }), 'physical');
  assert.equal(classifyRecoCandidateAbrasion({ name: 'Pumice Stone' }), 'physical');
  assert.equal(classifyRecoCandidateAbrasion({ name: '天然丝瓜络' }), 'physical');
  const gentle = { gentleness_preferred: true, scrub_requested: false };
  assert.equal(resolveRecoGentlenessRankTier({ name: 'Loofah' }, gentle), 2);
});

// ---------------------------------------------------------------------------
// 2. A: the implement vocabulary
// ---------------------------------------------------------------------------

test('implements are rejected across the vocabulary, EN and CN', () => {
  for (const title of [
    'Loofah', 'Natural Luffa', 'Konjac Sponge', 'Cleansing Sponge', 'Exfoliating Mitt',
    'Silicone Exfoliating Gloves', 'Pumice Stone', 'Rose Quartz Gua Sha', 'Jade Roller',
    'Powder Puff', 'Microfiber Face Cloth', 'Bamboo Washcloth', 'Silicone Spatula',
    'Spa Headband', 'Bamboo Towel', 'Blackhead Extractor', 'Dry Brush',
    '天然丝瓜络', '洁面刷', '刮痧板',
  ]) {
    // Mutant killed: dropping any arm of the implement vocabulary, or dropping the CN arm entirely.
    assert.equal(domainOf({ title }), 'explicit_non_skincare', `"${title}" should be out of scope`);
  }
});

test('the implement reading is HEAD-anchored, not a substring match', () => {
  // The word has to be what the product IS. Mutant killed: testing the implement pattern anywhere in
  // the title (or against the full haystack, which mixes in brand, category and description).
  assert.notEqual(domainOf({ title: 'Sponge-Applied Tinted Moisturizer' }), 'explicit_non_skincare');
  assert.notEqual(domainOf({ title: 'Loofah Extract Body Polish' }), 'explicit_non_skincare');
  assert.notEqual(domainOf({ title: 'Roller Ball Hydrating Mist' }), 'explicit_non_skincare');
  // ...and a loofah sold under a "Skincare" category is still a loofah.
  assert.equal(domainOf({ title: 'Loofah', category: 'Skincare' }), 'explicit_non_skincare');
});

test('a title that also names a FORMULATION is a formulation', () => {
  // Mutant killed: dropping IMPLEMENT_FORMULATION_CARVE_OUT_RE. Every one of these is a real product
  // shape, and each would be hard-rejected without the carve-out.
  for (const title of [
    'Vitamin C Serum Roller',
    'Facial Oil Roller',
    'Konjac Cleansing Foam',
    'Rose Water Facial Mist Spray',
    'Charcoal Sponge Cleanser',
    '精华滚珠',
  ]) {
    assert.notEqual(
      domainOf({ title }),
      'explicit_non_skincare',
      `"${title}" is a formulation and must stay admissible`,
    );
  }
});

test('real formulations are completely untouched', () => {
  for (const title of [
    'The Ordinary Salicylic Acid 2% Solution',
    'Naturium BHA 2% Liquid Exfoliant',
    'AXIS-Y PHA Resurfacing Glow Peel',
    'COSRX AHA/BHA Clarifying Treatment Toner',
    'NUXE Radiance Face Scrub',
  ]) {
    // Mutant killed: an over-broad implement pattern. A scrub is a product, not an implement -- it
    // must stay admissible and be handled by #2062's ranking, not by rejection.
    assert.notEqual(domainOf({ title }), 'explicit_non_skincare', title);
  }
});

// ---------------------------------------------------------------------------
// 3. B: category signals reach the classifier
// ---------------------------------------------------------------------------

test('category_label now reaches the haystack', () => {
  // On main this returned `ambiguous`: category_label was read by nothing. NON_FACE_SUPPORT_RE
  // already matched "body" -- it just never saw the field.
  // Mutant killed: reverting the category_label threading in productText.
  assert.equal(
    domainOf({ title: 'Exfoliating Treatment', category_label: 'Body Care' }),
    'explicit_non_face_supportive',
  );
  assert.equal(
    domainOf({ title: 'Exfoliating Treatment', categoryLabel: 'Body Care' }),
    'explicit_non_face_supportive',
  );
});

test('a STRING category_path is read; an ARRAY one still is', () => {
  // Mutant killed: reverting the string branch. The founder's row carries category_path="beauty" as
  // a string, so the pre-existing Array.isArray spread skipped it entirely.
  assert.equal(
    domainOf({ title: 'Exfoliating Treatment', category_path: 'beauty/body-care' }),
    'explicit_non_face_supportive',
  );
  assert.equal(
    domainOf({ title: 'Exfoliating Treatment', category_path: ['beauty', 'body care'] }),
    'explicit_non_face_supportive',
  );
});

test('a Body-Care row that also carries FACE signals stays admissible', () => {
  const result = classify({ title: 'Facial Hydrating Serum', category_label: 'Body Care' });
  // Mutant killed: promoting the body-category signal to a hard reject. A face serum filed under a
  // body category is the wrong shelf, not the wrong product -- demoted (0.28), never dropped.
  assert.equal(result.classification, 'explicit_non_face_supportive');
  assert.equal(result.hard_reject, false);
  assert.equal(result.penalty, 0.28);
});

test('an ABSENT category changes nothing', () => {
  // Mutant killed: defaulting a missing category to anything at all. Most rows carry no category
  // label; a default there would re-classify the catalog.
  assert.equal(domainOf({ title: 'Hydrating Facial Serum' }), 'explicit_face_skincare');
  assert.equal(domainOf({ title: 'Hydrating Facial Serum', category_label: '' }), 'explicit_face_skincare');
  assert.equal(domainOf({ title: 'Hydrating Facial Serum', category_label: null }), 'explicit_face_skincare');
  assert.equal(domainOf({ title: 'Hydrating Facial Serum', category_label: 'Face Care' }), 'explicit_face_skincare');
});

test('PRE-EXISTING, not caused by this PR: brush / blender / applicator are already fatal', () => {
  // The brief asked that "Beauty Blender Cleanser" and "brush cleanser" stay admissible. Measured on
  // origin/main in this worktree: they are ALREADY explicit_non_skincare, because
  // SKINCARE_FATAL_BLOCK_RE has carried `brush|applicator|blender|tool` since long before this PR --
  // and the fatal branch is unconditional, so even an explicit "cleanser" does not rescue it.
  //
  // Making them admissible means WEAKENING a shipped guard, which is the opposite direction from this
  // PR and deserves its own blast-radius measurement. This test pins the behavior so the reviewer can
  // see it is untouched here, and so a later PR that fixes it fails loudly rather than silently.
  // Mutant killed: adding brush/blender/applicator to the new implement vocabulary and imagining that
  // changed something -- it would not; these are already rejected one branch earlier.
  assert.equal(domainOf({ title: 'Beauty Blender Cleanser' }), 'explicit_non_skincare');
  assert.equal(domainOf({ title: 'Brush Cleanser' }), 'explicit_non_skincare');
  assert.equal(domainOf({ title: 'Sponge Applicator Tinted Moisturizer' }), 'explicit_non_skincare');
  // The reason distinguishes the two paths: these come from the pre-existing fatal list, NOT from the
  // new implement rule.
  assert.equal(classify({ title: 'Brush Cleanser' }).reason, 'explicit_non_skincare');
  assert.equal(classify({ title: 'Loofah' }).reason, 'explicit_non_skincare_implement');
});

// ---------------------------------------------------------------------------
// 4. Regression: #2062's gentleness ordering is intact
// ---------------------------------------------------------------------------

test('#2062 regression: chemical still leads, scrubs still last, nothing dropped', () => {
  const pool = [
    candidate('ord', 'The Ordinary Salicylic Acid 2% Solution', 5.16),
    candidate('nuxe', 'NUXE Radiance Face Scrub', 29),
    candidate('tirtir', 'TIRTIR Matcha Bubble Tea Scrub', 20),
    candidate('axis', 'AXIS-Y PHA Resurfacing Glow Peel', 6),
    candidate('nat', 'Naturium BHA 2% Liquid Exfoliant', 19),
  ];
  const gentle = finalizeRecommendationCandidatePools(pool, { targetContext: ctxFor(GENTLE_NEED) });
  // Mutant killed: an implement rule broad enough to reject scrubs. #2062 ranks them; this PR must
  // not start dropping them.
  assert.equal(ids(gentle.viable_candidate_pool), 'ord,axis,nat,nuxe,tirtir');
  assert.equal(gentle.hard_reject_count, 0);

  // ...and a no-signal need is still byte-identical to #2062's baseline.
  const plain = finalizeRecommendationCandidatePools(pool, { targetContext: ctxFor('an exfoliant') });
  assert.equal(ids(plain.viable_candidate_pool), 'ord,nuxe,tirtir,axis,nat');
});
