const { randomUUID } = require('crypto');
const {
  detectAuroraExternalSeedMonoculture: detectAuroraExternalSeedMonocultureBase,
  withStageBudget: withStageBudgetBase,
  shouldFallbackProxySearch: shouldFallbackProxySearchBase,
  getFallbackAdoptUsableThreshold: getFallbackAdoptUsableThresholdBase,
  shouldBypassSecondaryFallbackSkipOnPrimaryException:
    shouldBypassSecondaryFallbackSkipOnPrimaryExceptionBase,
} = require('./catalog/searchFallbackRuntime');

function createProxyAgentSearchToBackend({
  axiosClient,
  logger = {},
  config = {},
  helpers = {},
} = {}) {
  const axios = axiosClient;
  const log = {
    warn: typeof logger?.warn === 'function' ? logger.warn.bind(logger) : () => {},
  };
  const {
    PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS,
    PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS,
    SEARCH_STRICT_EMPTY_ENABLED,
    PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
    PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED,
    PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA,
    PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
    FIND_PRODUCTS_MULTI_RESOLVER_STAGE_BUDGET_MS,
    PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS,
    PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS,
    PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED,
    PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY,
    PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_FORCE_TWO_PASS,
    PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE,
    SEARCH_EXTERNAL_HARD_RULE_PRUNE,
  } = config;

  const {
    firstQueryParamValue,
    getProxySearchApiBase,
    normalizeSearchQueryParams,
    getAuroraFallbackOverrides,
    applyShoppingCatalogQueryGuards,
    createRequestId,
    extractSearchAnchorTokens,
    isLookupStyleSearchQuery,
    isStrongResolverFirstQuery,
    withSearchDiagnostics,
    buildSearchRouteHealth,
    isExternalSeedProduct,
    buildSearchTrace,
    normalizeAgentSource,
    isAuroraSource,
    withStageBudget,
    queryResolveSearchFallback,
    getUpstreamTimeoutMs,
    shouldReducePrimaryTimeoutAfterResolverMiss,
    detectBrandEntities,
    getSecondaryFallbackSkipReason,
    shouldAllowSecondaryFallback,
    shouldAllowResolverFallback,
    buildInvokeUpstreamAuthHeaders,
    normalizeAgentProductsListResponse,
    parseQueryNumber,
    countUsableSearchProducts,
    shouldFallbackProxySearch,
    isProxySearchFallbackRelevant,
    evaluateCacheQualityGate,
    computePrimaryQualityScore,
    detectAuroraExternalSeedMonoculture,
    recordAuroraCompPass2Invoked,
    recordAuroraCompPass2Timeout,
    getFallbackAdoptUsableThreshold,
    queryFindProductsMultiFallback,
    hasFragranceQuerySignal,
    buildProxySearchSoftFallbackResponse,
    withStrictEmptyFallback,
    withProxySearchFallbackMetadata,
    shouldBypassSecondaryFallbackSkipOnPrimaryException,
    extractUpstreamErrorCode,
  } = helpers;
  const withStageBudgetImpl =
    typeof withStageBudget === 'function' ? withStageBudget : withStageBudgetBase;
  const shouldFallbackProxySearchImpl =
    typeof shouldFallbackProxySearch === 'function'
      ? shouldFallbackProxySearch
      : shouldFallbackProxySearchBase;
  const detectAuroraExternalSeedMonocultureImpl =
    typeof detectAuroraExternalSeedMonoculture === 'function'
      ? detectAuroraExternalSeedMonoculture
      : detectAuroraExternalSeedMonocultureBase;
  const getFallbackAdoptUsableThresholdImpl =
    typeof getFallbackAdoptUsableThreshold === 'function'
      ? getFallbackAdoptUsableThreshold
      : getFallbackAdoptUsableThresholdBase;
  const shouldBypassSecondaryFallbackSkipOnPrimaryExceptionImpl =
    typeof shouldBypassSecondaryFallbackSkipOnPrimaryException === 'function'
      ? shouldBypassSecondaryFallbackSkipOnPrimaryException
      : shouldBypassSecondaryFallbackSkipOnPrimaryExceptionBase;
  const createRequestIdSafe =
    typeof createRequestId === 'function' ? createRequestId : randomUUID;

  return async function proxyAgentSearchToBackend(req, res) {
  const checkoutToken =
    String(req.header('X-Checkout-Token') || req.header('x-checkout-token') || '').trim() || null;

  const source = String(firstQueryParamValue(req.query?.source) || '').trim().toLowerCase();
  const searchApiBase = getProxySearchApiBase(source);
  const url = `${searchApiBase}${req.path}`;
  const { queryText, queryParams } = normalizeSearchQueryParams(req.query);
  const auroraFallbackOverrides = getAuroraFallbackOverrides(source, 'find_products_multi');
  const resolverTimeoutMs = auroraFallbackOverrides.active
    ? PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS
    : PROXY_SEARCH_RESOLVER_TIMEOUT_MS;
  const guardedQueryParams = applyShoppingCatalogQueryGuards(queryParams, source);
  const resolverFirstMetadata = source ? { source } : null;
  const traceId = createRequestIdSafe();
  const startedAtMs = Date.now();
  let requestDeadlineMs = startedAtMs + PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS;
  const getRemainingBudgetMs = () => Math.max(0, requestDeadlineMs - Date.now());
  const normalizedQuery = String(queryText || '').trim();
  const resolverStage = {
    called: false,
    hit: false,
    miss: false,
    latency_ms: null,
  };
  const proxySearchAnchorTokens = extractSearchAnchorTokens(queryText);
  const proxySearchLookupStyle = isLookupStyleSearchQuery(queryText, proxySearchAnchorTokens);
  const proxySearchStrongResolverQuery = isStrongResolverFirstQuery(queryText);
  const proxySearchQueryClass = proxySearchLookupStyle ? 'lookup' : null;
  const cacheStage = {
    hit: false,
    candidate_count: 0,
    relevant_count: 0,
    retrieval_sources: [],
  };

  const respondSearch = (
    status,
    body,
    {
      finalDecision = 'upstream_returned',
      primaryPathUsed = 'proxy_search_primary',
      fallbackTriggered = false,
      fallbackReason = null,
      upstreamStage = null,
      strictEmptyReason = null,
      expansionMode = 'off',
      expandedQuery = normalizedQuery,
      intent = null,
	      fallbackStrategy = null,
	      flagsSnapshot = null,
	    } = {},
	  ) => {
    const latencyMs = Math.max(0, Date.now() - startedAtMs);
    const intNonNegative = (value, fallback = 0) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : Math.max(0, Math.floor(fallback));
    };
    const responseProducts = Array.isArray(body?.products) ? body.products : [];
    const responseMetadata =
      body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? body.metadata
        : {};
    const sourceBreakdown =
      responseMetadata.source_breakdown &&
      typeof responseMetadata.source_breakdown === 'object' &&
      !Array.isArray(responseMetadata.source_breakdown)
        ? responseMetadata.source_breakdown
        : {};
    const retryAttemptCount = intNonNegative(
      fallbackStrategy?.secondary_attempt_count != null
        ? fallbackStrategy.secondary_attempt_count
        : Array.isArray(fallbackStrategy?.secondary_attempts)
        ? fallbackStrategy.secondary_attempts.length
        : responseMetadata.retry_attempt_count,
      0,
    );
    const fallbackAttemptCount = intNonNegative(
      responseMetadata.fallback_attempt_count != null
        ? responseMetadata.fallback_attempt_count
        : fallbackStrategy?.secondary_attempt_count != null
        ? fallbackStrategy.secondary_attempt_count
        : fallbackStrategy?.secondary_attempts?.length,
      retryAttemptCount,
    );
    const selectedFallbackAttempt = intNonNegative(
      responseMetadata.selected_fallback_attempt != null
        ? responseMetadata.selected_fallback_attempt
        : fallbackStrategy?.secondary_selected_attempt,
      0,
    );
    const semanticRetryActualAttempted = Boolean(
      responseMetadata.semantic_retry_actual_attempted != null
        ? responseMetadata.semantic_retry_actual_attempted
        : fallbackStrategy?.secondary_actual_retry_attempted === true,
    );
    const primaryQualityScore =
      Number.isFinite(Number(fallbackStrategy?.primary_quality_score)) &&
      Number(fallbackStrategy?.primary_quality_score) >= 0
        ? Math.max(0, Math.min(1, Number(fallbackStrategy.primary_quality_score)))
        : Number.isFinite(Number(responseMetadata.primary_quality_score)) &&
          Number(responseMetadata.primary_quality_score) >= 0
        ? Math.max(0, Math.min(1, Number(responseMetadata.primary_quality_score)))
        : null;
    const lowQualityNonemptyDetected = Boolean(
      fallbackStrategy?.low_quality_nonempty_detected || responseMetadata.low_quality_nonempty_detected,
    );
    const primaryQualityGatePassed =
      fallbackStrategy?.primary_quality_gate_passed != null
        ? Boolean(fallbackStrategy.primary_quality_gate_passed)
        : responseMetadata.primary_quality_gate_passed != null
        ? Boolean(responseMetadata.primary_quality_gate_passed)
        : !lowQualityNonemptyDetected;
    const supplementAttempted = Boolean(
      fallbackStrategy?.secondary_attempted || responseMetadata?.search_stage_b?.attempted,
    );
    const supplementSkipReason =
      String(responseMetadata.supplement_skip_reason || '').trim() ||
      String(responseMetadata?.search_stage_b?.reason || '').trim() ||
      (supplementAttempted
        ? null
        : primaryQualityGatePassed
        ? 'not_needed'
        : String(fallbackStrategy?.secondary_skipped_reason || '').trim() || 'quality_gate_forced_but_skipped');
    let out = withSearchDiagnostics(body, {
      route_health: buildSearchRouteHealth({
        primaryPathUsed,
        primaryLatencyMs: latencyMs,
        fallbackTriggered,
        fallbackReason,
        internalRawCount: intNonNegative(
          responseMetadata.internal_raw_count != null
            ? responseMetadata.internal_raw_count
            : sourceBreakdown.internal_count,
          responseProducts.filter((product) => !isExternalSeedProduct(product)).length,
        ),
        externalRawCount: intNonNegative(
          responseMetadata.external_raw_count != null
            ? responseMetadata.external_raw_count
            : sourceBreakdown.external_seed_count,
          responseProducts.filter((product) => isExternalSeedProduct(product)).length,
        ),
        mergedPreLimitCount: intNonNegative(
          responseMetadata.merged_pre_limit_count != null
            ? responseMetadata.merged_pre_limit_count
            : responseMetadata.total != null
            ? responseMetadata.total
            : body?.total,
          responseProducts.length,
        ),
        primaryQualityGatePassed,
        primaryQualityScore,
        lowQualityNonemptyDetected,
        supplementAttempted,
        supplementSkipReason,
        retryAttemptCount,
        fallbackAttemptCount,
        selectedFallbackAttempt,
        semanticRetryApplied:
          responseMetadata.semantic_retry_applied != null
            ? responseMetadata.semantic_retry_applied
            : semanticRetryActualAttempted,
        semanticRetryActualAttempted,
        semanticRetryQuery: responseMetadata.semantic_retry_query || null,
        semanticRetryHits: intNonNegative(responseMetadata.semantic_retry_hits, 0),
        externalSeedQueryTimeout: Boolean(responseMetadata.external_seed_query_timeout),
        externalSeedSkipReason: responseMetadata.external_seed_skip_reason || null,
        externalSeedCacheHit: Boolean(responseMetadata.external_seed_cache_hit),
        externalSeedRowsFetched: intNonNegative(responseMetadata.external_seed_rows_fetched, 0),
        externalSeedRowsBuilt: intNonNegative(responseMetadata.external_seed_rows_built, 0),
        externalFillGateReason: responseMetadata.external_fill_gate_reason || null,
        querySemanticClass: responseMetadata.query_semantic_class || null,
        domainFilterDroppedExternal: intNonNegative(
          responseMetadata.domain_filter_dropped_external,
          0,
        ),
        finalReturnedCount: intNonNegative(
          responseMetadata.final_returned_count != null
            ? responseMetadata.final_returned_count
            : responseProducts.length,
          responseProducts.length,
        ),
      }),
      search_trace: buildSearchTrace({
        traceId,
        rawQuery: normalizedQuery,
        expandedQuery,
        expansionMode,
        intent,
        cacheStage,
        upstreamStage,
	        resolverStage,
	        finalDecision,
	        flagsSnapshot,
	      }),
      ...(fallbackStrategy && typeof fallbackStrategy === 'object'
        ? { fallback_strategy: fallbackStrategy }
        : {}),
      ...(strictEmptyReason
        ? {
            strict_empty: true,
            strict_empty_reason: strictEmptyReason,
          }
        : {}),
    });
    if (out && typeof out === 'object' && !Array.isArray(out)) {
      out = {
        ...out,
        metadata: {
          ...(out.metadata && typeof out.metadata === 'object' && !Array.isArray(out.metadata)
            ? out.metadata
            : {}),
          guard_source_normalized: normalizeAgentSource(source) || null,
          secondary_fallback_skipped: Boolean(
            fallbackStrategy &&
              typeof fallbackStrategy === 'object' &&
              fallbackStrategy.skip_secondary_after_resolver_miss === true,
          ),
          secondary_fallback_skip_reason:
            fallbackStrategy &&
            typeof fallbackStrategy === 'object' &&
            fallbackStrategy.skip_secondary_after_resolver_miss === true
              ? String(
                  fallbackStrategy.secondary_skipped_reason || 'resolver_miss_skip_secondary',
                )
              : null,
        },
      };
    }

    if (
      SEARCH_STRICT_EMPTY_ENABLED &&
      normalizedQuery &&
      Array.isArray(out?.products) &&
      out.products.length === 0 &&
      !out?.metadata?.strict_empty
    ) {
      out = withSearchDiagnostics(out, {
        strict_empty: true,
        strict_empty_reason: strictEmptyReason || 'no_candidates',
      });
    }
    return res.status(status).json(out);
  };

  let resolverFirstResult = null;
  const shouldAttemptResolverFirst =
    PROXY_SEARCH_RESOLVER_FIRST_ENABLED &&
    PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED &&
    Boolean(String(queryText || '').trim()) &&
    !(isAuroraSource(source) && PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA) &&
    (!PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY ||
      proxySearchLookupStyle ||
      proxySearchStrongResolverQuery);

  if (shouldAttemptResolverFirst) {
    resolverStage.called = true;
    const resolverStartedAtMs = Date.now();
    try {
      resolverFirstResult = await withStageBudgetImpl(
        queryResolveSearchFallback({
        queryParams: guardedQueryParams,
        checkoutToken,
        reason: 'resolver_first',
        requestSource: source,
        timeoutMs: resolverTimeoutMs,
        }),
        FIND_PRODUCTS_MULTI_RESOLVER_STAGE_BUDGET_MS,
        'resolver_stage',
      );
      resolverStage.latency_ms = Math.max(0, Date.now() - resolverStartedAtMs);
      if (
        resolverFirstResult &&
        resolverFirstResult.status >= 200 &&
        resolverFirstResult.status < 300 &&
        resolverFirstResult.usableCount > 0
      ) {
        resolverStage.hit = true;
        return respondSearch(resolverFirstResult.status, resolverFirstResult.data, {
          finalDecision: 'resolver_returned',
          primaryPathUsed: 'resolver_first',
          fallbackTriggered: true,
          fallbackReason: 'resolver_first',
          upstreamStage: {
            called: false,
            timeout: false,
            status: null,
            latency_ms: 0,
          },
        });
      }
      resolverStage.miss = true;
    } catch (resolverErr) {
      resolverStage.miss = true;
      resolverStage.latency_ms = Math.max(0, Date.now() - resolverStartedAtMs);
      log.warn(
        { err: resolverErr?.message || String(resolverErr) },
        'proxy agent search resolver-first failed; falling back to upstream',
      );
    }
  }

  try {
    const basePrimaryTimeoutMsRaw = Math.min(
      getUpstreamTimeoutMs('find_products_multi'),
      PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS,
    );
    const basePrimaryTimeoutMs = auroraFallbackOverrides.active
      ? Math.min(basePrimaryTimeoutMsRaw, PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS)
      : basePrimaryTimeoutMsRaw;
    const primaryTimeoutMs =
      shouldReducePrimaryTimeoutAfterResolverMiss(resolverFirstResult, queryText)
        ? Math.min(basePrimaryTimeoutMs, PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS)
        : basePrimaryTimeoutMs;
    const totalBudgetMs = Math.max(primaryTimeoutMs, PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS);
    requestDeadlineMs = Date.now() + totalBudgetMs;
    const secondarySkipBrandLike = Boolean(
      detectBrandEntities(queryText, { candidateProducts: [] })?.brand_like,
    );
    const secondaryFallbackSkipReason = getSecondaryFallbackSkipReason(
      resolverFirstResult,
      queryText,
      {
        disableSkipAfterResolverMiss: auroraFallbackOverrides.disableSkipAfterResolverMiss,
        queryClass: proxySearchQueryClass,
        brandLike: secondarySkipBrandLike,
      },
    );
    const skipSecondaryFallback = Boolean(secondaryFallbackSkipReason);
    const allowSecondaryFallback = shouldAllowSecondaryFallback('find_products_multi', {
      forceSecondaryFallback: auroraFallbackOverrides.forceSecondaryFallback,
    });
    const allowResolverFallback = shouldAllowResolverFallback('find_products_multi');
    const allowInvokeFallback = true;
    const fallbackStrategy = {
      source: auroraFallbackOverrides.strategySource,
      request_source: source || null,
      resolver_attempted: false,
      secondary_attempted: false,
      pass1_attempted: false,
      pass2_attempted: false,
      pass2_selected: false,
      pass2_skipped_reason: null,
      secondary_skipped_reason: secondaryFallbackSkipReason,
      fallback_skipped_due_budget: false,
      fallback_after_primary_timeout_attempted: false,
      total_budget_ms: totalBudgetMs,
      allow_secondary_fallback: allowSecondaryFallback,
      allow_invoke_fallback: allowInvokeFallback,
      skip_secondary_after_resolver_miss: skipSecondaryFallback,
      aurora_external_seed_forced: Boolean(auroraFallbackOverrides.active),
      aurora_external_seed_enabled: Boolean(
        auroraFallbackOverrides.active && PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED,
      ),
      aurora_seed_strategy: auroraFallbackOverrides.active
        ? PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY
        : null,
      aurora_upstream_base: auroraFallbackOverrides.active
        ? getProxySearchApiBase(source)
        : null,
      aurora_primary_timeout_ms: auroraFallbackOverrides.active
        ? PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS
        : null,
      aurora_fallback_timeout_ms: auroraFallbackOverrides.active
        ? PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS
        : null,
      primary_monoculture_detected: false,
      primary_monoculture_dominant_brand: null,
      primary_monoculture_external_ratio: 0,
      fallback_adopt_usable_threshold: null,
    };

    const runPrimarySearchRequest = async ({ params, timeoutMs, pass }) => {
      const startedMs = Date.now();
      const response = await axios({
        method: 'GET',
        url,
        params,
        headers: {
          ...buildInvokeUpstreamAuthHeaders({ checkoutToken }),
        },
        timeout: timeoutMs,
        validateStatus: () => true,
      });
      const upstream = {
        called: true,
        timeout: false,
        status: Number(response?.status || 0) || 0,
        latency_ms: Math.max(0, Date.now() - startedMs),
        pass,
      };
      const normalizedResponse = normalizeAgentProductsListResponse(response.data, {
        limit: parseQueryNumber(params?.limit ?? params?.page_size),
        offset: parseQueryNumber(params?.offset),
      });
      const usableCount = countUsableSearchProducts(normalizedResponse?.products);
      const unusable =
        Boolean(queryText) &&
        shouldFallbackProxySearchImpl(normalizedResponse, response.status);
      const relevant = queryText ? isProxySearchFallbackRelevant(normalizedResponse, queryText) : true;
      const primaryQualityGate = evaluateCacheQualityGate({
        products: normalizedResponse?.products,
        queryText,
        intent: null,
        queryClass: proxySearchQueryClass,
      });
      const primaryQualityScore = computePrimaryQualityScore(primaryQualityGate);
      const primaryProducts = Array.isArray(normalizedResponse?.products) ? normalizedResponse.products : [];
      const primaryHasExternalSeed = primaryProducts.some((product) => isExternalSeedProduct(product));
      const primaryBrandLike = Boolean(
        detectBrandEntities(queryText, { candidateProducts: primaryProducts })?.brand_like,
      );
      const lowQualityNonempty =
        Boolean(queryText) &&
        usableCount > 0 &&
        primaryQualityGate.enabled &&
        !primaryQualityGate.accepted &&
        !primaryBrandLike &&
        !primaryHasExternalSeed;
      const monocultureSignal = detectAuroraExternalSeedMonocultureImpl({
        normalized: normalizedResponse,
        queryText,
        source,
      });
      const monoculture = Boolean(monocultureSignal.detected);
      const irrelevant = Boolean(queryText) && ((usableCount > 0 && !relevant) || monoculture);
      return {
        pass,
        response,
        upstream,
        params,
        timeout_ms: timeoutMs,
        normalized: normalizedResponse,
        usable_count: usableCount,
        unusable,
        relevant,
        monoculture_signal: monocultureSignal,
        monoculture,
        irrelevant,
        primary_quality_gate: primaryQualityGate,
        primary_quality_score: primaryQualityScore,
        low_quality_nonempty: lowQualityNonempty,
        should_fallback: unusable || irrelevant || lowQualityNonempty,
      };
    };

    const auroraTwoPassEnabled = Boolean(
      auroraFallbackOverrides.active &&
      PROXY_SEARCH_AURORA_FORCE_TWO_PASS &&
      queryText,
    );
    const primaryDeadlineMs = Date.now() + primaryTimeoutMs;
    const pass1QueryParams = auroraTwoPassEnabled
      ? {
          ...guardedQueryParams,
          allow_external_seed: false,
          external_seed_strategy: 'legacy',
          fast_mode: true,
        }
      : guardedQueryParams;
    const pass1TimeoutMs = auroraTwoPassEnabled
      ? Math.max(
          250,
          Math.min(
            PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS,
            Math.max(250, primaryDeadlineMs - Date.now()),
            primaryTimeoutMs,
          ),
        )
      : primaryTimeoutMs;
    fallbackStrategy.pass1_attempted = true;
    fallbackStrategy.pass1_timeout_ms = pass1TimeoutMs;

    let primaryRun = await runPrimarySearchRequest({
      params: pass1QueryParams,
      timeoutMs: pass1TimeoutMs,
      pass: auroraTwoPassEnabled ? 'pass1_internal_fast' : 'single_pass',
    });
    fallbackStrategy.pass1_usable_count = Number(primaryRun.usable_count || 0);
    fallbackStrategy.pass1_relevance_passed = primaryRun.relevant === true;

    if (auroraTwoPassEnabled) {
      const requestedLimit = parseQueryNumber(guardedQueryParams?.limit ?? guardedQueryParams?.page_size);
      const pass2TargetUsable = Math.max(
        1,
        Math.min(
          PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE,
          Number.isFinite(Number(requestedLimit)) && Number(requestedLimit) > 0 ? Number(requestedLimit) : PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE,
        ),
      );
      const needPass2 = primaryRun.usable_count < pass2TargetUsable || primaryRun.should_fallback;
      if (!needPass2) {
        fallbackStrategy.pass2_skipped_reason = 'pass1_sufficient';
      } else if (!PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED) {
        fallbackStrategy.pass2_skipped_reason = 'external_seed_disabled';
      } else {
        const remainingBudgetMs = Math.max(0, primaryDeadlineMs - Date.now());
        if (remainingBudgetMs < 200) {
          fallbackStrategy.pass2_skipped_reason = 'budget_exhausted';
        } else {
          const pass2TimeoutMs = Math.max(
            200,
            Math.min(PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS, remainingBudgetMs),
          );
          const pass2QueryParams = {
            ...guardedQueryParams,
            allow_external_seed: true,
            external_seed_strategy: PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY,
            fast_mode: true,
          };
          fallbackStrategy.pass2_attempted = true;
          fallbackStrategy.pass2_timeout_ms = pass2TimeoutMs;
          recordAuroraCompPass2Invoked({ mode: 'main_path' });
          try {
            const pass2Run = await runPrimarySearchRequest({
              params: pass2QueryParams,
              timeoutMs: pass2TimeoutMs,
              pass: 'pass2_external_seed',
            });
            fallbackStrategy.pass2_usable_count = Number(pass2Run.usable_count || 0);
            fallbackStrategy.pass2_relevance_passed = pass2Run.relevant === true;
            const pass2Preferred =
              pass2Run.usable_count > primaryRun.usable_count ||
              (
                (primaryRun.unusable || primaryRun.irrelevant) &&
                pass2Run.usable_count > 0 &&
                pass2Run.relevant === true
              );
            if (pass2Preferred) {
              primaryRun = pass2Run;
              fallbackStrategy.pass2_selected = true;
            } else {
              fallbackStrategy.pass2_selected = false;
              fallbackStrategy.pass2_skipped_reason = 'pass2_not_better';
            }
          } catch (pass2Err) {
            fallbackStrategy.pass2_skipped_reason =
              String(pass2Err?.code || '').toUpperCase() === 'ECONNABORTED'
                ? 'pass2_timeout'
                : 'pass2_exception';
            if (fallbackStrategy.pass2_skipped_reason === 'pass2_timeout') {
              recordAuroraCompPass2Timeout({ mode: 'main_path' });
            }
            log.warn(
              { err: pass2Err?.message || String(pass2Err) },
              'proxy agent search aurora pass2 failed; keeping pass1',
            );
          }
        }
      }
    } else {
      fallbackStrategy.pass2_skipped_reason = auroraFallbackOverrides.active ? 'two_pass_disabled' : 'not_aurora';
    }

    const resp = primaryRun.response;
    const upstreamStage = primaryRun.upstream;
    const normalized = primaryRun.normalized;
    const primaryUsableCount = primaryRun.usable_count;
    const primaryUnusable = primaryRun.unusable;
    const primaryRelevant = primaryRun.relevant;
    const primaryMonocultureSignal = primaryRun.monoculture_signal;
    const primaryMonoculture = primaryRun.monoculture;
    const primaryIrrelevant = primaryRun.irrelevant;
    const primaryQualityGate = primaryRun.primary_quality_gate || null;
    const primaryQualityScore = primaryRun.primary_quality_score;
    const primaryLowQualityNonempty = Boolean(primaryRun.low_quality_nonempty);
    const shouldFallback = primaryRun.should_fallback;
    const primaryProducts = Array.isArray(normalized?.products) ? normalized.products : [];
    const primaryExternalRawCount = primaryProducts.filter((product) => isExternalSeedProduct(product)).length;
    const primaryInternalRawCount = Math.max(0, primaryProducts.length - primaryExternalRawCount);
    fallbackStrategy.primary_monoculture_detected = primaryMonoculture;
    fallbackStrategy.primary_monoculture_dominant_brand = primaryMonocultureSignal.dominantBrand || null;
    fallbackStrategy.primary_monoculture_external_ratio = Number(
      primaryMonocultureSignal.externalRatio || 0,
    );
    fallbackStrategy.primary_quality_gate_passed = !primaryLowQualityNonempty;
    fallbackStrategy.primary_quality_score =
      Number.isFinite(Number(primaryQualityScore)) && Number(primaryQualityScore) >= 0
        ? Number(primaryQualityScore)
        : null;
    fallbackStrategy.low_quality_nonempty_detected = primaryLowQualityNonempty;
    fallbackStrategy.internal_raw_count = primaryInternalRawCount;
    fallbackStrategy.external_raw_count = primaryExternalRawCount;
    fallbackStrategy.merged_pre_limit_count = Number.isFinite(Number(normalized?.total))
      ? Math.max(primaryProducts.length, Number(normalized.total))
      : primaryProducts.length;
    fallbackStrategy.primary_quality_reason =
      primaryQualityGate && typeof primaryQualityGate === 'object'
        ? String(primaryQualityGate.reason || '').trim() || null
        : null;
    const fallbackAdoptUsableThreshold = getFallbackAdoptUsableThresholdImpl({
      operation: 'find_products_multi',
      source,
      primaryUsableCount,
      primaryIrrelevant,
    });
    fallbackStrategy.fallback_adopt_usable_threshold = fallbackAdoptUsableThreshold;

    if (shouldFallback) {
      if (allowResolverFallback && !skipSecondaryFallback) {
        const resolverRemainingBudgetMs = getRemainingBudgetMs();
        if (resolverRemainingBudgetMs < 120) {
          fallbackStrategy.fallback_skipped_due_budget = true;
          fallbackStrategy.resolver_skipped_reason = 'budget_exhausted';
        } else {
          fallbackStrategy.resolver_attempted = true;
          try {
            const resolverFallback = await queryResolveSearchFallback({
              queryParams: guardedQueryParams,
              checkoutToken,
              reason: 'resolver_after_primary',
              requestSource: source,
              timeoutMs: Math.max(120, Math.min(resolverTimeoutMs, resolverRemainingBudgetMs)),
            });
            if (
              resolverFallback &&
              resolverFallback.status >= 200 &&
              resolverFallback.status < 300 &&
              resolverFallback.usableCount > 0
            ) {
              resolverStage.hit = true;
              fallbackStrategy.remaining_budget_ms = getRemainingBudgetMs();
              return respondSearch(resolverFallback.status, resolverFallback.data, {
                finalDecision: 'resolver_returned',
                primaryPathUsed: 'proxy_search_primary',
                fallbackTriggered: true,
                fallbackReason: 'resolver_after_primary',
                upstreamStage,
                fallbackStrategy,
              });
            }
          } catch (resolverErr) {
            log.warn(
              { err: resolverErr?.message || String(resolverErr) },
              'proxy agent search resolver fallback failed; keeping primary response',
            );
          }
        }
      }

      const secondaryFallbackReason = primaryUnusable
        ? primaryUsableCount > 0
          ? 'insufficient_primary'
          : 'empty_or_unusable_primary'
        : primaryMonoculture
        ? 'primary_monoculture'
        : primaryLowQualityNonempty
        ? 'primary_low_quality'
        : 'primary_irrelevant';

      if (allowSecondaryFallback && allowInvokeFallback && !skipSecondaryFallback) {
        const secondaryRemainingBudgetMs = getRemainingBudgetMs();
        const forceLowQualityFallbackAttempt =
          primaryLowQualityNonempty && SEARCH_EXTERNAL_HARD_RULE_PRUNE;
        if (secondaryRemainingBudgetMs < 160 && !forceLowQualityFallbackAttempt) {
          fallbackStrategy.fallback_skipped_due_budget = true;
          fallbackStrategy.secondary_skipped_reason = 'budget_exhausted';
        } else {
          fallbackStrategy.secondary_attempted = true;
          try {
            const fallbackTimeoutMs = forceLowQualityFallbackAttempt
              ? Math.max(500, secondaryRemainingBudgetMs)
              : secondaryRemainingBudgetMs;
            const fallback = await queryFindProductsMultiFallback({
              queryParams: guardedQueryParams,
              checkoutToken,
              reason: secondaryFallbackReason,
              requestSource: source,
              timeoutMs: fallbackTimeoutMs,
            });
            const fallbackRelevant = Boolean(
              fallback &&
                (
                  (hasFragranceQuerySignal(queryText) && Number(fallback?.usableCount || 0) > 0) ||
                  fallback.relevanceMatched === true ||
                  (fallback.relevanceMatched == null && isProxySearchFallbackRelevant(fallback.data, queryText))
                ),
            );
            const fallbackUsableCount = Math.max(0, Number(fallback?.usableCount || 0) || 0);
            const fallbackRecallImproved = fallbackUsableCount >= Math.max(
              fallbackAdoptUsableThreshold,
              primaryUsableCount + (primaryLowQualityNonempty ? 1 : 2),
            );
            fallbackStrategy.secondary_usable_count = Number(fallback?.usableCount || 0);
            fallbackStrategy.secondary_relevance_passed = fallbackRelevant;
            fallbackStrategy.secondary_selected_query = fallback?.selectedQuery || null;
            fallbackStrategy.secondary_selected_attempt = Math.max(
              0,
              Number(fallback?.selectedAttemptNo || 0) || 0,
            );
            fallbackStrategy.secondary_actual_retry_attempted = Boolean(
              fallback?.actualRetryAttempted,
            );
            fallbackStrategy.secondary_attempt_count = Array.isArray(fallback?.attempts)
              ? fallback.attempts.length
              : fallback
              ? 1
              : 0;
            if (Array.isArray(fallback?.attempts) && fallback.attempts.length > 0) {
              fallbackStrategy.secondary_attempts = fallback.attempts.slice(0, 3);
            }
            if (
              fallback &&
              fallback.status >= 200 &&
              fallback.status < 300 &&
              fallbackUsableCount >= fallbackAdoptUsableThreshold &&
              (
                (primaryLowQualityNonempty && (fallbackRecallImproved || fallbackRelevant)) ||
                fallbackRelevant
              )
            ) {
              fallbackStrategy.secondary_rejected_reason = null;
              fallbackStrategy.remaining_budget_ms = getRemainingBudgetMs();
              return respondSearch(fallback.status, fallback.data, {
                finalDecision: 'upstream_returned',
                primaryPathUsed: 'proxy_search_primary',
                fallbackTriggered: true,
                fallbackReason: primaryUnusable
                  ? 'secondary_after_primary_unusable'
                  : primaryMonoculture
                  ? 'secondary_after_primary_monoculture'
                  : primaryLowQualityNonempty
                  ? 'secondary_after_primary_low_quality'
                  : 'secondary_after_primary_irrelevant',
                upstreamStage,
                fallbackStrategy,
              });
            }
            fallbackStrategy.secondary_rejected_reason = !fallback
              ? 'secondary_unavailable'
              : fallback.status < 200 || fallback.status >= 300
              ? 'secondary_status_non_2xx'
              : fallback.usableCount < fallbackAdoptUsableThreshold
              ? 'secondary_below_usable_threshold'
              : !fallbackRelevant
              ? 'secondary_irrelevant'
              : 'secondary_not_adopted';
          } catch (fallbackErr) {
            fallbackStrategy.secondary_rejected_reason = 'secondary_exception';
            log.warn(
              { err: fallbackErr?.message || String(fallbackErr) },
              'proxy agent search fallback invoke failed; keeping primary response',
            );
          }
        }
      } else if (!allowSecondaryFallback) {
        fallbackStrategy.secondary_skipped_reason = 'secondary_disabled';
      } else if (!allowInvokeFallback) {
        fallbackStrategy.secondary_skipped_reason = 'invoke_fallback_disabled';
      } else if (skipSecondaryFallback) {
        fallbackStrategy.secondary_skipped_reason =
          fallbackStrategy.secondary_skipped_reason || 'resolver_miss_skip_secondary';
      }
    }
    fallbackStrategy.remaining_budget_ms = getRemainingBudgetMs();
    const normalizedProducts = Array.isArray(normalized?.products) ? normalized.products : [];
    const fallbackAttempts = Array.isArray(fallbackStrategy.secondary_attempts)
      ? fallbackStrategy.secondary_attempts
      : [];
    const semanticRetryApplied = Boolean(fallbackStrategy.secondary_actual_retry_attempted);
    const semanticRetryQuery = semanticRetryApplied
      ? String(
          fallbackStrategy.secondary_selected_query ||
            fallbackAttempts[fallbackAttempts.length - 1]?.query ||
            '',
        ).trim() || null
      : null;
    const fallbackNotBetterReason = semanticRetryApplied
      ? primaryLowQualityNonempty
        ? 'low_quality_semantic_retry_exhausted'
        : 'semantic_retry_exhausted'
      : primaryLowQualityNonempty
      ? 'low_quality_no_improvement'
      : 'fallback_not_better';

    if (primaryIrrelevant && Number(resp.status) >= 200 && Number(resp.status) < 300) {
      const reason = skipSecondaryFallback
        ? primaryMonoculture
          ? 'primary_monoculture_skip_secondary'
          : 'primary_irrelevant_skip_secondary'
        : primaryMonoculture
        ? 'primary_monoculture_no_fallback'
        : 'primary_irrelevant_no_fallback';
      return respondSearch(
        200,
        buildProxySearchSoftFallbackResponse({
          body: normalized,
          queryParams: guardedQueryParams,
          reason,
          upstreamStatus: resp.status,
          route: 'proxy_search_primary_irrelevant',
          queryText,
          semanticRetryApplied: Boolean(semanticRetryApplied),
          semanticRetryQuery,
          semanticRetryHits: Math.max(0, Number(fallbackStrategy.secondary_usable_count || 0) || 0),
          forceClarify: true,
        }),
        {
          finalDecision: 'clarify',
          primaryPathUsed: 'proxy_search_primary',
          fallbackTriggered: true,
          fallbackReason: reason,
          upstreamStage,
          fallbackStrategy,
        },
      );
    }

    if (Number(resp.status) >= 500) {
      const reason = 'primary_status_5xx';
      return respondSearch(
        200,
        withStrictEmptyFallback({
          body: normalized,
          queryParams: guardedQueryParams,
          reason,
          upstreamStatus: resp.status,
          route: 'proxy_search_primary_status',
          fallbackStrategy,
        }),
        {
          finalDecision: 'strict_empty',
          primaryPathUsed: 'proxy_search_primary',
          fallbackTriggered: true,
          fallbackReason: reason,
          upstreamStage,
          strictEmptyReason: reason,
          fallbackStrategy,
        },
      );
    }

    const shouldForceClarifyAfterFallback =
      SEARCH_EXTERNAL_HARD_RULE_PRUNE &&
      normalizedProducts.length === 0 &&
      shouldFallback &&
      !primaryIrrelevant &&
      !skipSecondaryFallback &&
      semanticRetryApplied;
    const shouldForceClarifyLowQuality =
      SEARCH_EXTERNAL_HARD_RULE_PRUNE &&
      primaryLowQualityNonempty &&
      shouldFallback &&
      !primaryIrrelevant;
    if (shouldForceClarifyAfterFallback || shouldForceClarifyLowQuality) {
      const clarifyBody = buildProxySearchSoftFallbackResponse({
        body: normalized,
        queryParams: guardedQueryParams,
        reason: fallbackNotBetterReason,
        upstreamStatus: resp.status,
        route: 'proxy_search_fallback_exhausted',
        queryText,
        semanticRetryApplied: Boolean(semanticRetryApplied),
        semanticRetryQuery,
        semanticRetryHits: Math.max(0, Number(fallbackStrategy.secondary_usable_count || 0) || 0),
        forceClarify: true,
      });
      return respondSearch(
        200,
        clarifyBody,
        {
          finalDecision: 'clarify',
          primaryPathUsed: 'proxy_search_primary',
          fallbackTriggered: true,
          fallbackReason: fallbackNotBetterReason,
          upstreamStage,
          strictEmptyReason: null,
          fallbackStrategy,
        },
      );
    }

    return respondSearch(
      resp.status,
      withProxySearchFallbackMetadata(normalized, {
        applied: false,
        reason:
          primaryIrrelevant
            ? skipSecondaryFallback
              ? primaryMonoculture
                ? 'primary_monoculture_skip_secondary'
                : 'primary_irrelevant_skip_secondary'
              : primaryMonoculture
              ? 'primary_monoculture_no_fallback'
              : 'primary_irrelevant_no_fallback'
            : shouldFallback && skipSecondaryFallback
            ? 'resolver_miss_skip_secondary'
            : shouldFallback
              ? fallbackNotBetterReason
              : 'not_needed',
        ...(semanticRetryApplied ? { query_variant: 'semantic_retry' } : {}),
      }),
      {
        finalDecision:
          normalizedProducts.length > 0
            ? 'upstream_returned'
            : 'strict_empty',
        primaryPathUsed: 'proxy_search_primary',
        fallbackTriggered: Boolean(shouldFallback),
        fallbackReason:
          primaryIrrelevant
            ? skipSecondaryFallback
              ? primaryMonoculture
                ? 'primary_monoculture_skip_secondary'
                : 'primary_irrelevant_skip_secondary'
              : primaryMonoculture
              ? 'primary_monoculture_no_fallback'
              : 'primary_irrelevant_no_fallback'
            : shouldFallback && skipSecondaryFallback
            ? 'resolver_miss_skip_secondary'
            : shouldFallback
              ? fallbackNotBetterReason
              : null,
        upstreamStage,
        strictEmptyReason:
          normalizedProducts.length > 0
            ? null
            : shouldFallback && skipSecondaryFallback
            ? 'resolver_miss_skip_secondary'
            : shouldFallback
            ? fallbackNotBetterReason
            : 'no_candidates',
        fallbackStrategy,
      },
    );
  } catch (err) {
    const primaryTimedOut = String(err?.code || '').toUpperCase() === 'ECONNABORTED';
    const secondarySkipBrandLike = Boolean(
      detectBrandEntities(queryText, { candidateProducts: [] })?.brand_like,
    );
    const secondaryFallbackSkipReason = getSecondaryFallbackSkipReason(
      resolverFirstResult,
      queryText,
      {
        disableSkipAfterResolverMiss: auroraFallbackOverrides.disableSkipAfterResolverMiss,
        queryClass: proxySearchQueryClass,
        brandLike: secondarySkipBrandLike,
      },
    );
    const skipSecondaryFallback = Boolean(secondaryFallbackSkipReason);
    const allowSecondaryFallback = shouldAllowSecondaryFallback('find_products_multi', {
      forceSecondaryFallback: auroraFallbackOverrides.forceSecondaryFallback,
    });
    const allowResolverFallback = shouldAllowResolverFallback('find_products_multi');
    const allowInvokeFallback = true;
    const bypassSkipSecondaryFallback =
      shouldBypassSecondaryFallbackSkipOnPrimaryExceptionImpl({ err });
    const allowResolverFallbackOnException =
      allowResolverFallback && (!skipSecondaryFallback || bypassSkipSecondaryFallback);
    const allowSecondaryFallbackOnException =
      allowSecondaryFallback &&
      allowInvokeFallback &&
      (!skipSecondaryFallback || bypassSkipSecondaryFallback);
    const fallbackStrategy = {
      source: auroraFallbackOverrides.strategySource,
      request_source: source || null,
      resolver_attempted: false,
      secondary_attempted: false,
      pass1_attempted: true,
      pass2_attempted: false,
      pass2_selected: false,
      pass2_skipped_reason: 'primary_exception',
      secondary_skipped_reason: secondaryFallbackSkipReason,
      fallback_skipped_due_budget: false,
      fallback_after_primary_timeout_attempted: false,
      total_budget_ms: Math.max(0, requestDeadlineMs - startedAtMs),
      allow_secondary_fallback: allowSecondaryFallback,
      allow_invoke_fallback: allowInvokeFallback,
      skip_secondary_after_resolver_miss: skipSecondaryFallback,
      bypass_skip_after_exception: bypassSkipSecondaryFallback,
      aurora_external_seed_forced: Boolean(auroraFallbackOverrides.active),
      aurora_external_seed_enabled: Boolean(
        auroraFallbackOverrides.active && PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED,
      ),
      aurora_seed_strategy: auroraFallbackOverrides.active
        ? PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY
        : null,
      aurora_upstream_base: auroraFallbackOverrides.active
        ? getProxySearchApiBase(source)
        : null,
    };
    if (queryText) {
      if (allowResolverFallbackOnException) {
        const resolverRemainingBudgetMs = getRemainingBudgetMs();
        if (resolverRemainingBudgetMs < 120) {
          fallbackStrategy.fallback_skipped_due_budget = true;
          fallbackStrategy.resolver_skipped_reason = 'budget_exhausted';
        } else {
          fallbackStrategy.resolver_attempted = true;
          if (primaryTimedOut) {
            fallbackStrategy.fallback_after_primary_timeout_attempted = true;
          }
          try {
            const resolverStartedAtMs = Date.now();
            resolverStage.called = true;
            const resolverFallback = await queryResolveSearchFallback({
              queryParams: guardedQueryParams,
              checkoutToken,
              reason: 'resolver_after_exception',
              requestSource: source,
              timeoutMs: Math.max(120, Math.min(resolverTimeoutMs, resolverRemainingBudgetMs)),
            });
            resolverStage.latency_ms = Math.max(0, Date.now() - resolverStartedAtMs);
            if (
              resolverFallback &&
              resolverFallback.status >= 200 &&
              resolverFallback.status < 300 &&
              resolverFallback.usableCount > 0
            ) {
              resolverStage.hit = true;
              fallbackStrategy.remaining_budget_ms = getRemainingBudgetMs();
              return respondSearch(resolverFallback.status, resolverFallback.data, {
                finalDecision: 'resolver_returned',
                primaryPathUsed: 'proxy_search_primary',
                fallbackTriggered: true,
                fallbackReason: 'resolver_after_exception',
                upstreamStage: {
                  called: true,
                  timeout: primaryTimedOut,
                  status: Number(err?.response?.status || err?.status || 0) || 0,
                  latency_ms: Math.max(0, Date.now() - startedAtMs),
                },
                fallbackStrategy,
              });
            }
            resolverStage.miss = true;
          } catch (resolverErr) {
            resolverStage.miss = true;
            log.warn(
              { err: resolverErr?.message || String(resolverErr) },
              'proxy agent search resolver fallback failed after primary exception',
            );
          }
        }
      }

      if (allowSecondaryFallbackOnException) {
        const secondaryRemainingBudgetMs = getRemainingBudgetMs();
        if (secondaryRemainingBudgetMs < 160) {
          fallbackStrategy.fallback_skipped_due_budget = true;
          fallbackStrategy.secondary_skipped_reason = 'budget_exhausted';
        } else {
          fallbackStrategy.secondary_attempted = true;
          if (primaryTimedOut) {
            fallbackStrategy.fallback_after_primary_timeout_attempted = true;
          }
          try {
            const fallback = await queryFindProductsMultiFallback({
              queryParams: guardedQueryParams,
              checkoutToken,
              reason: 'primary_request_failed',
              requestSource: source,
              timeoutMs: secondaryRemainingBudgetMs,
            });
            const fallbackRelevant = Boolean(
              fallback &&
                (
                  (hasFragranceQuerySignal(queryText) && Number(fallback?.usableCount || 0) > 0) ||
                  fallback.relevanceMatched === true ||
                  (fallback.relevanceMatched == null && isProxySearchFallbackRelevant(fallback.data, queryText))
                ),
            );
            fallbackStrategy.secondary_usable_count = Number(fallback?.usableCount || 0);
            fallbackStrategy.secondary_relevance_passed = fallbackRelevant;
            fallbackStrategy.secondary_selected_query = fallback?.selectedQuery || null;
            fallbackStrategy.secondary_selected_attempt = Math.max(
              0,
              Number(fallback?.selectedAttemptNo || 0) || 0,
            );
            fallbackStrategy.secondary_actual_retry_attempted = Boolean(
              fallback?.actualRetryAttempted,
            );
            fallbackStrategy.secondary_attempt_count = Array.isArray(fallback?.attempts)
              ? fallback.attempts.length
              : fallback
              ? 1
              : 0;
            if (Array.isArray(fallback?.attempts) && fallback.attempts.length > 0) {
              fallbackStrategy.secondary_attempts = fallback.attempts.slice(0, 3);
            }
            if (
              fallback &&
              fallback.status >= 200 &&
              fallback.status < 300 &&
              fallback.usableCount > 0 &&
              fallbackRelevant
            ) {
              fallbackStrategy.secondary_rejected_reason = null;
              fallbackStrategy.remaining_budget_ms = getRemainingBudgetMs();
              return respondSearch(fallback.status, fallback.data, {
                finalDecision: 'upstream_returned',
                primaryPathUsed: 'proxy_search_primary',
                fallbackTriggered: true,
                fallbackReason: 'secondary_after_exception',
                upstreamStage: {
                  called: true,
                  timeout: primaryTimedOut,
                  status: Number(err?.response?.status || err?.status || 0) || 0,
                  latency_ms: Math.max(0, Date.now() - startedAtMs),
                },
                fallbackStrategy,
              });
            }
            fallbackStrategy.secondary_rejected_reason = !fallback
              ? 'secondary_unavailable'
              : fallback.status < 200 || fallback.status >= 300
              ? 'secondary_status_non_2xx'
              : fallback.usableCount <= 0
              ? 'secondary_no_usable_products'
              : !fallbackRelevant
              ? 'secondary_irrelevant'
              : 'secondary_not_adopted';
          } catch (fallbackErr) {
            fallbackStrategy.secondary_rejected_reason = 'secondary_exception';
            log.warn(
              { err: fallbackErr?.message || String(fallbackErr) },
              'proxy agent search fallback invoke failed after primary exception',
            );
          }
        }
      } else if (!allowSecondaryFallback) {
        fallbackStrategy.secondary_skipped_reason = 'secondary_disabled';
      } else if (!allowInvokeFallback) {
        fallbackStrategy.secondary_skipped_reason = 'invoke_fallback_disabled';
      } else if (skipSecondaryFallback && !bypassSkipSecondaryFallback) {
        fallbackStrategy.secondary_skipped_reason =
          fallbackStrategy.secondary_skipped_reason || 'resolver_miss_skip_secondary';
      }
      fallbackStrategy.remaining_budget_ms = getRemainingBudgetMs();
    }

    const { code, message, data } = extractUpstreamErrorCode(err);
    const statusCode = err?.response?.status || err?.status || (err?.code === 'ECONNABORTED' ? 504 : 500);
    if (queryText) {
      const reason = err?.code === 'ECONNABORTED' ? 'primary_timeout' : 'primary_exception';
      return respondSearch(
        200,
        withStrictEmptyFallback({
          body: null,
          queryParams: guardedQueryParams,
          reason,
          upstreamStatus: statusCode,
          upstreamCode: code || err?.code || null,
          upstreamMessage: message || err?.message || null,
          route: 'proxy_search_exception',
          fallbackStrategy,
        }),
        {
          finalDecision: 'strict_empty',
          primaryPathUsed: 'proxy_search_primary',
          fallbackTriggered: true,
          fallbackReason: reason,
          upstreamStage: {
            called: true,
            timeout: String(err?.code || '').toUpperCase() === 'ECONNABORTED',
            status: Number(statusCode || 0) || 0,
            latency_ms: Math.max(0, Date.now() - startedAtMs),
          },
          strictEmptyReason: reason,
          fallbackStrategy,
        },
      );
    }
    return res.status(statusCode).json({
      error: code || 'FAILED_TO_PROXY_AGENT_SEARCH',
      message: message || 'Failed to proxy agent search request',
      details: data || null,
    });
  }
}
}

module.exports = {
  createProxyAgentSearchToBackend,
};
