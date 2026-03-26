const {
  validateResultPayload,
} = require('../src/auroraBff/diagnosisV2Schema');
const {
  detectColdStart,
  detectMissingDataDimensions,
} = require('../src/auroraBff/diagnosisV2Orchestrator');
const { fixtures } = require('./diagnosisV2.fixtures');

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

describe('diagnosisV2', () => {
  test('detects cold start correctly', () => {
    expect(detectColdStart(fixtures.cold_start_new_user.input)).toBe(true);
    expect(detectColdStart(fixtures.no_photo_with_checkin_logs.input)).toBe(false);
    expect(detectColdStart(fixtures.travel_active.input)).toBe(false);
  });

  test('detects missing data dimensions', () => {
    const coldMissing = detectMissingDataDimensions({ ...fixtures.cold_start_new_user.input });
    expect(coldMissing).toEqual(
      expect.arrayContaining(['photo', 'routine', 'checkin', 'travel']),
    );

    const travelMissing = detectMissingDataDimensions({ ...fixtures.travel_active.input });
    expect(travelMissing).not.toContain('travel');
  });

  test('accepts a valid result payload', () => {
    const validation = validateResultPayload(validResult);
    expect(validation.ok).toBe(true);
  });

  test('rejects missing evidence in inferred state', () => {
    const invalidResult = {
      ...validResult,
      inferred_state: {
        axes: [{ axis: 'test', level: 'low', confidence: 0.3, evidence: [], trend: 'new' }],
      },
    };
    const validation = validateResultPayload(invalidResult);
    expect(validation.ok).toBe(false);
  });

  test('rejects empty next actions', () => {
    const validation = validateResultPayload({ ...validResult, next_actions: [] });
    expect(validation.ok).toBe(false);
  });

  test('warns on high confidence cold-start output', () => {
    const validation = validateResultPayload({
      ...validResult,
      inferred_state: {
        axes: [{ axis: 'test', level: 'low', confidence: 0.8, evidence: ['test'], trend: 'new' }],
      },
    });
    expect(validation.ok).toBe(true);
    expect(validation.warnings.length).toBeGreaterThan(0);
    expect(
      validation.warnings.some(
        (warning) => warning.includes('cold_start') && warning.includes('confidence'),
      ),
    ).toBe(true);
  });

  test('requires meta for post procedure goal', () => {
    const validation = validateResultPayload({
      ...validResult,
      goal_profile: { selected_goals: ['post_procedure_repair'], constraints: [] },
    });
    expect(validation.ok).toBe(false);
  });
});
