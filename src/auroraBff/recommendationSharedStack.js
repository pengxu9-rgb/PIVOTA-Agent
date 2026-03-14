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

function normalizeStringArray(values, max = 12) {
  return uniqCaseInsensitiveStrings(
    (Array.isArray(values) ? values : [values])
      .flatMap((item) => {
        if (Array.isArray(item)) return item;
        return [item];
      })
      .map((item) => normalizeQueryToken(item))
      .filter(Boolean),
    max,
  );
}

function collectRecoContextGoalTerms(recoContext) {
  const hard = isPlainObject(recoContext?.task_hard_context) ? recoContext.task_hard_context : {};
  const soft = isPlainObject(recoContext?.task_soft_context) ? recoContext.task_soft_context : {};
  return normalizeStringArray([
    ...(Array.isArray(hard.active_goals) ? hard.active_goals : []),
    ...(Array.isArray(soft.background_goals) ? soft.background_goals : []),
    ...(Array.isArray(soft.active_goals) ? soft.active_goals : []),
  ], 6);
}

function collectRecoContextIngredientTerms(recoContext) {
  const hard = isPlainObject(recoContext?.task_hard_context) ? recoContext.task_hard_context : {};
  const soft = isPlainObject(recoContext?.task_soft_context) ? recoContext.task_soft_context : {};
  return normalizeStringArray([
    ...(Array.isArray(hard.ingredient_targets) ? hard.ingredient_targets : []),
    ...(Array.isArray(soft.ingredient_targets) ? soft.ingredient_targets : []),
  ], 6);
}

function collectRecoContextConcernTerms(recoContext) {
  const hard = isPlainObject(recoContext?.task_hard_context) ? recoContext.task_hard_context : {};
  const soft = isPlainObject(recoContext?.task_soft_context) ? recoContext.task_soft_context : {};
  const out = [];
  const barrierStatus = pickFirstTrimmed(hard.barrier_status, soft.barrier_status);
  const sensitivity = pickFirstTrimmed(hard.sensitivity, soft.sensitivity);
  if (barrierStatus === 'impaired' || barrierStatus === 'reactive') out.push('barrier repair');
  if (barrierStatus === 'healthy') out.push('skin barrier');
  if (sensitivity === 'high' || sensitivity === 'medium') out.push('sensitive skin');
  const riskAxes = Array.isArray(soft.risk_axes) ? soft.risk_axes : [];
  for (const item of riskAxes) {
    const text = normalizeQueryToken(item);
    if (!text) continue;
    out.push(text.replace(/:/g, ' '));
  }
  return normalizeStringArray(out, 6);
}

function collectProfileGoalTerms(profileSummary, recoContext = null) {
  const raw = [];
  if (typeof profileSummary?.goal_primary === 'string') raw.push(profileSummary.goal_primary);
  if (Array.isArray(profileSummary?.goals)) raw.push(...profileSummary.goals);
  raw.push(...collectRecoContextGoalTerms(recoContext));
  return uniqCaseInsensitiveStrings(
    raw
      .map((item) => normalizeQueryToken(item))
      .filter(Boolean)
      .flatMap((item) => item.split(/[|,/;]+/g).map((token) => token.trim()).filter(Boolean)),
    6,
  );
}

function collectIngredientTerms(ingredientContext, recoContext = null) {
  const ctx = isPlainObject(ingredientContext) ? ingredientContext : {};
  const candidates = Array.isArray(ctx.candidates) ? ctx.candidates : [];
  return uniqCaseInsensitiveStrings(
    [
      normalizeQueryToken(ctx.query),
      ...candidates.map((item) => normalizeQueryToken(item)),
      ...collectRecoContextIngredientTerms(recoContext),
    ].filter(Boolean),
    4,
  );
}

