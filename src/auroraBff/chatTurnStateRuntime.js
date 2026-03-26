function createChatTurnStateRuntime(options = {}) {
  const {
    DEFAULT_AGENT_STATE = 'idle',
    AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED = false,
    PENDING_CLARIFICATION_TTL_MS = 0,
    normalizeAgentState = (value) => String(value || '').trim(),
    deriveRequestedTransitionFromAction = () => null,
    inferTextExplicitTransition = () => null,
    validateRequestedTransition = () => ({ ok: true, next_state: DEFAULT_AGENT_STATE }),
    recommendationsAllowed = () => false,
    isClarifyChipAction = () => false,
    hasPendingClarificationStateHint = () => false,
    parseClarificationReplyFromActionId = () => '',
    extractClarificationQuestionIdFromAction = () => '',
    parseClarificationIdFromActionId = () => '',
    advancePendingClarification = () => ({ nextPending: null, nextQuestion: null, history: [] }),
    emitPendingClarificationPatch = () => {},
    compactClarificationHistory = (history) => (Array.isArray(history) ? history : []),
    buildResumeKnownProfileFields = () => null,
  } = options;

  function resolveRequestedTransition({ parsedData, actionId, message, language } = {}) {
    const clientAgentState = normalizeAgentState(parsedData && parsedData.client_state);
    const requestedTransitionFromBody =
      parsedData && parsedData.requested_transition && typeof parsedData.requested_transition === 'object'
        ? parsedData.requested_transition
        : null;

    const derivedTransitionFromAction = !requestedTransitionFromBody && actionId
      ? deriveRequestedTransitionFromAction({ fromState: clientAgentState, actionId })
      : null;

    const derivedTransitionFromText = !requestedTransitionFromBody && !derivedTransitionFromAction && message
      ? inferTextExplicitTransition(message, language)
      : null;

    const requestedTransition =
      requestedTransitionFromBody ||
      derivedTransitionFromAction ||
      (derivedTransitionFromText
        ? {
          trigger_source: 'text_explicit',
          trigger_id: derivedTransitionFromText.trigger_id,
          requested_next_state: derivedTransitionFromText.requested_next_state,
        }
        : null);

    return {
      clientAgentState,
      requestedTransition,
    };
  }

  function prepareChatTurnPrelude(args = {}) {
    const {
      parsedData,
      ctx,
      message,
      actionId,
      clarificationId,
      actionReplyText,
      normalizedActionPayload,
      profile,
      appliedProfilePatch,
      summarizeChatProfileForContext,
      pushGateDecision = () => {},
      policyMeta,
      logger,
      recordPendingClarificationAbandoned = () => {},
      recordSessionPatchProfileEmitted = () => {},
      buildChipsForQuestion = () => [],
      recordAuroraChatSkipped = () => {},
      recordPendingClarificationStep = () => {},
      recordPendingClarificationCompleted = () => {},
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      getPendingClarification = () => null,
      AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED = false,
    } = args;

    const { clientAgentState, requestedTransition } = resolveRequestedTransition({
      parsedData,
      actionId,
      message,
      language: ctx && (ctx.match_lang || ctx.lang),
    });

    let agentState = clientAgentState;
    if (requestedTransition) {
      const triggerSource = String(requestedTransition.trigger_source || '').trim();
      const triggerId = String(requestedTransition.trigger_id || '').trim();
      const requestedNextState = normalizeAgentState(requestedTransition.requested_next_state);
      let transitionRejectedReason = '';

      if (triggerSource === 'text_explicit') {
        const inferred = inferTextExplicitTransition(message, ctx && (ctx.match_lang || ctx.lang));
        if (!inferred || inferred.requested_next_state !== requestedNextState) {
          transitionRejectedReason = 'TEXT_EXPLICIT_NOT_ALLOWED';
        }
      }

      let validation = null;
      if (!transitionRejectedReason) {
        validation = validateRequestedTransition({
          fromState: clientAgentState,
          triggerSource,
          triggerId,
          requestedNextState,
        });
        if (!validation.ok) transitionRejectedReason = String(validation.reason || 'STATE_TRANSITION_REJECTED');
      }

      if (transitionRejectedReason) {
        pushGateDecision('frontend_state_transition_guard', {
          reason_codes: [String(transitionRejectedReason || '').toLowerCase()],
        });
        if (policyMeta && typeof policyMeta === 'object') {
          policyMeta.invalid_transition_fallback = true;
          policyMeta.invalid_transition_reason = transitionRejectedReason;
        }
        logger?.warn(
          {
            request_id: ctx && ctx.request_id,
            trace_id: ctx && ctx.trace_id,
            from_state: clientAgentState,
            requested_next_state: requestedNextState,
            trigger_source: triggerSource,
            trigger_id: triggerId,
            reason: transitionRejectedReason,
          },
          'aurora bff: requested transition rejected, fallback to default state',
        );
        agentState = DEFAULT_AGENT_STATE;
      } else {
        agentState = validation.next_state;
      }
    }

    const recoInteractionAllowed = recommendationsAllowed({
      triggerSource: ctx && ctx.trigger_source,
      actionId,
      clarificationId,
      message,
      state: ctx && ctx.state,
      agentState,
    });

    const allowRecoCards =
      agentState === 'RECO_GATE' ||
      agentState === 'RECO_CONSTRAINTS' ||
      agentState === 'RECO_RESULTS' ||
      recoInteractionAllowed;

    let upstreamMessage = message;
    let clarificationHistoryForUpstream = null;
    let resumeContextForUpstream = null;
    let pendingClarificationPatchOverride = undefined;
    let forceUpstreamAfterPendingAbandon = false;
    const clarifyChipAction = isClarifyChipAction(normalizedActionPayload, { actionId, clarificationId });
    const sessionStateRaw =
      parsedData && parsedData.session && typeof parsedData.session === 'object' && !Array.isArray(parsedData.session)
        ? parsedData.session.state
        : null;
    const hasRawPendingClarification =
      sessionStateRaw &&
      typeof sessionStateRaw === 'object' &&
      !Array.isArray(sessionStateRaw) &&
      Object.prototype.hasOwnProperty.call(sessionStateRaw, 'pending_clarification');
    const pendingClarificationState = getPendingClarification(parsedData && parsedData.session);
    const pendingClarification = pendingClarificationState ? pendingClarificationState.pending : null;
    if (
      AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED &&
      pendingClarificationState &&
      pendingClarificationState.upgraded &&
      pendingClarificationPatchOverride === undefined
    ) {
      pendingClarificationPatchOverride = pendingClarification;
    }
    if (AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED && hasRawPendingClarification && !pendingClarification) {
      recordPendingClarificationAbandoned({ reason: 'error' });
    }

    let pendingClarificationExpired = false;
    if (AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED && pendingClarification) {
      const ageMs = Date.now() - Number(pendingClarification.created_at_ms || 0);
      if (!Number.isFinite(ageMs) || ageMs > PENDING_CLARIFICATION_TTL_MS) {
        pendingClarificationExpired = true;
        pendingClarificationPatchOverride = null;
        if (clarifyChipAction) forceUpstreamAfterPendingAbandon = true;
        recordPendingClarificationAbandoned({ reason: 'ttl' });
      }
    }

    if (
      AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED &&
      pendingClarification &&
      !pendingClarificationExpired &&
      !clarifyChipAction &&
      message
    ) {
      pendingClarificationPatchOverride = null;
      recordPendingClarificationAbandoned({ reason: 'free_text' });
    }

    if (
      AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED &&
      !pendingClarification &&
      clarifyChipAction &&
      hasPendingClarificationStateHint(normalizedActionPayload)
    ) {
      recordPendingClarificationAbandoned({ reason: 'missing_state' });
    }

    let earlyEnvelope = null;
    if (
      AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED &&
      pendingClarification &&
      !pendingClarificationExpired &&
      clarifyChipAction
    ) {
      const selectedOption = actionReplyText || parseClarificationReplyFromActionId(actionId);
      const selectedQuestionId =
        extractClarificationQuestionIdFromAction(normalizedActionPayload) ||
        (pendingClarification.current && pendingClarification.current.id) ||
        (typeof clarificationId === 'string' ? clarificationId.trim() : '') ||
        parseClarificationIdFromActionId(actionId);
      const { nextPending, nextQuestion, history } = advancePendingClarification(
        pendingClarification,
        selectedOption,
        selectedQuestionId,
      );

      if (nextPending && nextQuestion) {
        const profileSummaryForPatch = summarizeChatProfileForContext(profile);
        const sessionPatch = {};
        emitPendingClarificationPatch(sessionPatch, nextPending);
        if (profileSummaryForPatch) {
          sessionPatch.profile = profileSummaryForPatch;
          recordSessionPatchProfileEmitted({ changed: Boolean(appliedProfilePatch) });
        }
        const nextStepIndex = Array.isArray(nextPending.history) ? nextPending.history.length + 1 : 1;
        const chips = buildChipsForQuestion(nextQuestion, { stepIndex: nextStepIndex });
        recordAuroraChatSkipped({ reason: 'pending_clarification_step' });
        recordPendingClarificationStep({ stepIndex: Array.isArray(nextPending.history) ? nextPending.history.length : 1 });

        const questionText = String(nextQuestion.question || '').trim() ||
          (ctx && ctx.lang === 'CN' ? '再补充一个信息就好。' : 'One more quick question.');
        earlyEnvelope = buildEnvelope(ctx, {
          assistant_message: makeChatAssistantMessage(questionText),
          suggested_chips: chips,
          cards: [],
          session_patch: sessionPatch,
          events: [makeEvent(ctx, 'state_entered', { next_state: (ctx && ctx.state) || 'idle', reason: 'pending_clarification_step' })],
        });
      } else {
        pendingClarificationPatchOverride = null;
        upstreamMessage = pendingClarification.resume_user_text || upstreamMessage || message;
        const compactHistory = compactClarificationHistory(history);
        if (AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED) {
          clarificationHistoryForUpstream = compactHistory;
        }
        const profileSummaryForResume = summarizeChatProfileForContext(profile);
        const knownProfileFieldsForResume = buildResumeKnownProfileFields(profileSummaryForResume);
        resumeContextForUpstream = {
          flow_id:
            pendingClarification && typeof pendingClarification.flow_id === 'string'
              ? pendingClarification.flow_id
              : null,
          resume_user_text: upstreamMessage || pendingClarification.resume_user_text || message || '(no message)',
          clarification_history: compactHistory,
          include_history: AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED,
          ...(knownProfileFieldsForResume ? { known_profile_fields: knownProfileFieldsForResume } : {}),
        };
        forceUpstreamAfterPendingAbandon = true;
        recordPendingClarificationCompleted();
      }
    }

    return {
      clientAgentState,
      requestedTransition,
      agentState,
      recoInteractionAllowed,
      allowRecoCards,
      upstreamMessage,
      clarificationHistoryForUpstream,
      resumeContextForUpstream,
      pendingClarificationPatchOverride,
      forceUpstreamAfterPendingAbandon,
      earlyEnvelope,
    };
  }

  return {
    resolveRequestedTransition,
    prepareChatTurnPrelude,
  };
}

module.exports = { createChatTurnStateRuntime };
