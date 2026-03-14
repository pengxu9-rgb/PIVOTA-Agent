const crypto = require('crypto');
const {
  buildAnalysisContextSnapshotV1,
  resolveAnalysisContextForTask,
  buildRecommendationAnalysisContextFromSnapshot,
} = require('./analysisContextSnapshot');

const SHARED_RECOMMENDATION_STACK_VERSION = 'aurora_recommendation_shared_stack_v1';

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
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, length);
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

function looksLikeGenericRecoAsk(text = '') {
  const normalized = asString(text).toLowerCase();
  if (!normalized) return false;
  return /\brecommend|recommendation|product rec|products\b/.test(normalized)
    || /推荐|护肤品|产品推荐/.test(normalized);
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

  if (targetStep) {
    return {
      need_id: `step:${normalizeNeedToken(targetStep) || 'unknown'}`,
      need_type: 'fill_gap',
      target_need: targetStep,
      recommendation_mode: coerceRecommendationMode({ targetStep }),
      entry_type: entryType === 'chat' ? 'chat' : 'direct',
      intent_confidence: 0.92,
      needs_clarification: false,
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
  };
}

function buildFallbackPolicy({ entryType = 'direct' } = {}) {
  return entryType === 'chat'
    ? 'chat_clarify_friendly_v1'
    : 'structured_needs_more_context_v1';
}

function deriveStrictnessMode({ entryType = 'direct' } = {}) {
  return entryType === 'chat' ? 'normal' : 'strict';
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
  fallbackPolicy = null,
  requestGoalScope = 'active_only',
} = {}) {
  const normalizedIntent = isPlainObject(intent)
    ? intent
    : normalizeRecommendationIntent({ entryType: 'direct' });
  const entryType = normalizedIntent.entry_type === 'chat' ? 'chat' : 'direct';
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
  const effectiveStrictnessMode = strictnessMode || deriveStrictnessMode({ entryType });
  const effectiveFallbackPolicy = fallbackPolicy || buildFallbackPolicy({ entryType });
  const requestContextSignature = stableHash({
    intent: {
      need_id: normalizedIntent.need_id,
      need_type: normalizedIntent.need_type,
      target_need: normalizedIntent.target_need,
      recommendation_mode: normalizedIntent.recommendation_mode,
      entry_type: normalizedIntent.entry_type,
    },
    hard: taskContext.task_hard_context,
    soft: taskContext.task_soft_context,
    strictness_mode: effectiveStrictnessMode,
    fallback_policy: effectiveFallbackPolicy,
    request_goal_scope: requestGoalScope,
  });

  return {
    stack_version: SHARED_RECOMMENDATION_STACK_VERSION,
    intent: normalizedIntent,
    need_id: normalizedIntent.need_id,
    need_type: normalizedIntent.need_type,
    target_need: normalizedIntent.target_need,
    recommendation_mode: normalizedIntent.recommendation_mode,
    entry_type: normalizedIntent.entry_type,
    strictness_mode: effectiveStrictnessMode,
    fallback_policy: effectiveFallbackPolicy,
    strictness_source: 'default',
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
    context_mode: String(taskContext.context_mode || '').trim() || 'no_context',
    context_usage: {
      snapshot_present: Boolean(taskContext.snapshot_present),
      snapshot_fields_used: asArray(taskContext.snapshot_fields_used),
      hard_context_fields_used: asArray(taskContext.hard_context_fields_used),
      soft_context_fields_used: asArray(taskContext.soft_context_fields_used),
      explicit_override_applied: Boolean(taskContext.explicit_override_applied),
      context_mode: String(taskContext.context_mode || '').trim() || 'no_context',
      adapter_version: String(taskContext.adapter_version || '').trim() || null,
      strictness_source: 'default',
    },
    request_context_signature: requestContextSignature,
    analysis_context_snapshot: effectiveSnapshot,
    task_context: taskContext,
  };
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
    candidate_pool_signature: stableHash({
      ids: normalizedPool.map((item) => item.normalized_candidate_id).sort(),
      pool_source: poolSource,
      filters,
      constraints_version: constraintsVersion,
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
  llmFailureClass = '',
  upstreamFailureCode = '',
  mainlineStatus = '',
  promptContractOk = true,
} = {}) {
  if (intent && intent.needs_clarification && entryType === 'chat') return 'chat_clarify_needed_for_missing_target_need';
  if (intent && intent.needs_clarification && strictnessMode === 'strict') return 'missing_required_context_under_strict_mode';
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
      candidate_pool_signature: candidatePool && candidatePool.candidate_pool_signature,
      mainline_status: raw && raw.mainlineStatus ? raw.mainlineStatus : null,
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
  });
  const candidatePool = buildCandidatePool({
    requestContext,
    targetNeed: intent.target_need,
    candidatePool: [],
    poolSource: 'precore',
  });
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
          candidate_pool_signature: candidatePool.candidate_pool_signature,
          mainline_status: 'needs_more_context',
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
    candidate_pool_signature: finalizedCandidatePool.candidate_pool_signature,
  };
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
  normalizeRecommendationIntent,
  buildRecommendationRequestContext,
  buildCandidatePool,
  runRecommendationCore,
  runRecommendationSharedStack,
};