function collectConcernTerms(profileSummary, ingredientContext, recoContext = null) {
  const raw = [
    ...collectProfileGoalTerms(profileSummary, recoContext),
    normalizeQueryToken(ingredientContext && ingredientContext.goal),
    ...collectRecoContextConcernTerms(recoContext),
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
  recoContext = null,
  lang = 'EN',
  seedTerms = [],
} = {}) {
  const step = normalizeRecoTargetStep(targetContext && targetContext.resolved_target_step);
  if (!step) return [];
  const aliases = STEP_QUERY_ALIASES[step] || [step];
  const stepPrimary = aliases[0] || step;
  const goalTerms = collectProfileGoalTerms(profileSummary, recoContext).slice(0, 2);
  const ingredientTerms = collectIngredientTerms(ingredientContext, recoContext).slice(0, 2);
  const concernTerms = collectConcernTerms(profileSummary, ingredientContext, recoContext).slice(0, 2);
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

function productKey(product) {
  const row = isPlainObject(product) ? product : {};
  const productId = pickFirstTrimmed(row.product_id, row.productId, row.id);
  const merchantId = pickFirstTrimmed(row.merchant_id, row.merchantId);
  const name = pickFirstTrimmed(row.brand, row.name, row.display_name, row.displayName);
  return `${productId}::${merchantId}::${name}`.toLowerCase();
}

function buildCandidateResolutionText(product) {
  const row = isPlainObject(product) ? product : {};
  return [
    pickFirstTrimmed(row.display_name, row.displayName, row.name, row.title),
    ...(Array.isArray(row.tags) ? row.tags : []),
    ...(Array.isArray(row.tag_tokens) ? row.tag_tokens : []),
    ...(Array.isArray(row.ingredient_tokens) ? row.ingredient_tokens : []),
    pickFirstTrimmed(row.retrieval_query, row.query, row.retrieval_reason),
  ]
    .map((item) => normalizeQueryToken(item))
    .filter(Boolean)
    .join(' ');
}

function normalizeCandidateStep(product, { targetContext } = {}) {
  const row = isPlainObject(product) ? product : {};
  const structuredRaw = pickFirstTrimmed(
    row.product_type,
    row.productType,
    row.category,
    row.category_name,
    row.categoryName,
    row.step,
    row.type,
  );
  const structuredStep = normalizeProductType(structuredRaw);
  if (structuredStep) {
    return {
      candidate_step: structuredStep,
      candidate_step_source: 'structured_category',
      candidate_step_confidence: 'high',
    };
  }
  const resolutionText = buildCandidateResolutionText(row);
  const textResolution = resolutionText
    ? resolveRecoTargetStepIntent({
      text: resolutionText,
    })
    : {
      resolved_target_step: null,
      resolved_target_step_confidence: 'none',
      resolved_target_step_source: 'none',
    };
  if (textResolution.resolved_target_step) {
    return {
      candidate_step: normalizeRecoTargetStep(textResolution.resolved_target_step),
      candidate_step_source:
        textResolution.resolved_target_step_source === 'message_alias'
          ? 'title_or_tag_alias'
          : textResolution.resolved_target_step_source === 'message_concept'
            ? 'title_or_tag_concept'
            : textResolution.resolved_target_step_source || 'title_or_tag',
      candidate_step_confidence: textResolution.resolved_target_step_confidence || 'medium',
    };
  }
  const retrievalQuery = normalizeQueryToken(row.retrieval_query || row.query);
  if (retrievalQuery && targetContext?.resolved_target_step) {
    const retrievalResolution = resolveRecoTargetStepIntent({
      text: retrievalQuery,
    });
    if (normalizeRecoTargetStep(retrievalResolution.resolved_target_step) === normalizeRecoTargetStep(targetContext.resolved_target_step)) {
      return {
        candidate_step: normalizeRecoTargetStep(retrievalResolution.resolved_target_step),
        candidate_step_source: 'retrieval_trace',
        candidate_step_confidence: retrievalResolution.resolved_target_step_confidence || 'low',
      };
    }
  }
  return {
    candidate_step: null,
    candidate_step_source: 'none',
    candidate_step_confidence: 'none',
  };
}

function resolveCandidateFamilyRelation(targetStep, candidateStep) {
  const target = normalizeRecoTargetStep(targetStep);
  const candidate = normalizeRecoTargetStep(candidateStep);
  if (!target) return 'same_family';
  if (!candidate) return 'unknown';
  return getRecoTargetFamilyRelation(target, candidate);
}

function buildCandidateTextSearch(product) {
  const row = isPlainObject(product) ? product : {};
  return [
    pickFirstTrimmed(row.brand),
    pickFirstTrimmed(row.display_name, row.displayName, row.name, row.title),
    pickFirstTrimmed(row.category, row.category_name, row.categoryName, row.product_type, row.productType),
    ...(Array.isArray(row.ingredient_tokens) ? row.ingredient_tokens : []),
    ...(Array.isArray(row.tags) ? row.tags : []),
    ...(Array.isArray(row.tag_tokens) ? row.tag_tokens : []),
  ]
    .map((item) => normalizeQueryToken(item).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function arrayIncludesPhrase(text, values = []) {
  const haystack = String(text || '').trim().toLowerCase();
  if (!haystack) return false;
  return (Array.isArray(values) ? values : []).some((raw) => {
    const token = normalizeQueryToken(raw).toLowerCase();
    return token && haystack.includes(token);
  });
}

function clampScore(value, min = 0, max = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function scoreGoalContext(goal, productText) {
  const token = normalizeQueryToken(goal).toLowerCase();
  if (!token) return 0;
  if (/barrier|repair|修护/.test(token)) {
    return /(barrier|repair|ceramide|cica|soothing|calming|gel cream|cream|lotion|面霜|保湿)/i.test(productText) ? 0.28 : 0;
  }
  if (/hydrat|dry|保湿|补水/.test(token)) {
    return /(hydrat|moist|cream|lotion|emulsion|gel cream|保湿|补水|乳液|面霜)/i.test(productText) ? 0.2 : 0;
  }
  if (/acne|breakout|痘/.test(token)) {
    return /(niacinamide|salicylic|azelaic|blemish|acne|spot)/i.test(productText) ? 0.16 : 0;
  }
  return 0;
}

function computeCandidateContextSignals(product, recoContext = null) {
  const row = isPlainObject(product) ? product : {};
  const hard = isPlainObject(recoContext?.task_hard_context) ? recoContext.task_hard_context : {};
  const soft = isPlainObject(recoContext?.task_soft_context) ? recoContext.task_soft_context : {};
  const productText = buildCandidateTextSearch(row);
  const ingredientTokens = (Array.isArray(row.ingredient_tokens) ? row.ingredient_tokens : [])
    .map((item) => normalizeQueryToken(item).toLowerCase())
    .filter(Boolean);
  const hardAvoid = normalizeStringArray(hard.ingredient_avoid, 12).map((item) => item.toLowerCase());
  const targetTerms = normalizeStringArray([
    ...(Array.isArray(hard.ingredient_targets) ? hard.ingredient_targets : []),
    ...(Array.isArray(soft.ingredient_targets) ? soft.ingredient_targets : []),
  ], 12);
  const goals = normalizeStringArray([
    ...(Array.isArray(hard.active_goals) ? hard.active_goals : []),
    ...(Array.isArray(soft.background_goals) ? soft.background_goals : []),
  ], 8);
  const barrierStatus = pickFirstTrimmed(hard.barrier_status, soft.barrier_status).toLowerCase();
  const sensitivity = pickFirstTrimmed(hard.sensitivity, soft.sensitivity).toLowerCase();
  const strongActivePattern = /\b(retinol|retinoid|aha|bha|acid|peel|exfoliat|benzoyl)\b/i;
  let constraintConflict = false;
  let contextFitScore = 0;

  if (hardAvoid.length && (arrayIncludesPhrase(productText, hardAvoid) || ingredientTokens.some((token) => hardAvoid.some((avoid) => token.includes(avoid))))) {
    constraintConflict = true;
  }
  if (!constraintConflict && (barrierStatus === 'impaired' || barrierStatus === 'reactive') && strongActivePattern.test(productText)) {
    constraintConflict = true;
  }
  if (!constraintConflict && sensitivity === 'high' && strongActivePattern.test(productText)) {
    constraintConflict = true;
  }
  if (constraintConflict) {
    return {
      context_fit_score: 0,
      constraint_conflict: true,
      artifact_context_applied: goals.length > 0 || targetTerms.length > 0 || Boolean(barrierStatus || sensitivity || hardAvoid.length),
    };
  }

  for (const goal of goals) {
    contextFitScore += scoreGoalContext(goal, productText);
  }
  if (barrierStatus === 'impaired' || barrierStatus === 'reactive') {
    if (/(barrier|repair|ceramide|cica|soothing|calming|cream|lotion|面霜|保湿)/i.test(productText)) contextFitScore += 0.24;
  }
  if (sensitivity === 'high' || sensitivity === 'medium') {
    if (/(gentle|fragrance free|fragrance-free|for sensitive|sensitive skin|soothing|calming|无香|敏感)/i.test(productText)) contextFitScore += 0.18;
  }
  if (targetTerms.length) {
    for (const term of targetTerms) {
      if (arrayIncludesPhrase(productText, [term]) || ingredientTokens.some((token) => token.includes(term.toLowerCase()))) {
        contextFitScore += 0.18;
      }
    }
  }

  return {
    context_fit_score: clampScore(contextFitScore, 0, 1),
    constraint_conflict: false,
    artifact_context_applied: goals.length > 0 || targetTerms.length > 0 || Boolean(barrierStatus || sensitivity || hardAvoid.length),
  };
}

function normalizeViabilityScore({ relation, candidateStep, targetStep }) {
  if (!targetStep) return 0.75;
  if (relation === 'same_family') {
    return candidateStep === targetStep ? 1 : 0.9;
  }
  if (relation === 'adjacent_family') return 0.58;
  if (relation === 'unknown') return 0.42;
  return 0;
}

function classifyRecommendationCandidate(product, { targetContext, recoContext } = {}) {
  const row = isPlainObject(product) ? product : null;
  if (!row) return null;
  const skincare = isSkincareCandidate(row);
  const stepResolution = normalizeCandidateStep(row, { targetContext });
  const candidateStep = stepResolution.candidate_step;
  const stepAwareIntent = Boolean(targetContext && targetContext.step_aware_intent && targetContext.resolved_target_step);
  const resolvedTargetStep = normalizeRecoTargetStep(targetContext && targetContext.resolved_target_step);
  const relation = stepAwareIntent
    ? resolveCandidateFamilyRelation(resolvedTargetStep, candidateStep)
    : 'same_family';
  const contextSignals = computeCandidateContextSignals(row, recoContext);
  const stepFitScore = normalizeViabilityScore({
    relation,
    candidateStep,
    targetStep: resolvedTargetStep,
  });
  const selectionScore = clampScore(stepFitScore + Number(contextSignals.context_fit_score || 0), 0, 2);

  let bucket = 'viable';
  let reason = 'generic_viable';
  if (!skincare) {
    bucket = 'hard_reject';
    reason = 'non_skincare_or_blacklisted';
  } else if (contextSignals.constraint_conflict) {
    bucket = 'hard_reject';
    reason = 'hard_constraint_conflict';
  } else if (stepAwareIntent && relation === 'incompatible_family') {
    bucket = 'hard_reject';
    reason = 'incompatible_family';
  } else if (stepAwareIntent && (relation === 'adjacent_family' || relation === 'unknown')) {
    bucket = 'soft_mismatch';
    reason = relation === 'adjacent_family' ? 'adjacent_family' : 'step_unresolved';
  } else if (stepAwareIntent && relation === 'same_family') {
    bucket = 'viable';
    reason = candidateStep === resolvedTargetStep ? 'exact_step_match' : 'same_family_match';
  }

  const itemTargetFidelity =
    bucket === 'viable'
      ? clampScore(
        Math.max(
          stepFitScore,
          (stepFitScore * 0.7) + (Number(contextSignals.context_fit_score || 0) * 0.3),
        ),
        0,
        1,
      )
      : bucket === 'soft_mismatch'
        ? 0.5
        : 0;

  return {
    product: row,
    candidate_step: candidateStep,
    candidate_step_source: stepResolution.candidate_step_source || 'none',
    candidate_step_confidence: stepResolution.candidate_step_confidence || 'none',
    family_relation: relation,
    bucket,
    reason,
    score: stepFitScore,
    step_fit_score: stepFitScore,
    context_fit_score: Number(contextSignals.context_fit_score || 0),
    constraint_conflict: Boolean(contextSignals.constraint_conflict),
    artifact_context_applied: Boolean(contextSignals.artifact_context_applied),
    selection_score: selectionScore,
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

function finalizeRecommendationCandidatePools(rawCandidates, { targetContext, recoContext = null } = {}) {
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
    .map((row) => classifyRecommendationCandidate(row, { targetContext, recoContext }))
    .filter(Boolean);

  const viable = classified
    .filter((row) => row.bucket === 'viable')
    .sort((left, right) => right.selection_score - left.selection_score || right.step_fit_score - left.step_fit_score);
  const softMismatch = classified
    .filter((row) => row.bucket === 'soft_mismatch')
    .sort((left, right) => right.selection_score - left.selection_score || right.step_fit_score - left.step_fit_score);
  const hardReject = classified.filter((row) => row.bucket === 'hard_reject');
  const thresholds = getStepPolicy(targetContext && targetContext.resolved_target_step);
  const exactStepViableCount = viable.filter((row) => row.candidate_step && row.candidate_step === targetContext?.resolved_target_step).length;
  const sameFamilyViableCount = viable.length;
  const averageContextFit = viable.length
    ? viable.reduce((sum, row) => sum + Number(row.context_fit_score || 0), 0) / viable.length
    : 0;
  const sameFamilySuccessThresholdMet = Boolean(
    sameFamilyViableCount >= Number(thresholds.min_viable_count_for_step || 1)
      && viable.some((row) => Number(row.selection_score || 0) >= Number(thresholds.min_viable_quality_for_step || 0.72)),
  );
  const sameFamilyStrongViableExists = viable.some((row) => Number(row.selection_score || 0) >= Number(thresholds.min_viable_quality_for_step || 0.72));
  const selected = viable.slice(0, 3);
  const selectedFamilies = uniqCaseInsensitiveStrings(selected.map((row) => row.candidate_step || row.family_relation || 'unknown'), 3);
  const topCandidatesConverged = selectedFamilies.length <= 1;
  const primaryDisplayGroups = summarizePrimaryDisplayGroups(selected);
  const overallTargetFidelitySatisfied = primaryDisplayGroups.length > 0
    && primaryDisplayGroups.every((group) => Number(group.group_target_fidelity || 0) >= Number(thresholds.min_viable_quality_for_step || 0.72));
  const hardConstraintConflict = viable.some((row) => row.constraint_conflict === true) || selected.some((row) => row.constraint_conflict === true);
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
  const artifactContextApplied = classified.some((row) => row.artifact_context_applied === true);

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
    average_context_fit_score: Number(averageContextFit.toFixed(4)),
    artifact_context_applied: artifactContextApplied,
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
