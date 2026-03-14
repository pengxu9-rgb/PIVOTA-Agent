const crypto = require('crypto');

const {
  RECOMMENDATION_STEP_RESOLUTION_RULES_V1,
  resolveRecoTargetStepIntent,
  getRecoTargetFamilyRelation,
  normalizeRecoTargetStep,
} = require('./recoTargetStep');
const { __internal: recoHybridInternal } = require('./usecases/recoHybridResolveCandidates');

const normalizeProductType =
  recoHybridInternal && typeof recoHybridInternal.normalizeProductType === 'function'
    ? recoHybridInternal.normalizeProductType
    : (value) => normalizeRecoTargetStep(value);
const isSkincareCandidate =
  recoHybridInternal && typeof recoHybridInternal.isSkincareCandidate === 'function'
    ? recoHybridInternal.isSkincareCandidate
    : () => false;

const RECOMMENDATION_STEP_QUERY_POLICY_V1 = 'recommendation_step_query_policy_v1';
const RECOMMENDATION_VIABLE_THRESHOLD_POLICY_V1 = 'recommendation_viable_threshold_policy_v1';
const RECOMMENDATION_RECO_POLICY_V1 = 'recommendation_step_aware_reco_policy_v1';
const CANDIDATE_POOL_SIGNATURE_VERSION = 'recommendation_viable_pool_signature_v1';
const RAW_CANDIDATE_POOL_DEBUG_SIGNATURE_VERSION = 'recommendation_raw_pool_debug_signature_v1';
const GROUP_SEMANTICS_VERSION = 'recommendation_group_semantics_v1';

const STEP_QUERY_ALIASES = Object.freeze({
  cleanser: Object.freeze(['cleanser', 'face wash', 'cleansing gel', 'cleansing foam', 'gentle cleanser', '洁面', '洗面奶']),
  toner: Object.freeze(['toner', 'skin toner', 'mist', '爽肤水', '化妆水']),
  essence: Object.freeze(['essence', 'first essence', '精华水', '精粹']),
  serum: Object.freeze(['serum', 'ampoule', 'repair serum', 'hydrating serum', '精华', '安瓶', '原液']),
  moisturizer: Object.freeze(['moisturizer', 'face cream', 'barrier cream', 'gel cream', 'lotion', 'emulsion', 'day cream', 'night cream', '面霜', '保湿霜', '保湿乳', '乳液', '日霜', '晚霜']),
  sunscreen: Object.freeze(['sunscreen', 'sun screen', 'spf', 'sunblock', '防晒', '隔离防晒']),
  treatment: Object.freeze(['treatment', 'spot treatment', 'retinol treatment', 'acid treatment', '祛痘', '刷酸', '点涂']),
  mask: Object.freeze(['mask', 'sleeping mask', 'sheet mask', 'overnight mask', 'facial mask', '面膜', '睡眠面膜', '泥膜']),
  oil: Object.freeze(['face oil', 'facial oil', 'oil serum', '护肤油', '面油']),
});

