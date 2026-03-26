function createChatProfileContinuationRuntime(options = {}) {
  const {
    profileCompleteness,
    stateChangeAllowed,
    recordSessionPatchProfileEmitted = () => {},
    chatDiagnosisGateRuntime,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat profile continuation runtime missing dependency: ${name}`);
  }

  function buildSuggestedChips(lang) {
    return [
      {
        chip_id: 'chip.action.reco_routine',
        label: lang === 'CN' ? '生成早晚护肤 routine' : 'Build an AM/PM routine',
        kind: 'quick_reply',
        data: { reply_text: lang === 'CN' ? '生成一套早晚护肤 routine' : 'Build an AM/PM skincare routine' },
      },
      {
        chip_id: 'chip.action.analyze_product',
        label: lang === 'CN' ? '评估某个产品适合吗' : 'Evaluate a specific product',
        kind: 'quick_reply',
        data: { reply_text: lang === 'CN' ? '评估这款产品是否适合我' : 'Evaluate a specific product for me' },
      },
      {
        chip_id: 'chip.action.dupe_compare',
        label: lang === 'CN' ? '找平替/对比替代品' : 'Find dupes / alternatives',
        kind: 'quick_reply',
        data: { reply_text: lang === 'CN' ? '帮我找平替并比较 tradeoffs' : 'Find dupes and compare tradeoffs' },
      },
    ];
  }

  function maybeBuildProfileContinuationEnvelope({
    ctx,
    agentState,
    message = '',
    profileClarificationAction = false,
    hasExplicitUserIntentMessage = false,
    ingredientScienceIntentEffective = false,
    ingredientEntryRequested = false,
    ingredientLookupRequested = false,
    ingredientByGoalRequested = false,
    ingredientTextTrigger = false,
    profile = null,
    recentLogs = [],
    appliedProfilePatch = null,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
    summarizeChatProfileForContext,
    buildDiagnosisPrompt,
    buildDiagnosisChips,
  } = {}) {
    if (!appliedProfilePatch || ((message && !profileClarificationAction) || hasExplicitUserIntentMessage)) {
      return null;
    }

    const profileCompletenessFn = requireFunction('profileCompleteness', profileCompleteness);
    const stateChangeAllowedFn = requireFunction('stateChangeAllowed', stateChangeAllowed);
    const summarizeChatProfileForContextFn = requireFunction(
      'summarizeChatProfileForContext',
      summarizeChatProfileForContext,
    );
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);

    if (
      !chatDiagnosisGateRuntime ||
      typeof chatDiagnosisGateRuntime.buildDiagnosisGateEnvelope !== 'function'
    ) {
      throw new Error('aurora chat profile continuation runtime missing dependency: chatDiagnosisGateRuntime.buildDiagnosisGateEnvelope');
    }

    const inDiagnosisFlow =
      String(agentState || '').startsWith('DIAG_') ||
      String(ctx && ctx.state || '').startsWith('S2_') ||
      String(ctx && ctx.state || '').startsWith('S3_') ||
      profileClarificationAction;

    const { missing } = profileCompletenessFn(profile);
    const requiredCore = ['skinType', 'sensitivity', 'barrierStatus', 'goals'];
    const missingCore = requiredCore.filter((key) => (Array.isArray(missing) ? missing.includes(key) : false));
    const profileSummaryForPatch = summarizeChatProfileForContextFn(profile);

    if (profileSummaryForPatch) {
      recordSessionPatchProfileEmitted({ changed: true });
    }

    const shouldStayInDiagnosis =
      inDiagnosisFlow &&
      missingCore.length > 0 &&
      !(
        ingredientScienceIntentEffective &&
        (ingredientEntryRequested || ingredientLookupRequested || ingredientByGoalRequested || ingredientTextTrigger)
      );

    if (shouldStayInDiagnosis) {
      const nextState = stateChangeAllowedFn(ctx && ctx.trigger_source) ? 'S2_DIAGNOSIS' : undefined;
      return chatDiagnosisGateRuntime.buildDiagnosisGateEnvelope({
        reason: 'diagnosis_progress',
        ctx,
        profile,
        recentLogs,
        missingFields: missingCore,
        nextState,
        buildEnvelope,
        makeChatAssistantMessage,
        makeEvent,
        summarizeChatProfileForContext: summarizeChatProfileForContextFn,
        buildDiagnosisPrompt,
        buildDiagnosisChips,
        includeProfileInSessionPatch: true,
        profileSummaryForPatch,
        appliedProfilePatch,
      });
    }

    const lang = ctx && ctx.lang === 'CN' ? 'CN' : 'EN';
    return buildEnvelopeFn(ctx, {
      assistant_message: makeChatAssistantMessageFn(
        lang === 'CN'
          ? '已更新你的偏好信息。接下来你想做什么？'
          : 'Got it. What would you like to do next?',
      ),
      suggested_chips: buildSuggestedChips(lang),
      cards: [
        {
          card_id: `profile_${ctx && ctx.request_id}`,
          type: 'profile',
          payload: { profile: summarizeChatProfileForContextFn(profile) },
        },
      ],
      session_patch: { profile: profileSummaryForPatch },
      events: [makeEventFn(ctx, 'profile_saved', { fields: Object.keys(appliedProfilePatch) })],
    });
  }

  return {
    maybeBuildProfileContinuationEnvelope,
  };
}

module.exports = {
  createChatProfileContinuationRuntime,
};
