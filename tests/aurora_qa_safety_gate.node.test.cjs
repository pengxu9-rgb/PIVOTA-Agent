const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveQaPlan } = require('../src/auroraBff/qaPlanner');
const { INTENT_ENUM } = require('../src/auroraBff/intentCanonical');

test('qaPlanner treats optional safety REQUIRE_INFO as soft non-blocking', () => {
  const plan = resolveQaPlan({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    profile: {
      skinType: 'oily',
      sensitivity: 'medium',
      barrierStatus: 'healthy',
      goals: ['acne'],
    },
    message: 'Can I use retinol with acids?',
    language: 'EN',
    hasAnchor: false,
    safetyDecision: {
      block_level: 'REQUIRE_INFO',
      required_fields: ['pregnancy_status'],
      required_questions: ['Are you currently pregnant or trying to conceive?'],
      reasons: ['Pregnancy status is needed before retinoid guidance.'],
    },
  });

  assert.equal(plan.gate_type, 'soft');
  assert.deepEqual(plan.required_fields, ['pregnancy_status']);
  assert.equal(plan.safety_require_info_optional, true);
  assert.equal(plan.next_step, 'upstream');
  assert.equal(plan.can_answer_now, true);
});

test('qaPlanner treats core recommendation profile fields as soft advisory', () => {
  const plan = resolveQaPlan({
    intent: INTENT_ENUM.RECO_PRODUCTS,
    profile: { skinType: 'oily' },
    message: 'Recommend products for me',
    language: 'EN',
    hasAnchor: false,
    safetyDecision: null,
  });

  assert.equal(plan.gate_type, 'soft');
  assert.ok(Array.isArray(plan.required_fields));
  assert.ok(plan.required_fields.includes('sensitivity'));
  assert.equal(plan.next_step, 'upstream');
  assert.equal(plan.can_answer_now, true);
});
