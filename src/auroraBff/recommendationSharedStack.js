const crypto = require('crypto');
const {
  buildAnalysisContextSnapshotV1,
  resolveAnalysisContextForTask,
  buildRecommendationAnalysisContextFromSnapshot,
} = require('./analysisContextSnapshot');
const {
  RECOMMENDATION_STEP_RESOLUTION_RULES_V1,
  resolveRecoTargetStepIntent,
  getRecoTargetFamilyRelation,
  normalizeRecoTargetStep,
} = require('./recoTargetStep');
const { __internal: recoHybridInternal } = require('./usecases/recoHybridResolveCandidates');

const SHARED_RECOMMENDATION_STACK_VERSION = 'aurora_recommendation_shared_stack_v1';
const REQUEST_CONTEXT_SIGNATURE_VERSION = 'request_context_signature_v1';
const CANDIDATE_POOL_SIGNATURE_VERSION = 'candidate_pool_signature_v1';
const MIN_CONTEXT_RULE_VERSION = 'RECOMMENDATION_MIN_CONTEXT_RULES_V1';
const RECOMMENDATION_STEP_QUERY_POLICY_V1 = 'recommendation_step_query_policy_v1';
const RECOMMENDATION_VIABLE_THRESHOLD_POLICY_V1 = 'recommendation_viable_threshold_policy_v1';
const RAW_CANDIDATE_POOL_DEBUG_SIGNATURE_VERSION = 'recommendation_raw_pool_debug_signature_v1';
const GROUP_SEMANTICS_VERSION = 'recommendation_group_semantics_v1';
const STRICTNESS_SOURCES = Object.freeze(['entry_default', 'allowlisted_override', 'policy_forced']);
const ALLOWLISTED_STRICTNESS_OVERRIDE_CALLERS = new Set(['aurora_internal_test', 'aurora_eval']);
const RECOMMENDATION_MIN_CONTEXT_RULES_V1 = Object.freeze({
  replace: 'specific_target_or_goal_plus_filter',
  fill_gap: 'specific_target_or_goal_plus_filter',
  upgrade: 'specific_target_and_filter',
  maintain: 'specific_target_and_filter',
  exploratory: 'goal_plus_filter_or_artifact_hard_filters',
});
const STABLE_FILTER_FIELDS = Object.freeze([
  'skin_type',
  'sensitivity',
  'barrier_status',
  'ingredient_avoid',
  'ingredient_targets',
]);
const normalizeProductType =
  recoHybridInternal && typeof recoHybridInternal.normalizeProductType === 'function'
    ? recoHybridInternal.normalizeProductType
    : (value) => normalizeRecoTargetStep(value);
const isSkincareCandidate =
  recoHybridInternal && typeof recoHybridInternal.isSkincareCandidate === 'function'
    ? recoHybridInternal.isSkincareCandidate
    : () => false;
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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return value == null ? '' : String(value).trim();
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return '';
}

function uniqStrings(values, max = 8) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const text = asString(raw);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function stableHash(value, length = 16) {
  const text = typeof value === 'string' ? value : stableStringify(value || {});
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, length);
}

function stableNormalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableNormalize(item));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stableNormalize(value[key]);
    }
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableNormalize(value));
}

function normalizeSignatureValue(value) {
  if (Array.isArray(value)) {
    const normalizedItems = value
      .map((item) => normalizeSignatureValue(item))
      .map((item) => stableStringify(item))
      .filter(Boolean)
      .sort();
    return Array.from(new Set(normalizedItems)).map((item) => JSON.parse(item));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = normalizeSignatureValue(value[key]);
    }
    return out;
  }
  return typeof value === 'string' ? asString(value) : value;
}

function buildSharedSignature(version, payload, length = 16) {
  return stableHash({
    signature_version: version,
    payload: normalizeSignatureValue(payload),
  }, length);
}