const STEP_THRESHOLDS = Object.freeze({
  default: Object.freeze({
    min_viable_count_for_step: 1,
    min_viable_quality_for_step: 0.72,
    allow_soft_target_same_family_only: true,
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function uniqCaseInsensitiveStrings(items, max = 24) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value == null ? null : value);
}

function makeSignature(prefix, payload) {
  const digest = crypto.createHash('sha1').update(stableSerialize(payload)).digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

function inferSlotForStep(step) {
  const normalized = normalizeRecoTargetStep(step);
  if (normalized === 'sunscreen') return 'am';
  if (normalized === 'mask' || normalized === 'treatment') return 'pm';
  return 'other';
}

function normalizeQueryToken(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectProfileGoalTerms(profileSummary) {
  const raw = [];
  if (typeof profileSummary?.goal_primary === 'string') raw.push(profileSummary.goal_primary);
  if (Array.isArray(profileSummary?.goals)) raw.push(...profileSummary.goals);
  return uniqCaseInsensitiveStrings(
    raw
      .map((item) => normalizeQueryToken(item))
      .filter(Boolean)
      .flatMap((item) => item.split(/[|,/;]+/g).map((token) => token.trim()).filter(Boolean)),
    6,
  );
}

function collectIngredientTerms(ingredientContext) {
  const ctx = isPlainObject(ingredientContext) ? ingredientContext : {};
  const candidates = Array.isArray(ctx.candidates) ? ctx.candidates : [];
  return uniqCaseInsensitiveStrings(
    [
      normalizeQueryToken(ctx.query),
      ...candidates.map((item) => normalizeQueryToken(item)),
    ].filter(Boolean),
    4,
  );
}

function collectConcernTerms(profileSummary, ingredientContext) {
  const raw = [
    ...collectProfileGoalTerms(profileSummary),
    normalizeQueryToken(ingredientContext && ingredientContext.goal),
  ];
  return uniqCaseInsensitiveStrings(
    raw
      .filter(Boolean)
      .flatMap((item) => item.split(/[|,/;]+/g).map((token) => token.trim()).filter(Boolean)),
    6,
  );
}

function getStepPolicy(step) {
  const normalized = normalizeRecoTargetStep(step) || 'default';
  return STEP_THRESHOLDS[normalized] || STEP_THRESHOLDS.default;
}

function resolveRecommendationTargetContext({
  explicitStep = '',
  focus = '',
  text = '',
  entryType = 'chat',
} = {}) {
  const resolved = resolveRecoTargetStepIntent({
    explicitStep,
    focus,
    text,
  });
  const confidence = String(resolved.resolved_target_step_confidence || 'none').trim().toLowerCase() || 'none';
  const step = normalizeRecoTargetStep(resolved.resolved_target_step);
  const stepAwareIntent = Boolean(step) && (confidence === 'high' || confidence === 'medium');
  const mainlineMode =
    confidence === 'high'
      ? 'hard_target'
      : confidence === 'medium'
        ? 'soft_target'
        : 'generic';
  return {
    ...resolved,
    resolved_target_step: step,
    entry_type: String(entryType || 'chat').trim().toLowerCase() || 'chat',
    step_aware_intent: stepAwareIntent,
    mainline_mode: stepAwareIntent ? mainlineMode : 'generic',
  };
}

function buildSameFamilyQueryLevels({
  targetContext,
  profileSummary,
  ingredientContext,
  lang = 'EN',
  seedTerms = [],
} = {}) {
  const step = normalizeRecoTargetStep(targetContext && targetContext.resolved_target_step);
  if (!step) return [];
  const aliases = STEP_QUERY_ALIASES[step] || [step];
  const stepPrimary = aliases[0] || step;
  const goalTerms = collectProfileGoalTerms(profileSummary).slice(0, 2);
  const ingredientTerms = collectIngredientTerms(ingredientContext).slice(0, 2);
  const concernTerms = collectConcernTerms(profileSummary, ingredientContext).slice(0, 2);
  const normalizedSeedTerms = uniqCaseInsensitiveStrings(
    (Array.isArray(seedTerms) ? seedTerms : []).map((item) => normalizeQueryToken(item)).filter(Boolean),
    4,
  );

  const levels = [
    {
      ladder_level: 'step_goal_ingredient_concern',
      queries: uniqCaseInsensitiveStrings([
        ...goalTerms.flatMap((goal) => ingredientTerms.flatMap((ingredient) => concernTerms.length
          ? concernTerms.map((concern) => `${stepPrimary} ${goal} ${ingredient} ${concern}`)
          : [`${stepPrimary} ${goal} ${ingredient}`])),
        ...normalizedSeedTerms.flatMap((seed) => goalTerms.flatMap((goal) => [`${seed} ${goal}`, `${stepPrimary} ${seed} ${goal}`])),
      ], 8),
    },
    {
      ladder_level: 'step_goal',
      queries: uniqCaseInsensitiveStrings([
        ...goalTerms.map((goal) => `${stepPrimary} ${goal}`),
        ...normalizedSeedTerms,
      ], 8),
    },
    {
      ladder_level: 'step_concern',
      queries: uniqCaseInsensitiveStrings([
        ...concernTerms.map((concern) => `${stepPrimary} ${concern}`),
        ...normalizedSeedTerms.map((seed) => `${stepPrimary} ${seed}`),
      ], 8),
    },
    {
      ladder_level: 'step_only',
      queries: uniqCaseInsensitiveStrings([
        stepPrimary,
        ...normalizedSeedTerms,
      ], 8),
    },
    {
      ladder_level: 'step_alias_expansion',
      queries: uniqCaseInsensitiveStrings(aliases, 8),
    },
  ];

  const slot = inferSlotForStep(step);
  return levels
    .map((level, index) => ({
      level_index: index,
      ladder_level: level.ladder_level,
      queries: level.queries
        .map((query) => normalizeQueryToken(query))
        .filter(Boolean)
        .slice(0, 8)
        .map((query) => ({
          query,
          step: String(lang || '').trim().toUpperCase() === 'CN' ? stepPrimary : stepPrimary,
          slot,
          ladder_level: level.ladder_level,
        })),
    }))
    .filter((level) => Array.isArray(level.queries) && level.queries.length > 0);
}

function normalizeCandidateStep(product) {
  if (!isPlainObject(product)) return null;
  return normalizeProductType(
    pickFirstTrimmed(
      product.product_type,
      product.productType,
      product.category,
      product.category_name,
      product.categoryName,
      product.step,
      product.type,
    ),
  );
}

function productKey(product) {
  const row = isPlainObject(product) ? product : {};
  const productId = pickFirstTrimmed(row.product_id, row.productId, row.id);
  const merchantId = pickFirstTrimmed(row.merchant_id, row.merchantId);
  const name = pickFirstTrimmed(row.brand, row.name, row.display_name, row.displayName);
  return `${productId}::${merchantId}::${name}`.toLowerCase();
}

function normalizeViabilityScore({ relation, candidateStep, targetStep }) {
  if (!targetStep) return 0.75;
  if (relation === 'same_family') {
    return candidateStep === targetStep ? 1 : 0.9;
  }
  if (relation === 'adjacent_family') return 0.58;
  return 0;
}

function classifyRecommendationCandidate(product, { targetContext } = {}) {
  const row = isPlainObject(product) ? product : null;
  if (!row) return null;
  const skincare = isSkincareCandidate(row);
  const candidateStep = normalizeCandidateStep(row);
  const stepAwareIntent = Boolean(targetContext && targetContext.step_aware_intent && targetContext.resolved_target_step);
  const resolvedTargetStep = normalizeRecoTargetStep(targetContext && targetContext.resolved_target_step);
  const relation = stepAwareIntent
    ? getRecoTargetFamilyRelation(resolvedTargetStep, candidateStep)
    : 'same_family';

  let bucket = 'viable';
  let reason = 'generic_viable';
  if (!skincare) {
    bucket = 'hard_reject';
    reason = 'non_skincare_or_blacklisted';
  } else if (stepAwareIntent && relation === 'incompatible_family') {
    bucket = 'hard_reject';
    reason = 'incompatible_family';
  } else if (stepAwareIntent && relation === 'adjacent_family') {
    bucket = 'soft_mismatch';
    reason = 'adjacent_family';
  } else if (stepAwareIntent && relation === 'same_family') {
    bucket = 'viable';
    reason = candidateStep === resolvedTargetStep ? 'exact_step_match' : 'same_family_match';
  }

  const score = normalizeViabilityScore({
    relation,
    candidateStep,
    targetStep: resolvedTargetStep,
  });
  const itemTargetFidelity =
    bucket === 'viable'
      ? score
      : bucket === 'soft_mismatch'
        ? 0.5
        : 0;

  return {
    product: row,
    candidate_step: candidateStep,
    family_relation: relation,
    bucket,
    reason,
    score,
    item_target_fidelity: itemTargetFidelity,
  };
}

function summarizePrimaryDisplayGroups(selected) {
  const items = Array.isArray(selected) ? selected : [];
  if (!items.length) return [];
  const groupTargetFidelity = items.reduce((min, item) => Math.min(min, Number(item.item_target_fidelity || 0)), 1);
  return [
    {
      group_id: 'primary',
      group_target_fidelity: groupTargetFidelity,
      items: items.map((item) => ({
        product_id: pickFirstTrimmed(item.product?.product_id, item.product?.productId),
        candidate_step: item.candidate_step || null,
        item_target_fidelity: Number(item.item_target_fidelity || 0),
      })),
    },
  ];
}

function finalizeRecommendationCandidatePools(rawCandidates, { targetContext } = {}) {
  const deduped = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawCandidates) ? rawCandidates : []) {
    const row = isPlainObject(raw) ? raw : null;
    if (!row) continue;
    const key = productKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  const classified = deduped
    .map((row) => classifyRecommendationCandidate(row, { targetContext }))
    .filter(Boolean);

  const viable = classified.filter((row) => row.bucket === 'viable').sort((left, right) => right.score - left.score);
  const softMismatch = classified.filter((row) => row.bucket === 'soft_mismatch').sort((left, right) => right.score - left.score);
  const hardReject = classified.filter((row) => row.bucket === 'hard_reject');
  const thresholds = getStepPolicy(targetContext && targetContext.resolved_target_step);
  const exactStepViableCount = viable.filter((row) => row.candidate_step && row.candidate_step === targetContext?.resolved_target_step).length;
  const sameFamilyViableCount = viable.length;
  const sameFamilySuccessThresholdMet = Boolean(
    sameFamilyViableCount >= Number(thresholds.min_viable_count_for_step || 1)
      && viable.some((row) => Number(row.score || 0) >= Number(thresholds.min_viable_quality_for_step || 0.72)),
  );
  const sameFamilyStrongViableExists = viable.some((row) => Number(row.score || 0) >= Number(thresholds.min_viable_quality_for_step || 0.72));
  const selected = viable.slice(0, 3);
  const selectedFamilies = uniqCaseInsensitiveStrings(selected.map((row) => row.candidate_step || row.family_relation || 'unknown'), 3);
  const topCandidatesConverged = selectedFamilies.length <= 1;
  const primaryDisplayGroups = summarizePrimaryDisplayGroups(selected);
  const overallTargetFidelitySatisfied = primaryDisplayGroups.length > 0
    && primaryDisplayGroups.every((group) => Number(group.group_target_fidelity || 0) >= Number(thresholds.min_viable_quality_for_step || 0.72));
  const hardConstraintConflict = false;
  const weakViablePool = Boolean(targetContext?.step_aware_intent) && selected.length === 0 && softMismatch.length > 0;
  const softTargetSuccessAllowed =
    targetContext?.mainline_mode === 'soft_target'
      ? Boolean(
        (exactStepViableCount > 0 || sameFamilyStrongViableExists)
          && topCandidatesConverged
          && !hardConstraintConflict
          && overallTargetFidelitySatisfied,
      )
      : null;
  const hardTargetSuccessAllowed =
    targetContext?.mainline_mode === 'hard_target'
      ? Boolean(exactStepViableCount > 0 && !hardConstraintConflict && overallTargetFidelitySatisfied)
      : null;
  const terminalSuccess = Boolean(
    !targetContext?.step_aware_intent
      ? selected.length > 0
      : targetContext.mainline_mode === 'soft_target'
        ? softTargetSuccessAllowed
        : hardTargetSuccessAllowed,
  );
  const familyMatchType = !targetContext?.step_aware_intent
    ? null
    : exactStepViableCount > 0
      ? 'exact_step'
      : sameFamilyViableCount > 0
        ? 'same_family'
        : softMismatch.length > 0
          ? 'adjacent_family'
          : 'incompatible_family';
  const targetFidelityLevel = overallTargetFidelitySatisfied
    ? 'satisfied'
    : selected.length > 0 || viable.length > 0 || softMismatch.length > 0
      ? 'partial'
      : 'failed';
  const viablePoolStrength = selected.length > 0
    ? (terminalSuccess ? 'strong' : 'weak')
    : (softMismatch.length > 0 || viable.length > 0 ? 'weak' : 'empty');

  return {
    raw_candidate_pool: deduped,
    viable_candidate_pool: viable.map((row) => row.product),
    selected_recommendations: selected.map((row) => row.product),
    primary_display_groups: primaryDisplayGroups,
    auxiliary_groups: [],
    debug_only_groups: [],
    raw_candidate_count: deduped.length,
    viable_candidate_count: viable.length,
    exact_step_viable_count: exactStepViableCount,
    same_family_viable_count: sameFamilyViableCount,
    soft_mismatch_count: softMismatch.length,
    hard_reject_count: hardReject.length,
    pre_llm_selected_candidate_count: selected.length,
    final_selected_candidate_count: selected.length,
    selected_candidate_count: selected.length,
    hard_reject: hardReject,
    soft_mismatch: softMismatch,
    viable,
    viable_pool_strength: viablePoolStrength,
    weak_viable_pool: weakViablePool,
    family_match_type: familyMatchType,
    item_target_fidelity: selected.map((row) => row.item_target_fidelity),
    group_target_fidelity: primaryDisplayGroups.map((group) => group.group_target_fidelity),
    target_fidelity_level: targetFidelityLevel,
    overall_target_fidelity_satisfied: overallTargetFidelitySatisfied,
    target_fidelity_satisfied: overallTargetFidelitySatisfied,
    top_candidates_converged: topCandidatesConverged,
    same_family_strong_viable_exists: sameFamilyStrongViableExists,
    same_family_success_threshold_met: sameFamilySuccessThresholdMet,
    hard_constraint_conflict: hardConstraintConflict,
    constraint_conflict: hardConstraintConflict,
    terminal_success: terminalSuccess,
    reco_policy_version: RECOMMENDATION_RECO_POLICY_V1,
    raw_candidate_pool_debug_signature: makeSignature('rawpool', {
      version: RAW_CANDIDATE_POOL_DEBUG_SIGNATURE_VERSION,
      ids: deduped.map((row) => productKey(row)).filter(Boolean).sort(),
      target_step: targetContext?.resolved_target_step || null,
    }),
    candidate_pool_signature: makeSignature('viablepool', {
      version: CANDIDATE_POOL_SIGNATURE_VERSION,
      ids: viable.map((row) => productKey(row.product)).filter(Boolean).sort(),
      target_step: targetContext?.resolved_target_step || null,
      viable_candidate_count: viable.length,
      soft_mismatch_count: softMismatch.length,
      hard_reject_count: hardReject.length,
    }),
  };
}

function shouldStopStepAwareBroadening(poolState, { targetContext } = {}) {
  if (!targetContext?.step_aware_intent) return false;
  const thresholds = getStepPolicy(targetContext.resolved_target_step);
  const viableCount = Number(poolState?.same_family_viable_count || 0);
  const sameFamilyStrongViableExists = Boolean(poolState?.same_family_strong_viable_exists);
  return viableCount >= Number(thresholds.min_viable_count_for_step || 1) && sameFamilyStrongViableExists;
}

function deriveStepAwareEmptyReason(targetContext, poolState) {
  if (poolState?.weak_viable_pool) return 'weak_viable_pool_for_target';
  if (targetContext?.step_aware_intent) return 'no_viable_candidates_for_target';
  return 'upstream_missing_or_empty';
}

module.exports = {
  RECOMMENDATION_STEP_RESOLUTION_RULES_V1,
  RECOMMENDATION_STEP_QUERY_POLICY_V1,
  RECOMMENDATION_VIABLE_THRESHOLD_POLICY_V1,
  RECOMMENDATION_RECO_POLICY_V1,
  CANDIDATE_POOL_SIGNATURE_VERSION,
  RAW_CANDIDATE_POOL_DEBUG_SIGNATURE_VERSION,
  GROUP_SEMANTICS_VERSION,
  STEP_THRESHOLDS,
  resolveRecommendationTargetContext,
  buildSameFamilyQueryLevels,
  finalizeRecommendationCandidatePools,
  shouldStopStepAwareBroadening,
  deriveStepAwareEmptyReason,
  inferSlotForStep,
};
