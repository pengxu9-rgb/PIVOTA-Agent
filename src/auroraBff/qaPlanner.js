const { INTENT_ENUM } = require('./intentCanonical');

const QA_LOOP_STATE_KEY = 'qa_planner_v2';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function profileHasValue(profile, key) {
  const source = profile && typeof profile === 'object' ? profile : {};
  if (key === 'goals') return isNonEmptyArray(source.goals);
  if (key === 'high_risk_medications') return Array.isArray(source.high_risk_medications);
  return isNonEmptyString(source[key]);
}

function getCoreProfileMissing(profile) {
  const required = ['skinType', 'sensitivity', 'barrierStatus', 'goals'];
  return required.filter((key) => !profileHasValue(profile, key));
}

function getTravelMissing(profile) {
  const travel = profile && typeof profile === 'object' ? profile.travel_plan : null;
  const travelObj = travel && typeof travel === 'object' && !Array.isArray(travel) ? travel : {};
  const missing = [];
  if (!isNonEmptyString(travelObj.destination)) missing.push('travel_plan.destination');
  if (!isNonEmptyString(travelObj.start_date)) missing.push('travel_plan.start_date');
  if (!isNonEmptyString(travelObj.end_date)) missing.push('travel_plan.end_date');
  return missing;
}

function hasStrongActiveMention(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  return /(retinoid|retinol|tretinoin|adapalene|hydroquinone|isotretinoin|peel|high\s*strength\s*acid|A醇|维A|阿达帕林|氢醌|异维A酸|刷酸|果酸换肤)/i.test(
    text,
  );
}

function buildRequiredFields({ intent, profile, hasAnchor, message, safetyDecision }) {
  if (
    safetyDecision &&
    typeof safetyDecision === 'object' &&
    String(safetyDecision.block_level || '').toUpperCase() === 'REQUIRE_INFO'
  ) {
    const safetyRequiredFields = Array.isArray(safetyDecision.required_fields)
      ? safetyDecision.required_fields.map((field) => String(field || '').trim()).filter(Boolean)
      : [];
    if (safetyRequiredFields.length) return safetyRequiredFields;
    return ['pregnancy_status'];
  }

  if (intent === INTENT_ENUM.RECO_PRODUCTS || intent === INTENT_ENUM.ROUTINE) {
    return getCoreProfileMissing(profile);
  }

  if (intent === INTENT_ENUM.EVALUATE_PRODUCT || intent === INTENT_ENUM.DUPE_COMPARE) {
    if (!hasAnchor) return ['anchor'];
    if (hasStrongActiveMention(message) && !profileHasValue(profile, 'pregnancy_status')) {
      return ['pregnancy_status'];
    }
    return [];
  }

  if (intent === INTENT_ENUM.TRAVEL_PLANNING || intent === INTENT_ENUM.WEATHER_ENV) {
    return getTravelMissing(profile);
  }

  if (intent === INTENT_ENUM.INGREDIENT_SCIENCE) {
    if (hasStrongActiveMention(message) && !profileHasValue(profile, 'pregnancy_status')) {
      return ['pregnancy_status'];
    }
    return [];
  }

  return [];
}

function computeGateType(intent, requiredFields, safetyDecision) {
  const missing = Array.isArray(requiredFields) ? requiredFields : [];
  if (
    safetyDecision &&
    typeof safetyDecision === 'object' &&
    String(safetyDecision.block_level || '').toUpperCase() === 'REQUIRE_INFO' &&
    missing.length > 0
  ) {
    return 'hard';
  }
  if (!missing.length) return 'none';

  if (intent === INTENT_ENUM.RECO_PRODUCTS || intent === INTENT_ENUM.ROUTINE) return 'hard';
  if (intent === INTENT_ENUM.EVALUATE_PRODUCT || intent === INTENT_ENUM.DUPE_COMPARE) {
    if (missing.includes('anchor')) return 'hard';
    return 'soft';
  }
  if (intent === INTENT_ENUM.TRAVEL_PLANNING || intent === INTENT_ENUM.WEATHER_ENV) return 'soft';
  if (intent === INTENT_ENUM.INGREDIENT_SCIENCE) return 'soft';
  return 'soft';
}

function pickQuestionTemplateId(intent, requiredFields) {
  const firstMissing = Array.isArray(requiredFields) && requiredFields.length ? requiredFields[0] : 'none';
  return `${String(intent || INTENT_ENUM.UNKNOWN)}:${firstMissing}`;
}

