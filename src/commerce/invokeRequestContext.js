function extractCreatorId(payload) {
  if (!payload) return null;
  return (
    payload.creator_id ||
    payload.creatorId ||
    payload.metadata?.creator_id ||
    payload.metadata?.creatorId ||
    payload.search?.creator_id ||
    payload.similar?.creator_id ||
    null
  );
}

function getDefaultCreatorId(creatorConfigs = []) {
  const env = process.env.DEFAULT_CREATOR_ID || process.env.CREATOR_ID || '';
  const trimmed = String(env || '').trim();
  if (trimmed) return trimmed;

  const first =
    Array.isArray(creatorConfigs) &&
    creatorConfigs[0] &&
    creatorConfigs[0].creatorId
      ? String(creatorConfigs[0].creatorId).trim()
      : '';
  return first || null;
}

function normalizeInvokeMetadata(
  rawMetadata = {},
  payload = {},
  {
    creatorConfigs = [],
    isCreatorUiSource = () => false,
    getDefaultCreatorIdFn = getDefaultCreatorId,
  } = {},
) {
  let creatorId =
    rawMetadata.creator_id ||
    rawMetadata.creatorId ||
    payload.creator_id ||
    payload.creatorId ||
    payload.search?.creator_id ||
    null;

  const creatorName =
    rawMetadata.creator_name ||
    rawMetadata.creatorName ||
    payload.creator_name ||
    payload.creatorName ||
    null;

  const traceId =
    rawMetadata.trace_id ||
    rawMetadata.traceId ||
    payload.trace_id ||
    payload.traceId ||
    null;

  const source = rawMetadata.source || payload.source || 'shopping-agent-ui';

  if (!creatorId && isCreatorUiSource(source)) {
    creatorId = getDefaultCreatorIdFn(creatorConfigs);
  }

  return {
    ...rawMetadata,
    ...(creatorId && { creator_id: creatorId, creatorId }),
    ...(creatorName && { creator_name: creatorName, creatorName }),
    ...(traceId && { trace_id: traceId, traceId }),
    ...(source && { source }),
  };
}

