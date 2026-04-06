const { createHash } = require('crypto');

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

function extractSearchSelectionProductId(product) {
  return firstNonEmptyString(
    product && product.product_id,
    product && product.productId,
    product && product.id,
    product && product.offer_id,
    product && product.offerId,
    product && product.sku && (product.sku.product_id || product.sku.productId || product.sku.id),
  );
}

function extractSearchSelectionTitle(product) {
  return firstNonEmptyString(
    product && product.display_name,
    product && product.displayName,
    product && product.name,
    product && product.title,
    product && product.sku && (
      product.sku.display_name ||
      product.sku.displayName ||
      product.sku.name ||
      product.sku.title
    ),
  );
}

function normalizeSearchSelectionStrings(values, max = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const normalized = String(raw || '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= Math.max(1, Number(max) || 12)) break;
  }
  return out;
}

function buildSearchSelectionSignature({ selectedProductIds = [], selectedTitles = [] } = {}) {
  const ids = normalizeSearchSelectionStrings(selectedProductIds, 16);
  const titles = normalizeSearchSelectionStrings(selectedTitles, 16);
  const parts = ids.length ? ids : titles;
  if (!parts.length) return null;
  return `search_sel_${createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)}`;
}

function buildSearchFinalSelectionContract({
  products = [],
  decisionOwner = null,
  defaultSelectionOwner = 'shopping_agent_beauty_mainline',
  finalDecision = null,
  hasClarification = false,
  lowConfidence = false,
  sourceTierCounts = null,
  topCandidateProvenance = null,
  selectionReasonCodes = null,
} = {}) {
  const rows = Array.isArray(products)
    ? products.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
  const selectedProductIds = normalizeSearchSelectionStrings(
    rows.map((item) => extractSearchSelectionProductId(item)),
    12,
  );
  const selectedTitles = normalizeSearchSelectionStrings(
    rows.map((item) => extractSearchSelectionTitle(item)),
    12,
  );
  const warningReasons = [];
  if (rows.length > 0 && hasClarification) warningReasons.push('clarify_preferred');
  if (rows.length > 0 && lowConfidence) warningReasons.push('low_confidence');
  const normalizedReasonCodes = Array.from(
    new Set(
      [
        finalDecision,
        ...(Array.isArray(selectionReasonCodes) ? selectionReasonCodes : []),
        ...warningReasons,
      ]
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
  return {
    selection_owner:
      firstNonEmptyString(decisionOwner, defaultSelectionOwner) || defaultSelectionOwner,
    selected_products_count: rows.length,
    selected_product_ids: selectedProductIds,
    selected_titles: selectedTitles,
    selection_signature: buildSearchSelectionSignature({ selectedProductIds, selectedTitles }),
    mainline_status: rows.length > 0
      ? 'grounded_success'
      : String(finalDecision || '').trim().toLowerCase() === 'clarify'
      ? 'needs_more_context'
      : 'empty_structured',
    context_warning: warningReasons.length ? { applied: true, reasons: warningReasons } : null,
    selection_reason_codes: normalizedReasonCodes,
    source_tier_counts:
      sourceTierCounts && isPlainObject(sourceTierCounts) ? sourceTierCounts : {},
    top_candidate_provenance:
      topCandidateProvenance && isPlainObject(topCandidateProvenance)
        ? topCandidateProvenance
        : null,
  };
}

function shouldUseBeautyMainlineContractAuthority({
  operation = '',
  strictBeautyDirectSearch = false,
  semanticOwnerControlled = false,
  beautyDecisionOwner = '',
  beautySemanticOwner = '',
} = {}) {
  return (
    operation === 'find_products_multi' &&
    (
      strictBeautyDirectSearch ||
      semanticOwnerControlled ||
      beautyDecisionOwner === 'shopping_agent_beauty_mainline' ||
      beautySemanticOwner === 'shopping_agent_beauty_mainline'
    )
  );
}

function buildSearchContractBridgeMeta({
  operation = '',
  strictCommerceFindProductsMulti = false,
  strictBeautyDirectSearch = false,
  semanticOwnerControlled = false,
  explicitResolvedContract = '',
} = {}) {
  if (operation !== 'find_products_multi') return null;
  const normalizedExplicit = String(explicitResolvedContract || '').trim();
  if (normalizedExplicit === 'shop_invoke_strict') {
    return {
      attempted_contract: 'shop_invoke_strict',
      resolved_contract: 'shop_invoke_strict',
      legacy_fallback: false,
    };
  }
  if (
    normalizedExplicit === 'agent_v1_search_beauty_mainline' ||
    strictBeautyDirectSearch ||
    semanticOwnerControlled
  ) {
    return {
      attempted_contract: 'agent_v1_search_beauty_mainline',
      resolved_contract: 'agent_v1_search_beauty_mainline',
      legacy_fallback: false,
    };
  }
  if (strictCommerceFindProductsMulti) {
    return {
      attempted_contract: 'shop_invoke_strict',
      resolved_contract: 'shop_invoke_strict',
      legacy_fallback: false,
    };
  }
  return null;
}

function applyBeautySearchContractAuthority({
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
  lowConfidenceFlag = false,
  mergedSourceBreakdown = null,
  querySource = '',
  searchStageLedger = null,
  defaultSelectionOwner = 'shopping_agent_beauty_mainline',
} = {}) {
  const shouldStampBeautyMainlineContract = shouldUseBeautyMainlineContractAuthority({
    operation,
    strictBeautyDirectSearch,
    semanticOwnerControlled,
    beautyDecisionOwner,
    beautySemanticOwner,
  });
  const normalizedExistingContractBridge =
    existingMeta?.contract_bridge && isPlainObject(existingMeta.contract_bridge)
      ? existingMeta.contract_bridge
      : {};
  const resolvedContractForMetadata = shouldStampBeautyMainlineContract
    ? 'agent_v1_search_beauty_mainline'
    : (String(normalizedExistingContractBridge.resolved_contract || '').trim() || '');
  const attemptedContractForMetadata = shouldStampBeautyMainlineContract
    ? 'agent_v1_search_beauty_mainline'
    : (
      String(normalizedExistingContractBridge.attempted_contract || '').trim() ||
      (resolvedContractForMetadata ? resolvedContractForMetadata : '')
    );
  const finalSelection = shouldStampBeautyMainlineContract
    ? buildSearchFinalSelectionContract({
        products,
        decisionOwner: defaultSelectionOwner,
        defaultSelectionOwner,
        finalDecision,
        hasClarification,
        lowConfidence: lowConfidenceFlag,
        sourceTierCounts: mergedSourceBreakdown?.source_tier_counts,
        topCandidateProvenance: mergedSourceBreakdown?.top_candidate_provenance,
        selectionReasonCodes: [mergedSourceBreakdown?.strategy_applied, querySource],
      })
    : null;
  const shouldClearReplyForGroundedMainline =
    shouldStampBeautyMainlineContract &&
    finalSelection &&
    String(finalSelection.mainline_status || '').trim() === 'grounded_success' &&
    Number(finalSelection.selected_products_count || 0) > 0;

  if (
    searchStageLedger &&
    isPlainObject(searchStageLedger) &&
    finalSelection
  ) {
    searchStageLedger.final_selection = finalSelection;
  }

  return {
    enriched: {
      ...enriched,
      ...(shouldClearReplyForGroundedMainline ? { reply: null } : {}),
      metadata: {
        ...(existingMeta && isPlainObject(existingMeta) ? existingMeta : {}),
        ...(shouldStampBeautyMainlineContract
          ? {
              semantic_owner: defaultSelectionOwner,
              decision_owner: defaultSelectionOwner,
            }
          : {}),
        ...(resolvedContractForMetadata
          ? {
              attempted_contract: attemptedContractForMetadata,
              resolved_contract: resolvedContractForMetadata,
              contract_bridge: {
                ...normalizedExistingContractBridge,
                attempted_contract: attemptedContractForMetadata,
                resolved_contract: resolvedContractForMetadata,
                legacy_fallback:
                  normalizedExistingContractBridge.legacy_fallback === true ? true : false,
              },
            }
          : {}),
        ...(finalSelection
          ? {
              mainline_status: finalSelection.mainline_status,
              final_selection: finalSelection,
              selection_signature: finalSelection.selection_signature,
              selected_product_ids: finalSelection.selected_product_ids,
              selected_titles: finalSelection.selected_titles,
              ...(finalSelection.context_warning
                ? { context_warning: finalSelection.context_warning }
                : {}),
            }
          : {}),
        source_breakdown: mergedSourceBreakdown,
        search_decision: {
          ...(existingMeta?.search_decision && isPlainObject(existingMeta.search_decision)
            ? existingMeta.search_decision
            : {}),
          source_tier_counts: mergedSourceBreakdown?.source_tier_counts,
          source_quality_counts: mergedSourceBreakdown?.source_quality_counts,
          cache_owner_paths: mergedSourceBreakdown?.cache_owner_paths,
          top_candidate_provenance: mergedSourceBreakdown?.top_candidate_provenance,
          ...(finalSelection
            ? {
                mainline_status: finalSelection.mainline_status,
                final_selection: finalSelection,
              }
            : {}),
        },
      },
    },
    finalSelection,
    resolvedContractForMetadata,
    attemptedContractForMetadata,
  };
}

module.exports = {
  buildSearchContractBridgeMeta,
  buildSearchFinalSelectionContract,
  applyBeautySearchContractAuthority,
  shouldUseBeautyMainlineContractAuthority,
};