function normalizeLanguage(language) {
  return String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function normalizeSignatureParts(parts) {
  return parts
    .map((part) => String(part || '').trim().toLowerCase())
    .filter(Boolean)
    .join('|');
}

function buildLoopSignature({ intent, requiredFields, questionTemplateId, language }) {
  const missing = Array.isArray(requiredFields)
    ? requiredFields
        .map((field) => String(field || '').trim().toLowerCase())
        .filter(Boolean)
        .sort()
    : [];
  return normalizeSignatureParts([intent || INTENT_ENUM.UNKNOWN, missing.join(','), questionTemplateId, normalizeLanguage(language)]);
}

function readLoopStateFromSession(session) {
  const s = session && typeof session === 'object' ? session : null;
  const state = s && s.state && typeof s.state === 'object' && !Array.isArray(s.state) ? s.state : null;
  const loop = state && state[QA_LOOP_STATE_KEY] && typeof state[QA_LOOP_STATE_KEY] === 'object' && !Array.isArray(state[QA_LOOP_STATE_KEY])
    ? state[QA_LOOP_STATE_KEY]
    : null;
  if (!loop) return { signature: '', count: 0 };

  const signature = isNonEmptyString(loop.signature) ? loop.signature.trim() : '';
  const countRaw = Number(loop.count);
  const count = Number.isFinite(countRaw) ? Math.max(0, Math.min(9, Math.trunc(countRaw))) : 0;
  return { signature, count };
}

function computeLoopControl({ session, signature, profileDelta, anchorDelta }) {
  const prev = readLoopStateFromSession(session);

  if (profileDelta || anchorDelta) {
    return {
      loop_count: 0,
      break_applied: 'none',
      next_state_patch: {
        [QA_LOOP_STATE_KEY]: {
          signature,
          count: 0,
          updated_at_ms: Date.now(),
        },
      },
    };
  }

  const same = prev.signature && signature && prev.signature === signature;
  const count = same ? Math.min(9, prev.count + 1) : 1;

  let breakApplied = 'none';
  if (count >= 4) breakApplied = 'stop_asking';
  else if (count >= 3) breakApplied = 'conservative_defaults';
  else if (count >= 2) breakApplied = 'chips_single_question';

  return {
    loop_count: count,
    break_applied: breakApplied,
    next_state_patch: {
      [QA_LOOP_STATE_KEY]: {
        signature,
        count,
        updated_at_ms: Date.now(),
      },
    },
  };
}

function computeNextStep({ intent, gateType, requiredFields }) {
  if (gateType === 'hard' && requiredFields.length > 0) return 'ask';
  if (intent === INTENT_ENUM.TRAVEL_PLANNING || intent === INTENT_ENUM.WEATHER_ENV) {
    if (requiredFields.length) return 'ask';
    return 'tool_call';
  }
  if (gateType === 'soft' && requiredFields.length > 0) return 'ask';
  return 'upstream';
}

function resolveQuestionBudget(gateType, breakApplied) {
  if (breakApplied === 'stop_asking') return 0;
  if (breakApplied === 'chips_single_question') return 1;
  if (gateType === 'hard') return 1;
  return 2;
}

function resolveQaPlan({
  intent,
  profile,
  message,
  language,
  hasAnchor,
  session,
  safetyDecision = null,
  profileDelta = false,
  anchorDelta = false,
} = {}) {
  const safeIntent = Object.values(INTENT_ENUM).includes(intent) ? intent : INTENT_ENUM.UNKNOWN;
  const requiredFields = buildRequiredFields({ intent: safeIntent, profile, hasAnchor, message, safetyDecision });
  const gateType = computeGateType(safeIntent, requiredFields, safetyDecision);
  const questionTemplateId = pickQuestionTemplateId(safeIntent, requiredFields);
  const loopSignature = buildLoopSignature({
    intent: safeIntent,
    requiredFields,
    questionTemplateId,
    language,
  });
  const loop = computeLoopControl({ session, signature: loopSignature, profileDelta, anchorDelta });
  const questionBudget = resolveQuestionBudget(gateType, loop.break_applied);
  const nextStep = computeNextStep({ intent: safeIntent, gateType, requiredFields });
  const safetyRequireInfo =
    safetyDecision &&
    typeof safetyDecision === 'object' &&
    String(safetyDecision.block_level || '').toUpperCase() === 'REQUIRE_INFO';

  const canAnswerNow =
    !safetyRequireInfo &&
    (
      loop.break_applied === 'stop_asking' ||
      loop.break_applied === 'conservative_defaults' ||
      gateType === 'none' ||
      (gateType === 'soft' && requiredFields.length <= 1)
    );

  return {
    gate_type: gateType,
    question_budget: questionBudget,
    required_fields: requiredFields,
    can_answer_now: canAnswerNow,
    next_step: nextStep,
    loop_signature: loopSignature,
    loop_count: loop.loop_count,
    break_applied: loop.break_applied,
    session_state_patch: loop.next_state_patch,
  };
}

module.exports = {
  QA_LOOP_STATE_KEY,
  buildLoopSignature,
  resolveQaPlan,
  __internal: {
    getCoreProfileMissing,
    getTravelMissing,
    hasStrongActiveMention,
    buildRequiredFields,
    computeGateType,
    computeLoopControl,
  },
};
