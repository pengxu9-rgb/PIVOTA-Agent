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
