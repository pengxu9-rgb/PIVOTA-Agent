const assert = require('assert');
const { validateResultPayload } = require('../src/auroraBff/diagnosisV2Schema');
const {
  detectColdStart,
  detectMissingDataDimensions,
  normalizeDiagnosisV2ResultPayload,
} = require('../src/auroraBff/diagnosisV2Orchestrator');
const { fixtures } = require('./diagnosisV2.fixtures');

console.log('Test: cold start detection');
assert.strictEqual(detectColdStart(fixtures.cold_start_new_user.input), true);
assert.strictEqual(detectColdStart(fixtures.no_photo_with_checkin_logs.input), false);
assert.strictEqual(detectColdStart(fixtures.travel_active.input), false);
console.log('  PASS');

console.log('Test: missing data dimensions');
const coldMissing = detectMissingDataDimensions({ ...fixtures.cold_start_new_user.input });
assert.ok(coldMissing.includes('photo'));
assert.ok(coldMissing.includes('routine'));
assert.ok(coldMissing.includes('checkin'));
assert.ok(coldMissing.includes('travel'));
const travelMissing = detectMissingDataDimensions({ ...fixtures.travel_active.input });
assert.ok(!travelMissing.includes('travel'));
console.log('  PASS');

console.log('Test: schema validation - valid result');
const validResult = {
  diagnosis_id: '550e8400-e29b-41d4-a716-446655440000',
  diagnosis_seq: 1,
  goal_profile: { selected_goals: ['barrier_repair'], constraints: [] },
  is_cold_start: true,
  data_quality: { overall: 'low', limits_banner: 'Initial assessment based on limited data' },
  inferred_state: {
    axes: [
      {
        axis: 'barrier_irritation_risk',
        level: 'moderate',
        confidence: 0.35,
        evidence: ['User reported easy redness'],
        trend: 'new',
      },
    ],
  },
  strategies: [
    {
      title: 'Barrier Repair First',
      why: 'Limited data suggests possible barrier compromise',
      timeline: '2-4 weeks',
      do_list: ['Use gentle cleanser', 'Apply barrier repair cream'],
      avoid_list: ['Avoid strong acids'],
    },
  ],
  routine_blueprint: {
    am_steps: ['Gentle cleanser', 'Moisturizer', 'Sunscreen'],
    pm_steps: ['Gentle cleanser', 'Barrier repair serum', 'Moisturizer'],
    conflict_rules: [],
  },
  improvement_path: [
    {
      tip: 'Take a photo next time for better accuracy',
      action_type: 'take_photo',
      action_label: 'Take photo',
    },
  ],
  next_actions: [{ type: 'setup_routine', label: 'Set up your routine' }],
};
const validation = validateResultPayload(validResult);
assert.strictEqual(validation.ok, true);
console.log('  PASS');

console.log('Test: schema validation - empty evidence now accepted (relaxed)');
const emptyEvidenceResult = {
  ...validResult,
  inferred_state: {
    axes: [{ axis: 'test', level: 'low', confidence: 0.3, evidence: [], trend: 'new' }],
  },
};
assert.strictEqual(validateResultPayload(emptyEvidenceResult).ok, true);
console.log('  PASS');

console.log('Test: schema validation - empty next_actions');
const noActionsResult = { ...validResult, next_actions: [] };
assert.strictEqual(validateResultPayload(noActionsResult).ok, false);
console.log('  PASS');

console.log('Test: quality gate - cold start confidence warning');
const highConfColdStart = {
  ...validResult,
  inferred_state: {
    axes: [{ axis: 'test', level: 'low', confidence: 0.8, evidence: ['test'], trend: 'new' }],
  },
};
const highConfValidation = validateResultPayload(highConfColdStart);
assert.ok(highConfValidation.ok);
assert.ok(highConfValidation.warnings.some((warning) => warning.includes('cold_start') && warning.includes('confidence')));
console.log('  PASS');

console.log('Test: post_procedure requires meta');
const postProcResult = {
  ...validResult,
  goal_profile: { selected_goals: ['post_procedure_repair'], constraints: [] },
};
assert.strictEqual(validateResultPayload(postProcResult).ok, false);
console.log('  PASS');

console.log('Test: result normalization - null payload is stripped');
const nullPayloadResult = normalizeDiagnosisV2ResultPayload(
  {
    ...validResult,
    next_actions: [{ type: 'setup_routine', label: 'Set up your routine', payload: null }],
  },
  fixtures.cold_start_new_user.input,
);
assert.strictEqual(validateResultPayload(nullPayloadResult).ok, true);
assert.deepStrictEqual(nullPayloadResult.next_actions, [{ type: 'setup_routine', label: 'Set up your routine' }]);
console.log('  PASS');

console.log('Test: result normalization - fallback actions and improvement path');
const fallbackResult = normalizeDiagnosisV2ResultPayload(
  {
    ...validResult,
    improvement_path: [{ tip: '', action_type: 'add_travel', action_label: '' }],
    next_actions: [{ type: 'add_travel', label: '', payload: null }],
  },
  fixtures.cold_start_new_user.input,
);
assert.strictEqual(validateResultPayload(fallbackResult).ok, true);
assert.ok(fallbackResult.improvement_path.some((tip) => tip.action_type === 'intake_optimize'));
assert.ok(fallbackResult.next_actions.some((action) => action.type === 'intake_optimize'));
console.log('  PASS');

console.log('\nAll diagnosis v2 tests passed!');
