const GATE_MODE = Object.freeze({
  BLOCK: 'block',
  ADVISORY: 'advisory',
  FILTER_ONLY: 'filter_only',
  BYPASS: 'bypass',
});

const DEFAULT_GATE_POLICY_VERSION = 'aurora_gate_policy_answer_first_v1';

const DEFAULT_POLICIES = Object.freeze({
  startup_fail_closed: { mode: GATE_MODE.ADVISORY, fallback_behavior: 'route_level_503' },
  safety_optional_profile: { mode: GATE_MODE.ADVISORY, fallback_behavior: 'inline_notice' },
  safety_hard_block: { mode: GATE_MODE.BLOCK, fallback_behavior: 'block' },
  diagnosis_first_profile_gate: { mode: GATE_MODE.ADVISORY, fallback_behavior: 'answer_with_assumptions' },
  artifact_missing_gate: { mode: GATE_MODE.ADVISORY, fallback_behavior: 'answer_with_low_confidence' },
  travel_missing_fields_gate: { mode: GATE_MODE.ADVISORY, fallback_behavior: 'answer_with_generic_strategy' },
  fit_check_anchor_gate: { mode: GATE_MODE.ADVISORY, fallback_behavior: 'answer_then_ask_anchor' },
  budget_gate: { mode: GATE_MODE.ADVISORY, fallback_behavior: 'optional_preference_collection' },
  frontend_state_transition_guard: { mode: GATE_MODE.ADVISORY, fallback_behavior: 'fallback_to_default_state' },
  product_reco_filters: { mode: GATE_MODE.FILTER_ONLY, fallback_behavior: 'keep_main_answer' },
  kb_quarantine_gate: { mode: GATE_MODE.FILTER_ONLY, fallback_behavior: 'recompute_and_refresh' },
});

function parseBooleanEnv(raw, fallback) {
  const normalized = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function dedupeStringArray(values, max = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === GATE_MODE.BLOCK) return GATE_MODE.BLOCK;
  if (mode === GATE_MODE.ADVISORY) return GATE_MODE.ADVISORY;
  if (mode === GATE_MODE.FILTER_ONLY) return GATE_MODE.FILTER_ONLY;
  return GATE_MODE.BYPASS;
}

const ANSWER_FIRST_ENABLED = parseBooleanEnv(process.env.AURORA_GATE_POLICY_ANSWER_FIRST_ENABLED, true);
const GATE_POLICY_VERSION = String(process.env.AURORA_GATE_POLICY_VERSION || DEFAULT_GATE_POLICY_VERSION).trim() || DEFAULT_GATE_POLICY_VERSION;

function resolveGateDecision(ctx = {}, gateId, input = {}) {
  const id = String(gateId || '').trim() || 'unknown_gate';
  const policy = DEFAULT_POLICIES[id] || { mode: GATE_MODE.BYPASS, fallback_behavior: 'none' };
  const reasonCodes = dedupeStringArray(input.reason_codes || input.reasonCodes || [], 10);

  let mode = normalizeMode(policy.mode);
  if (!ANSWER_FIRST_ENABLED && mode !== GATE_MODE.FILTER_ONLY) {
    mode = normalizeMode(input.legacy_mode || GATE_MODE.BLOCK);
  }
  if (id === 'safety_hard_block' && !Boolean(input.is_hard_contraindication)) {
    mode = GATE_MODE.ADVISORY;
  }

  const source = String(ctx.source || 'aurora').trim();
  return {
    gate_id: id,
    mode,
    fallback_behavior: policy.fallback_behavior || 'none',
    reason_codes: reasonCodes,
    source,
  };
}

module.exports = {
  GATE_MODE,
  GATE_POLICY_VERSION,
  ANSWER_FIRST_ENABLED,
  DEFAULT_POLICIES,
  resolveGateDecision,
};
