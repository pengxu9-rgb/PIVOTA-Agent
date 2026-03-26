function defaultIsPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function createChatContextRuntime(options = {}) {
  const {
    INTENT_ENUM = { UNKNOWN: 'unknown' },
    isPlainObject = defaultIsPlainObject,
  } = options;

  function collectLegacyCardTypes(envelope) {
    const cards = envelope && Array.isArray(envelope.cards) ? envelope.cards : [];
    return Array.from(
      new Set(
        cards
          .map((card) => String(card && card.type ? card.type : '').trim().toLowerCase())
          .filter(Boolean),
      ),
    );
  }

  function inferGateFromLegacyCardTypes(cardTypes) {
    const types = Array.isArray(cardTypes) ? cardTypes : [];
    if (types.includes('diagnosis_gate')) return 'diagnosis_gate';
    if (types.includes('budget_gate')) return 'budget_gate';
    if (types.includes('gate_notice')) return 'gate_notice';
    return 'none';
  }

  function extractNextStateFromEnvelope(envelope) {
    const sessionPatch =
      envelope &&
      envelope.session_patch &&
      isPlainObject(envelope.session_patch)
        ? envelope.session_patch
        : null;
    if (!sessionPatch) return null;
    const next = String(sessionPatch.next_state || '').trim();
    return next || null;
  }

  function updateChatContextFromEnvelope({
    chatContext,
    envelope,
    policyIntent,
    canonicalIntent,
    requestMessage,
  } = {}) {
    const topicFromIntent = String(policyIntent || canonicalIntent || INTENT_ENUM.UNKNOWN)
      .trim()
      .toLowerCase();
    const requestedTopicId = topicFromIntent || 'unknown';
    const nowMs = Date.now();
    const baseContext = isPlainObject(chatContext) ? { ...chatContext } : {};
    const stack = Array.isArray(baseContext.thread_stack)
      ? baseContext.thread_stack.filter((row) => isPlainObject(row))
      : [];
    const activeThread = isPlainObject(baseContext.active_thread)
      ? { ...baseContext.active_thread }
      : null;
    const assistantSummary =
      envelope &&
      envelope.assistant_message &&
      typeof envelope.assistant_message.content === 'string'
        ? String(envelope.assistant_message.content).trim().slice(0, 220)
        : '';
    const userText = String(requestMessage || '').trim();
    const returnToPrevious = /回到|刚才|之前的话题|继续刚才|back to|previous topic|return to/i.test(userText);
    const ops = [];
    let nextActive = activeThread;
    let nextStack = stack.slice(0, 8);

    if (returnToPrevious && nextStack.length > 0) {
      const restored = nextStack.pop();
      const restoredTopicId = String(restored && restored.topic_id ? restored.topic_id : '').trim();
      if (restoredTopicId) {
        nextActive = {
          ...restored,
          topic_id: restoredTopicId,
          summary: assistantSummary || String(restored.summary || '').trim().slice(0, 220),
          updated_at_ms: nowMs,
        };
        ops.push({
          op: 'thread_pop',
          topic_id: restoredTopicId.slice(0, 120),
          summary: String(nextActive.summary || '').slice(0, 220),
          timestamp_ms: nowMs,
        });
      }
    } else if (requestedTopicId && requestedTopicId !== 'unknown') {
      const activeTopicId = String(nextActive && nextActive.topic_id ? nextActive.topic_id : '').trim().toLowerCase();
      if (!activeTopicId) {
        nextActive = {
          topic_id: requestedTopicId,
          summary: assistantSummary,
          updated_at_ms: nowMs,
        };
        ops.push({
          op: 'thread_push',
          topic_id: requestedTopicId.slice(0, 120),
          summary: assistantSummary,
          timestamp_ms: nowMs,
        });
      } else if (activeTopicId !== requestedTopicId) {
        nextStack.push({
          topic_id: activeTopicId,
          summary: String(nextActive.summary || '').slice(0, 220),
          updated_at_ms: Number.isFinite(Number(nextActive.updated_at_ms))
            ? Math.max(0, Math.trunc(Number(nextActive.updated_at_ms)))
            : nowMs,
        });
        nextStack = nextStack.slice(-8);
        nextActive = {
          topic_id: requestedTopicId,
          summary: assistantSummary,
          updated_at_ms: nowMs,
        };
        ops.push({
          op: 'thread_push',
          topic_id: requestedTopicId.slice(0, 120),
          summary: assistantSummary,
          timestamp_ms: nowMs,
        });
      } else {
        nextActive = {
          ...nextActive,
          summary: assistantSummary || String(nextActive.summary || '').slice(0, 220),
          updated_at_ms: nowMs,
        };
        ops.push({
          op: 'thread_update',
          topic_id: requestedTopicId.slice(0, 120),
          summary: String(nextActive.summary || '').slice(0, 220),
          timestamp_ms: nowMs,
        });
      }
    }

    const sessionPatch = envelope && isPlainObject(envelope.session_patch) ? envelope.session_patch : {};
    const sessionMeta = isPlainObject(sessionPatch.meta) ? sessionPatch.meta : {};
    const travelFollowupFromPatch =
      sessionMeta && isPlainObject(sessionMeta.travel_followup) ? sessionMeta.travel_followup : null;
    const travelFollowupFromContext =
      baseContext && isPlainObject(baseContext.travel_followup)
        ? baseContext.travel_followup
        : (
          baseContext && isPlainObject(baseContext.travelFollowup)
            ? baseContext.travelFollowup
            : null
        );
    const travelFollowup = travelFollowupFromPatch || travelFollowupFromContext;
    const pendingClarification = Object.prototype.hasOwnProperty.call(sessionPatch, 'pending_clarification')
      ? sessionPatch.pending_clarification
      : baseContext.pending_clarification || null;

    return {
      chatContext: {
        ...baseContext,
        active_thread: nextActive,
        active_thread_summary: nextActive && nextActive.summary ? String(nextActive.summary).slice(0, 220) : null,
        thread_stack: nextStack,
        ...(travelFollowup
          ? {
            travel_followup: travelFollowup,
            travelFollowup: travelFollowup,
          }
          : {}),
        pending_clarification: pendingClarification,
        updated_at_ms: nowMs,
      },
      threadOps: ops.slice(0, 4),
    };
  }

  function collectTelemetryEntities(canonicalIntentForResponse) {
    const entitiesRaw =
      canonicalIntentForResponse &&
      canonicalIntentForResponse.entities &&
      isPlainObject(canonicalIntentForResponse.entities)
        ? canonicalIntentForResponse.entities
        : {};
    const out = [];
    for (const [key, value] of Object.entries(entitiesRaw)) {
      if (Array.isArray(value)) {
        for (const row of value.slice(0, 4)) {
          out.push({ key, value: row });
        }
        continue;
      }
      out.push({ key, value });
    }
    return out.slice(0, 16);
  }

  return {
    collectLegacyCardTypes,
    inferGateFromLegacyCardTypes,
    extractNextStateFromEnvelope,
    updateChatContextFromEnvelope,
    collectTelemetryEntities,
  };
}

module.exports = { createChatContextRuntime };