function normalizeNeedToken(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function inferNeedType(text = '') {
  const normalized = asString(text).toLowerCase();
  if (!normalized) return 'exploratory';
  if (/\breplace|swap|instead of|替换|换掉\b/.test(normalized)) return 'replace';
  if (/\bupgrade|better|stronger|提升|升级\b/.test(normalized)) return 'upgrade';
  if (/\bmaintain|keep|maintainance|维持|保持\b/.test(normalized)) return 'maintain';
  if (/\bfill gap|missing step|need a\b/.test(normalized)) return 'fill_gap';
  return 'exploratory';
}

function coerceRecommendationMode({ targetStep = '', targetIngredient = '', needType = 'exploratory' } = {}) {
  if (targetIngredient) return 'ingredient_targeted';
  if (targetStep) return 'step_targeted';
  if (needType === 'replace') return 'replace_targeted';
  if (needType === 'upgrade') return 'upgrade_targeted';
  if (needType === 'maintain') return 'maintenance';
  return 'goal_driven';
}

function hasSpecificTargetNeed(targetNeed) {
  return Boolean(asString(targetNeed));
}

function looksLikeGenericRecoAsk(text = '') {
  const normalized = asString(text).toLowerCase();
  if (!normalized) return false;
  return /\brecommend|recommendation|product rec|products\b/.test(normalized)
    || /推荐|护肤品|产品推荐/.test(normalized);
}

function normalizeQueryToken(value) {
  return asString(value).replace(/\s+/g, ' ').trim();
}

function collectProfileGoalTerms(profileSummary) {
  const raw = [];
  if (typeof profileSummary?.goal_primary === 'string') raw.push(profileSummary.goal_primary);
  if (Array.isArray(profileSummary?.goals)) raw.push(...profileSummary.goals);
  return uniqStrings(
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
  return uniqStrings(
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
  return uniqStrings(
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

function inferSlotForStep(step) {
  const normalized = normalizeRecoTargetStep(step);
  if (normalized === 'sunscreen') return 'am';
  if (normalized === 'mask' || normalized === 'treatment') return 'pm';
  return 'other';
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
  const confidence = asString(resolved.resolved_target_step_confidence).toLowerCase() || 'none';
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
    entry_type: entryType === 'chat' ? 'chat' : 'direct',
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
  const normalizedSeedTerms = uniqStrings(
    asArray(seedTerms).map((item) => normalizeQueryToken(item)).filter(Boolean),
    4,
  );

  const levels = [
    {
      ladder_level: 'step_goal_ingredient_concern',
      queries: uniqStrings([
        ...goalTerms.flatMap((goal) => ingredientTerms.flatMap((ingredient) => concernTerms.length
          ? concernTerms.map((concern) => `${stepPrimary} ${goal} ${ingredient} ${concern}`)
          : [`${stepPrimary} ${goal} ${ingredient}`])),
        ...normalizedSeedTerms.flatMap((seed) => goalTerms.flatMap((goal) => [`${seed} ${goal}`, `${stepPrimary} ${seed} ${goal}`])),
      ], 8),
    },
    {
      ladder_level: 'step_goal',
      queries: uniqStrings([
        ...goalTerms.map((goal) => `${stepPrimary} ${goal}`),
        ...normalizedSeedTerms,
      ], 8),
    },
    {
      ladder_level: 'step_concern',
      queries: uniqStrings([
        ...concernTerms.map((concern) => `${stepPrimary} ${concern}`),
        ...normalizedSeedTerms.map((seed) => `${stepPrimary} ${seed}`),
      ], 8),
    },
    {
      ladder_level: 'step_only',
      queries: uniqStrings([
        stepPrimary,
        ...normalizedSeedTerms,
      ], 8),
    },
    {
      ladder_level: 'step_alias_expansion',
      queries: uniqStrings(aliases, 8),
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
          step: asString(lang).toUpperCase() === 'CN' ? stepPrimary : stepPrimary,
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
  for (const raw of asArray(rawCandidates)) {
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
  const sameFamilyStrongViableExists = viable.some((row) => Number(row.score || 0) >= Number(thresholds.min_viable_quality_for_step || 0.72));
  const selected = viable.slice(0, 3);
  const selectedFamilies = uniqStrings(selected.map((row) => row.candidate_step || row.family_relation || 'unknown'), 3);
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
    selected_candidate_count: selected.length,
    hard_reject: hardReject,
    soft_mismatch: softMismatch,
    viable,
    weak_viable_pool: weakViablePool,
    item_target_fidelity: selected.map((row) => row.item_target_fidelity),
    group_target_fidelity: primaryDisplayGroups.map((group) => group.group_target_fidelity),
    overall_target_fidelity_satisfied: overallTargetFidelitySatisfied,
    target_fidelity_satisfied: overallTargetFidelitySatisfied,
    top_candidates_converged: topCandidatesConverged,
    same_family_strong_viable_exists: sameFamilyStrongViableExists,
    hard_constraint_conflict: hardConstraintConflict,
    terminal_success: terminalSuccess,
    raw_candidate_pool_debug_signature: buildSharedSignature(RAW_CANDIDATE_POOL_DEBUG_SIGNATURE_VERSION, {
      ids: deduped.map((row) => productKey(row)).filter(Boolean).sort(),
      target_step: targetContext?.resolved_target_step || null,
    }),
    candidate_pool_signature: buildSharedSignature(CANDIDATE_POOL_SIGNATURE_VERSION, {
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

function normalizeRecommendationIntent({
  entryType = 'direct',
  message = '',
  directRequest = null,
  params = null,
  actionData = null,
} = {}) {
  const direct = isPlainObject(directRequest) ? directRequest : {};
  const requestParams = isPlainObject(params) ? params : {};
  const action = isPlainObject(actionData) ? actionData : {};
  const focus = pickFirstTrimmed(
    direct.focus,
    requestParams.focus,
    requestParams.target_need,
    requestParams.user_need,
  );
  const targetStep = pickFirstTrimmed(
    requestParams.target_step,
    requestParams.step,
    direct.constraints && direct.constraints.target_step,
    direct.constraints && direct.constraints.step,
  );
  const targetIngredient = pickFirstTrimmed(
    requestParams.target_ingredient,
    requestParams.ingredient,
    direct.constraints && direct.constraints.target_ingredient,
    direct.constraints && direct.constraints.ingredient,
  );
  const userMessage = pickFirstTrimmed(
    message,
    requestParams.user_message,
    requestParams.message,
    requestParams.text,
    action.reply_text,
    action.replyText,
  );
  const targetContext = resolveRecommendationTargetContext({
    explicitStep: targetStep,
    focus,
    text: userMessage,
    entryType,
  });
  const resolvedTargetStep = targetContext.resolved_target_step || null;
  const resolvedTargetStepConfidence = targetContext.resolved_target_step_confidence || 'none';
  const resolvedTargetStepSource = targetContext.resolved_target_step_source || 'none';
  const stepResolutionVersion = targetContext.step_resolution_version || RECOMMENDATION_STEP_RESOLUTION_RULES_V1;

  if (resolvedTargetStep && (resolvedTargetStepConfidence === 'high' || resolvedTargetStepConfidence === 'medium')) {
    return {
      need_id: `step:${normalizeNeedToken(resolvedTargetStep) || 'unknown'}`,
      need_type: 'fill_gap',
      target_need: resolvedTargetStep,
      recommendation_mode: coerceRecommendationMode({ targetStep: resolvedTargetStep }),
      entry_type: entryType === 'chat' ? 'chat' : 'direct',
      intent_confidence: resolvedTargetStepConfidence === 'high' ? 0.92 : 0.74,
      needs_clarification: false,
      resolved_target_step: resolvedTargetStep,
      resolved_target_step_confidence: resolvedTargetStepConfidence,
      resolved_target_step_source: resolvedTargetStepSource,
      step_resolution_version: stepResolutionVersion,
      step_aware_intent: targetContext.step_aware_intent === true,
      mainline_mode: targetContext.mainline_mode || 'generic',
    };
  }

  if (targetIngredient) {
    return {
      need_id: `ingredient:${normalizeNeedToken(targetIngredient) || 'unknown'}`,
      need_type: 'fill_gap',
      target_need: targetIngredient,
      recommendation_mode: coerceRecommendationMode({ targetIngredient }),
      entry_type: entryType === 'chat' ? 'chat' : 'direct',
      intent_confidence: 0.92,
      needs_clarification: false,
      resolved_target_step: null,
      resolved_target_step_confidence: resolvedTargetStepConfidence,
      resolved_target_step_source: resolvedTargetStepSource,
      step_resolution_version: stepResolutionVersion,
      step_aware_intent: false,
      mainline_mode: 'generic',
    };
  }

  if (focus) {
    const needType = inferNeedType(focus);
    return {
      need_id: normalizeNeedToken(focus) || 'general_skincare_recommendation',
      need_type: needType,
      target_need: focus,
      recommendation_mode: coerceRecommendationMode({ needType }),
      entry_type: entryType === 'chat' ? 'chat' : 'direct',
      intent_confidence: 0.84,
      needs_clarification: false,
      resolved_target_step: null,
      resolved_target_step_confidence: resolvedTargetStepConfidence,
      resolved_target_step_source: resolvedTargetStepSource,
      step_resolution_version: stepResolutionVersion,
      step_aware_intent: false,
      mainline_mode: 'generic',
    };
  }

  if (looksLikeGenericRecoAsk(userMessage) || asString(requestParams.entry_source).toLowerCase() === 'chip.start.reco_products') {
    return {
      need_id: 'general_skincare_recommendation',
      need_type: 'exploratory',
      target_need: null,
      recommendation_mode: 'goal_driven',
      entry_type: entryType === 'chat' ? 'chat' : 'direct',
      intent_confidence: 0.72,
      needs_clarification: false,
      resolved_target_step: null,
      resolved_target_step_confidence: resolvedTargetStepConfidence,
      resolved_target_step_source: resolvedTargetStepSource,
      step_resolution_version: stepResolutionVersion,
      step_aware_intent: false,
      mainline_mode: 'generic',
    };
  }

  return {
    need_id: 'unknown',
    need_type: 'exploratory',
    target_need: null,
    recommendation_mode: 'goal_driven',
    entry_type: entryType === 'chat' ? 'chat' : 'direct',
    intent_confidence: 0.18,
    needs_clarification: true,
    resolved_target_step: null,
    resolved_target_step_confidence: resolvedTargetStepConfidence,
    resolved_target_step_source: resolvedTargetStepSource,
    step_resolution_version: stepResolutionVersion,
    step_aware_intent: false,
    mainline_mode: 'generic',
  };
}

function buildFallbackPolicy({ entryType = 'direct' } = {}) {
  return entryType === 'chat'
    ? 'chat_clarify_friendly_v1'
    : 'structured_needs_more_context_v1';
}

function resolveStrictnessMode({ entryType = 'direct', requestedMode = null, callerId = null } = {}) {
  const defaultMode = entryType === 'chat' ? 'normal' : 'strict';
  const normalizedRequested = asString(requestedMode).toLowerCase();
  if (!normalizedRequested || normalizedRequested === defaultMode) {
    return { strictness_mode: defaultMode, strictness_source: 'entry_default' };
  }
  if (ALLOWLISTED_STRICTNESS_OVERRIDE_CALLERS.has(asString(callerId))) {
    return { strictness_mode: normalizedRequested, strictness_source: 'allowlisted_override' };
  }
  return { strictness_mode: defaultMode, strictness_source: 'policy_forced' };
}

function buildRecommendationContextMode({
  contextSourceMode = 'none',
  hardContext = {},
  softContext = {},
} = {}) {
  const hasHard = Object.keys(isPlainObject(hardContext) ? hardContext : {}).length > 0;
  const hasSoft = Object.keys(isPlainObject(softContext) ? softContext : {}).length > 0;
  if (contextSourceMode === 'none') return 'no_context';
  if (contextSourceMode === 'explicit_only') return 'explicit_only';
  if (hasHard && hasSoft) return 'snapshot_mixed';
  if (hasHard) return 'snapshot_hard';
  if (hasSoft) return 'snapshot_soft_only';
  return 'no_context';
}

function hasStableFilters(context = null) {
  const row = isPlainObject(context) ? context : {};
  return STABLE_FILTER_FIELDS.some((field) => {
    const value = row[field];
    return Array.isArray(value) ? value.length > 0 : Boolean(asString(value));
  });
}

function hasMinimumRecommendationContext({
  intent = null,
  explicitContext = null,
  snapshotHardContext = null,
  contextSourceMode = 'none',
} = {}) {
  const needType = inferNeedType(asString(intent && intent.need_type)) === 'exploratory'
    ? asString(intent && intent.need_type) || 'exploratory'
    : asString(intent && intent.need_type);
  const effectiveNeedType = ['replace', 'fill_gap', 'upgrade', 'maintain', 'exploratory'].includes(needType)
    ? needType
    : 'exploratory';
  const explicitGoals = uniqStrings(explicitContext && explicitContext.goals ? explicitContext.goals : explicitContext && explicitContext.active_goals, 4);
  const hardGoals = uniqStrings(snapshotHardContext && snapshotHardContext.active_goals, 4);
  const hasGoals = explicitGoals.length > 0 || hardGoals.length > 0;
  const hasSpecificTarget = hasSpecificTargetNeed(intent && intent.target_need);
  const mergedHasStableFilter = hasStableFilters(explicitContext) || hasStableFilters(snapshotHardContext);
  const artifactBacked = contextSourceMode === 'artifact' || contextSourceMode === 'artifact_compat_fallback';
  const artifactHardFilters = artifactBacked && hasStableFilters(snapshotHardContext);

  if (effectiveNeedType === 'replace' || effectiveNeedType === 'fill_gap') {
    return hasSpecificTarget || (hasGoals && mergedHasStableFilter);
  }
  if (effectiveNeedType === 'upgrade' || effectiveNeedType === 'maintain') {
    return hasSpecificTarget && mergedHasStableFilter;
  }
  return (hasGoals && mergedHasStableFilter) || (artifactHardFilters && hasGoals);
}

function normalizeSharedContextUsage(taskContext = {}, {
  contextSourceMode = 'none',
  analysisContextAvailable = false,
  minimumRecommendationContextSatisfied = false,
  contextUsageOverrides = null,
} = {}) {
  const usage = isPlainObject(taskContext) ? { ...taskContext } : {};
  const normalized = {
    snapshot_present: contextSourceMode === 'artifact' || contextSourceMode === 'artifact_compat_fallback',
    context_source_mode: contextSourceMode,
    analysis_context_available: analysisContextAvailable,
    snapshot_fields_used: asArray(usage.snapshot_fields_used),
    hard_context_fields_used: asArray(usage.hard_context_fields_used),
    soft_context_fields_used: asArray(usage.soft_context_fields_used),
    explicit_override_applied: Boolean(usage.explicit_override_applied),
    context_mode: asString(usage.context_mode) || 'no_context',
    adapter_version: asString(usage.adapter_version) || null,
    strictness_source: 'entry_default',
    minimum_recommendation_context_satisfied: minimumRecommendationContextSatisfied,
    min_context_rule_version: MIN_CONTEXT_RULE_VERSION,
  };
  if (isPlainObject(contextUsageOverrides)) {
    Object.assign(normalized, contextUsageOverrides);
  }
  return normalized;
}

function normalizeRecommendationOverride(raw = null) {
  const value = isPlainObject(raw) ? raw : {};
  const goals = uniqStrings(
    value.goals
      || (value.goal ? [value.goal] : [])
      || (value.goal_primary ? [value.goal_primary] : []),
    4,
  );
  const contraindications = uniqStrings(
    value.contraindications
      || value.ingredient_avoid
      || value.avoid
      || [],
    6,
  );
  const sensitivity = pickFirstTrimmed(value.sensitivity, value.sensitivity_level);
  const barrierStatus = pickFirstTrimmed(value.barrierStatus, value.barrier_status);
  const skinType = pickFirstTrimmed(value.skinType, value.skin_type);
  return {
    ...(skinType ? { skinType } : {}),
    ...(sensitivity ? { sensitivity } : {}),
    ...(barrierStatus ? { barrierStatus } : {}),
    ...(goals.length ? { goals } : {}),
    ...(contraindications.length ? { contraindications } : {}),
  };
}

function buildRecommendationRequestContext({
  intent,
  profile = null,
  recentLogs = [],
  analysisContextSnapshot = null,
  requestOverride = null,
  strictnessMode = null,
  internalCallerId = null,
  fallbackPolicy = null,
  requestGoalScope = 'active_only',
  contextUsageOverrides = null,
} = {}) {
  const normalizedIntent = isPlainObject(intent)
    ? intent
    : normalizeRecommendationIntent({ entryType: 'direct' });
  const entryType = normalizedIntent.entry_type === 'chat' ? 'chat' : 'direct';
  const strictness = resolveStrictnessMode({
    entryType,
    requestedMode: strictnessMode,
    callerId: internalCallerId,
  });
  const effectiveSnapshot = isPlainObject(analysisContextSnapshot)
    ? analysisContextSnapshot
    : buildAnalysisContextSnapshotV1({
      profile,
      recentLogs,
      lastAnalysis: isPlainObject(profile) ? profile.lastAnalysis || null : null,
    });
  const normalizedOverride = normalizeRecommendationOverride(requestOverride);
  const resolved = resolveAnalysisContextForTask({
    task: 'recommendation',
    snapshot: effectiveSnapshot,
    profile,
    requestOverride: normalizedOverride,
    recentLogs,
  });
  const taskContext = buildRecommendationAnalysisContextFromSnapshot(resolved);
  const effectiveStrictnessMode = strictness.strictness_mode;
  const effectiveFallbackPolicy = fallbackPolicy || buildFallbackPolicy({ entryType });
  const contextSourceMode = asString(taskContext.context_source_mode) || 'none';
  const analysisContextAvailable = Boolean(taskContext.analysis_context_available);
  const resolvedTargetStep = normalizeRecoTargetStep(normalizedIntent.resolved_target_step);
  const resolvedTargetStepConfidence = asString(normalizedIntent.resolved_target_step_confidence).toLowerCase() || 'none';
  const resolvedTargetStepSource = pickFirstTrimmed(normalizedIntent.resolved_target_step_source) || 'none';
  const stepResolutionVersion = pickFirstTrimmed(normalizedIntent.step_resolution_version) || RECOMMENDATION_STEP_RESOLUTION_RULES_V1;
  const minimumRecommendationContextSatisfied = hasMinimumRecommendationContext({
    intent: normalizedIntent,
    explicitContext: resolved.explicit_profile,
    snapshotHardContext: taskContext.task_hard_context,
    contextSourceMode,
  });
  const requestContextSignature = buildSharedSignature(REQUEST_CONTEXT_SIGNATURE_VERSION, {
    intent: {
      need_id: normalizedIntent.need_id,
      need_type: normalizedIntent.need_type,
      target_need: normalizedIntent.target_need,
      recommendation_mode: normalizedIntent.recommendation_mode,
      entry_type: normalizedIntent.entry_type,
      resolved_target_step: resolvedTargetStep,
      resolved_target_step_confidence: resolvedTargetStepConfidence,
      resolved_target_step_source: resolvedTargetStepSource,
    },
    hard: taskContext.task_hard_context,
    soft: taskContext.task_soft_context,
    strictness_mode: effectiveStrictnessMode,
    fallback_policy: effectiveFallbackPolicy,
    request_goal_scope: requestGoalScope,
  });
  const contextMode = buildRecommendationContextMode({
    contextSourceMode,
    hardContext: taskContext.task_hard_context,
    softContext: taskContext.task_soft_context,
  });

  const requestContext = {
    stack_version: SHARED_RECOMMENDATION_STACK_VERSION,
    intent: normalizedIntent,
    need_id: normalizedIntent.need_id,
    need_type: normalizedIntent.need_type,
    target_need: normalizedIntent.target_need,
    recommendation_mode: normalizedIntent.recommendation_mode,
    entry_type: normalizedIntent.entry_type,
    resolved_target_step: resolvedTargetStep,
    resolved_target_step_confidence: resolvedTargetStepConfidence,
    resolved_target_step_source: resolvedTargetStepSource,
    step_resolution_version: stepResolutionVersion,
    step_aware_intent: normalizedIntent.step_aware_intent === true,
    mainline_mode: normalizedIntent.mainline_mode || 'generic',
    strictness_mode: effectiveStrictnessMode,
    fallback_policy: effectiveFallbackPolicy,
    strictness_source: strictness.strictness_source,
    request_goal_scope: requestGoalScope,
    explicit_context: resolved.explicit_profile,
    snapshot_hard_context: taskContext.task_hard_context,
    snapshot_soft_context: taskContext.task_soft_context,
    recent_log_signals: {
      extraction_signature: resolved.recent_log_extraction_signature,
    },
    constraints: {
      ingredient_avoid: uniqStrings(taskContext.task_hard_context && taskContext.task_hard_context.ingredient_avoid, 6),
    },
    context_mode: contextMode,
    context_source_mode: contextSourceMode,
    analysis_context_available: analysisContextAvailable,
    minimum_recommendation_context_satisfied: minimumRecommendationContextSatisfied,
    min_context_rule_version: MIN_CONTEXT_RULE_VERSION,
    context_usage: normalizeSharedContextUsage(taskContext, {
      contextSourceMode,
      analysisContextAvailable,
      minimumRecommendationContextSatisfied,
      contextUsageOverrides,
    }),
    request_context_signature_version: REQUEST_CONTEXT_SIGNATURE_VERSION,
    request_context_signature: requestContextSignature,
    analysis_context_snapshot: effectiveSnapshot,
    task_context: taskContext,
  };
  requestContext.context_usage.context_mode = contextMode;
  requestContext.context_usage.strictness_source = strictness.strictness_source;
  requestContext.context_usage.resolved_target_step = resolvedTargetStep;
  requestContext.context_usage.resolved_target_step_confidence = resolvedTargetStepConfidence;
  requestContext.context_usage.resolved_target_step_source = resolvedTargetStepSource;
  requestContext.context_usage.step_resolution_version = stepResolutionVersion;
  return requestContext;
}

function buildPoolFilterList(requestContext = {}) {
  const filters = [];
  const hard = isPlainObject(requestContext.snapshot_hard_context) ? requestContext.snapshot_hard_context : {};
  uniqStrings(hard.active_goals, 4).forEach((goal) => filters.push(`goal:${goal}`));
  uniqStrings(hard.ingredient_avoid, 4).forEach((value) => filters.push(`avoid:${value}`));
  uniqStrings(hard.ingredient_targets, 4).forEach((value) => filters.push(`target:${value}`));
  if (asString(hard.skin_type)) filters.push(`skin_type:${hard.skin_type}`);
  if (asString(hard.sensitivity)) filters.push(`sensitivity:${hard.sensitivity}`);
  if (asString(hard.barrier_status)) filters.push(`barrier:${hard.barrier_status}`);
  return filters.slice(0, 12);
}

function normalizedCandidateId(candidate = {}) {
  const row = isPlainObject(candidate) ? candidate : {};
  const sku = isPlainObject(row.sku) ? row.sku : {};
  const stable = pickFirstTrimmed(
    row.product_id,
    row.product_ref,
    row.product_group_id,
    row.sku_id,
    sku.product_id,
    sku.product_group_id,
    sku.sku_id,
  );
  if (stable) return stable.toLowerCase();
  const brand = pickFirstTrimmed(row.brand, sku.brand);
  const name = pickFirstTrimmed(row.name, row.display_name, sku.name, sku.display_name);
  const url = pickFirstTrimmed(row.url, row.pdp_url, row.pdpUrl, sku.url, sku.pdp_url);
  return pickFirstTrimmed(
    brand && name ? `${brand}:${name}` : '',
    name,
    url,
  ).toLowerCase();
}

function buildCandidatePool({
  requestContext = null,
  targetNeed = null,
  candidatePool = [],
  poolSource = 'deferred',
  unresolvedReason = null,
  constraintsVersion = 'v1',
} = {}) {
  const normalizedPool = [];
  const seen = new Set();
  for (const row of asArray(candidatePool)) {
    const id = normalizedCandidateId(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalizedPool.push({
      normalized_candidate_id: id,
      candidate_origin: pickFirstTrimmed(row.candidate_origin, row.retrieval_source, row.source, 'unknown'),
    });
  }
  const filters = buildPoolFilterList(requestContext);
  const effectiveUnresolvedReason =
    unresolvedReason
    || (!normalizedPool.length && requestContext && requestContext.intent && requestContext.intent.needs_clarification ? 'insufficient_target_need' : null)
    || (!normalizedPool.length ? 'no_candidates_found' : null);
  return {
    candidate_pool: normalizedPool,
    candidate_pool_signature: buildSharedSignature(CANDIDATE_POOL_SIGNATURE_VERSION, {
      ids: normalizedPool.map((item) => item.normalized_candidate_id).sort(),
      pool_source: poolSource,
      filters,
      constraints_version: constraintsVersion,
      target_step: requestContext && requestContext.resolved_target_step ? requestContext.resolved_target_step : null,
      unresolved_reason: effectiveUnresolvedReason || null,
    }),
    candidate_pool_signature_version: CANDIDATE_POOL_SIGNATURE_VERSION,
    raw_candidate_pool_debug_signature: buildSharedSignature(RAW_CANDIDATE_POOL_DEBUG_SIGNATURE_VERSION, {
      ids: asArray(candidatePool).map((item) => normalizedCandidateId(item)).filter(Boolean).sort(),
      pool_source: poolSource,
      constraints_version: constraintsVersion,
      target_step: requestContext && requestContext.resolved_target_step ? requestContext.resolved_target_step : null,
    }),
    pool_source: poolSource,
    pool_filters_applied: filters,
    dedup_applied: normalizedPool.length !== asArray(candidatePool).length,
    excluded_candidates_summary: [],
    unresolved_reason: effectiveUnresolvedReason,
  };
}

function deriveFallbackMode({
  entryType = 'direct',
  intent = null,
  strictnessMode = 'strict',
  minimumRecommendationContextSatisfied = false,
  llmFailureClass = '',
  upstreamFailureCode = '',
  mainlineStatus = '',
  promptContractOk = true,
} = {}) {
  if (intent && intent.needs_clarification && entryType === 'chat') return 'chat_clarify_needed_for_missing_target_need';
  if (intent && intent.needs_clarification && strictnessMode === 'strict') return 'missing_required_context_under_strict_mode';
  if (String(llmFailureClass || '').trim() === 'timeout' || /timeout/i.test(String(upstreamFailureCode || ''))) {
    if (entryType === 'chat' && !minimumRecommendationContextSatisfied) return 'timeout_to_clarify';
    return 'timeout_to_safe_failure';
  }
  if (promptContractOk === false || mainlineStatus === 'prompt_contract_mismatch') return 'partial_rollout_contract_mismatch';
  if (llmFailureClass || upstreamFailureCode) return 'severe_parse_or_prompt_failure';
  return null;
}

async function runRecommendationCore({
  coreRunner,
  coreInput,
  requestContext,
  candidatePool,
} = {}) {
  if (typeof coreRunner !== 'function') {
    throw new Error('recommendation shared stack requires coreRunner');
  }
  const raw = await coreRunner(coreInput);
  const payload = raw && raw.norm && isPlainObject(raw.norm.payload) ? raw.norm.payload : {};
  const recommendationGroups = Array.isArray(payload.recommendations) && payload.recommendations.length
    ? [{ group_id: 'primary', items: payload.recommendations }]
    : [];
  const fallbackMode = deriveFallbackMode({
    entryType: requestContext && requestContext.entry_type,
    intent: requestContext && requestContext.intent,
    strictnessMode: requestContext && requestContext.strictness_mode,
    minimumRecommendationContextSatisfied: Boolean(requestContext && requestContext.minimum_recommendation_context_satisfied),
    llmFailureClass: raw && raw.llmFailureClass,
    upstreamFailureCode: raw && raw.upstreamFailureCode,
    mainlineStatus: raw && raw.mainlineStatus,
    promptContractOk: payload.prompt_contract_ok !== false,
  });
  return {
    raw,
    recommendation_groups: recommendationGroups,
    context_usage: isPlainObject(payload.recommendation_meta && payload.recommendation_meta.analysis_context_usage)
      ? payload.recommendation_meta.analysis_context_usage
      : (requestContext && requestContext.context_usage) || {},
    decision_trace: {
      eligibility_decision: recommendationGroups.length ? 'eligible' : String(raw && raw.mainlineStatus || 'empty').trim() || 'empty',
      filter_reasons: uniqStrings([
        payload.products_empty_reason,
        payload.recommendation_meta && payload.recommendation_meta.catalog_skip_reason,
      ], 4),
      rank_signals: uniqStrings([
        payload.recommendation_meta && payload.recommendation_meta.source_mode,
        payload.grounding_status,
      ], 4),
      fallback_reason: fallbackMode || pickFirstTrimmed(
        payload.recommendation_meta && payload.recommendation_meta.telemetry_failure_reason,
        raw && raw.telemetryFailureReason,
      ) || null,
      context_constraints_applied: candidatePool && Array.isArray(candidatePool.pool_filters_applied)
        ? candidatePool.pool_filters_applied
        : [],
    },
    fallback_mode: fallbackMode,
    missing_context:
      requestContext && requestContext.intent && requestContext.intent.needs_clarification
        ? ['target_need']
        : [],
    confidence: payload.recommendation_confidence_score ?? null,
    debug_meta: {
      request_context_signature: requestContext && requestContext.request_context_signature,
      request_context_signature_version: requestContext && requestContext.request_context_signature_version,
      candidate_pool_signature: candidatePool && candidatePool.candidate_pool_signature,
      candidate_pool_signature_version: candidatePool && candidatePool.candidate_pool_signature_version,
      mainline_status: raw && raw.mainlineStatus ? raw.mainlineStatus : null,
      strictness_source: requestContext && requestContext.strictness_source ? requestContext.strictness_source : 'entry_default',
    },
  };
}

async function runRecommendationSharedStack({
  entryType = 'direct',
  message = '',
  directRequest = null,
  params = null,
  actionData = null,
  profile = null,
  recentLogs = [],
  analysisContextSnapshot = null,
  requestOverride = null,
  coreRunner,
  coreInput = {},
  contextUsageOverrides = null,
} = {}) {
  const intent = normalizeRecommendationIntent({
    entryType,
    message,
    directRequest,
    params,
    actionData,
  });
  const requestContext = buildRecommendationRequestContext({
    intent,
    profile,
    recentLogs,
    analysisContextSnapshot,
    requestOverride,
    strictnessMode: coreInput && coreInput.strictnessMode ? coreInput.strictnessMode : null,
    internalCallerId: coreInput && coreInput.internalCallerId ? coreInput.internalCallerId : null,
    contextUsageOverrides,
  });
  const candidatePool = buildCandidatePool({
    requestContext,
    targetNeed: intent.target_need,
    candidatePool: [],
    poolSource: 'precore',
  });
  if (
    entryType === 'chat' &&
    !requestContext.minimum_recommendation_context_satisfied &&
    !hasSpecificTargetNeed(intent.target_need)
  ) {
    return {
      intent,
      request_context: requestContext,
      candidate_pool: candidatePool,
      core_result: {
        recommendation_groups: [],
        context_usage: requestContext.context_usage,
        decision_trace: {
          eligibility_decision: 'needs_more_context',
          filter_reasons: ['minimum_recommendation_context_unsatisfied'],
          rank_signals: [],
          fallback_reason: 'chat_clarify_needed_for_missing_target_need',
          context_constraints_applied: candidatePool.pool_filters_applied,
        },
        fallback_mode: 'chat_clarify_needed_for_missing_target_need',
        missing_context: ['minimum_recommendation_context'],
        confidence: null,
        debug_meta: {
          request_context_signature: requestContext.request_context_signature,
          request_context_signature_version: requestContext.request_context_signature_version,
          candidate_pool_signature: candidatePool.candidate_pool_signature,
          candidate_pool_signature_version: candidatePool.candidate_pool_signature_version,
          mainline_status: 'needs_more_context',
          strictness_source: requestContext.strictness_source,
        },
      },
      raw: null,
      needs_more_context: true,
    };
  }
  if (intent.needs_clarification && requestContext.strictness_mode === 'strict') {
    return {
      intent,
      request_context: requestContext,
      candidate_pool: candidatePool,
      core_result: {
        recommendation_groups: [],
        context_usage: requestContext.context_usage,
        decision_trace: {
          eligibility_decision: 'needs_more_context',
          filter_reasons: ['insufficient_target_need'],
          rank_signals: [],
          fallback_reason: 'missing_required_context_under_strict_mode',
          context_constraints_applied: candidatePool.pool_filters_applied,
        },
        fallback_mode: 'missing_required_context_under_strict_mode',
        missing_context: ['target_need'],
        confidence: null,
        debug_meta: {
          request_context_signature: requestContext.request_context_signature,
          request_context_signature_version: requestContext.request_context_signature_version,
          candidate_pool_signature: candidatePool.candidate_pool_signature,
          candidate_pool_signature_version: candidatePool.candidate_pool_signature_version,
          mainline_status: 'needs_more_context',
          strictness_source: requestContext.strictness_source,
        },
      },
      raw: null,
      needs_more_context: true,
    };
  }
  if (entryType === 'direct' && requestContext.strictness_mode === 'strict' && !requestContext.minimum_recommendation_context_satisfied) {
    return {
      intent,
      request_context: requestContext,
      candidate_pool: candidatePool,
      core_result: {
        recommendation_groups: [],
        context_usage: requestContext.context_usage,
        decision_trace: {
          eligibility_decision: 'needs_more_context',
          filter_reasons: ['minimum_recommendation_context_unsatisfied'],
          rank_signals: [],
          fallback_reason: 'missing_required_context_under_strict_mode',
          context_constraints_applied: candidatePool.pool_filters_applied,
        },
        fallback_mode: 'missing_required_context_under_strict_mode',
        missing_context: ['minimum_recommendation_context'],
        confidence: null,
        debug_meta: {
          request_context_signature: requestContext.request_context_signature,
          request_context_signature_version: requestContext.request_context_signature_version,
          candidate_pool_signature: candidatePool.candidate_pool_signature,
          candidate_pool_signature_version: candidatePool.candidate_pool_signature_version,
          mainline_status: 'needs_more_context',
          strictness_source: requestContext.strictness_source,
        },
      },
      raw: null,
      needs_more_context: true,
    };
  }
  const coreResult = await runRecommendationCore({
    coreRunner,
    coreInput: {
      ...coreInput,
      sharedRequestContext: requestContext,
    },
    requestContext,
    candidatePool,
  });
  const rawCandidatePool = asArray(coreResult.raw && coreResult.raw.candidatePool);
  const finalizedCandidatePool = buildCandidatePool({
    requestContext,
    targetNeed: intent.target_need,
    candidatePool: rawCandidatePool,
    poolSource: pickFirstTrimmed(coreResult.raw && coreResult.raw.poolSource, recommendationPoolSource(rawCandidatePool)),
    unresolvedReason: rawCandidatePool.length ? null : candidatePool.unresolved_reason,
  });
  coreResult.debug_meta = {
    ...(isPlainObject(coreResult.debug_meta) ? coreResult.debug_meta : {}),
    request_context_signature: requestContext.request_context_signature,
    request_context_signature_version: requestContext.request_context_signature_version,
    candidate_pool_signature: finalizedCandidatePool.candidate_pool_signature,
    candidate_pool_signature_version: finalizedCandidatePool.candidate_pool_signature_version,
    strictness_source: requestContext.strictness_source,
  };
  if (isPlainObject(coreResult.raw)) {
    const norm = isPlainObject(coreResult.raw.norm) ? coreResult.raw.norm : null;
    const payload = norm && isPlainObject(norm.payload) ? norm.payload : null;
    const recommendationMeta = payload && isPlainObject(payload.recommendation_meta) ? payload.recommendation_meta : null;
    const normalizedUsage = {
      ...requestContext.context_usage,
      request_context_signature: requestContext.request_context_signature,
      request_context_signature_version: requestContext.request_context_signature_version,
      candidate_pool_signature: finalizedCandidatePool.candidate_pool_signature,
      candidate_pool_signature_version: finalizedCandidatePool.candidate_pool_signature_version,
      strictness_source: requestContext.strictness_source,
    };
    if (recommendationMeta) {
      recommendationMeta.analysis_context_usage = normalizedUsage;
      recommendationMeta.request_context_signature = requestContext.request_context_signature;
      recommendationMeta.request_context_signature_version = requestContext.request_context_signature_version;
      recommendationMeta.candidate_pool_signature = finalizedCandidatePool.candidate_pool_signature;
      recommendationMeta.candidate_pool_signature_version = finalizedCandidatePool.candidate_pool_signature_version;
      recommendationMeta.strictness_source = requestContext.strictness_source;
    }
    if (payload) {
      payload.request_context_signature = requestContext.request_context_signature;
      payload.request_context_signature_version = requestContext.request_context_signature_version;
      payload.candidate_pool_signature = finalizedCandidatePool.candidate_pool_signature;
      payload.candidate_pool_signature_version = finalizedCandidatePool.candidate_pool_signature_version;
    }
    if (isPlainObject(coreResult.raw.upstreamDebug)) {
      coreResult.raw.upstreamDebug.analysis_context_usage = normalizedUsage;
    }
  }
  return {
    intent,
    request_context: requestContext,
    candidate_pool: finalizedCandidatePool,
    core_result: coreResult,
    raw: coreResult.raw,
    needs_more_context: false,
  };
}

function recommendationPoolSource(candidatePool = []) {
  return asArray(candidatePool).length ? 'catalog_candidates' : 'none';
}

module.exports = {
  SHARED_RECOMMENDATION_STACK_VERSION,
  REQUEST_CONTEXT_SIGNATURE_VERSION,
  CANDIDATE_POOL_SIGNATURE_VERSION,
  MIN_CONTEXT_RULE_VERSION,
  RECOMMENDATION_STEP_QUERY_POLICY_V1,
  RECOMMENDATION_VIABLE_THRESHOLD_POLICY_V1,
  RAW_CANDIDATE_POOL_DEBUG_SIGNATURE_VERSION,
  GROUP_SEMANTICS_VERSION,
  STRICTNESS_SOURCES,
  RECOMMENDATION_MIN_CONTEXT_RULES_V1,
  STEP_THRESHOLDS,
  normalizeRecommendationIntent,
  buildRecommendationRequestContext,
  buildCandidatePool,
  resolveRecommendationTargetContext,
  buildSameFamilyQueryLevels,
  finalizeRecommendationCandidatePools,
  shouldStopStepAwareBroadening,
  deriveStepAwareEmptyReason,
  inferSlotForStep,
  runRecommendationCore,
  runRecommendationSharedStack,
};
