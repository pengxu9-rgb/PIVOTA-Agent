const spec = require('./specs/agent_state_machine.json');

const DEFAULT_AGENT_STATE = (spec && spec.default_state) || 'IDLE_CHAT';

const CHIP_ALIASES = {
  'chip.start.diagnosis': 'chip_start_diagnosis',
  'chip.start.evaluate': 'chip_eval_single_product',
  'chip.start.reco_products': 'chip_get_recos',
  'chip.start.routine': 'chip_get_recos',
  'chip.action.reco_routine': 'chip_get_recos',
};

function normalizeAgentState(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return Array.isArray(spec.states) && spec.states.includes(s) ? s : DEFAULT_AGENT_STATE;
}

function canonicalizeChipId(chipId) {
  const id = String(chipId || '').trim();
  return CHIP_ALIASES[id] || id;
}

function findChip(chipId) {
  const id = canonicalizeChipId(chipId);
  const chips = Array.isArray(spec.chips) ? spec.chips : [];
  return chips.find((c) => c && c.chip_id === id) || null;
}

function validateRequestedTransition({ fromState, triggerSource, triggerId, requestedNextState }) {
  const from = normalizeAgentState(fromState);
  const to = normalizeAgentState(requestedNextState);
  const canonicalTriggerId = triggerSource === 'chip' ? canonicalizeChipId(triggerId) : String(triggerId || '').trim();

  if (to === from) return { ok: true, next_state: from, canonical_trigger_id: canonicalTriggerId };

  const allowedSources = Array.isArray(spec.trigger_source) ? spec.trigger_source : [];
  if (!allowedSources.includes(String(triggerSource || '').trim())) {
    return { ok: false, reason: 'TRIGGER_SOURCE_NOT_ALLOWED', canonical_trigger_id: canonicalTriggerId };
  }

  if (triggerSource === 'chip') {
    const chip = findChip(triggerId);
    if (!chip) return { ok: false, reason: 'UNKNOWN_CHIP', canonical_trigger_id: canonicalTriggerId };
    if (chip.next_state !== to) return { ok: false, reason: 'CHIP_NEXT_STATE_MISMATCH', canonical_trigger_id: canonicalTriggerId };
    const allowedStates = Array.isArray(chip.allowed_states) ? chip.allowed_states : [];
    if (!allowedStates.includes(from)) return { ok: false, reason: 'CHIP_NOT_ALLOWED_FROM_STATE', canonical_trigger_id: canonicalTriggerId };
    return { ok: true, next_state: to, canonical_trigger_id: canonicalTriggerId };
  }

  // action/text_explicit: allow only if a spec chip could reach that state from this state.
  const chips = Array.isArray(spec.chips) ? spec.chips : [];
  const reachable = chips.some((c) => c && c.next_state === to && Array.isArray(c.allowed_states) && c.allowed_states.includes(from));
  if (!reachable) return { ok: false, reason: 'NEXT_STATE_NOT_REACHABLE', canonical_trigger_id: canonicalTriggerId };

  return { ok: true, next_state: to, canonical_trigger_id: canonicalTriggerId };
}

function inferTextExplicitTransition(message, language) {
  const raw = String(message || '').trim();
  if (!raw) return null;
  const text = raw.toLowerCase();
  const lang = language === 'CN' ? 'CN' : 'EN';

  const wantsDiagnosis = lang === 'CN' ? /诊断/.test(raw) : /diagnose my skin/i.test(raw);
  if (wantsDiagnosis) return { requested_next_state: 'DIAG_PROFILE', trigger_id: raw.slice(0, 120) };

  const wantsRoutineReview = lang === 'CN' ? /评估我现在用的/.test(raw) : /review my routine/i.test(raw);
  if (wantsRoutineReview) return { requested_next_state: 'ROUTINE_INTAKE', trigger_id: raw.slice(0, 120) };

  const wantsRecs = lang === 'CN'
    ? /产品推荐/.test(raw) ||
      /推荐/.test(raw) ||
      /给我方案/.test(raw) ||
      /(想要|想买|要|求|求推荐|求推).*(精华|面霜|乳液|面膜|防晒|洁面|洗面奶|爽肤水|化妆水|护肤品|产品|平替|替代)/.test(raw)
    : /\brecommend\b/i.test(text) || /product recommendations?/i.test(text) || /build me a routine/i.test(text);
  if (wantsRecs) return { requested_next_state: 'RECO_GATE', trigger_id: raw.slice(0, 120) };

  return null;
}

function deriveRequestedTransitionFromAction({ fromState, actionId }) {
  const from = normalizeAgentState(fromState);
  const id = String(actionId || '').trim();
  if (!id) return null;

  const chip = findChip(id);
  if (!chip) return null;

  const allowedStates = Array.isArray(chip.allowed_states) ? chip.allowed_states : [];
  if (!allowedStates.includes(from)) return null;

  return { trigger_source: 'chip', trigger_id: id, requested_next_state: chip.next_state };
}

module.exports = {
  DEFAULT_AGENT_STATE,
  normalizeAgentState,
  canonicalizeChipId,
  validateRequestedTransition,
  inferTextExplicitTransition,
  deriveRequestedTransitionFromAction,
};
