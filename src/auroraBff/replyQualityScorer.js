const rubric = require('./specs/reply_quality_rubric.json');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAssistantMessage(message) {
  if (typeof message === 'string') {
    return { format: 'text', content: message };
  }
  if (!isPlainObject(message)) {
    return { format: 'text', content: '' };
  }
  const formatRaw = String(message.format || '').trim().toLowerCase();
  const format = formatRaw === 'markdown' ? 'markdown' : 'text';
  return {
    format,
    content: String(message.content || ''),
  };
}

function getCards(envelope) {
  return Array.isArray(envelope && envelope.cards) ? envelope.cards : [];
}

function getSessionPatch(envelope) {
  return isPlainObject(envelope && envelope.session_patch) ? envelope.session_patch : {};
}

function getSuggestedChips(envelope) {
  return Array.isArray(envelope && envelope.suggested_chips) ? envelope.suggested_chips : [];
}

function hasRecommendationsCard(cards) {
  return cards.some((card) => String(card && card.type || '').trim().toLowerCase() === 'recommendations');
}

function hasPendingClarificationCurrent(sessionPatch) {
  const state = isPlainObject(sessionPatch && sessionPatch.state) ? sessionPatch.state : {};
  const pending = isPlainObject(state.pending_clarification) ? state.pending_clarification : null;
  if (!pending) return false;
  if (isPlainObject(pending.current)) return true;
  return Boolean(String(pending.current || '').trim());
}

function countQuestions(text) {
  return (String(text || '').match(/[?？]/g) || []).length;
}

function countMarkdownBullets(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => /^\s*([-*]|\d+\.)\s+/.test(line.trim())).length;
}

function hasNullOfferInOffersResolved(cards) {
  for (const card of cards) {
    if (String(card && card.type || '').trim().toLowerCase() !== 'offers_resolved') continue;
    const payload = isPlainObject(card && card.payload) ? card.payload : {};

    if (Array.isArray(payload.items)) {
      for (const item of payload.items) {
        if (!isPlainObject(item) || item.offer == null) return true;
      }
    }

    for (const [key, value] of Object.entries(payload)) {
      if (/^items\[\d+\]\.offer$/i.test(String(key)) && value == null) return true;
    }
  }
  return false;
}

function compileRegexList(patterns) {
  return (Array.isArray(patterns) ? patterns : [])
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .map((p) => new RegExp(p, 'i'));
}

function matchesAny(text, regexes) {
  const raw = String(text || '');
  return regexes.some((rx) => rx.test(raw));
}

function scoreReplyQuality(envelope = {}) {
  const message = normalizeAssistantMessage(envelope.assistant_message);
  const cards = getCards(envelope);
  const sessionPatch = getSessionPatch(envelope);
  const chips = getSuggestedChips(envelope);

  const hardFailReasons = [];
  const diagnosisRegexes = compileRegexList(rubric.hard_fail && rubric.hard_fail.forbidden_medical_diagnosis_regex);
  const cureRegexes = compileRegexList(rubric.hard_fail && rubric.hard_fail.forbidden_absolute_cure_regex);
  if (matchesAny(message.content, diagnosisRegexes)) hardFailReasons.push('forbidden_medical_diagnosis_term');
  if (matchesAny(message.content, cureRegexes)) hardFailReasons.push('forbidden_absolute_cure_claim');

  const checks = Array.isArray(rubric.checks) ? rubric.checks : [];
  const breakdown = [];
  let total = 0;

  for (const check of checks) {
    const id = String(check && check.id || '').trim();
    const weight = Number(check && check.weight) > 0 ? Number(check.weight) : 0;
    let applicable = true;
    let passed = true;
    let reason = 'ok';

    if (id === 'message_length_budget') {
      if (message.format === 'markdown') {
        const overChars = message.content.length > Number(check.thresholds && check.thresholds.markdown_max_chars || 520);
        const overBullets = countMarkdownBullets(message.content) > Number(check.thresholds && check.thresholds.markdown_max_bullets || 6);
        passed = !overChars && !overBullets;
        if (!passed) reason = overChars ? 'markdown_chars_exceeded' : 'markdown_bullets_exceeded';
      } else {
        const overChars = message.content.length > Number(check.thresholds && check.thresholds.text_max_chars || 280);
        passed = !overChars;
        if (!passed) reason = 'text_chars_exceeded';
      }
    } else if (id === 'recommendations_state_gate') {
      const hasReco = hasRecommendationsCard(cards);
      applicable = hasReco;
      if (hasReco) {
        const nextState = String(sessionPatch.next_state || '').trim();
        passed = nextState.startsWith(String(check.thresholds && check.thresholds.next_state_prefix || 'RECO_'));
        if (!passed) reason = 'recommendations_outside_reco_state';
      } else {
        reason = 'not_applicable';
      }
    } else if (id === 'pending_clarification_chips_budget') {
      const hasPendingCurrent = hasPendingClarificationCurrent(sessionPatch);
      applicable = hasPendingCurrent;
      if (hasPendingCurrent) {
        const min = Number(check.thresholds && check.thresholds.min || 4);
        const max = Number(check.thresholds && check.thresholds.max || 10);
        passed = chips.length >= min && chips.length <= max;
        if (!passed) reason = chips.length < min ? 'chips_below_min' : 'chips_above_max';
      } else {
        reason = 'not_applicable';
      }
    } else if (id === 'pending_clarification_single_question') {
      const hasPendingCurrent = hasPendingClarificationCurrent(sessionPatch);
      applicable = hasPendingCurrent;
      if (hasPendingCurrent) {
        const maxQuestions = Number(check.thresholds && check.thresholds.max_questions || 1);
        const count = countQuestions(message.content);
        passed = count <= maxQuestions;
        if (!passed) reason = 'too_many_questions';
      } else {
        reason = 'not_applicable';
      }
    } else if (id === 'offers_null_no_stock_assertion') {
      const hasNullOffer = hasNullOfferInOffersResolved(cards);
      applicable = hasNullOffer;
      if (hasNullOffer) {
        const forbidden = compileRegexList(check.patterns && check.patterns.forbidden_positive);
        const negative = compileRegexList(check.patterns && check.patterns.allowed_negative);
        const hitsForbidden = matchesAny(message.content, forbidden);
        const hitsNegative = matchesAny(message.content, negative);
        passed = !(hitsForbidden && !hitsNegative);
        if (!passed) reason = 'asserted_in_stock_or_buy_now_with_null_offer';
      } else {
        reason = 'not_applicable';
      }
    }

    const score = passed ? weight : 0;
    total += score;
    breakdown.push({
      id,
      passed,
      score,
      max_score: weight,
      applicable,
      reason,
    });
  }

  if (hardFailReasons.length > 0) {
    return {
      total_score: Number(rubric.scoring && rubric.scoring.hard_fail_total_score || 0),
      breakdown,
      hard_fail_reasons: hardFailReasons,
    };
  }

  const maxTotal = Number(rubric.scoring && rubric.scoring.max_total_score || 100);
  return {
    total_score: Math.max(0, Math.min(maxTotal, total)),
    breakdown,
    hard_fail_reasons: [],
  };
}

module.exports = {
  REPLY_QUALITY_RUBRIC: rubric,
  scoreReplyQuality,
  __internal: {
    normalizeAssistantMessage,
    countQuestions,
    countMarkdownBullets,
    hasNullOfferInOffersResolved,
    hasPendingClarificationCurrent,
  },
};
