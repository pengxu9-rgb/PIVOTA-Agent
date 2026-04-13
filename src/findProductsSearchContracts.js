const {
  resolveSourceProfile,
  normalizeSourceToken,
} = require('./api/gateway/sourceProfiles');
const {
  INTERNAL_PRODUCTS_SEARCH_PATH,
} = require('./findProductsInternalSearchPrimitive');
const {
  resolveBeautyCategoryBrowseFastpath,
} = require('./findProductsBeautyCategoryBrowseFastpath');

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

function normalizeStringArray(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return Array.from(
    new Set(
      list
        .map((entry) => String(entry || '').trim())
        .filter(Boolean),
    ),
  );
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

function normalizeFindProductsSearchRequestContract(
  value,
  { surface = null, operation = null } = {},
) {
  const contract = isPlainObject(value) ? value : null;
  if (!contract) return null;
  const contractVersion = String(contract.contract_version || '').trim();
  if (contractVersion && contractVersion !== 'search_contract_v1') return null;
  const primaryLane = String(contract.primary_lane || '').trim();
  const primaryRetrievalContract = String(contract.primary_retrieval_contract || '').trim();
  if (!primaryLane || !primaryRetrievalContract) return null;
  if (surface) {
    const contractSurface = String(contract.surface || '').trim();
    if (contractSurface && contractSurface !== String(surface || '').trim()) return null;
  }
  if (operation) {
    const contractOperation = String(contract.operation || '').trim();
    if (contractOperation && contractOperation !== String(operation || '').trim()) return null;
  }
  return contract;
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
  const localMainlineChild =
    parseBooleanLike(
      normalizedSearch.local_mainline_child ??
        normalizedSearch.localMainlineChild ??
        normalizedMetadata.local_mainline_child ??
        normalizedMetadata.localMainlineChild,
    ) === true;
  const semanticContract =
    localMainlineChild
      ? null
      : normalizeStructuredSemanticContract(
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
  const rawQueryText = firstNonEmptyString(normalizedSearch.query, normalizedSearch.q);
  const allowExternalSeed =
    parseBooleanLike(
      normalizedSearch.allow_external_seed ?? normalizedSearch.allowExternalSeed,
    ) === true;
  const productOnly =
    parseBooleanLike(normalizedSearch.product_only ?? normalizedSearch.productOnly) === true;
  const supportRecallRequest =
    String(semanticContract?.request_class || '').trim().toLowerCase() === 'support_role' ||
    uiSurface === 'ingredient_plan_guidance_only';
  const hasExplicitScopeConstraint =
    Boolean(
      firstNonEmptyString(
        normalizedSearch.merchant_id,
        normalizedSearch.merchantId,
        normalizedSearch.category,
      ),
    ) ||
    firstValue(normalizedSearch.price_min) != null ||
    firstValue(normalizedSearch.min_price) != null ||
    firstValue(normalizedSearch.price_max) != null ||
    firstValue(normalizedSearch.max_price) != null ||
    normalizeStringArray(normalizedSearch.merchant_ids || normalizedSearch.merchantIds).length > 0;
  const requestedCatalogSurface = firstNonEmptyString(
    normalizedSearch.catalog_surface,
    normalizedSearch.catalogSurface,
    normalizedMetadata.catalog_surface,
    normalizedMetadata.catalogSurface,
  ).toLowerCase();
  const beautyCategoryBrowseFastpath =
    !localMainlineChild &&
    !strictConstraintQuery &&
    !supportRecallRequest &&
    !semanticContract &&
    !hasExplicitScopeConstraint &&
    (!requestedCatalogSurface || requestedCatalogSurface === 'beauty')
      ? resolveBeautyCategoryBrowseFastpath(rawQueryText, {
          queryClass: normalizedQueryClass,
        })
      : null;
  const effectiveSemanticContract = beautyCategoryBrowseFastpath ? null : semanticContract;
  const requestClass = localMainlineChild
    ? 'catalog_child_recall'
    : beautyCategoryBrowseFastpath
      ? 'beauty_discovery'
      : strictConstraintQuery
        ? 'beauty_discovery'
        : supportRecallRequest
          ? 'support_recall'
          : ['lookup', 'attribute', 'category'].includes(normalizedQueryClass)
            ? 'resolver_lookup'
            : 'beauty_discovery';
  const primaryLane = localMainlineChild
    ? 'catalog_child_recall'
    : beautyCategoryBrowseFastpath
      ? 'beauty_discovery_mainline'
      : strictConstraintQuery
        ? 'shop_invoke_strict'
        : requestClass === 'resolver_lookup' &&
          String(semanticContract?.resolver_only || '').trim().toLowerCase() === 'true'
          ? 'resolver_only'
          : 'beauty_discovery_mainline';
  const primaryRetrievalContract = localMainlineChild
    ? 'agent_v2_catalog_child_recall'
    : beautyCategoryBrowseFastpath
      ? 'agent_v1_search_beauty_mainline'
      : strictConstraintQuery
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
    semantic_contract: effectiveSemanticContract,
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

function selectFindProductsSearchRequestContract({
  ingressContract = null,
  surface = 'direct',
  operation = 'find_products_multi',
  search = null,
  metadata = null,
  queryClass = '',
  strictConstraintQuery = false,
  beautyMainlineBypass = null,
} = {}) {
  return (
    normalizeFindProductsSearchRequestContract(ingressContract, {
      surface,
      operation,
    }) ||
    buildFindProductsSearchRequestContract({
      surface,
      operation,
      search,
      metadata,
      queryClass,
      strictConstraintQuery,
      beautyMainlineBypass,
    })
  );
}

function resolveFindProductsSearchSurface({
  metadataSource = '',
  routeClientChannel = '',
} = {}) {
  const normalizedClientChannel = String(routeClientChannel || '').trim().toLowerCase();
  if (normalizedClientChannel === 'shop') return 'direct';
  return normalizeSourceToken(metadataSource) === 'aurora-bff' ? 'chat' : 'gateway';
}

function isAuthoritativeDirectBeautySearchIngress({
  requestContract = null,
  routeClientChannel = '',
} = {}) {
  if (String(routeClientChannel || '').trim().toLowerCase() !== 'shop') return false;
  const contract = normalizeFindProductsSearchRequestContract(requestContract, {
    surface: 'direct',
    operation: 'find_products_multi',
  });
  return String(contract?.primary_lane || '').trim() === 'beauty_discovery_mainline';
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
  if (primaryLane === 'catalog_child_recall') {
    const catalogChildSearchBase =
      String(searchInvokeBase || '').replace(/\/$/, '') ||
      String(pivotaApiBase || '').replace(/\/$/, '');
    return {
      primary_lane: 'catalog_child_recall',
      primary_retrieval_contract: 'agent_v2_catalog_child_recall',
      upstream_method: 'POST',
      upstream_url: catalogChildSearchBase
        ? `${catalogChildSearchBase}${INTERNAL_PRODUCTS_SEARCH_PATH}`
        : null,
      transport_owner: 'internal_products_search_primitive',
      endpoint_kind: 'internal_primitive',
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
    upstream_method: 'POST',
    upstream_url: beautyDiscoverySearchBase
      ? `${beautyDiscoverySearchBase}${INTERNAL_PRODUCTS_SEARCH_PATH}`
      : null,
    fallback_upstream_url: null,
    transport_owner: 'internal_products_search_primitive',
    endpoint_kind: 'internal_primitive',
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
  transportHops = [],
  primaryTransportOwner = null,
  primaryEndpointKind = null,
  attemptedInternalBaseUrls = [],
  attemptedInternalPaths = [],
  nestedOrchestratorHops = null,
} = {}) {
  const contract = isPlainObject(requestContract) ? requestContract : {};
  const plan = isPlainObject(executionPlan) ? executionPlan : {};
  const retryReasons = Array.isArray(primarySearchRetryReasons)
    ? primarySearchRetryReasons
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    : [];
  const normalizedTransportHops = Array.isArray(transportHops)
    ? transportHops.filter((value) => isPlainObject(value))
    : [];
  const normalizedAttemptedInternalBaseUrls = Array.isArray(attemptedInternalBaseUrls)
    ? Array.from(
        new Set(
          attemptedInternalBaseUrls
            .map((value) => String(value || '').trim())
            .filter(Boolean),
        ),
      )
    : [];
  const normalizedAttemptedInternalPaths = Array.isArray(attemptedInternalPaths)
    ? Array.from(
        new Set(
          attemptedInternalPaths
            .map((value) => String(value || '').trim())
            .filter(Boolean),
        ),
      )
    : [];
  const derivedNestedOrchestratorHops = normalizedTransportHops.filter(
    (hop) => String(hop?.endpoint_kind || '').trim().toLowerCase() === 'public_orchestrator',
  ).length;
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
    primary_transport_owner:
      String(primaryTransportOwner || plan.transport_owner || '').trim() || null,
    primary_endpoint_kind:
      String(primaryEndpointKind || plan.endpoint_kind || '').trim() || null,
    transport_hops: normalizedTransportHops,
    transport_hop_count: normalizedTransportHops.length,
    nested_orchestrator_hops:
      Number.isFinite(Number(nestedOrchestratorHops)) &&
      Number(nestedOrchestratorHops) >= 0
        ? Number(nestedOrchestratorHops)
        : derivedNestedOrchestratorHops,
    attempted_internal_base_urls: normalizedAttemptedInternalBaseUrls,
    attempted_internal_paths: normalizedAttemptedInternalPaths,
  };
}

module.exports = {
  isAuthoritativeDirectBeautySearchIngress,
  normalizeFindProductsSearchRequestContract,
  normalizeStructuredSemanticContract,
  buildFindProductsSearchRequestContract,
  resolveFindProductsSearchSurface,
  selectFindProductsSearchRequestContract,
  resolveFindProductsSearchExecutionPlan,
  buildFindProductsSearchExecutionTrace,
};
