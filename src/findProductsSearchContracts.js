const {
  resolveSourceProfile,
  normalizeSourceToken,
} = require('./api/gateway/sourceProfiles');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseBooleanLike(value) {
  const raw = firstValue(value);
  if (raw == null) return undefined;
  if (typeof raw === 'boolean') return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function normalizeTargetStepFamily(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'serum') return 'treatment';
  return normalized;
}

function normalizeUiSurface(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function normalizeDecisionMode(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function normalizeQueryClass(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function normalizeStructuredSemanticContract(value) {
  if (isPlainObject(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function buildSupplementLanes({
  requestClass = '',
  allowExternalSeed = false,
  uiSurface = null,
  semanticContract = null,
} = {}) {
  const lanes = [];
  if (requestClass === 'resolver_lookup') lanes.push('resolver');
  if (allowExternalSeed) {
    lanes.push('external_seed_supplement', 'coverage_supplement');
  }
  if (
    requestClass === 'support_recall' ||
    String(semanticContract?.planner_mode || '').trim().toLowerCase() === 'framework_generic'
  ) {
    lanes.push('support_role_recall');
  }
  if (
    requestClass === 'resolver_lookup' ||
    uiSurface === 'ingredient_plan_guidance_only'
  ) {
    lanes.push('exact_title_rescue');
  }
  return Array.from(new Set(lanes));
}

function buildFindProductsSearchRequestContract({
  surface = 'direct',
  operation = 'find_products_multi',
  search = null,
  metadata = null,
  queryClass = '',
  strictConstraintQuery = false,
  beautyMainlineBypass = null,
} = {}) {
  const normalizedSearch = isPlainObject(search) ? search : {};
  const normalizedMetadata = isPlainObject(metadata) ? metadata : {};
  const normalizedSource = normalizeSourceToken(
    firstNonEmptyString(
      normalizedMetadata.source,
      normalizedSearch.source,
    ),
  );
  const sourceProfile = resolveSourceProfile(normalizedSource);
  const semanticContract =
    normalizeStructuredSemanticContract(
      normalizedSearch.semantic_contract ||
        normalizedSearch.semanticContract ||
        normalizedMetadata.semantic_contract ||
        normalizedMetadata.semanticContract,
    ) ||
    (isPlainObject(beautyMainlineBypass?.semanticContract)
      ? beautyMainlineBypass.semanticContract
      : null);
  const uiSurface = normalizeUiSurface(
    firstNonEmptyString(
      normalizedMetadata.ui_surface,
      normalizedMetadata.uiSurface,
      normalizedSearch.ui_surface,
      normalizedSearch.uiSurface,
    ),
  );
  const decisionMode = normalizeDecisionMode(
    firstNonEmptyString(
      normalizedMetadata.decision_mode,
      normalizedMetadata.decisionMode,
      normalizedSearch.decision_mode,
      normalizedSearch.decisionMode,
    ),
  );
  const targetStepFamily = normalizeTargetStepFamily(
    firstNonEmptyString(
      semanticContract?.target_step_family,
      semanticContract?.targetStepFamily,
      normalizedSearch.target_step_family,
      normalizedSearch.targetStepFamily,
      normalizedMetadata.query_target_step_family,
      normalizedMetadata.queryTargetStepFamily,
    ),
  );
  const semanticFamily = String(
    firstNonEmptyString(
      semanticContract?.semantic_family,
      semanticContract?.semanticFamily,
      normalizedSearch.semantic_family,
      normalizedSearch.semanticFamily,
      normalizedMetadata.semantic_family,
      normalizedMetadata.semanticFamily,
    ),
  )
    .trim()
    .toLowerCase() || null;
  const normalizedQueryClass = normalizeQueryClass(
    queryClass ||
      semanticContract?.query_class ||
      semanticContract?.queryClass,
  );
  const allowExternalSeed =
    parseBooleanLike(
      normalizedSearch.allow_external_seed ?? normalizedSearch.allowExternalSeed,
    ) === true;
  const productOnly =
    parseBooleanLike(normalizedSearch.product_only ?? normalizedSearch.productOnly) === true;
  const supportRecallRequest =
    String(semanticContract?.request_class || '').trim().toLowerCase() === 'support_role' ||
    uiSurface === 'ingredient_plan_guidance_only';
  const requestClass = strictConstraintQuery
    ? 'beauty_discovery'
    : supportRecallRequest
      ? 'support_recall'
      : ['lookup', 'attribute', 'category'].includes(normalizedQueryClass)
        ? 'resolver_lookup'
        : 'beauty_discovery';
  const primaryLane = strictConstraintQuery
    ? 'shop_invoke_strict'
    : requestClass === 'resolver_lookup' &&
      String(semanticContract?.resolver_only || '').trim().toLowerCase() === 'true'
      ? 'resolver_only'
      : 'beauty_discovery_mainline';
  const primaryRetrievalContract = strictConstraintQuery
    ? 'shop_invoke_strict'
    : primaryLane === 'resolver_only'
      ? 'resolver_only'
      : 'agent_v1_search_beauty_mainline';

  return {
    contract_version: 'search_contract_v1',
    surface: String(surface || '').trim() || null,
    operation: String(operation || '').trim() || null,
    source: normalizedSource || null,
    source_profile: sourceProfile || null,
    ownership_domain: strictConstraintQuery ? 'strict_shop' : 'beauty_mainline',
    request_class: requestClass,
    semantic_contract: semanticContract,
    policy: {
      allow_external_seed: allowExternalSeed,
      ui_surface: uiSurface,
      decision_mode: decisionMode,
      product_only: productOnly,
      timeout_budget: {
        query_class: normalizedQueryClass,
        target_step_family: targetStepFamily,
      },
    },
    target_step_family: targetStepFamily,
    semantic_family: semanticFamily,
    primary_lane: primaryLane,
    primary_retrieval_contract: primaryRetrievalContract,
    supplement_lanes: buildSupplementLanes({
      requestClass,
      allowExternalSeed,
      uiSurface,
      semanticContract,
    }),
  };
}

function resolveFindProductsSearchExecutionPlan({
  requestContract = null,
  pivotaApiBase = '',
  searchInvokeBase = '',
} = {}) {
  const contract = isPlainObject(requestContract) ? requestContract : {};
  const primaryLane = String(contract.primary_lane || '').trim();
  const primaryRetrievalContract = String(
    contract.primary_retrieval_contract || '',
  ).trim();
  if (primaryLane === 'shop_invoke_strict') {
    return {
      primary_lane: 'shop_invoke_strict',
      primary_retrieval_contract: 'shop_invoke_strict',
      upstream_method: 'POST',
      upstream_url: `${String(pivotaApiBase || '').replace(/\/$/, '')}/agent/shop/v1/invoke`,
      transport_owner: 'pivota_shop_invoke',
      owner_switch_count: 0,
      policy_only_source: true,
    };
  }
  if (primaryLane === 'resolver_only') {
    return {
      primary_lane: 'resolver_only',
      primary_retrieval_contract: 'resolver_only',
      upstream_method: null,
      upstream_url: null,
      transport_owner: 'resolver_only',
      owner_switch_count: 0,
      policy_only_source: true,
    };
  }
  const normalizedPivotaApiBase = String(pivotaApiBase || '').replace(/\/$/, '');
  const normalizedSearchInvokeBase = String(searchInvokeBase || '').replace(/\/$/, '');
  const beautyDiscoverySearchBase = normalizedSearchInvokeBase || normalizedPivotaApiBase;
  return {
    primary_lane: 'beauty_discovery_mainline',
    primary_retrieval_contract:
      primaryRetrievalContract || 'agent_v1_search_beauty_mainline',
    upstream_method: 'GET',
    upstream_url: `${beautyDiscoverySearchBase}/agent/v1/products/search`,
    fallback_upstream_url:
      normalizedPivotaApiBase &&
      normalizedSearchInvokeBase &&
      normalizedPivotaApiBase !== normalizedSearchInvokeBase
      ? `${normalizedPivotaApiBase}/agent/v1/products/search`
      : null,
    transport_owner: 'pivota_agent_v1_search',
    owner_switch_count: 0,
    policy_only_source: true,
  };
}

function buildFindProductsSearchExecutionTrace({
  requestContract = null,
  executionPlan = null,
  primarySearchInitialTimeoutMs = null,
  primarySearchFinalTimeoutMs = null,
  primarySearchRetryCount = 0,
  primarySearchRetryReasons = [],
  primaryFailureStage = null,
  supplementsAttempted = [],
} = {}) {
  const contract = isPlainObject(requestContract) ? requestContract : {};
  const plan = isPlainObject(executionPlan) ? executionPlan : {};
  const retryReasons = Array.isArray(primarySearchRetryReasons)
    ? primarySearchRetryReasons
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    : [];
  return {
    primary_lane: String(plan.primary_lane || contract.primary_lane || '').trim() || null,
    primary_retrieval_contract:
      String(
        plan.primary_retrieval_contract || contract.primary_retrieval_contract || '',
      ).trim() || null,
    primary_timeout_initial_ms:
      Number.isFinite(Number(primarySearchInitialTimeoutMs)) &&
      Number(primarySearchInitialTimeoutMs) >= 0
        ? Number(primarySearchInitialTimeoutMs)
        : null,
    primary_timeout_final_ms:
      Number.isFinite(Number(primarySearchFinalTimeoutMs)) &&
      Number(primarySearchFinalTimeoutMs) >= 0
        ? Number(primarySearchFinalTimeoutMs)
        : null,
    primary_retry_count: Math.max(
      0,
      Number.isFinite(Number(primarySearchRetryCount))
        ? Number(primarySearchRetryCount)
        : 0,
    ),
    primary_retry_reasons: retryReasons,
    primary_failure_stage: String(primaryFailureStage || '').trim() || null,
    supplements_attempted: Array.isArray(supplementsAttempted)
      ? supplementsAttempted
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      : [],
    owner_switch_count: Math.max(
      0,
      Number.isFinite(Number(plan.owner_switch_count))
        ? Number(plan.owner_switch_count)
        : 0,
    ),
  };
}

module.exports = {
  normalizeStructuredSemanticContract,
  buildFindProductsSearchRequestContract,
  resolveFindProductsSearchExecutionPlan,
  buildFindProductsSearchExecutionTrace,
};
