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
  },
};

module.exports = { fixtures };
