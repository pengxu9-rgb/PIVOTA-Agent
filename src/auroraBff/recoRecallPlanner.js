const RECO_RECALL_PLAN_VERSION = 'aurora_reco_recall_plan_v1';
const BEAUTY_SEMANTIC_CONTRACT_VERSION = 'beauty_semantic_contract_v1';

function uniqueCaseInsensitiveStrings(values, max = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= Math.max(1, Number(max) || 1)) break;
  }
  return out;
}

function normalizeConcernQueryToken(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSemanticStepFamily(value) {
  const normalized = normalizeConcernQueryToken(value).toLowerCase();
  if (!normalized) return null;
  if (normalized === 'gel cream' || normalized === 'cream') return 'moisturizer';
  if (normalized === 'sun care' || normalized === 'sun protection') return 'sunscreen';
  return normalized;
}

function buildSemanticStepFamilyList(values, { includeSerumForTreatment = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const normalized = normalizeSemanticStepFamily(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  if (includeSerumForTreatment && seen.has('treatment') && !seen.has('serum')) {
    out.push('serum');
  }
  return out.slice(0, 6);
}

function deriveSemanticFamilyFromRole(role = null) {
  const roleObj = role && typeof role === 'object' && !Array.isArray(role) ? role : null;
  if (!roleObj) return null;
  const candidates = [
    roleObj.semantic_family,
    roleObj.semanticFamily,
    roleObj.family,
    roleObj.role_family,
    roleObj.roleFamily,
  ];
  for (const raw of candidates) {
    const normalized = normalizeConcernQueryToken(raw).toLowerCase();
    if (normalized) return normalized;
  }
  const roleId = normalizeConcernQueryToken(roleObj.role_id).toLowerCase();
  if (!roleId) return null;
  if (roleId.includes('oil_control') || roleId.includes('shine_control') || roleId.includes('mattify')) {
    return 'oil_control';
  }
  if (roleId.includes('sunscreen') || roleId.includes('spf') || roleId.includes('uv')) {
    return 'sunscreen';
  }
  if (roleId.includes('moisturizer') || roleId.includes('barrier')) {
    return 'moisturizer';
  }
  return roleId.replace(/_+/g, ' ');
}

function pickSemanticFamily(targetContext = null, primaryRole = null) {
  const candidates = [
    targetContext?.semantic_plan?.semantic_family,
    targetContext?.semantic_plan?.semanticFamily,
    targetContext?.framework_summary?.semantic_family,
    targetContext?.framework_summary?.semanticFamily,
    deriveSemanticFamilyFromRole(primaryRole),
  ];
  for (const raw of candidates) {
    const normalized = normalizeConcernQueryToken(raw).toLowerCase();
    if (normalized) return normalized;
  }
  return null;
}

function buildFrameworkSemanticContract({ targetContext } = {}) {
  const roles = Array.isArray(targetContext?.framework_roles)
    ? [...targetContext.framework_roles]
        .filter((role) => role && typeof role === 'object' && !Array.isArray(role))
        .sort((left, right) => Number(left?.rank || 99) - Number(right?.rank || 99))
    : [];
  const primaryRole = roles[0] || null;
  if (!primaryRole) return null;
  const supportRoles = roles.slice(1, 3);
  const targetStepFamily = normalizeSemanticStepFamily(primaryRole?.preferred_step || primaryRole?.step);
  const ingredientHypotheses = uniqueCaseInsensitiveStrings([
    ...(Array.isArray(primaryRole?.ingredient_hypotheses) ? primaryRole.ingredient_hypotheses : []),
    ...(Array.isArray(targetContext?.semantic_plan?.ingredient_hypotheses)
      ? targetContext.semantic_plan.ingredient_hypotheses
      : []),
  ], 8);
  return {
    version: BEAUTY_SEMANTIC_CONTRACT_VERSION,
    owner: 'aurora_reco_planner',
    planner_mode: 'framework_generic',
    request_class: 'generic_concern',
    target_step_family: targetStepFamily,
    primary_role_id: normalizeConcernQueryToken(primaryRole?.role_id) || null,
    support_role_ids: supportRoles
      .map((role) => normalizeConcernQueryToken(role?.role_id))
      .filter(Boolean)
      .slice(0, 4),
    semantic_family: pickSemanticFamily(targetContext, primaryRole),
    allowed_step_families: buildSemanticStepFamilyList(
      [
        targetStepFamily,
        ...supportRoles.map((role) => role?.preferred_step || role?.step),
      ],
      { includeSerumForTreatment: true },
    ),
    blocked_step_families: [],
    ingredient_hypotheses: ingredientHypotheses,
    source_surface: 'aurora_beauty_strict',
  };
}

function buildStepAwareSemanticContract({ targetContext, queryLevels } = {}) {
  const targetStepFamily = normalizeSemanticStepFamily(
    targetContext?.resolved_target_step ||
    queryLevels?.[0]?.queries?.[0]?.step,
  );
  if (!targetStepFamily) return null;
  return {
    version: BEAUTY_SEMANTIC_CONTRACT_VERSION,
    owner: 'aurora_reco_planner',
    planner_mode: 'step_aware',
    request_class: targetStepFamily === 'sunscreen' ? 'sunscreen' : 'routine_followup',
    target_step_family: targetStepFamily,
    primary_role_id: normalizeConcernQueryToken(targetContext?.primary_role_id) || `${targetStepFamily}_primary`,
    support_role_ids: [],
    semantic_family: normalizeConcernQueryToken(
      targetContext?.semantic_plan?.semantic_family ||
      targetContext?.step_aware_intent?.semantic_family ||
      targetStepFamily,
    ).toLowerCase() || null,
    allowed_step_families: buildSemanticStepFamilyList([targetStepFamily], {
      includeSerumForTreatment: targetStepFamily === 'treatment',
    }),
    blocked_step_families: [],
    ingredient_hypotheses: uniqueCaseInsensitiveStrings(
      Array.isArray(targetContext?.semantic_plan?.ingredient_hypotheses)
        ? targetContext.semantic_plan.ingredient_hypotheses
        : [],
      8,
    ),
    source_surface: 'aurora_beauty_strict',
  };
}

function buildExactLookupSemanticContract() {
  return {
    version: BEAUTY_SEMANTIC_CONTRACT_VERSION,
    owner: 'aurora_reco_planner',
    planner_mode: 'exact_product',
    request_class: 'exact_lookup',
    target_step_family: null,
    primary_role_id: null,
    support_role_ids: [],
    semantic_family: null,
    allowed_step_families: [],
    blocked_step_families: [],
    ingredient_hypotheses: [],
    source_surface: 'aurora_beauty_strict',
  };
}

function scoreTreatmentIngredientHypothesis(value) {
  const normalized = normalizeConcernQueryToken(value).toLowerCase();
  if (!normalized) return 0;
  if (/\b(salicylic|glycolic|lactic|mandelic|azelaic|retinol|retinoid|adapalene|tretinoin|benzoyl|peroxide|sulfur|aha|bha|pha|acid|exfoliant)\b/.test(normalized)) {
    return 3;
  }
  if (/\b(niacinamide|zinc|zinc pca)\b/.test(normalized)) return 2;
  return 1;
}

function buildPrimaryTreatmentIngredientQuery(role) {
  const roleObj = role && typeof role === 'object' && !Array.isArray(role) ? role : null;
  if (!roleObj) return '';
  const candidates = uniqueCaseInsensitiveStrings(
    Array.isArray(roleObj.ingredient_hypotheses) ? roleObj.ingredient_hypotheses : [],
    8,
  )
    .map((value) => normalizeConcernQueryToken(value))
    .filter(Boolean)
    .sort((left, right) => scoreTreatmentIngredientHypothesis(right) - scoreTreatmentIngredientHypothesis(left));
  const picked = candidates[0] || '';
  if (!picked || scoreTreatmentIngredientHypothesis(picked) < 3) return '';
  return normalizeConcernQueryToken(`${picked} treatment`);
}

function buildPrimaryTreatmentSemanticQueries(role) {
  const roleObj = role && typeof role === 'object' && !Array.isArray(role) ? role : null;
  if (!roleObj) return [];
  const roleId = normalizeConcernQueryToken(roleObj.role_id).toLowerCase();
  const roleLabel = normalizeConcernQueryToken(roleObj.label).toLowerCase();
  const signalText = uniqueCaseInsensitiveStrings([
    roleId,
    roleLabel,
    ...(Array.isArray(roleObj.fit_keywords) ? roleObj.fit_keywords : []),
    ...(Array.isArray(roleObj.query_terms) ? roleObj.query_terms : []),
  ], 24)
    .map((value) => normalizeConcernQueryToken(value).toLowerCase())
    .join(' ');
  if (!signalText) return [];
  const semanticQueries = [];
  if (
    /\b(oil balance|shine control|mattify|mattifying|anti-shine|sebum|balancing)\b/.test(signalText)
  ) {
    semanticQueries.push(
      'shine control serum',
      'mattifying serum',
      'balancing serum oily skin',
    );
  }
  return uniqueCaseInsensitiveStrings(semanticQueries, 3);
}

function flattenPlanEntries(stages) {
  return (Array.isArray(stages) ? stages : []).flatMap((stage) => {
    const stageObj = stage && typeof stage === 'object' && !Array.isArray(stage) ? stage : null;
    if (!stageObj) return [];
    return Array.isArray(stageObj.entries) ? stageObj.entries : [];
  });
}

function buildStage({
  stageId,
  roleId = null,
  roleRank = null,
  sourceScope = 'internal',
  queries = [],
  concurrency = 1,
  maxAttemptsForStage = 1,
  stopOnViableMatch = false,
  reasonForInclusion = '',
  runIf = 'always',
  preferredStep = null,
  slot = null,
} = {}) {
  const normalizedQueries = uniqueCaseInsensitiveStrings(
    queries,
    Math.max(1, Number(maxAttemptsForStage) || 1),
  );
  if (!normalizedQueries.length) return null;
  const stage = {
    stage_id: String(stageId || '').trim() || 'stage',
    role_id: roleId ? String(roleId).trim() : null,
    role_rank: Number.isFinite(Number(roleRank)) ? Number(roleRank) : null,
    source_scope: String(sourceScope || 'internal').trim().toLowerCase() === 'external_seed'
      ? 'external_seed'
      : 'internal',
    concurrency: Math.max(1, Number(concurrency) || 1),
    max_attempts_for_stage: Math.max(1, Number(maxAttemptsForStage) || 1),
    stop_on_viable_match: stopOnViableMatch === true,
    reason_for_inclusion: String(reasonForInclusion || '').trim() || null,
    run_if: String(runIf || 'always').trim() || 'always',
    preferred_step: preferredStep ? String(preferredStep).trim() : null,
    slot: slot ? String(slot).trim().toLowerCase() : null,
  };
  stage.entries = normalizedQueries.map((query, index) => ({
    stage_id: stage.stage_id,
    role_id: stage.role_id,
    role_rank: stage.role_rank,
    source_scope: stage.source_scope,
    query,
    query_index: index,
    max_attempts_for_stage: stage.max_attempts_for_stage,
    stop_on_viable_match: stage.stop_on_viable_match,
    reason_for_inclusion: stage.reason_for_inclusion,
    preferred_step: stage.preferred_step,
    slot: stage.slot,
  }));
  return stage;
}

function buildFrameworkRoleQueries(role, concernText, maxQueries, { allowConcernFallback = false } = {}) {
  const roleObj = role && typeof role === 'object' && !Array.isArray(role) ? role : null;
  if (!roleObj) return [];
  const preferredStep = String(roleObj.preferred_step || '').trim();
  const roleQueries = Array.isArray(roleObj.query_terms) ? roleObj.query_terms : [];
  const out = [];
  if (roleQueries.length > 0) out.push(roleQueries[0]);
  if (allowConcernFallback && String(preferredStep).trim().toLowerCase() === 'treatment') {
    const ingredientLedQuery = buildPrimaryTreatmentIngredientQuery(roleObj);
    if (ingredientLedQuery) out.push(ingredientLedQuery);
    out.push(...buildPrimaryTreatmentSemanticQueries(roleObj));
  }
  out.push(...roleQueries.slice(1));
  if (
    allowConcernFallback
    && String(preferredStep).trim().toLowerCase() === 'treatment'
    && roleQueries.length <= 1
  ) {
    const roleLabelOrIdQuery = normalizeConcernQueryToken(
      String(roleObj.label || roleObj.role_id || '').replace(/[-_/]+/g, ' '),
    ).toLowerCase();
    if (roleLabelOrIdQuery) out.push(roleLabelOrIdQuery);
  }
  if (allowConcernFallback && concernText) {
    if (preferredStep) out.push(`${concernText} ${preferredStep}`);
    out.push(concernText);
  }
  return uniqueCaseInsensitiveStrings(out, maxQueries);
}

function buildFrameworkSupportStageId(roleId, sourceScope = 'internal') {
  const normalizedRoleId = String(roleId || '').trim() || 'role';
  return String(sourceScope || '').trim().toLowerCase() === 'external_seed'
    ? `framework_stage_c_support_${normalizedRoleId}_external_seed`
    : `framework_stage_c_support_${normalizedRoleId}`;
}

function buildFrameworkGenericRecallPlan({ targetContext } = {}) {
  const targetObj = targetContext && typeof targetContext === 'object' && !Array.isArray(targetContext)
    ? targetContext
    : null;
  const roles = Array.isArray(targetObj?.framework_roles)
    ? [...targetObj.framework_roles]
        .filter((role) => role && typeof role === 'object' && !Array.isArray(role))
        .sort((left, right) => Number(left?.rank || 99) - Number(right?.rank || 99))
    : [];
  if (!roles.length) {
    return {
      version: RECO_RECALL_PLAN_VERSION,
      mode: 'framework_generic',
      budget: {
        max_query_entries: 4,
        max_upstream_attempt_count: 4,
      },
      stages: [],
      entries: [],
    };
  }

  const concernText = String(targetObj?.framework_summary?.concern_text || '').trim().replace(/\s+/g, ' ');
  const primaryRole = roles[0] || null;
  const supportRoles = roles.slice(1, 3);
  const supportStages = supportRoles.flatMap((role) => {
    const roleId = role?.role_id || null;
    const preferredStep = role?.preferred_step || null;
    const slot = Array.isArray(role?.routine_slots) ? role.routine_slots[0] || null : null;
    return [
      buildStage({
        stageId: buildFrameworkSupportStageId(roleId, 'internal'),
        roleId,
        roleRank: role?.rank || null,
        sourceScope: 'internal',
        queries: buildFrameworkRoleQueries(role, concernText, 1, { allowConcernFallback: false }),
        concurrency: 1,
        maxAttemptsForStage: 1,
        stopOnViableMatch: false,
        reasonForInclusion: 'support_role_internal',
        runIf: 'if_surface_count_below_target',
        preferredStep,
        slot,
      }),
      buildStage({
        stageId: buildFrameworkSupportStageId(roleId, 'external_seed'),
        roleId,
        roleRank: role?.rank || null,
        sourceScope: 'external_seed',
        queries: buildFrameworkRoleQueries(role, concernText, 1, { allowConcernFallback: false }),
        concurrency: 1,
        maxAttemptsForStage: 1,
        stopOnViableMatch: false,
        reasonForInclusion: 'support_role_external_seed',
        runIf: 'if_surface_count_below_target',
        preferredStep,
        slot,
      }),
    ].filter(Boolean);
  });

  const stages = [
    buildStage({
      stageId: 'framework_stage_a_primary_internal',
      roleId: primaryRole?.role_id || null,
      roleRank: primaryRole?.rank || 1,
      sourceScope: 'internal',
      queries: buildFrameworkRoleQueries(primaryRole, concernText, 3, { allowConcernFallback: true }),
      concurrency: 2,
      maxAttemptsForStage: 3,
      stopOnViableMatch: true,
      reasonForInclusion: 'primary_role_internal',
      runIf: 'always',
      preferredStep: primaryRole?.preferred_step || null,
    }),
    buildStage({
      stageId: 'framework_stage_b_primary_external_seed',
      roleId: primaryRole?.role_id || null,
      roleRank: primaryRole?.rank || 1,
      sourceScope: 'external_seed',
      queries: buildFrameworkRoleQueries(primaryRole, concernText, 3, { allowConcernFallback: true }),
      concurrency: 1,
      maxAttemptsForStage: 3,
      stopOnViableMatch: true,
      reasonForInclusion: 'primary_role_external_seed',
      runIf: 'if_no_primary_viable_or_transient_only',
      preferredStep: primaryRole?.preferred_step || null,
    }),
    ...supportStages,
  ].filter(Boolean);
  const entries = flattenPlanEntries(stages);
  const maxQueryEntries = entries.length;

  return {
    version: RECO_RECALL_PLAN_VERSION,
    mode: 'framework_generic',
    budget: {
      max_query_entries: maxQueryEntries,
      max_upstream_attempt_count: maxQueryEntries,
      stage_concurrency: {
        framework_stage_a_primary_internal: 2,
        framework_stage_b_primary_external_seed: 1,
        ...Object.fromEntries(
          supportStages
            .map((stage) => [String(stage?.stage_id || '').trim(), 1])
            .filter(([stageId]) => Boolean(stageId)),
        ),
      },
    },
    stages,
    entries,
  };
}

function buildStepAwareRecallPlan({ queryLevels } = {}) {
  const levels = Array.isArray(queryLevels) ? queryLevels : [];
  const stages = [];
  for (const level of levels) {
    const levelObj = level && typeof level === 'object' && !Array.isArray(level) ? level : null;
    if (!levelObj) continue;
    const queries = (Array.isArray(levelObj.queries) ? levelObj.queries : [])
      .map((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null))
      .filter(Boolean)
      .slice(0, 2);
    if (!queries.length) continue;
    const first = queries[0];
    const stage = buildStage({
      stageId: String(levelObj.ladder_level || `step_level_${stages.length + 1}`).trim() || `step_level_${stages.length + 1}`,
      roleId: null,
      roleRank: stages.length + 1,
      sourceScope: 'internal',
      queries: queries.map((entry) => entry.query),
      concurrency: 2,
      maxAttemptsForStage: queries.length,
      stopOnViableMatch: false,
      reasonForInclusion: 'step_aware_internal',
      runIf: 'always',
      preferredStep: first?.step || null,
      slot: first?.slot || null,
    });
    if (stage) stages.push(stage);
  }
  const firstQuery = levels.flatMap((level) => (Array.isArray(level?.queries) ? level.queries : [])).find(Boolean) || null;
  const shouldUseExternalSeedFallbackForStepAware = String(firstQuery?.step || '').trim().toLowerCase() === 'sunscreen';
  const externalFallbackQueries = uniqueCaseInsensitiveStrings(
    levels.flatMap((level) => (
      Array.isArray(level?.queries)
        ? level.queries.map((entry) => String(entry?.query || '').trim()).filter(Boolean)
        : []
    )),
    2,
  );
  if (shouldUseExternalSeedFallbackForStepAware && externalFallbackQueries.length > 0) {
    const externalStage = buildStage({
      stageId: 'step_aware_stage_z_external_seed_fallback',
      roleId: null,
      roleRank: stages.length + 1,
      sourceScope: 'external_seed',
      queries: externalFallbackQueries,
      concurrency: 1,
      maxAttemptsForStage: Math.min(2, externalFallbackQueries.length),
      stopOnViableMatch: true,
      reasonForInclusion: 'step_aware_external_seed_fallback',
      runIf: 'if_no_primary_viable_or_transient_only',
      preferredStep: firstQuery?.step || null,
      slot: firstQuery?.slot || null,
    });
    if (externalStage) stages.push(externalStage);
  }
  const entries = flattenPlanEntries(stages);
  return {
    version: RECO_RECALL_PLAN_VERSION,
    mode: 'step_aware',
    budget: {
      max_query_entries: entries.length,
      max_upstream_attempt_count: entries.length,
    },
    stages,
    entries,
  };
}

function buildProductGroundingExactRecallPlan({ queries } = {}) {
  const normalizedQueries = uniqueCaseInsensitiveStrings(queries, 3);
  const stages = [
    buildStage({
      stageId: 'product_grounding_stage_a_internal',
      sourceScope: 'internal',
      queries: normalizedQueries,
      concurrency: 2,
      maxAttemptsForStage: Math.min(3, normalizedQueries.length),
      stopOnViableMatch: true,
      reasonForInclusion: 'product_exact_internal',
      runIf: 'always',
    }),
    buildStage({
      stageId: 'product_grounding_stage_b_external_seed',
      sourceScope: 'external_seed',
      queries: normalizedQueries,
      concurrency: 1,
      maxAttemptsForStage: Math.min(3, normalizedQueries.length),
      stopOnViableMatch: true,
      reasonForInclusion: 'product_exact_external_seed',
      runIf: 'if_no_primary_viable_or_transient_only',
    }),
  ].filter(Boolean);

  return {
    version: RECO_RECALL_PLAN_VERSION,
    mode: 'product_grounding_exact',
    budget: {
      max_query_entries: 6,
      max_upstream_attempt_count: 6,
    },
    stages,
    entries: flattenPlanEntries(stages),
  };
}

function buildRecoRecallPlan({ mode, targetContext = null, queryLevels = null, queries = null } = {}) {
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (normalizedMode === 'framework_generic') {
    return buildFrameworkGenericRecallPlan({ targetContext });
  }
  if (normalizedMode === 'step_aware') {
    return buildStepAwareRecallPlan({ queryLevels });
  }
  if (normalizedMode === 'product_grounding_exact') {
    return buildProductGroundingExactRecallPlan({ queries });
  }
  return {
    version: RECO_RECALL_PLAN_VERSION,
    mode: normalizedMode || 'unknown',
    budget: {
      max_query_entries: 0,
      max_upstream_attempt_count: 0,
    },
    stages: [],
    entries: [],
  };
}

function buildRecoSearchSemanticContract({ mode, targetContext = null, queryLevels = null, queries = null } = {}) {
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (normalizedMode === 'framework_generic') {
    return buildFrameworkSemanticContract({ targetContext });
  }
  if (normalizedMode === 'step_aware') {
    return buildStepAwareSemanticContract({ targetContext, queryLevels });
  }
  if (normalizedMode === 'product_grounding_exact') {
    return buildExactLookupSemanticContract({ queries });
  }
  return null;
}

module.exports = {
  BEAUTY_SEMANTIC_CONTRACT_VERSION,
  RECO_RECALL_PLAN_VERSION,
  buildRecoRecallPlan,
  buildRecoSearchSemanticContract,
};
