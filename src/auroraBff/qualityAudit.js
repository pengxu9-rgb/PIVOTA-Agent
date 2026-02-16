const { scoreReplyQuality, REPLY_QUALITY_RUBRIC, __internal: scorerInternal } = require('./replyQualityScorer');
const { selectTemplate } = require('./replyTemplates');

const ALLOWED_FIELD_MISSING_REASONS = new Set([
  'not_provided_by_user',
  'parse_failed',
  'needs_disambiguation',
  'catalog_not_available',
  'feature_flag_disabled',
  'low_confidence',
  'frontend_disallows_external_seed',
  'upstream_timeout',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value) {
  if (value == null) return '';
  return String(value);
}

function getAssistantText(envelope) {
  const message = envelope && envelope.assistant_message;
  if (typeof message === 'string') return message;
  if (!isPlainObject(message)) return '';
  return safeString(message.content);
}

function getCards(envelope) {
  return Array.isArray(envelope && envelope.cards) ? envelope.cards : [];
}

function getSessionPatch(envelope) {
  return isPlainObject(envelope && envelope.session_patch) ? envelope.session_patch : {};
}

function hasRecommendationsCard(cards) {
  return cards.some((card) => safeString(card && card.type).trim().toLowerCase() === 'recommendations');
}

function isRecoUiState(nextState) {
  const state = safeString(nextState).trim().toUpperCase();
  return state.startsWith('RECO_');
}

function countOffersNull(cards) {
  let count = 0;
  for (const card of cards) {
    if (safeString(card && card.type).trim().toLowerCase() !== 'offers_resolved') continue;
    const payload = isPlainObject(card && card.payload) ? card.payload : {};
    if (Array.isArray(payload.items)) {
      for (const item of payload.items) {
        if (!isPlainObject(item) || item.offer == null) count += 1;
      }
    }
    for (const [key, value] of Object.entries(payload)) {
      if (/^items\[\d+\]\.offer$/i.test(String(key)) && value == null) count += 1;
    }
  }
  return count;
}

function compileRegexList(patterns) {
  return (Array.isArray(patterns) ? patterns : [])
    .map((pattern) => safeString(pattern).trim())
    .filter(Boolean)
    .map((pattern) => new RegExp(pattern, 'i'));
}

function matchesAny(text, regexes) {
  const raw = safeString(text);
  return regexes.some((rx) => rx.test(raw));
}

function getOfferAssertionPatterns() {
  const checks = Array.isArray(REPLY_QUALITY_RUBRIC && REPLY_QUALITY_RUBRIC.checks) ? REPLY_QUALITY_RUBRIC.checks : [];
  const offersCheck = checks.find((row) => safeString(row && row.id).trim() === 'offers_null_no_stock_assertion');
  const patterns = offersCheck && isPlainObject(offersCheck.patterns) ? offersCheck.patterns : {};
  return {
    forbidden: compileRegexList(patterns.forbidden_positive),
    allowedNegative: compileRegexList(patterns.allowed_negative),
  };
}

function collectCriticalMissingFields(cards) {
  const required = [];
  cards.forEach((card, cardIndex) => {
    const type = safeString(card && card.type).trim().toLowerCase();
    const payload = isPlainObject(card && card.payload) ? card.payload : {};
    if (type === 'offers_resolved') {
      if (Array.isArray(payload.items)) {
        payload.items.forEach((item, itemIndex) => {
          if (!isPlainObject(item) || item.offer == null) {
            required.push({ cardIndex, cardType: type, field: `items[${itemIndex}].offer` });
          }
        });
      }
      for (const [key, value] of Object.entries(payload)) {
        if (/^items\[\d+\]\.offer$/i.test(String(key)) && value == null) {
          required.push({ cardIndex, cardType: type, field: key });
        }
      }
    }
    if (type === 'product_parse') {
      const hasProductRef =
        safeString(payload.product_ref).trim() ||
        safeString(payload.productRef).trim() ||
        isPlainObject(payload.product);
      const hasAnchorId = safeString(payload.anchor_product_id).trim() || safeString(payload.anchorProductId).trim();
      if (!hasProductRef && !hasAnchorId) {
        required.push({ cardIndex, cardType: type, field: 'payload.product_ref' });
      }
    }
    if (type === 'recommendations' && payload.recommendations_count == null) {
      required.push({ cardIndex, cardType: type, field: 'payload.recommendations_count' });
    }
  });
  return required;
}

function findFieldMissingEntry(card, field) {
  const list = Array.isArray(card && card.field_missing) ? card.field_missing : [];
  return list.find((row) => safeString(row && row.field).trim() === field) || null;
}

function evaluateCriticalMissingFieldInvariant(cards) {
  const required = collectCriticalMissingFields(cards);
  if (required.length === 0) {
    return {
      passed: true,
      applicable: false,
      reason: 'not_applicable',
      violations: [],
    };
  }

  const violations = [];
  required.forEach((row) => {
    const card = cards[row.cardIndex];
    const entry = findFieldMissingEntry(card, row.field);
    if (!entry) {
      violations.push({
        ...row,
        reason: 'field_missing_entry_missing',
      });
      return;
    }
    const reason = safeString(entry.reason).trim();
    if (!reason) {
      violations.push({
        ...row,
        reason: 'field_missing_reason_empty',
      });
      return;
    }
    if (!ALLOWED_FIELD_MISSING_REASONS.has(reason)) {
      violations.push({
        ...row,
        reason: 'field_missing_reason_invalid',
        value: reason,
      });
    }
  });

  return {
    passed: violations.length === 0,
    applicable: true,
    reason: violations.length === 0 ? 'ok' : 'missing_field_without_reason',
    violations,
  };
}

function getAnalysisFlags(cards) {
  const analysis = cards.find((card) => safeString(card && card.type).trim().toLowerCase() === 'analysis_summary');
  if (!analysis || !isPlainObject(analysis.payload)) {
    return { used_photos: null, low_confidence: null };
  }
  const payload = analysis.payload;
  const usedPhotos = typeof payload.used_photos === 'boolean' ? payload.used_photos : null;
  const lowConfidence = typeof payload.low_confidence === 'boolean' ? payload.low_confidence : null;
  return {
    used_photos: usedPhotos,
    low_confidence: lowConfidence,
  };
}

function resolveTemplateId(envelope, ctx) {
  const patch = getSessionPatch(envelope);
  const state = isPlainObject(patch.state) ? patch.state : {};
  const fromState = safeString(state._template_id).trim();
  if (fromState) return fromState;
  try {
    const selected = safeString(selectTemplate({ envelope, ctx })).trim();
    return selected || null;
  } catch (_) {
    return null;
  }
}

function auditEnvelope(envelope = {}, ctx = {}) {
  const cards = getCards(envelope);
  const patch = getSessionPatch(envelope);
  const assistantText = getAssistantText(envelope);
  const quality = scoreReplyQuality(envelope);

  const invariants = [];

  const recoApplicable = hasRecommendationsCard(cards);
  const uiNextState = safeString(patch.next_state).trim();
  const recoPassed = !recoApplicable || isRecoUiState(uiNextState);
  invariants.push({
    id: 'recommendations_reco_state',
    passed: recoPassed,
    applicable: recoApplicable,
    reason: recoPassed ? (recoApplicable ? 'ok' : 'not_applicable') : 'recommendations_outside_reco_state',
  });

  const hasPendingCurrent = scorerInternal.hasPendingClarificationCurrent(patch);
  const chipsCount = Array.isArray(envelope && envelope.suggested_chips) ? envelope.suggested_chips.length : 0;
  const questionCount = scorerInternal.countQuestions(assistantText);
  const pendingPassed = !hasPendingCurrent || (chipsCount >= 4 && chipsCount <= 10 && questionCount <= 1);
  invariants.push({
    id: 'pending_clarification_step_constraints',
    passed: pendingPassed,
    applicable: hasPendingCurrent,
    reason: pendingPassed
      ? (hasPendingCurrent ? 'ok' : 'not_applicable')
      : (chipsCount < 4 ? 'chips_below_min' : (chipsCount > 10 ? 'chips_above_max' : 'too_many_questions')),
    chips_count: chipsCount,
    question_count: questionCount,
  });

  const offersNullCount = countOffersNull(cards);
  const offerApplicable = offersNullCount > 0;
  const patterns = getOfferAssertionPatterns();
  const hitsForbidden = matchesAny(assistantText, patterns.forbidden);
  const hitsNegative = matchesAny(assistantText, patterns.allowedNegative);
  const offerPassed = !offerApplicable || !(hitsForbidden && !hitsNegative);
  invariants.push({
    id: 'offers_null_inventory_assertion_guard',
    passed: offerPassed,
    applicable: offerApplicable,
    reason: offerPassed
      ? (offerApplicable ? 'ok' : 'not_applicable')
      : 'asserted_in_stock_or_buy_now_with_null_offer',
    offers_null_count: offersNullCount,
  });

  const critical = evaluateCriticalMissingFieldInvariant(cards);
  invariants.push({
    id: 'critical_missing_fields_require_field_missing_reason',
    passed: critical.passed,
    applicable: critical.applicable,
    reason: critical.reason,
    violations: critical.violations,
  });

  const analysisFlags = getAnalysisFlags(cards);
  const templateId = resolveTemplateId(envelope, ctx);
  const hardFailReasons = Array.isArray(quality && quality.hard_fail_reasons) ? quality.hard_fail_reasons : [];

  return {
    score: Number(quality && quality.total_score) || 0,
    hardFails: hardFailReasons,
    invariants,
    template_id: templateId,
    ui_next_state: uiNextState || null,
    internal_next_state: safeString(patch.state && patch.state._internal_next_state).trim() || null,
    total_score: Number(quality && quality.total_score) || 0,
    hard_fail_reasons: hardFailReasons,
    key_flags: {
      ...analysisFlags,
      offers_null_count: offersNullCount,
    },
    quality,
  };
}

function buildAuditEvent(ctx, audit) {
  return {
    event_name: 'quality_audit',
    timestamp: Date.now(),
    request_id: safeString(ctx && ctx.request_id).trim() || null,
    trace_id: safeString(ctx && ctx.trace_id).trim() || null,
    data: {
      template_id: audit.template_id || null,
      ui_next_state: audit.ui_next_state || null,
      internal_next_state: audit.internal_next_state || null,
      total_score: audit.total_score,
      hard_fail_reasons: Array.isArray(audit.hard_fail_reasons) ? audit.hard_fail_reasons : [],
      key_flags: audit.key_flags || {},
      invariants: (Array.isArray(audit.invariants) ? audit.invariants : []).map((item) => ({
        id: item.id,
        passed: Boolean(item.passed),
        applicable: item.applicable !== false,
        reason: item.reason || 'ok',
      })),
    },
  };
}

function emitAudit(envelope = {}, ctx = {}, { logger } = {}) {
  const env = isPlainObject(envelope) ? envelope : {};
  try {
    const audit = auditEnvelope(env, ctx);
    const event = buildAuditEvent(ctx, audit);
    if (!Array.isArray(env.events)) env.events = [];
    env.events.push(event);

    const failedInvariants = (Array.isArray(audit.invariants) ? audit.invariants : [])
      .filter((item) => item && item.applicable !== false && item.passed === false)
      .map((item) => item.id);
    const shouldWarn = failedInvariants.length > 0 || (Array.isArray(audit.hard_fail_reasons) && audit.hard_fail_reasons.length > 0);
    const payload = {
      request_id: event.request_id,
      trace_id: event.trace_id,
      template_id: event.data.template_id,
      ui_next_state: event.data.ui_next_state,
      internal_next_state: event.data.internal_next_state,
      total_score: event.data.total_score,
      hard_fail_reasons: event.data.hard_fail_reasons,
      invariant_failures: failedInvariants,
      key_flags: event.data.key_flags,
    };
    if (logger && typeof logger[shouldWarn ? 'warn' : 'info'] === 'function') {
      logger[shouldWarn ? 'warn' : 'info'](payload, 'aurora bff: quality audit');
    }
    return { envelope: env, audit, event };
  } catch (err) {
    if (!Array.isArray(env.events)) env.events = [];
    env.events.push({
      event_name: 'quality_audit',
      timestamp: Date.now(),
      request_id: safeString(ctx && ctx.request_id).trim() || null,
      trace_id: safeString(ctx && ctx.trace_id).trim() || null,
      data: {
        total_score: 0,
        hard_fail_reasons: ['audit_runtime_error'],
        invariants: [],
      },
    });
    if (logger && typeof logger.warn === 'function') {
      logger.warn(
        {
          request_id: safeString(ctx && ctx.request_id).trim() || null,
          trace_id: safeString(ctx && ctx.trace_id).trim() || null,
          err: err && err.message ? err.message : 'unknown',
        },
        'aurora bff: quality audit failed',
      );
    }
    return { envelope: env, audit: null, event: null };
  }
}

module.exports = {
  auditEnvelope,
  emitAudit,
  __internal: {
    ALLOWED_FIELD_MISSING_REASONS,
    countOffersNull,
    collectCriticalMissingFields,
    evaluateCriticalMissingFieldInvariant,
    buildAuditEvent,
    getAnalysisFlags,
  },
};
