const {
  createCommerceResolutionRuntime,
  handleCommerceResolution,
} = require('../src/modules/execution/commerce_resolution');

describe('Commerce resolution facade', () => {
  test('default facade handle remains a bounded not_resolved skeleton', async () => {
    const out = await handleCommerceResolution({
      requested_resolution: 'product',
      context: {
        source_profile: {
          source: 'shopping_agent',
          default_entry_layer: 'decisioning',
        },
        raw_user_goal: 'ipsa toner',
      },
    });

    expect(out.layer).toBe('execution_facing');
    expect(out.status).toBe('not_resolved');
    expect(out.blockers).toContain('milestone0_execution_facade_not_yet_bound');
  });

  test('cache-miss resolver fallback gate only opens for enabled lookup queries with text', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.shouldAttemptCacheMissResolverFallback({
        resolverFallbackEnabled: true,
        isLookupQuery: true,
        cacheQueryText: 'ipsa toner',
      }),
    ).toBe(true);
    expect(
      runtime.shouldAttemptCacheMissResolverFallback({
        resolverFallbackEnabled: false,
        isLookupQuery: true,
        cacheQueryText: 'ipsa toner',
      }),
    ).toBe(false);
    expect(
      runtime.shouldAttemptCacheMissResolverFallback({
        resolverFallbackEnabled: true,
        isLookupQuery: false,
        cacheQueryText: 'ipsa toner',
      }),
    ).toBe(false);
    expect(
      runtime.shouldAttemptCacheMissResolverFallback({
        resolverFallbackEnabled: true,
        isLookupQuery: true,
        cacheQueryText: '   ',
      }),
    ).toBe(false);
  });

  test('resolver fallback request builder normalizes query params and aurora timeout', () => {
    const runtime = createCommerceResolutionRuntime({
      isAuroraSource(source) {
        return String(source || '').toLowerCase() === 'aurora-bff';
      },
    });

    expect(
      runtime.buildCacheMissResolverFallbackRequest({
        search: {
          category: 'skincare',
          price_min: 10,
          max_price: 40,
        },
        cacheQueryText: 'repair serum',
        inStockOnly: true,
        limit: 12,
        normalizedSeedStrategyForCache: '',
        checkoutToken: 'checkout-token',
        source: 'aurora-bff',
        auroraResolverTimeoutMs: 1800,
        resolverTimeoutMs: 900,
      }),
    ).toEqual({
      queryParams: {
        query: 'repair serum',
        category: 'skincare',
        min_price: 10,
        max_price: 40,
        in_stock_only: true,
        limit: 12,
        offset: 0,
        search_all_merchants: true,
        allow_external_seed: true,
        allow_stale_cache: false,
        external_seed_strategy: 'unified_relevance',
        fast_mode: true,
      },
      checkoutToken: 'checkout-token',
      reason: 'resolver_after_cache_miss',
      requestSource: 'aurora-bff',
      timeoutMs: 1800,
    });
  });

  test('cache quality gate is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      buildBeautyQueryProfile() {
        return {
          isSpecificBeautyQuery: false,
          bucket: null,
        };
      },
      hasBeautyMakeupSearchSignal() {
        return true;
      },
      buildFallbackCandidateText(product) {
        return String(product?.title || '').trim().toLowerCase();
      },
      extractSearchAnchorTokens() {
        return ['repair', 'serum'];
      },
      searchCacheValidate: () => true,
      searchCacheMinAnchor: () => 0.5,
      searchCacheMaxDomainEntropy: () => 0.55,
      searchCacheMinCount: () => 2,
      searchCacheMaxCrossDomainRatio: () => 0.2,
    });

    expect(
      runtime.evaluateCacheQualityGate({
        products: [
          { product_id: 'p1', title: 'Repair serum concentrate', domain: 'beauty' },
          { product_id: 'p2', title: 'Repair serum refill', domain: 'beauty' },
        ],
        queryText: 'repair serum',
        intent: { primary_domain: 'beauty' },
        queryClass: 'attribute',
      }),
    ).toEqual({
      enabled: true,
      accepted: true,
      min_count: 2,
      count: 2,
      anchor_ratio: 1,
      min_anchor: 0.5,
      domain_entropy_topk: 0,
      max_domain_entropy: 0.55,
      expected_domain: 'beauty',
      cross_domain_ratio: 0,
      max_cross_domain_ratio: 0.2,
      reason: 'ok',
    });
  });

  test('cache quality score is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.computePrimaryQualityScore({
        count: 2,
        min_count: 4,
        anchor_ratio: 0.5,
        domain_entropy_topk: 0.275,
        max_domain_entropy: 0.55,
        cross_domain_ratio: 0.1,
        max_cross_domain_ratio: 0.2,
      }),
    ).toBe(0.5);
  });

  test('resolver fallback adoption accepts strong lookup queries even without relevance evidence', () => {
    const runtime = createCommerceResolutionRuntime({
      isProxySearchFallbackRelevant() {
        return false;
      },
    });

    expect(
      runtime.getResolverFallbackAdoptionDecision({
        result: {
          status: 200,
          usableCount: 1,
          data: {
            metadata: {
              query_source: 'agent_products_resolver_fallback',
              resolve_query_used: 'ipsa toner',
            },
          },
        },
        queryText: 'ipsa toner',
        queryClass: 'lookup',
      }),
    ).toEqual({
      adopt: true,
      reason: null,
      resolveQueryUsed: 'ipsa toner',
    });
  });

  test('resolver fallback adoption rejects beauty-query fallback that is irrelevant to original query', () => {
    const runtime = createCommerceResolutionRuntime({
      detectBeautyQueryBucket() {
        return 'skincare';
      },
      isProxySearchFallbackRelevant() {
        return true;
      },
    });

    expect(
      runtime.getResolverFallbackAdoptionDecision({
        result: {
          status: 200,
          usableCount: 1,
          data: {
            metadata: {
              query_source: 'agent_products_resolver_fallback',
            },
          },
        },
        queryText: 'repair serum',
        queryClass: 'category',
      }),
    ).toEqual({
      adopt: false,
      reason: 'resolver_irrelevant_to_original_query',
      resolveQueryUsed: 'repair serum',
    });
  });

  test('resolver fallback adoption rejects reference-only resolver payloads', () => {
    const runtime = createCommerceResolutionRuntime({
      isProxySearchFallbackRelevant() {
        return true;
      },
    });

    expect(
      runtime.getResolverFallbackAdoptionDecision({
        result: {
          status: 200,
          usableCount: 1,
          data: {
            metadata: {
              query_source: 'agent_products_resolver_ref_fallback',
              resolve_detail_source: 'reference_only',
              resolve_query_used: 'tom ford',
            },
          },
        },
        queryText: 'tom ford perfume',
        queryClass: 'brand',
      }),
    ).toEqual({
      adopt: false,
      reason: 'resolver_irrelevant_to_original_query',
      resolveQueryUsed: 'tom ford',
    });
  });

  test('adopted resolver fallback response shaping preserves clarification and clarify final decision', () => {
    const runtime = createCommerceResolutionRuntime({
      applyDealsToResponse(response) {
        return {
          ...response,
          metadata: {
            ...(response.metadata || {}),
            deals_applied: true,
          },
        };
      },
    });

    expect(
      runtime.shapeAdoptedResolverFallbackResponse({
        result: {
          data: {
            products: [],
            clarification: {
              question: 'Which toner did you mean?',
            },
            metadata: {
              query_source: 'agent_products_resolver_fallback',
            },
          },
        },
      }),
    ).toEqual({
      response: {
        products: [],
        clarification: {
          question: 'Which toner did you mean?',
        },
        metadata: {
          query_source: 'agent_products_resolver_fallback',
          deals_applied: true,
        },
      },
      clarification: {
        question: 'Which toner did you mean?',
      },
      finalDecision: 'clarify',
    });
  });

  test('adopted resolver fallback response shaping returns resolver_returned when no clarification exists', () => {
    const runtime = createCommerceResolutionRuntime({
      applyDealsToResponse(response) {
        return response;
      },
    });

    expect(
      runtime.shapeAdoptedResolverFallbackResponse({
        result: {
          data: {
            products: [{ id: 'p1' }],
            metadata: {
              query_source: 'agent_products_resolver_fallback',
            },
          },
        },
      }),
    ).toEqual({
      response: {
        products: [{ id: 'p1' }],
        metadata: {
          query_source: 'agent_products_resolver_fallback',
        },
      },
      clarification: null,
      finalDecision: 'resolver_returned',
    });
  });

  test('cache-miss resolver diagnostics state normalizes resolver-stage route health and trace state', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.buildCacheMissResolverFallbackDiagnosticsState({
        primaryLatencyMs: 37,
        ambiguityScorePre: 0.42,
        clarification: { question: 'Which toner?' },
        effectiveProducts: [{ id: 'p1' }, { id: 'p2' }],
        internalProductsAfterAnchor: [{ id: 'p1' }],
        retrievalSources: ['internal_cache'],
        cacheRouteDebug: { attempted: true },
      }),
    ).toEqual({
      routeHealthInput: {
        primaryPathUsed: 'resolver_stage',
        primaryLatencyMs: 37,
        fallbackTriggered: true,
        fallbackReason: 'resolver_after_cache_miss',
        ambiguityScorePre: 0.42,
        clarifyTriggered: true,
      },
      searchTraceState: {
        cacheStage: {
          hit: false,
          candidateCount: 2,
          relevantCount: 1,
          retrievalSources: ['internal_cache'],
          cacheRouteDebug: { attempted: true },
          selectedSource: 'resolver_fallback',
        },
        upstreamStage: {
          called: false,
          timeout: false,
          status: null,
          latency_ms: 0,
        },
        resolverStage: {
          called: true,
          hit: true,
          miss: false,
          latency_ms: null,
        },
        finalDecision: 'clarify',
      },
    });
  });

  test('cache-miss resolver diagnosed response builds route health and search trace through execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      applyDealsToResponse(response) {
        return {
          ...response,
          metadata: {
            ...(response.metadata || {}),
            deals_applied: true,
          },
        };
      },
      buildSearchRouteHealth(routeHealth) {
        return {
          ...routeHealth,
          normalized: true,
        };
      },
      buildCacheStageSnapshot(cacheStage) {
        return {
          ...cacheStage,
          snapshot: true,
        };
      },
      buildSearchTrace(searchTrace) {
        return {
          ...searchTrace,
          trace_normalized: true,
        };
      },
    });

    expect(
      runtime.buildCacheMissResolverFallbackDiagnosedResponse({
        result: {
          data: {
            products: [{ id: 'p1' }],
            metadata: {
              query_source: 'agent_products_resolver_fallback',
            },
          },
        },
        promotions: [],
        now: new Date('2026-03-26T00:00:00.000Z'),
        creatorId: 'creator-1',
        primaryLatencyMs: 41,
        ambiguityScorePre: 0.17,
        effectiveProducts: [{ id: 'p1' }],
        internalProductsAfterAnchor: [{ id: 'p1' }],
        retrievalSources: ['internal_cache'],
        cacheRouteDebug: { attempted: true },
        traceId: 'trace-1',
        rawQuery: 'ipsa toner',
        expandedQuery: 'ipsa toner',
        expansionMode: 'none',
        queryClass: 'lookup',
        rewriteGate: 'open',
        associationPlan: 'none',
        flagsSnapshot: { strict: true },
        intent: { query: 'ipsa toner' },
      }),
    ).toEqual({
      response: {
        products: [{ id: 'p1' }],
        metadata: {
          query_source: 'agent_products_resolver_fallback',
          deals_applied: true,
        },
        route_health: {
          primaryPathUsed: 'resolver_stage',
          primaryLatencyMs: 41,
          fallbackTriggered: true,
          fallbackReason: 'resolver_after_cache_miss',
          ambiguityScorePre: 0.17,
          clarifyTriggered: false,
          normalized: true,
        },
        search_trace: {
          traceId: 'trace-1',
          rawQuery: 'ipsa toner',
          expandedQuery: 'ipsa toner',
          expansionMode: 'none',
          queryClass: 'lookup',
          rewriteGate: 'open',
          associationPlan: 'none',
          flagsSnapshot: { strict: true },
          intent: { query: 'ipsa toner' },
          cacheStage: {
            hit: false,
            candidateCount: 1,
            relevantCount: 1,
            retrievalSources: ['internal_cache'],
            cacheRouteDebug: { attempted: true },
            selectedSource: 'resolver_fallback',
            snapshot: true,
          },
          upstreamStage: {
            called: false,
            timeout: false,
            status: null,
            latency_ms: 0,
          },
          resolverStage: {
            called: true,
            hit: true,
            miss: false,
            latency_ms: null,
          },
          finalDecision: 'resolver_returned',
          trace_normalized: true,
        },
      },
      clarification: null,
      finalDecision: 'resolver_returned',
    });
  });

  test('proxy-search resolver fallback response shaping returns respondSearch payload through execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.buildProxySearchResolverFallbackResponse({
        result: {
          status: 200,
          data: {
            products: [{ id: 'p1' }],
          },
        },
        fallbackReason: 'resolver_after_primary',
        upstreamStage: {
          called: true,
          timeout: false,
          status: 200,
          latency_ms: 21,
        },
        fallbackStrategy: {
          resolver_attempted: true,
        },
      }),
    ).toEqual({
      status: 200,
      data: {
        products: [{ id: 'p1' }],
      },
      respondSearchOptions: {
        finalDecision: 'resolver_returned',
        primaryPathUsed: 'proxy_search_primary',
        fallbackTriggered: true,
        fallbackReason: 'resolver_after_primary',
        upstreamStage: {
          called: true,
          timeout: false,
          status: 200,
          latency_ms: 21,
        },
        fallbackStrategy: {
          resolver_attempted: true,
        },
      },
    });
  });

  test('proxy-search resolver-first response shaping can override primary path through execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.buildProxySearchResolverFallbackResponse({
        result: {
          status: 200,
          data: {
            products: [{ id: 'p1' }],
          },
        },
        fallbackReason: 'resolver_first',
        primaryPathUsed: 'resolver_first',
        upstreamStage: {
          called: false,
          timeout: false,
          status: null,
          latency_ms: 0,
        },
      }),
    ).toEqual({
      status: 200,
      data: {
        products: [{ id: 'p1' }],
      },
      respondSearchOptions: {
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
        fallbackStrategy: null,
      },
    });
  });

  test('direct resolver fallback response shaping returns adopted payload through execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.buildDirectResolverFallbackResponse({
        result: {
          status: 200,
          data: {
            products: [{ id: 'p1' }],
          },
        },
      }),
    ).toEqual({
      status: 200,
      data: {
        products: [{ id: 'p1' }],
      },
    });
  });

  test('generic proxy fallback metadata patching is handled through execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.applyProxySearchFallbackMetadata(
        {
          products: [{ id: 'p1' }],
          metadata: {
            query_source: 'agent_products_search',
          },
        },
        {
          applied: false,
          reason: 'invoke_outer_cache_guard',
          route: 'invoke_outer_catch_cache_guard',
        },
      ),
    ).toEqual({
      products: [{ id: 'p1' }],
      metadata: {
        query_source: 'agent_products_search',
        proxy_search_fallback: {
          applied: false,
          reason: 'invoke_outer_cache_guard',
          route: 'invoke_outer_catch_cache_guard',
        },
      },
    });
  });

  test('generic proxy fallback metadata response builder returns shaped response through execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.buildProxySearchFallbackMetadataResponse({
        status: 200,
        body: {
          products: [{ id: 'p1' }],
        },
        patch: {
          applied: true,
          reason: 'primary_exception_cache_guard',
          route: 'invoke_exception_cache_guard',
          upstream_status: 504,
        },
      }),
    ).toEqual({
      status: 200,
      data: {
        products: [{ id: 'p1' }],
        metadata: {
          proxy_search_fallback: {
            applied: true,
            reason: 'primary_exception_cache_guard',
            route: 'invoke_exception_cache_guard',
            upstream_status: 504,
          },
        },
      },
    });
  });

  test('resolver reference-only result is built through execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.buildResolverReferenceOnlyResult({
        queryText: 'ipsa toner',
        resolved: {
          reason: 'detail_unavailable',
          reason_code: 'detail_unavailable_ref_only',
          confidence: 0.81,
          metadata: {
            latency_ms: 42,
          },
          candidates: [{ title: 'IPSA The Time Reset Aqua' }],
        },
        resolvedQueryUsed: 'ipsa toner',
        resolvedMerchantId: 'ipsa',
        resolvedProductId: 'sku-1',
        resolveSources: ['resolver'],
        reason: 'resolver_ref_only',
      }),
    ).toEqual({
      status: 200,
      usableCount: 1,
      resolved: true,
      resolve_reason: 'detail_unavailable',
      resolve_reason_code: 'detail_unavailable_ref_only',
      resolve_confidence: 0.81,
      resolve_latency_ms: 42,
      resolve_sources: ['resolver'],
      resolve_query_used: 'ipsa toner',
      data: {
        status: 'success',
        success: true,
        products: [
          {
            id: 'sku-1',
            product_id: 'sku-1',
            merchant_id: 'ipsa',
            platform_product_id: 'sku-1',
            title: 'IPSA The Time Reset Aqua',
            name: 'IPSA The Time Reset Aqua',
            canonical_product_ref: {
              merchant_id: 'ipsa',
              product_id: 'sku-1',
            },
          },
        ],
        total: 1,
        page: 1,
        page_size: 1,
        metadata: {
          query_source: 'agent_products_resolver_ref_fallback',
          resolve_reason: 'detail_unavailable',
          resolve_reason_code: 'detail_unavailable_ref_only',
          resolve_confidence: 0.81,
          resolve_latency_ms: 42,
          resolve_query_used: 'ipsa toner',
          resolve_detail_source: 'reference_only',
          proxy_search_fallback: {
            applied: true,
            reason: 'resolver_ref_only',
          },
        },
      },
    });
  });

  test('resolver success result is built through execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.buildResolverSuccessResult({
        queryText: 'ipsa toner',
        resolved: {
          reason: 'resolver_hit',
          reason_code: 'resolver_hit',
          confidence: 0.92,
          metadata: {
            latency_ms: 31,
          },
          candidates: [{ title: 'candidate title' }],
        },
        resolvedQueryUsed: 'ipsa toner',
        resolvedMerchantId: 'ipsa',
        resolvedProductId: 'sku-1',
        resolveSources: ['resolver', 'detail'],
        reason: 'resolver_fallback',
        detail: {
          id: 'sku-1',
          product_id: 'sku-1',
          merchant_id: 'ipsa',
          title: 'IPSA Toner',
        },
        detailSource: 'products_cache',
      }),
    ).toEqual({
      status: 200,
      usableCount: 1,
      resolved: true,
      resolve_reason: 'resolver_hit',
      resolve_reason_code: 'resolver_hit',
      resolve_confidence: 0.92,
      resolve_latency_ms: 31,
      resolve_sources: ['resolver', 'detail'],
      resolve_query_used: 'ipsa toner',
      data: {
        status: 'success',
        success: true,
        products: [
          {
            id: 'sku-1',
            product_id: 'sku-1',
            merchant_id: 'ipsa',
            title: 'IPSA Toner',
            name: 'IPSA Toner',
            platform_product_id: 'sku-1',
            canonical_product_ref: {
              merchant_id: 'ipsa',
              product_id: 'sku-1',
            },
          },
        ],
        total: 1,
        page: 1,
        page_size: 1,
        metadata: {
          query_source: 'agent_products_resolver_fallback',
          resolve_reason: 'resolver_hit',
          resolve_reason_code: 'resolver_hit',
          resolve_confidence: 0.92,
          resolve_latency_ms: 31,
          resolve_query_used: 'ipsa toner',
          resolve_detail_source: 'products_cache',
          proxy_search_fallback: {
            applied: true,
            reason: 'resolver_fallback',
          },
        },
      },
    });
  });

  test('resolver fallback query short-circuits on cached result through execution facade', async () => {
    const cachedResult = {
      status: 200,
      usableCount: 1,
      data: {
        products: [{ id: 'p1' }],
      },
    };
    const runtime = createCommerceResolutionRuntime({
      extractSearchQueryText(query) {
        return String(query?.query || '').trim();
      },
      firstQueryParamValue(value) {
        return value;
      },
      parseQueryStringArray() {
        return [];
      },
      uniqueStrings(values) {
        return values.filter(Boolean);
      },
      buildProxySearchResolverCacheKey() {
        return 'resolver-cache-key';
      },
      getProxySearchResolverCacheEntry() {
        return cachedResult;
      },
      resolverTimeoutMs: 900,
    });

    await expect(
      runtime.queryResolveSearchFallback({
        queryParams: { query: 'ipsa toner' },
      }),
    ).resolves.toBe(cachedResult);
  });

  test('resolver fallback query returns reference-only result for lookup-style detail miss through execution facade', async () => {
    const runtime = createCommerceResolutionRuntime({
      extractSearchQueryText(query) {
        return String(query?.query || '').trim();
      },
      firstQueryParamValue(value) {
        return value;
      },
      parseQueryStringArray() {
        return [];
      },
      uniqueStrings(values) {
        return values.filter(Boolean);
      },
      parseQueryBoolean() {
        return undefined;
      },
      buildProxySearchResolverCacheKey() {
        return 'resolver-cache-key';
      },
      getProxySearchResolverCacheEntry() {
        return null;
      },
      setProxySearchResolverCacheEntry() {},
      buildResolverQueryCandidates(query) {
        return [query];
      },
      resolveStableAliasByQuery() {
        return {
          title: 'IPSA The Time Reset Aqua',
          score: 0.98,
          product_ref: {
            merchant_id: 'ipsa',
            product_id: 'sku-1',
          },
        };
      },
      normalizeResolverText(value) {
        return String(value || '').trim().toLowerCase();
      },
      tokenizeResolverQuery(value) {
        return String(value || '').trim().split(/\s+/).filter(Boolean);
      },
      normalizeAgentProductsListResponse(body) {
        return body;
      },
      countUsableSearchProducts(products) {
        return Array.isArray(products) ? products.length : 0;
      },
      resolverDetailEnabled: true,
      productDetailStaleMaxAgeHours: 72,
      resolverDetailTimeoutMs: 400,
      resolverTimeoutMs: 900,
      resolverCacheTtlMs: 1000,
      resolverMissCacheTtlMs: 500,
      fetchProductDetailFromProductsCache: async () => null,
      fetchProductDetailFromUpstream: async () => null,
      isLookupStyleSearchQuery() {
        return true;
      },
      extractSearchAnchorTokens() {
        return ['ipsa', 'toner'];
      },
      logger: { warn() {}, info() {} },
    });

    await expect(
      runtime.queryResolveSearchFallback({
        queryParams: { query: 'ipsa toner' },
        reason: 'resolver_first',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 200,
        usableCount: 1,
        resolved: true,
        resolve_reason_code: 'stable_alias_match',
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            query_source: 'agent_products_resolver_ref_fallback',
            resolve_detail_source: 'reference_only',
          }),
        }),
      }),
    );
  });

  test('invoke resolver fallback response shaping adds proxy fallback metadata through execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.buildInvokeResolverFallbackResponse({
        result: {
          status: 200,
          data: {
            products: [{ id: 'p1' }],
            metadata: {
              query_source: 'agent_products_resolver_fallback',
            },
          },
        },
        fallbackReason: 'resolver_after_exception',
        route: 'invoke_exception_resolver',
        upstreamStatus: 504,
        upstreamErrorCode: 'ECONNABORTED',
        upstreamErrorMessage: 'timeout',
      }),
    ).toEqual({
      status: 200,
      data: {
        products: [{ id: 'p1' }],
        metadata: {
          query_source: 'agent_products_resolver_fallback',
          proxy_search_fallback: {
            applied: true,
            reason: 'resolver_after_exception',
            route: 'invoke_exception_resolver',
            upstream_status: 504,
            upstream_error_code: 'ECONNABORTED',
            upstream_error_message: 'timeout',
          },
        },
      },
    });
  });

  test('resolver fallback data extraction returns adopted response body', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.extractResolverFallbackData({
        status: 200,
        data: {
          products: [{ id: 'p1' }],
        },
      }),
    ).toEqual({
      products: [{ id: 'p1' }],
    });
  });

  test('product detail normalization is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.normalizeAgentProductDetailResponse({
        data: {
          product: {
            id: 'p1',
            title: 'IPSA Toner',
          },
        },
      }),
    ).toEqual({
      data: {
        product: {
          id: 'p1',
          title: 'IPSA Toner',
        },
      },
      product: {
        id: 'p1',
        title: 'IPSA Toner',
      },
    });

    expect(
      runtime.normalizeAgentProductDetailResponse({
        id: 'p2',
        title: 'Shiseido Serum',
      }),
    ).toEqual({
      status: 'success',
      success: true,
      product: {
        id: 'p2',
        title: 'Shiseido Serum',
      },
    });
  });

  test('soft fallback clarification shaping is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      isUpstreamQuotaExhausted() {
        return false;
      },
      shouldClarifyOnQuota() {
        return false;
      },
      normalizeTravelLookupSlotState(value) {
        return value
          ? {
              asked_slots: Array.isArray(value.asked_slots) ? value.asked_slots : [],
              resolved_slots:
                value.resolved_slots && typeof value.resolved_slots === 'object'
                  ? value.resolved_slots
                  : {},
            }
          : { asked_slots: [], resolved_slots: {} };
      },
      parseQueryJsonObject() {
        return null;
      },
      firstQueryParamValue(value) {
        return value;
      },
      hasTravelLookupSlotState(slotState) {
        return Array.isArray(slotState?.asked_slots) && slotState.asked_slots.length > 0;
      },
      buildClarification() {
        return {
          question: 'What budget range do you want?',
          options: ['$25', '$50'],
          reason_code: 'CLARIFY_BUDGET',
          slot: 'budget',
        };
      },
      buildClarificationReplyText(clarification) {
        return clarification.question;
      },
      normalizeAgentProductsListResponse(body) {
        return body;
      },
      parseQueryNumber(value) {
        return Number(value);
      },
    });

    expect(
      runtime.buildProxySearchSoftFallbackResponse({
        queryParams: {
          query: 'Face SPF50+ PA++++ sunscreen',
          ui_surface: 'travel_lookup',
          limit: '12',
        },
        slotStateInput: {
          asked_slots: ['brand'],
          resolved_slots: { brand: 'No brand preference' },
        },
        reason: 'primary_irrelevant_no_fallback',
        queryClass: 'attribute',
        intent: {
          language: 'en',
          query_class: 'attribute',
          primary_domain: 'beauty',
        },
        queryText: 'Face SPF50+ PA++++ sunscreen',
      }),
    ).toEqual({
      status: 'success',
      success: true,
      products: [],
      total: 0,
      page: 1,
      page_size: 12,
      reply: 'What budget range do you want?',
      clarification: {
        question: 'What budget range do you want?',
        options: ['$25', '$50'],
        reason_code: 'CLARIFY_BUDGET',
        slot: 'budget',
      },
      reason_codes: ['SEMANTIC_RETRY_EXHAUSTED', 'AMBIGUITY_CLARIFY'],
      metadata: {
        query_source: 'agent_products_error_fallback',
        upstream_status: 0,
        upstream_error_code: null,
        upstream_error_message: null,
        fallback_route: null,
        semantic_retry_applied: false,
        semantic_retry_query: null,
        semantic_retry_hits: 0,
        strict_empty: true,
        strict_empty_reason: 'primary_irrelevant_no_fallback',
        slot_state: {
          asked_slots: ['brand'],
          resolved_slots: {
            brand: 'No brand preference',
          },
        },
        proxy_search_fallback: {
          applied: true,
          reason: 'primary_irrelevant_no_fallback',
          route: null,
          upstream_status: 0,
          upstream_error_code: null,
          upstream_error_message: null,
        },
      },
    });
  });

  test('strict empty fallback shaping is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      withSearchDiagnostics(body, diagnostics) {
        return {
          ...body,
          metadata: {
            ...(body?.metadata || {}),
            ...(diagnostics?.strict_empty ? { strict_empty: true } : {}),
            ...(diagnostics?.strict_empty_reason
              ? { strict_empty_reason: diagnostics.strict_empty_reason }
              : {}),
            ...(diagnostics?.fallback_strategy
              ? { fallback_strategy: diagnostics.fallback_strategy }
              : {}),
          },
        };
      },
      normalizeAgentProductsListResponse(body) {
        return body;
      },
      parseQueryNumber(value) {
        return Number(value);
      },
    });

    expect(
      runtime.buildStrictEmptyFallbackResponse({
        queryParams: {
          query: 'ipsa toner',
          limit: '12',
        },
        reason: 'primary_status_5xx',
        upstreamStatus: 503,
        route: 'proxy_search_primary_status',
        fallbackStrategy: {
          resolver_attempted: false,
        },
      }),
    ).toEqual({
      status: 'success',
      success: true,
      products: [],
      total: 0,
      page: 1,
      page_size: 12,
      reply: 'Search is temporarily unavailable. Please retry shortly.',
      metadata: {
        query_source: 'agent_products_error_fallback',
        upstream_status: 503,
        upstream_error_code: null,
        upstream_error_message: null,
        fallback_route: 'proxy_search_primary_status',
        semantic_retry_applied: false,
        semantic_retry_query: null,
        semantic_retry_hits: 0,
        proxy_search_fallback: {
          applied: true,
          reason: 'primary_status_5xx',
          route: 'proxy_search_primary_status',
          upstream_status: 503,
          upstream_error_code: null,
          upstream_error_message: null,
        },
        strict_empty: true,
        strict_empty_reason: 'primary_status_5xx',
        fallback_strategy: {
          resolver_attempted: false,
        },
      },
    });
  });

  test('canonical search fallback reason is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.getCanonicalSearchFallbackReason({
        response: { status: 422 },
      }),
    ).toBe('status_422');
    expect(
      runtime.getCanonicalSearchFallbackReason({
        message: 'Nock: No match for request',
      }),
    ).toBe('contract_not_mocked');
    expect(
      runtime.getCanonicalSearchFallbackReason({
        response: { status: 500 },
        message: 'upstream exploded',
      }),
    ).toBe(null);
  });

  test('proxy search fallback gate is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      countUsableSearchProducts(products) {
        return Array.isArray(products) ? products.filter(Boolean).length : 0;
      },
    });

    expect(
      runtime.shouldFallbackProxySearch(
        {
          products: [],
          total: 0,
        },
        200,
      ),
    ).toBe(true);
    expect(
      runtime.shouldFallbackProxySearch(
        {
          products: [{ id: 'p1' }],
          total: 1,
        },
        200,
      ),
    ).toBe(false);
    expect(
      runtime.shouldFallbackProxySearch(
        {
          products: [{ id: 'p1' }],
          total: 1,
        },
        503,
      ),
    ).toBe(true);
  });

  test('fallback adopt usable threshold is owned by execution facade', () => {
    const auroraRuntime = createCommerceResolutionRuntime({
      isAuroraSource(source) {
        return source === 'aurora-bff';
      },
      auroraRelaxPrimaryIrrelevantAdopt: true,
    });
    const genericRuntime = createCommerceResolutionRuntime({
      isAuroraSource() {
        return false;
      },
    });

    expect(
      auroraRuntime.getFallbackAdoptUsableThreshold({
        operation: 'find_products_multi',
        source: 'aurora-bff',
        primaryUsableCount: 3,
        primaryIrrelevant: true,
      }),
    ).toBe(1);
    expect(
      genericRuntime.getFallbackAdoptUsableThreshold({
        operation: 'find_products_multi',
        source: 'shopping_agent',
        primaryUsableCount: 3,
        primaryIrrelevant: true,
      }),
    ).toBe(3);
  });

  test('fallback overlap preview is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      normalizeSearchTextForMatch(value) {
        return String(value || '').trim().toLowerCase();
      },
      tokenizeSearchTextForMatch(value) {
        return String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      },
      hasBeautyIngredientIntentSignal() {
        return false;
      },
      hasUsableSearchProduct(product) {
        return Boolean(product && product.id);
      },
      buildFallbackCandidateText(product) {
        return String(product?.title || '').trim().toLowerCase();
      },
    });

    expect(
      runtime.buildFallbackOverlapPreview(
        [
          { id: 'p1', title: 'IPSA toner refill' },
          { id: 'p2', title: 'Random body lotion' },
        ],
        'ipsa toner',
        3,
      ),
    ).toEqual([
      {
        product_id: 'p1',
        title: 'IPSA toner refill',
        overlap_count: 2,
        matched_tokens: ['ipsa', 'toner'],
      },
      {
        product_id: 'p2',
        title: 'Random body lotion',
        overlap_count: 0,
        matched_tokens: [],
      },
    ]);
  });

  test('proxy search fallback relevance is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      normalizeSearchTextForMatch(value) {
        return String(value || '').trim().toLowerCase();
      },
      tokenizeSearchTextForMatch(value) {
        return String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      },
      hasUsableSearchProduct(product) {
        return Boolean(product && product.id);
      },
      buildFallbackCandidateText(product) {
        return String(product?.title || '').trim().toLowerCase();
      },
      hasBeautyIngredientIntentSignal() {
        return false;
      },
      extractSearchAnchorTokens(query) {
        return String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      },
      expandLookupAnchorTokens(_, anchorTokens) {
        return anchorTokens;
      },
      detectBeautyQueryBucket() {
        return null;
      },
      isLookupStyleSearchQuery() {
        return false;
      },
      hasPetHarnessSearchSignal() {
        return false;
      },
      hasFragranceQuerySignal() {
        return false;
      },
    });

    expect(
      runtime.isProxySearchFallbackRelevant(
        {
          products: [{ id: 'p1', title: 'IPSA toner refill' }],
        },
        'ipsa toner',
      ),
    ).toBe(true);
    expect(
      runtime.isProxySearchFallbackRelevant(
        {
          products: [{ id: 'p2', title: 'random body lotion' }],
        },
        'ipsa toner',
      ),
    ).toBe(false);
  });

  test('resolver miss timeout reduction is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      hasPetSearchSignal() {
        return false;
      },
      normalizeOffersResolveReasonCode(value) {
        return String(value || '').trim().toLowerCase();
      },
    });

    expect(
      runtime.shouldReducePrimaryTimeoutAfterResolverMiss(
        {
          usableCount: 0,
          resolve_reason_code: 'NO_CANDIDATES',
        },
        'ipsa toner',
      ),
    ).toBe(true);
    expect(
      runtime.shouldReducePrimaryTimeoutAfterResolverMiss(
        {
          usableCount: 1,
          resolve_reason_code: 'NO_CANDIDATES',
        },
        'ipsa toner',
      ),
    ).toBe(false);
  });

  test('resolver miss secondary fallback skip reason preserves lookup alias retries', () => {
    const runtime = createCommerceResolutionRuntime({
      hasPetSearchSignal() {
        return false;
      },
      hasFragranceQuerySignal() {
        return false;
      },
      normalizeOffersResolveReasonCode(value) {
        return String(value || '').trim().toLowerCase();
      },
      isKnownLookupAliasQuery(query) {
        return query === 'ipsa toner';
      },
      extractSearchAnchorTokens() {
        return ['ipsa', 'toner'];
      },
      isLookupStyleSearchQuery() {
        return true;
      },
      skipSecondaryFallbackAfterResolverMissEnabled: true,
      simplifyGateEnabled: true,
      lookupOnlyResolverEnabled: true,
    });

    expect(
      runtime.getSecondaryFallbackSkipReason(
        {
          usableCount: 0,
          resolve_reason_code: 'no_candidates',
        },
        'ipsa toner',
        {
          queryClass: 'lookup',
        },
      ),
    ).toBe(null);
    expect(
      runtime.shouldSkipSecondaryFallbackAfterResolverMiss(
        {
          usableCount: 0,
          resolve_reason_code: 'no_candidates',
        },
        'ipsa toner',
        {
          queryClass: 'lookup',
        },
      ),
    ).toBe(false);
  });

  test('resolver fallback allow gate is owned by execution facade', () => {
    const enabledRuntime = createCommerceResolutionRuntime({
      resolverFallbackEnabled: true,
    });
    const disabledRuntime = createCommerceResolutionRuntime({
      resolverFallbackEnabled: false,
    });

    expect(enabledRuntime.shouldAllowResolverFallback('find_products_multi')).toBe(true);
    expect(disabledRuntime.shouldAllowResolverFallback('find_products_multi')).toBe(false);
    expect(enabledRuntime.shouldAllowResolverFallback('create_order')).toBe(false);
  });

  test('secondary fallback allow gate is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      secondaryFallbackMultiEnabled: false,
    });

    expect(runtime.shouldAllowSecondaryFallback('find_products')).toBe(true);
    expect(runtime.shouldAllowSecondaryFallback('find_products_multi')).toBe(false);
    expect(
      runtime.shouldAllowSecondaryFallback('find_products_multi', {
        forceSecondaryFallback: true,
      }),
    ).toBe(true);
  });

  test('invoke fallback allow gate is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      invokeFallbackEnabled: false,
    });

    expect(runtime.shouldAllowInvokeFallback('find_products')).toBe(false);
    expect(
      runtime.shouldAllowInvokeFallback('find_products_multi', {
        forceInvokeFallback: true,
      }),
    ).toBe(true);
    expect(runtime.shouldAllowInvokeFallback('create_order')).toBe(false);
  });

  test('secondary fallback bypass-on-primary-exception is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.shouldBypassSecondaryFallbackSkipOnPrimaryException({
        err: {
          response: {
            status: 504,
          },
        },
      }),
    ).toBe(true);
    expect(
      runtime.shouldBypassSecondaryFallbackSkipOnPrimaryException({
        err: {
          code: 'ECONNABORTED',
        },
      }),
    ).toBe(true);
    expect(
      runtime.shouldBypassSecondaryFallbackSkipOnPrimaryException({
        err: {
          message: 'validation error',
        },
      }),
    ).toBe(false);
  });

  test('strong resolver-first query detection is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      buildResolverQueryCandidates(query) {
        return [query, `${query} refill`];
      },
      normalizeResolverText(value) {
        return String(value || '').trim().toLowerCase();
      },
      tokenizeResolverQuery(value) {
        return String(value || '').trim().split(/\s+/).filter(Boolean);
      },
      resolveStableAliasByQuery({ normalizedQuery }) {
        if (normalizedQuery === 'the time reset aqua') {
          return {
            product_ref: {
              merchant_id: 'ipsa',
              product_id: 'sku-1',
            },
          };
        }
        return null;
      },
    });

    expect(runtime.isStrongResolverFirstQuery('the time reset aqua')).toBe(true);
    expect(runtime.isStrongResolverFirstQuery('generic toner')).toBe(false);
  });

  test('resolver-first search gate is owned by execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      resolverFirstEnabled: true,
      resolverFirstStrongOnly: true,
      simplifyGateEnabled: true,
      lookupOnlyResolverEnabled: true,
      normalizeAgentSource(value) {
        return String(value || '').trim().toLowerCase();
      },
      isCreatorUiSource(source) {
        return source === 'creator-ui';
      },
      isResolverFirstCatalogSource(source) {
        return source === 'search';
      },
      isAuroraSource(source) {
        return source === 'aurora-bff';
      },
      isKnownLookupAliasQuery(query) {
        return query === 'ipsa toner';
      },
      extractSearchAnchorTokens() {
        return ['ipsa', 'toner'];
      },
      isLookupStyleSearchQuery() {
        return true;
      },
      extractGuidanceRetrievalContext() {
        return {};
      },
      hasGuidanceLookupStyleQuery() {
        return false;
      },
      resolverMinRemainingBudgetMs: 200,
    });

    expect(
      runtime.shouldUseResolverFirstSearch({
        operation: 'find_products_multi',
        metadata: { source: 'search' },
        queryText: 'ipsa toner',
        remainingBudgetMs: 500,
        queryClass: 'lookup',
      }),
    ).toBe(true);
    expect(
      runtime.shouldUseResolverFirstSearch({
        operation: 'find_products_multi',
        metadata: { source: 'creator-ui' },
        queryText: 'ipsa toner',
        remainingBudgetMs: 500,
        queryClass: 'lookup',
      }),
    ).toBe(false);
  });

  test('resolver-first strong alias query is not blocked only because it is brand-like', () => {
    const runtime = createCommerceResolutionRuntime({
      resolverFirstEnabled: true,
      resolverFirstStrongOnly: true,
      simplifyGateEnabled: true,
      lookupOnlyResolverEnabled: true,
      normalizeAgentSource(value) {
        return String(value || '').trim().toLowerCase();
      },
      isCreatorUiSource() {
        return false;
      },
      isResolverFirstCatalogSource(source) {
        return source === 'shopping_agent';
      },
      isAuroraSource() {
        return false;
      },
      extractGuidanceRetrievalContext() {
        return {};
      },
      hasGuidanceLookupStyleQuery() {
        return false;
      },
      buildResolverQueryCandidates(query) {
        return [query];
      },
      normalizeResolverText(value) {
        return String(value || '').trim().toLowerCase();
      },
      tokenizeResolverQuery(value) {
        return String(value || '').trim().split(/\s+/).filter(Boolean);
      },
      resolveStableAliasByQuery({ normalizedQuery }) {
        if (normalizedQuery === 'the ordinary niacinamide 10 zinc 1') {
          return {
            product_ref: {
              merchant_id: 'ordinary',
              product_id: 'sku-ordinary-1',
            },
          };
        }
        return null;
      },
      isLookupStyleSearchQuery() {
        return false;
      },
      resolverMinRemainingBudgetMs: 200,
    });

    expect(
      runtime.shouldUseResolverFirstSearch({
        operation: 'find_products_multi',
        metadata: { source: 'shopping_agent' },
        queryText: 'The Ordinary Niacinamide 10 Zinc 1',
        remainingBudgetMs: 500,
        queryClass: 'exploratory',
        brandLike: true,
      }),
    ).toBe(true);
  });

  test('find_products_multi fallback selection returns null when payload cannot be built', async () => {
    const runtime = createCommerceResolutionRuntime({
      buildFindProductsMultiPayloadFromQuery() {
        return null;
      },
    });

    await expect(
      runtime.queryFindProductsMultiFallback({
        queryParams: {
          query: 'repair serum',
        },
        requestSource: 'search',
        reason: 'primary_irrelevant',
      }),
    ).resolves.toBeNull();
  });

  test('find_products_multi fallback selection is owned by execution facade', async () => {
    const capturedAttempts = [];
    const runtime = createCommerceResolutionRuntime({
      buildFindProductsMultiPayloadFromQuery(queryParams) {
        return {
          search: {
            query: String(queryParams?.query || ''),
            limit: 12,
            offset: 0,
          },
          metadata: {
            source: 'search',
          },
        };
      },
      getProxySearchApiBase() {
        return 'https://pivota.test';
      },
      isAuroraSource(source) {
        return source === 'aurora-bff';
      },
      proxySearchAuroraPreserveSourceOnInvoke: true,
      proxySearchAuroraPrimaryIrrelevantSemanticRetryEnabled: true,
      searchExternalHardRulePrune: false,
      proxySearchFallbackTimeoutMs: 800,
      proxySearchAuroraFallbackTimeoutMs: 600,
      buildAuroraPrimaryIrrelevantSemanticRetryQueries() {
        return ['repair barrier serum'];
      },
      hasFragranceSearchSignal() {
        return false;
      },
      normalizeSearchTextForMatch(value) {
        return String(value || '').trim().toLowerCase();
      },
      async invokeFindProductsMultiFallbackOnce(input) {
        capturedAttempts.push({
          attemptNo: input.attemptNo,
          query: input.payload?.search?.query,
          useSearchEndpoint: input.useSearchEndpoint,
          timeoutMs: input.timeoutMs,
          requestSource: input.requestSource,
        });

        if (input.attemptNo === 1) {
          return {
            status: 200,
            usableCount: 1,
            relevanceMatched: false,
            targetRelevantCount: 0,
            targetRelevanceCounts: null,
            top3QualityScore: 8,
            queryUsed: 'repair serum',
            productsPreview: [],
            data: { products: [{ product_id: 'p1' }] },
          };
        }

        return {
          status: 200,
          usableCount: 3,
          relevanceMatched: true,
          targetRelevantCount: 2,
          targetRelevanceCounts: {
            target: 2,
          },
          top3QualityScore: 34,
          queryUsed: 'repair barrier serum',
          productsPreview: [{ product_id: 'p2' }],
          data: { products: [{ product_id: 'p2' }] },
        };
      },
    });

    await expect(
      runtime.queryFindProductsMultiFallback({
        queryParams: {
          query: 'repair serum',
        },
        checkoutToken: 'checkout-token',
        requestSource: 'aurora-bff',
        reason: 'primary_irrelevant',
        timeoutMs: 500,
      }),
    ).resolves.toEqual({
      status: 200,
      usableCount: 3,
      relevanceMatched: true,
      targetRelevantCount: 2,
      targetRelevanceCounts: {
        target: 2,
      },
      top3QualityScore: 34,
      selectedQuery: 'repair barrier serum',
      selectedAttemptNo: 2,
      semanticRetryApplied: true,
      semanticRetryQuery: 'repair barrier serum',
      semanticRetryHits: 3,
      actualRetryAttempted: true,
      attempts: [
        {
          attempt: 1,
          query: 'repair serum',
          status: 200,
          usable_count: 1,
          target_relevant_count: 0,
          relevance_matched: false,
          products_preview: [],
        },
        {
          attempt: 2,
          query: 'repair barrier serum',
          status: 200,
          usable_count: 3,
          target_relevant_count: 2,
          relevance_matched: true,
          products_preview: [{ product_id: 'p2' }],
        },
      ],
      data: { products: [{ product_id: 'p2' }] },
    });

    expect(capturedAttempts).toHaveLength(2);
    expect(capturedAttempts[0]).toEqual(
      expect.objectContaining({
        attemptNo: 1,
        query: 'repair serum',
        useSearchEndpoint: false,
        requestSource: 'aurora-bff',
      }),
    );
    expect(capturedAttempts[1]).toEqual(
      expect.objectContaining({
        attemptNo: 2,
        query: 'repair barrier serum',
        useSearchEndpoint: true,
        requestSource: 'aurora-bff',
      }),
    );
    expect(capturedAttempts[0].timeoutMs).toBeGreaterThanOrEqual(100);
    expect(capturedAttempts[1].timeoutMs).toBeGreaterThanOrEqual(100);
  });

  test('find_products_multi fallback invoke helper is owned by execution facade', async () => {
    const capturedRequests = [];
    const runtime = createCommerceResolutionRuntime({
      httpRequest(requestConfig) {
        capturedRequests.push(requestConfig);
        return Promise.resolve({
          status: 200,
          data: {
            products: [{ product_id: 'p1', title: 'IPSA Toner' }],
          },
        });
      },
      buildInvokeUpstreamAuthHeaders({ checkoutToken }) {
        return checkoutToken ? { Authorization: `Bearer ${checkoutToken}` } : {};
      },
      normalizeAgentProductsListResponse(body) {
        return body;
      },
      countUsableSearchProducts(products) {
        return Array.isArray(products) ? products.length : 0;
      },
      parseQueryNumber(value) {
        return Number(value);
      },
      normalizeSearchTextForMatch(value) {
        return String(value || '').trim().toLowerCase();
      },
      summarizeGuidanceCandidatePool() {
        return {
          target_relevant_count: 1,
          counts: { strong_goal_family: 1 },
          top3_quality_score: 120,
        };
      },
    });

    await expect(
      runtime.invokeFindProductsMultiFallbackOnce({
        url: 'https://pivota.test/agent/shop/v1/invoke',
        searchUrl: 'https://pivota.test/agent/v1/products/search',
        payload: {
          search: {
            query: 'ipsa toner',
            limit: 12,
            offset: 0,
          },
        },
        checkoutToken: 'checkout-token',
        requestSource: 'search',
        triggerReason: 'primary_irrelevant',
        preserveAuroraSource: false,
        fallbackSource: 'agent_search_proxy_fallback',
        relevanceQuery: 'ipsa toner',
        attemptNo: 1,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 200,
        usableCount: 1,
        relevanceMatched: true,
        targetRelevantCount: 1,
        top3QualityScore: 120,
        queryUsed: 'ipsa toner',
      }),
    );

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toEqual(
      expect.objectContaining({
        method: 'POST',
        url: 'https://pivota.test/agent/shop/v1/invoke',
        timeout: expect.any(Number),
        headers: expect.objectContaining({
          Authorization: 'Bearer checkout-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  test('secondary fallback outcome adopts lookup-like fallback through execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      isKnownLookupAliasQuery(query) {
        return query === 'ipsa toner';
      },
      extractSearchAnchorTokens() {
        return ['ipsa', 'toner'];
      },
      isLookupStyleSearchQuery() {
        return true;
      },
    });

    expect(
      runtime.getSecondaryFallbackOutcomeDecision({
        fallback: {
          status: 200,
          usableCount: 2,
          relevanceMatched: true,
          selectedAttemptNo: 1,
          selectedQuery: 'ipsa toner',
          attempts: [{ query: 'ipsa toner' }],
          data: { products: [{ product_id: 'p1' }] },
        },
        queryText: 'ipsa toner',
        queryClass: 'lookup',
        primaryUsableCount: 0,
        primaryUnusable: true,
      }),
    ).toEqual(
      expect.objectContaining({
        decision: 'adopt',
        reason: 'secondary_after_primary_unusable',
        fallbackRelevant: true,
        usableCount: 2,
      }),
    );
  });

  test('secondary fallback outcome clarifies semantic retry for non-resolution query through execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      extractSearchAnchorTokens() {
        return [];
      },
      isLookupStyleSearchQuery() {
        return false;
      },
      isProxySearchFallbackRelevant() {
        return true;
      },
    });

    expect(
      runtime.getSecondaryFallbackOutcomeDecision({
        fallback: {
          status: 200,
          usableCount: 4,
          relevanceMatched: true,
          actualRetryAttempted: true,
          selectedAttemptNo: 2,
          selectedQuery: 'travel skincare set',
          attempts: [
            { query: 'travel essentials' },
            { query: 'travel skincare set' },
          ],
          data: { products: [{ product_id: 'p1' }] },
        },
        queryText: 'travel essentials',
        queryClass: 'scenario',
        primaryUsableCount: 1,
        primaryIrrelevant: true,
      }),
    ).toEqual(
      expect.objectContaining({
        decision: 'clarify',
        reason: 'primary_irrelevant_no_fallback',
        rejectionReason: 'secondary_not_resolution_like',
        querySource: 'agent_products_semantic_retry_exhausted',
      }),
    );
  });

  test('secondary fallback outcome returns strict empty for non-adopted non-resolution miss through execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      extractSearchAnchorTokens() {
        return [];
      },
      isLookupStyleSearchQuery() {
        return false;
      },
      isProxySearchFallbackRelevant() {
        return false;
      },
    });

    expect(
      runtime.getSecondaryFallbackOutcomeDecision({
        fallback: {
          status: 200,
          usableCount: 0,
          relevanceMatched: false,
          selectedAttemptNo: 1,
          selectedQuery: 'blue sweater',
          attempts: [{ query: 'blue sweater' }],
          data: { products: [] },
        },
        queryText: 'blue sweater',
        queryClass: 'category',
        primaryUsableCount: 0,
      }),
    ).toEqual(
      expect.objectContaining({
        decision: 'strict_empty',
        reason: 'fallback_not_better',
        rejectionReason: 'secondary_below_usable_threshold',
      }),
    );
  });

  test('secondary fallback outcome rejects weak semantic-retry lookup evidence through execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      extractSearchAnchorTokens() {
        return ['ipsa', 'toner'];
      },
      isLookupStyleSearchQuery() {
        return true;
      },
      isProxySearchFallbackRelevant() {
        return true;
      },
    });

    expect(
      runtime.getSecondaryFallbackOutcomeDecision({
        fallback: {
          status: 200,
          usableCount: 2,
          relevanceMatched: true,
          actualRetryAttempted: true,
          targetRelevantCount: 0,
          top3QualityScore: 40,
          selectedAttemptNo: 2,
          selectedQuery: 'ipsa balancing toner',
          attempts: [
            { query: 'ipsa toner' },
            { query: 'ipsa balancing toner' },
          ],
          data: { products: [{ product_id: 'p1' }] },
        },
        queryText: 'ipsa toner',
        queryClass: 'lookup',
        primaryUsableCount: 0,
        primaryUnusable: true,
      }),
    ).toEqual(
      expect.objectContaining({
        decision: 'clarify',
        reason: 'semantic_retry_exhausted',
        rejectionReason: 'secondary_semantic_retry_not_adoptable',
        strongAdoptionEvidence: false,
      }),
    );
  });

  test('primary fallback outcome returns strict empty for unusable primary without trusted adoption through execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.getPrimaryFallbackOutcomeDecision({
        shouldFallback: true,
        primaryUsableCount: 0,
        primaryUnusable: true,
        primaryIrrelevant: false,
        primaryLowQualityNonempty: false,
        skipSecondaryFallback: false,
        secondaryFallbackOutcome: null,
        semanticRetryApplied: false,
        fallbackNotBetterReason: 'fallback_not_better',
      }),
    ).toEqual(
      expect.objectContaining({
        decision: 'strict_empty',
        reason: 'primary_unusable_no_fallback',
        querySource: 'agent_products_error_fallback',
      }),
    );
  });

  test('primary fallback outcome clarifies low-quality semantic retry through execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.getPrimaryFallbackOutcomeDecision({
        shouldFallback: true,
        primaryUsableCount: 2,
        primaryLowQualityNonempty: true,
        semanticRetryApplied: true,
        fallbackNotBetterReason: 'low_quality_semantic_retry_exhausted',
      }),
    ).toEqual(
      expect.objectContaining({
        decision: 'clarify',
        reason: 'low_quality_semantic_retry_exhausted',
        querySource: 'agent_products_semantic_retry_exhausted',
      }),
    );
  });

  test('primary fallback outcome preserves a locked authority instead of re-adopting fallback through execution facade', () => {
    const runtime = createCommerceResolutionRuntime();

    expect(
      runtime.getPrimaryFallbackOutcomeDecision({
        shouldFallback: true,
        decisionLocked: true,
        decisionAuthority: 'cache_cross_merchant_search',
        decisionLockReason: 'cache_main_path',
        primaryUsableCount: 2,
        primaryIrrelevant: true,
      }),
    ).toEqual(
      expect.objectContaining({
        decision: 'authority_locked',
        reason: 'cache_main_path',
        querySource: 'cache_cross_merchant_search',
      }),
    );
  });

  test('primary search quality decision marks weak lookup evidence as low-quality through execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      buildFallbackCandidateText(product) {
        return String(product?.title || '').trim().toLowerCase();
      },
      extractSearchAnchorTokens() {
        return ['ipsa', 'toner'];
      },
      isLookupStyleSearchQuery() {
        return true;
      },
    });

    expect(
      runtime.getPrimarySearchQualityDecision({
        products: [{ product_id: 'p1', title: 'IPSA balancing lotion' }],
        queryText: 'ipsa toner',
        queryClass: 'lookup',
        primaryQualityGate: {
          enabled: true,
          accepted: true,
          reason: 'ok',
        },
        lowQualityNonempty: false,
        usableCount: 1,
      }),
    ).toEqual({
      lowQualityNonempty: true,
      reason: 'weak_resolution_evidence',
      queryType: 'lookup_like',
      targetRelevantCount: 0,
      top3QualityScore: 35,
      strongEvidencePassed: false,
    });
  });

  test('primary search quality decision does not force generic query into low-quality through execution facade', () => {
    const runtime = createCommerceResolutionRuntime({
      buildFallbackCandidateText(product) {
        return String(product?.title || '').trim().toLowerCase();
      },
      extractSearchAnchorTokens() {
        return ['blue', 'sweater'];
      },
      isLookupStyleSearchQuery() {
        return false;
      },
    });

    expect(
      runtime.getPrimarySearchQualityDecision({
        products: [{ product_id: 'p1', title: 'Blue striped sweater' }],
        queryText: 'blue sweater',
        queryClass: 'category',
        primaryQualityGate: {
          enabled: true,
          accepted: true,
          reason: 'ok',
        },
        lowQualityNonempty: false,
        usableCount: 1,
      }),
    ).toEqual({
      lowQualityNonempty: false,
      reason: null,
      queryType: 'generic',
      targetRelevantCount: 0,
      top3QualityScore: null,
      strongEvidencePassed: null,
    });
  });
});
