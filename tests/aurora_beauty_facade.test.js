const {
  createAuroraBeautyOrchestrationRuntime,
} = require('../src/modules/orchestration/aurora_beauty');

describe('Aurora beauty orchestration facade', () => {
  test('aurora source plan owns find_products_multi override strategy', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeAgentSource(value) {
        return String(value || '').trim().toLowerCase();
      },
      isAuroraSource(value) {
        return String(value || '').trim().toLowerCase() === 'aurora-bff';
      },
      getAuroraFallbackOverrides(source, operation) {
        const active =
          String(source || '').trim().toLowerCase() === 'aurora-bff' &&
          String(operation || '').trim() === 'find_products_multi';
        return {
          active,
          strategySource: active ? 'aurora_force_path' : 'default',
          disableSkipAfterResolverMiss: active,
          forceSecondaryFallback: active,
          forceInvokeFallback: active,
        };
      },
      auroraResolverTimeoutMs: () => 1800,
      defaultResolverTimeoutMs: () => 900,
      auroraBypassCacheStrictEmptyEnabled: () => true,
    });

    expect(
      runtime.buildAuroraFindProductsMultiPlan({
        source: 'aurora-bff',
        operation: 'find_products_multi',
      }),
    ).toEqual({
      source: 'aurora-bff',
      auroraSource: true,
      operation: 'find_products_multi',
      fallbackOverrides: {
        active: true,
        strategySource: 'aurora_force_path',
        disableSkipAfterResolverMiss: true,
        forceSecondaryFallback: true,
        forceInvokeFallback: true,
      },
      resolverTimeoutMs: 1800,
      bypassCacheStrictEmpty: true,
    });
  });

  test('non-aurora or non-find_products_multi plan falls back to default orchestration strategy', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeAgentSource(value) {
        return String(value || '').trim().toLowerCase();
      },
      isAuroraSource(value) {
        return String(value || '').trim().toLowerCase() === 'aurora-bff';
      },
      getAuroraFallbackOverrides() {
        return {
          active: false,
          strategySource: 'default',
          disableSkipAfterResolverMiss: false,
          forceSecondaryFallback: false,
          forceInvokeFallback: false,
        };
      },
      auroraResolverTimeoutMs: () => 1800,
      defaultResolverTimeoutMs: () => 900,
      auroraBypassCacheStrictEmptyEnabled: () => true,
    });

    expect(
      runtime.buildAuroraFindProductsMultiPlan({
        source: 'shopping_agent',
        operation: 'find_products_multi',
      }),
    ).toEqual({
      source: 'shopping_agent',
      auroraSource: false,
      operation: 'find_products_multi',
      fallbackOverrides: {
        active: false,
        strategySource: 'default',
        disableSkipAfterResolverMiss: false,
        forceSecondaryFallback: false,
        forceInvokeFallback: false,
      },
      resolverTimeoutMs: 900,
      bypassCacheStrictEmpty: false,
    });

    expect(
      runtime.buildAuroraFindProductsMultiPlan({
        source: 'aurora-bff',
        operation: 'find_products',
      }),
    ).toEqual({
      source: 'aurora-bff',
      auroraSource: true,
      operation: 'find_products',
      fallbackOverrides: {
        active: false,
        strategySource: 'default',
        disableSkipAfterResolverMiss: false,
        forceSecondaryFallback: false,
        forceInvokeFallback: false,
      },
      resolverTimeoutMs: 900,
      bypassCacheStrictEmpty: false,
    });
  });

  test('guidance-only surface suppresses legacy clarification inside aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeSearchUiSurface(value) {
        return String(value || '').trim().toLowerCase();
      },
    });

    expect(
      runtime.buildGuidanceOnlyClarificationPlan({
        uiSurface: 'ingredient_plan_guidance_only',
        clarification: { question: 'Which concern matters most?' },
        reasonCodes: ['AMBIGUITY_CLARIFY', 'KEEP_ME'],
        querySource: 'agent_products_search',
      }),
    ).toEqual({
      uiSurface: 'ingredient_plan_guidance_only',
      guidanceOnlySurface: true,
      suppressLegacyClarification: true,
      filteredReasonCodes: ['KEEP_ME'],
      legacyFallbackSuppressed: false,
    });
  });

  test('guidance-only surface marks legacy fallback suppression for aurora orchestration plan', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeSearchUiSurface(value) {
        return String(value || '').trim().toLowerCase();
      },
    });

    expect(
      runtime.buildGuidanceOnlyClarificationPlan({
        uiSurface: 'ingredient_plan_guidance_only',
        clarification: null,
        reasonCodes: [],
        querySource: 'agent_products_error_fallback',
      }),
    ).toEqual({
      uiSurface: 'ingredient_plan_guidance_only',
      guidanceOnlySurface: true,
      suppressLegacyClarification: true,
      filteredReasonCodes: [],
      legacyFallbackSuppressed: true,
    });
  });

  test('guidance-only search state plan owns session loading and persistence decisions', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeSearchUiSurface(value) {
        return String(value || '').trim().toLowerCase();
      },
    });

    expect(
      runtime.buildGuidanceOnlySearchStatePlan({
        uiSurface: 'ingredient_plan_guidance_only',
        requestedTargetStepFamily: 'cleanser',
        clarification: { question: 'Which texture?' },
        reasonCodes: ['AMBIGUITY_CLARIFY'],
        querySource: 'agent_products_search',
      }),
    ).toEqual({
      uiSurface: 'ingredient_plan_guidance_only',
      guidanceOnlySurface: true,
      shouldApplyGuidanceOnlyHitQuality: true,
      shouldLoadSessionSeenProducts: true,
      shouldPersistSeenProducts: true,
      clarificationPlan: {
        uiSurface: 'ingredient_plan_guidance_only',
        guidanceOnlySurface: true,
        suppressLegacyClarification: true,
        filteredReasonCodes: [],
        legacyFallbackSuppressed: false,
      },
    });
  });

  test('non-guidance surface does not request guidance-only session orchestration', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeSearchUiSurface(value) {
        return String(value || '').trim().toLowerCase();
      },
    });

    expect(
      runtime.buildGuidanceOnlySearchStatePlan({
        uiSurface: 'travel_lookup',
        requestedTargetStepFamily: 'cleanser',
        clarification: null,
        reasonCodes: [],
        querySource: 'agent_products_search',
      }),
    ).toEqual({
      uiSurface: 'travel_lookup',
      guidanceOnlySurface: false,
      shouldApplyGuidanceOnlyHitQuality: false,
      shouldLoadSessionSeenProducts: false,
      shouldPersistSeenProducts: false,
      clarificationPlan: {
        uiSurface: 'travel_lookup',
        guidanceOnlySurface: false,
        suppressLegacyClarification: false,
        filteredReasonCodes: [],
        legacyFallbackSuppressed: false,
      },
    });
  });

  test('guidance-only hit-quality outcome merge is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeSearchUiSurface(value) {
        return String(value || '').trim().toLowerCase();
      },
      isExternalSeedProduct(product) {
        return product?.merchant_id === 'external_seed';
      },
      countCandidateOriginBreakdown(products) {
        return { internal: Array.isArray(products) ? products.length : 0 };
      },
      mergeSearchCountMaps(...maps) {
        return Object.assign({}, ...maps.filter(Boolean));
      },
    });

    const guidancePlan = runtime.buildGuidanceOnlySearchStatePlan({
      uiSurface: 'ingredient_plan_guidance_only',
      requestedTargetStepFamily: 'cleanser',
      clarification: { question: 'Which texture?' },
      reasonCodes: ['AMBIGUITY_CLARIFY', 'KEEP_ME'],
      querySource: 'agent_products_error_fallback',
    });

    expect(
      runtime.applyGuidanceOnlyHitQualityOutcome({
        response: {
          products: [
            { product_id: 'sku_1', merchant_id: 'merchant_internal' },
            { product_id: 'seed_1', merchant_id: 'external_seed' },
          ],
          total: 2,
          page_size: 2,
          clarification: { question: 'Which texture?' },
          reason_codes: ['AMBIGUITY_CLARIFY', 'KEEP_ME'],
          metadata: {
            query_source: 'agent_products_error_fallback',
            source_breakdown: {
              internal_count: 1,
              external_seed_count: 1,
              stale_cache_used: false,
            },
            guidance_direct_external_seed_applied: true,
            guidance_direct_external_seed_valid_hit: true,
            search_decision: {
              existing_field: true,
            },
          },
        },
        guidancePlan,
        guidanceDecision: {
          applied: true,
          contract_version: 'beauty_v1',
          hit_quality: 'valid_hit',
          query_target_step_family: 'cleanser',
          query_step_strength: 'exact_step',
          candidate_class_counts: { core: 1 },
          target_relevance_class_counts: { target: 1 },
          noise_drop_counts: { noise: 0 },
          valid_products: [{ product_id: 'sku_1', merchant_id: 'merchant_internal' }],
          products_returned_count: 1,
          fallback_mode: 'normal',
        },
        sourcePolicy: 'guided_only',
        productOnlyApplied: true,
        serviceRowsFilteredCount: 2,
        discoverySourceUsed: 'internal_cache',
        queryIndex: 1,
        queryExhausted: false,
      }),
    ).toEqual({
      products: [{ product_id: 'sku_1', merchant_id: 'merchant_internal' }],
      total: 1,
      page_size: 1,
      clarification: null,
      reply: '',
      reason_codes: ['KEEP_ME'],
      metadata: {
        query_source: 'agent_products_error_fallback',
        normalized_intent: null,
        quality_gate_result: null,
        candidate_origin_counts: { internal: 1 },
        source_breakdown: {
          internal_count: 1,
          external_seed_count: 0,
          stale_cache_used: false,
        },
        external_seed_returned_count: 0,
        guidance_direct_external_seed_applied: false,
        guidance_direct_external_seed_valid_hit: false,
        displayable_candidate_count: undefined,
        fill_target_count: undefined,
        fill_completed_count: undefined,
        valid_scoping_dropped_count: undefined,
        dedupe_dropped_count: undefined,
        selection_diversity: null,
        stable_prior_applied: false,
        stable_prior_source: null,
        fallback_mode: 'normal',
        diversity_exception_applied: false,
        coverage_limited_after_fill: false,
        surface_reason: null,
        clarification_suppressed: true,
        legacy_fallback_suppressed: true,
        search_decision: {
          existing_field: true,
          contract_version: 'beauty_v1',
          hit_quality: 'valid_hit',
          invalid_hit_reason: undefined,
          query_bucket: undefined,
          query_target_step_family: 'cleanser',
          topk_bucket_mix: undefined,
          same_family_topk_count: undefined,
          exact_step_topk_count: undefined,
          strong_goal_family_topk_count: undefined,
          supportive_same_family_topk_count: undefined,
          query_step_strength: 'exact_step',
          decision_mode: 'guidance_only',
          source_policy: 'guided_only',
          normalized_intent: null,
          step_success_class: null,
          success_contract_result: null,
          quality_gate_result: null,
          candidate_origin_counts: { internal: 1 },
          candidate_class_counts: { core: 1 },
          target_relevance_class_counts: { target: 1 },
          noise_drop_counts: { noise: 0 },
          raw_result_count: undefined,
          displayable_candidate_count: undefined,
          fill_target_count: undefined,
          fill_completed_count: undefined,
          valid_scoping_dropped_count: undefined,
          dedupe_dropped_count: undefined,
          selection_diversity: null,
          stable_prior_applied: false,
          stable_prior_source: null,
          fallback_mode: 'normal',
          diversity_exception_applied: false,
          coverage_limited_after_fill: false,
          surface_reason: null,
          products_returned_count: 1,
          product_only_applied: true,
          service_rows_filtered_count: 2,
          discovery_source_used: 'internal_cache',
          query_index: 1,
          query_exhausted: false,
          clarification_suppressed: true,
          legacy_fallback_suppressed: true,
        },
      },
    });
  });

  test('guidance-only session load is owned by aurora orchestration facade', async () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeSearchUiSurface(value) {
        return String(value || '').trim().toLowerCase();
      },
      resolveGuidanceSearchSessionId() {
        return 'session_guidance_1';
      },
      async loadGuidanceSearchSessionSeenProductIds(sessionId) {
        return sessionId === 'session_guidance_1' ? ['sku_1', 'sku_2'] : [];
      },
    });

    const guidancePlan = runtime.buildGuidanceOnlySearchStatePlan({
      uiSurface: 'ingredient_plan_guidance_only',
      requestedTargetStepFamily: 'cleanser',
    });

    await expect(
      runtime.loadGuidanceOnlySessionState({
        guidancePlan,
        req: {},
        query: {},
        metadata: {},
      }),
    ).resolves.toEqual({
      sessionId: 'session_guidance_1',
      sessionSeenProductIds: ['sku_1', 'sku_2'],
    });
  });

  test('guidance-only session persistence is owned by aurora orchestration facade', async () => {
    const persisted = [];
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeSearchUiSurface(value) {
        return String(value || '').trim().toLowerCase();
      },
      resolveGuidanceSearchSessionId() {
        return 'session_guidance_2';
      },
      async persistGuidanceSearchSeenProducts(sessionId, products) {
        persisted.push({ sessionId, products });
      },
    });

    const guidancePlan = runtime.buildGuidanceOnlySearchStatePlan({
      uiSurface: 'ingredient_plan_guidance_only',
      requestedTargetStepFamily: 'serum',
    });

    await expect(
      runtime.persistGuidanceOnlySessionState({
        guidancePlan,
        req: {},
        query: {},
        metadata: {},
        response: {
          products: [{ product_id: 'sku_a' }, { product_id: 'sku_b' }],
        },
      }),
    ).resolves.toEqual({
      persisted: true,
      sessionId: 'session_guidance_2',
      productCount: 2,
    });

    expect(persisted).toEqual([
      {
        sessionId: 'session_guidance_2',
        products: [{ product_id: 'sku_a' }, { product_id: 'sku_b' }],
      },
    ]);
  });

  test('guidance-only derived hit-quality inputs are owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeSearchUiSurface(value) {
        return String(value || '').trim().toLowerCase();
      },
      normalizeGuidanceDiscoverySourcePolicy(value) {
        return String(value || '').trim().toLowerCase() || null;
      },
      parseQueryBoolean(value) {
        return value === true || value === 'true';
      },
      parseQueryNumber(value) {
        return value == null ? null : Number(value);
      },
      inferGuidanceDiscoverySourceUsed(products, allowExternalSeed) {
        return allowExternalSeed ? `mixed_${Array.isArray(products) ? products.length : 0}` : 'internal_only';
      },
      resolveGuidanceSearchStepStrength(value, queryText, targetStepFamily) {
        return `${String(value || 'auto')}:${String(queryText || '').trim()}:${String(targetStepFamily || '')}`;
      },
    });

    const guidancePlan = runtime.buildGuidanceOnlySearchStatePlan({
      uiSurface: 'ingredient_plan_guidance_only',
      requestedTargetStepFamily: 'cleanser',
    });

    expect(
      runtime.buildGuidanceOnlyHitQualityInputs({
        guidancePlan,
        metadata: {
          source_policy: 'Guided_Only',
          service_rows_filtered_count: '2',
          query_index: '3',
        },
        reqQuery: {
          allow_external_seed: 'true',
          product_only: 'true',
          query_step_strength: 'focused',
        },
        query: {},
        queryText: 'hydrating cleanser',
        requestedTargetStepFamily: 'cleanser',
        products: [{ product_id: 'sku_1' }, { product_id: 'sku_2' }],
        sessionState: {
          sessionSeenProductIds: ['seen_1'],
        },
      }),
    ).toEqual({
      shouldApplyGuidanceOnlyHitQuality: true,
      sessionSeenProductIds: ['seen_1'],
      queryStepStrength: 'focused:hydrating cleanser:cleanser',
      sourcePolicy: 'guided_only',
      productOnlyApplied: true,
      serviceRowsFilteredCount: 2,
      discoverySourceUsed: 'mixed_2',
      queryIndex: 3,
      queryExhausted: false,
    });
  });

  test('guidance-only finalization is owned by aurora orchestration facade', async () => {
    const persisted = [];
    const decisions = [];
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeSearchUiSurface(value) {
        return String(value || '').trim().toLowerCase();
      },
      resolveGuidanceSearchSessionId() {
        return 'session_guidance_final';
      },
      async loadGuidanceSearchSessionSeenProductIds(sessionId) {
        return sessionId === 'session_guidance_final' ? ['seen_1'] : [];
      },
      async persistGuidanceSearchSeenProducts(sessionId, products) {
        persisted.push({ sessionId, products });
      },
      normalizeGuidanceDiscoverySourcePolicy(value) {
        return String(value || '').trim().toLowerCase() || null;
      },
      parseQueryBoolean(value) {
        return value === true || value === 'true';
      },
      parseQueryNumber(value) {
        return value == null ? null : Number(value);
      },
      inferGuidanceDiscoverySourceUsed() {
        return 'internal_cache';
      },
      resolveGuidanceSearchStepStrength(value) {
        return String(value || 'auto');
      },
      buildGuidanceOnlyHitQualityDecision(input) {
        decisions.push(input);
        return {
          applied: true,
          hit_quality: 'valid_hit',
          query_target_step_family: input.queryTargetStepFamily,
          query_step_strength: input.queryStepStrength,
          products_returned_count: Array.isArray(input.products) ? input.products.length : 0,
        };
      },
      guidanceDecisionContractVersion: 'beauty_contract_v2',
      countCandidateOriginBreakdown(products) {
        return { internal: Array.isArray(products) ? products.length : 0 };
      },
      mergeSearchCountMaps(...maps) {
        return Object.assign({}, ...maps.filter(Boolean));
      },
    });

    const finalized = await runtime.finalizeGuidanceOnlySearchResponse({
      response: {
        products: [{ product_id: 'sku_1' }],
        clarification: { question: 'Which texture?' },
        reason_codes: ['AMBIGUITY_CLARIFY'],
        metadata: {
          ui_surface: 'ingredient_plan_guidance_only',
          source_policy: 'Guided_Only',
          query_source: 'agent_products_search',
          query_step_strength: 'focused',
        },
      },
      uiSurface: 'ingredient_plan_guidance_only',
      requestedTargetStepFamily: 'cleanser',
      queryText: 'hydrating cleanser',
      req: {
        query: {
          query_step_strength: 'focused',
        },
      },
      query: {},
    });

    expect(decisions).toEqual([
      {
        queryText: 'hydrating cleanser',
        products: [{ product_id: 'sku_1' }],
        queryTargetStepFamily: 'cleanser',
        guidanceOnlyDiscovery: true,
        queryStepStrength: 'focused',
        mode: 'guidance_only',
        sessionSeenProductIds: ['seen_1'],
      },
    ]);
    expect(finalized.guidancePlan).toEqual({
      uiSurface: 'ingredient_plan_guidance_only',
      guidanceOnlySurface: true,
      shouldApplyGuidanceOnlyHitQuality: true,
      shouldLoadSessionSeenProducts: true,
      shouldPersistSeenProducts: true,
      clarificationPlan: {
        uiSurface: 'ingredient_plan_guidance_only',
        guidanceOnlySurface: true,
        suppressLegacyClarification: true,
        filteredReasonCodes: [],
        legacyFallbackSuppressed: false,
      },
    });
    expect(finalized.persistence).toEqual({
      persisted: true,
      sessionId: 'session_guidance_final',
      productCount: 1,
    });
    expect(finalized.response.metadata.search_decision.contract_version).toBe('beauty_contract_v2');
    expect(finalized.response.metadata.search_decision.query_step_strength).toBe('focused');
    expect(finalized.response.metadata.search_decision.discovery_source_used).toBe('internal_cache');
    expect(finalized.response.clarification).toBeNull();
    expect(persisted).toEqual([
      {
        sessionId: 'session_guidance_final',
        products: [{ product_id: 'sku_1' }],
      },
    ]);
  });

  test('guidance-only invoke response normalization is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeSearchUiSurface(value) {
        return String(value || '').trim().toLowerCase();
      },
      normalizeRecoTargetStep(value) {
        return String(value || '').trim().toLowerCase() || null;
      },
      firstQueryParamValue(value) {
        return Array.isArray(value) ? value[0] : value;
      },
      normalizeGuidanceDiscoveryProductPdpContract(product) {
        return {
          ...product,
          normalized_for_guidance: true,
        };
      },
      normalizeGuidanceDiscoverySourcePolicy(value) {
        return String(value || '').trim().toLowerCase() || null;
      },
      parseQueryBoolean(value) {
        return value === true || value === 'true';
      },
      parseQueryNumber(value) {
        return value == null ? null : Number(value);
      },
      inferGuidanceDiscoverySourceUsed() {
        return 'internal_cache';
      },
      resolveGuidanceSearchStepStrength(value) {
        return String(value || 'auto');
      },
      buildGuidanceOnlyHitQualityDecision() {
        return {
          applied: true,
          query_target_step_family: 'cleanser',
          query_step_strength: 'focused',
          hit_quality: 'valid_hit',
          products_returned_count: 1,
        };
      },
      guidanceDecisionContractVersion: 'beauty_contract_v2',
      countCandidateOriginBreakdown(products) {
        return { internal: Array.isArray(products) ? products.length : 0 };
      },
      mergeSearchCountMaps(...maps) {
        return Object.assign({}, ...maps.filter(Boolean));
      },
    });

    const normalized = runtime.normalizeGuidanceOnlyInvokeSearchResponse({
      response: {
        products: [{ product_id: 'sku_1' }],
        metadata: {
          ui_surface: 'ingredient_plan_guidance_only',
          query_target_step_family: 'cleanser',
          query_step_strength: 'focused',
          source_policy: 'Guided_Only',
        },
      },
      reqQuery: {
        query: 'hydrating cleanser',
        product_only: 'true',
      },
    });

    expect(normalized.response.products).toEqual([
      {
        product_id: 'sku_1',
        normalized_for_guidance: true,
      },
    ]);
    expect(normalized.searchDecision).toMatchObject({
      contract_version: 'beauty_contract_v2',
      hit_quality: 'valid_hit',
      query_target_step_family: 'cleanser',
      query_step_strength: 'focused',
      decision_mode: 'guidance_only',
      product_only_applied: true,
      discovery_source_used: 'internal_cache',
      query_exhausted: false,
    });
  });

  test('guidance-only search decision patches are owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      inferGuidanceDiscoverySourceUsed() {
        return 'internal_cache';
      },
      classifySharedBeautyCoarseCandidate(product) {
        return product?.kind === 'service'
          ? { object_type: 'service', domain_scope: 'beauty_service' }
          : { object_type: 'product', domain_scope: 'beauty' };
      },
      buildSearchDecisionProductKey(product) {
        return product?.product_id || null;
      },
    });

    expect(
      runtime.buildGuidanceOnlySearchDecisionPatches({
        guidanceOnlyDiscovery: true,
        requestedProductOnly: true,
        requestedAllowExternalSeed: true,
        requestedExternalSeedStrategy: 'supplement_internal_first',
        requestedQueryIndex: 1,
        requestedQueryTotal: 3,
        requestedDecisionMode: 'guidance_only',
        requestedTargetStepFamily: 'cleanser',
        requestedQueryStepStrength: 'focused',
        existingMeta: {
          query_total: 4,
        },
        rawProductsForQualityGate: [
          { product_id: 'sku_1', kind: 'product' },
          { product_id: 'svc_1', kind: 'service' },
        ],
        nextProducts: [{ product_id: 'sku_1', kind: 'product' }],
        hitDecision: {
          query_step_strength: 'exact_step',
        },
      }),
    ).toEqual({
      searchDecisionPatch: {
        product_only_applied: true,
        service_rows_filtered_count: 1,
        discovery_source_used: 'internal_cache',
        query_step_strength: 'exact_step',
        decision_mode: 'guidance_only',
        query_index: 1,
        query_exhausted: false,
      },
      metadataPatch: {
        product_only_applied: true,
        service_rows_filtered_count: 1,
        discovery_source_used: 'internal_cache',
        query_step_strength: 'exact_step',
        decision_mode: 'guidance_only',
        query_index: 1,
        query_exhausted: false,
      },
    });
  });

  test('guidance-only direct supplement plan is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      isExternalSeedProduct(product) {
        return product?.merchant_name === 'external_seed';
      },
    });

    expect(
      runtime.buildGuidanceOnlyDirectSupplementPlan({
        guidanceOnlyDiscovery: true,
        requestedAllowExternalSeed: true,
        requestedTargetStepFamily: 'cleanser',
        queryText: 'cleanser for travel',
        upstreamData: {
          products: [{ product_id: 'sku_1', merchant_name: 'internal_cache' }],
          metadata: {
            search_decision: {
              hit_quality: 'valid_hit',
              same_family_topk_count: 1,
            },
          },
        },
        requestedLimit: 10,
      }),
    ).toEqual({
      shouldAttemptDirectSupplement: true,
      existingMeta: {
        search_decision: {
          hit_quality: 'valid_hit',
          same_family_topk_count: 1,
        },
      },
      existingSearchDecision: {
        hit_quality: 'valid_hit',
        same_family_topk_count: 1,
      },
      primaryProductsBeforeGuidance: [{ product_id: 'sku_1', merchant_name: 'internal_cache' }],
      primaryHasExternalSeedBeforeGuidance: false,
      primaryHasValidGuidanceHit: true,
      primaryHasCacheReturnedGuidanceFastpath: false,
    });
  });

  test('guidance-only direct supplement plan skips when the cache-hit fastpath contract is already satisfied', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      isExternalSeedProduct(product) {
        return product?.merchant_name === 'external_seed';
      },
    });

    expect(
      runtime.buildGuidanceOnlyDirectSupplementPlan({
        guidanceOnlyDiscovery: true,
        requestedAllowExternalSeed: true,
        requestedTargetStepFamily: 'serum',
        queryText: 'hydrating serum',
        upstreamData: {
          products: [{ product_id: 'sku_1', merchant_name: 'internal_cache' }],
          metadata: {
            query_source: 'agent_products_guidance_fastpath',
            final_decision: 'cache_returned',
            search_decision: {
              hit_quality: 'valid_hit',
              same_family_topk_count: 1,
            },
            route_debug: {
              cross_merchant_cache: {
                guidance_hit_quality: 'valid_hit',
                internal_products_relevant_count: 1,
                guidance_scoped_internal_products_count: 1,
              },
            },
          },
        },
        requestedLimit: 10,
      }),
    ).toEqual({
      shouldAttemptDirectSupplement: false,
      existingMeta: {
        query_source: 'agent_products_guidance_fastpath',
        final_decision: 'cache_returned',
        search_decision: {
          hit_quality: 'valid_hit',
          same_family_topk_count: 1,
        },
        route_debug: {
          cross_merchant_cache: {
            guidance_hit_quality: 'valid_hit',
            internal_products_relevant_count: 1,
            guidance_scoped_internal_products_count: 1,
          },
        },
      },
      existingSearchDecision: {
        hit_quality: 'valid_hit',
        same_family_topk_count: 1,
      },
      primaryProductsBeforeGuidance: [{ product_id: 'sku_1', merchant_name: 'internal_cache' }],
      primaryHasExternalSeedBeforeGuidance: false,
      primaryHasValidGuidanceHit: true,
      primaryHasCacheReturnedGuidanceFastpath: true,
    });
  });

  test('guidance-only direct supplement outcome is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      isExternalSeedProduct(product) {
        return product?.merchant_name === 'external_seed';
      },
      buildSearchProductKey(product) {
        return product?.product_id || null;
      },
      normalizeAgentProductsListResponse(value) {
        return value;
      },
    });

    expect(
      runtime.buildGuidanceOnlyDirectSupplementOutcome({
        upstreamData: {
          products: [{ product_id: 'sku_1', merchant_name: 'internal_cache' }],
          total: 1,
          metadata: {
            source_breakdown: {
              internal_count: 1,
              external_seed_count: 0,
            },
          },
        },
        directSupplement: {
          total: 2,
          products: [
            { product_id: 'sku_1', merchant_name: 'internal_cache' },
            { product_id: 'sku_2', merchant_name: 'external_seed' },
          ],
          metadata: {
            search_decision: {
              hit_quality: 'valid_hit',
            },
            external_seed_rows_fetched: 2,
            external_seed_rows_built: 2,
          },
        },
        existingMeta: {
          source_breakdown: {
            internal_count: 1,
            external_seed_count: 0,
          },
        },
        primaryHasValidGuidanceHit: true,
        primaryProductsBeforeGuidance: [{ product_id: 'sku_1', merchant_name: 'internal_cache' }],
        requestedLimit: 10,
        queryLimit: 10,
        queryOffset: 0,
      }),
    ).toEqual({
      applied: true,
      directValidHit: true,
      response: {
        products: [
          { product_id: 'sku_1', merchant_name: 'internal_cache' },
          { product_id: 'sku_2', merchant_name: 'external_seed' },
        ],
        total: 2,
        metadata: {
          source_breakdown: {
            internal_count: 1,
            external_seed_count: 1,
            stale_cache_used: false,
            strategy_applied: 'guidance_direct_external_seed_supplement',
          },
          query_source: 'agent_products_search_guidance_supplemented',
          guidance_direct_external_seed_applied: true,
          guidance_direct_external_seed_valid_hit: true,
          external_seed_executed: true,
          external_seed_rows_fetched: 2,
          external_seed_rows_built: 2,
          external_seed_returned_count: 1,
          search_stage_b: {
            attempted: true,
            applied: true,
            added_count: 1,
            reason: 'guidance_direct_external_seed_supplemented',
          },
          supplement_attempted: true,
          supplement_skip_reason: null,
        },
      },
    });
  });

  test('guidance-only cache search plan is owned by aurora orchestration facade', async () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeSearchUiSurface(value) {
        return String(value || '').trim().toLowerCase();
      },
      normalizeRecoTargetStep(value) {
        return String(value || '').trim().toLowerCase() || null;
      },
      resolveGuidanceSearchStepStrength() {
        return 'focused';
      },
      buildGuidanceSearchNormalizedIntent({ queryText, targetStepFamily }) {
        return {
          queryText,
          targetStepFamily,
          mode: 'guidance_only',
        };
      },
      resolveGuidanceSearchSessionId() {
        return 'guidance-session-1';
      },
      async loadGuidanceSearchSessionSeenProductIds() {
        return ['sku_seen_1'];
      },
      buildGuidanceOnlyHitQualityDecision() {
        return {
          applied: true,
          hit_quality: 'valid_hit',
          same_family_topk_count: 2,
          valid_products: [{ product_id: 'sku_1' }],
        };
      },
      buildSearchDecisionProductKey(product) {
        return product?.product_id || null;
      },
    });

    const plan = await runtime.buildGuidanceOnlyCacheSearchPlan({
      uiSurface: 'ingredient_plan_guidance_only',
      requestedTargetStepFamily: 'serum',
      requestedQueryStepStrength: 'auto',
      queryText: 'vitamin c serum',
      req: {},
      query: {},
      metadata: {
        query_source: 'cache_cross_merchant_search',
      },
      products: [
        { product_id: 'sku_1' },
        { product_id: 'sku_2' },
      ],
    });

    expect(plan.guidanceOnlyDiscovery).toBe(true);
    expect(plan.guidanceTargetStepFamily).toBe('serum');
    expect(plan.guidanceQueryStepStrength).toBe('focused');
    expect(plan.guidanceNormalizedIntent).toEqual({
      queryText: 'vitamin c serum',
      targetStepFamily: 'serum',
      mode: 'guidance_only',
    });
    expect(plan.sessionState).toEqual({
      sessionId: 'guidance-session-1',
      sessionSeenProductIds: ['sku_seen_1'],
    });
    expect(plan.internalGuidanceHitDecision).toMatchObject({
      applied: true,
      hit_quality: 'valid_hit',
      same_family_topk_count: 2,
    });
    expect(plan.guidanceNeedsPrimaryFillSupplement).toBe(false);
    expect(plan.baselineProducts).toEqual([{ product_id: 'sku_1' }]);
  });

  test('guidance-only cache supplement plan is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      isCatalogGuardSource() {
        return true;
      },
      hasPetHarnessSearchSignal() {
        return false;
      },
      hasFragranceSearchSignal() {
        return false;
      },
      isBeautyGeneralDiversitySupplementCandidate() {
        return false;
      },
      searchExternalFillGated: () => true,
      searchExternalHardRulePrune: () => false,
    });

    expect(
      runtime.buildGuidanceOnlyCacheSupplementPlan({
        source: 'aurora-bff',
        page: 1,
        queryText: 'vitamin c serum',
        effectiveIntent: {
          confidence: { overall: 0.82 },
        },
        baselineProducts: [{ product_id: 'sku_1' }],
        rawInternalProductsCount: 2,
        safeResultLimit: 3,
        guidanceTargetStepFamily: 'serum',
        guidanceNormalizedIntent: {
          backbone_id: 'serum_guidance_backbone',
        },
        guidanceNeedsPrimaryFillSupplement: true,
        cachePolicyQueryClass: 'lookup',
        ambiguityScorePre: 0.18,
        isLookupQuery: false,
        preferInternalSpecificBeautyCache: false,
        cacheBeautyBucket: 'serum',
      }),
    ).toEqual({
      guidanceFillTargetCount: 3,
      needsPrimaryFillSupplement: true,
      needsBeautyDiversitySupplement: false,
      shouldAttemptSupplement: true,
      neededCount: 2,
      supplementMeta: {
        attempted: true,
        applied: false,
        added_count: 0,
        reason: 'supplement_pending',
        diversity_targeted: false,
        gate: {
          enabled: true,
          soft_bypassed: false,
          min_internal_required: 3,
          internal_count: 1,
          raw_internal_count: 2,
          overall_confidence: 0.82,
          ambiguity_score_pre: 0.18,
          lookup_query_bypass: false,
          guidance_fill_bypassed: true,
        },
      },
    });
  });

  test('guidance-only cache supplement plan skips when shared success contract is already satisfied', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      isCatalogGuardSource() {
        return true;
      },
      hasPetHarnessSearchSignal() {
        return false;
      },
      hasFragranceSearchSignal() {
        return false;
      },
      isBeautyGeneralDiversitySupplementCandidate() {
        return true;
      },
      searchExternalFillGated: () => true,
      searchExternalHardRulePrune: () => false,
    });

    expect(
      runtime.buildGuidanceOnlyCacheSupplementPlan({
        source: 'aurora-bff',
        page: 1,
        queryText: 'hydrating serum',
        effectiveIntent: {
          confidence: { overall: 0.82 },
        },
        baselineProducts: [{ product_id: 'sku_1' }],
        internalGuidanceHitDecision: {
          applied: true,
          hit_quality: 'valid_hit',
          step_success_class: 'supportive_family',
          success_contract_result: {
            satisfied: true,
          },
        },
        rawInternalProductsCount: 1,
        safeResultLimit: 6,
        guidanceTargetStepFamily: 'serum',
        guidanceNormalizedIntent: null,
        guidanceNeedsPrimaryFillSupplement: false,
        cachePolicyQueryClass: 'category',
        ambiguityScorePre: 0.18,
        isLookupQuery: false,
        preferInternalSpecificBeautyCache: false,
        cacheBeautyBucket: 'skincare',
      }),
    ).toEqual({
      guidanceFillTargetCount: 6,
      needsPrimaryFillSupplement: false,
      needsBeautyDiversitySupplement: true,
      shouldAttemptSupplement: false,
      neededCount: 0,
      supplementMeta: {
        attempted: false,
        applied: false,
        added_count: 0,
        reason: 'guidance_contract_satisfied',
        gate: {
          internal_count: 1,
          raw_internal_count: 1,
          step_success_class: 'supportive_family',
          success_contract_satisfied: true,
          beauty_diversity_targeted: true,
        },
      },
    });
  });

  test('guidance-only cache supplement request assembly is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime();

    expect(
      runtime.buildGuidanceOnlyCacheSupplementRequest({
        activeCacheSearchQueryText: 'hydrating serum',
        search: {
          catalog_surface: 'beauty',
          category: 'serum',
          price_min: 20,
          max_price: 80,
        },
        metadata: {
          ui_surface: 'ingredient_plan_guidance_only',
          product_only_requested: true,
          query_index: 1,
          query_total: 3,
          query_target_step_family: 'serum',
          query_step_strength: 'focused',
          decision_mode: 'guidance_only',
          source_policy: 'guided_only',
        },
        guidanceSessionId: 'session_123',
        inStockOnly: true,
      }),
    ).toEqual({
      query: 'hydrating serum',
      catalog_surface: 'beauty',
      ui_surface: 'ingredient_plan_guidance_only',
      product_only: true,
      query_index: 1,
      query_total: 3,
      target_step_family: 'serum',
      query_step_strength: 'focused',
      decision_mode: 'guidance_only',
      source_policy: 'guided_only',
      session_id: 'session_123',
      category: 'serum',
      min_price: 20,
      max_price: 80,
      in_stock_only: true,
    });
  });

  test('guidance-only cache supplement outcome metadata is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      searchExternalHardRulePrune: () => false,
    });

    expect(
      runtime.buildGuidanceOnlyCacheSupplementOutcome({
        supplement: {
          metadata: {
            fetch_source: 'external_seed',
          },
        },
        toAppend: [{ product_id: 'ext_1' }],
        needsBeautyDiversitySupplement: true,
      }),
    ).toEqual({
      fetch_source: 'external_seed',
      attempted: true,
      applied: true,
      added_count: 1,
      reason: 'supplemented_external_seed_diversity',
      diversity_targeted: true,
    });

    expect(
      runtime.buildGuidanceOnlyCacheSupplementErrorOutcome({
        error: new Error('network_down'),
        needsBeautyDiversitySupplement: false,
      }),
    ).toEqual({
      attempted: true,
      applied: false,
      added_count: 0,
      reason: 'supplement_error',
      error: 'network_down',
      diversity_targeted: false,
    });
  });

  test('guidance-only cache supplement selection is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      buildSearchProductKey(product) {
        return product?.product_id || null;
      },
      isExternalSeedProduct(product) {
        return product?.source === 'external_seed';
      },
      isSupplementCandidateRelevant(product) {
        return product?.relevant !== false;
      },
      blendBeautyDiversitySupplement(internalProducts, supplementProducts) {
        return internalProducts.concat(supplementProducts);
      },
    });

    expect(
      runtime.buildGuidanceOnlyCacheSupplementSelection({
        baselineProducts: [{ product_id: 'base_1', source: 'internal' }],
        supplementProducts: [
          { product_id: 'base_1', source: 'external_seed', relevant: true },
          { product_id: 'ext_skip', source: 'external_seed', relevant: false },
          { product_id: 'ext_1', source: 'external_seed', relevant: true },
          { product_id: 'ext_2', source: 'external_seed', relevant: true },
          { product_id: 'int_1', source: 'internal', relevant: true },
        ],
        neededCount: 1,
        needsBeautyDiversitySupplement: false,
        safeResultLimit: 10,
        queryText: 'vitamin c serum',
        guidanceTargetStepFamily: 'serum',
        uiSurface: 'ingredient_plan_guidance_only',
        guidanceQueryStepStrength: 'focused',
      }),
    ).toEqual({
      supplementedProducts: [
        { product_id: 'base_1', source: 'internal' },
        { product_id: 'ext_1', source: 'external_seed', relevant: true },
      ],
      toAppend: [{ product_id: 'ext_1', source: 'external_seed', relevant: true }],
      addedCount: 1,
      applied: true,
    });
  });

  test('guidance-only cache response artifacts are owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      firstQueryParamValue(value) {
        return Array.isArray(value) ? value[0] : value;
      },
      uniqueStrings(values) {
        return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
      },
      normalizeExternalSeedStrategy(value, fallback) {
        return String(value || fallback || '').trim() || null;
      },
      isExternalSeedProduct(product) {
        return product?.source === 'external_seed';
      },
      isShoppingSource(value) {
        return String(value || '').trim().toLowerCase() === 'shopping_agent';
      },
      isCatalogGuardSource(value) {
        return String(value || '').trim().toLowerCase() === 'catalog_guard';
      },
    });

    const artifacts = runtime.buildGuidanceOnlyCacheResponseArtifacts({
      source: 'catalog_guard',
      search: {
        externalSeedStrategy: 'unified_relevance',
      },
      payload: {},
      metadata: {},
      cacheQueryText: 'vitamin c serum',
      activeCacheSearchQueryText: 'vitamin c serum',
      cacheQueryMode: 'semantic',
      queryText: 'vitamin c serum for dark spots',
      cacheStageStartedAt: Date.now() - 25,
      cacheStageBudgetMs: 120,
      page: 1,
      limit: 10,
      inStockOnly: true,
      effectiveProducts: [
        { product_id: 'int_1', merchant_id: 'merchant_a', source: 'internal' },
        { product_id: 'ext_1', merchant_id: 'merchant_b', source: 'external_seed' },
      ],
      internalProducts: [{ product_id: 'int_1', merchant_id: 'merchant_a', source: 'internal' }],
      internalProductsAfterAnchor: [
        { product_id: 'int_1', merchant_id: 'merchant_a', source: 'internal' },
      ],
      baselineInternalProducts: [
        { product_id: 'int_1', merchant_id: 'merchant_a', source: 'internal' },
      ],
      internalGuidanceHitDecision: {
        hit_quality: 'valid_hit',
        same_family_topk_count: 2,
      },
      guidanceTargetStepFamily: 'serum',
      leashAnchoredQuery: true,
      cacheRelevant: false,
      relaxCacheRelevanceGate: true,
      fromCache: {
        total: 5,
        page: 1,
        retrieval_sources: ['internal_cache', 'external_seed'],
        query_terms: ['vitamin', 'serum'],
        beauty_query_bucket: 'serum',
        internal_filter_debug: {
          filtered_irrelevant_count: 1,
          bucket_mix_before: { serum: 2 },
          bucket_mix_after: { serum: 1 },
        },
      },
      cacheBeautyQueryProfile: { bucket: 'serum' },
      supplementMeta: {
        applied: true,
        reason: 'supplemented_external_seed_diversity',
      },
      routeDebugEnabled: true,
    });

    expect(artifacts.normalizedSeedStrategyForCache).toBe('unified_relevance');
    expect(artifacts.unifiedRelevanceRequested).toBe(true);
    expect(artifacts.externalCount).toBe(1);
    expect(artifacts.cacheRouteDebug).toMatchObject({
      query: 'vitamin c serum',
      cache_query: 'vitamin c serum',
      cache_query_mode: 'semantic',
      upstream_query: 'vitamin c serum for dark spots',
      cache_hit: true,
      cache_hit_base: true,
      products_count: 2,
      external_products_count: 1,
      guidance_query_target_step_family: 'serum',
      supplement: {
        applied: true,
        reason: 'supplemented_external_seed_diversity',
      },
    });
    expect(artifacts.upstreamData.metadata).toMatchObject({
      query_source: 'cache_cross_merchant_search_supplemented',
      merchants_searched: 2,
      retrieval_sources: ['internal_cache', 'external_seed'],
      source_breakdown: {
        internal_count: 1,
        external_seed_count: 1,
        stale_cache_used: false,
        strategy_applied: 'unified_relevance',
      },
      route_debug: {
        cross_merchant_cache: {
          query: 'vitamin c serum',
          external_products_count: 1,
        },
      },
    });
  });

  test('guidance-only cache route debug outcome is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime();

    expect(
      runtime.applyGuidanceOnlyCacheRouteDebugOutcome({
        cacheRouteDebug: {
          attempted: true,
          cache_hit_base: true,
        },
        effectiveCacheHit: false,
        cacheValidation: {
          accepted: false,
          reason: 'anchor_below_threshold',
        },
        cacheRejectedLowQuality: true,
        cacheMissingExternalForUnified: true,
        bypassCacheStrictEmptyForUnified: true,
        cacheStrictEmptyBypassReason: 'missing_external_for_unified',
        forceSearchFirstForExpandedQuery: true,
        cacheClarifyOnlyShouldUseEarlyDecision: true,
        earlyDecisionRouteDebugUpdate: {
          applied: true,
          reason: 'scenario_query',
        },
      }),
    ).toEqual({
      attempted: true,
      cache_hit_base: true,
      cache_hit: false,
      cache_validation: {
        accepted: false,
        reason: 'anchor_below_threshold',
      },
      cache_rejected_low_quality: true,
      cache_missing_external_for_unified: true,
      cache_strict_empty_bypassed: true,
      cache_strict_empty_bypass_reason: 'missing_external_for_unified',
      force_search_first_for_expanded_query: true,
      cache_clarify_only_recast_as_early_decision: true,
      early_decision: {
        applied: true,
        reason: 'scenario_query',
      },
    });
  });

  test('guidance-only cache transition plan rejects weak lookup cache hit inside aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      evaluateCacheQualityGate() {
        return {
          enabled: true,
          accepted: true,
          reason: null,
          anchor_ratio: 0.9,
        };
      },
      searchCacheMinAnchor: () => 0.4,
    });

    expect(
      runtime.buildGuidanceOnlyCacheTransitionPlan({
        effectiveCacheHit: true,
        response: {
          products: [{ product_id: 'sku_1' }],
        },
        effectiveProducts: [{ product_id: 'sku_1' }],
        cacheQueryText: 'ipsa toner',
        queryText: 'ipsa toner',
        intent: { query_class: 'lookup' },
        traceQueryClass: null,
        cachePolicyQueryClass: 'lookup',
        cacheBrandLikeQuery: false,
        isLookupQuery: true,
        cacheRelevant: false,
        unifiedRelevanceRequested: false,
        externalCount: 0,
        source: 'shopping_agent',
        hasMerchantScope: false,
        preferInternalSpecificBeautyCache: false,
        cacheBeautyQueryProfile: null,
      }),
    ).toEqual({
      effectiveCacheHit: false,
      withPolicyProducts: [{ product_id: 'sku_1' }],
      cacheClarifyOnly: false,
      cacheClarifyOnlyShouldUseEarlyDecision: false,
      cacheValidation: {
        enabled: true,
        accepted: false,
        reason: 'anchor_below_threshold',
        anchor_ratio: 0.39,
      },
      cacheRejectedLowQuality: true,
      cacheMissingExternalForUnified: false,
      cacheStrictEmptyBypassReason: 'cache_rejected_low_quality',
      forceSearchFirstForExpandedQuery: false,
      bypassCacheStrictEmptyForUnified: false,
    });
  });

  test('guidance-only cache transition plan keeps healthy generic skincare serum cache hit when external supplement is missing', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      evaluateCacheQualityGate() {
        return {
          enabled: false,
          accepted: true,
          reason: null,
        };
      },
      isShoppingSource() {
        return false;
      },
    });

    expect(
      runtime.buildGuidanceOnlyCacheTransitionPlan({
        effectiveCacheHit: true,
        response: {
          products: [{ product_id: 'sku_1' }],
        },
        effectiveProducts: [{ product_id: 'sku_1' }],
        cacheQueryText: 'repair serum',
        queryText: 'repair serum',
        intent: { query_class: 'category' },
        traceQueryClass: 'category',
        cachePolicyQueryClass: 'category',
        cacheBrandLikeQuery: false,
        isLookupQuery: false,
        cacheRelevant: true,
        unifiedRelevanceRequested: true,
        externalCount: 0,
        source: 'aurora-bff',
        hasMerchantScope: false,
        preferInternalSpecificBeautyCache: false,
        cacheBeautyQueryProfile: { isSpecificBeautyQuery: false, bucket: 'skincare' },
      }),
    ).toEqual({
      effectiveCacheHit: true,
      withPolicyProducts: [{ product_id: 'sku_1' }],
      cacheClarifyOnly: false,
      cacheClarifyOnlyShouldUseEarlyDecision: false,
      cacheValidation: {
        enabled: false,
        accepted: true,
        reason: null,
      },
      cacheRejectedLowQuality: false,
      cacheMissingExternalForUnified: false,
      cacheStrictEmptyBypassReason: null,
      forceSearchFirstForExpandedQuery: false,
      bypassCacheStrictEmptyForUnified: false,
    });
  });

  test('guidance-only cache transition plan preserves a hydration-supportive serum main path when the shared success contract is satisfied', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      evaluateCacheQualityGate() {
        return {
          enabled: true,
          accepted: true,
          reason: null,
        };
      },
      isShoppingSource() {
        return false;
      },
    });

    expect(
      runtime.buildGuidanceOnlyCacheTransitionPlan({
        effectiveCacheHit: false,
        response: {
          products: [{ product_id: 'sku_1' }],
        },
        effectiveProducts: [{ product_id: 'sku_1' }],
        cacheQueryText: 'hydrating serum',
        queryText: 'hydrating serum',
        intent: { query_class: 'category' },
        traceQueryClass: 'category',
        cachePolicyQueryClass: 'category',
        cacheBrandLikeQuery: false,
        isLookupQuery: false,
        cacheRelevant: false,
        unifiedRelevanceRequested: true,
        externalCount: 0,
        source: 'aurora-bff',
        hasMerchantScope: false,
        preferInternalSpecificBeautyCache: false,
        cacheBeautyQueryProfile: { isSpecificBeautyQuery: false, bucket: 'skincare' },
        internalGuidanceHitDecision: {
          applied: true,
          hit_quality: 'valid_hit',
          same_family_topk_count: 1,
          success_contract_result: {
            satisfied: true,
          },
        },
      }),
    ).toEqual({
      effectiveCacheHit: true,
      withPolicyProducts: [{ product_id: 'sku_1' }],
      cacheClarifyOnly: false,
      cacheClarifyOnlyShouldUseEarlyDecision: false,
      cacheValidation: {
        enabled: true,
        accepted: true,
        reason: null,
      },
      cacheRejectedLowQuality: false,
      cacheMissingExternalForUnified: false,
      cacheStrictEmptyBypassReason: null,
      forceSearchFirstForExpandedQuery: false,
      bypassCacheStrictEmptyForUnified: false,
    });
  });

  test('guidance-only cache transition plan still marks unified relevance external gap for non-serum generic beauty queries', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      evaluateCacheQualityGate() {
        return {
          enabled: false,
          accepted: true,
          reason: null,
        };
      },
      isShoppingSource() {
        return false;
      },
    });

    expect(
      runtime.buildGuidanceOnlyCacheTransitionPlan({
        effectiveCacheHit: true,
        response: {
          products: [{ product_id: 'sku_1' }],
        },
        effectiveProducts: [{ product_id: 'sku_1' }],
        cacheQueryText: 'repair moisturizer',
        queryText: 'repair moisturizer',
        intent: { query_class: 'category' },
        traceQueryClass: 'category',
        cachePolicyQueryClass: 'category',
        cacheBrandLikeQuery: false,
        isLookupQuery: false,
        cacheRelevant: true,
        unifiedRelevanceRequested: true,
        externalCount: 0,
        source: 'aurora-bff',
        hasMerchantScope: false,
        preferInternalSpecificBeautyCache: false,
        cacheBeautyQueryProfile: { isSpecificBeautyQuery: false, bucket: 'skincare' },
      }),
    ).toEqual({
      effectiveCacheHit: false,
      withPolicyProducts: [{ product_id: 'sku_1' }],
      cacheClarifyOnly: false,
      cacheClarifyOnlyShouldUseEarlyDecision: false,
      cacheValidation: {
        enabled: false,
        accepted: true,
        reason: null,
      },
      cacheRejectedLowQuality: false,
      cacheMissingExternalForUnified: true,
      cacheStrictEmptyBypassReason: 'missing_external_for_unified',
      forceSearchFirstForExpandedQuery: false,
      bypassCacheStrictEmptyForUnified: true,
    });
  });

  test('guidance-only cache early-decision response is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime();

    expect(
      runtime.buildGuidanceOnlyCacheEarlyDecisionResponse({
        page: 1,
        merchantsReturned: ['merchant_a', 'merchant_b'],
        cacheRouteDebug: {
          attempted: true,
          products_count: 2,
        },
        routeDebugEnabled: true,
        earlyDecisionCause: 'scenario_query',
        queryClassForEarlyDecision: 'scenario',
      }),
    ).toEqual({
      products: [],
      total: 0,
      page: 1,
      page_size: 0,
      reply: null,
      metadata: expect.objectContaining({
        query_source: 'cache_cross_merchant_search_early_decision',
        merchants_searched: 2,
        source_breakdown: {
          internal_count: 0,
          external_seed_count: 0,
          stale_cache_used: false,
          strategy_applied: 'ambiguity_gate_before_upstream',
        },
        route_debug: {
          cross_merchant_cache: {
            attempted: true,
            products_count: 2,
            early_decision: {
              applied: true,
              reason: 'scenario_query',
              query_class: 'scenario',
            },
          },
        },
      }),
    });
  });

  test('guidance-only cache early-decision outcome is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      applyFindProductsMultiPolicyIfNeeded({ response }) {
        return {
          ...response,
          metadata: {
            ...(response?.metadata || {}),
            policy_applied: true,
          },
        };
      },
      withSearchDiagnostics(response, diagnostics) {
        return {
          ...response,
          metadata: {
            ...(response?.metadata || {}),
            route_health: diagnostics.route_health,
            search_trace: diagnostics.search_trace,
          },
          ...(diagnostics.strict_empty ? { strict_empty: diagnostics.strict_empty } : {}),
        };
      },
      buildSearchRouteHealth(value) {
        return value;
      },
      buildSearchTrace(value) {
        return value;
      },
      buildCacheStageSnapshot(value) {
        return value;
      },
    });

    expect(
      runtime.buildGuidanceOnlyCacheEarlyDecisionOutcome({
        page: 1,
        merchantsReturned: ['merchant_a'],
        cacheRouteDebug: { attempted: true, products_count: 2 },
        routeDebugEnabled: true,
        earlyDecisionCause: 'scenario_query',
        queryClassForEarlyDecision: 'scenario',
        intent: { query_class: 'scenario' },
        requestPayload: { search: { query: 'gift ideas' } },
        policyMetadata: { source: 'shopping_agent' },
        rawUserQuery: 'gift ideas',
        primaryLatencyMs: 27,
        ambiguityScorePre: 0.82,
        traceId: 'trace_early',
        expandedQuery: 'gift ideas',
        expansionMode: 'direct',
        queryClass: 'scenario',
        rewriteGate: 'pass',
        associationPlan: 'none',
        flagsSnapshot: { flag_d: true },
        retrievalSources: ['internal_cache'],
      }),
    ).toEqual({
      shouldReturn: true,
      clarification: null,
      strictEmpty: true,
      response: {
        products: [],
        total: 0,
        page: 1,
        page_size: 0,
        reply: null,
        metadata: {
          query_source: 'cache_cross_merchant_search_early_decision',
          fetched_at: expect.any(String),
          merchants_searched: 1,
          source_breakdown: {
            internal_count: 0,
            external_seed_count: 0,
            stale_cache_used: false,
            strategy_applied: 'ambiguity_gate_before_upstream',
          },
          route_debug: {
            cross_merchant_cache: {
              attempted: true,
              products_count: 2,
              early_decision: {
                applied: true,
                reason: 'scenario_query',
                query_class: 'scenario',
              },
            },
          },
          policy_applied: true,
          strict_empty: true,
          route_health: {
            primaryPathUsed: 'cache_stage',
            primaryLatencyMs: 27,
            fallbackTriggered: false,
            fallbackReason: null,
            ambiguityScorePre: 0.82,
            ambiguityScorePost: 1,
            clarifyTriggered: false,
          },
          search_trace: {
            traceId: 'trace_early',
            rawQuery: 'gift ideas',
            expandedQuery: 'gift ideas',
            expansionMode: 'direct',
            queryClass: 'scenario',
            rewriteGate: 'pass',
            associationPlan: 'none',
            flagsSnapshot: { flag_d: true },
            intent: { query_class: 'scenario' },
            cacheStage: {
              hit: false,
              candidateCount: 0,
              relevantCount: 0,
              retrievalSources: ['internal_cache'],
              cacheRouteDebug: { attempted: true, products_count: 2 },
              selectedSource: 'cache_empty',
            },
            upstreamStage: {
              called: false,
              timeout: false,
              status: null,
              latency_ms: 0,
            },
            resolverStage: {
              called: false,
              hit: false,
              miss: false,
              latency_ms: null,
            },
            finalDecision: 'strict_empty',
          },
        },
        strict_empty: true,
      },
    });
  });

  test('guidance-only cache strict-empty response is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      isCatalogGuardSource(value) {
        return String(value || '').trim().toLowerCase() === 'catalog_guard';
      },
    });

    expect(
      runtime.buildGuidanceOnlyCacheStrictEmptyResponse({
        source: 'catalog_guard',
        page: 1,
        retrievalSources: ['internal_cache'],
        merchantsReturned: ['merchant_a'],
        cacheRouteDebug: {
          attempted: true,
          cache_hit: false,
        },
        routeDebugEnabled: true,
        cacheStrictReason: 'cache_miss_strict_empty',
        normalizedSeedStrategyForCache: 'unified_relevance',
      }),
    ).toEqual({
      status: 'success',
      success: true,
      products: [],
      total: 0,
      page: 1,
      page_size: 0,
      reply: null,
      metadata: expect.objectContaining({
        query_source: 'cache_cross_merchant_search',
        merchants_searched: 1,
        retrieval_sources: ['internal_cache'],
        source_breakdown: {
          internal_count: 0,
          external_seed_count: 0,
          stale_cache_used: false,
          strategy_applied: 'unified_relevance',
        },
        proxy_search_fallback: {
          applied: false,
          reason: 'cache_miss_strict_empty',
        },
        route_debug: {
          cross_merchant_cache: {
            attempted: true,
            cache_hit: false,
          },
        },
      }),
    });
  });

  test('guidance-only cache strict-empty outcome is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      isCatalogGuardSource(value) {
        return String(value || '').trim().toLowerCase() === 'catalog_guard';
      },
      applyFindProductsMultiPolicyIfNeeded({ response }) {
        return {
          ...response,
          metadata: {
            ...(response?.metadata || {}),
            policy_applied: true,
          },
        };
      },
      applyDealsToResponse(response) {
        return {
          ...response,
          metadata: {
            ...(response?.metadata || {}),
            deals_applied: true,
          },
        };
      },
      withSearchDiagnostics(response, diagnostics) {
        return {
          ...response,
          metadata: {
            ...(response?.metadata || {}),
            route_health: diagnostics.route_health,
            search_trace: diagnostics.search_trace,
          },
          ...(diagnostics.strict_empty ? { strict_empty: diagnostics.strict_empty } : {}),
          ...(diagnostics.strict_empty_reason
            ? { strict_empty_reason: diagnostics.strict_empty_reason }
            : {}),
        };
      },
      buildSearchRouteHealth(value) {
        return value;
      },
      buildSearchTrace(value) {
        return value;
      },
      buildCacheStageSnapshot(value) {
        return value;
      },
    });

    expect(
      runtime.buildGuidanceOnlyCacheStrictEmptyOutcome({
        source: 'catalog_guard',
        page: 1,
        retrievalSources: ['internal_cache'],
        merchantsReturned: ['merchant_a'],
        cacheRouteDebug: { attempted: true, cache_hit: false },
        routeDebugEnabled: true,
        cacheStrictReason: 'cache_miss_strict_empty',
        normalizedSeedStrategyForCache: 'unified_relevance',
        intent: { query_class: 'category' },
        requestPayload: { search: { query: 'repair serum' } },
        policyMetadata: { source: 'catalog_guard' },
        rawUserQuery: 'repair serum',
        promotions: [],
        now: new Date('2026-03-27T00:00:00.000Z'),
        creatorId: 'creator_1',
        primaryLatencyMs: 41,
        ambiguityScorePre: 0.61,
        traceId: 'trace_strict_outcome',
        expandedQuery: 'repair serum',
        expansionMode: 'direct',
        queryClass: 'category',
        rewriteGate: 'pass',
        associationPlan: 'none',
        flagsSnapshot: { flag_c: true },
        candidateCount: 0,
        relevantCount: 0,
      }),
    ).toEqual({
      response: {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        page: 1,
        page_size: 0,
        reply: null,
        metadata: {
          query_source: 'cache_cross_merchant_search',
          fetched_at: expect.any(String),
          merchants_searched: 1,
          source_breakdown: {
            internal_count: 0,
            external_seed_count: 0,
            stale_cache_used: false,
            strategy_applied: 'unified_relevance',
          },
          proxy_search_fallback: {
            applied: false,
            reason: 'cache_miss_strict_empty',
          },
          retrieval_sources: ['internal_cache'],
          route_debug: {
            cross_merchant_cache: { attempted: true, cache_hit: false },
          },
          policy_applied: true,
          deals_applied: true,
          route_health: {
            primaryPathUsed: 'cache_stage',
            primaryLatencyMs: 41,
            fallbackTriggered: false,
            fallbackReason: 'cache_miss_strict_empty',
            ambiguityScorePre: 0.61,
            ambiguityScorePost: 1,
            clarifyTriggered: false,
          },
          search_trace: {
            traceId: 'trace_strict_outcome',
            rawQuery: 'repair serum',
            expandedQuery: 'repair serum',
            expansionMode: 'direct',
            queryClass: 'category',
            rewriteGate: 'pass',
            associationPlan: 'none',
            flagsSnapshot: { flag_c: true },
            intent: { query_class: 'category' },
            cacheStage: {
              hit: false,
              candidateCount: 0,
              relevantCount: 0,
              retrievalSources: ['internal_cache'],
              cacheRouteDebug: { attempted: true, cache_hit: false },
              selectedSource: 'cache_strict_empty',
            },
            upstreamStage: {
              called: false,
              timeout: false,
              status: null,
              latency_ms: 0,
            },
            resolverStage: {
              called: false,
              hit: false,
              miss: false,
              latency_ms: null,
            },
            finalDecision: 'strict_empty',
          },
        },
        strict_empty: true,
        strict_empty_reason: 'cache_miss_strict_empty',
      },
      clarification: null,
    });
  });

  test('guidance-only cache hit outcome is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      withSearchDiagnostics(response, diagnostics) {
        return {
          ...response,
          metadata: {
            ...(response?.metadata || {}),
            route_health: diagnostics.route_health,
            search_trace: diagnostics.search_trace,
          },
        };
      },
      buildSearchRouteHealth(value) {
        return value;
      },
      buildSearchTrace(value) {
        return value;
      },
      buildCacheStageSnapshot(value) {
        return value;
      },
    });

    expect(
      runtime.buildGuidanceOnlyCacheHitOutcome({
        response: {
          products: [{ product_id: 'sku_1' }],
          clarification: {
            question: 'Which size do you want?',
          },
          metadata: {
            query_source: 'cache_cross_merchant_search',
          },
        },
        primaryLatencyMs: 31,
        ambiguityScorePre: 0.22,
        traceId: 'trace_cache_hit_outcome',
        rawQuery: 'ipsa toner',
        expandedQuery: 'ipsa toner',
        expansionMode: 'direct',
        queryClass: 'lookup',
        rewriteGate: 'pass',
        associationPlan: 'none',
        flagsSnapshot: { flag_e: true },
        intent: { query_class: 'lookup' },
        candidateCount: 3,
        relevantCount: 2,
        retrievalSources: ['internal_cache'],
        cacheRouteDebug: { attempted: true, cache_hit: true },
      }),
    ).toEqual({
      clarification: {
        question: 'Which size do you want?',
      },
      response: {
        products: [{ product_id: 'sku_1' }],
        clarification: {
          question: 'Which size do you want?',
        },
        metadata: {
          query_source: 'cache_cross_merchant_search',
          route_health: {
            primaryPathUsed: 'cache_stage',
            primaryLatencyMs: 31,
            fallbackTriggered: false,
            fallbackReason: null,
            ambiguityScorePre: 0.22,
            ambiguityScorePost: undefined,
            clarifyTriggered: true,
          },
          search_trace: {
            traceId: 'trace_cache_hit_outcome',
            rawQuery: 'ipsa toner',
            expandedQuery: 'ipsa toner',
            expansionMode: 'direct',
            queryClass: 'lookup',
            rewriteGate: 'pass',
            associationPlan: 'none',
            flagsSnapshot: { flag_e: true },
            intent: { query_class: 'lookup' },
            cacheStage: {
              hit: false,
              candidateCount: 3,
              relevantCount: 2,
              retrievalSources: ['internal_cache'],
              cacheRouteDebug: { attempted: true, cache_hit: true },
              selectedSource: 'internal_cache',
            },
            upstreamStage: {
              called: false,
              timeout: false,
              status: null,
              latency_ms: 0,
            },
            resolverStage: {
              called: false,
              hit: false,
              miss: false,
              latency_ms: null,
            },
            finalDecision: 'clarify',
          },
        },
      },
    });
  });

  test('guidance-only cache miss plan returns strict empty path inside aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      isCatalogGuardSource(value) {
        return String(value || '').trim().toLowerCase() === 'catalog_guard';
      },
    });

    expect(
      runtime.buildGuidanceOnlyCacheMissPlan({
        source: 'catalog_guard',
        cacheQueryText: 'repair serum',
        page: 1,
        limit: 10,
        inStockOnly: true,
        effectiveCacheHit: false,
        isLookupQuery: false,
        effectiveProducts: [],
        bypassCacheStrictEmpty: false,
        bypassCacheStrictEmptyForUnified: false,
        cacheStrictEmptyBypassReason: null,
        forceControlledRecallForScenario: false,
        cacheStrictEmptyEarlyReturnEnabled: true,
      }),
    ).toEqual({
      shouldEvaluateMissPlan: true,
      shouldReturnStrictEmpty: true,
      cacheStrictReason: 'cache_miss_strict_empty',
      shouldLogStrictEmptyBypass: false,
      strictEmptyBypassLogReason: null,
      upstreamFallbackLogPayload: {
        source: 'catalog_guard',
        page: 1,
        limit: 10,
        inStockOnly: true,
        query: 'repair serum',
      },
    });
  });

  test('guidance-only cache miss plan owns bypass logging reason inside aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      isCatalogGuardSource(value) {
        return String(value || '').trim().toLowerCase() === 'catalog_guard';
      },
    });

    expect(
      runtime.buildGuidanceOnlyCacheMissPlan({
        source: 'catalog_guard',
        cacheQueryText: 'repair serum',
        page: 1,
        limit: 10,
        inStockOnly: true,
        effectiveCacheHit: false,
        isLookupQuery: false,
        effectiveProducts: [{ product_id: 'sku_1' }],
        bypassCacheStrictEmpty: false,
        bypassCacheStrictEmptyForUnified: true,
        cacheStrictEmptyBypassReason: 'missing_external_for_unified',
        forceControlledRecallForScenario: false,
        cacheStrictEmptyEarlyReturnEnabled: false,
      }),
    ).toEqual({
      shouldEvaluateMissPlan: true,
      shouldReturnStrictEmpty: false,
      cacheStrictReason: 'cache_irrelevant_strict_empty',
      shouldLogStrictEmptyBypass: true,
      strictEmptyBypassLogReason: 'missing_external_for_unified',
      upstreamFallbackLogPayload: {
        source: 'catalog_guard',
        page: 1,
        limit: 10,
        inStockOnly: true,
        query: 'repair serum',
      },
    });
  });

  test('guidance-only cache miss logging artifacts are owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime();

    expect(
      runtime.buildGuidanceOnlyCacheMissLoggingArtifacts({
        source: 'aurora-bff',
        cacheQueryText: 'repair serum',
        cacheMissPlan: {
          shouldLogStrictEmptyBypass: true,
          strictEmptyBypassLogReason: 'missing_external_for_unified',
          upstreamFallbackLogPayload: {
            source: 'aurora-bff',
            page: 1,
            limit: 10,
            inStockOnly: true,
            query: 'repair serum',
          },
        },
      }),
    ).toEqual({
      bypassLog: {
        payload: {
          source: 'aurora-bff',
          query: 'repair serum',
          reason: 'missing_external_for_unified',
        },
        message: 'Catalog cache miss strict-empty bypassed; continuing to upstream search',
      },
      upstreamFallbackLog: {
        payload: {
          source: 'aurora-bff',
          page: 1,
          limit: 10,
          inStockOnly: true,
          query: 'repair serum',
        },
        message: 'Cross-merchant cache search returned empty; falling back to upstream',
      },
    });
  });

  test('guidance-only cache resolver fallback plan is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      shouldAttemptCacheMissResolverFallback({ resolverFallbackEnabled, isLookupQuery, cacheQueryText }) {
        return Boolean(resolverFallbackEnabled && isLookupQuery && String(cacheQueryText || '').trim());
      },
      buildCacheMissResolverFallbackRequest(params) {
        return {
          built: true,
          ...params,
        };
      },
      auroraResolverTimeoutMs: () => 1800,
      defaultResolverTimeoutMs: () => 900,
    });

    expect(
      runtime.buildGuidanceOnlyCacheResolverFallbackPlan({
        resolverFallbackEnabled: true,
        isLookupQuery: true,
        search: { page: 1 },
        cacheQueryText: 'ipsa toner',
        inStockOnly: true,
        limit: 10,
        normalizedSeedStrategyForCache: 'unified_relevance',
        checkoutToken: 'token_1',
        source: 'aurora-bff',
      }),
    ).toEqual({
      shouldAttemptResolverFallback: true,
      request: {
        built: true,
        search: { page: 1 },
        cacheQueryText: 'ipsa toner',
        inStockOnly: true,
        limit: 10,
        normalizedSeedStrategyForCache: 'unified_relevance',
        checkoutToken: 'token_1',
        source: 'aurora-bff',
        auroraResolverTimeoutMs: 1800,
        resolverTimeoutMs: 900,
      },
    });
  });

  test('guidance-only cache failure artifacts are owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime();

    expect(
      runtime.buildGuidanceOnlyCacheFailureArtifacts({
        error: { code: 'STAGE_TIMEOUT', message: 'cache stage timed out' },
        cacheQueryText: 'repair serum',
        expandedCacheSearchQueryText: 'hydrating repair serum',
        preferRawBeautyCacheQuery: false,
        queryText: 'hydrating repair serum',
        page: 2,
        limit: 12,
        inStockOnly: true,
        cacheStageBudgetMs: 150,
        cacheBeautyBucket: 'serum',
        source: 'aurora-bff',
      }),
    ).toEqual({
      cacheRouteDebug: {
        attempted: true,
        mode: 'search',
        query: 'repair serum',
        cache_query: 'hydrating repair serum',
        cache_query_mode: null,
        cache_query_terms: [],
        upstream_query: 'hydrating repair serum',
        page: 2,
        limit: 12,
        in_stock_only: true,
        cache_hit: false,
        timeout_budget_ms: 150,
        stage_timeout: true,
        beauty_query_bucket: 'serum',
        error: 'cache stage timed out',
      },
      warnLogPayload: {
        err: 'cache stage timed out',
        source: 'aurora-bff',
        query: 'repair serum',
      },
    });
  });

  test('guidance-only cache resolver fallback outcome is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      buildCacheMissResolverFallbackDiagnosedResponse(params) {
        return {
          response: {
            status: 'success',
            products: [{ product_id: 'sku_resolver' }],
            metadata: {
              echoed_query: params.rawQuery,
              final_decision: 'resolver_returned',
            },
          },
        };
      },
    });

    expect(
      runtime.buildGuidanceOnlyCacheResolverFallbackOutcome({
        result: {
          status: 200,
          usableCount: 2,
          data: { products: [{ product_id: 'sku_resolver' }] },
        },
        promotions: [],
        now: new Date('2026-03-27T00:00:00.000Z'),
        creatorId: 'creator_1',
        primaryLatencyMs: 42,
        ambiguityScorePre: 0.15,
        effectiveProducts: [],
        internalProductsAfterAnchor: [],
        retrievalSources: ['internal_cache'],
        cacheRouteDebug: { attempted: true },
        traceId: 'trace_1',
        rawQuery: 'ipsa toner',
        expandedQuery: 'ipsa toner',
        expansionMode: 'none',
        queryClass: 'lookup',
        rewriteGate: 'pass',
        associationPlan: { mode: 'lookup' },
        flagsSnapshot: { strict: true },
        intent: { query_class: 'lookup' },
      }),
    ).toEqual({
      shouldReturnResolverFallback: true,
      response: {
        status: 'success',
        products: [{ product_id: 'sku_resolver' }],
        metadata: {
          echoed_query: 'ipsa toner',
          final_decision: 'resolver_returned',
        },
      },
    });
  });

  test('guidance-only cache resolver fallback failure artifacts are owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime();

    expect(
      runtime.buildGuidanceOnlyCacheResolverFallbackFailureArtifacts({
        error: { message: 'resolver fallback timed out' },
        cacheQueryText: 'ipsa toner',
      }),
    ).toEqual({
      warnLogPayload: {
        err: 'resolver fallback timed out',
        query: 'ipsa toner',
      },
    });
  });

  test('guidance-only cache diagnosed response is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      withSearchDiagnostics(response, diagnostics) {
        return {
          ...response,
          metadata: {
            ...(response?.metadata || {}),
            route_health: diagnostics.route_health,
            search_trace: diagnostics.search_trace,
          },
        };
      },
      buildSearchRouteHealth(value) {
        return value;
      },
      buildSearchTrace(value) {
        return value;
      },
      buildCacheStageSnapshot(value) {
        return value;
      },
    });

    expect(
      runtime.buildGuidanceOnlyCacheDiagnosedResponse({
        response: {
          products: [{ product_id: 'sku_1' }],
          metadata: {
            query_source: 'cache_cross_merchant_search',
          },
        },
        primaryLatencyMs: 42,
        ambiguityScorePre: 0.18,
        traceId: 'trace_cache_hit',
        rawQuery: 'vitamin c serum',
        expandedQuery: 'vitamin c serum',
        expansionMode: 'direct',
        queryClass: 'lookup',
        rewriteGate: 'pass',
        associationPlan: 'none',
        flagsSnapshot: { flag_a: true },
        intent: { target_object: { type: 'product' } },
        candidateCount: 3,
        relevantCount: 2,
        retrievalSources: ['internal_cache'],
        cacheRouteDebug: { attempted: true, cache_hit: true },
        selectedSource: 'internal_cache',
        clarifyTriggered: false,
        finalDecision: 'cache_returned',
      }),
    ).toEqual({
      products: [{ product_id: 'sku_1' }],
      metadata: {
        query_source: 'cache_cross_merchant_search',
        route_health: {
          primaryPathUsed: 'cache_stage',
          primaryLatencyMs: 42,
          fallbackTriggered: false,
          fallbackReason: null,
          ambiguityScorePre: 0.18,
          ambiguityScorePost: undefined,
          clarifyTriggered: false,
        },
        search_trace: {
          traceId: 'trace_cache_hit',
          rawQuery: 'vitamin c serum',
          expandedQuery: 'vitamin c serum',
          expansionMode: 'direct',
          queryClass: 'lookup',
          rewriteGate: 'pass',
          associationPlan: 'none',
          flagsSnapshot: { flag_a: true },
          intent: { target_object: { type: 'product' } },
          cacheStage: {
            hit: true,
            candidateCount: 3,
            relevantCount: 2,
            retrievalSources: ['internal_cache'],
            cacheRouteDebug: { attempted: true, cache_hit: true },
            selectedSource: 'internal_cache',
          },
          upstreamStage: {
            called: false,
            timeout: false,
            status: null,
            latency_ms: 0,
          },
          resolverStage: {
            called: false,
            hit: false,
            miss: false,
            latency_ms: null,
          },
          finalDecision: 'cache_returned',
        },
      },
    });
  });

  test('guidance-only cache diagnosed response marks strict empty through aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      withSearchDiagnostics(response, diagnostics) {
        return {
          ...response,
          metadata: {
            ...(response?.metadata || {}),
            route_health: diagnostics.route_health,
            search_trace: diagnostics.search_trace,
          },
          ...(diagnostics.strict_empty ? { strict_empty: diagnostics.strict_empty } : {}),
          ...(diagnostics.strict_empty_reason
            ? { strict_empty_reason: diagnostics.strict_empty_reason }
            : {}),
        };
      },
      buildSearchRouteHealth(value) {
        return value;
      },
      buildSearchTrace(value) {
        return value;
      },
      buildCacheStageSnapshot(value) {
        return value;
      },
    });

    expect(
      runtime.buildGuidanceOnlyCacheDiagnosedResponse({
        response: {
          products: [],
          metadata: {
            query_source: 'cache_cross_merchant_search',
          },
        },
        primaryLatencyMs: 55,
        ambiguityScorePre: 0.63,
        traceId: 'trace_strict_empty',
        rawQuery: 'hydrating toner',
        expandedQuery: 'hydrating toner',
        expansionMode: 'semantic_retry',
        queryClass: 'scenario',
        rewriteGate: 'defer',
        associationPlan: 'step_family',
        flagsSnapshot: { flag_b: false },
        intent: { target_object: { type: 'routine' } },
        candidateCount: 1,
        relevantCount: 0,
        retrievalSources: ['internal_cache'],
        cacheRouteDebug: { attempted: true, cache_hit: false },
        selectedSource: 'cache_strict_empty',
        clarifyTriggered: false,
        finalDecision: 'strict_empty',
        fallbackReason: 'cache_miss_strict_empty',
        strictEmpty: true,
        strictEmptyReason: 'cache_miss_strict_empty',
      }),
    ).toEqual({
      products: [],
      metadata: {
        query_source: 'cache_cross_merchant_search',
        route_health: {
          primaryPathUsed: 'cache_stage',
          primaryLatencyMs: 55,
          fallbackTriggered: false,
          fallbackReason: 'cache_miss_strict_empty',
          ambiguityScorePre: 0.63,
          ambiguityScorePost: 1,
          clarifyTriggered: false,
        },
        search_trace: {
          traceId: 'trace_strict_empty',
          rawQuery: 'hydrating toner',
          expandedQuery: 'hydrating toner',
          expansionMode: 'semantic_retry',
          queryClass: 'scenario',
          rewriteGate: 'defer',
          associationPlan: 'step_family',
          flagsSnapshot: { flag_b: false },
          intent: { target_object: { type: 'routine' } },
          cacheStage: {
            hit: false,
            candidateCount: 1,
            relevantCount: 0,
            retrievalSources: ['internal_cache'],
            cacheRouteDebug: { attempted: true, cache_hit: false },
            selectedSource: 'cache_strict_empty',
          },
          upstreamStage: {
            called: false,
            timeout: false,
            status: null,
            latency_ms: 0,
          },
          resolverStage: {
            called: false,
            hit: false,
            miss: false,
            latency_ms: null,
          },
          finalDecision: 'strict_empty',
        },
      },
      strict_empty: true,
      strict_empty_reason: 'cache_miss_strict_empty',
    });
  });

  test('invoke find_products_multi metadata finalization is owned by aurora orchestration facade', () => {
    const runtime = createAuroraBeautyOrchestrationRuntime({
      normalizeSearchUiSurface(value) {
        return String(value || '').trim().toLowerCase();
      },
      normalizeRecoTargetStep(value) {
        return String(value || '').trim().toLowerCase() || null;
      },
      firstQueryParamValue(value) {
        return Array.isArray(value) ? value[0] : value;
      },
      normalizeGuidanceDiscoveryProductPdpContract(product) {
        return {
          ...product,
          normalized_for_guidance: true,
        };
      },
      normalizeGuidanceDiscoverySourcePolicy(value) {
        return String(value || '').trim().toLowerCase() || null;
      },
      parseQueryBoolean(value) {
        return value === true || value === 'true';
      },
      parseQueryNumber(value) {
        return value == null ? null : Number(value);
      },
      inferGuidanceDiscoverySourceUsed() {
        return 'internal_cache';
      },
      resolveGuidanceSearchStepStrength(value) {
        return String(value || 'auto');
      },
      buildGuidanceOnlyHitQualityDecision() {
        return {
          applied: true,
          query_target_step_family: 'cleanser',
          query_step_strength: 'focused',
          hit_quality: 'valid_hit',
          normalized_intent: 'target_step_lookup',
          quality_gate_result: 'pass',
          candidate_origin_counts: { internal: 1 },
          displayable_candidate_count: 1,
          fill_target_count: 3,
          fill_completed_count: 1,
          products_returned_count: 1,
        };
      },
      guidanceDecisionContractVersion: 'beauty_contract_v2',
      countCandidateOriginBreakdown(products) {
        return { internal: Array.isArray(products) ? products.length : 0 };
      },
      mergeSearchCountMaps(...maps) {
        return Object.assign({}, ...maps.filter(Boolean));
      },
    });

    const finalized = runtime.finalizeInvokeFindProductsMultiResponse({
      response: {
        products: [{ product_id: 'sku_1' }],
        metadata: {
          ui_surface: 'ingredient_plan_guidance_only',
          query_target_step_family: 'cleanser',
          query_step_strength: 'focused',
          source_policy: 'Guided_Only',
          semantic_retry_applied: true,
          semantic_retry_query: 'hydrating cleanser',
          semantic_retry_hits: 2,
          route_debug: {
            policy: {
              ambiguity: {
                domain_filter_dropped_external: 4,
              },
            },
          },
        },
      },
      reqQuery: {
        query: 'hydrating cleanser',
        product_only: 'true',
      },
      routeContext: {
        orchestrator_path: 'aurora_invoke_postprocess',
      },
      orchestratorVersion: 'search_orchestrator_test_v1',
    });

    expect(finalized.metadata).toMatchObject({
      orchestrator_version: 'search_orchestrator_test_v1',
      orchestrator_path: 'aurora_invoke_postprocess',
      semantic_retry_applied: true,
      semantic_retry_query: 'hydrating cleanser',
      semantic_retry_hits: 2,
      domain_filter_dropped_external: 4,
      normalized_intent: 'target_step_lookup',
      quality_gate_result: 'pass',
      candidate_origin_counts: { internal: 1 },
      displayable_candidate_count: 1,
      fill_target_count: 3,
      fill_completed_count: 1,
    });
    expect(finalized.metadata.search_decision).toMatchObject({
      contract_version: 'beauty_contract_v2',
      hit_quality: 'valid_hit',
      query_target_step_family: 'cleanser',
      query_step_strength: 'focused',
      decision_mode: 'guidance_only',
      discovery_source_used: 'internal_cache',
      product_only_applied: true,
    });
  });
});
