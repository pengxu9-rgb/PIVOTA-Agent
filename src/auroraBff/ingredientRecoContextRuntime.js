function defaultPickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function defaultNormalizeIngredientGoalToken(value) {
  return String(value || '').trim().toLowerCase();
}

function defaultNormalizeIngredientSensitivityToken(value) {
  return String(value || '').trim().toLowerCase() || 'unknown';
}

function defaultNormalizeIngredientCandidateList(raw, max = 6) {
  const source = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[、,;|/]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const text = String(item || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function defaultExtractActionDataObject(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  return action.data && typeof action.data === 'object' && !Array.isArray(action.data)
    ? action.data
    : null;
}

function createIngredientRecoContextRuntime(options = {}) {
  const {
    pickFirstTrimmed = defaultPickFirstTrimmed,
    normalizeIngredientGoalToken = defaultNormalizeIngredientGoalToken,
    normalizeIngredientSensitivityToken = defaultNormalizeIngredientSensitivityToken,
    normalizeIngredientCandidateList = defaultNormalizeIngredientCandidateList,
    extractActionDataObject = defaultExtractActionDataObject,
  } = options;

  function normalizeIngredientRecoContextValue(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const query = pickFirstTrimmed(
      raw.query,
      raw.ingredient_query,
      raw.ingredientQuery,
      raw.inci,
      raw.ingredient_name,
      raw.ingredientName,
    );
    const goal = normalizeIngredientGoalToken(
      pickFirstTrimmed(raw.goal, raw.ingredient_goal, raw.ingredientGoal, raw.target_goal, raw.effect_goal),
    );
    const sensitivity = normalizeIngredientSensitivityToken(
      pickFirstTrimmed(raw.sensitivity, raw.ingredient_sensitivity, raw.ingredientSensitivity, raw.skin_sensitivity),
    );
    const candidates = normalizeIngredientCandidateList(
      Array.isArray(raw.candidates)
        ? raw.candidates
        : Array.isArray(raw.ingredient_candidates)
          ? raw.ingredient_candidates
          : Array.isArray(raw.ingredientCandidates)
            ? raw.ingredientCandidates
            : [],
      8,
    );
    const productCandidatesRaw = Array.isArray(raw.product_candidates)
      ? raw.product_candidates
      : Array.isArray(raw.productCandidates)
        ? raw.productCandidates
        : [];
    const productCandidates = productCandidatesRaw
      .filter((p) => p && typeof p === 'object' && !Array.isArray(p))
      .slice(0, 12);
    const source = pickFirstTrimmed(raw.source, raw.entry_source, raw.trigger_source, raw.route_source);
    const updatedRaw = Number(raw.updated_at_ms || raw.updatedAtMs || 0);
    if (!query && !goal && candidates.length === 0) return null;
    const out = {
      ...(query ? { query: String(query).slice(0, 120) } : {}),
      ...(goal ? { goal } : {}),
      ...(candidates.length ? { candidates } : {}),
      ...(candidates.length ? { ingredient_candidates: candidates } : {}),
      ...(productCandidates.length ? { product_candidates: productCandidates } : {}),
      sensitivity: sensitivity || 'unknown',
      ...(source ? { source: String(source).slice(0, 48) } : {}),
    };
    if (Number.isFinite(updatedRaw) && updatedRaw > 0) {
      out.updated_at_ms = Math.trunc(updatedRaw);
    }
    return out;
  }

  function mergeIngredientRecoContextValue(base, patch) {
    const left = normalizeIngredientRecoContextValue(base);
    const right = normalizeIngredientRecoContextValue(patch);
    if (!left) return right;
    if (!right) return left;
    const mergedCandidates = normalizeIngredientCandidateList(
      [
        ...(Array.isArray(left.candidates) ? left.candidates : []),
        ...(Array.isArray(right.candidates) ? right.candidates : []),
      ],
      8,
    );
    const mergedProductCandidates = [
      ...(Array.isArray(right.product_candidates) ? right.product_candidates : []),
      ...(Array.isArray(left.product_candidates) ? left.product_candidates : []),
    ].filter((p) => p && typeof p === 'object' && !Array.isArray(p)).slice(0, 12);
    return {
      ...left,
      ...right,
      query: right.query || left.query || '',
      goal: right.goal || left.goal || '',
      ...(mergedCandidates.length ? { candidates: mergedCandidates, ingredient_candidates: mergedCandidates } : {}),
      ...(mergedProductCandidates.length ? { product_candidates: mergedProductCandidates } : {}),
      sensitivity: right.sensitivity || left.sensitivity || 'unknown',
      source: right.source || left.source || '',
      updated_at_ms: Math.max(
        Number.isFinite(Number(left.updated_at_ms)) ? Number(left.updated_at_ms) : 0,
        Number.isFinite(Number(right.updated_at_ms)) ? Number(right.updated_at_ms) : 0,
      ) || Date.now(),
    };
  }

  function extractIngredientRecoContext(action) {
    const data = extractActionDataObject(action);
    if (!data) return null;
    const goal = normalizeIngredientGoalToken(
      (typeof data.ingredient_goal === 'string' && data.ingredient_goal) ||
        (typeof data.goal === 'string' && data.goal) ||
        '',
    );
    const sensitivity = normalizeIngredientSensitivityToken(
      (typeof data.ingredient_sensitivity === 'string' && data.ingredient_sensitivity) ||
        (typeof data.sensitivity === 'string' && data.sensitivity) ||
        '',
    );
    const candidates = normalizeIngredientCandidateList(
      data.ingredient_candidates || data.ingredientCandidates || data.candidates || [],
      6,
    );
    if (!goal && !candidates.length && sensitivity === 'unknown') return null;
    return {
      goal: goal || '',
      sensitivity,
      candidates,
    };
  }

  return {
    normalizeIngredientRecoContextValue,
    mergeIngredientRecoContextValue,
    extractIngredientRecoContext,
  };
}

module.exports = {
  createIngredientRecoContextRuntime,
};
