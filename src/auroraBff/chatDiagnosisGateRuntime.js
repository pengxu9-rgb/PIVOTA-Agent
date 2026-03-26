function createChatDiagnosisGateRuntime(options = {}) {
  const {
    logger,
    GATE_MODE = {
      ADVISORY: 'advisory',
    },
    AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED = false,
    buildPendingClarificationForGate = () => null,
    emitPendingClarificationPatch = () => {},
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat diagnosis gate runtime missing dependency: ${name}`);
  }

  function buildDiagnosisGateEnvelope({
    reason,
    ctx,
    profile,
    recentLogs = [],
    missingFields = [],
    nextState,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
    summarizeChatProfileForContext,
    buildDiagnosisPrompt,
    buildDiagnosisChips,
    includeProfileInSessionPatch = false,
    profileSummaryForPatch = null,
    appliedProfilePatch = null,
  } = {}) {
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const summarizeChatProfileForContextFn = requireFunction(
      'summarizeChatProfileForContext',
      summarizeChatProfileForContext,
    );
    const buildDiagnosisPromptFn = requireFunction('buildDiagnosisPrompt', buildDiagnosisPrompt);
    const buildDiagnosisChipsFn = requireFunction('buildDiagnosisChips', buildDiagnosisChips);

    const prompt = buildDiagnosisPromptFn(ctx && ctx.lang, missingFields);
    const chips = buildDiagnosisChipsFn(ctx && ctx.lang, missingFields);
    const sessionPatch = nextState ? { next_state: nextState } : {};
    if (includeProfileInSessionPatch) {
      sessionPatch.profile = profileSummaryForPatch;
    }

    const events = [];
    if (appliedProfilePatch && typeof appliedProfilePatch === 'object' && !Array.isArray(appliedProfilePatch)) {
      events.push(
        makeEventFn(ctx, 'profile_saved', {
          fields: Object.keys(appliedProfilePatch),
        }),
      );
    }
    events.push(
      makeEventFn(ctx, 'state_entered', {
        next_state: nextState || null,
        reason,
      }),
    );

    return buildEnvelopeFn(ctx, {
      assistant_message: makeChatAssistantMessageFn(prompt),
      suggested_chips: chips,
      cards: [
        {
          card_id: `diag_${ctx && ctx.request_id}`,
          type: 'diagnosis_gate',
          payload: {
            reason,
            missing_fields: missingFields,
            wants: 'diagnosis',
            profile: summarizeChatProfileForContextFn(profile),
            recent_logs: recentLogs,
          },
        },
      ],
      session_patch: sessionPatch,
      events,
    });
  }

  function buildDiagnosisProfileCompleteEnvelope({
    ctx,
    profile,
    nextState,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
    summarizeChatProfileForContext,
  } = {}) {
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const summarizeChatProfileForContextFn = requireFunction(
      'summarizeChatProfileForContext',
      summarizeChatProfileForContext,
    );

    const lang = ctx && ctx.lang === 'CN' ? 'CN' : 'EN';
    const prompt =
      lang === 'CN'
        ? '已收到你的肤况信息。要不要再上传一张照片让我更准？你也可以先跳过照片，我会给一份低置信度的安全基线。'
        : "Got it — I saved your skin profile. Want to upload a photo for a more accurate analysis? You can also skip photos and I’ll give a low-confidence, safe baseline first.";

    return buildEnvelopeFn(ctx, {
      assistant_message: makeChatAssistantMessageFn(prompt),
      suggested_chips: [
        {
          chip_id: 'chip.intake.upload_photos',
          label: lang === 'CN' ? '上传照片（更准）' : 'Upload a photo (more accurate)',
          kind: 'quick_reply',
          data: {},
        },
        {
          chip_id: 'chip.intake.skip_analysis',
          label: lang === 'CN' ? '跳过照片（低置信度）' : 'Skip photo (low confidence)',
          kind: 'quick_reply',
          data: {},
        },
        {
          chip_id: 'chip_keep_chatting',
          label: lang === 'CN' ? '继续聊聊' : 'Just keep chatting',
          kind: 'quick_reply',
          data: {},
        },
      ],
      cards: [],
      session_patch: nextState
        ? {
          next_state: nextState,
          profile: summarizeChatProfileForContextFn(profile),
        }
        : {
          profile: summarizeChatProfileForContextFn(profile),
        },
      events: [
        makeEventFn(ctx, 'state_entered', {
          next_state: nextState || null,
          reason: 'diagnosis_profile_complete',
        }),
      ],
    });
  }

  function applyDiagnosisFirstProfileGate({
    ctx,
    requiredMissing = [],
    message = '',
    pushGateDecision,
    enqueueGateAdvisory,
    pendingClarificationPatchOverride,
    buildDiagnosisChips,
  } = {}) {
    const pushGateDecisionFn = requireFunction('pushGateDecision', pushGateDecision);
    const enqueueGateAdvisoryFn = requireFunction('enqueueGateAdvisory', enqueueGateAdvisory);
    const buildDiagnosisChipsFn = requireFunction('buildDiagnosisChips', buildDiagnosisChips);

    const required = Array.isArray(requiredMissing) ? requiredMissing.filter(Boolean) : [];
    if (!required.length) {
      return {
        decision: null,
        pendingClarificationPatchOverride,
      };
    }

    const chips = buildDiagnosisChipsFn(ctx && ctx.lang, required);
    const decision = pushGateDecisionFn('diagnosis_first_profile_gate', {
      reason_codes: ['diagnosis_first'],
    });

    let nextPendingClarificationPatchOverride = pendingClarificationPatchOverride;
    if (decision && decision.mode === GATE_MODE.ADVISORY) {
      enqueueGateAdvisoryFn({
        gate_id: 'diagnosis_first_profile_gate',
        message:
          ctx && ctx.lang === 'CN'
            ? '我先给你可执行推荐，同时补充画像后可进一步提高精准度。'
            : 'I will provide usable recommendations first; adding profile details will improve precision.',
        reason_codes: ['diagnosis_first', ...required.map((field) => `missing_${field}`)],
        actions: ['refine_profile'],
        chips,
      });

      logger?.info(
        {
          request_id: ctx && ctx.request_id,
          trace_id: ctx && ctx.trace_id,
          missing_fields: required,
        },
        'aurora bff: diagnosis-first gate downgraded to advisory',
      );

      if (AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED) {
        const pendingFromGate = buildPendingClarificationForGate({
          language: ctx && ctx.lang,
          missing: required,
          message,
          wants: 'recommendation',
        });
        if (pendingFromGate) {
          const sessionPatch = {};
          emitPendingClarificationPatch(sessionPatch, pendingFromGate);
          nextPendingClarificationPatchOverride =
            sessionPatch.pending_clarification || nextPendingClarificationPatchOverride;
        }
      }
    }

    return {
      decision,
      pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
    };
  }

  function resolveDiagnosisEntryEnvelope({
    ctx,
    agentState,
    diagnosisFlowContinuationAllowed,
    diagnosisEntryRequested,
    ingredientScienceIntentEffective,
    ingredientDiagnosisOptInRequested,
    actionId,
    ingredientEntryRequested,
    ingredientLookupRequested,
    ingredientByGoalRequested,
    ingredientResearchPollRequested,
    ingredientTextTrigger,
    profile,
    recentLogs = [],
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
    summarizeChatProfileForContext,
    buildDiagnosisPrompt,
    buildDiagnosisChips,
    profileCompleteness,
    stateChangeAllowed,
    normalizeIngredientActionId,
  } = {}) {
    const profileCompletenessFn = requireFunction('profileCompleteness', profileCompleteness);
    const stateChangeAllowedFn = requireFunction('stateChangeAllowed', stateChangeAllowed);
    const normalizeIngredientActionIdFn = requireFunction(
      'normalizeIngredientActionId',
      normalizeIngredientActionId,
    );

    const inDiagnosisState =
      String(agentState || '') === 'DIAG_PROFILE' ||
      String(agentState || '').startsWith('DIAG_');
    const ingredientDiagnosisRouteGuardActive =
      ingredientScienceIntentEffective &&
      !ingredientDiagnosisOptInRequested &&
      normalizeIngredientActionIdFn(actionId) !== 'chip.start.diagnosis' &&
      normalizeIngredientActionIdFn(actionId) !== 'chip_start_diagnosis' &&
      (
        ingredientEntryRequested ||
        ingredientLookupRequested ||
        ingredientByGoalRequested ||
        ingredientResearchPollRequested ||
        ingredientTextTrigger
      );

    if (
      !(diagnosisEntryRequested || (inDiagnosisState && diagnosisFlowContinuationAllowed)) ||
      ingredientDiagnosisRouteGuardActive
    ) {
      return { handled: false };
    }

    const { missing } = profileCompletenessFn(profile);
    const requiredCore = ['skinType', 'sensitivity', 'barrierStatus', 'goals'];
    const missingCore = requiredCore.filter((field) => (
      Array.isArray(missing) ? missing.includes(field) : false
    ));

    if (missingCore.length) {
      const nextState = stateChangeAllowedFn(ctx && ctx.trigger_source) ? 'S2_DIAGNOSIS' : undefined;
      return {
        handled: true,
        envelope: buildDiagnosisGateEnvelope({
          reason: 'diagnosis_start',
          ctx,
          profile,
          recentLogs,
          missingFields: missingCore,
          nextState,
          buildEnvelope,
          makeChatAssistantMessage,
          makeEvent,
          summarizeChatProfileForContext,
          buildDiagnosisPrompt,
          buildDiagnosisChips,
        }),
      };
    }

    const nextState = stateChangeAllowedFn(ctx && ctx.trigger_source) ? 'S2_DIAGNOSIS' : undefined;
    return {
      handled: true,
      envelope: buildDiagnosisProfileCompleteEnvelope({
        ctx,
        profile,
        nextState,
        buildEnvelope,
        makeChatAssistantMessage,
        makeEvent,
        summarizeChatProfileForContext,
      }),
    };
  }

  return {
    buildDiagnosisGateEnvelope,
    buildDiagnosisProfileCompleteEnvelope,
    applyDiagnosisFirstProfileGate,
    resolveDiagnosisEntryEnvelope,
  };
}

module.exports = {
  createChatDiagnosisGateRuntime,
};
