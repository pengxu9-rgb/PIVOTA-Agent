function createChatClarificationRuntime(options = {}) {
  const {
    filterClarificationQuestionsForChips = () => [],
    normalizeClarificationField = (value) => String(value || '').trim() || 'clarify',
    hasKnownClarificationFieldValue = () => false,
    sanitizePendingClarification = () => null,
    buildChipsForQuestion = () => [],
    recordClarificationPresent = () => {},
    recordRepeatedClarifyField = () => {},
    recordClarificationFlowV2Started = () => {},
    AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED = false,
    PENDING_CLARIFICATION_SCHEMA_V1 = 1,
    makeFlowId = () => `pc_${Math.random().toString(36).slice(2, 10)}`,
    now = () => Date.now(),
  } = options;

  function deriveUpstreamClarification({
    upstream,
    profileSummary,
    filterKnown = false,
    upstreamMessage = '',
    message = '',
  } = {}) {
    const clarification =
      upstream && upstream.clarification && typeof upstream.clarification === 'object'
        ? upstream.clarification
        : null;
    recordClarificationPresent({ present: Boolean(clarification) });

    const clarificationQuestions = filterClarificationQuestionsForChips({
      clarification,
      profileSummary,
      filterKnown,
    });

    let pendingClarificationFromUpstream = null;
    const suggestedChips = [];

    if (clarificationQuestions[0]) {
      const q0 = clarificationQuestions[0];
      const qid = String(q0.id || 'clarify').trim() || 'clarify';
      const repeatedField = (() => {
        const field = normalizeClarificationField(qid);
        return hasKnownClarificationFieldValue(profileSummary, field) ? field : null;
      })();
      if (repeatedField) recordRepeatedClarifyField({ field: repeatedField });

      if (AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED && clarificationQuestions.length > 1) {
        const resumeUserText = String(upstreamMessage || message || '(no message)').trim() || '(no message)';
        const seededPending = sanitizePendingClarification(
          {
            v: PENDING_CLARIFICATION_SCHEMA_V1,
            flow_id: makeFlowId(),
            created_at_ms: now(),
            resume_user_text: resumeUserText,
            step_index: 0,
            current: { id: qid },
            queue: clarificationQuestions.slice(1).map((question) => ({
              id: String(question.id || 'clarify'),
              question: String(question.question || ''),
              options: Array.isArray(question.options) ? question.options : [],
            })),
            history: [],
          },
          { recordMetrics: true },
        );
        if (seededPending && seededPending.pending && seededPending.pending.queue.length > 0) {
          pendingClarificationFromUpstream = seededPending.pending;
          recordClarificationFlowV2Started();
        }
      }

      suggestedChips.push(...buildChipsForQuestion(q0, { stepIndex: 1 }));
    }

    return {
      clarification,
      pendingClarificationFromUpstream,
      suggestedChips,
    };
  }

  return {
    deriveUpstreamClarification,
  };
}

module.exports = {
  createChatClarificationRuntime,
};
