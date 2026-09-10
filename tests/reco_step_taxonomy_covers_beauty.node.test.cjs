'use strict';

// THE STEP TAXONOMY IS THE ROUTE, NOT A LOOKUP TABLE.
//
// `recoTargetStep.js` held exactly nine skincare steps, and every consumer treated "no step" as
// "nothing to look for". So for a makeup archetype the grounding pass ran ZERO queries — measured:
// `normalizeRecoTargetStep('bronzer')` returned null, `buildSameFamilyQueryLevels` returns [] on a
// falsy step, and the shortlist was then emptied because nothing grounded. The lane was never
// failing to FIND bronzers. It was never searching for them.
//
// Worse than silence: 'cream blush' matched the moisturizer patterns via the bare token `cream`, so
// a blush was resolved as a moisturizer and grounded against moisturizers.
//
// The widened prompt (reco_main_v1_3) recommends makeup and fragrance. The taxonomy the answer is
// resolved against has to know they exist — this is the main route, not a fallback for when it
// fails. Nothing here adds a "when no step resolves" escape hatch, deliberately: that would be the
// seventh workaround stacked on the same defect.

process.env.AURORA_BFF_USE_MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRecoTargetStep,
  extractRecoTargetStepFromText,
  getRecoTargetFamilyRelation,
  CANONICAL_STEP_FAMILY_MAP,
} = require('../src/auroraBff/recoTargetStep');
const {
  buildSameFamilyQueryLevels,
  STEP_QUERY_ALIASES,
} = require('../src/auroraBff/recommendationSharedStack');

const MAKEUP_STEPS = [
  'blush', 'bronzer', 'highlighter', 'foundation', 'concealer',
  'face_powder', 'primer', 'lip_colour', 'eye_colour', 'fragrance',
];

test('every canonical step normalises to itself', () => {
  // THE INVARIANT THAT CAUGHT A BUG IN THIS VERY CHANGE. The skincare steps get it for free — each
  // is a single word its own pattern matches — but `lip_colour`, `eye_colour` and `face_powder` do
  // not, and a canonical step that does not round-trip resolves to null, which puts it straight back
  // into the "no step, no queries" hole this change exists to fill.
  const steps = Object.keys(CANONICAL_STEP_FAMILY_MAP);
  assert.ok(steps.length >= 19, `expected skincare + beauty families, got ${steps.length}`);
  for (const step of steps) {
    assert.equal(normalizeRecoTargetStep(step), step,
      `canonical step "${step}" must normalise to itself, or every consumer sees null`);
  }
});

test('a makeup or fragrance need resolves to a step, from the alias and from free text', () => {
  const cases = [
    ['bronzer', 'bronzer'],
    ['a warm-toned bronzer for contouring my cheekbones', 'bronzer'],
    ['bronzing powder', 'bronzer'],
    ['lipstick', 'lip_colour'],
    ['a long-wear liquid lipstick in brick red', 'lip_colour'],
    ['mascara', 'eye_colour'],
    ['eau de toilette', 'fragrance'],
    ['a fresh citrus eau de parfum for daytime', 'fragrance'],
    ['setting powder', 'face_powder'],
    ['口红', 'lip_colour'],
    ['香水', 'fragrance'],
    ['修容', 'bronzer'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(normalizeRecoTargetStep(text), expected, `alias: ${text}`);
    assert.equal(extractRecoTargetStepFromText(text), expected, `free text: ${text}`);
  }
});

test('a cream blush is a blush, not a moisturizer', () => {
  // The observed defect. `cream` and `lotion` are modifiers at least as often as they are products,
  // and matching them as moisturizer both stole the step AND made the answer ambiguous.
  for (const text of ['cream blush', 'cream bronzer', 'cream eyeshadow']) {
    const step = normalizeRecoTargetStep(text);
    assert.notEqual(step, 'moisturizer', `${text} must not resolve as skincare`);
    assert.equal(extractRecoTargetStepFromText(text), step, `${text} must not be left ambiguous`);
  }
  // CONTROL: the skincare senses of the same words are untouched.
  for (const [text, expected] of [['face cream', 'moisturizer'], ['a rich night cream', 'moisturizer'],
                                  ['body lotion', 'moisturizer'], ['cream', 'moisturizer']]) {
    assert.equal(normalizeRecoTargetStep(text), expected, `${text} is still a moisturizer`);
  }
});

test('grounding builds a real query ladder for every beauty step — the decisive property', () => {
  // This is the whole point. Before, each of these returned ZERO levels and the grounding pass made
  // no catalog query at all, so a model that correctly named a bronzer had its answer emptied.
  for (const step of MAKEUP_STEPS) {
    const levels = buildSameFamilyQueryLevels({
      targetContext: { resolved_target_step: step, resolved_target_step_token: '' },
      profileSummary: null, ingredientContext: null, lang: 'EN', seedTerms: [],
    }) || [];
    const queries = levels.flatMap((l) => (l.queries || []).map((q) => q.query));
    assert.ok(levels.length > 0, `${step}: grounding must build at least one ladder level`);
    assert.ok(queries.length > 0, `${step}: grounding must issue at least one query`);
    assert.ok(queries.some((q) => q && q.trim()), `${step}: queries must not be blank`);
  }
});

test('every beauty step has query aliases, so its ladder is wider than the bare token', () => {
  for (const step of MAKEUP_STEPS) {
    const aliases = STEP_QUERY_ALIASES[step];
    assert.ok(Array.isArray(aliases) && aliases.length >= 3,
      `${step} needs aliases, or it recalls only its own name`);
  }
});

test('beauty families are near-substitutes, and never cross into skincare', () => {
  // A bronzer and a blush are adjacent; a bronzer and a serum are not. Without this the family
  // relation would let an off-category row through as "same family".
  assert.equal(getRecoTargetFamilyRelation('bronzer', 'blush'), 'adjacent_family');
  assert.equal(getRecoTargetFamilyRelation('bronzer', 'bronzer'), 'same_family');
  for (const skincare of ['serum', 'moisturizer', 'cleanser', 'sunscreen']) {
    assert.notEqual(getRecoTargetFamilyRelation('bronzer', skincare), 'same_family',
      `a ${skincare} is not the same family as a bronzer`);
    assert.notEqual(getRecoTargetFamilyRelation('bronzer', skincare), 'adjacent_family',
      `a ${skincare} is not an acceptable substitute for a bronzer — that is #2155 verbatim`);
  }
  // Lip, eye and fragrance take no substitutes at all.
  for (const isolated of ['lip_colour', 'eye_colour', 'fragrance']) {
    assert.deepEqual(CANONICAL_STEP_FAMILY_MAP[isolated].adjacent_family, [],
      `${isolated} must not accept a near-substitute`);
  }
});

test('skincare resolution is unchanged', () => {
  // The taxonomy is shared by chat, the consumer lane and the agent door. Widening it must not move
  // a single skincare answer.
  for (const [text, expected] of [
    ['serum', 'serum'], ['a gentle retinol for beginners', 'treatment'],
    ['sunscreen', 'sunscreen'], ['cleanser', 'cleanser'], ['toner', 'toner'],
    ['essence', 'essence'], ['face oil', 'oil'], ['面膜', 'mask'],
  ]) {
    assert.equal(normalizeRecoTargetStep(text), expected, `skincare: ${text}`);
  }
});
