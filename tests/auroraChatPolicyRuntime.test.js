const { createChatPolicyRuntime } = require('../src/auroraBff/chatPolicyRuntime');

describe('aurora chat policy runtime', () => {
  test('createPolicyState seeds policy meta from rollout and flags', () => {
    const runtime = createChatPolicyRuntime({
      resolveGateDecision: jest.fn(),
      AURORA_CHAT_POLICY_VERSION: 'policy_v1',
      AURORA_GATE_POLICY_META_VERSION: 'gate_v1',
    });

    const state = runtime.createPolicyState({
      rolloutContext: {
        policy_version: 'rollout_v2',
        variant: 'beta',
        bucket: 17,
        bucket_key_source: 'aurora_uid',
        forced_variant: 'forced',
        applied: true,
        build_sha: 'sha_123',
      },
      effectiveChatFlags: {
        profile_v2: true,
        qa_planner_v1: false,
        safety_engine_v1: true,
        travel_weather_live_v1: true,
        loop_breaker_v2: false,
        chat_response_meta: true,
      },
      INTENT_ENUM: { UNKNOWN: 'unknown_intent' },
    });

    expect(state.policyMeta).toEqual(
      expect.objectContaining({
        intent_canonical: 'unknown_intent',
        policy_version: 'rollout_v2',
        rollout_variant: 'beta',
        rollout_bucket: 17,
        rollout_bucket_key_source: 'aurora_uid',
        rollout_forced_variant: 'forced',
        rollout_applied: true,
        build_sha: 'sha_123',
        gate_policy_version: 'gate_v1',
        advisory_count: 0,
        gate_decisions: [],
        degraded: false,
        flags_effective: {
          profile_v2: true,
          qa_planner_v1: false,
          safety_engine_v1: true,
          travel_weather_live_v1: true,
          loop_breaker_v2: false,
          chat_response_meta: true,
        },
      }),
    );
  });

  test('pushGateDecision records non-bypass decisions and syncs advisory count', () => {
    const resolveGateDecision = jest
      .fn()
      .mockReturnValueOnce({
        gate_id: 'diag_gate',
        mode: 'advisory',
        reason_codes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      })
      .mockReturnValueOnce({
        gate_id: 'soft_gate',
        mode: 'soft',
        reason_codes: ['soft_reason'],
      })
      .mockReturnValueOnce({
        gate_id: 'noop_gate',
        mode: 'bypass',
        reason_codes: ['ignored'],
      });
    const runtime = createChatPolicyRuntime({
      resolveGateDecision,
      GATE_MODE: {
        ADVISORY: 'advisory',
        BYPASS: 'bypass',
      },
    });

    const state = runtime.createPolicyState();
    expect(state.pushGateDecision('diagnosis_first_profile_gate', { reason_codes: ['diagnosis_first'] })).toEqual({
      gate_id: 'diag_gate',
      mode: 'advisory',
      reason_codes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
    expect(state.pushGateDecision('fit_check_anchor_gate')).toEqual({
      gate_id: 'soft_gate',
      mode: 'soft',
      reason_codes: ['soft_reason'],
    });
    expect(state.pushGateDecision('noop_gate')).toEqual({
      gate_id: 'noop_gate',
      mode: 'bypass',
      reason_codes: ['ignored'],
    });

    state.syncGatePolicyMeta();

    expect(resolveGateDecision).toHaveBeenNthCalledWith(
      1,
      { source: 'chat' },
      'diagnosis_first_profile_gate',
      { reason_codes: ['diagnosis_first'] },
    );
    expect(state.policyMeta.advisory_count).toBe(1);
    expect(state.policyMeta.gate_decisions).toEqual([
      {
        gate_id: 'diag_gate',
        mode: 'advisory',
        reason_codes: ['a', 'b', 'c', 'd', 'e', 'f'],
      },
      {
        gate_id: 'soft_gate',
        mode: 'soft',
        reason_codes: ['soft_reason'],
      },
    ]);
  });

  test('refreshPolicyMetaRollout updates rollout fields and effective flags', () => {
    const runtime = createChatPolicyRuntime({
      resolveGateDecision: jest.fn(),
      AURORA_CHAT_POLICY_VERSION: 'policy_v1',
    });
    const state = runtime.createPolicyState({
      rolloutContext: {
        policy_version: 'rollout_v1',
        variant: 'legacy',
        bucket: 3,
        build_sha: 'sha_old',
      },
      effectiveChatFlags: {
        profile_v2: false,
        chat_response_meta: false,
      },
    });

    state.refreshPolicyMetaRollout({
      rolloutContext: {
        policy_version: 'rollout_v2',
        variant: 'beta',
        bucket: 9,
        bucket_key_source: 'request_id',
        forced_variant: 'force_beta',
        applied: true,
        build_sha: 'sha_new',
      },
      effectiveChatFlags: {
        profile_v2: true,
        qa_planner_v1: true,
        safety_engine_v1: true,
        travel_weather_live_v1: false,
        loop_breaker_v2: true,
        chat_response_meta: true,
      },
    });

    expect(state.policyMeta).toEqual(
      expect.objectContaining({
        policy_version: 'rollout_v2',
        rollout_variant: 'beta',
        rollout_bucket: 9,
        rollout_bucket_key_source: 'request_id',
        rollout_forced_variant: 'force_beta',
        rollout_applied: true,
        build_sha: 'sha_new',
        flags_effective: {
          profile_v2: true,
          qa_planner_v1: true,
          safety_engine_v1: true,
          travel_weather_live_v1: false,
          loop_breaker_v2: true,
          chat_response_meta: true,
        },
      }),
    );
  });
});
