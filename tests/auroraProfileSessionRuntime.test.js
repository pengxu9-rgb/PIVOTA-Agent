const { UserProfilePatchSchema } = require('../src/auroraBff/schemas');
const { createProfileSessionRuntime } = require('../src/auroraBff/profileSessionRuntime');

function buildRuntime(overrides = {}) {
  return createProfileSessionRuntime({
    isPlainObject: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    tryParseRoutineObject: (value) => {
      if (value == null) return null;
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    },
    UserProfilePatchSchema,
    inferGoalFromClarificationText: (text) => {
      const raw = String(text || '').toLowerCase();
      if (raw.includes('hydration') || raw.includes('补水')) return 'hydration';
      if (raw.includes('acne') || raw.includes('痘')) return 'acne';
      return '';
    },
    resolvePreferredLegacyTravelPlan: (profile) => {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
      return profile.travel_plan || profile.travelPlan || null;
    },
    INTENT_ENUM: {
      TRAVEL_PLANNING: 'travel_planning',
      WEATHER_ENV: 'weather_env',
    },
    profileV2EnabledDefault: true,
    ...overrides,
  });
}

describe('createProfileSessionRuntime', () => {
  test('extracts and appends artifact ids', () => {
    const runtime = buildRuntime();

    expect(
      runtime.extractLatestArtifactIdFromSession({
        state: { latest_artifact_id: ' art_123 ' },
      }),
    ).toBe('art_123');

    const patch = {};
    runtime.appendLatestArtifactToSessionPatch(patch, ' art_456 ');
    expect(patch).toEqual({
      state: { latest_artifact_id: 'art_456' },
    });
  });

  test('sanitizes reco context when reading and writing session state', () => {
    const runtime = buildRuntime();
    const session = {
      state: {
        latest_reco_context: {
          message: 'x'.repeat(300),
          action_id: ' act_1 ',
          source_detail: 'unknown_source',
          intent: ' RECO_PRODUCTS ',
          trigger_source: ' Chat ',
          ingredient_query: ' niacinamide ',
          goal: ' calm redness ',
          include_alternatives: true,
        },
      },
    };

    expect(runtime.extractLatestRecoContextFromSession(session)).toEqual({
      message: 'x'.repeat(240),
      action_id: 'act_1',
      source_detail: 'goal_driven',
      intent: 'reco_products',
      trigger_source: 'chat',
      ingredient_query: 'niacinamide',
      goal: 'calm redness',
      created_at_ms: expect.any(Number),
      include_alternatives: true,
    });

    const patch = {};
    runtime.appendLatestRecoContextToSessionPatch(patch, {
      sourceDetail: 'ingredient_driven',
      intent: 'reco_products',
      triggerSource: 'chat',
      message: 'Need gentle options',
    });
    expect(patch).toEqual({
      state: {
        latest_reco_context: {
          source_detail: 'ingredient_driven',
          intent: 'reco_products',
          trigger_source: 'chat',
          message: 'Need gentle options',
          created_at_ms: expect.any(Number),
          include_alternatives: false,
        },
      },
    });
  });

  test('extracts profile patch from session and merges routine-derived fields', () => {
    const runtime = buildRuntime();

    expect(
      runtime.extractProfilePatchFromSession({
        profile: {
          skin_type: 'oily',
          pregnancy_status: 'unknown',
          currentRoutine: {
            profile: {
              barrierState: 'impaired',
              selectedGoals: ['hydration'],
            },
          },
        },
      }),
    ).toEqual({
      skinType: 'oily',
      barrierStatus: 'impaired',
      goals: ['hydration'],
      currentRoutine: {
        profile: {
          barrierState: 'impaired',
          selectedGoals: ['hydration'],
        },
      },
    });
  });

  test('extracts profile patch from free text and routine payloads', () => {
    const runtime = buildRuntime();

    expect(
      runtime.extractProfilePatchFromRoutinePayload(
        JSON.stringify({
          profile: {
            skin_type: 'dry',
            sensitivity_level: 'high',
            selectedGoals: ['hydration'],
          },
        }),
      ),
    ).toEqual({
      skinType: 'dry',
      sensitivity: 'high',
      goals: ['hydration'],
    });

    expect(
      runtime.extractProfilePatchFromFreeText({
        message: 'I am breastfeeding, have oily skin, need hydration, and traveling next week to Tokyo. Current routine: cleanser + serum + SPF',
        canonicalIntent: {
          intent: 'travel_planning',
          entities: {
            destination: 'Tokyo',
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        lactation_status: 'lactating',
        skinType: 'oily',
        goals: ['hydration'],
        currentRoutine: ': cleanser + serum + SPF',
        travel_plan: {
          destination: 'Tokyo',
          time_window: 'next_week',
        },
      }),
    );
  });

  test('derives pregnancy policy patch and summarizes profile context', () => {
    const runtime = buildRuntime();

    expect(
      runtime.derivePregnancyPolicyPatch({
        profile: {
          pregnancy_status: 'pregnant',
          pregnancy_due_date: '2020-01-01',
        },
        todayUtc: '2026-03-23',
      }),
    ).toEqual({
      patch: {
        pregnancy_status: 'not_pregnant',
        pregnancy_due_date: null,
      },
      events: [
        {
          event_name: 'pregnancy_status_auto_reset',
          data: {
            from: 'pregnant',
            to: 'not_pregnant',
            effective_date_utc: '2026-03-23',
          },
        },
      ],
    });

    expect(runtime.profileHasOptionalSafetyFieldValue({ pregnancy_status: 'unknown' }, 'pregnancy_status')).toBe(false);
    expect(runtime.profileHasOptionalSafetyFieldValue({ high_risk_medications: [] }, 'high_risk_medications')).toBe(true);

    expect(
      runtime.summarizeProfileForContext({
        skinType: 'combination',
        sensitivity: 'medium',
        barrierStatus: 'healthy',
        goals: ['hydration'],
        currentRoutine: { am: ['cleanser', 'spf'] },
        itinerary: { climate: 'dry' },
        contraindications: ['fragrance'],
        age_band: '25_34',
        pregnancy_status: 'not_pregnant',
        pregnancy_due_date: '2030-01-02',
        lactation_status: 'unknown',
        high_risk_medications: ['isotretinoin'],
        travel_plan: {
          destination: 'Tokyo',
          start_date: '2030-01-01',
          end_date: '2030-01-05',
          time_window: 'next_week',
          indoor_outdoor_ratio: 0.75,
        },
      }),
    ).toEqual(
      expect.objectContaining({
        skinType: 'combination',
        sensitivity: 'medium',
        barrierStatus: 'healthy',
        goals: ['hydration'],
        contraindications: ['fragrance'],
        age_band: '25_34',
        pregnancy_status: 'not_pregnant',
        pregnancy_due_date: '2030-01-02',
        high_risk_medications: ['isotretinoin'],
        travel_plan: {
          destination: 'Tokyo',
          start_date: '2030-01-01',
          end_date: '2030-01-05',
          time_window: 'next_week',
          indoor_outdoor_ratio: 0.75,
        },
      }),
    );
  });

  test('loads identity profile snapshot and degrades when log fetch fails', async () => {
    const resolveIdentity = jest.fn(async () => ({
      auroraUid: 'uid_1',
      userId: 'user_1',
    }));
    const getProfileForIdentity = jest.fn(async () => ({
      skinType: 'oily',
    }));
    const getRecentSkinLogsForIdentity = jest.fn(async () => {
      throw new Error('db down');
    });
    const isCheckinDue = jest.fn(() => true);
    const runtime = buildRuntime({
      resolveIdentity,
      getProfileForIdentity,
      getRecentSkinLogsForIdentity,
      isCheckinDue,
    });

    const snapshot = await runtime.loadIdentityProfileSnapshot({}, { request_id: 'req_1' });

    expect(resolveIdentity).toHaveBeenCalled();
    expect(snapshot).toEqual({
      identity: { auroraUid: 'uid_1', userId: 'user_1' },
      profile: { skinType: 'oily' },
      recentLogs: [],
      dbError: expect.any(Error),
      isReturning: true,
      checkinDue: true,
    });
  });

  test('parses profile update body with routine-derived patch before explicit fields', () => {
    const runtime = buildRuntime();

    const parsed = runtime.parseProfileUpdateBody({
      currentRoutine: {
        profile: {
          skin_type: 'dry',
          selectedGoals: ['hydration'],
        },
      },
      sensitivity: 'high',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(
      expect.objectContaining({
        skinType: 'dry',
        sensitivity: 'high',
        goals: ['hydration'],
      }),
    );
  });

  test('deletes profile and runs hard-case cleanup with logger propagation', async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
    };
    const resolveIdentity = jest.fn(async () => ({
      auroraUid: 'uid_delete_1',
      userId: 'user_delete_1',
    }));
    const deleteIdentityData = jest.fn(async () => ({ ok: true, deleted: true }));
    const deleteHardCasesForIdentity = jest.fn(async () => ({ deleted: 2 }));
    const runtime = buildRuntime({
      logger,
      resolveIdentity,
      deleteIdentityData,
      deleteHardCasesForIdentity,
    });

    const result = await runtime.deleteProfileForIdentity({}, { request_id: 'req_delete_1' });

    expect(deleteIdentityData).toHaveBeenCalledWith({
      auroraUid: 'uid_delete_1',
      userId: 'user_delete_1',
    });
    expect(deleteHardCasesForIdentity).toHaveBeenCalledWith({
      auroraUid: 'uid_delete_1',
      userId: 'user_delete_1',
      logger,
    });
    expect(logger.info).toHaveBeenCalledWith(
      { kind: 'hard_case_delete', request_id: 'req_delete_1', deleted: 2 },
      'hard case sampler: deleted on profile delete',
    );
    expect(result).toEqual({
      identity: { auroraUid: 'uid_delete_1', userId: 'user_delete_1' },
      result: { ok: true, deleted: true },
    });
  });
});
