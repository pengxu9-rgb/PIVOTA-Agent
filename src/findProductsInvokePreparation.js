function createFindProductsInvokePreparationRuntime(deps = {}) {
  const {
    buildFindProductsMultiContext,
    resolveLegacyBeautyCacheOwnerBypass,
    isAuroraSource,
    isBeautyDiscoverySemanticContract,
    buildAuroraFindProductsMultiPlan,
    FIND_PRODUCTS_MULTI_EXPANSION_MODE,
  } = deps;

  async function prepareInvokeFindProductsMultiContext({
    operation = '',
    payload = null,
    metadata = null,
    parsedPayload = null,
  } = {}) {
    let nextMetadata = metadata;
    let findProductsMultiCtx = null;
    let nluLatencyMs = 0;

    if (operation === 'find_products_multi') {
      const nluStartedAtMs = Date.now();
      findProductsMultiCtx = await buildFindProductsMultiContext({
        payload,
        metadata: {
          ...(metadata || {}),
          expansion_mode: FIND_PRODUCTS_MULTI_EXPANSION_MODE,
        },
      });
      nluLatencyMs = Math.max(0, Date.now() - nluStartedAtMs);

      const governanceShadowRuntime =
        metadata?.governance_shadow_runtime &&
        typeof metadata.governance_shadow_runtime === 'object' &&
        !Array.isArray(metadata.governance_shadow_runtime)
          ? metadata.governance_shadow_runtime
          : null;
      const declaredRequestSource = String(
        parsedPayload?.metadata?.source || '',
      )
        .trim()
        .toLowerCase();
      const semanticContractCandidate =
        findProductsMultiCtx?.expansion_meta?.semantic_contract &&
        typeof findProductsMultiCtx.expansion_meta.semantic_contract === 'object' &&
        !Array.isArray(findProductsMultiCtx.expansion_meta.semantic_contract)
          ? findProductsMultiCtx.expansion_meta.semantic_contract
          : null;
      const declaredAuroraBeautyMainlineBypass = resolveLegacyBeautyCacheOwnerBypass({
        search:
          findProductsMultiCtx?.adjustedPayload?.search ||
          parsedPayload?.search ||
          payload?.search ||
          null,
        metadata: {
          ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
          source: declaredRequestSource || metadata?.source || null,
        },
        rawQuery:
          findProductsMultiCtx?.rawUserQuery ||
          findProductsMultiCtx?.adjustedPayload?.search?.query ||
          parsedPayload?.search?.query ||
          payload?.search?.query ||
          '',
        queryClass: findProductsMultiCtx?.expansion_meta?.query_class || null,
        strictConstraintQuery: false,
      });

      if (
        isAuroraSource(declaredRequestSource) &&
        (
          isBeautyDiscoverySemanticContract(semanticContractCandidate) ||
          declaredAuroraBeautyMainlineBypass.bypass === true
        )
      ) {
        nextMetadata = {
          ...metadata,
          source: declaredRequestSource,
          governance_shadow_runtime: {
            ...governanceShadowRuntime,
            source_restore_applied: true,
            source_restore_reason: 'aurora_beauty_mainline',
            source_restore_from_request: declaredRequestSource,
          },
        };
      }
    }

    const auroraInvokePlan = buildAuroraFindProductsMultiPlan({
      source: nextMetadata?.source,
      operation,
    });

    return {
      metadata: nextMetadata,
      findProductsMultiCtx,
      nluLatencyMs,
      auroraInvokePlan,
      auroraFallbackOverrides: auroraInvokePlan.fallbackOverrides,
      resolverTimeoutMs: auroraInvokePlan.resolverTimeoutMs,
    };
  }

  return {
    prepareInvokeFindProductsMultiContext,
  };
}

module.exports = {
  createFindProductsInvokePreparationRuntime,
};
