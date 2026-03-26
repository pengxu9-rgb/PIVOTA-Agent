function createChatRecoHandoffRuntime(options = {}) {
  const {
    buildConfidenceNoticeCardPayload,
    buildIngredientPlanCard,
    buildRulesOnlyRoutineExpertFromContext,
    appendLatestArtifactToSessionPatch,
    appendLatestRecoContextToSessionPatch,
    buildRecoLlmTraceRef,
    normalizeRecoSourceDetail = (value) => value,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat reco handoff runtime missing dependency: ${name}`);
  }

  function buildRoutineTimeoutDegradedEnvelope({
    ctx,
    message = '',
    profile = null,
    recentLogs = [],
    detail,
    upstreamFailureCode,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
  } = {}) {
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const buildConfidenceNoticeCardPayloadFn = requireFunction(
      'buildConfidenceNoticeCardPayload',
      buildConfidenceNoticeCardPayload,
    );
    const buildRulesOnlyRoutineExpertFromContextFn = requireFunction(
      'buildRulesOnlyRoutineExpertFromContext',
      buildRulesOnlyRoutineExpertFromContext,
    );

    const lang = ctx && ctx.lang === 'CN' ? 'CN' : 'EN';
    const detailText =
      typeof detail === 'string' && detail.trim()
        ? detail.trim()
        : lang === 'CN'
          ? 'routine 生成阶段超时，已切换保守降级路径。'
          : 'Routine generation timed out, so it was switched to a conservative degraded path.';
    const upstreamCode = String(upstreamFailureCode || '').trim();
    const detailCodeText =
      upstreamCode
        ? lang === 'CN'
          ? `上游代码：${upstreamCode.slice(0, 64)}`
          : `Upstream code: ${upstreamCode.slice(0, 64)}`
        : null;
    const chips = [
      {
        chip_id: 'chip.intake.paste_routine',
        label: lang === 'CN' ? '继续填写 AM/PM' : 'Continue routine intake',
        kind: 'quick_reply',
        data: {
          reply_text: lang === 'CN' ? '继续填写我的 AM/PM 护肤流程' : 'Continue filling my AM/PM routine',
        },
      },
      {
        chip_id: 'chip.start.routine',
        label: lang === 'CN' ? '重试生成 routine' : 'Retry routine generation',
        kind: 'quick_reply',
        data: {
          reply_text: lang === 'CN' ? '重试生成 AM/PM 护肤 routine' : 'Retry generating an AM/PM routine',
        },
      },
    ];
    const rulesOnlyExpert = buildRulesOnlyRoutineExpertFromContextFn({
      message,
      profile,
      recentLogs,
      language: ctx && ctx.lang,
    });

    return buildEnvelopeFn(ctx, {
      assistant_message: makeChatAssistantMessageFn(
        lang === 'CN'
          ? 'routine 生成暂时超时。我已切到保守降级，不返回空卡；你可以继续补充当前流程，或直接重试。'
          : 'Routine generation timed out. I switched to a conservative degraded path without returning empty cards; continue intake or retry directly.',
      ),
      suggested_chips: chips,
      cards: [
        {
          card_id: `analysis_${ctx.request_id}`,
          type: 'analysis_summary',
          payload: {
            analysis_source: 'rules_only_timeout_degraded',
            low_confidence: true,
            analysis: {
              routine_expert: rulesOnlyExpert,
            },
          },
        },
        {
          card_id: `conf_${ctx.request_id}`,
          type: 'confidence_notice',
          payload: buildConfidenceNoticeCardPayloadFn({
            language: ctx && ctx.lang,
            reason: 'timeout_degraded',
            confidence: { score: 0.38, level: 'low', rationale: ['routine_budget_timeout'] },
            actions: ['update_current_routine', 'retry_recommendations'],
            details: [detailText, ...(detailCodeText ? [detailCodeText] : [])],
          }),
        },
      ],
      session_patch: {},
      events: [
        makeEventFn(ctx, 'recos_requested', {
          explicit: true,
          gated: true,
          reason: 'timeout_degraded',
          source: 'upstream_timeout',
          route: 'routine',
          ...(detailCodeText ? { upstream_failure_code: upstreamCode.slice(0, 64) } : {}),
        }),
      ],
    });
  }

  function buildRoutineRecoEnvelope({
    ctx,
    variant = 'routine_request',
    hasBudget = false,
    suggestedChips = [],
    payload,
    fieldMissing = [],
    nextState,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
  } = {}) {
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);

    let assistantText = '';
    if (variant === 'budget_flow') {
      assistantText =
        ctx && ctx.lang === 'CN'
          ? '已收到预算信息。我生成了一个简洁 AM/PM routine（见下方卡片）。'
          : 'Got it. I generated a simple AM/PM routine (see the card below).';
    } else if (!hasBudget) {
      assistantText =
        ctx && ctx.lang === 'CN'
          ? '我先按“功效与耐受优先”生成了一个简洁 AM/PM routine（见下方卡片）。如果你愿意，我可以再按预算优化一版。'
          : 'I generated a simple AM/PM routine first (efficacy + tolerance prioritized). If you want, I can optimize it by budget next.';
    } else {
      assistantText =
        ctx && ctx.lang === 'CN'
          ? '我生成了一个简洁 AM/PM routine（见下方卡片）。'
          : 'I generated a simple AM/PM routine (see the card below).';
    }

    return buildEnvelopeFn(ctx, {
      assistant_message: makeChatAssistantMessageFn(assistantText),
      suggested_chips: Array.isArray(suggestedChips) ? suggestedChips : [],
      cards: [
        {
          card_id: `reco_${ctx.request_id}`,
          type: 'recommendations',
          payload,
          ...(Array.isArray(fieldMissing) && fieldMissing.length ? { field_missing: fieldMissing.slice(0, 8) } : {}),
        },
      ],
      session_patch: nextState ? { next_state: nextState } : {},
      events: [
        makeEventFn(ctx, 'value_moment', { kind: 'routine_generated' }),
        makeEventFn(ctx, 'recos_requested', { explicit: true }),
      ],
    });
  }

  function buildRecoTimeoutDegradedEnvelope({
    ctx,
    latestArtifactId = null,
    recoEntrySourceDetail = '',
    triggerSource = '',
    actionId = '',
    message = '',
    includeAlternatives = false,
    ingredientQuery = '',
    goal = '',
    mappedIngredientPlan = null,
    refinementChips = [],
    recoLlmTrace = null,
    upstreamFailureCode = '',
    shouldAutoRerunRecommendationsFromProfilePatch = false,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
  } = {}) {
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const buildConfidenceNoticeCardPayloadFn = requireFunction(
      'buildConfidenceNoticeCardPayload',
      buildConfidenceNoticeCardPayload,
    );
    const appendLatestArtifactToSessionPatchFn = requireFunction(
      'appendLatestArtifactToSessionPatch',
      appendLatestArtifactToSessionPatch,
    );
    const appendLatestRecoContextToSessionPatchFn = requireFunction(
      'appendLatestRecoContextToSessionPatch',
      appendLatestRecoContextToSessionPatch,
    );
    const buildRecoLlmTraceRefFn = requireFunction('buildRecoLlmTraceRef', buildRecoLlmTraceRef);
    const buildIngredientPlanCardFn = requireFunction('buildIngredientPlanCard', buildIngredientPlanCard);

    const llmTraceRef = buildRecoLlmTraceRefFn(recoLlmTrace);
    const confNode =
      recoLlmTrace &&
      recoLlmTrace.overall_confidence &&
      typeof recoLlmTrace.overall_confidence === 'object'
        ? recoLlmTrace.overall_confidence
        : { score: 0.45, level: 'low', rationale: ['reco_budget_timeout'] };

    const cards = [
      {
        card_id: `conf_${ctx.request_id}`,
        type: 'confidence_notice',
        payload: {
          ...buildConfidenceNoticeCardPayloadFn({
            language: ctx && ctx.lang,
            reason: 'artifact_missing',
            confidence: confNode,
            actions: ['retry_recommendations', 'upload_daylight_and_indoor_white', 'update_current_routine'],
            details: [
              ctx && ctx.lang === 'CN'
                ? '推荐阶段超时，已切换保守降级输出。'
                : 'Recommendation stage timed out; switched to conservative degraded output.',
            ],
          }),
          ...(recoLlmTrace ? { llm_trace: recoLlmTrace } : {}),
        },
      },
    ];
    if (mappedIngredientPlan) {
      cards.push(buildIngredientPlanCardFn(mappedIngredientPlan, ctx.request_id));
    }

    const sessionPatch = {};
    appendLatestArtifactToSessionPatchFn(sessionPatch, latestArtifactId);
    appendLatestRecoContextToSessionPatchFn(sessionPatch, {
      intent: 'reco_products',
      source_detail: recoEntrySourceDetail,
      trigger_source: triggerSource,
      action_id: actionId || '',
      message: String(message || '').trim(),
      include_alternatives: includeAlternatives === true,
      ingredient_query: ingredientQuery || '',
      goal: goal || '',
    });

    return buildEnvelopeFn(ctx, {
      assistant_message: makeChatAssistantMessageFn(
        ctx && ctx.lang === 'CN'
          ? '推荐阶段暂时超时了。我先保守降级，不返回商品卡；你可以稍后重试，或补充照片与当前护肤流程后再继续。'
          : "The recommendation step timed out. I’m degrading safely for now without returning product cards; retry shortly, or add photos/current routine and continue.",
      ),
      suggested_chips: Array.isArray(refinementChips) ? refinementChips : [],
      cards,
      session_patch: sessionPatch,
      events: [
        makeEventFn(ctx, 'reco_timeout_degraded', {
          source: 'upstream_timeout',
          ...(upstreamFailureCode ? { upstream_failure_code: upstreamFailureCode } : {}),
          failure_class: 'timeout',
          ...(llmTraceRef ? { llm_trace_ref: llmTraceRef } : {}),
        }),
        makeEventFn(ctx, 'recos_requested', {
          explicit: true,
          gated: true,
          reason: 'artifact_missing',
          telemetry_reason: 'timeout_degraded',
          source: 'upstream_timeout',
          source_mode: 'rules_only',
          grounding_status: 'ungrounded',
          grounded_count: 0,
          ungrounded_count: 0,
          mainline_status: 'upstream_timeout',
          source_detail: normalizeRecoSourceDetail(recoEntrySourceDetail),
          recompute_from_profile_update: shouldAutoRerunRecommendationsFromProfilePatch === true,
          ...(upstreamFailureCode ? { upstream_failure_code: upstreamFailureCode } : {}),
          failure_class: 'timeout',
          ...(llmTraceRef ? { llm_trace_ref: llmTraceRef } : {}),
        }),
      ],
    });
  }

  return {
    buildRoutineTimeoutDegradedEnvelope,
    buildRoutineRecoEnvelope,
    buildRecoTimeoutDegradedEnvelope,
  };
}

module.exports = {
  createChatRecoHandoffRuntime,
};
