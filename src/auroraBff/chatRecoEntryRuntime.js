function createChatRecoEntryRuntime(options = {}) {
  const {
    looksLikeRoutineRequest = () => false,
    looksLikeSuitabilityRequest = () => false,
    looksLikeRecommendationRequest = () => false,
    looksLikeCompatibilityOrConflictQuestion = () => false,
    looksLikeWeatherOrEnvironmentQuestion = () => false,
    isBudgetClarificationAction = () => false,
    isBareBudgetSelectionMessage = () => false,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat reco entry runtime missing dependency: ${name}`);
  }

  function prepareRecoEntry(args = {}) {
    const {
      forceUpstreamAfterPendingAbandon = false,
      actionId = '',
      clarificationId = '',
      appliedProfilePatch = null,
      textDerivedProfilePatch = null,
      textDerivedSkinLog = null,
      latestRecoContextFromSession = null,
      allowRecoCards = false,
      message = '',
      normalizedActionPayload = null,
      ingredientRecoOptInRequested = false,
      ingredientLookupRequested = false,
      ingredientByGoalRequested = false,
      ctx = {},
      profile = null,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      summarizeChatProfileForContext,
    } = args;

    const looksLikeRoutineRequestFn = requireFunction('looksLikeRoutineRequest', looksLikeRoutineRequest);
    const looksLikeSuitabilityRequestFn = requireFunction('looksLikeSuitabilityRequest', looksLikeSuitabilityRequest);
    const looksLikeRecommendationRequestFn = requireFunction('looksLikeRecommendationRequest', looksLikeRecommendationRequest);
    const looksLikeCompatibilityOrConflictQuestionFn = requireFunction(
      'looksLikeCompatibilityOrConflictQuestion',
      looksLikeCompatibilityOrConflictQuestion,
    );
    const looksLikeWeatherOrEnvironmentQuestionFn = requireFunction(
      'looksLikeWeatherOrEnvironmentQuestion',
      looksLikeWeatherOrEnvironmentQuestion,
    );
    const isBudgetClarificationActionFn = requireFunction(
      'isBudgetClarificationAction',
      isBudgetClarificationAction,
    );
    const isBareBudgetSelectionMessageFn = requireFunction(
      'isBareBudgetSelectionMessage',
      isBareBudgetSelectionMessage,
    );
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const summarizeChatProfileForContextFn = requireFunction(
      'summarizeChatProfileForContext',
      summarizeChatProfileForContext,
    );

    const budgetClarificationAction =
      !forceUpstreamAfterPendingAbandon && isBudgetClarificationActionFn(actionId, clarificationId);
    const budgetChipCanContinueReco = budgetClarificationAction && ctx.state === 'S6_BUDGET';
    const profileClarificationAction =
      !forceUpstreamAfterPendingAbandon &&
      Boolean(appliedProfilePatch && Object.keys(appliedProfilePatch).length > 0) &&
      (String(actionId || '').trim().toLowerCase().startsWith('chip.clarify.') || Boolean(clarificationId));
    const profilePatchTriggeredByText =
      !forceUpstreamAfterPendingAbandon &&
      Boolean(textDerivedProfilePatch && Object.keys(textDerivedProfilePatch).length > 0);
    const hasRecoContextForAutoRerun =
      latestRecoContextFromSession &&
      String(latestRecoContextFromSession.intent || '').trim().toLowerCase() === 'reco_products';
    const shouldAutoRerunRecommendationsFromProfilePatch =
      allowRecoCards &&
      (profilePatchTriggeredByText || Boolean(textDerivedSkinLog)) &&
      hasRecoContextForAutoRerun &&
      !looksLikeRoutineRequestFn(message, normalizedActionPayload) &&
      !looksLikeSuitabilityRequestFn(message) &&
      !looksLikeCompatibilityOrConflictQuestionFn(message) &&
      !looksLikeWeatherOrEnvironmentQuestionFn(message);
    const ingredientDrivenRecommendationRequested =
      ingredientRecoOptInRequested ||
      ingredientLookupRequested ||
      ingredientByGoalRequested;
    const recoEntrySourceDetail = shouldAutoRerunRecommendationsFromProfilePatch
      ? 'profile_refine_rerun'
      : ingredientDrivenRecommendationRequested
        ? 'ingredient_driven'
        : 'goal_driven';
    const recoRequestMessage = String(message || '').trim();
    const budgetChipOutOfFlow =
      budgetClarificationAction &&
      !budgetChipCanContinueReco &&
      isBareBudgetSelectionMessageFn(message) &&
      !looksLikeRecommendationRequestFn(message) &&
      !looksLikeSuitabilityRequestFn(message) &&
      !looksLikeRoutineRequestFn(message, normalizedActionPayload) &&
      !looksLikeCompatibilityOrConflictQuestionFn(message) &&
      !looksLikeWeatherOrEnvironmentQuestionFn(message);

    if (budgetChipOutOfFlow) {
      const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
      const envelope = buildEnvelopeFn(ctx, {
        assistant_message: makeChatAssistantMessageFn(
          lang === 'CN'
            ? '我已记录你的预算。你现在想做哪种帮助？（评估单品 / 获取推荐 / 检查搭配冲突）'
            : 'Budget noted. What should I do next? (evaluate one product / get recommendations / check conflicts)',
        ),
        suggested_chips: [
          {
            chip_id: 'chip.action.analyze_product',
            label: lang === 'CN' ? '评估这款是否适合我' : 'Evaluate one product',
            kind: 'quick_reply',
            data: { reply_text: lang === 'CN' ? '这款适不适合我：<产品名>' : 'Is this suitable for me: <product name>' },
          },
          {
            chip_id: 'chip.start.reco_products',
            label: lang === 'CN' ? '给我产品推荐' : 'Get recommendations',
            kind: 'quick_reply',
            data: { reply_text: lang === 'CN' ? '给我一些产品推荐' : 'Get product recommendations' },
          },
          {
            chip_id: 'chip.action.dupe_compare',
            label: lang === 'CN' ? '检查搭配冲突' : 'Check compatibility',
            kind: 'quick_reply',
            data: {
              reply_text:
                lang === 'CN' ? '阿达帕林/维A + 果酸同晚叠加会冲突吗？' : 'Can I use retinoid + acids in the same night?',
            },
          },
        ],
        cards: [
          {
            card_id: `profile_${ctx.request_id}`,
            type: 'profile',
            payload: { profile: summarizeChatProfileForContextFn(profile) },
          },
        ],
        session_patch: {},
        events: [
          makeEventFn(ctx, 'state_entered', {
            next_state: ctx.state || 'idle',
            reason: 'stale_budget_chip_ignored',
          }),
        ],
      });

      return {
        handled: true,
        envelope,
        budgetChipCanContinueReco,
        profileClarificationAction,
        ingredientDrivenRecommendationRequested,
        shouldAutoRerunRecommendationsFromProfilePatch,
        recoEntrySourceDetail,
        recoRequestMessage,
      };
    }

    return {
      handled: false,
      envelope: null,
      budgetChipCanContinueReco,
      profileClarificationAction,
      ingredientDrivenRecommendationRequested,
      shouldAutoRerunRecommendationsFromProfilePatch,
      recoEntrySourceDetail,
      recoRequestMessage,
    };
  }

  return {
    prepareRecoEntry,
  };
}

module.exports = {
  createChatRecoEntryRuntime,
};
