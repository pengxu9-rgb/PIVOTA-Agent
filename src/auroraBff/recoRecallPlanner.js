const RECO_RECALL_PLAN_VERSION = 'aurora_reco_recall_plan_v1';
const BEAUTY_SEMANTIC_CONTRACT_VERSION = 'beauty_semantic_contract_v1';
const {
  buildBeautyDiscoveryQueryPackFromContract,
  BEAUTY_DISCOVERY_MAINLINE_OWNER,
} = require('../findProductsMulti/policy');

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

function normalizeFrameworkSemanticRole(role = null) {
  const roleObj = role && typeof role === 'object' && !Array.isArray(role) ? role : null;
  if (!roleObj) return null;
  const roleId = normalizeConcernQueryToken(roleObj.role_id);
  if (!roleId) return null;
  const preferredStep = normalizeSemanticStepFamily(roleObj.preferred_step || roleObj.step);
  return {
    role_id: roleId,
    rank: Number.isFinite(Number(roleObj.rank)) ? Number(roleObj.rank) : 99,
    preferred_step: preferredStep,
    label: normalizeConcernQueryToken(roleObj.label || roleObj.role_id),
    query_terms: uniqueCaseInsensitiveStrings(
      Array.isArray(roleObj.query_terms) ? roleObj.query_terms : [],
      6,
    ),
    fit_keywords: uniqueCaseInsensitiveStrings(
      Array.isArray(roleObj.fit_keywords) ? roleObj.fit_keywords : [],
      10,
    ),
    ingredient_hypotheses: uniqueCaseInsensitiveStrings(
      Array.isArray(roleObj.ingredient_hypotheses) ? roleObj.ingredient_hypotheses : [],
      8,
    ),
    product_type_hypotheses: buildSemanticStepFamilyList(
      [
        preferredStep,
        ...(Array.isArray(roleObj.product_type_hypotheses) ? roleObj.product_type_hypotheses : []),
      ],
      { includeSerumForTreatment: preferredStep === 'treatment' },
    ),
    alternate_steps: buildSemanticStepFamilyList(
      Array.isArray(roleObj.alternate_steps) ? roleObj.alternate_steps : [],
      { includeSerumForTreatment: preferredStep === 'treatment' },
    ),
    semantic_family: deriveSemanticFamilyFromRole(roleObj),
  };
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

function findAlignedFrameworkRoleForStep(targetContext = null, targetStepFamily = null) {
  const normalizedTargetStep = normalizeSemanticStepFamily(targetStepFamily);
  if (!normalizedTargetStep) return null;
  const roles = Array.isArray(targetContext?.framework_roles)
    ? targetContext.framework_roles.filter((role) => role && typeof role === 'object' && !Array.isArray(role))
    : [];
  return roles.find((role) =>
    normalizeSemanticStepFamily(role?.preferred_step || role?.step) === normalizedTargetStep
  ) || null;
}

function buildStepAwareIngredientHypotheses(targetContext = null, targetStepFamily = null, alignedRole = null) {
  const roleIngredients = uniqueCaseInsensitiveStrings(
    Array.isArray(alignedRole?.ingredient_hypotheses) ? alignedRole.ingredient_hypotheses : [],
    8,
  );
  if (roleIngredients.length > 0) return roleIngredients;

  const semanticIngredients = uniqueCaseInsensitiveStrings(
    Array.isArray(targetContext?.semantic_plan?.ingredient_hypotheses)
      ? targetContext.semantic_plan.ingredient_hypotheses
      : [],
    8,
  );
  if (normalizeSemanticStepFamily(targetStepFamily) !== 'sunscreen') return semanticIngredients;

  const sunscreenSpecific = semanticIngredients.filter((value) =>
    /\b(uv|spf|filter|zinc oxide|titanium dioxide|avobenzone|octocrylene|homosalate|uvasorb|tinosorb|bemotrizinol|bisoctrizole)\b/i.test(
      String(value || ''),
    )
  );
  return sunscreenSpecific.length > 0 ? sunscreenSpecific : ['UV filters'];
}

function buildFrameworkSemanticContract({ targetContext } = {}) {
  const roles = Array.isArray(targetContext?.framework_roles)
    ? [...targetContext.framework_roles]
        .filter((role) => role && typeof role === 'object' && !Array.isArray(role))
        .sort((left, right) => Number(left?.rank || 99) - Number(right?.rank || 99))
        .map((role) => normalizeFrameworkSemanticRole(role))
        .filter(Boolean)
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
    framework_roles: roles,
  };
}

