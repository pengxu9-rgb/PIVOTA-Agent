const LOW_CONFIDENCE_THRESHOLD = 0.55;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.75;

const ACTIVE_INGREDIENTS = new Set([
  'retinol',
  'salicylic_acid',
  'ascorbic_acid',
  'benzoyl_peroxide',
  'azelaic_acid',
]);

const STRONG_INGREDIENTS = new Set([
  'retinol',
  'salicylic_acid',
  'benzoyl_peroxide',
]);

const INGREDIENT_USAGE_GUIDANCE = Object.freeze({
  ceramide_np: ['AM/PM as barrier support', 'Prefer moisturizer or barrier serum forms'],
  panthenol: ['AM/PM soothing support', 'Use after cleansing on damp skin'],
  niacinamide: ['Start once daily if sensitive', 'Increase to AM/PM after tolerance'],
  zinc_pca: ['Best for oily zones', 'Keep cleanser gentle to avoid rebound oil'],
  salicylic_acid: ['Start 2-3 nights/week', 'Avoid pairing with retinoid same night'],
  azelaic_acid: ['Start 2-3 nights/week', 'Increase frequency only if comfortable'],
  ascorbic_acid: ['Prefer AM use', 'Always pair with sunscreen'],
  retinol: ['Night only and low frequency first', 'Barrier should be stable before use'],
  benzoyl_peroxide: ['Spot treatment first', 'Reduce if dryness/peeling appears'],
  sunscreen_filters: ['Daily AM final step', 'Reapply when sun exposure is extended'],
  glycerin: ['AM/PM hydration support', 'Layer with moisturizer for better retention'],
  hyaluronic_acid: ['Apply on damp skin', 'Seal with moisturizer'],
});

const RISKY_FOR_FRAGILE = new Set([
  'retinol',
  'salicylic_acid',
  'benzoyl_peroxide',
  'ascorbic_acid',
]);