async function initializeInvokeRequestContext({
  reqBody,
  gatewayRequestId,
  invokeStartedAtMs,
  invokeRequestSchema,
  operationEnum,
  creatorConfigs = [],
  isCreatorUiSource,
  buildFindProductsMultiContext,
  defaultFindProductsMultiExpansionMode,
  searchCacheValidate,
  searchForceControlledRecallForScenario,
  searchCacheMinAnchor,
  searchCacheMaxDomainEntropy,
  searchCacheMinCount,
  searchCacheMaxCrossDomainRatio,
  searchUpstreamQuotaClarifyEnabled,
  searchUpstreamQuotaClarifyQueryClasses = [],
  normalizeMetadata = normalizeInvokeMetadata,
  extractCreatorIdFn = extractCreatorId,
  logger,
} = {}) {
  const parsed = invokeRequestSchema.safeParse(reqBody);
  if (!parsed.success) {
    logger?.warn?.(
      { gateway_request_id: gatewayRequestId, error: parsed.error.format() },
      'Invalid request body',
    );
    return {
      handled: true,
      statusCode: 400,
      body: {
        error: 'INVALID_REQUEST',
        details: parsed.error.format(),
      },
    };
  }

  const { operation, payload } = parsed.data;
  if (!operationEnum.options.includes(operation)) {
    return {
      handled: true,
      statusCode: 400,
      body: {
        error: 'UNSUPPORTED_OPERATION',
        operation,
      },
    };
  }

  const metadata = normalizeMetadata(reqBody.metadata, payload, {
    creatorConfigs,
    isCreatorUiSource,
  });
  const creatorId = extractCreatorIdFn({ ...payload, metadata });
  const now = new Date();

  let findProductsMultiCtx = null;
  let nluLatencyMs = 0;
  if (operation === 'find_products_multi') {
    const nluStartedAtMs = Date.now();
    findProductsMultiCtx = await buildFindProductsMultiContext({
      payload,
      metadata: {
        ...(metadata || {}),
        expansion_mode: defaultFindProductsMultiExpansionMode,
      },
    });
    nluLatencyMs = Math.max(0, Date.now() - nluStartedAtMs);
  }

  const effectivePayload = findProductsMultiCtx?.adjustedPayload || payload;
  const effectiveIntent = findProductsMultiCtx?.intent || null;
  const findProductsExpansionMeta = findProductsMultiCtx?.expansion_meta || null;
  const rawUserQuery =
    findProductsMultiCtx?.rawUserQuery ||
    effectivePayload?.search?.query ||
    effectivePayload?.query ||
    payload?.search?.query ||
    payload?.query ||
    '';

  const policyMetadata =
    operation === 'find_products_multi'
      ? {
          ...(metadata || {}),
          ...(Number.isFinite(Number(findProductsExpansionMeta?.ambiguity_score_pre))
            ? {
                ambiguity_score_pre: Number(findProductsExpansionMeta.ambiguity_score_pre),
              }
            : {}),
          ...(findProductsExpansionMeta?.query_class
            ? { query_class: String(findProductsExpansionMeta.query_class) }
            : {}),
          ...(findProductsExpansionMeta?.rewrite_gate &&
          typeof findProductsExpansionMeta.rewrite_gate === 'object'
            ? { rewrite_gate: findProductsExpansionMeta.rewrite_gate }
            : {}),
          ...(findProductsExpansionMeta?.association_plan &&
          typeof findProductsExpansionMeta.association_plan === 'object'
            ? { association_plan: findProductsExpansionMeta.association_plan }
            : {}),
        }
      : metadata;

  const traceQueryClass =
    findProductsExpansionMeta?.query_class || effectiveIntent?.query_class || null;
  const traceRewriteGate =
    findProductsExpansionMeta?.rewrite_gate &&
    typeof findProductsExpansionMeta.rewrite_gate === 'object'
      ? findProductsExpansionMeta.rewrite_gate
      : null;
  const traceAssociationPlan =
    findProductsExpansionMeta?.association_plan &&
    typeof findProductsExpansionMeta.association_plan === 'object'
      ? findProductsExpansionMeta.association_plan
      : null;
  const traceFlagsSnapshotBase =
    findProductsExpansionMeta?.flags_snapshot &&
    typeof findProductsExpansionMeta.flags_snapshot === 'object'
      ? findProductsExpansionMeta.flags_snapshot
      : {};
  const traceFlagsSnapshot = {
    ...traceFlagsSnapshotBase,
    search_cache_validate: searchCacheValidate,
    search_force_controlled_recall_for_scenario: searchForceControlledRecallForScenario,
    search_cache_min_anchor: searchCacheMinAnchor,
    search_cache_max_domain_entropy: searchCacheMaxDomainEntropy,
    search_cache_min_count: searchCacheMinCount,
    search_cache_max_cross_domain_ratio: searchCacheMaxCrossDomainRatio,
    search_upstream_quota_clarify_enabled: searchUpstreamQuotaClarifyEnabled,
    search_upstream_quota_clarify_query_classes: Array.from(
      searchUpstreamQuotaClarifyQueryClasses,
    ),
  };
  const traceAmbiguityScorePre = Number.isFinite(
    Number(findProductsExpansionMeta?.ambiguity_score_pre),
  )
    ? Number(findProductsExpansionMeta.ambiguity_score_pre)
    : null;

  const fpmGateTrace = [];
  const addFpmGateTrace = ({
    gateId,
    applied = false,
    decision = 'pass',
    reason = null,
    costMsEstimate = 0,
    queryClass = null,
  }) => {
    fpmGateTrace.push({
      gate_id: String(gateId || 'unknown'),
      applied: Boolean(applied),
      decision: String(decision || 'pass'),
      reason: reason ? String(reason) : null,
      cost_ms_estimate: Math.max(0, Number(costMsEstimate || 0) || 0),
      query_class: queryClass ? String(queryClass) : null,
    });
  };
  const getFpmElapsedMs = () => Math.max(0, Date.now() - invokeStartedAtMs);
  const getFpmRemainingBudgetMs = (budgetMs) =>
    Math.max(0, Number(budgetMs || 0) - getFpmElapsedMs());

  return {
    handled: false,
    operation,
    payload,
    metadata,
    creatorId,
    now,
    effectivePayload,
    effectiveIntent,
    findProductsExpansionMeta,
    rawUserQuery,
    policyMetadata,
    traceQueryClass,
    traceRewriteGate,
    traceAssociationPlan,
    traceFlagsSnapshot,
    traceAmbiguityScorePre,
    fpmGateTrace,
    addFpmGateTrace,
    getFpmRemainingBudgetMs,
    debugRuntimePatch: {
      operation: String(operation || '').trim().toLowerCase(),
      nluLatencyMs,
      rawUserQuery: String(rawUserQuery || '').trim(),
      intent: effectiveIntent || null,
      expansionMode:
        findProductsExpansionMeta?.mode || defaultFindProductsMultiExpansionMode,
    },
  };
}

module.exports = {
  extractCreatorId,
  getDefaultCreatorId,
  normalizeInvokeMetadata,
  initializeInvokeRequestContext,
};
