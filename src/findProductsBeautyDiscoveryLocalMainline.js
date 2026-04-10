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

function parseBooleanLike(value) {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(Array.isArray(value) ? value[0] : value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function normalizeRoleStep(roleId = '') {
  const normalized = String(roleId || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('sunscreen') || normalized.includes('spf')) return 'sunscreen';
  if (normalized.includes('moisturizer') || normalized.includes('cream') || normalized.includes('lotion')) {
    return 'moisturizer';
  }
  return 'treatment';
}

function getSelectedProductIds(products = []) {
  return (Array.isArray(products) ? products : [])
    .map((product) => {
      if (!isPlainObject(product)) return '';
      return String(product.product_id || product.productId || product.id || '').trim();
    })
    .filter(Boolean);
}

function buildSupplementTrace({
  stageId = '',
  queryEntries = [],
  selectedProductIdsBefore = [],
  selectedProductIdsAfter = [],
  primaryProductIdBefore = '',
  primaryProductIdAfter = '',
  skipped = false,
  skipReason = '',
  timeoutCount = 0,
} = {}) {
  const normalizedStageId = String(stageId || '').trim();
  if (!normalizedStageId) return null;
  let supplementType = '';
  let supplementReason = '';
  if (normalizedStageId === 'framework_stage_b_primary_external_seed') {
    supplementType = 'semantic_owner_external_coverage';
    supplementReason = 'primary_coverage_repair';
  } else if (normalizedStageId.startsWith('framework_stage_c_support_')) {
    supplementType = 'semantic_owner_framework_support';
    supplementReason = 'role_coverage_repair';
  }
  if (!supplementType) return null;
  const before = new Set(
    (Array.isArray(selectedProductIdsBefore) ? selectedProductIdsBefore : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );
  const after = (Array.isArray(selectedProductIdsAfter) ? selectedProductIdsAfter : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const addedProducts = after.filter((value) => !before.has(value));
  const attemptedQueries = (Array.isArray(queryEntries) ? queryEntries : [])
    .map((entry) => String(entry?.query || '').trim())
    .filter(Boolean);
  let status = 'miss';
  if (skipped) status = 'skipped';
  else if (addedProducts.length > 0) status = 'applied';
  else if (Number(timeoutCount || 0) > 0) status = 'transient_miss';
  return {
    supplement_type: supplementType,
    supplement_reason: supplementReason,
    status,
    attempted_queries: attemptedQueries,
    applied_queries: addedProducts.length > 0 ? attemptedQueries : [],
    added_products: addedProducts,
    filtered_products: 0,
    did_change_primary_slot:
      String(primaryProductIdBefore || '').trim() !== String(primaryProductIdAfter || '').trim(),
    ...(skipReason ? { skip_reason: String(skipReason).trim() } : {}),
  };
}

function isFrameworkPrimaryInternalStageId(stageId = '') {
  const normalizedStageId = String(stageId || '').trim().toLowerCase();
  if (!normalizedStageId) return false;
  return (
    normalizedStageId === 'framework_stage_a_primary_internal' ||
    normalizedStageId.startsWith('framework_stage_a_primary_')
  );
}

function hasFrameworkPrimaryStageTimeout(searchResults = []) {
  return (Array.isArray(searchResults) ? searchResults : []).some((row) => {
    const stageId = String(row?.stage_id || row?.ladder_level || '').trim().toLowerCase();
    if (!isFrameworkPrimaryInternalStageId(stageId)) return false;
    const reason = String(row?.reason || '').trim().toLowerCase();
    const skippedReason = String(row?.skipped_reason || '').trim().toLowerCase();
    return reason === 'upstream_timeout' || skippedReason === 'budget_guard';
  });
}

function hasFrameworkPrimaryStageRecall(searchResults = []) {
  return (Array.isArray(searchResults) ? searchResults : []).some((row) => {
    const stageId = String(row?.stage_id || row?.ladder_level || '').trim().toLowerCase();
    if (!isFrameworkPrimaryInternalStageId(stageId)) return false;
    const products = Array.isArray(row?.products) ? row.products : [];
    return products.length > 0;
  });
}

function buildPrimaryQueryPackAttempts(recallPlan = null) {
  return (Array.isArray(recallPlan?.entries) ? recallPlan.entries : [])
    .map((entry, index, rows) => ({
      query: String(entry?.query || '').trim(),
      query_index:
        Number.isFinite(Number(entry?.query_index)) ? Number(entry.query_index) : index,
      query_total: rows.length,
      ladder_level: String(entry?.stage_id || entry?.ladder_level || '').trim() || null,
      role_id: String(entry?.role_id || '').trim() || null,
      role_rank:
        Number.isFinite(Number(entry?.role_rank)) ? Number(entry.role_rank) : null,
      source_scope: String(entry?.source_scope || 'internal').trim().toLowerCase() || 'internal',
      preferred_step:
        String(entry?.preferred_step || '').trim().toLowerCase() || null,
    }))
    .filter((entry) => entry.query);
}

function looksLikeBroadBeautyDiscoveryQuery(queryText = '') {
  const normalized = String(queryText || '').trim().toLowerCase();
  if (!normalized) return false;
  const hasBroadAskSignal =
    /\b(what products should i use|what should i use|routine|routine for|products for|need products|need a routine|i am|i'm|im|my skin|i have)\b/.test(
      normalized,
    ) || /\b(oily skin|dry skin|acne-prone|sensitive skin|combination skin)\b/.test(normalized);
  if (!hasBroadAskSignal) return false;
  const hasExplicitSingleStepSignal =
    /\b(cleanser|face wash|serum|treatment|moisturi[sz]er|cream|lotion|gel cream|sunscreen|spf|toner|mask)\b/.test(
      normalized,
    );
  return !hasExplicitSingleStepSignal;
}

function normalizeSearchObject(value) {
  return isPlainObject(value) ? value : {};
}

function mapLocalSearchReasonToPrimaryFailureStage(reason = '') {
  const normalized = String(reason || '').trim().toLowerCase();
  if (!normalized || normalized === 'ok') return null;
  if (normalized === 'upstream_timeout' || normalized === 'budget_exhausted') {
    return 'primary_upstream_timeout';
  }
  if (normalized === 'upstream_error') return 'primary_upstream_error';
  return 'no_recall_from_planned_sources';
}

function withWallClockTimeout(promise, timeoutMs, timeoutCode = 'LOCAL_WALL_CLOCK_TIMEOUT') {
  const normalizedTimeoutMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(1, Math.trunc(Number(timeoutMs)))
    : 0;
  if (!normalizedTimeoutMs) return Promise.resolve(promise);
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(timeoutCode);
        err.code = timeoutCode;
        reject(err);
      }, normalizedTimeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildBoundedPrimitiveFailure({
  reason = 'upstream_error',
  timeoutMs = 0,
  error = '',
} = {}) {
  return {
    ok: false,
    products: [],
    reason: String(reason || '').trim().toLowerCase() || 'upstream_error',
    actual_http_attempt_count: 0,
    attempted_request_timeouts_ms:
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0
        ? [Math.trunc(Number(timeoutMs))]
        : [],
    ...(String(error || '').trim() ? { error: String(error || '').trim() } : {}),
    ...(String(reason || '').trim().toLowerCase() === 'upstream_timeout'
      ? { timeout_guard: 'caller_wall_clock' }
      : {}),
  };
}

function buildStepAwareCriticalQueryPack(queryPack = [], semanticContract = null) {
  const normalized = Array.from(
    new Set(
      (Array.isArray(queryPack) ? queryPack : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  );
  const targetStepFamily = String(semanticContract?.target_step_family || '')
    .trim()
    .toLowerCase();
  if (targetStepFamily !== 'sunscreen') return normalized;

  const ranked = [];
  const pushMatch = (pattern) => {
    const hit = normalized.find((query) => pattern.test(query));
    if (hit && !ranked.includes(hit)) ranked.push(hit);
  };

  pushMatch(/\blightweight\b.*\bsunscreen\b|\bsunscreen\b.*\blightweight\b/i);
  pushMatch(/\boil control\b.*\bsunscreen\b|\bsunscreen\b.*\boil control\b/i);
  pushMatch(/\bface\b.*\bsunscreen\b|\bsunscreen\b.*\bface\b/i);

  for (const query of normalized) {
    if (ranked.length >= 2) break;
    if (!ranked.includes(query)) ranked.push(query);
  }
  return ranked.slice(0, 2);
}

function clampLocalBeautyRecallAttemptTimeoutMs({
  primaryTimeoutMs = 0,
  remainingBudgetMs = 0,
  queryTotal = 1,
  sourceScope = '',
  plannerMode = '',
  isPrimaryInternalAnchor = false,
} = {}) {
  const remaining =
    Number.isFinite(Number(remainingBudgetMs)) && Number(remainingBudgetMs) > 0
      ? Number(remainingBudgetMs)
      : 0;
  if (remaining <= 0) return 0;
  const primary =
    Number.isFinite(Number(primaryTimeoutMs)) && Number(primaryTimeoutMs) > 0
      ? Number(primaryTimeoutMs)
      : remaining;
  const normalizedPlannerMode = String(plannerMode || '').trim().toLowerCase();
  if (normalizedPlannerMode === 'step_aware') {
    return Math.min(remaining, Math.max(120, Math.min(primary, 3000)));
  }
  const normalizedQueryTotal =
    Number.isFinite(Number(queryTotal)) && Number(queryTotal) > 0
      ? Number(queryTotal)
      : 1;
  const normalizedSourceScope = String(sourceScope || '').trim().toLowerCase();
  if (
    normalizedPlannerMode === 'framework_generic' &&
    normalizedSourceScope === 'internal' &&
    isPrimaryInternalAnchor === true &&
    normalizedQueryTotal > 6
  ) {
    return Math.min(remaining, Math.max(120, Math.min(primary, 4800)));
  }
  const capByFanout = normalizedQueryTotal > 6 ? 1800 : 2400;
  const capBySource =
    normalizedSourceScope === 'external_seed' && normalizedPlannerMode === 'framework_generic'
      ? 4800
      : normalizedSourceScope === 'external_seed'
        ? 2400
        : capByFanout;
  return Math.min(remaining, Math.max(120, Math.min(primary, capBySource)));
}

function buildLocalQueryString(params = {}) {
  const search = new URLSearchParams();
  Object.entries(isPlainObject(params) ? params : {}).forEach(([key, value]) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item == null) return;
        search.append(key, String(item));
      });
      return;
    }
    if (isPlainObject(value)) {
      try {
        search.append(key, JSON.stringify(value));
      } catch (_) {
        // Ignore malformed structured values in local-only query serialization.
      }
      return;
    }
    search.append(key, String(value));
  });
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

function parseLocalUrlQuery(url = '') {
  const renderedUrl = String(url || '').trim();
  if (!renderedUrl) return {};
  try {
    const parsed = new URL(renderedUrl, 'http://local-mainline.test');
    const out = {};
    for (const [key, value] of parsed.searchParams.entries()) {
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        const existing = out[key];
        out[key] = Array.isArray(existing) ? existing.concat(value) : [existing, value];
      } else {
        out[key] = value;
      }
    }
    return out;
  } catch (_) {
    return {};
  }
}

function normalizeTransportHop(value) {
  return isPlainObject(value) ? value : null;
}

  function collectLocalTransportTrace({
    rows = [],
    metadata = null,
    executionPlan = null,
  } = {}) {
    const hops = [];
    const internalBaseUrls = new Set();
    const internalPaths = new Set();
    const normalizedRows = Array.isArray(rows) ? rows : [];
    const normalizedMetadata = normalizeSearchObject(metadata);
    let observedPrimaryTransportOwner = firstNonEmptyString(
      normalizedMetadata.primary_transport_owner,
      normalizedMetadata.transport_owner,
    );
    let observedPrimaryEndpointKind = firstNonEmptyString(
      normalizedMetadata.primary_endpoint_kind,
      normalizedMetadata.endpoint_kind,
    );

    const appendRow = (row) => {
      if (!isPlainObject(row)) return;
      if (!observedPrimaryTransportOwner) {
        observedPrimaryTransportOwner = firstNonEmptyString(
          row.primary_transport_owner,
          row.transport_owner,
        );
      }
      if (!observedPrimaryEndpointKind) {
        observedPrimaryEndpointKind = firstNonEmptyString(
          row.primary_endpoint_kind,
          row.endpoint_kind,
        );
      }
      if (Array.isArray(row.transport_hops)) {
        row.transport_hops
          .map(normalizeTransportHop)
          .filter(Boolean)
          .forEach((hop) => hops.push(hop));
    }
    (Array.isArray(row.attempted_internal_base_urls) ? row.attempted_internal_base_urls : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .forEach((value) => internalBaseUrls.add(value));
    (Array.isArray(row.attempted_internal_paths) ? row.attempted_internal_paths : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .forEach((value) => internalPaths.add(value));
  };

  normalizedRows.forEach(appendRow);
  appendRow(normalizedMetadata);

  if (!observedPrimaryTransportOwner && hops.length > 0) {
    observedPrimaryTransportOwner = firstNonEmptyString(
      hops[0]?.transport_owner,
    );
  }
  if (!observedPrimaryEndpointKind && hops.length > 0) {
    observedPrimaryEndpointKind = firstNonEmptyString(
      hops[0]?.endpoint_kind,
    );
  }

  return {
    transport_hops: hops,
    transport_hop_count: hops.length,
    nested_orchestrator_hops: hops.filter(
      (hop) => String(hop?.endpoint_kind || '').trim().toLowerCase() === 'public_orchestrator',
    ).length,
    primary_transport_owner: observedPrimaryTransportOwner || null,
    primary_endpoint_kind: observedPrimaryEndpointKind || null,
    attempted_internal_base_urls: Array.from(internalBaseUrls),
    attempted_internal_paths: Array.from(internalPaths),
  };
}

function extractTransportMetadataFromSearchOut(searchOut = null) {
  const out = isPlainObject(searchOut) ? searchOut : {};
  return {
    ...(Array.isArray(out.transport_hops) ? { transport_hops: out.transport_hops } : {}),
    ...(Number.isFinite(Number(out.transport_hop_count))
      ? { transport_hop_count: Number(out.transport_hop_count) }
      : {}),
    ...(Number.isFinite(Number(out.nested_orchestrator_hops))
      ? { nested_orchestrator_hops: Number(out.nested_orchestrator_hops) }
      : {}),
    ...(out.primary_transport_owner
      ? { primary_transport_owner: String(out.primary_transport_owner).trim() }
      : {}),
    ...(out.primary_endpoint_kind
      ? { primary_endpoint_kind: String(out.primary_endpoint_kind).trim() }
      : {}),
    ...(Array.isArray(out.attempted_internal_base_urls)
      ? { attempted_internal_base_urls: out.attempted_internal_base_urls }
      : {}),
    ...(Array.isArray(out.attempted_internal_paths)
      ? { attempted_internal_paths: out.attempted_internal_paths }
      : {}),
    ...(out.transport_owner ? { transport_owner: String(out.transport_owner).trim() } : {}),
    ...(out.endpoint_kind ? { endpoint_kind: String(out.endpoint_kind).trim() } : {}),
  };
}

function createFindProductsBeautyDiscoveryLocalMainlineRuntime(deps = {}) {
  const {
    buildBeautyDiscoverySemanticContract,
    buildBeautyDiscoveryQueryPackFromContract,
    buildConcernSemanticPlanFallback,
    buildConcernTargetContextFromSemanticPlan,
    buildRecoRecallPlan,
    buildRecoSearchSemanticContract,
    shouldRunRecoRecallStage,
    buildRecoRecallTransportPolicy,
    resolveRecoRecallTransportModeForPlannerMode,
    searchInternalProductsPrimitive,
    searchPivotaBackendProducts,
    normalizeRecoCatalogProduct,
    normalizeAgentProductsListResponse,
    prepareInvokeSemanticOwnerContext,
    runInvokeSemanticOwnerExecution,
    fetchExternalSeedSupplementFromBackend,
    finalizeConcernFrameworkCandidatePools,
    countCandidateOriginBreakdown,
    withSearchDiagnostics,
    buildSearchRouteHealth,
    buildSearchTrace,
    buildDecisionAuthorityPatch,
    applyInvokeBeautyAuthority,
    applyBeautySearchMetadataAuthority,
    buildFindProductsSearchExecutionTrace,
    BEAUTY_DISCOVERY_MAINLINE_OWNER,
  } = deps;
  const runInternalSearchPrimitive =
    typeof searchInternalProductsPrimitive === 'function'
      ? searchInternalProductsPrimitive
      : typeof searchPivotaBackendProducts === 'function'
        ? searchPivotaBackendProducts
        : null;

  function buildLocalBeautyDiscoveryMainlineResponse({
    queryText = '',
    contract = null,
    plan = null,
    traceQueryClass = null,
    gatewayRequestId = null,
    invokeStartedAtMs = 0,
    primaryTimeoutMs = null,
    semanticContract = null,
    semanticRewriteResultMeta = null,
    primaryQueryPackAttempts = [],
    selectedProducts = [],
    rawCandidates = [],
    supplementTraces = [],
    primaryFailureStage = null,
    finalDecision = 'strict_empty',
    operation = 'find_products_multi',
    upstreamMetadata = null,
    transportTrace = null,
    candidateState = null,
  } = {}) {
    const normalizedContract = isPlainObject(contract) ? contract : {};
    const normalizedPlan = isPlainObject(plan) ? plan : {};
    const normalizedSelectedProducts = Array.isArray(selectedProducts)
      ? selectedProducts
      : [];
    const normalizedRawCandidates = Array.isArray(rawCandidates) ? rawCandidates : [];
    const normalizedSupplementTraces = Array.isArray(supplementTraces)
      ? supplementTraces
      : [];
    const normalizedTransportTrace = isPlainObject(transportTrace)
      ? transportTrace
      : collectLocalTransportTrace({
          metadata: upstreamMetadata,
          executionPlan: normalizedPlan,
        });
    const sourceObservability = countCandidateOriginBreakdown(
      normalizedSelectedProducts.length > 0
        ? normalizedSelectedProducts
        : normalizedRawCandidates,
    );
    const normalizedCandidateState = isPlainObject(candidateState) ? candidateState : {};
    const baseResponse = {
      status: 'success',
      success: true,
      products: normalizedSelectedProducts,
      total: normalizedSelectedProducts.length,
      page: 1,
      page_size: normalizedSelectedProducts.length,
      reply: null,
      metadata: {
        query_source: 'beauty_discovery_local_mainline',
        fetched_at: new Date().toISOString(),
        ...(isPlainObject(upstreamMetadata) ? upstreamMetadata : {}),
        ...(isPlainObject(semanticContract) ? { semantic_contract: semanticContract } : {}),
        ...(Number.isFinite(Number(normalizedCandidateState.raw_candidate_count))
          ? { raw_candidate_count: Number(normalizedCandidateState.raw_candidate_count) }
          : {}),
        ...(Number.isFinite(Number(normalizedCandidateState.viable_candidate_count))
          ? { viable_candidate_count: Number(normalizedCandidateState.viable_candidate_count) }
          : {}),
        ...(Number.isFinite(Number(normalizedCandidateState.selected_candidate_count))
          ? { selected_candidate_count: Number(normalizedCandidateState.selected_candidate_count) }
          : {}),
        ...(typeof normalizedCandidateState.primary_role_matched === 'boolean'
          ? { primary_role_matched: normalizedCandidateState.primary_role_matched }
          : {}),
        ...(normalizedCandidateState.best_available_role_id
          ? { best_available_role_id: String(normalizedCandidateState.best_available_role_id) }
          : {}),
        ...(normalizedCandidateState.weak_viable_pool === true
          ? { weak_viable_pool: true }
          : {}),
        ...(Array.isArray(normalizedCandidateState.hard_reject_preview)
          ? { hard_reject_preview: normalizedCandidateState.hard_reject_preview }
          : {}),
        ...(Array.isArray(normalizedTransportTrace.transport_hops)
          ? { transport_hops: normalizedTransportTrace.transport_hops }
          : {}),
        ...(Number.isFinite(Number(normalizedTransportTrace.transport_hop_count))
          ? { transport_hop_count: Number(normalizedTransportTrace.transport_hop_count) }
          : {}),
        ...(Number.isFinite(Number(normalizedTransportTrace.nested_orchestrator_hops))
          ? { nested_orchestrator_hops: Number(normalizedTransportTrace.nested_orchestrator_hops) }
          : {}),
        ...(normalizedTransportTrace.primary_transport_owner
          ? { primary_transport_owner: normalizedTransportTrace.primary_transport_owner }
          : {}),
        ...(normalizedTransportTrace.primary_endpoint_kind
          ? { primary_endpoint_kind: normalizedTransportTrace.primary_endpoint_kind }
          : {}),
        ...(Array.isArray(normalizedTransportTrace.attempted_internal_base_urls)
          ? {
              attempted_internal_base_urls:
                normalizedTransportTrace.attempted_internal_base_urls,
            }
          : {}),
        ...(Array.isArray(normalizedTransportTrace.attempted_internal_paths)
          ? { attempted_internal_paths: normalizedTransportTrace.attempted_internal_paths }
          : {}),
      },
    };

    let enriched = withSearchDiagnostics(baseResponse, {
      route_health: buildSearchRouteHealth({
        primaryPathUsed: 'beauty_discovery_local_mainline',
        primaryLane: normalizedPlan?.primary_lane || 'beauty_discovery_mainline',
        primaryRetrievalContract:
          normalizedPlan?.primary_retrieval_contract ||
          'agent_v1_search_beauty_mainline',
        primaryLatencyMs: Math.max(
          0,
          Date.now() - Number(invokeStartedAtMs || Date.now()),
        ),
        fallbackTriggered: false,
        fallbackReason: null,
        ownerSwitchCount: Number(normalizedPlan?.owner_switch_count || 0) || 0,
        observerNodes: [],
        ambiguityScorePre: null,
        ambiguityScorePost: null,
        clarifyTriggered: false,
        degradeFlags: [],
      }),
      search_trace: buildSearchTrace({
        traceId: gatewayRequestId,
        rawQuery: queryText,
        expandedQuery: queryText,
        expansionMode: 'beauty_discovery_local_mainline',
        queryClass: traceQueryClass,
        rewriteGate: null,
        associationPlan: null,
        flagsSnapshot: null,
        intent: null,
        cacheStage: null,
        upstreamStage: null,
        resolverStage: null,
        stageLedger: null,
        finalDecision,
      }),
      search_decision: buildDecisionAuthorityPatch({
        body: baseResponse,
        finalDecision,
        primaryPathUsed: 'beauty_discovery_local_mainline',
        decisionAuthority: 'beauty_discovery_local_mainline',
        decisionLocked: true,
        decisionLockReason: 'beauty_discovery_local_mainline',
      }),
    });

    const beautyAuthority = applyInvokeBeautyAuthority({
      enriched,
      existingMeta: enriched.metadata,
      operation,
      invalidHitApplied: false,
      isStrictEmpty: normalizedSelectedProducts.length === 0,
      hasClarification: false,
      beautyMainlineAuthorityActive: true,
      products: normalizedSelectedProducts,
      searchDecision: { final_decision: finalDecision },
      querySource: 'beauty_discovery_local_mainline',
      findProductsExpansionMeta: {
        mode: 'beauty_discovery_local_mainline',
        intent_parse_latency_ms: 0,
        semantic_rewrite_timeout_ms: primaryTimeoutMs,
      },
      effectiveIntent: null,
      decisionObserverNodes: [],
      rawProductsForQualityGate: normalizedRawCandidates,
      primaryPathUsed: 'beauty_discovery_local_mainline',
      semanticContractMeta: semanticContract,
      semanticRewriteResultMeta,
      semanticOwnerControlled: true,
      semanticOwnerQueryAttempts: primaryQueryPackAttempts,
      semanticOwnerDecision: BEAUTY_DISCOVERY_MAINLINE_OWNER,
      primarySearchTimeoutMs: primaryTimeoutMs,
      primarySearchInitialTimeoutMs: primaryTimeoutMs,
      primarySearchFinalTimeoutMs: primaryTimeoutMs,
      primarySearchRetryCount: 0,
      primarySearchRetryReasons: [],
      primaryFailureStage,
      primaryQualityGatePassed: normalizedSelectedProducts.length > 0,
      guidanceDirectSupplementValidHit: false,
      primaryIrrelevant: false,
      primaryMonoculture: false,
      primaryLowQualityNonempty: false,
      semanticRetryApplied: false,
      secondaryFallbackMeta: null,
      secondarySupplementMeta: null,
      skipSecondaryFallback: true,
      normalizedSecondaryFallbackSkipReason: 'beauty_discovery_local_mainline',
      strictBeautyDirectSearch: true,
      findProductsSearchRequestContract: normalizedContract,
      findProductsExecutionPlan: normalizedPlan,
      beautyDecisionOwner: BEAUTY_DISCOVERY_MAINLINE_OWNER,
      beautySemanticOwner: BEAUTY_DISCOVERY_MAINLINE_OWNER,
      semanticOwnerCacheSourceIsolated: false,
      semanticOwnerLastResortCacheApplied: false,
    });

    const supplementTypes = Array.from(
      new Set(
        normalizedSupplementTraces
          .map((trace) => String(trace?.supplement_type || '').trim())
          .filter(Boolean),
      ),
    );
    enriched = applyBeautySearchMetadataAuthority({
      enriched: beautyAuthority.enriched,
      semanticOwnerDecision: BEAUTY_DISCOVERY_MAINLINE_OWNER,
      defaultSelectionOwner: BEAUTY_DISCOVERY_MAINLINE_OWNER,
      fpmGateTrace: [],
      fpmSkippedGatesDueToBudget: [],
      fpmLatencyGuardApplied: false,
      lowConfidenceFlag: beautyAuthority.lowConfidenceFlag,
      normalizedLowConfidenceReasons:
        beautyAuthority.normalizedLowConfidenceReasons,
      semanticContractMeta: semanticContract,
      semanticRewriteResultMeta,
      semanticOwnerQueryAttempts: primaryQueryPackAttempts,
      semanticOwnerExternalRescueQueriesAttempted: [],
      semanticOwnerCacheSourceIsolated: false,
      semanticOwnerLastResortCacheApplied: false,
      searchStageLedger: beautyAuthority.searchStageLedger,
      findProductsExpansionMeta: {
        mode: 'beauty_discovery_local_mainline',
        semantic_rewrite_timeout_ms: primaryTimeoutMs,
      },
      primarySearchTimeoutMs: primaryTimeoutMs,
      primarySearchInitialTimeoutMs: primaryTimeoutMs,
      primarySearchFinalTimeoutMs: primaryTimeoutMs,
      primarySearchRetryCount: 0,
      primarySearchRetryReasons: [],
      primaryFailureStage,
      findProductsSearchRequestContract: normalizedContract,
      findProductsExecutionPlan: normalizedPlan,
      gatewayTotalBudgetMs: null,
      supplementsAttempted: supplementTypes,
      blockingGateInfo: null,
      querySource: 'beauty_discovery_local_mainline',
    });

    const searchExecutionTrace = buildFindProductsSearchExecutionTrace({
      requestContract: normalizedContract,
      executionPlan: normalizedPlan,
      primarySearchInitialTimeoutMs: primaryTimeoutMs,
      primarySearchFinalTimeoutMs: primaryTimeoutMs,
      primarySearchRetryCount: 0,
      primarySearchRetryReasons: [],
      primaryFailureStage,
      supplementsAttempted: supplementTypes,
      transportHops: normalizedTransportTrace.transport_hops,
      primaryTransportOwner: normalizedTransportTrace.primary_transport_owner,
      primaryEndpointKind: normalizedTransportTrace.primary_endpoint_kind,
      attemptedInternalBaseUrls:
        normalizedTransportTrace.attempted_internal_base_urls,
      attemptedInternalPaths: normalizedTransportTrace.attempted_internal_paths,
      nestedOrchestratorHops:
        normalizedTransportTrace.nested_orchestrator_hops,
    });

    return {
      ...enriched,
      metadata: {
        ...(isPlainObject(enriched.metadata) ? enriched.metadata : {}),
        ...(normalizedSupplementTraces.length > 0
          ? { supplement_traces: normalizedSupplementTraces }
          : {}),
        search_execution_trace:
          normalizedSupplementTraces.length > 0
            ? {
                ...searchExecutionTrace,
                supplement_traces: normalizedSupplementTraces,
              }
            : searchExecutionTrace,
        source_observability: sourceObservability,
      },
    };
  }

  function shouldUseLocalBeautyDiscoveryMainline({
    search = null,
    metadata = null,
    requestContract = null,
    rawUserQuery = '',
  } = {}) {
    const searchObj = normalizeSearchObject(search);
    const metadataObj = normalizeSearchObject(metadata);
    const contract = isPlainObject(requestContract) ? requestContract : {};
    if (String(contract.primary_lane || '').trim() !== 'beauty_discovery_mainline') return false;
    const queryText = firstNonEmptyString(rawUserQuery, searchObj.query, searchObj.q);
    if (
      parseBooleanLike(
        searchObj.local_mainline_child ??
          searchObj.localMainlineChild ??
          metadataObj.local_mainline_child ??
          metadataObj.localMainlineChild,
      ) === true
    ) {
      return false;
    }
    if (String(searchObj.merchant_id || searchObj.merchantId || '').trim()) return false;
    if (searchObj.external_seed_only === true) return false;
    const uiSurface = String(
      searchObj.ui_surface || searchObj.uiSurface || metadataObj.ui_surface || '',
    )
      .trim()
      .toLowerCase();
    const decisionMode = String(
      searchObj.decision_mode || searchObj.decisionMode || metadataObj.decision_mode || '',
    )
      .trim()
      .toLowerCase();
    if (
      uiSurface === 'ingredient_plan_guidance_only' ||
      decisionMode === 'guidance_only'
    ) {
      return false;
    }
    const semanticContract =
      isPlainObject(contract.semantic_contract)
        ? contract.semantic_contract
        : buildBeautyDiscoverySemanticContract({
            rawQuery: queryText,
            search: searchObj,
            metadata: metadataObj,
          });
    if (!isPlainObject(semanticContract)) return false;
    const plannerMode = String(semanticContract.planner_mode || '').trim().toLowerCase();
    const requestClass = String(semanticContract.request_class || '').trim().toLowerCase();
    const targetStepFamily = String(semanticContract.target_step_family || '').trim().toLowerCase();
    if (plannerMode === 'step_aware') {
      if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'test') return false;
      return targetStepFamily === 'sunscreen' && requestClass === 'sunscreen';
    }
    return (
      plannerMode === 'framework_generic' &&
      requestClass === 'generic_concern' &&
      String(contract.primary_lane || '').trim() === 'beauty_discovery_mainline' &&
      looksLikeBroadBeautyDiscoveryQuery(queryText)
    );
  }

  async function fetchLocalExternalSeedDirectSupplement({
    queryParams = null,
    checkoutToken = null,
    neededCount = 0,
    source = '',
    timeoutMs = 4800,
  } = {}) {
    if (typeof fetchExternalSeedSupplementFromBackend !== 'function') {
      return {
        products: [],
        metadata: {
          attempted: false,
          applied: false,
          reason: 'external_seed_direct_local_unavailable',
          requested_count: Number(neededCount || 0),
        },
      };
    }
    const externalSeedDirectTimeoutMs = Math.min(
      Math.max(120, Number(timeoutMs || 0) || 4800),
      4800,
    );
    let externalSeedDirectTimer = null;
    const supplementPromise = fetchExternalSeedSupplementFromBackend({
      queryParams,
      checkoutToken,
      neededCount,
      source,
      directOnly: true,
    }).catch((err) => ({
      products: [],
      metadata: {
        attempted: true,
        applied: false,
        reason: 'external_seed_direct_local_error',
        error: err?.message || String(err),
      },
    }));
    const supplement = await Promise.race([
      supplementPromise,
      new Promise((resolve) => {
        externalSeedDirectTimer = setTimeout(() => {
          resolve({
            products: [],
            metadata: {
              attempted: true,
              applied: false,
              reason: 'external_seed_direct_local_timeout',
              timeout_ms: externalSeedDirectTimeoutMs,
              query: firstNonEmptyString(queryParams?.query),
            },
          });
        }, externalSeedDirectTimeoutMs);
      }),
    ]);
    if (externalSeedDirectTimer) clearTimeout(externalSeedDirectTimer);
    return supplement;
  }

  async function runLocalBeautySearchAttempt({
    queryParams = null,
    searchObj = null,
    metadataObj = null,
    semanticContract = null,
    gatewayRequestId = null,
    timeoutMs = 15000,
    logger = null,
    authHeaders = null,
  } = {}) {
    const query = normalizeSearchObject(queryParams);
    const searchState = normalizeSearchObject(searchObj);
    const metadataState = normalizeSearchObject(metadataObj);
    const queryText = firstNonEmptyString(query.query, searchState.query, searchState.q);
    const limit = Math.max(
      1,
      Math.min(12, Number(query.limit || query.page_size || searchState.limit || 6) || 6),
    );
    const offset = Math.max(0, Number(query.offset || 0) || 0);
    const page = Number(query.page || 0) > 0 ? Number(query.page || 0) : Math.floor(offset / limit) + 1;
    const allowExternalSeed =
      parseBooleanLike(query.allow_external_seed ?? query.allowExternalSeed) === true;
    const externalSeedStrategy =
      firstNonEmptyString(
        query.external_seed_strategy,
        query.externalSeedStrategy,
        searchState.external_seed_strategy,
        searchState.externalSeedStrategy,
        'unified_relevance',
      ) || 'unified_relevance';
    if (allowExternalSeed && typeof fetchExternalSeedSupplementFromBackend === 'function') {
      const externalSeedDirectQueryParams = {
        ...query,
        query: queryText,
        limit,
        offset: 0,
        allow_external_seed: true,
        allow_stale_cache: false,
        external_seed_strategy: externalSeedStrategy,
        fast_mode: true,
        ...(firstNonEmptyString(query.target_step_family, query.targetStepFamily)
          ? {
              target_step_family: firstNonEmptyString(
                query.target_step_family,
                query.targetStepFamily,
              ),
            }
          : {}),
        ...(firstNonEmptyString(query.semantic_family, query.semanticFamily)
          ? {
              semantic_family: firstNonEmptyString(
                query.semantic_family,
                query.semanticFamily,
              ),
            }
          : {}),
        ...(firstNonEmptyString(query.query_step_strength, query.queryStepStrength)
          ? {
              query_step_strength: firstNonEmptyString(
                query.query_step_strength,
                query.queryStepStrength,
              ),
            }
          : {}),
        ...(parseBooleanLike(query.product_only ?? query.productOnly) === true
          ? { product_only: true }
          : {}),
      };
      const supplement = await fetchLocalExternalSeedDirectSupplement({
        queryParams: externalSeedDirectQueryParams,
        neededCount: limit,
        source: metadataState?.source || 'aurora-bff',
        timeoutMs,
      });
      const supplementProducts = (Array.isArray(supplement?.products) ? supplement.products : [])
        .map((product) =>
          typeof normalizeRecoCatalogProduct === 'function'
            ? normalizeRecoCatalogProduct(product)
            : product,
        )
        .filter((product) => isPlainObject(product));
      if (supplementProducts.length > 0 || supplement?.metadata?.attempted === true) {
        const bodyInput = {
          status: 'success',
          success: true,
          products: supplementProducts,
          total: supplementProducts.length,
          page,
          page_size: supplementProducts.length,
          reply: null,
          metadata: {
            query_source: 'local_external_seed_direct_child',
            external_seed_direct_child: true,
            external_seed_supplement: supplement?.metadata || null,
            query_target_step_family:
              firstNonEmptyString(query.target_step_family, query.targetStepFamily) || null,
            semantic_family:
              firstNonEmptyString(query.semantic_family, query.semanticFamily) || null,
            query_step_strength:
              firstNonEmptyString(query.query_step_strength, query.queryStepStrength) || null,
          },
        };
        const body =
          typeof normalizeAgentProductsListResponse === 'function'
            ? normalizeAgentProductsListResponse(bodyInput, { limit, offset: 0 })
            : bodyInput;
        return {
          response: {
            status: 200,
            data: body,
          },
          upstreamData: body,
          searchOut: {
            ok: true,
            reason: supplementProducts.length > 0 ? 'external_seed_direct_local_hit' : 'empty',
            actual_http_attempt_count: 0,
            products: supplementProducts,
          },
        };
      }
    }
    let searchOut = null;
    try {
      searchOut = await withWallClockTimeout(
        runInternalSearchPrimitive({
          query: queryText,
          limit,
          logger,
          timeoutMs,
          searchSourceOverride: metadataState?.source || null,
          catalogSurface:
            query.catalog_surface ||
            query.catalogSurface ||
            searchState.catalog_surface ||
            searchState.catalogSurface ||
            metadataState.catalog_surface ||
            'beauty',
          allowExternalSeed:
            allowExternalSeed,
          externalSeedStrategy,
          fastMode:
            parseBooleanLike(query.fast_mode ?? query.fastMode ?? searchState.fast_mode ?? searchState.fastMode) !==
            false,
          transportPolicy: {
            mode: 'local_beauty_mainline',
            include_self_proxy: false,
            prefer_self_proxy_first: false,
            allow_secondary_base_failover: false,
            allow_secondary_path_failover: false,
            max_base_urls: 1,
            max_paths: 1,
          },
          queryStepStrength:
            firstNonEmptyString(query.query_step_strength, query.queryStepStrength) || undefined,
          targetStepFamily:
            firstNonEmptyString(query.target_step_family, query.targetStepFamily) || undefined,
          semanticFamily:
            firstNonEmptyString(query.semantic_family, query.semanticFamily) || undefined,
          productOnly:
            parseBooleanLike(query.product_only ?? query.productOnly ?? searchState.product_only ?? searchState.productOnly) ===
            true,
          semanticContract,
          traceId: gatewayRequestId,
          queryIndex:
            Number.isFinite(Number(query.query_index)) ? Number(query.query_index) : null,
          queryTotal:
            Number.isFinite(Number(query.query_total)) ? Number(query.query_total) : null,
          authHeaders,
          merchantId:
            firstNonEmptyString(
              query.merchant_id,
              query.merchantId,
              searchState.merchant_id,
              searchState.merchantId,
            ) || '',
          merchantIds: Array.isArray(query.merchant_ids ?? query.merchantIds)
            ? (query.merchant_ids ?? query.merchantIds)
            : [],
          offset,
          inStockOnly:
            parseBooleanLike(
              query.in_stock_only ??
                query.inStockOnly ??
                searchState.in_stock_only ??
                searchState.inStockOnly,
            ) !== false,
          callerLane:
            parseBooleanLike(query.local_mainline_child ?? query.localMainlineChild) === true
              ? 'catalog_child_recall'
              : 'beauty_discovery_mainline',
        }),
        timeoutMs,
        'LOCAL_INTERNAL_SEARCH_WALL_CLOCK_TIMEOUT',
      );
    } catch (err) {
      const timeoutTriggered =
        String(err?.code || '').trim() === 'LOCAL_INTERNAL_SEARCH_WALL_CLOCK_TIMEOUT';
      searchOut = buildBoundedPrimitiveFailure({
        reason: timeoutTriggered ? 'upstream_timeout' : 'upstream_error',
        timeoutMs,
        error: err?.message || String(err),
      });
    }
    const failureReason = String(searchOut?.reason || '').trim().toLowerCase();
    if (searchOut?.ok !== true && ['upstream_timeout', 'upstream_error', 'rate_limited'].includes(failureReason)) {
      const err = new Error(
        failureReason === 'upstream_timeout'
          ? 'timeout of local beauty discovery mainline exceeded'
          : failureReason || 'local beauty discovery upstream failed',
      );
      err.code = failureReason === 'upstream_timeout' ? 'ECONNABORTED' : 'ELOCALSEARCH';
      err.searchOut = searchOut;
      throw err;
    }
    const products = (Array.isArray(searchOut?.products) ? searchOut.products : [])
      .map((product) =>
        typeof normalizeRecoCatalogProduct === 'function'
          ? normalizeRecoCatalogProduct(product)
          : product,
      )
      .filter((product) => isPlainObject(product));
    const body = typeof normalizeAgentProductsListResponse === 'function'
      ? normalizeAgentProductsListResponse(
          {
            status: 'success',
            success: true,
            products,
            total: products.length,
            page,
            page_size: products.length,
            reply: null,
          metadata: {
            query_source: 'agent_products_search',
            query_target_step_family:
              firstNonEmptyString(query.target_step_family, query.targetStepFamily) || null,
            semantic_family:
              firstNonEmptyString(query.semantic_family, query.semanticFamily) || null,
            query_step_strength:
              firstNonEmptyString(query.query_step_strength, query.queryStepStrength) || null,
            ...extractTransportMetadataFromSearchOut(searchOut),
          },
        },
          { limit, offset },
        )
      : {
          status: 'success',
          success: true,
          products,
          total: products.length,
          page,
          page_size: products.length,
          reply: null,
          metadata: {
            query_source: 'agent_products_search',
            query_target_step_family:
              firstNonEmptyString(query.target_step_family, query.targetStepFamily) || null,
            semantic_family:
              firstNonEmptyString(query.semantic_family, query.semanticFamily) || null,
            query_step_strength:
              firstNonEmptyString(query.query_step_strength, query.queryStepStrength) || null,
            ...extractTransportMetadataFromSearchOut(searchOut),
          },
        };
    return {
      response: {
        status: 200,
        data: body,
      },
      upstreamData: body,
      searchOut,
    };
  }

  async function runLocalBeautyStepAwareMainline({
    searchObj = null,
    metadataObj = null,
    contract = null,
    plan = null,
    semanticContract = null,
    queryText = '',
    gatewayRequestId = null,
    traceQueryClass = null,
    primaryTimeoutMs = 15000,
    invokeStartedAtMs = 0,
    logger = null,
    authHeaders = null,
    operation = 'find_products_multi',
  } = {}) {
    if (
      typeof buildBeautyDiscoveryQueryPackFromContract !== 'function' ||
      typeof prepareInvokeSemanticOwnerContext !== 'function' ||
      typeof runInvokeSemanticOwnerExecution !== 'function' ||
      typeof runInternalSearchPrimitive !== 'function'
    ) {
      return { handled: false, response: null };
    }
    const normalizedLimit = Math.max(
      1,
      Math.min(12, Number(searchObj.limit || searchObj.page_size || 6) || 6),
    );
    const fullQueryPack = buildBeautyDiscoveryQueryPackFromContract({
      rawQuery: queryText,
      semanticContract,
    });
    const criticalQueryPack = buildStepAwareCriticalQueryPack(fullQueryPack, semanticContract);
    const semanticRewriteResultMeta = {
      owner: BEAUTY_DISCOVERY_MAINLINE_OWNER,
      applied: true,
      mode: 'deterministic_contract',
      llm_enrichment_attempted: false,
      normalized_query_pack: criticalQueryPack,
      full_query_pack: fullQueryPack,
      critical_query_pack: criticalQueryPack,
      critical_query_pack_truncated: criticalQueryPack.length < fullQueryPack.length,
    };
    if (!Array.isArray(semanticRewriteResultMeta.normalized_query_pack) ||
        semanticRewriteResultMeta.normalized_query_pack.length <= 0) {
      return {
        handled: true,
        response: buildLocalBeautyDiscoveryMainlineResponse({
          queryText,
          contract,
          plan,
          traceQueryClass,
          gatewayRequestId,
          invokeStartedAtMs,
          primaryTimeoutMs,
          semanticContract,
          semanticRewriteResultMeta,
          primaryQueryPackAttempts: [],
          selectedProducts: [],
          rawCandidates: [],
          supplementTraces: [],
          primaryFailureStage: 'semantic_query_pack_empty',
          finalDecision: 'strict_empty',
          operation,
        }),
      };
    }
    let queryParams = {
      query: semanticRewriteResultMeta.normalized_query_pack[0],
      query_index: 0,
      query_total: semanticRewriteResultMeta.normalized_query_pack.length,
      limit: normalizedLimit,
      offset: 0,
      allow_external_seed:
        parseBooleanLike(searchObj.allow_external_seed ?? searchObj.allowExternalSeed) !== false,
      allow_stale_cache: false,
      external_seed_strategy: 'unified_relevance',
      target_step_family: semanticContract.target_step_family,
      semantic_family: semanticContract.semantic_family,
      query_step_strength: firstNonEmptyString(
        searchObj.query_step_strength,
        searchObj.queryStepStrength,
        semanticContract.target_step_family === 'sunscreen' ? 'exact_step' : '',
      ),
      semantic_contract: semanticContract,
      product_only:
        parseBooleanLike(searchObj.product_only ?? searchObj.productOnly) === true,
      catalog_surface:
        searchObj.catalog_surface || searchObj.catalogSurface || metadataObj.catalog_surface || 'beauty',
      commerce_surface:
        searchObj.commerce_surface ||
        searchObj.commerceSurface ||
        searchObj.catalog_surface ||
        searchObj.catalogSurface ||
        metadataObj.catalog_surface ||
        'beauty',
      ...(metadataObj?.source ? { source: String(metadataObj.source).trim() } : {}),
    };
    let requestBody = {
      search: {
        ...searchObj,
        query: queryParams.query,
        query_index: 0,
        query_total: semanticRewriteResultMeta.normalized_query_pack.length,
      },
      metadata: metadataObj,
    };
    const localStepAwareStartedAtMs = Date.now();
    const getLocalStepAwareRemainingBudgetMs = () =>
      Math.max(
        0,
        Number(primaryTimeoutMs || 0) -
          Math.max(0, Date.now() - localStepAwareStartedAtMs),
      );
    const clampLocalStepAwareAttemptTimeoutMs = (requestedTimeoutMs) => {
      const requested =
        Number.isFinite(Number(requestedTimeoutMs)) && Number(requestedTimeoutMs) > 0
          ? Number(requestedTimeoutMs)
          : primaryTimeoutMs;
      return Math.min(
        requested,
        clampLocalBeautyRecallAttemptTimeoutMs({
          primaryTimeoutMs,
          remainingBudgetMs: getLocalStepAwareRemainingBudgetMs(),
          queryTotal: semanticRewriteResultMeta.normalized_query_pack.length,
          plannerMode: 'step_aware',
        }),
      );
    };
    const semanticOwnerContext = prepareInvokeSemanticOwnerContext({
      operation,
      semanticOwnerControlled: true,
      strictFindProductsMultiDecision: null,
      metadata: metadataObj,
      traceQueryClass,
      rawUserQuery: queryText,
      semanticRewriteResultMeta,
      semanticContractMeta: semanticContract,
      queryParams,
      effectivePayload: {
        search: searchObj,
        metadata: metadataObj,
      },
    });
    const fetchLocalStepAwareExternalSeedSupplement = async ({
      queryParams: supplementQueryParams = null,
      checkoutToken = null,
      neededCount = normalizedLimit,
      source = metadataObj?.source || 'aurora-bff',
    } = {}) =>
      fetchLocalExternalSeedDirectSupplement({
        queryParams: supplementQueryParams,
        checkoutToken,
        neededCount,
        source,
        timeoutMs: clampLocalStepAwareAttemptTimeoutMs(primaryTimeoutMs),
      });
    let initialSearch;
    let initialSearchErrorAttempt = null;
    try {
      initialSearch = await runLocalBeautySearchAttempt({
        queryParams,
        searchObj,
        metadataObj,
        semanticContract,
        gatewayRequestId,
        timeoutMs: clampLocalStepAwareAttemptTimeoutMs(primaryTimeoutMs),
        logger,
        authHeaders,
      });
    } catch (initialSearchErr) {
      const errMessage = String(initialSearchErr?.message || initialSearchErr || '').trim();
      const isInitialTimeout = /timeout|ECONNABORTED/i.test(
        `${initialSearchErr?.code || ''} ${errMessage}`,
      );
      const canRetryAfterInitialTimeout =
        isInitialTimeout &&
        semanticRewriteResultMeta.normalized_query_pack.length > 1 &&
        getLocalStepAwareRemainingBudgetMs() >= 120;
      if (canRetryAfterInitialTimeout) {
        const emptyBodyInput = {
          status: 'success',
          success: true,
          products: [],
          total: 0,
          page: 1,
          page_size: 0,
          reply: null,
          metadata: {
            query_source: 'beauty_discovery_local_mainline',
            primary_failure_stage: 'primary_upstream_timeout',
            initial_query_error: errMessage,
          },
        };
        const emptyBody =
          typeof normalizeAgentProductsListResponse === 'function'
            ? normalizeAgentProductsListResponse(emptyBodyInput, {
                limit: Number(queryParams.limit || normalizedLimit) || normalizedLimit,
                offset: Number(queryParams.offset || 0) || 0,
              })
            : emptyBodyInput;
        initialSearch = {
          response: {
            status: 200,
            data: emptyBody,
          },
          upstreamData: emptyBody,
          searchOut: null,
        };
        initialSearchErrorAttempt = {
          error: errMessage,
          timeout_error: true,
          ...(Array.isArray(initialSearchErr?.searchOut?.attempted_endpoints)
            ? { attempted_endpoints: initialSearchErr.searchOut.attempted_endpoints }
            : {}),
          ...(Array.isArray(initialSearchErr?.searchOut?.attempted_base_urls)
            ? { attempted_base_urls: initialSearchErr.searchOut.attempted_base_urls }
            : {}),
          ...(Array.isArray(initialSearchErr?.searchOut?.attempted_paths)
            ? { attempted_paths: initialSearchErr.searchOut.attempted_paths }
            : {}),
          ...(initialSearchErr?.searchOut?.source_endpoint
            ? { source_endpoint: String(initialSearchErr.searchOut.source_endpoint) }
            : {}),
          ...(initialSearchErr?.searchOut?.source_base_url
            ? { source_base_url: String(initialSearchErr.searchOut.source_base_url) }
            : {}),
          ...(initialSearchErr?.searchOut?.source_path
            ? { source_path: String(initialSearchErr.searchOut.source_path) }
            : {}),
          ...(Number.isFinite(Number(initialSearchErr?.searchOut?.actual_http_attempt_count))
            ? {
                actual_http_attempt_count:
                  Number(initialSearchErr.searchOut.actual_http_attempt_count),
              }
            : {}),
        };
      } else {
        return {
          handled: true,
          response: buildLocalBeautyDiscoveryMainlineResponse({
            queryText,
            contract,
            plan,
            traceQueryClass,
            gatewayRequestId,
            invokeStartedAtMs,
            primaryTimeoutMs,
            semanticContract,
            semanticRewriteResultMeta,
            primaryQueryPackAttempts: [
              {
                query: String(queryParams.query || '').trim(),
                query_index: 0,
                query_total: semanticRewriteResultMeta.normalized_query_pack.length,
                result_count: 0,
                adopted: false,
                error: errMessage,
              },
            ],
            selectedProducts: [],
            rawCandidates: [],
            supplementTraces: [],
            primaryFailureStage: /timeout|ECONNABORTED/i.test(
              `${initialSearchErr?.code || ''} ${errMessage}`,
            )
              ? 'primary_upstream_timeout'
              : 'primary_upstream_error',
            finalDecision: 'strict_empty',
            operation,
            upstreamMetadata: {
              query_source: 'beauty_discovery_local_mainline',
              local_step_aware_query_pack_full: fullQueryPack,
              local_step_aware_query_pack_critical: criticalQueryPack,
              local_step_aware_query_pack_truncated:
                criticalQueryPack.length < fullQueryPack.length,
            },
            transportTrace: collectLocalTransportTrace({
              rows: [initialSearchErr?.searchOut],
              executionPlan: plan,
            }),
          }),
        };
      }
    }
    let response = initialSearch.response;
    let upstreamData = initialSearch.upstreamData;
    const localBaseUrl = 'http://local-beauty-mainline.test/agent/internal/products/search';
    const localCallTrackedUpstream = async (_op, config = {}) => {
      const parsedQuery = parseLocalUrlQuery(config?.url);
      const localQueryParams = {
        ...parsedQuery,
        ...(isPlainObject(config?.data?.search) ? config.data.search : {}),
      };
      const effectiveTimeoutMs = clampLocalStepAwareAttemptTimeoutMs(config?.timeout);
      if (effectiveTimeoutMs < 120) {
        const err = new Error('local beauty discovery timeout budget exhausted');
        err.code = 'ECONNABORTED';
        throw err;
      }
      const searchAttempt = await runLocalBeautySearchAttempt({
        queryParams: localQueryParams,
        searchObj,
        metadataObj,
        semanticContract,
        gatewayRequestId,
        timeoutMs: effectiveTimeoutMs,
        logger,
        authHeaders,
      });
      return searchAttempt.response;
    };
    const semanticOwnerExecution = await runInvokeSemanticOwnerExecution({
      operation,
      semanticOwnerControlled: true,
      semanticOwnerQueryPack: semanticOwnerContext.semanticOwnerQueryPack,
      semanticOwnerQueryTotal: semanticOwnerContext.semanticOwnerQueryTotal,
      semanticOwnerSupportRoleQueryPack:
        semanticOwnerContext.semanticOwnerSupportRoleQueryPack,
      semanticOwnerTargetStepFamily:
        semanticOwnerContext.semanticOwnerTargetStepFamily,
      semanticOwnerSemanticFamily:
        semanticOwnerContext.semanticOwnerSemanticFamily,
      semanticOwnerQueryStepStrength:
        semanticOwnerContext.semanticOwnerQueryStepStrength,
      semanticOwnerMinQueriesBeforeBudgetGuard:
        semanticOwnerContext.semanticOwnerMinQueriesBeforeBudgetGuard,
      response,
      upstreamData,
      queryParams,
      requestBody,
      axiosConfig: {
        method: 'GET',
        url: `${localBaseUrl}${buildLocalQueryString(queryParams)}`,
        timeout: primaryTimeoutMs,
      },
      strictCommerceFindProductsMulti: false,
      strictBeautyDirectSearch: true,
      routeMethod: 'GET',
      url: localBaseUrl,
      buildQueryString: buildLocalQueryString,
      normalizeUpstreamData: ({ responseBody }) => responseBody,
      callTrackedUpstream: localCallTrackedUpstream,
      buildVariantRequestBody: semanticOwnerContext.buildVariantRequestBody,
      evaluateSemanticOwnerBeautyAdoption:
        semanticOwnerContext.evaluateSemanticOwnerBeautyAdoption,
      describeSemanticOwnerObservationFallback:
        semanticOwnerContext.describeSemanticOwnerObservationFallback,
      buildSemanticOwnerExternalRescueQueryPack:
        semanticOwnerContext.buildSemanticOwnerExternalRescueQueryPack,
      fetchExternalSeedSupplementFromBackend:
        fetchLocalStepAwareExternalSeedSupplement,
      normalizeAgentProductsListResponse,
      checkoutToken: null,
      metadata: metadataObj,
      effectivePayload: {
        search: searchObj,
        metadata: metadataObj,
      },
      getFpmRemainingBudgetMs: () =>
        getLocalStepAwareRemainingBudgetMs(),
      logger,
      rawUserQuery: queryText,
      strictFailCloseOnPrimaryTimeout: true,
    });
    response = semanticOwnerExecution.response;
    upstreamData = semanticOwnerExecution.upstreamData;
    queryParams = semanticOwnerExecution.queryParams;
    requestBody = semanticOwnerExecution.requestBody;
    const selectedProducts = Array.isArray(upstreamData?.products)
      ? upstreamData.products.slice(0, normalizedLimit)
      : [];
    let queryAttempts = Array.isArray(semanticOwnerExecution.semanticOwnerQueryAttempts)
      ? semanticOwnerExecution.semanticOwnerQueryAttempts
      : [];
    if (initialSearchErrorAttempt) {
      queryAttempts = queryAttempts.length > 0
        ? [
            {
              ...queryAttempts[0],
              ...initialSearchErrorAttempt,
            },
            ...queryAttempts.slice(1),
          ]
        : [
            {
              query: String(queryParams.query || '').trim(),
              query_index: 0,
              query_total: semanticRewriteResultMeta.normalized_query_pack.length,
              result_count: 0,
              adopted: false,
              ...initialSearchErrorAttempt,
            },
          ];
    }
    const supplementTraces = Array.isArray(semanticOwnerExecution.semanticOwnerSupplementTraces)
      ? semanticOwnerExecution.semanticOwnerSupplementTraces
      : [];
    const hasTimeoutAttempt = queryAttempts.some((attempt) =>
      /timeout/i.test(String(attempt?.error || '')),
    );
    return {
      handled: true,
      response: buildLocalBeautyDiscoveryMainlineResponse({
        queryText,
        contract,
        plan,
        traceQueryClass,
        gatewayRequestId,
        invokeStartedAtMs,
        primaryTimeoutMs,
        semanticContract,
        semanticRewriteResultMeta,
        primaryQueryPackAttempts: queryAttempts,
        selectedProducts,
        rawCandidates: selectedProducts,
        supplementTraces,
        primaryFailureStage:
          selectedProducts.length > 0
            ? null
            : hasTimeoutAttempt
              ? 'primary_upstream_timeout'
              : 'no_recall_from_planned_sources',
        finalDecision: selectedProducts.length > 0 ? 'products_returned' : 'strict_empty',
        operation,
        upstreamMetadata:
          upstreamData && isPlainObject(upstreamData.metadata) ? upstreamData.metadata : null,
        transportTrace: collectLocalTransportTrace({
          metadata: upstreamData?.metadata,
          executionPlan: plan,
        }),
      }),
    };
  }

  function buildLocalBeautyCatalogChildRecallResponse({
    responseBody = null,
    searchObj = null,
    contract = null,
    plan = null,
    primaryTimeoutMs = 0,
    primaryFailureStage = null,
    transportTrace = null,
  } = {}) {
    const normalizedSearch = normalizeSearchObject(searchObj);
    const normalizedContract = isPlainObject(contract) ? contract : {};
    const normalizedPlan = isPlainObject(plan) ? plan : {};
    const upstreamBody = isPlainObject(responseBody) ? responseBody : {};
    const upstreamMetadata = normalizeSearchObject(upstreamBody.metadata);
    const normalizedTransportTrace = isPlainObject(transportTrace)
      ? transportTrace
      : collectLocalTransportTrace({
          metadata: upstreamMetadata,
          executionPlan: normalizedPlan,
        });
    const normalizedProducts = Array.isArray(upstreamBody.products)
      ? upstreamBody.products.filter((product) => isPlainObject(product))
      : [];
    const limit = Math.max(
      1,
      Math.min(
        12,
        Number(
          normalizedSearch.limit ||
            normalizedSearch.page_size ||
            upstreamBody.page_size ||
            normalizedProducts.length ||
            6,
        ) || 6,
      ),
    );
    const offset = Math.max(0, Number(normalizedSearch.offset || 0) || 0);
    const normalizedBodyInput = {
      status: 'success',
      success: true,
      products: normalizedProducts,
      total: Number.isFinite(Number(upstreamBody.total))
        ? Number(upstreamBody.total)
        : normalizedProducts.length,
      page:
        Number.isFinite(Number(upstreamBody.page)) && Number(upstreamBody.page) > 0
          ? Number(upstreamBody.page)
          : Math.floor(offset / Math.max(1, limit)) + 1,
      page_size:
        Number.isFinite(Number(upstreamBody.page_size)) && Number(upstreamBody.page_size) > 0
          ? Number(upstreamBody.page_size)
          : normalizedProducts.length,
      reply: upstreamBody.reply ?? null,
      metadata: {
        ...upstreamMetadata,
        query_source:
          firstNonEmptyString(upstreamMetadata.query_source, 'catalog_child_recall') ||
          'catalog_child_recall',
        primary_lane:
          firstNonEmptyString(
            upstreamMetadata.primary_lane,
            normalizedPlan.primary_lane,
            normalizedContract.primary_lane,
            'catalog_child_recall',
          ) || 'catalog_child_recall',
        primary_retrieval_contract:
          firstNonEmptyString(
            upstreamMetadata.primary_retrieval_contract,
            normalizedPlan.primary_retrieval_contract,
            normalizedContract.primary_retrieval_contract,
            'agent_v2_catalog_child_recall',
          ) || 'agent_v2_catalog_child_recall',
        ...(Array.isArray(normalizedTransportTrace.transport_hops)
          ? { transport_hops: normalizedTransportTrace.transport_hops }
          : {}),
        ...(Number.isFinite(Number(normalizedTransportTrace.transport_hop_count))
          ? { transport_hop_count: Number(normalizedTransportTrace.transport_hop_count) }
          : {}),
        ...(Number.isFinite(Number(normalizedTransportTrace.nested_orchestrator_hops))
          ? { nested_orchestrator_hops: Number(normalizedTransportTrace.nested_orchestrator_hops) }
          : {}),
        ...(normalizedTransportTrace.primary_transport_owner
          ? { primary_transport_owner: normalizedTransportTrace.primary_transport_owner }
          : {}),
        ...(normalizedTransportTrace.primary_endpoint_kind
          ? { primary_endpoint_kind: normalizedTransportTrace.primary_endpoint_kind }
          : {}),
        ...(Array.isArray(normalizedTransportTrace.attempted_internal_base_urls)
          ? {
              attempted_internal_base_urls:
                normalizedTransportTrace.attempted_internal_base_urls,
            }
          : {}),
        ...(Array.isArray(normalizedTransportTrace.attempted_internal_paths)
          ? { attempted_internal_paths: normalizedTransportTrace.attempted_internal_paths }
          : {}),
      },
    };
    const normalizedBody =
      typeof normalizeAgentProductsListResponse === 'function'
        ? normalizeAgentProductsListResponse(normalizedBodyInput, { limit, offset })
        : normalizedBodyInput;
    const searchExecutionTrace =
      typeof buildFindProductsSearchExecutionTrace === 'function'
        ? buildFindProductsSearchExecutionTrace({
            requestContract: normalizedContract,
            executionPlan: normalizedPlan,
            primarySearchInitialTimeoutMs: primaryTimeoutMs,
            primarySearchFinalTimeoutMs: primaryTimeoutMs,
            primarySearchRetryCount: 0,
            primarySearchRetryReasons: [],
            primaryFailureStage,
            supplementsAttempted: [],
            transportHops: normalizedTransportTrace.transport_hops,
            primaryTransportOwner: normalizedTransportTrace.primary_transport_owner,
            primaryEndpointKind: normalizedTransportTrace.primary_endpoint_kind,
            attemptedInternalBaseUrls:
              normalizedTransportTrace.attempted_internal_base_urls,
            attemptedInternalPaths:
              normalizedTransportTrace.attempted_internal_paths,
            nestedOrchestratorHops:
              normalizedTransportTrace.nested_orchestrator_hops,
          })
        : null;
    return {
      ...normalizedBody,
      metadata: {
        ...(normalizedBody.metadata && isPlainObject(normalizedBody.metadata)
          ? normalizedBody.metadata
          : {}),
        ...(searchExecutionTrace ? { search_execution_trace: searchExecutionTrace } : {}),
      },
    };
  }

  async function runLocalBeautyCatalogChildRecall({
    search = null,
    metadata = null,
    requestContract = null,
    executionPlan = null,
    rawUserQuery = '',
    timeoutMs = null,
    logger = null,
    authHeaders = null,
  } = {}) {
    if (
      typeof runInternalSearchPrimitive !== 'function' ||
      typeof normalizeAgentProductsListResponse !== 'function'
    ) {
      return { handled: false, response: null };
    }
    const searchObj = normalizeSearchObject(search);
    const metadataObj = normalizeSearchObject(metadata);
    const contract = isPlainObject(requestContract) ? requestContract : {};
    const plan = isPlainObject(executionPlan) ? executionPlan : {};
    if (String(contract.primary_lane || '').trim() !== 'catalog_child_recall') {
      return { handled: false, response: null };
    }
    const queryText = firstNonEmptyString(rawUserQuery, searchObj.query, searchObj.q);
    if (!queryText) {
      return {
        handled: true,
        response: buildLocalBeautyCatalogChildRecallResponse({
          responseBody: {
            products: [],
            total: 0,
            page: 1,
            page_size: 0,
            reply: null,
            metadata: {
              query_source: 'catalog_child_recall',
            },
          },
          searchObj,
          contract,
          plan,
          primaryTimeoutMs:
            Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
              ? Number(timeoutMs)
              : 0,
          primaryFailureStage: 'query_missing',
          transportTrace: collectLocalTransportTrace({
            executionPlan: plan,
          }),
        }),
      };
    }
    const primaryTimeoutMs =
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000;
    const semanticContract = isPlainObject(contract.semantic_contract)
      ? contract.semantic_contract
      : isPlainObject(searchObj.semantic_contract)
        ? searchObj.semantic_contract
        : null;
    const queryParams = {
      query: queryText,
      limit: Math.max(
        1,
        Math.min(12, Number(searchObj.limit || searchObj.page_size || 6) || 6),
      ),
      offset: Math.max(0, Number(searchObj.offset || 0) || 0),
      ...(parseBooleanLike(searchObj.allow_external_seed ?? searchObj.allowExternalSeed) !== undefined
        ? {
            allow_external_seed:
              parseBooleanLike(searchObj.allow_external_seed ?? searchObj.allowExternalSeed) ===
              true,
          }
        : {}),
      ...(firstNonEmptyString(
        searchObj.external_seed_strategy,
        searchObj.externalSeedStrategy,
      )
        ? {
            external_seed_strategy: firstNonEmptyString(
              searchObj.external_seed_strategy,
              searchObj.externalSeedStrategy,
            ),
          }
        : {}),
      ...(firstNonEmptyString(searchObj.target_step_family, searchObj.targetStepFamily)
        ? {
            target_step_family: firstNonEmptyString(
              searchObj.target_step_family,
              searchObj.targetStepFamily,
            ),
          }
        : {}),
      ...(firstNonEmptyString(searchObj.semantic_family, searchObj.semanticFamily)
        ? {
            semantic_family: firstNonEmptyString(
              searchObj.semantic_family,
              searchObj.semanticFamily,
            ),
          }
        : {}),
      ...(firstNonEmptyString(searchObj.query_step_strength, searchObj.queryStepStrength)
        ? {
            query_step_strength: firstNonEmptyString(
              searchObj.query_step_strength,
              searchObj.queryStepStrength,
            ),
          }
        : {}),
      ...(parseBooleanLike(searchObj.product_only ?? searchObj.productOnly) === true
        ? { product_only: true }
        : {}),
      ...(semanticContract ? { semantic_contract: semanticContract } : {}),
      catalog_surface:
        searchObj.catalog_surface ||
        searchObj.catalogSurface ||
        metadataObj.catalog_surface ||
        'beauty',
      commerce_surface:
        searchObj.commerce_surface ||
        searchObj.commerceSurface ||
        searchObj.catalog_surface ||
        searchObj.catalogSurface ||
        metadataObj.catalog_surface ||
        'beauty',
      local_mainline_child: true,
    };
    try {
      const childSearch = await runLocalBeautySearchAttempt({
        queryParams,
        searchObj,
        metadataObj,
        semanticContract,
        timeoutMs: primaryTimeoutMs,
        logger,
        authHeaders,
      });
      const primaryFailureStage =
        Array.isArray(childSearch?.upstreamData?.products) &&
        childSearch.upstreamData.products.length > 0
          ? null
          : mapLocalSearchReasonToPrimaryFailureStage(childSearch?.searchOut?.reason);
      return {
        handled: true,
        response: buildLocalBeautyCatalogChildRecallResponse({
          responseBody:
            childSearch?.upstreamData && isPlainObject(childSearch.upstreamData)
              ? childSearch.upstreamData
              : childSearch?.response?.data,
          searchObj,
          contract,
          plan,
          primaryTimeoutMs,
          primaryFailureStage,
          transportTrace: collectLocalTransportTrace({
            metadata: childSearch?.upstreamData?.metadata,
            rows: [childSearch?.searchOut],
            executionPlan: plan,
          }),
        }),
      };
    } catch (err) {
      const errText = `${err?.code || ''} ${err?.message || String(err)}`;
      return {
        handled: true,
        response: buildLocalBeautyCatalogChildRecallResponse({
          responseBody: {
            products: [],
            total: 0,
            page: 1,
            page_size: 0,
            reply: null,
            metadata: {
              query_source: 'catalog_child_recall',
              upstream_error_code: err?.code || null,
              upstream_error_message: err?.message || String(err),
              ...extractTransportMetadataFromSearchOut(err?.searchOut),
            },
          },
          searchObj,
          contract,
          plan,
          primaryTimeoutMs,
          primaryFailureStage: /timeout|ECONNABORTED/i.test(errText)
            ? 'primary_upstream_timeout'
            : 'primary_upstream_error',
          transportTrace: collectLocalTransportTrace({
            rows: [err?.searchOut],
            executionPlan: plan,
          }),
        }),
      };
    }
  }

  async function runLocalBeautyDiscoveryMainline({
    search = null,
    metadata = null,
    requestContract = null,
    executionPlan = null,
    rawUserQuery = '',
    gatewayRequestId = null,
    traceQueryClass = null,
    timeoutMs = null,
    invokeStartedAtMs = 0,
    logger = null,
    authHeaders = null,
    operation = 'find_products_multi',
  } = {}) {
    if (
      typeof buildBeautyDiscoverySemanticContract !== 'function' ||
      typeof buildConcernSemanticPlanFallback !== 'function' ||
      typeof buildConcernTargetContextFromSemanticPlan !== 'function' ||
      typeof buildRecoRecallPlan !== 'function' ||
      typeof buildRecoSearchSemanticContract !== 'function' ||
      typeof shouldRunRecoRecallStage !== 'function' ||
      typeof buildRecoRecallTransportPolicy !== 'function' ||
      typeof resolveRecoRecallTransportModeForPlannerMode !== 'function' ||
      typeof runInternalSearchPrimitive !== 'function' ||
      typeof normalizeRecoCatalogProduct !== 'function' ||
      typeof finalizeConcernFrameworkCandidatePools !== 'function' ||
      typeof countCandidateOriginBreakdown !== 'function' ||
      typeof withSearchDiagnostics !== 'function' ||
      typeof buildSearchRouteHealth !== 'function' ||
      typeof buildSearchTrace !== 'function' ||
      typeof buildDecisionAuthorityPatch !== 'function' ||
      typeof applyInvokeBeautyAuthority !== 'function' ||
      typeof applyBeautySearchMetadataAuthority !== 'function' ||
      typeof buildFindProductsSearchExecutionTrace !== 'function'
    ) {
      return { handled: false, response: null };
    }
    const searchObj = normalizeSearchObject(search);
    const metadataObj = normalizeSearchObject(metadata);
    const contract = isPlainObject(requestContract) ? requestContract : {};
    const plan = isPlainObject(executionPlan) ? executionPlan : {};
    const queryText = firstNonEmptyString(rawUserQuery, searchObj.query, searchObj.q);
    const semanticContract =
      isPlainObject(contract.semantic_contract)
        ? contract.semantic_contract
        : buildBeautyDiscoverySemanticContract({
            rawQuery: queryText,
            search: searchObj,
            metadata: metadataObj,
          });
    if (!isPlainObject(semanticContract)) {
      return {
        handled: true,
        response: buildLocalBeautyDiscoveryMainlineResponse({
          queryText,
          contract,
          plan,
          traceQueryClass,
          gatewayRequestId,
          invokeStartedAtMs,
          primaryTimeoutMs:
            Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
              ? Number(timeoutMs)
              : 15000,
          semanticContract: null,
          semanticRewriteResultMeta: {
            owner: BEAUTY_DISCOVERY_MAINLINE_OWNER,
            applied: false,
            mode: 'deterministic_contract',
            llm_enrichment_attempted: false,
            normalized_query_pack: [],
          },
          primaryQueryPackAttempts: [],
          selectedProducts: [],
          rawCandidates: [],
          supplementTraces: [],
          primaryFailureStage: 'semantic_contract_unavailable',
          finalDecision: 'strict_empty',
          operation,
        }),
      };
    }
    if (String(semanticContract?.planner_mode || '').trim().toLowerCase() === 'step_aware') {
      return runLocalBeautyStepAwareMainline({
        searchObj,
        metadataObj,
        contract,
        plan,
        semanticContract,
        queryText,
        gatewayRequestId,
        traceQueryClass,
        primaryTimeoutMs:
          Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
            ? Number(timeoutMs)
            : 15000,
        invokeStartedAtMs,
        logger,
        authHeaders,
        operation,
      });
    }

    const semanticPlan = buildConcernSemanticPlanFallback({
      text: queryText,
      focus: '',
    });
    const targetContext = buildConcernTargetContextFromSemanticPlan(semanticPlan, {
      text: queryText,
      entryType: 'search',
    });
    const recallPlan = buildRecoRecallPlan({
      mode: 'framework_generic',
      targetContext,
    });
    const recallEntries = Array.isArray(recallPlan?.entries) ? recallPlan.entries : [];
    const primaryQueryPackAttempts = buildPrimaryQueryPackAttempts(recallPlan);
    const semanticRewriteResultMeta = {
      owner: BEAUTY_DISCOVERY_MAINLINE_OWNER,
      applied: true,
      mode: 'deterministic_contract',
      llm_enrichment_attempted: false,
      normalized_query_pack: primaryQueryPackAttempts.map((entry) => entry.query),
    };
    const stagedSemanticContract = buildRecoSearchSemanticContract({
      mode: 'framework_generic',
      targetContext,
    });
    const normalizedLimit = Math.max(
      1,
      Math.min(12, Number(searchObj.limit || searchObj.page_size || 6) || 6),
    );
    const requestedPage = Math.max(1, Number(searchObj.page || 1) || 1);
    const primaryTimeoutMs =
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs)
        : 15000;
    if (!recallEntries.length) {
      return {
        handled: true,
        response: buildLocalBeautyDiscoveryMainlineResponse({
          queryText,
          contract,
          plan,
          traceQueryClass,
          gatewayRequestId,
          invokeStartedAtMs,
          primaryTimeoutMs,
          semanticContract,
          semanticRewriteResultMeta,
          primaryQueryPackAttempts,
          selectedProducts: [],
          rawCandidates: [],
          supplementTraces: [],
          primaryFailureStage: 'recall_plan_empty',
          finalDecision: 'strict_empty',
          operation,
        }),
      };
    }
    const transportPolicy = {
      ...buildRecoRecallTransportPolicy({
        mode: resolveRecoRecallTransportModeForPlannerMode(recallPlan?.mode),
      }),
      include_self_proxy: false,
      prefer_self_proxy_first: false,
    };

    let candidateState = finalizeConcernFrameworkCandidatePools([], {
      targetContext,
    });
    const rawCandidates = [];
    const searchResults = [];
    const stageResults = [];
    const supplementTraces = [];
    let queryCursor = 0;
    let frameworkBudgetExhausted = false;
    const localFrameworkStartedAtMs = Date.now();
    const getLocalFrameworkRemainingBudgetMs = () =>
      Math.max(
        0,
        primaryTimeoutMs - Math.max(0, Date.now() - localFrameworkStartedAtMs),
      );
    for (const stage of Array.isArray(recallPlan?.stages) ? recallPlan.stages : []) {
      const selectedProductIdsBefore = getSelectedProductIds(
        candidateState?.selected_recommendations,
      );
      const primaryProductIdBefore = selectedProductIdsBefore[0] || null;
      const runDecision = shouldRunRecoRecallStage(stage, {
        stageResults,
        candidateState,
      });
      const stageId = String(stage?.stage_id || '').trim() || null;
      const stageEntries = (Array.isArray(stage?.entries) ? stage.entries : []).map((entry) => ({
        ...entry,
        query_index:
          Number.isFinite(Number(entry?.query_index))
            ? Number(entry.query_index)
            : queryCursor,
      }));
      if (!runDecision.run) {
        stageResults.push({
          stage_id: stageId,
          role_id: String(stage?.role_id || '').trim() || null,
          role_rank:
            Number.isFinite(Number(stage?.role_rank)) ? Number(stage.role_rank) : null,
          source_scope:
            String(stage?.source_scope || 'internal').trim().toLowerCase() || 'internal',
          skipped: true,
          skip_reason: runDecision.reason,
          executed_query_count: 0,
          timeout_count: 0,
          selected_count: selectedProductIdsBefore.length,
          primary_role_matched: Boolean(candidateState?.primary_role_matched),
        });
        const skippedTrace = buildSupplementTrace({
          stageId,
          queryEntries: stageEntries,
          selectedProductIdsBefore,
          selectedProductIdsAfter: selectedProductIdsBefore,
          primaryProductIdBefore,
          primaryProductIdAfter: primaryProductIdBefore,
          skipped: true,
          skipReason: runDecision.reason,
        });
        if (skippedTrace) supplementTraces.push(skippedTrace);
        continue;
      }

      let timeoutCount = 0;
      let actualHttpAttemptCount = 0;
      let executedQueryCount = 0;
      let stageBudgetExhausted = false;
      for (const entry of stageEntries) {
        const sourceScope = String(entry?.source_scope || 'internal')
          .trim()
          .toLowerCase();
        const preferredStep =
          String(entry?.preferred_step || normalizeRoleStep(entry?.role_id)).trim() ||
          null;
        const isPrimaryInternalAnchor =
          stageId === 'framework_stage_a_primary_internal' &&
          sourceScope === 'internal' &&
          Number.isFinite(Number(entry?.query_index)) &&
          Number(entry.query_index) === 0;
        const effectiveTimeoutMs = clampLocalBeautyRecallAttemptTimeoutMs({
          primaryTimeoutMs,
          remainingBudgetMs: getLocalFrameworkRemainingBudgetMs(),
          queryTotal: recallEntries.length,
          sourceScope,
          plannerMode: 'framework_generic',
          isPrimaryInternalAnchor,
        });
        if (effectiveTimeoutMs < 120) {
          timeoutCount += 1;
          frameworkBudgetExhausted = true;
          stageBudgetExhausted = true;
          searchResults.push({
            stage_id: stageId,
            planner_mode: 'framework_generic',
            query: String(entry?.query || '').trim(),
            preferred_step: preferredStep || null,
            role_id: String(entry?.role_id || '').trim() || null,
            role_rank:
              Number.isFinite(Number(entry?.role_rank)) ? Number(entry.role_rank) : null,
            source_scope: sourceScope,
            ok: false,
            reason: 'upstream_timeout',
            products: [],
            attempt_timeout_ms: effectiveTimeoutMs,
            skipped_reason: 'budget_guard',
            error: 'local beauty discovery timeout budget exhausted',
          });
          queryCursor += 1;
          break;
        }
        const attemptStartedAtMs = Date.now();
        let out;
        if (sourceScope === 'external_seed') {
          const supplement = await fetchLocalExternalSeedDirectSupplement({
            queryParams: {
              query: entry?.query,
              limit: normalizedLimit,
              offset: 0,
              allow_external_seed: true,
              allow_stale_cache: false,
              external_seed_strategy: 'stage_planned',
              fast_mode: true,
              query_step_strength:
                Number(entry?.role_rank || 99) <= 1
                  ? 'strong_goal_family'
                  : 'supportive_family',
              target_step_family: preferredStep,
              semantic_family:
                String(semanticContract.semantic_family || entry?.role_id || '').trim() ||
                undefined,
              product_only: true,
            },
            neededCount: normalizedLimit,
            source: metadataObj?.source || 'aurora-bff',
            timeoutMs: effectiveTimeoutMs,
          });
          const supplementProducts = (Array.isArray(supplement?.products) ? supplement.products : [])
            .map((product) =>
              typeof normalizeRecoCatalogProduct === 'function'
                ? normalizeRecoCatalogProduct(product)
                : product,
            )
            .filter((product) => isPlainObject(product));
          const supplementReason = String(supplement?.metadata?.reason || '')
            .trim()
            .toLowerCase();
          const mappedReason =
            supplementProducts.length > 0
              ? 'ok'
              : supplementReason === 'external_seed_direct_local_timeout'
                ? 'upstream_timeout'
                : supplementReason === 'external_seed_direct_local_error'
                  ? 'upstream_error'
                  : 'empty';
          out = {
            ok: mappedReason !== 'upstream_timeout' && mappedReason !== 'upstream_error',
            reason: mappedReason === 'ok' ? 'ok' : mappedReason,
            actual_http_attempt_count: 0,
            products: supplementProducts,
            source_base_url: 'local_external_seed_direct',
            source_endpoint: 'local_external_seed_direct',
            source_path: null,
            external_seed_supplement: supplement?.metadata || null,
            ...(supplement?.metadata?.error
              ? { error: String(supplement.metadata.error) }
              : {}),
          };
        } else {
          try {
            out = await withWallClockTimeout(
              runInternalSearchPrimitive({
                query: entry?.query,
                limit: normalizedLimit,
                logger,
                timeoutMs: effectiveTimeoutMs,
                searchSourceOverride: metadataObj?.source || null,
                catalogSurface:
                  searchObj.catalog_surface ||
                  searchObj.catalogSurface ||
                  metadataObj.catalog_surface ||
                  'beauty',
                allowExternalSeed: false,
                externalSeedStrategy: 'on_empty_only',
                fastMode: true,
                transportPolicy,
                queryStepStrength:
                  Number(entry?.role_rank || 99) <= 1
                    ? 'strong_goal_family'
                    : 'supportive_family',
                targetStepFamily: preferredStep,
                semanticFamily:
                  String(semanticContract.semantic_family || entry?.role_id || '').trim() ||
                  undefined,
                productOnly: true,
                semanticContract: stagedSemanticContract,
                traceId: gatewayRequestId,
                queryIndex: queryCursor,
                queryTotal: recallEntries.length,
                authHeaders,
                offset: 0,
                inStockOnly: true,
                callerLane: 'beauty_discovery_mainline',
              }),
              effectiveTimeoutMs,
              'LOCAL_FRAMEWORK_INTERNAL_SEARCH_WALL_CLOCK_TIMEOUT',
            );
          } catch (err) {
            const timeoutTriggered =
              String(err?.code || '').trim() === 'LOCAL_FRAMEWORK_INTERNAL_SEARCH_WALL_CLOCK_TIMEOUT';
            out = buildBoundedPrimitiveFailure({
              reason: timeoutTriggered ? 'upstream_timeout' : 'upstream_error',
              timeoutMs: effectiveTimeoutMs,
              error: err?.message || String(err),
            });
          }
        }
        const attemptElapsedMs = Math.max(0, Date.now() - attemptStartedAtMs);
        queryCursor += 1;
        executedQueryCount += 1;
        actualHttpAttemptCount += Number(out?.actual_http_attempt_count || 0) || 0;
        if (String(out?.reason || '').trim().toLowerCase() === 'upstream_timeout') {
          timeoutCount += 1;
          stageBudgetExhausted = true;
          frameworkBudgetExhausted = true;
        }
        searchResults.push({
          stage_id: stageId,
          planner_mode: 'framework_generic',
          query: String(entry?.query || '').trim(),
          preferred_step: preferredStep || null,
          role_id: String(entry?.role_id || '').trim() || null,
          role_rank:
            Number.isFinite(Number(entry?.role_rank)) ? Number(entry.role_rank) : null,
          source_scope: sourceScope,
          attempt_timeout_ms: effectiveTimeoutMs,
          attempt_elapsed_ms: attemptElapsedMs,
          ...out,
        });
        for (const product of Array.isArray(out?.products) ? out.products : []) {
          const normalized = normalizeRecoCatalogProduct(product);
          if (!isPlainObject(normalized)) continue;
          rawCandidates.push({
            ...normalized,
            retrieval_query: String(entry?.query || '').trim(),
            retrieval_step: preferredStep || null,
            retrieval_slot: preferredStep === 'sunscreen' ? 'am' : 'other',
            retrieval_ladder_level: stageId,
            retrieval_role_id: String(entry?.role_id || '').trim() || null,
            retrieval_role_rank:
              Number.isFinite(Number(entry?.role_rank))
              ? Number(entry.role_rank)
              : null,
          });
        }
        if (stageBudgetExhausted) break;
      }

      candidateState = finalizeConcernFrameworkCandidatePools(rawCandidates, {
        targetContext,
      });
      const selectedProductIdsAfter = getSelectedProductIds(
        candidateState?.selected_recommendations,
      );
      const primaryProductIdAfter = selectedProductIdsAfter[0] || null;
      stageResults.push({
        stage_id: stageId,
        role_id: String(stage?.role_id || '').trim() || null,
        role_rank:
          Number.isFinite(Number(stage?.role_rank)) ? Number(stage.role_rank) : null,
        source_scope:
          String(stage?.source_scope || 'internal').trim().toLowerCase() || 'internal',
        skipped: false,
        skip_reason: null,
        executed_query_count: executedQueryCount,
        actual_http_attempt_count: actualHttpAttemptCount,
        timeout_count: timeoutCount,
        selected_count: selectedProductIdsAfter.length,
        primary_role_matched: Boolean(candidateState?.primary_role_matched),
      });
      const stageTrace = buildSupplementTrace({
        stageId,
        queryEntries: stageEntries,
        selectedProductIdsBefore,
        selectedProductIdsAfter,
        primaryProductIdBefore,
        primaryProductIdAfter,
        timeoutCount,
      });
      if (stageTrace) supplementTraces.push(stageTrace);
      if (frameworkBudgetExhausted) break;
    }

    const selectedProducts = Array.isArray(candidateState?.selected_recommendations)
      ? candidateState.selected_recommendations.slice(0, normalizedLimit)
      : [];
    const selectedProductIdSet = new Set(
      selectedProducts
        .map((product) => String(product?.product_id || product?.id || '').trim())
        .filter(Boolean),
    );
    const executedPrimaryQueryPackAttempts = searchResults.length > 0
      ? searchResults.map((row, index) => {
          const products = Array.isArray(row?.products) ? row.products : [];
          const adopted = products.some((product) =>
            selectedProductIdSet.has(String(product?.product_id || product?.id || '').trim()),
          );
          return {
            query: String(row?.query || '').trim(),
            query_index:
              Number.isFinite(Number(row?.query_index)) ? Number(row.query_index) : index,
            query_total: recallEntries.length,
            ladder_level: String(row?.stage_id || '').trim() || null,
            role_id: String(row?.role_id || '').trim() || null,
            role_rank:
              Number.isFinite(Number(row?.role_rank)) ? Number(row.role_rank) : null,
            source_scope: String(row?.source_scope || '').trim() || null,
            preferred_step: String(row?.preferred_step || '').trim() || null,
            result_count: products.length,
            adopted,
            ...(Number.isFinite(Number(row?.attempt_timeout_ms))
              ? { attempt_timeout_ms: Number(row.attempt_timeout_ms) }
              : {}),
            ...(Number.isFinite(Number(row?.attempt_elapsed_ms))
              ? { attempt_elapsed_ms: Number(row.attempt_elapsed_ms) }
              : {}),
            ...(Array.isArray(row?.attempted_endpoints)
              ? { attempted_endpoints: row.attempted_endpoints }
              : {}),
            ...(Array.isArray(row?.attempted_base_urls)
              ? { attempted_base_urls: row.attempted_base_urls }
              : {}),
            ...(Array.isArray(row?.attempted_paths)
              ? { attempted_paths: row.attempted_paths }
              : {}),
            ...(Array.isArray(row?.attempted_internal_base_urls)
              ? { attempted_internal_base_urls: row.attempted_internal_base_urls }
              : {}),
            ...(Array.isArray(row?.attempted_internal_paths)
              ? { attempted_internal_paths: row.attempted_internal_paths }
              : {}),
            ...(Array.isArray(row?.transport_hops)
              ? { transport_hops: row.transport_hops }
              : {}),
            ...(Number.isFinite(Number(row?.transport_hop_count))
              ? { transport_hop_count: Number(row.transport_hop_count) }
              : {}),
            ...(Number.isFinite(Number(row?.nested_orchestrator_hops))
              ? { nested_orchestrator_hops: Number(row.nested_orchestrator_hops) }
              : {}),
            ...(row?.primary_transport_owner
              ? { primary_transport_owner: String(row.primary_transport_owner) }
              : {}),
            ...(row?.primary_endpoint_kind
              ? { primary_endpoint_kind: String(row.primary_endpoint_kind) }
              : {}),
            ...(row?.source_endpoint ? { source_endpoint: String(row.source_endpoint) } : {}),
            ...(row?.source_base_url ? { source_base_url: String(row.source_base_url) } : {}),
            ...(row?.source_path ? { source_path: String(row.source_path) } : {}),
            ...(Number.isFinite(Number(row?.actual_http_attempt_count))
              ? { actual_http_attempt_count: Number(row.actual_http_attempt_count) }
              : {}),
            ...(row?.reason ? { reason: String(row.reason) } : {}),
            ...(Number.isFinite(Number(row?.status_code))
              ? { status_code: Number(row.status_code) }
              : {}),
            ...(row?.upstream_error_code
              ? { upstream_error_code: String(row.upstream_error_code) }
              : {}),
            ...(row?.upstream_error_message
              ? { upstream_error_message: String(row.upstream_error_message) }
              : {}),
            ...(row?.upstream_failure_stage
              ? { upstream_failure_stage: String(row.upstream_failure_stage) }
              : {}),
            ...(row?.upstream_internal_error_code
              ? { upstream_internal_error_code: String(row.upstream_internal_error_code) }
              : {}),
            ...(row?.error ? { error: String(row.error) } : {}),
            ...(row?.skipped_reason ? { skipped_reason: String(row.skipped_reason) } : {}),
          };
        })
      : primaryQueryPackAttempts;
    const sourceObservability = countCandidateOriginBreakdown(
      selectedProducts.length > 0 ? selectedProducts : rawCandidates,
    );
    const primaryInternalTimeout = hasFrameworkPrimaryStageTimeout(searchResults);
    const primaryInternalRecall = hasFrameworkPrimaryStageRecall(searchResults);
    const primaryFailureStage =
      selectedProducts.length > 0
        ? null
        : primaryInternalTimeout && !primaryInternalRecall
          ? 'primary_upstream_timeout'
          : 'no_recall_from_planned_sources';
    const finalDecision =
      selectedProducts.length > 0 ? 'products_returned' : 'strict_empty';
    return {
      handled: true,
      response: buildLocalBeautyDiscoveryMainlineResponse({
        queryText,
        contract,
        plan,
        traceQueryClass,
        gatewayRequestId,
        invokeStartedAtMs,
        primaryTimeoutMs,
        semanticContract,
        semanticRewriteResultMeta,
        primaryQueryPackAttempts: executedPrimaryQueryPackAttempts,
        selectedProducts,
        rawCandidates,
        supplementTraces,
        primaryFailureStage,
        finalDecision,
        operation,
        transportTrace: collectLocalTransportTrace({
          rows: searchResults,
          executionPlan: plan,
        }),
        candidateState,
      }),
    };
  }

  return {
    runLocalBeautyCatalogChildRecall,
    shouldUseLocalBeautyDiscoveryMainline,
    runLocalBeautyDiscoveryMainline,
  };
}

module.exports = {
  createFindProductsBeautyDiscoveryLocalMainlineRuntime,
};
