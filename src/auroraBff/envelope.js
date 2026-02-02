const { randomUUID } = require('crypto');
const { V1ResponseEnvelopeSchema } = require('./schemas');

function safeString(v) {
  if (v == null) return '';
  return String(v);
}

function makeAssistantMessage(content, format = 'text') {
  return { role: 'assistant', content: safeString(content), ...(format ? { format } : {}) };
}

function makeEvent(ctx, eventName, data) {
  return {
    event_name: eventName,
    timestamp: Date.now(),
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    aurora_uid: ctx.aurora_uid,
    brief_id: ctx.brief_id,
    lang: ctx.lang,
    trigger_source: ctx.trigger_source,
    state: ctx.state,
    data: data || {},
  };
}

function buildEnvelope(ctx, input) {
  const requestId = safeString(ctx.request_id).trim() || randomUUID();
  const traceId = safeString(ctx.trace_id).trim() || randomUUID();

  const envelope = {
    request_id: requestId,
    trace_id: traceId,
    assistant_message: input && input.assistant_message ? input.assistant_message : null,
    suggested_chips: Array.isArray(input && input.suggested_chips) ? input.suggested_chips : [],
    cards: Array.isArray(input && input.cards) ? input.cards : [],
    session_patch: (input && input.session_patch && typeof input.session_patch === 'object') ? input.session_patch : {},
    events: Array.isArray(input && input.events) ? input.events : [],
  };

  const parsed = V1ResponseEnvelopeSchema.safeParse(envelope);
  if (parsed.success) return parsed.data;

  // Fall back to a minimal well-formed envelope (never crash the UI on schema drift).
  return {
    request_id: requestId,
    trace_id: traceId,
    assistant_message: makeAssistantMessage('Internal error: invalid response shape.'),
    suggested_chips: [],
    cards: [
      {
        card_id: `card_${requestId}`,
        type: 'error',
        payload: { error: 'INTERNAL_SCHEMA_ERROR' },
        field_missing: [{ field: 'cards', reason: 'response_validation_failed' }],
      },
    ],
    session_patch: {},
    events: [],
  };
}

module.exports = {
  makeAssistantMessage,
  makeEvent,
  buildEnvelope,
};

