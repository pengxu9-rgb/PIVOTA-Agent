function createChatRoutineGateRuntime(options = {}) {
  const {
    logger = null,
    isBudgetOptimizationEntryAction = () => false,
    looksLikeSuitabilityRequest = () => false,
    looksLikeCompatibilityOrConflictQuestion = () => false,
    looksLikeRecommendationRequest = () => false,
    looksLikeRoutineRequest = () => false,
    looksLikeWeatherOrEnvironmentQuestion = () => false,
    buildBudgetGatePrompt = () => '',
    buildBudgetGateChips = () => [],
    normalizeBudgetHint = () => '',
    upsertProfileForIdentity = async (_identity, patch) => patch,
    stateChangeAllowed = () => false,
    chatRoutineRecoRuntime = null,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat routine gate runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  async function resolveRoutineGate(args = {}) {
    const {
      actionId = '',
      allowRecoCards = false,
      ctx = {},
      profile = null,
      appliedProfilePatch = null,
      message = '',
      normalizedActionPayload = null,
      ingredientScienceIntentEffective = false,
      recoInteractionAllowed = false,
      includeAlternatives = false,
      identity = {},
      recentLogs = [],
      debugUpstream = false,
      nextStateOverride = null,
      summarizeChatProfileForContext = () => null,
      pushGateDecision = () => null,
      enqueueGateAdvisory = () => {},
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    } = args;

    const isBudgetOptimizationEntryActionFn = requireFunction(
      'isBudgetOptimizationEntryAction',
      isBudgetOptimizationEntryAction,
    );
    const looksLikeSuitabilityRequestFn = requireFunction(
      'looksLikeSuitabilityRequest',
      looksLikeSuitabilityRequest,
    );
    const looksLikeCompatibilityOrConflictQuestionFn = requireFunction(
      'looksLikeCompatibilityOrConflictQuestion',
      looksLikeCompatibilityOrConflictQuestion,
    );
    const looksLikeRecommendationRequestFn = requireFunction(
      'looksLikeRecommendationRequest',
      looksLikeRecommendationRequest,
    );
    const looksLikeRoutineRequestFn = requireFunction(
      'looksLikeRoutineRequest',
      looksLikeRoutineRequest,
    );
    const looksLikeWeatherOrEnvironmentQuestionFn = requireFunction(
      'looksLikeWeatherOrEnvironmentQuestion',
      looksLikeWeatherOrEnvironmentQuestion,
    );
    const buildBudgetGatePromptFn = requireFunction('buildBudgetGatePrompt', buildBudgetGatePrompt);
    const buildBudgetGateChipsFn = requireFunction('buildBudgetGateChips', buildBudgetGateChips);
    const normalizeBudgetHintFn = requireFunction('normalizeBudgetHint', normalizeBudgetHint);
    const upsertProfileForIdentityFn = requireFunction('upsertProfileForIdentity', upsertProfileForIdentity);
    const stateChangeAllowedFn = requireFunction('stateChangeAllowed', stateChangeAllowed);
    const resolveRoutineRecoEnvelope = requireMethod(
      chatRoutineRecoRuntime,
      'chatRoutineRecoRuntime',
      'resolveRoutineRecoEnvelope',
    );

    let nextProfile = profile;
    let nextState = nextStateOverride;
    let nextCtxState = ctx && ctx.state;
    let policyMetaPatch = null;

    if (isBudgetOptimizationEntryActionFn(actionId) && allowRecoCards) {
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeChatAssistantMessage(buildBudgetGatePromptFn(ctx.lang)),
        suggested_chips: buildBudgetGateChipsFn(ctx.lang),
        cards: [
          {
            card_id: `budget_${ctx.request_id}`,
            type: 'budget_gate',
            payload: { reason: 'budget_optimization_optional', profile: summarizeChatProfileForContext(nextProfile) },
          },
        ],
        session_patch: stateChangeAllowedFn(ctx.trigger_source) ? { next_state: 'S6_BUDGET' } : {},
        events: [makeEvent(ctx, 'state_entered', { next_state: 'S6_BUDGET', reason: 'budget_optimization_optional' })],
      });
      return {
        handled: true,
        envelope,
        profile: nextProfile,
        nextStateOverride: nextState,
        nextCtxState,
        policyMetaPatch,
      };
    }

    if (nextCtxState === 'S6_BUDGET') {
      const rawBudget =
        normalizeBudgetHintFn(appliedProfilePatch && appliedProfilePatch.budgetTier) ||
        normalizeBudgetHintFn(nextProfile && nextProfile.budgetTier) ||
        normalizeBudgetHintFn(message);

      const wantsFitCheck = looksLikeSuitabilityRequestFn(message);
      const wantsCompat = looksLikeCompatibilityOrConflictQuestionFn(message);
      const wantsScience = ingredientScienceIntentEffective;
      const wantsRecoNoRoutine =
        looksLikeRecommendationRequestFn(message) &&
        !looksLikeRoutineRequestFn(message, normalizedActionPayload);
      const wantsEnvStress =
        looksLikeWeatherOrEnvironmentQuestionFn(message) &&
        (ctx.trigger_source === 'text' || ctx.trigger_source === 'text_explicit');

      if (wantsFitCheck || wantsCompat || wantsScience || wantsEnvStress || wantsRecoNoRoutine) {
        if (stateChangeAllowedFn(ctx.trigger_source)) {
          nextState = allowRecoCards ? 'S7_PRODUCT_RECO' : 'idle';
        }
        nextCtxState = nextState || 'idle';
        return {
          handled: false,
          envelope: null,
          profile: nextProfile,
          nextStateOverride: nextState,
          nextCtxState,
          policyMetaPatch,
        };
      }

      if (!allowRecoCards) {
        const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
        const suggestedChips = [
          {
            chip_id: 'chip.start.reco_products',
            label: lang === 'CN' ? '获取产品推荐' : 'Get product recommendations',
            kind: 'quick_reply',
            data: { reply_text: lang === 'CN' ? '给我一些产品推荐' : 'Get product recommendations' },
          },
          {
            chip_id: 'chip.start.routine',
            label: lang === 'CN' ? '生成早晚护肤 routine' : 'Build an AM/PM routine',
            kind: 'quick_reply',
            data: { reply_text: lang === 'CN' ? '生成一套早晚护肤 routine' : 'Build an AM/PM skincare routine' },
          },
        ];
        const decision = pushGateDecision('budget_gate', {
          reason_codes: ['budget_gate_nonblocking'],
        });
        if (decision && decision.mode === 'ADVISORY') {
          enqueueGateAdvisory({
            gate_id: 'budget_gate',
            message:
              lang === 'CN'
                ? '预算信息是可选项，我先继续给你主结果。'
                : 'Budget is optional; I will continue with the primary answer first.',
            reason_codes: ['budget_gate_nonblocking'],
            actions: ['provide_budget_optional'],
            chips: suggestedChips,
          });
          if (stateChangeAllowedFn(ctx.trigger_source)) {
            nextState = 'idle';
          }
          nextCtxState = nextState || 'idle';
        }
      }

      if (!rawBudget) {
        const decision = pushGateDecision('budget_gate', {
          reason_codes: ['budget_optimization_optional'],
        });
        if (decision && decision.mode === 'ADVISORY') {
          enqueueGateAdvisory({
            gate_id: 'budget_gate',
            message: buildBudgetGatePromptFn(ctx.lang),
            reason_codes: ['budget_optimization_optional'],
            actions: ['provide_budget_optional'],
            chips: buildBudgetGateChipsFn(ctx.lang),
          });
          policyMetaPatch = { gate_type: 'soft' };
        }
      }

      if (rawBudget && (!nextProfile || nextProfile.budgetTier !== rawBudget)) {
        nextProfile = { ...(nextProfile || {}), budgetTier: rawBudget };
        try {
          nextProfile = await upsertProfileForIdentityFn(
            { auroraUid: identity.auroraUid, userId: identity.userId },
            { budgetTier: rawBudget },
          );
        } catch (err) {
          logger?.warn?.({ err: err.code || err.message }, 'aurora bff: failed to persist budgetTier');
        }
      }

      const envelope = await resolveRoutineRecoEnvelope({
        ctx,
        profile: nextProfile,
        recentLogs,
        message,
        includeAlternatives,
        variant: 'budget_flow',
        hasBudget: true,
        debugUpstream,
        timeoutDetail:
          ctx.lang === 'CN'
            ? '预算分支 routine 生成超时，建议继续补充 AM/PM 后重试。'
            : 'Routine generation in budget flow timed out; continue AM/PM intake and retry.',
        buildEnvelope,
        makeChatAssistantMessage,
        makeEvent,
      });
      return {
        handled: true,
        envelope,
        profile: nextProfile,
        nextStateOverride: nextState,
        nextCtxState,
        policyMetaPatch,
      };
    }

    if (
      allowRecoCards &&
      looksLikeRoutineRequestFn(message, normalizedActionPayload) &&
      recoInteractionAllowed
    ) {
      const budget = normalizeBudgetHintFn(nextProfile && nextProfile.budgetTier);
      const envelope = await resolveRoutineRecoEnvelope({
        ctx,
        profile: nextProfile,
        recentLogs,
        message,
        includeAlternatives,
        variant: 'routine_request',
        hasBudget: Boolean(budget),
        appendBudgetOptimizationChip: !budget,
        debugUpstream,
        timeoutDetail:
          ctx.lang === 'CN'
            ? 'routine 生成超时，建议继续补充 AM/PM 或直接重试。'
            : 'Routine generation timed out; continue AM/PM intake or retry directly.',
        buildEnvelope,
        makeChatAssistantMessage,
        makeEvent,
      });
      return {
        handled: true,
        envelope,
        profile: nextProfile,
        nextStateOverride: nextState,
        nextCtxState,
        policyMetaPatch,
      };
    }

    return {
      handled: false,
      envelope: null,
      profile: nextProfile,
      nextStateOverride: nextState,
      nextCtxState,
      policyMetaPatch,
    };
  }

  return {
    resolveRoutineGate,
  };
}

module.exports = {
  createChatRoutineGateRuntime,
};
