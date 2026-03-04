const { runSkill } = require('./contracts');

const CORE_SKIN_STATE_FIELDS = Object.freeze([
  'skinType',
  'sensitivity',
  'barrierStatus',
  'goals',
]);

function pickFirst(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function normalizeGoalList(raw) {
  const source = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,;/|]/g)
      : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const value = String(item || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeStringList(raw, maxItems = 8) {
  const source = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,;/|]/g)
      : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const value = String(item || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeSkinStateSelectionInput({ profile, selections } = {}) {
  const profileNode = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
  const selectionNode = selections && typeof selections === 'object' && !Array.isArray(selections) ? selections : {};

  const skinType = pickFirst(
    selectionNode.skinType,
    selectionNode.skin_type,
    profileNode.skinType,
    profileNode.skin_type,
  );
  const sensitivity = pickFirst(
    selectionNode.sensitivity,
    selectionNode.skin_sensitivity,
    profileNode.sensitivity,
    profileNode.skin_sensitivity,
  );
  const barrierStatus = pickFirst(
    selectionNode.barrierStatus,
    selectionNode.barrier_status,
    profileNode.barrierStatus,
    profileNode.barrier_status,
  );
  const goals = normalizeGoalList(
    selectionNode.goals != null ? selectionNode.goals : profileNode.goals,
  );
  const contraindications = normalizeStringList(
    selectionNode.contraindications != null
      ? selectionNode.contraindications
      : profileNode.contraindications,
    10,
  );

  return {
    ...(skinType ? { skinType } : {}),
    ...(sensitivity ? { sensitivity } : {}),
    ...(barrierStatus ? { barrierStatus } : {}),
    goals,
    contraindications,
  };
}

function computeMissingFields(normalized, requiredFields = CORE_SKIN_STATE_FIELDS) {
  const missing = [];
  const required = Array.isArray(requiredFields) && requiredFields.length
    ? requiredFields
    : CORE_SKIN_STATE_FIELDS;
  for (const field of required) {
    const key = String(field || '').trim();
    if (!key) continue;
    const value = normalized[key];
    if (key === 'goals') {
      if (!Array.isArray(value) || value.length === 0) missing.push('goals');
      continue;
    }
    if (!value || (typeof value === 'string' && !value.trim())) missing.push(key);
  }
  return missing;
}

async function runSkinStateSelectionSkill({
  requestContext,
  logger,
  profile,
  selections,
  message,
  requiredFields = CORE_SKIN_STATE_FIELDS,
} = {}) {
  return runSkill({
    skillName: 'skin_state_selection',
    stage: 'skin_state_selection',
    provider: 'local_rules',
    requestContext,
    logger,
    run: async () => {
      const normalized = normalizeSkinStateSelectionInput({ profile, selections });
      const missing = computeMissingFields(normalized, requiredFields);
      return {
        normalized_skin_state: normalized,
        missing_fields: missing,
        has_message: Boolean(String(message || '').trim()),
      };
    },
  });
}

module.exports = {
  CORE_SKIN_STATE_FIELDS,
  normalizeSkinStateSelectionInput,
  runSkinStateSelectionSkill,
};

