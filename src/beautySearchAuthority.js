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

module.exports = {
  applyBeautySearchAuthority,
  resolveInvokeSearchContractBridgeMeta,
};
