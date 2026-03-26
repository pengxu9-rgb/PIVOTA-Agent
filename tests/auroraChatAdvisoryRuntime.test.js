const { createChatAdvisoryRuntime } = require('../src/auroraBff/chatAdvisoryRuntime');

function buildRuntime(overrides = {}) {
  return createChatAdvisoryRuntime({
    logger: { warn: jest.fn() },
    isPlainObject: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    OPTIONAL_SAFETY_PROFILE_FIELDS: ['pregnancy_status', 'age_band', 'high_risk_medications'],
    normalizeSafetyPromptStateForChat: jest.fn((value) => ({
      asked_once_fields:
        value && value.asked_once_fields && typeof value.asked_once_fields === 'object'
          ? { ...value.asked_once_fields }
          : {},
      asked_at_ms: value && value.asked_at_ms ? value.asked_at_ms : null,
    })),
    upsertProfileForIdentity: jest.fn(async (_identity, patch) => ({
      id: 'profile_saved_1',
      ...patch,
    })),
    ...overrides,
  });
}

describe('aurora chat advisory runtime', () => {
  test('mergePendingSafetyAdvisory dedupes merged fields and preserves existing chips', () => {
    const runtime = buildRuntime();
    const merged = runtime.mergePendingSafetyAdvisory({
      pendingSafetyAdvisory: {
        reason: 'safety_optional_profile_missing',
        details: ['detail A'],
        assumptions: ['age unknown'],
        actions: ['update_optional_profile'],
        chips: [{ chip_id: 'chip_existing' }],
        missing_optional_fields: ['pregnancy_status'],
        reason_codes: ['warn_a'],
      },
      incoming: {
        details: ['detail A', 'detail B'],
        assumptions: ['age unknown', 'pregnancy unknown'],
        actions: ['update_optional_profile', 'continue_conservative_mode'],
        chips: [{ chip_id: 'chip_new' }],
        missing_optional_fields: ['pregnancy_status', 'age_band'],
        reason_codes: ['warn_a', 'warn_b'],
      },
    });

    expect(merged.details).toEqual(['detail A', 'detail B']);
    expect(merged.assumptions).toEqual(['age unknown', 'pregnancy unknown']);
    expect(merged.actions).toEqual(['update_optional_profile', 'continue_conservative_mode']);
    expect(merged.chips).toEqual([{ chip_id: 'chip_existing' }]);
    expect(merged.missing_optional_fields).toEqual(['pregnancy_status', 'age_band']);
    expect(merged.reason_codes).toEqual(['warn_a', 'warn_b']);
  });

  test('persistSafetyPromptAskedOnce filters optional fields and persists updated state', async () => {
    const upsertProfileForIdentity = jest.fn(async (_identity, patch) => ({
      saved: true,
      ...patch,
    }));
    const runtime = buildRuntime({ upsertProfileForIdentity });

    const result = await runtime.persistSafetyPromptAskedOnce({
      fields: ['pregnancy_status', 'ignored_field', 'age_band'],
      profile: { skinType: 'oily', safetyPromptState: { asked_once_fields: { pregnancy_status: true } } },
      identity: { auroraUid: 'aurora_uid_1', userId: 'user_1' },
    });

    expect(result).toEqual({
      saved: true,
      safetyPromptState: {
        asked_once_fields: {
          pregnancy_status: true,
          age_band: true,
        },
        asked_at_ms: expect.any(Number),
      },
    });
    expect(upsertProfileForIdentity).toHaveBeenCalledWith(
      { auroraUid: 'aurora_uid_1', userId: 'user_1' },
      {
        safetyPromptState: {
          asked_once_fields: {
            pregnancy_status: true,
            age_band: true,
          },
          asked_at_ms: expect.any(Number),
        },
      },
    );
  });

  test('applyPendingSafetyAdvisoryToEnvelope annotates session meta and emits inline event', () => {
    const runtime = buildRuntime();

    const envelope = runtime.applyPendingSafetyAdvisoryToEnvelope({
      envelope: { session_patch: { meta: { existing: true } }, events: [] },
      pendingSafetyAdvisory: {
        reason: 'safety_optional_profile_missing',
        missing_optional_fields: ['pregnancy_status'],
        required_question: 'Please confirm pregnancy status.',
      },
      ctx: { request_id: 'req_chat_advisory_1' },
    });

    expect(envelope.session_patch.meta).toEqual({
      existing: true,
      safety_gate_mode: 'advisory_only_v1',
      safety_advisory_emitted: true,
      safety_missing_optional_fields: ['pregnancy_status'],
      passive_gate_suppressed: true,
      suppressed_gate_ids: ['safety_optional_profile_missing'],
    });
    expect(envelope.events).toEqual([
      {
        event_name: 'safety_advisory_inline',
        event_data: {
          reason: 'safety_optional_profile_missing',
          missing_fields: ['pregnancy_status'],
          question: 'Please confirm pregnancy status.',
        },
      },
    ]);
  });

  test('enqueueGateAdvisory merges duplicate gates and applyPendingGateAdvisoriesToEnvelope emits one event', () => {
    const runtime = buildRuntime();
    const pendingGateAdvisories = [];

    runtime.enqueueGateAdvisory({
      pendingGateAdvisories,
      gate_id: 'fit_check_anchor_gate',
      message: 'Please provide a product anchor.',
      reason_codes: ['anchor_missing'],
      actions: ['provide_anchor'],
      chips: [{ chip_id: 'chip_anchor' }],
    });
    runtime.enqueueGateAdvisory({
      pendingGateAdvisories,
      gate_id: 'fit_check_anchor_gate',
      message: '',
      reason_codes: ['anchor_missing', 'anchor_ambiguous'],
      actions: ['provide_anchor', 'use_product_name'],
      chips: [{ chip_id: 'chip_should_not_replace' }],
    });

    expect(pendingGateAdvisories).toEqual([
      {
        gate_id: 'fit_check_anchor_gate',
        message: 'Please provide a product anchor.',
        reason_codes: ['anchor_missing', 'anchor_ambiguous'],
        actions: ['provide_anchor', 'use_product_name'],
        chips: [{ chip_id: 'chip_anchor' }],
      },
    ]);

    const envelope = runtime.applyPendingGateAdvisoriesToEnvelope({
      envelope: { session_patch: { meta: { existing: true } }, events: [] },
      pendingGateAdvisories,
      ctx: { request_id: 'req_gate_advisory_1' },
    });

    expect(envelope.session_patch.meta).toEqual({
      existing: true,
      passive_gate_suppressed: true,
      suppressed_gate_ids: ['fit_check_anchor_gate'],
    });
    expect(envelope.events).toEqual([
      {
        event_name: 'gate_advisory_inline',
        event_data: {
          gate_id: 'fit_check_anchor_gate',
          reason_codes: ['anchor_missing', 'anchor_ambiguous'],
          actions: ['provide_anchor', 'use_product_name'],
          suppressed: true,
        },
      },
    ]);
  });

  test('buildSafetyNoticeText renders localized warning copy', () => {
    const runtime = buildRuntime();

    expect(
      runtime.buildSafetyNoticeText({
        safety: {
          block_level: 'warn',
          reasons: ['Retinoid overlap risk'],
          safe_alternatives: ['Use barrier-support serum'],
        },
        language: 'EN',
      }),
    ).toContain('Risk note:');

    expect(
      runtime.buildSafetyNoticeText({
        safety: {
          block_level: 'require_info',
          required_questions: ['Are you pregnant right now?'],
        },
        language: 'CN',
      }),
    ).toContain('继续前我需要一个关键安全信息');
  });

  test('resolveSafetyGateAction returns advisory with ask-once fields when optional safety profile is missing', () => {
    const pushGateDecision = jest.fn(() => ({ mode: 'advisory' }));
    const runtime = buildRuntime({
      buildSafetyAdvisoryChipsByField: jest.fn(() => [{ chip_id: 'chip_safety' }]),
      profileHasOptionalSafetyFieldValue: jest.fn(() => false),
    });

    const result = runtime.resolveSafetyGateAction({
      safety: {
        block_level: 'warn',
        required_fields: ['pregnancy_status'],
        required_questions: ['Are you pregnant right now?'],
        reasons: ['Retinoid overlap risk'],
        safe_alternatives: ['Use barrier-support serum'],
        reason_codes: ['retinoid_overlap'],
      },
      profileValue: {},
      conflictIntent: false,
      language: 'EN',
      pushGateDecision,
    });

    expect(result.mode).toBe('inline');
    expect(result.ask_once_fields).toEqual(['pregnancy_status']);
    expect(result.advisory).toEqual(
      expect.objectContaining({
        reason: 'safety_optional_profile_missing',
        severity: 'warn',
        chips: [{ chip_id: 'chip_safety' }],
        missing_optional_fields: ['pregnancy_status'],
        reason_codes: ['retinoid_overlap'],
      }),
    );
    expect(pushGateDecision).toHaveBeenCalledWith('safety_optional_profile', {
      is_hard_contraindication: false,
      reason_codes: ['retinoid_overlap'],
    });
  });
});
