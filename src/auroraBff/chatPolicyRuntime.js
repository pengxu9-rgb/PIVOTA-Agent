function createChatPolicyRuntime(options = {}) {
  const {
    resolveGateDecision,
    GATE_MODE = {
      ADVISORY: 'advisory',
      BYPASS: 'bypass',
    },
    AURORA_CHAT_POLICY_VERSION = 'legacy',
    AURORA_GATE_POLICY_META_VERSION = 'legacy',
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat policy runtime missing dependency: ${name}`);
  }

  function buildFlagsEffective(effectiveChatFlags = {}) {
    return {
      profile_v2: Boolean(effectiveChatFlags.profile_v2),
      qa_planner_v1: Boolean(effectiveChatFlags.qa_planner_v1),
      safety_engine_v1: Boolean(effectiveChatFlags.safety_engine_v1),
      travel_weather_live_v1: Boolean(effectiveChatFlags.travel_weather_live_v1),
      loop_breaker_v2: Boolean(effectiveChatFlags.loop_breaker_v2),
      chat_response_meta: Boolean(effectiveChatFlags.chat_response_meta),
    };
  }

  function createPolicyState({ rolloutContext = {}, effectiveChatFlags = {}, INTENT_ENUM = { UNKNOWN: 'unknown' } } = {}) {
    const resolveGateDecisionFn = requireFunction('resolveGateDecision', resolveGateDecision);
    const gateDecisions = [];
    let advisoryCount = 0;
    const policyMeta = {
      intent_canonical: INTENT_ENUM.UNKNOWN,
      intent_source: 'none',
      gate_type: 'none',
      loop_count: 0,
      break_applied: 'none',
      env_source: null,
      policy_version: rolloutContext.policy_version || AURORA_CHAT_POLICY_VERSION,
      rollout_variant: rolloutContext.variant || 'legacy',
      rollout_bucket: Number.isFinite(Number(rolloutContext.bucket)) ? Number(rolloutContext.bucket) : null,
      rollout_bucket_key_source: rolloutContext.bucket_key_source || null,
      rollout_forced_variant: rolloutContext.forced_variant || null,
      rollout_applied: Boolean(rolloutContext.applied),
      build_sha: rolloutContext.build_sha || null,
      flags_effective: buildFlagsEffective(effectiveChatFlags),
      gate_policy_version: AURORA_GATE_POLICY_META_VERSION,
      gate_decisions: [],
      advisory_count: 0,
      degraded: false,
    };

    function pushGateDecision(gateId, input = {}) {
      const decision = resolveGateDecisionFn({ source: 'chat' }, gateId, input);
      if (!decision || decision.mode === GATE_MODE.BYPASS) return decision;
      if (decision.mode === GATE_MODE.ADVISORY) advisoryCount += 1;
      gateDecisions.push({
        gate_id: decision.gate_id,
        mode: decision.mode,
        reason_codes: Array.isArray(decision.reason_codes) ? decision.reason_codes.slice(0, 6) : [],
      });
      return decision;
    }

    function syncGatePolicyMeta() {
      policyMeta.gate_policy_version = AURORA_GATE_POLICY_META_VERSION;
      policyMeta.gate_decisions = gateDecisions.slice(0, 24);
      policyMeta.advisory_count = advisoryCount;
      return policyMeta;
    }

    function refreshPolicyMetaRollout({ rolloutContext: nextRolloutContext = {}, effectiveChatFlags: nextEffectiveChatFlags = {} } = {}) {
      policyMeta.policy_version = nextRolloutContext.policy_version || policyMeta.policy_version || AURORA_CHAT_POLICY_VERSION;
      policyMeta.rollout_variant = nextRolloutContext.variant || policyMeta.rollout_variant || 'legacy';
      policyMeta.rollout_bucket = Number.isFinite(Number(nextRolloutContext.bucket))
        ? Number(nextRolloutContext.bucket)
        : policyMeta.rollout_bucket;
      policyMeta.rollout_bucket_key_source =
        nextRolloutContext.bucket_key_source || policyMeta.rollout_bucket_key_source || null;
      policyMeta.rollout_forced_variant = nextRolloutContext.forced_variant || null;
      policyMeta.rollout_applied = Boolean(nextRolloutContext.applied);
      policyMeta.build_sha = nextRolloutContext.build_sha || policyMeta.build_sha || null;
      policyMeta.flags_effective = buildFlagsEffective(nextEffectiveChatFlags);
      return policyMeta;
    }

    return {
      policyMeta,
      pushGateDecision,
      syncGatePolicyMeta,
      refreshPolicyMetaRollout,
    };
  }

  return {
    buildFlagsEffective,
    createPolicyState,
  };
}

module.exports = {
  createChatPolicyRuntime,
};
