const { randomUUID } = require('crypto');
const { V1ResponseEnvelopeSchema } = require('./schemas');
const { validateTemplateOutput } = require('./templateSystem');
const {
  recordChipsTruncated,
  recordFieldMissingAdded,
  recordAntiTemplateViolation,
  recordActionableReply,
} = require('./visionMetrics');

const UI_STATES = new Set([
  'IDLE_CHAT',
  'SOFT_INTENT_SUGGEST',
  'QUICK_PROFILE',
  'DIAG_PROFILE',
  'DIAG_PHOTO_OPTIN',
  'DIAG_ANALYSIS_SUMMARY',
  'ROUTINE_INTAKE',
  'ROUTINE_REVIEW',
  'MINIMAL_PLAN',
  'PRODUCT_LINK_EVAL',
  'RECO_GATE',
  'RECO_CONSTRAINTS',
  'RECO_RESULTS',
  'SAVE_PROFILE_PROMPT',
  'RETURN_WELCOME',
  'CHECKIN_PROMPT',
  'CHECKIN_FLOW',
  'SAFETY_TRIAGE',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

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

function deriveUiNextState({ cards = [], session_patch = {} } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const types = new Set(
    list
      .map((c) => (c && typeof c.type === 'string' ? c.type.trim().toLowerCase() : ''))
      .filter(Boolean),
  );
  const has = (type) => types.has(String(type || '').trim().toLowerCase());

  if (has('recommendations')) return 'RECO_RESULTS';

  const gate = list.find((c) => String(c && c.type ? c.type : '').trim().toLowerCase() === 'diagnosis_gate');
  const gateWants = String(gate && gate.payload && gate.payload.wants ? gate.payload.wants : '').trim().toLowerCase();
  if (gateWants === 'recommendation') return 'RECO_GATE';
  if (gate) return 'DIAG_PROFILE';

  if (has('analysis_summary')) return 'DIAG_ANALYSIS_SUMMARY';
  if (has('photo_confirm') || has('photo_modules_v1')) return 'DIAG_PHOTO_OPTIN';

  if (has('routine_simulation') || has('conflict_heatmap')) return 'ROUTINE_REVIEW';

  if (has('product_parse') || has('product_analysis') || has('offers_resolved')) return 'PRODUCT_LINK_EVAL';

  const ns = String(session_patch && session_patch.next_state ? session_patch.next_state : '').trim();
  if (UI_STATES.has(ns)) return ns;

  return 'IDLE_CHAT';
}

function normalizeNextState(envelope) {
  if (!isPlainObject(envelope)) return envelope;

  const patch = isPlainObject(envelope.session_patch) ? envelope.session_patch : {};
  const internalRaw = String(patch.next_state || '').trim();
  const ui = deriveUiNextState({ cards: envelope.cards, session_patch: patch });
  const state = isPlainObject(patch.state) ? { ...patch.state } : {};
  const internalExisting = String(state._internal_next_state || '').trim();
  const internal = !UI_STATES.has(internalRaw) && internalRaw ? internalRaw : internalExisting;

  if (internal) state._internal_next_state = internal;

  const nextPatch = {
    ...patch,
    ...(Object.keys(state).length ? { state } : {}),
    next_state: ui,
  };

  envelope.session_patch = nextPatch;
  return envelope;
}

function appendFieldMissing(card, field, reason) {
  if (!isPlainObject(card)) return;
  const fm = Array.isArray(card.field_missing) ? card.field_missing : [];
  const f = String(field || '').trim();
  const r = String(reason || '').trim();
  if (!f || !r) {
    card.field_missing = fm;
    return;
  }
  const exists = fm.some((x) => x && x.field === f && x.reason === r);
  if (exists) {
    card.field_missing = fm;
    return;
  }
  card.field_missing = [...fm, { field: f, reason: r }];
  recordFieldMissingAdded({ delta: 1 });
}

function recommendationHasPurchasePath(item) {
  if (!isPlainObject(item)) return false;

  const hasOfferRoute = (offer) => {
    if (!isPlainObject(offer)) return false;
    if (typeof offer.affiliate_url === 'string' && offer.affiliate_url.trim()) return true;
    if (isPlainObject(offer.internal_checkout)) return true;
    if (typeof offer.purchase_route === 'string' && offer.purchase_route.trim()) return true;
    return false;
  };

  if (hasOfferRoute(item.offer)) return true;
  if (Array.isArray(item.offers) && item.offers.some((offer) => hasOfferRoute(offer))) return true;
  if (typeof item.affiliate_url === 'string' && item.affiliate_url.trim()) return true;
  if (typeof item.purchase_url === 'string' && item.purchase_url.trim()) return true;
  if (typeof item.url === 'string' && item.url.trim()) return true;
  return false;
}

function sanitizeProductAnalysisPayloadForPublic(payload) {
  const p = isPlainObject(payload) ? payload : {};
  const next = { ...p };
  delete next.missing_info_internal;
  delete next.internal_debug_codes;
  return next;
}

function stripInternalProductAnalysisFields(envelope) {
  if (!isPlainObject(envelope)) return envelope;
  const cards = Array.isArray(envelope.cards) ? envelope.cards : [];
  for (const card of cards) {
    if (!isPlainObject(card)) continue;
    const type = String(card.type || '').trim().toLowerCase();
    if (type !== 'product_analysis') continue;
    card.payload = sanitizeProductAnalysisPayloadForPublic(card.payload);
  }
  envelope.cards = cards;
  return envelope;
}

function enforceCardFieldMissing(card) {
  if (!isPlainObject(card)) return;
  if (!Array.isArray(card.field_missing)) card.field_missing = [];

  const type = String(card.type || '').trim().toLowerCase();
  const payload = isPlainObject(card.payload) ? card.payload : {};

  if (type === 'offers_resolved') {
    if (Array.isArray(payload.items)) {
      payload.items.forEach((item, idx) => {
        if (!item || item.offer == null) {
          appendFieldMissing(card, `items[${idx}].offer`, 'catalog_not_available');
        }
      });
    } else {
      for (const [k, v] of Object.entries(payload)) {
        if (/^items\[\d+\]\.offer$/i.test(k) && v == null) {
          appendFieldMissing(card, k, 'catalog_not_available');
        }
      }
    }
  }

  if (type === 'product_parse') {
    const confidence = typeof payload.confidence === 'number' ? payload.confidence : null;
    const hasProductRef =
      (typeof payload.product_ref === 'string' && payload.product_ref.trim()) ||
      (typeof payload.productRef === 'string' && payload.productRef.trim()) ||
      isPlainObject(payload.product);
    const hasAnchorProductId =
      (typeof payload.anchor_product_id === 'string' && payload.anchor_product_id.trim()) ||
      (typeof payload.anchorProductId === 'string' && payload.anchorProductId.trim());
    const parseFailed =
      payload.parse_failed === true ||
      String(payload.error || '').trim().toLowerCase() === 'parse_failed' ||
      String(payload.status || '').trim().toLowerCase() === 'parse_failed';
    const needsDisambiguation =
      payload.needs_disambiguation === true ||
      String(payload.reason || '').trim().toLowerCase() === 'needs_disambiguation' ||
      String(payload.error || '').trim().toLowerCase() === 'needs_disambiguation' ||
      /ambiguous|disambiguat/.test(String(payload.status || '').trim().toLowerCase()) ||
      (Array.isArray(payload.candidates) && payload.candidates.length > 1);

    if (!hasProductRef && !hasAnchorProductId) {
      appendFieldMissing(card, 'payload.product_ref', needsDisambiguation ? 'needs_disambiguation' : 'parse_failed');
    } else if (confidence != null && confidence < 0.5) {
      appendFieldMissing(card, 'payload.product_ref', 'low_confidence');
    }
  }

  if (type === 'recommendations') {
    const recs = Array.isArray(payload.recommendations) ? payload.recommendations : [];
    if (payload.recommendations_count == null) {
      appendFieldMissing(card, 'payload.recommendations_count', 'upstream_timeout');
    }
    if (recs.length > 0 && !recommendationHasPurchasePath(recs[0])) {
      appendFieldMissing(card, 'payload.recommendations[0].purchase_path', 'catalog_not_available');
    }
  }
}

function FieldMissingEnforcer(envelope) {
  if (!isPlainObject(envelope)) return envelope;
  const cards = Array.isArray(envelope.cards) ? envelope.cards : [];
  for (const card of cards) enforceCardFieldMissing(card);
  envelope.cards = cards;
  return envelope;
}

function clampSuggestedChips(envelope) {
  if (!isPlainObject(envelope)) return envelope;
  if (Array.isArray(envelope.suggested_chips) && envelope.suggested_chips.length > 10) {
    recordChipsTruncated({ delta: envelope.suggested_chips.length - 10 });
    envelope.suggested_chips = envelope.suggested_chips.slice(0, 10);
  }
  return envelope;
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

  clampSuggestedChips(envelope);
  stripInternalProductAnalysisFields(envelope);
  FieldMissingEnforcer(envelope);
  normalizeNextState(envelope);
  const templateValidation = validateTemplateOutput(envelope, { warnOnly: true });
  if (templateValidation && typeof templateValidation.actionable === 'boolean') {
    recordActionableReply({ actionable: templateValidation.actionable });
  }
  if (templateValidation && Array.isArray(templateValidation.violations)) {
    for (const violation of templateValidation.violations) {
      recordAntiTemplateViolation({ rule: violation && violation.rule ? violation.rule : 'unknown' });
    }
  }

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
  deriveUiNextState,
  normalizeNextState,
  FieldMissingEnforcer,
  buildEnvelope,
};
