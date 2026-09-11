'use strict';

// "IT RESOLVED A STEP" MEANT "IT IS SKINCARE" only while every step WAS a skincare step.
//
// `beautyRecoCoarseClassifier` used `Boolean(candidateStep)` as a skincare cue, and as the cue for
// usage_scope='face' and application_mode='leave_on'. Once the taxonomy learned makeup and
// fragrance (#2155), a Tom Ford eau de parfum resolved `fragrance`, satisfied the cue, and was
// classified domain_scope=skincare / face / leave_on — a valid skincare hit on a skincare query.
//
// It surfaced as PERFUMES rather than lipsticks because MAKEUP_RE catches colour cosmetics one
// branch earlier; nothing was watching fragrance. Measured on the real 7-day query "few skincare":
// fragrance rows in the valid set went 4 -> 18.

process.env.AURORA_BFF_USE_MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyBeautyCoarseCandidate } = require('../src/shared/beautyRecoCoarseClassifier');

const classify = (title) => classifyBeautyCoarseCandidate({ title, name: title }, { queryText: 'few skincare' }) || {};

test('a fragrance is not a skincare hit, however cleanly its step resolves', () => {
  for (const title of [
    'Tom Ford Black Orchid Eau de Parfum',
    'Gucci Flora Gorgeous Gardenia EDP',
    'Rabanne 1 Million Eau de Toilette',
  ]) {
    const c = classify(title);
    assert.equal(c.candidate_step, 'fragrance', `${title}: the step must still resolve — that is #2155's fix`);
    assert.notEqual(c.domain_scope, 'skincare', `${title} must not be a skincare hit`);
    assert.notEqual(c.usage_scope, 'face', `${title} must not claim face usage`);
    assert.notEqual(c.application_mode, 'leave_on', `${title} must not claim a leave-on skincare mode`);
  }
});

test('and real skincare is untouched — the cue still fires for the steps it was written for', () => {
  for (const title of [
    'CeraVe Daily Moisturizing Lotion',
    'The Ordinary Niacinamide 10% + Zinc 1%',
    'Supergoop Unseen Sunscreen SPF 40',
    'Paula’s Choice 2% BHA Liquid Exfoliant',
  ]) {
    const c = classify(title);
    assert.equal(c.domain_scope, 'skincare', title);
    assert.equal(c.usage_scope, 'face', title);
    assert.equal(c.application_mode, 'leave_on', title);
  }
});

test('a resolved step no longer stands in for same-family when no query family is given', () => {
  // With no queryTargetStepFamily to compare against, "it resolved a step" used to mean "a skincare
  // row of some kind", so it stood in for same_family. A fragrance resolving a step does not make
  // it same-family with an unspecified query.
  const fragrance = classifyBeautyCoarseCandidate(
    { brand: 'Tom Ford', name: 'Black Orchid Eau de Parfum', category: 'Fragrance' },
    { queryTargetStepFamily: '' },
  ) || {};
  assert.equal(fragrance.candidate_step, 'fragrance');
  assert.notEqual(fragrance.family_relation, 'same_family',
    'a perfume must not claim same-family against an unspecified query');
  // A skincare row still does.
  const serum = classifyBeautyCoarseCandidate(
    { brand: 'The Ordinary', name: 'Niacinamide 10% + Zinc 1% Serum', category: 'Skincare > Serums' },
    { queryTargetStepFamily: '' },
  ) || {};
  assert.equal(serum.family_relation, 'same_family');
});

test('a product whose NAME says sunscreen is a sunscreen, whatever aisle it is filed in', () => {
  // Supergoop types "Unseen Sunscreen SPF 50" as product_type "Primer" under
  // beauty/makeup/face/primer. Before this taxonomy knew `primer` the structured field resolved to
  // nothing and text salvage called it a sunscreen; once `primer` existed the structured field won
  // and the row left the sunscreen pipeline — on a `sunscreen` query it went same_family →
  // incompatible_family and out of the top 20, on the 640-calls/7d lane.
  for (const row of [
    { brand: 'Supergoop!', name: 'Unseen Sunscreen SPF 50', product_type: 'Primer', category_path: 'beauty/makeup/face/primer' },
    { brand: 'Supergoop!', name: 'Dewscreen Hydrating Primer SPF 50', product_type: 'Primer' },
    { brand: 'Supergoop!', name: 'Glowscreen SPF 40', product_type: 'Primer' },
  ]) {
    assert.equal((classifyBeautyCoarseCandidate(row, { queryTargetStepFamily: '' }) || {}).candidate_step,
      'sunscreen', row.name);
  }
  // A FOUNDATION with SPF is sold on coverage and keeps its step — only `primer` yields to a bare
  // SPF claim, the same asymmetry the step resolver encodes.
  assert.equal((classifyBeautyCoarseCandidate(
    { brand: 'Estée Lauder', name: 'Double Wear Foundation SPF 10', product_type: 'Foundation' },
    { queryTargetStepFamily: '' },
  ) || {}).candidate_step, 'foundation');
  // And a primer with no sun claim is still a primer.
  assert.equal((classifyBeautyCoarseCandidate(
    { brand: 'Milk Makeup', name: 'Pore Eclipse Mattifying Primer', product_type: 'Primer' },
    { queryTargetStepFamily: '' },
  ) || {}).candidate_step, 'primer');
});

test('a makeup or fragrance step may not be salvaged from prose', () => {
  // buildBeautyCandidateText joins descriptions, how-to-use copy, claims and ingredient tokens, and
  // skincare copy is full of makeup words. A shampoo acquired a `fragrance` step from its scent
  // description and ranked above real perfumes on a `perfume` query.
  for (const row of [
    { brand: 'Paul Mitchell', name: 'Tea Tree & Macadamia Deep Cleansing Shampoo', description: 'A rich lather with a fresh fragrance and perfume-like notes.' },
    { brand: 'Glow Recipe', name: 'Dew Boost Makeup Serum', description: 'grips foundation and keeps makeup in place' },
  ]) {
    const step = (classifyBeautyCoarseCandidate(row, { queryTargetStepFamily: '' }) || {}).candidate_step;
    assert.ok(!step || !['fragrance', 'foundation', 'lip_colour', 'eye_colour', 'blush', 'bronzer'].includes(step),
      `${row.name}: got a makeup/fragrance step out of prose (${step})`);
  }
  // The IDENTITY still salvages a makeup step, which is what #2155 needs.
  assert.equal((classifyBeautyCoarseCandidate({ brand: 'Benefit', name: 'Hoola Matte Bronzer' },
    { queryTargetStepFamily: '' }) || {}).candidate_step, 'bronzer');
  // And skincare salvage from prose is untouched — the reading this function was built for.
  assert.equal((classifyBeautyCoarseCandidate({ brand: 'CeraVe', name: 'Daily Moisturizing Lotion', description: 'a rich moisturizer for dry skin' },
    { queryTargetStepFamily: '' }) || {}).candidate_step, 'moisturizer');
});
