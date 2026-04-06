const {
  buildSearchContractBridgeMeta,
} = require('./beautySearchContractAuthority');
const {
  buildBeautySearchSourceBreakdown,
} = require('./beautySearchSourceAuthority');
const { applyBeautySearchContractAuthority } = require('./beautySearchContractAuthority');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLowConfidenceReasons(existingMeta = null, searchDecision = null) {
  const existingMetaForGates = isPlainObject(existingMeta) ? existingMeta : {};
  const existingLowConfidenceReasons = Array.isArray(existingMetaForGates.low_confidence_reasons)
    ? existingMetaForGates.low_confidence_reasons
    : Array.isArray(searchDecision?.low_confidence_reasons)
      ? searchDecision.low_confidence_reasons
      : [];
  return Array.from(
    new Set(
      existingLowConfidenceReasons
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
}

function stripFilteredToEmptyReasonCodes(enriched = null, finalSelection = null) {
  if (
    !finalSelection ||
    Number(finalSelection.selected_products_count || 0) <= 0 ||
    !isPlainObject(enriched)
  ) {
    return enriched;
  }

  const nextEnriched = { ...enriched };
  if (Array.isArray(nextEnriched.reason_codes)) {
    nextEnriched.reason_codes = nextEnriched.reason_codes.filter(
      (code) => String(code || '').trim().toUpperCase() !== 'FILTERED_TO_EMPTY',
    );
  }
  if (
    isPlainObject(nextEnriched.metadata) &&
    Array.isArray(nextEnriched.metadata.reason_codes)
  ) {
    nextEnriched.metadata = {
      ...nextEnriched.metadata,
      reason_codes: nextEnriched.metadata.reason_codes.filter(
        (code) => String(code || '').trim().toUpperCase() !== 'FILTERED_TO_EMPTY',
      ),
    };
  }
  return nextEnriched;
}

function applyBeautySearchAuthority({
  enriched,
  existingMeta = null,
  operation = '',
  strictBeautyDirectSearch = false,
  semanticOwnerControlled = false,
  beautyDecisionOwner = '',
  beautySemanticOwner = '',
  products = [],
  finalDecision = '',
  hasClarification = false,
  querySource = '',
  searchStageLedger = null,
  defaultSelectionOwner = 'shopping_agent_beauty_mainline',
  sourceObservability = null,
  semanticOwnerCacheSourceIsolated = false,
  semanticOwnerLastResortCacheApplied = false,
  searchDecision = null,
} = {}) {
  const mergedSourceBreakdown = buildBeautySearchSourceBreakdown({
    existingSourceBreakdown:
      isPlainObject(existingMeta?.source_breakdown) ? existingMeta.source_breakdown : {},
    sourceObservability,
    semanticOwnerCacheSourceIsolated,
    semanticOwnerLastResortCacheApplied,
  });
  const normalizedLowConfidenceReasons = normalizeLowConfidenceReasons(existingMeta, searchDecision);
  const lowConfidenceFlag =
    Boolean(existingMeta?.low_confidence) ||
    Boolean(searchDecision?.low_confidence) ||
    normalizedLowConfidenceReasons.length > 0;

  const beautyContractAuthority = applyBeautySearchContractAuthority({
    enriched,
    existingMeta,
    operation,
    strictBeautyDirectSearch,
    semanticOwnerControlled,
    beautyDecisionOwner,
    beautySemanticOwner,
    products,
    finalDecision,
    hasClarification,
    lowConfidenceFlag,
    mergedSourceBreakdown,
    querySource,
    searchStageLedger,
    defaultSelectionOwner,
  });

  const finalSelection = beautyContractAuthority.finalSelection;
  const nextEnriched = stripFilteredToEmptyReasonCodes(
    beautyContractAuthority.enriched,
    finalSelection,
  );

  return {
    enriched: nextEnriched,
    existingMeta:
      isPlainObject(nextEnriched?.metadata) ? nextEnriched.metadata : existingMeta,
    finalSelection,
    mergedSourceBreakdown,
    lowConfidenceFlag,
    normalizedLowConfidenceReasons,
  };
}

function resolveInvokeSearchContractBridgeMeta({
  operation = '',
  strictCommerceFindProductsMulti = false,
  strictBeautyDirectSearch = false,
  semanticOwnerControlled = false,
  explicitResolvedContract = '',
} = {}) {
  const normalizedExplicit = String(explicitResolvedContract || '').trim();
  const fallbackResolvedContract = normalizedExplicit ||
    (
      strictCommerceFindProductsMulti && !strictBeautyDirectSearch && !semanticOwnerControlled
        ? 'shop_invoke_strict'
        : (strictBeautyDirectSearch || semanticOwnerControlled)
          ? 'agent_v1_search_beauty_mainline'
          : ''
    );
  return buildSearchContractBridgeMeta({
    operation,
    strictCommerceFindProductsMulti,
    strictBeautyDirectSearch,
    semanticOwnerControlled,
    explicitResolvedContract: fallbackResolvedContract,
  });
}

function applyBeautySearchMetadataAuthority({
  enriched,
  semanticOwnerDecision = null,
  defaultSelectionOwner = 'shopping_agent_beauty_mainline',
  fpmGateTrace = [],
  fpmSkippedGatesDueToBudget = [],
  fpmLatencyGuardApplied = false,
  lowConfidenceFlag = false,
  normalizedLowConfidenceReasons = [],
  semanticContractMeta = null,
  semanticRewriteResultMeta = null,
  semanticOwnerQueryAttempts = [],
  semanticOwnerExternalRescueQueriesAttempted = [],
  semanticOwnerCacheSourceIsolated = false,
  semanticOwnerCacheSourceIsolationReason = null,
  semanticOwnerLastResortCacheApplied = false,
  semanticOwnerLastResortCacheQuery = null,
  searchStageLedger = null,
  findProductsExpansionMeta = null,
  primarySearchTimeoutMs = null,
  gatewayTotalBudgetMs = null,
  blockingGateInfo = null,
  querySource = '',
} = {}) {
  if (!isPlainObject(enriched)) return enriched;

  const enrichedMetaForGates =
    isPlainObject(enriched.metadata) ? enriched.metadata : {};
  const effectiveSemanticOwner =
    semanticOwnerDecision ||
    String(enrichedMetaForGates.semantic_owner || '').trim() ||
    (
      String(enrichedMetaForGates.decision_owner || '').trim() === defaultSelectionOwner
        ? defaultSelectionOwner
        : null
    );
  const existingGateTrace = Array.isArray(enrichedMetaForGates.gate_trace)
    ? enrichedMetaForGates.gate_trace
    : [];
  const combinedGateTrace = existingGateTrace.concat(fpmGateTrace);
  const dedupSkippedGates = Array.from(
    new Set(
      fpmSkippedGatesDueToBudget
        .map((gateId) => String(gateId || '').trim())
        .filter(Boolean),
    ),
  );

  return {
    ...enriched,
    metadata: {
      ...enrichedMetaForGates,
      gate_trace: combinedGateTrace,
      gate_summary: {
        applied_count: combinedGateTrace.filter((item) => item && item.applied).length,
        blocked_count: combinedGateTrace.filter(
          (item) =>
            item &&
            (String(item.decision || '') === 'strict_empty' ||
              String(item.decision || '') === 'clarify_only_early'),
        ).length,
        total_cost_ms_estimate: combinedGateTrace.reduce(
          (sum, item) => sum + Math.max(0, Number(item?.cost_ms_estimate || 0) || 0),
          0,
        ),
      },
      latency_guard_applied: Boolean(fpmLatencyGuardApplied),
      skipped_gates_due_to_budget: dedupSkippedGates,
      low_confidence: lowConfidenceFlag,
      low_confidence_reasons: normalizedLowConfidenceReasons,
      semantic_contract: semanticContractMeta,
      semantic_rewrite_result: semanticRewriteResultMeta,
      semantic_owner_query_attempts: semanticOwnerQueryAttempts,
      ...(semanticOwnerExternalRescueQueriesAttempted.length > 0
        ? {
            semantic_owner_external_rescue_queries_attempted:
              semanticOwnerExternalRescueQueriesAttempted,
          }
        : {}),
      ...(semanticOwnerCacheSourceIsolated
        ? {
            semantic_owner_cache_source_isolated: true,
            semantic_owner_cache_source_isolation_reason:
              semanticOwnerCacheSourceIsolationReason || 'pure_cache_invalid_hit',
          }
        : {}),
      ...(semanticOwnerLastResortCacheApplied
        ? {
            semantic_owner_last_resort_cache_applied: true,
            semantic_owner_last_resort_cache_query:
              semanticOwnerLastResortCacheQuery || null,
          }
        : {}),
      semantic_owner: effectiveSemanticOwner,
      decision_owner:
        effectiveSemanticOwner ||
        enrichedMetaForGates.decision_owner ||
        querySource,
      search_stage_ledger: searchStageLedger,
      effective_timeout_ms: {
        semantic_rewrite_timeout_ms:
          Number.isFinite(Number(findProductsExpansionMeta?.semantic_rewrite_timeout_ms)) &&
          Number(findProductsExpansionMeta?.semantic_rewrite_timeout_ms) >= 0
            ? Number(findProductsExpansionMeta.semantic_rewrite_timeout_ms)
            : null,
        primary_search_timeout_ms: Number(primarySearchTimeoutMs || 0) || null,
        gateway_total_budget_ms: Number(gatewayTotalBudgetMs || 0) || null,
      },
      ...(blockingGateInfo ? blockingGateInfo : {}),
      ...(blockingGateInfo
        ? {
            search_decision: {
              ...(isPlainObject(enrichedMetaForGates.search_decision)
                ? enrichedMetaForGates.search_decision
                : {}),
              ...blockingGateInfo,
            },
          }
        : {}),
    },
  };
}

module.exports = {
  applyBeautySearchAuthority,
  applyBeautySearchMetadataAuthority,
  resolveInvokeSearchContractBridgeMeta,
};
