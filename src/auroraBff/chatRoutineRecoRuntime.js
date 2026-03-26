function createChatRoutineRecoRuntime(options = {}) {
  const {
    logger = null,
    generateRoutineReco,
    AURORA_BFF_CHAT_ROUTINE_V2_ENABLED = false,
    withTimeout,
    AURORA_BFF_CHAT_ROUTINE_BUDGET_MS = 0,
    buildBudgetOptimizationEntryChip = () => null,
    stateChangeAllowed = () => false,
    stripInternalRefsDeep = (payload) => payload,
    recordAuroraSkinFlowMetric = () => {},
    chatRecoHandoffRuntime,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat routine reco runtime missing dependency: ${name}`);
  }

  async function resolveRoutineRecoEnvelope({
    ctx,
    profile = null,
    recentLogs = [],
    message = '',
    includeAlternatives = false,
    variant = 'routine_request',
    hasBudget = false,
    appendBudgetOptimizationChip = false,
    debugUpstream = false,
    timeoutDetail = '',
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
  } = {}) {
    const generateRoutineRecoFn = requireFunction('generateRoutineReco', generateRoutineReco);
    const withTimeoutFn = requireFunction('withTimeout', withTimeout);
    const stripInternalRefsDeepFn = requireFunction('stripInternalRefsDeep', stripInternalRefsDeep);
    const stateChangeAllowedFn = requireFunction('stateChangeAllowed', stateChangeAllowed);
    if (
      !chatRecoHandoffRuntime ||
      typeof chatRecoHandoffRuntime.buildRoutineTimeoutDegradedEnvelope !== 'function' ||
      typeof chatRecoHandoffRuntime.buildRoutineRecoEnvelope !== 'function'
    ) {
      throw new Error('aurora chat routine reco runtime missing dependency: chatRecoHandoffRuntime');
    }

    let routineRecoOut = null;
    try {
      const routineRecoPromise = generateRoutineRecoFn({
        ctx,
        profile,
        recentLogs,
        focus: 'daily routine',
        constraints: { simplicity: 'high' },
        includeAlternatives,
        logger,
      });
      routineRecoOut = AURORA_BFF_CHAT_ROUTINE_V2_ENABLED
        ? await withTimeoutFn(
          routineRecoPromise,
          AURORA_BFF_CHAT_ROUTINE_BUDGET_MS,
          'AURORA_CHAT_ROUTINE_BUDGET_TIMEOUT',
        )
        : await routineRecoPromise;
    } catch (err) {
      if (!AURORA_BFF_CHAT_ROUTINE_V2_ENABLED || !(err && err.code === 'AURORA_CHAT_ROUTINE_BUDGET_TIMEOUT')) {
        throw err;
      }
      logger?.warn?.(
        {
          request_id: ctx && ctx.request_id,
          trace_id: ctx && ctx.trace_id,
          budget_ms: AURORA_BFF_CHAT_ROUTINE_BUDGET_MS,
        },
        'aurora bff: routine generation timeout, degraded to confidence_notice',
      );
      logger?.info?.({ kind: 'metric', name: 'aurora.skin.routine.timeout_degraded_rate', value: 1 }, 'metric');
      recordAuroraSkinFlowMetric({ stage: 'routine_timeout_degraded', hit: true });
      return chatRecoHandoffRuntime.buildRoutineTimeoutDegradedEnvelope({
        ctx,
        message,
        profile,
        recentLogs,
        detail: timeoutDetail,
        buildEnvelope,
        makeChatAssistantMessage,
        makeEvent,
      });
    }

    const norm = routineRecoOut && routineRecoOut.norm && typeof routineRecoOut.norm === 'object'
      ? routineRecoOut.norm
      : { payload: {}, field_missing: [] };
    const suggestedChips = Array.isArray(routineRecoOut && routineRecoOut.suggestedChips)
      ? [...routineRecoOut.suggestedChips]
      : [];
    if (appendBudgetOptimizationChip) {
      const chip = buildBudgetOptimizationEntryChip(ctx && ctx.lang);
      if (chip) suggestedChips.push(chip);
    }

    const hasRecs = Array.isArray(norm.payload && norm.payload.recommendations) && norm.payload.recommendations.length > 0;
    const nextState =
      hasRecs && stateChangeAllowedFn(ctx && ctx.trigger_source)
        ? 'S7_PRODUCT_RECO'
        : undefined;
    const payload =
      debugUpstream
        ? norm.payload
        : stripInternalRefsDeepFn(norm.payload);

    return chatRecoHandoffRuntime.buildRoutineRecoEnvelope({
      ctx,
      variant,
      hasBudget,
      suggestedChips,
      payload,
      fieldMissing: norm.field_missing,
      nextState,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    });
  }

  return {
    resolveRoutineRecoEnvelope,
  };
}

module.exports = { createChatRoutineRecoRuntime };