function buildStepAwareSemanticContract({ targetContext, queryLevels } = {}) {
  const targetStepFamily = normalizeSemanticStepFamily(
    targetContext?.resolved_target_step ||
    queryLevels?.[0]?.queries?.[0]?.step,
  );
  if (!targetStepFamily) return null;
  const alignedRole = findAlignedFrameworkRoleForStep(targetContext, targetStepFamily);
  const primaryRoleId =
    normalizeConcernQueryToken(alignedRole?.role_id) ||
    (targetStepFamily === 'sunscreen' ? 'daily_sunscreen' : `${targetStepFamily}_primary`);
  return {
    version: BEAUTY_SEMANTIC_CONTRACT_VERSION,
    owner: 'aurora_reco_planner',
    planner_mode: 'step_aware',
    request_class: targetStepFamily === 'sunscreen' ? 'sunscreen' : 'routine_followup',
    target_step_family: targetStepFamily,
    primary_role_id: primaryRoleId,
    support_role_ids: [],
    semantic_family: normalizeConcernQueryToken(
      targetContext?.step_aware_intent?.semantic_family ||
      deriveSemanticFamilyFromRole(alignedRole) ||
      targetStepFamily,
    ).toLowerCase() || null,
    allowed_step_families: buildSemanticStepFamilyList([targetStepFamily], {
      includeSerumForTreatment: targetStepFamily === 'treatment',
    }),
    blocked_step_families: [],
    ingredient_hypotheses: buildStepAwareIngredientHypotheses(targetContext, targetStepFamily, alignedRole),
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

function inferBeautyMainlineSlot(targetStepFamily = null) {
  return normalizeSemanticStepFamily(targetStepFamily) === 'sunscreen' ? 'am' : 'other';
}

function deriveBeautyMainlineRawQuery({ mode, targetContext = null, queryLevels = null } = {}) {
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (normalizedMode === 'framework_generic') {
    return normalizeConcernQueryToken(targetContext?.framework_summary?.concern_text || '');
  }
  if (normalizedMode === 'step_aware') {
    const firstQuery = (Array.isArray(queryLevels) ? queryLevels : [])
      .flatMap((level) => (Array.isArray(level?.queries) ? level.queries : []))
      .find((entry) => String(entry?.query || '').trim());
    return normalizeConcernQueryToken(firstQuery?.query || '');
  }
  return '';
}

function buildBeautyMainlineRecallPlan({ mode, semanticContract = null, rawQuery = '' } = {}) {
  const contract = semanticContract && typeof semanticContract === 'object' && !Array.isArray(semanticContract)
    ? semanticContract
    : null;
  if (!contract || contract.request_class === 'exact_lookup') {
    return {
      version: RECO_RECALL_PLAN_VERSION,
      mode: String(mode || '').trim().toLowerCase() || 'unknown',
      budget: {
        max_query_entries: 0,
        max_upstream_attempt_count: 0,
      },
      stages: [],
      entries: [],
      semantic_owner: BEAUTY_DISCOVERY_MAINLINE_OWNER,
    };
  }
  const frameworkRoles = Array.isArray(contract.framework_roles)
    ? contract.framework_roles.filter((role) => role && typeof role === 'object' && !Array.isArray(role))
    : [];
  let stages = [];
  if (String(mode || '').trim().toLowerCase() === 'framework_generic' && frameworkRoles.length > 0) {
    const primaryRole = frameworkRoles[0] || null;
    const supportRoles = frameworkRoles.slice(1, 3);
    const buildRoleStageQueries = (
      role,
      {
        allowConcernFallback = false,
        preferProductLedInternal = false,
        allowDefaultTreatmentIngredientFallback = false,
        includeIngredientAlternates = false,
        maxQueriesOverride = null,
      } = {},
    ) => {
      const hasMaxQueriesOverride =
        maxQueriesOverride !== null &&
        maxQueriesOverride !== undefined &&
        Number.isFinite(Number(maxQueriesOverride)) &&
        Number(maxQueriesOverride) > 0;
      const maxQueries = hasMaxQueriesOverride
        ? Math.max(1, Math.trunc(Number(maxQueriesOverride)))
        : (allowConcernFallback ? 3 : 2);
      const queries = buildFrameworkRoleQueries(
        role,
        rawQuery,
        maxQueries,
        {
          allowConcernFallback,
          preferProductLedInternal,
          allowDefaultTreatmentIngredientFallback,
          includeIngredientAlternates,
        },
      );
      return queries.length > 0
        ? queries
        : buildBeautyDiscoveryQueryPackFromContract({
            rawQuery,
            semanticContract: contract,
          }).slice(0, allowConcernFallback ? 3 : 2);
    };
    const primaryInternalQueries = buildRoleStageQueries(primaryRole, {
      allowConcernFallback: true,
      preferProductLedInternal: true,
    });
    const primaryExternalQueries = buildRoleStageQueries(primaryRole, {
      allowConcernFallback: true,
      allowDefaultTreatmentIngredientFallback: true,
      includeIngredientAlternates: true,
      maxQueriesOverride: 4,
    });
    const primaryPreferredStep = normalizeSemanticStepFamily(primaryRole?.preferred_step || contract.target_step_family);
    stages = [
      buildStage({
        stageId: 'framework_stage_a_primary_internal',
        roleId: primaryRole?.role_id || contract.primary_role_id || null,
        roleRank: Number.isFinite(Number(primaryRole?.rank)) ? Number(primaryRole.rank) : 1,
        sourceScope: 'internal',
        queries: primaryInternalQueries,
        concurrency: 1,
        maxAttemptsForStage: Math.min(primaryInternalQueries.length || 1, 3),
        stopOnViableMatch: true,
        reasonForInclusion: 'framework_primary_internal',
        runIf: 'always',
        preferredStep: primaryPreferredStep,
        slot: inferBeautyMainlineSlot(primaryPreferredStep),
      }),
      buildStage({
        stageId: 'framework_stage_b_primary_external_seed',
        roleId: primaryRole?.role_id || contract.primary_role_id || null,
        roleRank: Number.isFinite(Number(primaryRole?.rank)) ? Number(primaryRole.rank) : 1,
        sourceScope: 'external_seed',
        queries: primaryExternalQueries,
        concurrency: 1,
        maxAttemptsForStage: Math.min(primaryExternalQueries.length || 1, 4),
        stopOnViableMatch: true,
        reasonForInclusion: 'framework_primary_external_seed',
        runIf: 'if_surface_count_below_target',
        preferredStep: primaryPreferredStep,
        slot: inferBeautyMainlineSlot(primaryPreferredStep),
      }),
      ...supportRoles.flatMap((role) => {
        const supportQueries = buildRoleStageQueries(role, { allowConcernFallback: false });
        const supportPreferredStep = normalizeSemanticStepFamily(role?.preferred_step);
        return [
          buildStage({
            stageId: buildFrameworkSupportStageId(role?.role_id, 'external_seed'),
            roleId: role?.role_id || null,
            roleRank: Number.isFinite(Number(role?.rank)) ? Number(role.rank) : null,
            sourceScope: 'external_seed',
            queries: supportQueries,
            concurrency: 1,
            maxAttemptsForStage: Math.min(supportQueries.length || 1, 2),
            stopOnViableMatch: true,
            reasonForInclusion: 'framework_support_external_seed',
            runIf: 'if_role_unfilled_after_primary',
            preferredStep: supportPreferredStep,
            slot: inferBeautyMainlineSlot(supportPreferredStep),
          }),
        ];
      }),
    ].filter(Boolean);
  } else {
    const queries = buildBeautyDiscoveryQueryPackFromContract({
      rawQuery,
      semanticContract: contract,
    });
    const preferredStep = normalizeSemanticStepFamily(contract.target_step_family);
    const slot = inferBeautyMainlineSlot(preferredStep);
    stages = queries
      .map((query, index) => buildStage({
        stageId: `beauty_mainline_query_${index + 1}`,
        roleId: index === 0 ? contract.primary_role_id || null : null,
        roleRank: index + 1,
        sourceScope: 'hybrid',
        queries: [query],
        concurrency: 1,
        maxAttemptsForStage: 1,
        stopOnViableMatch: true,
        reasonForInclusion: index === 0 ? 'beauty_mainline_primary' : 'beauty_mainline_rescue',
        runIf: index === 0 ? 'always' : 'if_no_primary_viable_or_transient_only',
        preferredStep,
        slot,
      }))
      .filter(Boolean);
  }
  const entries = flattenPlanEntries(stages);
  return {
    version: RECO_RECALL_PLAN_VERSION,
    mode: String(mode || '').trim().toLowerCase() || 'unknown',
    budget: {
      max_query_entries: entries.length,
      max_upstream_attempt_count: entries.length,
    },
    stages,
    entries,
    semantic_owner: BEAUTY_DISCOVERY_MAINLINE_OWNER,
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

function buildPrimaryTreatmentIngredientQueryCandidateScore(value, semanticFamily = '') {
  const normalized = normalizeConcernQueryToken(value).toLowerCase();
  if (!normalized) return 0;
  if (String(semanticFamily || '').trim().toLowerCase() === 'oil_control') {
    if (/\b(niacinamide|zinc|zinc pca)\b/.test(normalized)) return 4;
    if (/\b(salicylic|bha|acid|exfoliant)\b/.test(normalized)) return 3;
  }
  return scoreTreatmentIngredientHypothesis(normalized);
}

function buildPrimaryTreatmentIngredientQueries(role, {
  allowDefaultFamilyFallback = false,
  maxQueries = 2,
} = {}) {
  const roleObj = role && typeof role === 'object' && !Array.isArray(role) ? role : null;
  if (!roleObj) return [];
  const semanticFamily = deriveSemanticFamilyFromRole(roleObj);
  const explicitCandidates = uniqueCaseInsensitiveStrings(
    Array.isArray(roleObj.ingredient_hypotheses) ? roleObj.ingredient_hypotheses : [],
    8,
  )
    .map((value) => normalizeConcernQueryToken(value))
    .filter(Boolean);
  const fallbackCandidates =
    allowDefaultFamilyFallback === true && explicitCandidates.length === 0 && semanticFamily === 'oil_control'
      ? ['Niacinamide', 'Salicylic acid']
      : [];
  const candidates = uniqueCaseInsensitiveStrings(
    [...explicitCandidates, ...fallbackCandidates],
    8,
  ).sort(
    (left, right) =>
      buildPrimaryTreatmentIngredientQueryCandidateScore(right, semanticFamily)
      - buildPrimaryTreatmentIngredientQueryCandidateScore(left, semanticFamily),
  );
  const out = [];
  if (semanticFamily === 'oil_control') {
    for (const picked of candidates) {
      if (/\b(niacinamide|zinc|zinc pca)\b/i.test(picked)) out.push('niacinamide serum oily skin');
      else if (/\b(salicylic|bha|acid|exfoliant)\b/i.test(picked)) out.push('salicylic acid serum oily skin');
    }
    return uniqueCaseInsensitiveStrings(out, Math.max(1, Number(maxQueries) || 1));
  }
  for (const picked of candidates) {
    if (scoreTreatmentIngredientHypothesis(picked) < 3) continue;
    out.push(normalizeConcernQueryToken(`${picked} treatment`));
  }
  return uniqueCaseInsensitiveStrings(out, Math.max(1, Number(maxQueries) || 1));
}

function buildPrimaryTreatmentIngredientQuery(role, { allowDefaultFamilyFallback = false } = {}) {
  return buildPrimaryTreatmentIngredientQueries(role, {
    allowDefaultFamilyFallback,
    maxQueries: 1,
  })[0] || '';
}

function buildPrimaryTreatmentAnchorQuery(role) {
  const roleObj = role && typeof role === 'object' && !Array.isArray(role) ? role : null;
  if (!roleObj) return '';
  const roleLabelOrIdQuery = normalizeConcernQueryToken(
    String(roleObj.label || roleObj.role_id || '').replace(/[-_/]+/g, ' '),
  ).toLowerCase();
  if (!roleLabelOrIdQuery) return '';
  if (/\btreatment\b/.test(roleLabelOrIdQuery)) return roleLabelOrIdQuery;
  if (/\b(oil control|shine control|mattify|mattifying|balancing|acne|blemish|spot|dark spot|pigment|texture|pore)\b/.test(roleLabelOrIdQuery)) {
    return normalizeConcernQueryToken(`${roleLabelOrIdQuery} treatment`);
  }
  return roleLabelOrIdQuery;
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
    source_scope: (() => {
      const normalizedSourceScope = String(sourceScope || 'internal').trim().toLowerCase();
      if (normalizedSourceScope === 'external_seed') return 'external_seed';
      if (normalizedSourceScope === 'hybrid') return 'hybrid';
      return 'internal';
    })(),
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

function buildFrameworkRoleQueries(
  role,
  concernText,
  maxQueries,
  {
    allowConcernFallback = false,
    preferProductLedInternal = false,
    allowDefaultTreatmentIngredientFallback = false,
    includeIngredientAlternates = false,
  } = {},
) {
  const roleObj = role && typeof role === 'object' && !Array.isArray(role) ? role : null;
  if (!roleObj) return [];
  const preferredStep = String(roleObj.preferred_step || '').trim();
  const roleQueries = Array.isArray(roleObj.query_terms) ? roleObj.query_terms : [];
  const out = [];
  const isTreatmentPrimary =
    allowConcernFallback && String(preferredStep).trim().toLowerCase() === 'treatment';
  const anchorQuery = isTreatmentPrimary ? buildPrimaryTreatmentAnchorQuery(roleObj) : '';
  const ingredientLedQueries = isTreatmentPrimary
    ? buildPrimaryTreatmentIngredientQueries(roleObj, {
        allowDefaultFamilyFallback: allowDefaultTreatmentIngredientFallback,
        maxQueries: includeIngredientAlternates ? 3 : 1,
      })
    : [];
  const ingredientLedQuery = ingredientLedQueries[0] || '';
  const semanticQueries = isTreatmentPrimary ? buildPrimaryTreatmentSemanticQueries(roleObj) : [];
  if (isTreatmentPrimary) {
    if (preferProductLedInternal) {
      if (ingredientLedQuery) out.push(ingredientLedQuery);
      if (roleQueries.length > 0) out.push(roleQueries[0]);
      out.push(...semanticQueries);
      out.push(...roleQueries.slice(1));
      if (anchorQuery) out.push(anchorQuery);
    } else {
      if (anchorQuery) out.push(anchorQuery);
      if (includeIngredientAlternates) out.push(...ingredientLedQueries);
      else if (ingredientLedQuery) out.push(ingredientLedQuery);
      if (roleQueries.length > 0) out.push(roleQueries[0]);
      out.push(...semanticQueries);
      out.push(...roleQueries.slice(1));
      if (roleQueries.length <= 1 && anchorQuery) out.push(anchorQuery);
    }
  } else {
    if (roleQueries.length > 0) out.push(roleQueries[0]);
    out.push(...roleQueries.slice(1));
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
  const semanticContract = buildFrameworkSemanticContract({ targetContext });
  return buildBeautyMainlineRecallPlan({
    mode: 'framework_generic',
    semanticContract,
    rawQuery: deriveBeautyMainlineRawQuery({
      mode: 'framework_generic',
      targetContext,
    }),
  });
}

function buildStepAwareRecallPlan({ targetContext = null, queryLevels } = {}) {
  const semanticContract = buildStepAwareSemanticContract({ targetContext, queryLevels });
  return buildBeautyMainlineRecallPlan({
    mode: 'step_aware',
    semanticContract,
    rawQuery: deriveBeautyMainlineRawQuery({
      mode: 'step_aware',
      targetContext,
      queryLevels,
    }),
  });
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
    return buildStepAwareRecallPlan({ targetContext, queryLevels });
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