const INGREDIENT_RULES = Object.freeze([
  {
    rule_id: 'R_BARRIER_001',
    when: { barrierStatusIn: ['impaired', 'compromised', 'damaged', 'weak'] },
    then: {
      setIntensity: 'gentle',
      addTargets: [{ ingredient_id: 'ceramide_np', basePriority: 92, role: 'hero' }],
      addConflictMessage: 'Barrier appears fragile, so repair-first strategy is applied.',
    },
  },
  {
    rule_id: 'R_BARRIER_002',
    when: { barrierStatusIn: ['impaired', 'compromised', 'damaged', 'weak'] },
    then: {
      addTargets: [{ ingredient_id: 'panthenol', basePriority: 86, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_BARRIER_003',
    when: { barrierStatusIn: ['impaired', 'compromised', 'damaged', 'weak'] },
    then: {
      addTargets: [{ ingredient_id: 'glycerin', basePriority: 72, role: 'support' }],
    },
  },
  {
    rule_id: 'R_BARRIER_004',
    when: { barrierStatusIn: ['impaired', 'compromised', 'damaged', 'weak'] },
    then: {
      addAvoids: [{ ingredient_id: 'retinol', severity: 'caution' }],
    },
  },
  {
    rule_id: 'R_BARRIER_005',
    when: { barrierStatusIn: ['impaired', 'compromised', 'damaged', 'weak'] },
    then: {
      addAvoids: [{ ingredient_id: 'salicylic_acid', severity: 'caution' }],
    },
  },
  {
    rule_id: 'R_SENS_001',
    when: { sensitivityIn: ['high'] },
    then: {
      setIntensity: 'gentle',
      addTargets: [{ ingredient_id: 'panthenol', basePriority: 80, role: 'hero' }],
      addConflictMessage: 'High sensitivity detected; aggressive actives are deprioritized.',
    },
  },
  {
    rule_id: 'R_SENS_002',
    when: { sensitivityIn: ['high'] },
    then: {
      addAvoids: [{ ingredient_id: 'retinol', severity: 'avoid' }],
    },
  },
  {
    rule_id: 'R_SENS_003',
    when: { sensitivityIn: ['high'] },
    then: {
      addAvoids: [{ ingredient_id: 'benzoyl_peroxide', severity: 'caution' }],
    },
  },
  {
    rule_id: 'R_SENS_004',
    when: { sensitivityIn: ['high', 'medium'] },
    then: {
      addAvoids: [{ ingredient_id: 'ascorbic_acid', severity: 'caution' }],
    },
  },
  {
    rule_id: 'R_SENS_005',
    when: { sensitivityIn: ['medium'] },
    then: {
      addTargets: [{ ingredient_id: 'niacinamide', basePriority: 66, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ACNE_001',
    when: { concernsAny: ['acne', 'breakout', 'blemish'] },
    then: {
      setIntensity: 'active',
      addTargets: [{ ingredient_id: 'salicylic_acid', basePriority: 78, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_ACNE_002',
    when: { concernsAny: ['acne', 'breakout', 'blemish'] },
    then: {
      addTargets: [{ ingredient_id: 'niacinamide', basePriority: 70, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ACNE_003',
    when: { concernsAny: ['acne', 'breakout', 'blemish'] },
    then: {
      addTargets: [{ ingredient_id: 'zinc_pca', basePriority: 67, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ACNE_004',
    when: { concernsAny: ['acne', 'breakout', 'blemish'], minConfidence: 0.65 },
    then: {
      addTargets: [{ ingredient_id: 'azelaic_acid', basePriority: 64, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ACNE_005',
    when: { concernsAny: ['acne', 'breakout', 'blemish'], minConfidence: 0.7 },
    then: {
      addTargets: [{ ingredient_id: 'benzoyl_peroxide', basePriority: 60, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ACNE_006',
    when: { concernsAny: ['acne', 'breakout', 'blemish'] },
    then: {
      addConflictMessage: 'Avoid stacking multiple strong acne actives on the same night.',
    },
  },
  {
    rule_id: 'R_REDNESS_001',
    when: { concernsAny: ['redness', 'irritation', 'reactive'] },
    then: {
      setIntensity: 'gentle',
      addTargets: [{ ingredient_id: 'panthenol', basePriority: 84, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_REDNESS_002',
    when: { concernsAny: ['redness', 'irritation', 'reactive'] },
    then: {
      addTargets: [{ ingredient_id: 'ceramide_np', basePriority: 76, role: 'support' }],
    },
  },
  {
    rule_id: 'R_REDNESS_003',
    when: { concernsAny: ['redness', 'irritation', 'reactive'] },
    then: {
      addAvoids: [{ ingredient_id: 'retinol', severity: 'caution' }],
    },
  },
  {
    rule_id: 'R_REDNESS_004',
    when: { concernsAny: ['redness', 'irritation', 'reactive'] },
    then: {
      addAvoids: [{ ingredient_id: 'salicylic_acid', severity: 'caution' }],
    },
  },
  {
    rule_id: 'R_TEXTURE_001',
    when: { concernsAny: ['texture', 'pores', 'roughness'] },
    then: {
      setIntensity: 'active',
      addTargets: [{ ingredient_id: 'salicylic_acid', basePriority: 73, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_TEXTURE_002',
    when: { concernsAny: ['texture', 'pores', 'roughness'] },
    then: {
      addTargets: [{ ingredient_id: 'niacinamide', basePriority: 64, role: 'support' }],
    },
  },
  {
    rule_id: 'R_TEXTURE_003',
    when: { concernsAny: ['texture', 'pores', 'roughness'], minConfidence: 0.7 },
    then: {
      addTargets: [{ ingredient_id: 'retinol', basePriority: 58, role: 'support' }],
    },
  },
  {
    rule_id: 'R_TEXTURE_004',
    when: { concernsAny: ['texture', 'pores', 'roughness'] },
    then: {
      addConflictMessage: 'Keep exfoliating acids and retinoids on separate nights.',
    },
  },
  {
    rule_id: 'R_TONE_001',
    when: { concernsAny: ['tone', 'dark_spots', 'hyperpigmentation', 'dullness'] },
    then: {
      addTargets: [{ ingredient_id: 'ascorbic_acid', basePriority: 71, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_TONE_002',
    when: { concernsAny: ['tone', 'dark_spots', 'hyperpigmentation', 'dullness'] },
    then: {
      addTargets: [{ ingredient_id: 'niacinamide', basePriority: 69, role: 'support' }],
    },
  },
  {
    rule_id: 'R_TONE_003',
    when: { concernsAny: ['tone', 'dark_spots', 'hyperpigmentation', 'dullness'], minConfidence: 0.7 },
    then: {
      addTargets: [{ ingredient_id: 'azelaic_acid', basePriority: 62, role: 'support' }],
    },
  },
  {
    rule_id: 'R_TONE_004',
    when: { concernsAny: ['tone', 'dark_spots', 'hyperpigmentation', 'dullness'] },
    then: {
      addTargets: [{ ingredient_id: 'sunscreen_filters', basePriority: 95, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_DEHY_001',
    when: { concernsAny: ['dehydration', 'dryness', 'tightness'] },
    then: {
      setIntensity: 'gentle',
      addTargets: [{ ingredient_id: 'hyaluronic_acid', basePriority: 74, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_DEHY_002',
    when: { concernsAny: ['dehydration', 'dryness', 'tightness'] },
    then: {
      addTargets: [{ ingredient_id: 'glycerin', basePriority: 68, role: 'support' }],
    },
  },
  {
    rule_id: 'R_DEHY_003',
    when: { concernsAny: ['dehydration', 'dryness', 'tightness'] },
    then: {
      addTargets: [{ ingredient_id: 'ceramide_np', basePriority: 72, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ANTIAGE_001',
    when: { concernsAny: ['wrinkles', 'anti_aging', 'firmness', 'fine_lines'], minConfidence: 0.65 },
    then: {
      setIntensity: 'active',
      addTargets: [{ ingredient_id: 'retinol', basePriority: 70, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_ANTIAGE_002',
    when: { concernsAny: ['wrinkles', 'anti_aging', 'firmness', 'fine_lines'] },
    then: {
      addTargets: [{ ingredient_id: 'niacinamide', basePriority: 62, role: 'support' }],
    },
  },
  {
    rule_id: 'R_ANTIAGE_003',
    when: { concernsAny: ['wrinkles', 'anti_aging', 'firmness', 'fine_lines'] },
    then: {
      addTargets: [{ ingredient_id: 'sunscreen_filters', basePriority: 95, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_ANTIAGE_004',
    when: { concernsAny: ['wrinkles', 'anti_aging', 'firmness', 'fine_lines'] },
    then: {
      addConflictMessage: 'If irritation appears, pull back to repair-only for 7-14 days.',
    },
  },
  {
    rule_id: 'R_SKINTYPE_001',
    when: { skinTypeIn: ['oily', 'combination'] },
    then: {
      addTargets: [{ ingredient_id: 'niacinamide', basePriority: 60, role: 'support' }],
    },
  },
  {
    rule_id: 'R_SKINTYPE_002',
    when: { skinTypeIn: ['oily', 'combination'] },
    then: {
      addTargets: [{ ingredient_id: 'zinc_pca', basePriority: 55, role: 'support' }],
    },
  },
  {
    rule_id: 'R_SKINTYPE_003',
    when: { skinTypeIn: ['dry'] },
    then: {
      addTargets: [{ ingredient_id: 'ceramide_np', basePriority: 74, role: 'hero' }],
    },
  },
  {
    rule_id: 'R_SKINTYPE_004',
    when: { skinTypeIn: ['dry'] },
    then: {
      addTargets: [{ ingredient_id: 'hyaluronic_acid', basePriority: 66, role: 'support' }],
    },
  },
  {
    rule_id: 'R_GOAL_001',
    when: { concernsAny: ['goal_acne', 'goal_breakout'] },
    then: {
      addTargets: [{ ingredient_id: 'salicylic_acid', basePriority: 60, role: 'support' }],
    },
  },
  {
    rule_id: 'R_GOAL_002',
    when: { concernsAny: ['goal_redness', 'goal_barrier'] },
    then: {
      addTargets: [{ ingredient_id: 'ceramide_np', basePriority: 70, role: 'support' }],
    },
  },
  {
    rule_id: 'R_GOAL_003',
    when: { concernsAny: ['goal_dark_spots', 'goal_brightening'] },
    then: {
      addTargets: [{ ingredient_id: 'ascorbic_acid', basePriority: 58, role: 'support' }],
    },
  },
  {
    rule_id: 'R_BASE_001',
    when: { minConfidence: 0 },
    then: {
      addTargets: [{ ingredient_id: 'sunscreen_filters', basePriority: 96, role: 'hero' }],
    },
  },
]);

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function confidenceLevelFromScore(score) {
  const s = clamp01(score);
  if (s < LOW_CONFIDENCE_THRESHOLD) return 'low';
  if (s <= MEDIUM_CONFIDENCE_THRESHOLD) return 'medium';
  return 'high';
}

function normalizeValueNode(node) {
  if (!node) return { value: null, confidence: 0, evidence: [] };
  if (typeof node === 'string') return { value: node, confidence: 0.65, evidence: [] };
  if (typeof node !== 'object' || Array.isArray(node)) return { value: null, confidence: 0, evidence: [] };
  const value = typeof node.value === 'string' ? node.value : null;
  const confidenceObj = node.confidence && typeof node.confidence === 'object' ? node.confidence : null;
  const confidence = confidenceObj ? clamp01(confidenceObj.score) : 0.65;
  const evidence = Array.isArray(node.evidence) ? node.evidence : [];
  return { value, confidence, evidence };
}

function normalizeMultiNode(node) {
  if (!node) return { values: [], confidence: 0, evidence: [] };
  if (Array.isArray(node)) return { values: node.map((v) => normalizeToken(v)).filter(Boolean), confidence: 0.65, evidence: [] };
  if (typeof node !== 'object') return { values: [], confidence: 0, evidence: [] };
  const rawValues = Array.isArray(node.values) ? node.values : [];
  const values = rawValues.map((v) => normalizeToken(v)).filter(Boolean);
  const confidenceObj = node.confidence && typeof node.confidence === 'object' ? node.confidence : null;
  const confidence = confidenceObj ? clamp01(confidenceObj.score) : values.length ? 0.65 : 0;
  const evidence = Array.isArray(node.evidence) ? node.evidence : [];
  return { values, confidence, evidence };
}

function pickConcerns(artifact) {
  const out = [];
  const concerns = asArray(artifact && artifact.concerns);
  for (const item of concerns) {
    if (!item) continue;
    if (typeof item === 'string') {
      const id = normalizeToken(item);
      if (!id) continue;
      out.push({ id, confidence: 0.62, evidence: [] });
      continue;
    }
    if (typeof item !== 'object' || Array.isArray(item)) continue;
    const id = normalizeToken(item.id || item.concern_id || item.value);
    if (!id) continue;
    const confidenceObj = item.confidence && typeof item.confidence === 'object' ? item.confidence : null;
    const confidence = confidenceObj ? clamp01(confidenceObj.score) : 0.62;
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    out.push({ id, confidence, evidence });
  }
  return out;
}

function mapGoalsToConcernTokens(goalValues) {
  const out = [];
  for (const goal of asArray(goalValues)) {
    const token = normalizeToken(goal);
    if (!token) continue;
    out.push(`goal_${token}`);
    if (token.includes('acne')) out.push('acne');
    if (token.includes('red')) out.push('redness');
    if (token.includes('barrier')) out.push('barrier');
    if (token.includes('dark') || token.includes('spot') || token.includes('tone') || token.includes('bright')) out.push('tone');
    if (token.includes('wrinkle') || token.includes('aging') || token.includes('anti_age')) out.push('anti_aging');
  }
  return out;
}

function hasTokenMatch(value, tokens) {
  const base = normalizeToken(value);
  if (!base) return false;
  for (const rawToken of asArray(tokens)) {
    const token = normalizeToken(rawToken);
    if (!token) continue;
    if (base === token) return true;
    if (base.includes(token) || token.includes(base)) return true;
  }
  return false;
}

function computeArtifactOverallConfidence(artifact) {
  const skinType = normalizeValueNode(artifact && artifact.skinType);
  const barrier = normalizeValueNode(artifact && artifact.barrierStatus);
  const sensitivity = normalizeValueNode(artifact && artifact.sensitivity);
  const goals = normalizeMultiNode(artifact && artifact.goals);
  const concerns = pickConcerns(artifact);

  const weighted = [
    { score: skinType.value ? skinType.confidence : 0, weight: 0.25 },
    { score: barrier.value ? barrier.confidence : 0, weight: 0.25 },
    { score: sensitivity.value ? sensitivity.confidence : 0, weight: 0.25 },
    { score: goals.values.length ? goals.confidence : 0, weight: 0.25 },
  ];
  const weightedScore = weighted.reduce((sum, item) => sum + item.score * item.weight, 0);
  const concernBoost =
    concerns.length > 0
      ? Math.min(0.1, concerns.reduce((sum, item) => sum + clamp01(item.confidence), 0) / concerns.length * 0.12)
      : 0;

  let score = clamp01(weightedScore + concernBoost);
  const rationale = [];

  const usePhoto = artifact && artifact.use_photo === true;
  const photos = asArray(artifact && artifact.photos);
  const qcTokens = photos
    .map((item) => normalizeToken(item && item.qc_status))
    .filter(Boolean);
  const hasFailQc = qcTokens.some((token) => token === 'fail' || token === 'failed' || token === 'reject' || token === 'rejected');
  const hasDegradedQc = qcTokens.some((token) => token === 'degraded' || token === 'warn' || token === 'low' || token === 'warning');

  if (hasFailQc) {
    score = Math.min(score, LOW_CONFIDENCE_THRESHOLD - 0.01);
    rationale.push('photo_qc_failed');
  } else if (hasDegradedQc) {
    score = clamp01(score - 0.1);
    rationale.push('photo_qc_degraded');
  }

  if (!usePhoto) {
    score = Math.min(score, MEDIUM_CONFIDENCE_THRESHOLD);
    rationale.push('no_photo_input');
  }

  const analysisSource = normalizeToken(artifact && artifact.analysis_context && artifact.analysis_context.analysis_source);
  if (analysisSource === 'baseline_low_confidence' || analysisSource === 'retake') {
    score = Math.min(score, LOW_CONFIDENCE_THRESHOLD - 0.01);
    rationale.push('low_confidence_fallback');
  }

  const level = confidenceLevelFromScore(score);
  return { score, level, rationale };
}

function collectCurrentRoutineTokens(profile) {
  const routine = profile && profile.currentRoutine !== undefined ? profile.currentRoutine : null;
  if (!routine) return [];
  const text =
    typeof routine === 'string'
      ? routine
      : (() => {
          try {
            return JSON.stringify(routine);
          } catch {
            return '';
          }
        })();
  return normalizeToken(text).split('_').filter(Boolean);
}

function ruleMatches(rule, context) {
  const when = rule && rule.when && typeof rule.when === 'object' ? rule.when : {};
  if (Number.isFinite(Number(when.minConfidence)) && context.overallConfidence.score < Number(when.minConfidence)) return false;
  if (Array.isArray(when.concernsAny) && when.concernsAny.length > 0) {
    const matched = when.concernsAny.some((token) => context.concernTokens.has(normalizeToken(token)));
    if (!matched) return false;
  }
  if (Array.isArray(when.barrierStatusIn) && when.barrierStatusIn.length > 0) {
    if (!hasTokenMatch(context.barrierStatus, when.barrierStatusIn)) return false;
  }
  if (Array.isArray(when.sensitivityIn) && when.sensitivityIn.length > 0) {
    if (!hasTokenMatch(context.sensitivity, when.sensitivityIn)) return false;
  }
  if (Array.isArray(when.skinTypeIn) && when.skinTypeIn.length > 0) {
    if (!hasTokenMatch(context.skinType, when.skinTypeIn)) return false;
  }
  return true;
}

function mergeIntensity(current, incoming) {
  const c = normalizeToken(current);
  const n = normalizeToken(incoming);
  const valid = new Set(['gentle', 'balanced', 'active']);
  const base = valid.has(c) ? c : 'balanced';
  if (!valid.has(n)) return base;
  if (base === 'gentle' || n === 'gentle') return 'gentle';
  if (base === 'active' || n === 'active') return 'active';
  return 'balanced';
}

function buildRuleEvidence(ruleId, supports = []) {
  return {
    source: 'rule',
    supports: Array.isArray(supports) ? supports : [],
    ref: { type: 'rule_id', id: String(ruleId || '').trim() || 'rule_unknown' },
    reliabilityWeight: 0.9,
  };
}

function buildConfidence(score, rationale) {
  const normalized = clamp01(score);
  return {
    score: normalized,
    level: confidenceLevelFromScore(normalized),
    rationale: Array.from(new Set(asArray(rationale).map((r) => String(r || '').trim()).filter(Boolean))).slice(0, 6),
  };
}

function normalizeIngredientGuidance(ingredientId) {
  const id = String(ingredientId || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(INGREDIENT_USAGE_GUIDANCE, id)) {
    return INGREDIENT_USAGE_GUIDANCE[id].slice(0, 4);
  }
  return ['Introduce gradually and monitor skin response.'];
}

function buildLowConfidencePlan({ artifact, profile, overallConfidence } = {}) {
  const evidence = [
    buildRuleEvidence('R_LOWCONF_001', ['overall_confidence']),
    { source: 'profile', supports: ['goals', 'sensitivity'], reliabilityWeight: 0.6 },
  ];
  const targets = [
    { ingredient_id: 'ceramide_np', role: 'hero', priority: 90 },
    { ingredient_id: 'panthenol', role: 'hero', priority: 86 },
    { ingredient_id: 'sunscreen_filters', role: 'hero', priority: 95 },
  ].map((item) => ({
    ...item,
    usage_guidance: normalizeIngredientGuidance(item.ingredient_id),
    confidence: buildConfidence(Math.min(0.72, overallConfidence.score + 0.12), ['low_confidence_gentle_only']),
    evidence,
  }));

  const avoid = ['retinol', 'salicylic_acid', 'benzoyl_peroxide'].map((ingredientId) => ({
    ingredient_id: ingredientId,
    reason: ['Low-confidence mode: avoid high-irritation actives until better evidence is available.'],
    severity: 'avoid',
    confidence: buildConfidence(0.82, ['low_confidence_safety_guard']),
    evidence: [buildRuleEvidence('R_LOWCONF_002', ['avoid'])],
  }));

  return {
    created_at: new Date().toISOString(),
    intensity: 'gentle',
    targets,
    avoid,
    conflicts: [
      {
        id: 'low_confidence_guard',
        description: 'Because confidence is low, this plan stays on repair + hydration + sunscreen.',
        evidence: [buildRuleEvidence('R_LOWCONF_003', ['conflicts'])],
      },
    ],
  };
}

function buildIngredientPlan({ artifact, profile } = {}) {
  const overallConfidence = computeArtifactOverallConfidence(artifact || {});
  if (overallConfidence.level === 'low') {
    return {
      ...buildLowConfidencePlan({ artifact, profile, overallConfidence }),
      confidence: buildConfidence(overallConfidence.score, overallConfidence.rationale),
    };
  }

  const skinTypeNode = normalizeValueNode(artifact && artifact.skinType);
  const barrierNode = normalizeValueNode(artifact && artifact.barrierStatus);
  const sensitivityNode = normalizeValueNode(artifact && artifact.sensitivity);
  const goalsNode = normalizeMultiNode(artifact && artifact.goals);
  const concernItems = pickConcerns(artifact);
  const concernTokens = new Set(concernItems.map((item) => item.id));
  for (const goalToken of mapGoalsToConcernTokens(goalsNode.values)) concernTokens.add(goalToken);

  const context = {
    skinType: skinTypeNode.value,
    barrierStatus: barrierNode.value,
    sensitivity: sensitivityNode.value,
    concernTokens,
    overallConfidence,
  };

  const currentRoutineTokens = collectCurrentRoutineTokens(profile);
  const barrierFragile = hasTokenMatch(barrierNode.value, ['impaired', 'compromised', 'damaged', 'weak']);
  const sensitivityHigh = hasTokenMatch(sensitivityNode.value, ['high']);

  const targetMap = new Map();
  const avoidMap = new Map();
  const conflicts = [];
  let intensity = 'balanced';

  for (const rule of INGREDIENT_RULES) {
    if (!ruleMatches(rule, context)) continue;
    const then = rule.then && typeof rule.then === 'object' ? rule.then : {};
    intensity = mergeIntensity(intensity, then.setIntensity);

    for (const target of asArray(then.addTargets)) {
      const ingredientId = normalizeToken(target && target.ingredient_id);
      if (!ingredientId) continue;
      const basePriority = Math.max(1, Math.min(100, Number(target.basePriority || 50)));
      const role = String(target && target.role || 'support') === 'hero' ? 'hero' : 'support';
      const current = targetMap.get(ingredientId) || {
        ingredient_id: ingredientId,
        role,
        basePriority: 0,
        rationale: [],
        evidence: [],
      };
      current.role = current.role === 'hero' || role === 'hero' ? 'hero' : 'support';
      current.basePriority = Math.max(current.basePriority, basePriority);
      current.rationale.push(rule.rule_id);
      current.evidence.push(buildRuleEvidence(rule.rule_id, ['ingredient_targets']));
      targetMap.set(ingredientId, current);
    }

    for (const avoid of asArray(then.addAvoids)) {
      const ingredientId = normalizeToken(avoid && avoid.ingredient_id);
      if (!ingredientId) continue;
      const severity = String(avoid && avoid.severity || 'caution').toLowerCase() === 'avoid' ? 'avoid' : 'caution';
      const current = avoidMap.get(ingredientId) || {
        ingredient_id: ingredientId,
        reason: [],
        severity,
        evidence: [],
      };
      current.severity = current.severity === 'avoid' || severity === 'avoid' ? 'avoid' : 'caution';
      current.reason.push(`Triggered by ${rule.rule_id}`);
      current.evidence.push(buildRuleEvidence(rule.rule_id, ['ingredient_avoid']));
      avoidMap.set(ingredientId, current);
    }

    if (typeof then.addConflictMessage === 'string' && then.addConflictMessage.trim()) {
      conflicts.push({
        id: rule.rule_id,
        description: then.addConflictMessage.trim(),
        evidence: [buildRuleEvidence(rule.rule_id, ['conflicts'])],
      });
    }
  }

  const targets = Array.from(targetMap.values())
    .map((target) => {
      const ingredientId = target.ingredient_id;
      const base = Number(target.basePriority || 0);
      let barrierMult = 1;
      let sensitivityMult = 1;
      let routineMult = 1;
      if (barrierFragile && RISKY_FOR_FRAGILE.has(ingredientId)) barrierMult = 0.55;
      if (sensitivityHigh && STRONG_INGREDIENTS.has(ingredientId)) sensitivityMult = 0.5;
      if (currentRoutineTokens.some((token) => token.includes(ingredientId))) routineMult = 0.85;

      const computedPriority = Math.max(
        5,
        Math.min(
          100,
          Math.round(base * clamp01(overallConfidence.score || 0.6) * barrierMult * sensitivityMult * routineMult),
        ),
      );
      return {
        ingredient_id: ingredientId,
        role: target.role,
        priority: computedPriority,
        usage_guidance: normalizeIngredientGuidance(ingredientId),
        confidence: buildConfidence(Math.min(0.95, overallConfidence.score * 0.9 + 0.08), target.rationale),
        evidence: target.evidence.slice(0, 8),
      };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 10);

  const avoid = Array.from(avoidMap.values())
    .map((item) => ({
      ingredient_id: item.ingredient_id,
      reason: Array.from(new Set(item.reason.map((raw) => String(raw || '').trim()).filter(Boolean))).slice(0, 4),
      severity: item.severity,
      confidence: buildConfidence(Math.min(0.95, overallConfidence.score * 0.85 + 0.1), ['rule_based_avoid']),
      evidence: item.evidence.slice(0, 8),
    }))
    .slice(0, 10);

  if (barrierFragile || sensitivityHigh) intensity = 'gentle';
  if (overallConfidence.level === 'medium' && intensity === 'active') intensity = 'balanced';

  return {
    created_at: new Date().toISOString(),
    intensity,
    targets,
    avoid,
    conflicts: conflicts.slice(0, 8),
    confidence: buildConfidence(overallConfidence.score, overallConfidence.rationale),
  };
}

module.exports = {
  LOW_CONFIDENCE_THRESHOLD,
  MEDIUM_CONFIDENCE_THRESHOLD,
  INGREDIENT_RULES,
  computeArtifactOverallConfidence,
  buildIngredientPlan,
};
