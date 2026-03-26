const fixtures = {
  cold_start_new_user: {
    input: {
      goals: ['barrier_repair'],
      userId: null,
      profile: {},
      recentLogs: [],
      currentRoutine: 'none',
      travelPlans: [],
      hasPhoto: false,
    },
    expectedOutput: {
      is_cold_start: true,
      question_strategy: 'state_probe',
      data_quality_overall: 'low',
      max_confidence: 0.4,
      next_actions_min_count: 1,
      improvement_path_min_count: 1,
    },
  },
  cold_start_with_photo: {
    input: {
      goals: ['brightening'],
      userId: null,
      profile: {},
      recentLogs: [],
      currentRoutine: 'none',
      travelPlans: [],
      hasPhoto: true,
      photoFindings: { t_zone_redness: 'mild', overall_tone: 'uneven' },
    },
    expectedOutput: {
      is_cold_start: true,
      data_quality_overall: 'low',
      max_confidence: 0.6,
      strategies_conservative: true,
    },
  },
  no_photo_with_checkin_logs: {
    input: {
      goals: ['anti_aging_face', 'barrier_repair'],
      userId: 'user_123',
      profile: { skinType: 'combination', sensitivity: 'medium', barrierStatus: 'impaired' },
      recentLogs: [{ date: '2026-03-01', redness: 'moderate', acne: 'low', dryness: 'high' }],
      currentRoutine: 'basic',
      travelPlans: [],
      hasPhoto: false,
    },
    expectedOutput: {
      is_cold_start: false,
      question_strategy: 'default',
      next_actions_min_count: 1,
      axes_must_have_evidence: true,
    },
  },
  travel_active: {
    input: {
      goals: ['daily_maintenance'],
      userId: 'user_456',
      profile: { skinType: 'dry', sensitivity: 'low' },
      recentLogs: [{ date: '2026-03-05', redness: 'low', acne: 'none', dryness: 'moderate' }],
      currentRoutine: 'full',
      travelPlans: [{ trip_id: 't1', destination: 'Thailand', start_date: '2026-03-10', end_date: '2026-03-20' }],
      hasPhoto: true,
    },
    expectedOutput: {
      must_include_travel_adjustment: true,
      blueprint_must_include: ['sunscreen', 'moisturizer'],
    },
  },
  post_procedure_repair: {
    input: {
      goals: ['post_procedure_repair'],
      userId: 'user_789',
      profile: {},
      recentLogs: [],
      currentRoutine: 'none',
      travelPlans: [],
      hasPhoto: false,
    },
    expectedOutput: {
      must_ask_days_since: true,
      must_ask_skin_broken: true,
      strategies_conservative: true,
    },
  },
  repeat_diagnosis_with_history: {
    input: {
      goals: ['anti_aging_face'],
      userId: 'user_repeat',
      profile: { skinType: 'combination', sensitivity: 'medium' },
      recentLogs: [{ date: '2026-03-04', redness: 'low', acne: 'none', dryness: 'low' }],
      currentRoutine: 'full',
      travelPlans: [],
      hasPhoto: true,
      previousDiagnoses: [
        {
          diagnosis_id: 'prev_001',
          date: '2026-02-20',
          goals: ['anti_aging_face'],
          inferred_axes_summary: [
            { axis: 'barrier_irritation_risk', level: 'high', confidence: 0.7 },
            { axis: 'photoaging_risk', level: 'moderate', confidence: 0.6 },
          ],
          data_quality: 'medium',
        },
      ],
    },
    expectedOutput: {
      axes_must_have_trend: true,
      axes_must_have_previous_level: true,
      diagnosis_seq_min: 2,
    },
  },
  eye_anti_aging: {
    input: {
      goals: ['eye_anti_aging'],
      userId: 'user_eye',
      profile: { sensitivity: 'high' },
      recentLogs: [],
      currentRoutine: 'basic',
      travelPlans: [],
      hasPhoto: false,
    },
    expectedOutput: {
      blueprint_must_include: ['eye_care'],
      strategies_no_strong_irritants: true,
    },
  },
};

module.exports = { fixtures };
