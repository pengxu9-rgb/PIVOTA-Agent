const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFindProductsBeautyDiscoveryLocalMainlineRuntime,
} = require('../src/findProductsBeautyDiscoveryLocalMainline');
const {
  createFindProductsInvokeSemanticOwnerExecutionRuntime,
} = require('../src/findProductsInvokeSemanticOwnerExecution');

function createRuntime(overrides = {}) {
  const observedTransportPolicies = [];
  const runtime = createFindProductsBeautyDiscoveryLocalMainlineRuntime({
    buildBeautyDiscoverySemanticContract: () => ({
      planner_mode: 'framework_generic',
      request_class: 'generic_concern',
      semantic_family: 'oil_control',
    }),
    buildConcernSemanticPlanFallback: () => ({
      plan_id: 'framework_oily',
      core_roles: [
        { role_id: 'oil_control_treatment', rank: 1, label: 'Oil-control treatment', preferred_step: 'treatment' },
        { role_id: 'lightweight_moisturizer', rank: 2, label: 'Lightweight moisturizer', preferred_step: 'moisturizer' },
      ],
      support_roles: [{ role_id: 'daily_sunscreen', rank: 3, label: 'Daily sunscreen', preferred_step: 'sunscreen' }],
      selection_owner_source: 'test_planner',
      selection_owner_state: 'trusted',
      framework_summary: { concern_text: 'im oily skin, what products should i use?' },
      concern_signals: {},
    }),
    buildConcernTargetContextFromSemanticPlan: (plan) => ({
      framework_id: plan.plan_id,
      framework_roles: plan.core_roles,
      support_roles: plan.support_roles,
      primary_role_id: 'oil_control_treatment',
      framework_owner_source: 'test_planner',
      framework_owner_state: 'trusted',
      semantic_plan: plan,
    }),
    buildRecoRecallPlan: () => ({
      mode: 'framework_generic',
      entries: [
        {
          stage_id: 'framework_stage_a_primary_internal',
          query: 'oil control treatment',
          role_id: 'oil_control_treatment',
          role_rank: 1,
          preferred_step: 'treatment',
          source_scope: 'internal',
          query_index: 0,
        },
        {
          stage_id: 'framework_stage_c_support_lightweight_moisturizer',
          query: 'lightweight moisturizer oily skin',
          role_id: 'lightweight_moisturizer',
          role_rank: 2,
          preferred_step: 'moisturizer',
          source_scope: 'internal',
          query_index: 1,
        },
      ],
      stages: [
        {
          stage_id: 'framework_stage_a_primary_internal',
          role_id: 'oil_control_treatment',
          role_rank: 1,
          source_scope: 'internal',
          entries: [
            {
              query: 'oil control treatment',
              role_id: 'oil_control_treatment',
              role_rank: 1,
              preferred_step: 'treatment',
              source_scope: 'internal',
              query_index: 0,
            },
          ],
        },
        {
          stage_id: 'framework_stage_c_support_lightweight_moisturizer',
          role_id: 'lightweight_moisturizer',
          role_rank: 2,
          source_scope: 'internal',
          entries: [
            {
              query: 'lightweight moisturizer oily skin',
              role_id: 'lightweight_moisturizer',
              role_rank: 2,
              preferred_step: 'moisturizer',
              source_scope: 'internal',
              query_index: 1,
            },
          ],
        },
      ],
    }),
    buildRecoSearchSemanticContract: () => ({ owner: 'aurora_reco_planner' }),
    shouldRunRecoRecallStage: () => ({ run: true }),
    buildRecoRecallTransportPolicy: () => ({ mode: 'framework_first_turn', include_self_proxy: true }),
    resolveRecoRecallTransportModeForPlannerMode: () => 'framework_first_turn',
    searchPivotaBackendProducts: async ({ query, transportPolicy }) => {
      observedTransportPolicies.push(transportPolicy || null);
      if (query === 'oil control treatment') {
        return {
          ok: true,
          reason: 'ok',
          actual_http_attempt_count: 1,
          products: [
            {
              product_id: 'niacinamide_1',
              merchant_id: 'merchant_internal',
              title: 'Oil Control Niacinamide Serum',
              retrieval_source: 'internal_search',
              source_tier: 'fresh_internal',
              source_quality_class: 'trusted',
            },
          ],
        };
      }
      return {
        ok: true,
        reason: 'ok',
        actual_http_attempt_count: 1,
        products: [
          {
            product_id: 'moisturizer_1',
            merchant_id: 'merchant_internal',
            title: 'Lightweight Gel Moisturizer',
            retrieval_source: 'internal_search',
            source_tier: 'fresh_internal',
            source_quality_class: 'trusted',
          },
        ],
      };
    },
    normalizeRecoCatalogProduct: (product) => product,
    normalizeAgentProductsListResponse: (body) => body,
    finalizeConcernFrameworkCandidatePools: (rawCandidates) => {
      const list = Array.isArray(rawCandidates) ? rawCandidates : [];
      const treatment = list.find((item) => item.retrieval_role_id === 'oil_control_treatment') || null;
      const moisturizer = list.find((item) => item.retrieval_role_id === 'lightweight_moisturizer') || null;
      const selected = [treatment, moisturizer].filter(Boolean).map((item) => ({
        ...item,
        matched_role_id: item.retrieval_role_id,
      }));
      return {
        selected_recommendations: selected,
        primary_role_matched: Boolean(treatment),
      };
    },
    countCandidateOriginBreakdown: () => ({
      internal_live: 2,
      external_supplement: 0,
      stable_prior: 0,
      source_channel_counts: { internal_search: 2 },
      source_tier_counts: { fresh_internal: 2 },
      source_quality_counts: { trusted: 2 },
      cache_owner_paths: [],
      top_candidate_provenance: { source_channel: 'internal_search', source_tier: 'fresh_internal' },
    }),
    withSearchDiagnostics: (body, diagnostics) => ({
      ...body,
      metadata: {
        ...(body.metadata || {}),
        ...(diagnostics.route_health ? { route_health: diagnostics.route_health } : {}),
        ...(diagnostics.search_trace ? { search_trace: diagnostics.search_trace } : {}),
        ...(diagnostics.search_decision ? { search_decision: diagnostics.search_decision } : {}),
      },
    }),
    buildSearchRouteHealth: (value) => value,
    buildSearchTrace: (value) => value,
    buildDecisionAuthorityPatch: (value) => value,
    applyInvokeBeautyAuthority: ({ enriched, semanticOwnerQueryAttempts }) => ({
      enriched: {
        ...enriched,
        metadata: {
          ...(enriched.metadata || {}),
          resolved_contract: 'agent_v1_search_beauty_mainline',
          contract_bridge: { resolved_contract: 'agent_v1_search_beauty_mainline' },
          search_stage_ledger: {
            primary_search: {
              query_pack_attempts: semanticOwnerQueryAttempts,
            },
          },
        },
      },
      existingMeta: enriched.metadata || {},
      searchStageLedger: {
        primary_search: {
          query_pack_attempts: semanticOwnerQueryAttempts,
        },
      },
      lowConfidenceFlag: false,
      normalizedLowConfidenceReasons: [],
    }),
    applyBeautySearchMetadataAuthority: ({ enriched }) => enriched,
    buildFindProductsSearchExecutionTrace: ({
      requestContract,
      executionPlan,
      supplementsAttempted,
      primaryFailureStage,
    }) => ({
      primary_lane: executionPlan?.primary_lane || requestContract?.primary_lane || null,
      primary_retrieval_contract:
        executionPlan?.primary_retrieval_contract ||
        requestContract?.primary_retrieval_contract ||
        null,
      supplements_attempted: supplementsAttempted || [],
      primary_failure_stage: primaryFailureStage || null,
      owner_switch_count: executionPlan?.owner_switch_count || 0,
    }),
    BEAUTY_DISCOVERY_MAINLINE_OWNER: 'shopping_agent_beauty_mainline',
    ...overrides,
  });
  runtime.__observedTransportPolicies = observedTransportPolicies;
  return runtime;
}

test('broad beauty generic query uses local beauty discovery mainline', () => {
  const runtime = createRuntime();
  const out = runtime.shouldUseLocalBeautyDiscoveryMainline({
    search: {
      query: 'im oily skin, what products should i use?',
    },
    metadata: {
      source: 'aurora-bff',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
    },
  });

  assert.equal(out, true);
});

test('product-only direct beauty search still uses local beauty discovery mainline', () => {
  const runtime = createRuntime();
  const out = runtime.shouldUseLocalBeautyDiscoveryMainline({
    search: {
      query: 'im oily skin, what products should i use?',
      product_only: true,
    },
    metadata: {
      source: 'aurora-bff',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
    },
  });

  assert.equal(out, true);
});

test('aurora-bff search calls still use local beauty discovery mainline', () => {
  const runtime = createRuntime();
  const out = runtime.shouldUseLocalBeautyDiscoveryMainline({
    search: {
      query: 'im oily skin, what products should i use?',
      product_only: true,
    },
    metadata: {
      source: 'aurora-bff',
    },
    requestContract: {
      surface: 'chat',
      primary_lane: 'beauty_discovery_mainline',
    },
  });

  assert.equal(out, true);
});

test('aurora-bff broad search uses raw user query before semantic query rewrite', () => {
  const runtime = createRuntime();
  const out = runtime.shouldUseLocalBeautyDiscoveryMainline({
    search: {
      query: 'oil control treatment',
      product_only: true,
    },
    metadata: {
      source: 'aurora-bff',
    },
    requestContract: {
      surface: 'chat',
      primary_lane: 'beauty_discovery_mainline',
    },
    rawUserQuery: 'im oily skin, what products should i use?',
  });

  assert.equal(out, true);
});

test('aurora-bff non-broad framework search stays on semantic-owner path', () => {
  const runtime = createRuntime();
  const out = runtime.shouldUseLocalBeautyDiscoveryMainline({
    search: {
      query: 'oil control serum',
      product_only: true,
    },
    metadata: {
      source: 'aurora-bff',
    },
    requestContract: {
      surface: 'chat',
      primary_lane: 'beauty_discovery_mainline',
    },
  });

  assert.equal(out, false);
});

test('explicit step-aware sunscreen query uses local beauty discovery mainline', () => {
  const runtime = createRuntime();
  const out = runtime.shouldUseLocalBeautyDiscoveryMainline({
    search: {
      query: 'best sunscreen for oily skin',
      target_step_family: 'sunscreen',
    },
    metadata: {
      source: 'shopping',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      semantic_contract: {
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        semantic_family: 'sunscreen',
        primary_role_id: 'daily_sunscreen',
      },
    },
  });

  assert.equal(out, true);
});

test('local beauty child requests cannot re-enter local discovery mainline', () => {
  const runtime = createRuntime();
  const out = runtime.shouldUseLocalBeautyDiscoveryMainline({
    search: {
      query: 'best sunscreen for oily skin',
      target_step_family: 'sunscreen',
      local_mainline_child: true,
    },
    metadata: {
      source: 'aurora-bff',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      semantic_contract: {
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        semantic_family: 'sunscreen',
        primary_role_id: 'daily_sunscreen',
      },
    },
  });

  assert.equal(out, false);
});

test('local beauty discovery mainline returns authoritative search metadata and supplement traces', async () => {
  const runtime = createRuntime();
  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'im oily skin, what products should i use?',
      limit: 6,
    },
    metadata: {
      source: 'shopping',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'im oily skin, what products should i use?',
    gatewayRequestId: 'trace_test',
    timeoutMs: 12000,
    invokeStartedAtMs: Date.now(),
  });

  assert.equal(out.handled, true);
  assert.equal(out.response.reply, null);
  assert.equal(out.response.metadata?.resolved_contract, 'agent_v1_search_beauty_mainline');
  assert.deepEqual(
    (out.response.products || []).map((item) => item.product_id),
    ['niacinamide_1', 'moisturizer_1'],
  );
  assert.equal(
    out.response.metadata?.search_execution_trace?.primary_lane,
    'beauty_discovery_mainline',
  );
  assert.equal(
    out.response.metadata?.search_execution_trace?.primary_retrieval_contract,
    'agent_v1_search_beauty_mainline',
  );
  assert.equal(runtime.__observedTransportPolicies[0]?.include_self_proxy, false);
  assert.equal(runtime.__observedTransportPolicies[0]?.prefer_self_proxy_first, false);
  assert.equal(
    out.response.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts?.length,
    2,
  );
  assert.deepEqual(
    out.response.metadata?.supplement_traces,
    [
      {
        supplement_type: 'semantic_owner_framework_support',
        supplement_reason: 'role_coverage_repair',
        status: 'applied',
        attempted_queries: ['lightweight moisturizer oily skin'],
        applied_queries: ['lightweight moisturizer oily skin'],
        added_products: ['moisturizer_1'],
        filtered_products: 0,
        did_change_primary_slot: false,
      },
    ],
  );
});

test('catalog child recall uses local child transport instead of falling back to legacy upstream', async () => {
  const runtime = createRuntime({
    searchPivotaBackendProducts: async ({
      query,
      localMainlineChild,
      transportPolicy,
      semanticContract,
      queryIndex,
      queryTotal,
    }) => {
      assert.equal(localMainlineChild, undefined);
      assert.equal(semanticContract, undefined);
      assert.equal(queryIndex, undefined);
      assert.equal(queryTotal, undefined);
      assert.equal(transportPolicy?.include_self_proxy, false);
      assert.equal(transportPolicy?.prefer_self_proxy_first, false);
      assert.equal(transportPolicy?.allow_secondary_base_failover, false);
      assert.equal(transportPolicy?.allow_secondary_path_failover, false);
      assert.equal(transportPolicy?.max_base_urls, 1);
      assert.equal(transportPolicy?.max_paths, 1);
      return {
        ok: true,
        reason: 'ok',
        actual_http_attempt_count: 1,
        products: [
          {
            product_id: 'sunscreen_1',
            merchant_id: 'merchant_internal',
            title: 'Oil Control Sunscreen SPF 50',
            retrieval_source: 'internal_search',
            source_tier: 'fresh_internal',
            source_quality_class: 'trusted',
          },
        ],
      };
    },
  });

  const out = await runtime.runLocalBeautyCatalogChildRecall({
    search: {
      query: 'best sunscreen for oily skin',
      limit: 6,
      target_step_family: 'sunscreen',
      semantic_family: 'sunscreen',
      product_only: true,
    },
    metadata: {
      source: 'aurora-bff',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'catalog_child_recall',
      primary_retrieval_contract: 'agent_v2_catalog_child_recall',
      semantic_contract: {
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        semantic_family: 'sunscreen',
      },
    },
    executionPlan: {
      primary_lane: 'catalog_child_recall',
      primary_retrieval_contract: 'agent_v2_catalog_child_recall',
      owner_switch_count: 0,
    },
    rawUserQuery: 'best sunscreen for oily skin',
    timeoutMs: 3200,
  });

  assert.equal(out.handled, true);
  assert.equal(out.response.reply, null);
  assert.deepEqual(
    (out.response.products || []).map((item) => item.product_id),
    ['sunscreen_1'],
  );
  assert.equal(
    out.response.metadata?.search_execution_trace?.primary_lane,
    'catalog_child_recall',
  );
  assert.equal(
    out.response.metadata?.search_execution_trace?.primary_retrieval_contract,
    'agent_v2_catalog_child_recall',
  );
  assert.equal(out.response.metadata?.search_execution_trace?.primary_failure_stage, null);
});

test('catalog child recall fail-closes on timeout without owner switch', async () => {
  const runtime = createRuntime({
    searchPivotaBackendProducts: async () => {
      const err = new Error('timeout of 2400ms exceeded');
      err.code = 'ECONNABORTED';
      throw err;
    },
  });

  const out = await runtime.runLocalBeautyCatalogChildRecall({
    search: {
      query: 'best sunscreen for oily skin',
      limit: 6,
      target_step_family: 'sunscreen',
      product_only: true,
    },
    metadata: {
      source: 'aurora-bff',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'catalog_child_recall',
      primary_retrieval_contract: 'agent_v2_catalog_child_recall',
    },
    executionPlan: {
      primary_lane: 'catalog_child_recall',
      primary_retrieval_contract: 'agent_v2_catalog_child_recall',
      owner_switch_count: 0,
    },
    rawUserQuery: 'best sunscreen for oily skin',
    timeoutMs: 2400,
  });

  assert.equal(out.handled, true);
  assert.deepEqual(out.response.products || [], []);
  assert.equal(
    out.response.metadata?.search_execution_trace?.primary_failure_stage,
    'primary_upstream_timeout',
  );
  assert.equal(
    out.response.metadata?.search_execution_trace?.owner_switch_count,
    0,
  );
});

test('local beauty discovery mainline fail-closes when recall plan is empty', async () => {
  const runtime = createRuntime({
    buildRecoRecallPlan: () => ({
      mode: 'framework_generic',
      entries: [],
      stages: [],
    }),
  });
  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'im oily skin, what products should i use?',
    },
    metadata: {
      source: 'shopping',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'im oily skin, what products should i use?',
    gatewayRequestId: 'trace_empty',
    timeoutMs: 12000,
    invokeStartedAtMs: Date.now(),
  });

  assert.equal(out.handled, true);
  assert.equal(out.response.reply, null);
  assert.deepEqual(out.response.products, []);
  assert.equal(out.response.metadata?.resolved_contract, 'agent_v1_search_beauty_mainline');
  assert.equal(
    out.response.metadata?.search_execution_trace?.primary_failure_stage,
    'recall_plan_empty',
  );
  assert.equal(out.response.metadata?.search_execution_trace?.owner_switch_count, 0);
});

test('framework local recall stops after primary timeout instead of advancing to support stage', async () => {
  const attemptedQueries = [];
  const attemptedTimeouts = [];
  const runtime = createRuntime({
    buildRecoRecallPlan: () => ({
      mode: 'framework_generic',
      entries: [
        {
          stage_id: 'framework_stage_a_primary_internal',
          query: 'oil control treatment',
          role_id: 'oil_control_treatment',
          role_rank: 1,
          preferred_step: 'treatment',
          source_scope: 'internal',
          query_index: 0,
        },
        {
          stage_id: 'framework_stage_a_primary_internal',
          query: 'shine control serum',
          role_id: 'oil_control_treatment',
          role_rank: 1,
          preferred_step: 'treatment',
          source_scope: 'internal',
          query_index: 1,
        },
        {
          stage_id: 'framework_stage_c_support_lightweight_moisturizer',
          query: 'lightweight moisturizer oily skin',
          role_id: 'lightweight_moisturizer',
          role_rank: 2,
          preferred_step: 'moisturizer',
          source_scope: 'internal',
          query_index: 2,
        },
      ],
      stages: [
        {
          stage_id: 'framework_stage_a_primary_internal',
          role_id: 'oil_control_treatment',
          role_rank: 1,
          source_scope: 'internal',
          entries: [
            {
              query: 'oil control treatment',
              role_id: 'oil_control_treatment',
              role_rank: 1,
              preferred_step: 'treatment',
              source_scope: 'internal',
              query_index: 0,
            },
            {
              query: 'shine control serum',
              role_id: 'oil_control_treatment',
              role_rank: 1,
              preferred_step: 'treatment',
              source_scope: 'internal',
              query_index: 1,
            },
          ],
        },
        {
          stage_id: 'framework_stage_c_support_lightweight_moisturizer',
          role_id: 'lightweight_moisturizer',
          role_rank: 2,
          source_scope: 'internal',
          entries: [
            {
              query: 'lightweight moisturizer oily skin',
              role_id: 'lightweight_moisturizer',
              role_rank: 2,
              preferred_step: 'moisturizer',
              source_scope: 'internal',
              query_index: 2,
            },
          ],
        },
      ],
    }),
    searchPivotaBackendProducts: async ({ query, timeoutMs }) => {
      attemptedQueries.push(String(query || ''));
      attemptedTimeouts.push(Number(timeoutMs || 0));
      if (query === 'oil control treatment') {
        return {
          ok: false,
          reason: 'upstream_timeout',
          actual_http_attempt_count: 1,
          products: [],
        };
      }
      return {
        ok: true,
        reason: 'ok',
        actual_http_attempt_count: 1,
        products: [
          {
            product_id: 'moisturizer_1',
            merchant_id: 'merchant_internal',
            title: 'Lightweight Gel Moisturizer',
            retrieval_source: 'internal_search',
            source_tier: 'fresh_internal',
            source_quality_class: 'trusted',
          },
        ],
      };
    },
  });
  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'im oily skin, what products should i use?',
      limit: 6,
    },
    metadata: {
      source: 'shopping',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'im oily skin, what products should i use?',
    gatewayRequestId: 'trace_framework_timeout_stage',
    timeoutMs: 6500,
    invokeStartedAtMs: Date.now(),
  });

  assert.equal(out.handled, true);
  assert.deepEqual(attemptedQueries, ['oil control treatment']);
  assert.ok(attemptedTimeouts.every((timeout) => timeout <= 2400));
  assert.equal(
    out.response.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts?.[0]
      ?.attempt_timeout_ms <= 2400,
    true,
  );
  assert.equal(
    out.response.metadata?.search_execution_trace?.primary_failure_stage,
    'primary_upstream_timeout',
  );
  assert.deepEqual(
    out.response.metadata?.search_execution_trace?.supplements_attempted || [],
    [],
  );
});

test('framework local recall gives the first primary internal anchor a wider timeout floor under full fanout', async () => {
  const attemptedTimeouts = [];
  const attemptedArgs = [];
  const runtime = createRuntime({
    buildRecoRecallPlan: () => ({
      mode: 'framework_generic',
      entries: [
        {
          stage_id: 'framework_stage_a_primary_internal',
          query: 'oil control treatment',
          role_id: 'oil_control_treatment',
          role_rank: 1,
          preferred_step: 'treatment',
          source_scope: 'internal',
          query_index: 0,
        },
        ...Array.from({ length: 13 }, (_, index) => ({
          stage_id: 'framework_stage_c_support_daily_sunscreen',
          query: `support query ${index + 1}`,
          role_id: 'daily_sunscreen',
          role_rank: 3,
          preferred_step: 'sunscreen',
          source_scope: 'internal',
          query_index: index + 1,
        })),
      ],
      stages: [
        {
          stage_id: 'framework_stage_a_primary_internal',
          role_id: 'oil_control_treatment',
          role_rank: 1,
          source_scope: 'internal',
          entries: [
            {
              query: 'oil control treatment',
              role_id: 'oil_control_treatment',
              role_rank: 1,
              preferred_step: 'treatment',
              source_scope: 'internal',
              query_index: 0,
            },
          ],
        },
      ],
    }),
    searchPivotaBackendProducts: async (args) => {
      attemptedArgs.push(args);
      const { timeoutMs } = args;
      attemptedTimeouts.push(Number(timeoutMs || 0));
      return {
        ok: false,
        reason: 'upstream_timeout',
        actual_http_attempt_count: 1,
        products: [],
      };
    },
  });

  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'im oily skin, what products should i use?',
      limit: 6,
    },
    metadata: {
      source: 'aurora-bff',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'im oily skin, what products should i use?',
    gatewayRequestId: 'trace_framework_anchor_budget',
    timeoutMs: 6500,
    invokeStartedAtMs: Date.now(),
  });

  assert.equal(out.handled, true);
  assert.equal(attemptedTimeouts.length, 1);
  assert.equal(attemptedArgs.length, 1);
  assert.equal(attemptedArgs[0]?.localMainlineChild, undefined);
  assert.equal(attemptedArgs[0]?.semanticContract, undefined);
  assert.equal(attemptedArgs[0]?.queryIndex, undefined);
  assert.equal(attemptedArgs[0]?.queryTotal, undefined);
  assert.equal(attemptedTimeouts[0] >= 4500, true);
  assert.equal(attemptedTimeouts[0] <= 4800, true);
  assert.equal(
    out.response.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts?.[0]
      ?.attempt_timeout_ms >= 4500,
    true,
  );
});

test('step-aware sunscreen query can use local beauty discovery mainline', () => {
  const runtime = createRuntime({
    buildBeautyDiscoverySemanticContract: () => ({
      planner_mode: 'step_aware',
      request_class: 'sunscreen',
      target_step_family: 'sunscreen',
      semantic_family: 'sunscreen',
      primary_role_id: 'daily_sunscreen',
    }),
  });
  const out = runtime.shouldUseLocalBeautyDiscoveryMainline({
    search: {
      query: 'best sunscreen for oily skin',
      target_step_family: 'sunscreen',
    },
    metadata: {
      source: 'public',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      semantic_contract: {
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        semantic_family: 'sunscreen',
        primary_role_id: 'daily_sunscreen',
      },
    },
  });
  assert.equal(out, true);
});

test('step-aware local beauty mainline reuses semantic-owner runtime wiring', async () => {
  const attemptedQueries = [];
  const runtime = createRuntime({
    buildBeautyDiscoverySemanticContract: () => ({
      planner_mode: 'step_aware',
      request_class: 'sunscreen',
      target_step_family: 'sunscreen',
      semantic_family: 'sunscreen',
      primary_role_id: 'daily_sunscreen',
    }),
    buildBeautyDiscoveryQueryPackFromContract: () => [
      'lightweight sunscreen oily skin',
      'oil control sunscreen',
    ],
    searchPivotaBackendProducts: async ({ query }) => {
      attemptedQueries.push(String(query || ''));
      if (query === 'lightweight sunscreen oily skin') {
        return {
          ok: true,
          reason: 'empty',
          actual_http_attempt_count: 1,
          products: [],
        };
      }
      return {
        ok: true,
        reason: 'ok',
        actual_http_attempt_count: 1,
        products: [
          {
            product_id: 'external_spf_local_1',
            merchant_id: 'external_seed',
            title: 'Oil Control SPF 50 Fluid',
            source: 'external_seed',
          },
        ],
      };
    },
    prepareInvokeSemanticOwnerContext: () => ({
      semanticOwnerQueryPack: [
        'lightweight sunscreen oily skin',
        'oil control sunscreen',
      ],
      semanticOwnerQueryTotal: 2,
      semanticOwnerSupportRoleQueryPack: [],
      semanticOwnerTargetStepFamily: 'sunscreen',
      semanticOwnerSemanticFamily: 'sunscreen',
      semanticOwnerQueryStepStrength: 'exact_step',
      semanticOwnerMinQueriesBeforeBudgetGuard: 2,
      buildVariantRequestBody: (_body, queryValue, queryIndex) => ({
        search: {
          query: queryValue,
          query_index: queryIndex,
          query_total: 2,
        },
      }),
      evaluateSemanticOwnerBeautyAdoption: ({ upstreamData }) => ({
        adopt: Array.isArray(upstreamData?.products) && upstreamData.products.length > 0,
        hitDecision: {
          hit_quality:
            Array.isArray(upstreamData?.products) && upstreamData.products.length > 0
              ? 'valid_hit'
              : 'empty',
          valid_products: Array.isArray(upstreamData?.products) ? upstreamData.products : [],
        },
      }),
      describeSemanticOwnerObservationFallback: () => ({
        ignore: false,
        score: 0,
        last_resort_cache_candidate: false,
      }),
      buildSemanticOwnerExternalRescueQueryPack: () => [],
    }),
    runInvokeSemanticOwnerExecution: async ({
      queryParams,
      response,
      upstreamData,
      callTrackedUpstream,
      url,
      buildQueryString,
    }) => {
      const nextQueryParams = {
        ...queryParams,
        query: 'oil control sunscreen',
        query_index: 1,
      };
      const nextResponse = await callTrackedUpstream('find_products_multi', {
        url: `${url}${buildQueryString(nextQueryParams)}`,
        timeout: 15000,
      });
      return {
        response: nextResponse,
        upstreamData: nextResponse.data,
        queryParams: nextQueryParams,
        requestBody: { search: nextQueryParams },
        axiosConfig: { url: `${url}${buildQueryString(nextQueryParams)}` },
        semanticOwnerQueryAttempts: [
          {
            query: 'lightweight sunscreen oily skin',
            query_index: 0,
            query_total: 2,
            result_count: Array.isArray(upstreamData?.products) ? upstreamData.products.length : 0,
            adopted: false,
          },
          {
            query: 'oil control sunscreen',
            query_index: 1,
            query_total: 2,
            result_count: Array.isArray(nextResponse?.data?.products)
              ? nextResponse.data.products.length
              : 0,
            adopted: true,
          },
        ],
        semanticOwnerSupplementTraces: [],
        semanticOwnerExternalRescueQueriesAttempted: [],
        semanticOwnerCacheSourceIsolated: false,
        semanticOwnerCacheSourceIsolationReason: null,
        semanticOwnerLastResortCacheApplied: false,
        semanticOwnerLastResortCacheQuery: null,
      };
    },
    normalizeAgentProductsListResponse: (body) => body,
  });
  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'best sunscreen for oily skin',
      target_step_family: 'sunscreen',
    },
    metadata: {
      source: 'public',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      semantic_contract: {
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        semantic_family: 'sunscreen',
        primary_role_id: 'daily_sunscreen',
      },
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'best sunscreen for oily skin',
    gatewayRequestId: 'trace-step-aware',
    traceQueryClass: 'query',
    timeoutMs: 15000,
    invokeStartedAtMs: Date.now(),
    logger: { warn() {} },
    authHeaders: { authorization: 'Bearer test' },
    operation: 'find_products_multi',
  });

  assert.equal(out.handled, true);
  assert.deepEqual(attemptedQueries, [
    'lightweight sunscreen oily skin',
    'oil control sunscreen',
  ]);
  assert.equal(out.response.products?.[0]?.product_id, 'external_spf_local_1');
  assert.equal(
    out.response.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts?.[1]?.query,
    'oil control sunscreen',
  );
  assert.equal(
    out.response.metadata?.search_execution_trace?.primary_lane,
    'beauty_discovery_mainline',
  );
});

test('step-aware local beauty mainline uses direct external seed child recall', async () => {
  let backendCalled = 0;
  const directCalls = [];
  const runtime = createRuntime({
    buildBeautyDiscoverySemanticContract: () => ({
      planner_mode: 'step_aware',
      request_class: 'sunscreen',
      target_step_family: 'sunscreen',
      semantic_family: 'oil_control',
      primary_role_id: 'daily_sunscreen',
    }),
    buildBeautyDiscoveryQueryPackFromContract: () => [
      'lightweight sunscreen oily skin',
    ],
    fetchExternalSeedSupplementFromBackend: async (args) => {
      directCalls.push(args);
      return {
        products: [
          {
            product_id: 'external_seed_spf_direct_1',
            merchant_id: 'external_seed',
            title: 'External Oil Control Sunscreen',
            source: 'external_seed',
          },
        ],
        metadata: {
          attempted: true,
          applied: true,
          reason: 'external_seed_direct_local_hit',
        },
      };
    },
    searchPivotaBackendProducts: async () => {
      backendCalled += 1;
      throw new Error('backend child should not be called for external-seed direct recall');
    },
    prepareInvokeSemanticOwnerContext: ({ semanticRewriteResultMeta }) => ({
      semanticOwnerQueryPack: semanticRewriteResultMeta.normalized_query_pack,
      semanticOwnerQueryTotal: semanticRewriteResultMeta.normalized_query_pack.length,
      semanticOwnerSupportRoleQueryPack: [],
      semanticOwnerTargetStepFamily: 'sunscreen',
      semanticOwnerSemanticFamily: 'oil_control',
      semanticOwnerQueryStepStrength: 'exact_step',
      semanticOwnerMinQueriesBeforeBudgetGuard: 1,
      buildVariantRequestBody: (_body, queryValue, queryIndex) => ({
        search: {
          query: queryValue,
          query_index: queryIndex,
          query_total: semanticRewriteResultMeta.normalized_query_pack.length,
        },
      }),
      evaluateSemanticOwnerBeautyAdoption: ({ upstreamData }) => ({
        adopt: Array.isArray(upstreamData?.products) && upstreamData.products.length > 0,
        hitDecision: {
          hit_quality:
            Array.isArray(upstreamData?.products) && upstreamData.products.length > 0
              ? 'valid_hit'
              : 'empty',
          valid_products: Array.isArray(upstreamData?.products) ? upstreamData.products : [],
        },
      }),
      describeSemanticOwnerObservationFallback: () => ({
        ignore: false,
        score: 0,
        last_resort_cache_candidate: false,
      }),
      buildSemanticOwnerExternalRescueQueryPack: () => [],
    }),
    runInvokeSemanticOwnerExecution: async ({
      response,
      upstreamData,
      semanticOwnerQueryPack,
    }) => ({
      response,
      upstreamData,
      queryParams: {
        query: semanticOwnerQueryPack[0],
        query_index: 0,
        query_total: semanticOwnerQueryPack.length,
      },
      requestBody: { search: { query: semanticOwnerQueryPack[0] } },
      axiosConfig: {},
      semanticOwnerQueryAttempts: [
        {
          query: semanticOwnerQueryPack[0],
          query_index: 0,
          query_total: semanticOwnerQueryPack.length,
          result_count: Array.isArray(upstreamData?.products) ? upstreamData.products.length : 0,
          adopted: true,
        },
      ],
      semanticOwnerSupplementTraces: [],
      semanticOwnerExternalRescueQueriesAttempted: [],
      semanticOwnerCacheSourceIsolated: false,
      semanticOwnerCacheSourceIsolationReason: null,
      semanticOwnerLastResortCacheApplied: false,
      semanticOwnerLastResortCacheQuery: null,
    }),
    normalizeAgentProductsListResponse: (body) => body,
  });

  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'best sunscreen for oily skin',
      target_step_family: 'sunscreen',
    },
    metadata: {
      source: 'public',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      semantic_contract: {
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        semantic_family: 'oil_control',
        primary_role_id: 'daily_sunscreen',
      },
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'best sunscreen for oily skin',
    gatewayRequestId: 'trace-step-aware-external-direct',
    traceQueryClass: 'query',
    timeoutMs: 6500,
    invokeStartedAtMs: Date.now(),
    logger: { warn() {} },
    authHeaders: { authorization: 'Bearer test' },
    operation: 'find_products_multi',
  });

  assert.equal(out.handled, true);
  assert.equal(backendCalled, 0);
  assert.equal(directCalls.length, 1);
  assert.equal(directCalls[0].directOnly, true);
  assert.equal(directCalls[0].queryParams.allow_external_seed, true);
  assert.equal(out.response.products?.[0]?.product_id, 'external_seed_spf_direct_1');
  assert.equal(
    out.response.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts?.[0]
      ?.result_count,
    1,
  );
});

test('step-aware local beauty mainline uses direct-only supplement fetch for semantic owner coverage', async () => {
  let backendCalled = 0;
  const supplementCalls = [];
  const runtime = createRuntime({
    buildBeautyDiscoverySemanticContract: () => ({
      planner_mode: 'step_aware',
      request_class: 'sunscreen',
      target_step_family: 'sunscreen',
      semantic_family: 'oil_control',
      primary_role_id: 'daily_sunscreen',
    }),
    buildBeautyDiscoveryQueryPackFromContract: () => [
      'lightweight sunscreen oily skin',
    ],
    fetchExternalSeedSupplementFromBackend: async (args) => {
      supplementCalls.push(args);
      if (String(args?.queryParams?.query || '').trim() === 'lightweight sunscreen oily skin') {
        return {
          products: [],
          metadata: {
            attempted: true,
            applied: false,
            reason: 'external_seed_direct_local_empty',
          },
        };
      }
      return {
        products: [
          {
            product_id: 'external_seed_spf_coverage_1',
            merchant_id: 'external_seed',
            title: 'Coverage Oil Control Sunscreen',
            source: 'external_seed',
          },
        ],
        metadata: {
          attempted: true,
          applied: true,
          reason: 'external_seed_direct_local_hit',
        },
      };
    },
    searchPivotaBackendProducts: async () => {
      backendCalled += 1;
      return {
        ok: true,
        reason: 'empty',
        actual_http_attempt_count: 1,
        products: [],
      };
    },
    prepareInvokeSemanticOwnerContext: ({ semanticRewriteResultMeta }) => ({
      semanticOwnerQueryPack: semanticRewriteResultMeta.normalized_query_pack,
      semanticOwnerQueryTotal: semanticRewriteResultMeta.normalized_query_pack.length,
      semanticOwnerSupportRoleQueryPack: [],
      semanticOwnerTargetStepFamily: 'sunscreen',
      semanticOwnerSemanticFamily: 'oil_control',
      semanticOwnerQueryStepStrength: 'exact_step',
      semanticOwnerMinQueriesBeforeBudgetGuard: 1,
      buildVariantRequestBody: (_body, queryValue, queryIndex) => ({
        search: {
          query: queryValue,
          query_index: queryIndex,
          query_total: semanticRewriteResultMeta.normalized_query_pack.length,
        },
      }),
      evaluateSemanticOwnerBeautyAdoption: ({ upstreamData }) => ({
        adopt: Array.isArray(upstreamData?.products) && upstreamData.products.length > 0,
        hitDecision: {
          hit_quality:
            Array.isArray(upstreamData?.products) && upstreamData.products.length > 0
              ? 'valid_hit'
              : 'empty',
          valid_products: Array.isArray(upstreamData?.products) ? upstreamData.products : [],
        },
      }),
      describeSemanticOwnerObservationFallback: () => ({
        ignore: false,
        score: 0,
        last_resort_cache_candidate: false,
      }),
      buildSemanticOwnerExternalRescueQueryPack: () => ['oil control sunscreen'],
    }),
    runInvokeSemanticOwnerExecution: async ({
      fetchExternalSeedSupplementFromBackend,
      semanticOwnerQueryPack,
    }) => {
      const supplement = await fetchExternalSeedSupplementFromBackend({
        queryParams: {
          query: 'oil control sunscreen',
          allow_external_seed: true,
        },
        checkoutToken: null,
        neededCount: 2,
        source: 'aurora-bff',
      });
      const body = {
        status: 'success',
        success: true,
        products: supplement.products,
        total: supplement.products.length,
        page: 1,
        page_size: supplement.products.length,
        reply: null,
        metadata: {},
      };
      return {
        response: { status: 200, data: body },
        upstreamData: body,
        queryParams: {
          query: semanticOwnerQueryPack[0],
          query_index: 0,
          query_total: semanticOwnerQueryPack.length,
        },
        requestBody: { search: { query: semanticOwnerQueryPack[0] } },
        axiosConfig: {},
        semanticOwnerQueryAttempts: [
          {
            query: semanticOwnerQueryPack[0],
            query_index: 0,
            query_total: semanticOwnerQueryPack.length,
            result_count: supplement.products.length,
            adopted: true,
          },
        ],
        semanticOwnerSupplementTraces: [
          {
            supplement_type: 'semantic_owner_external_coverage',
            status: 'applied',
          },
        ],
        semanticOwnerExternalRescueQueriesAttempted: ['oil control sunscreen'],
        semanticOwnerCacheSourceIsolated: false,
        semanticOwnerCacheSourceIsolationReason: null,
        semanticOwnerLastResortCacheApplied: false,
        semanticOwnerLastResortCacheQuery: null,
      };
    },
    normalizeAgentProductsListResponse: (body) => body,
  });

  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'best sunscreen for oily skin',
      target_step_family: 'sunscreen',
    },
    metadata: {
      source: 'public',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      semantic_contract: {
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        semantic_family: 'oil_control',
        primary_role_id: 'daily_sunscreen',
      },
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'best sunscreen for oily skin',
    gatewayRequestId: 'trace-step-aware-supplement-direct',
    traceQueryClass: 'query',
    timeoutMs: 6500,
    invokeStartedAtMs: Date.now(),
    logger: { warn() {} },
    authHeaders: { authorization: 'Bearer test' },
    operation: 'find_products_multi',
  });

  assert.equal(out.handled, true);
  assert.equal(backendCalled, 0);
  assert.equal(supplementCalls.length, 2);
  assert.equal(supplementCalls[0].directOnly, true);
  assert.equal(supplementCalls[1].directOnly, true);
  assert.equal(out.response.products?.[0]?.product_id, 'external_seed_spf_coverage_1');
});

test('step-aware local external seed child recall times out without backend child fallback', async () => {
  let backendCalled = 0;
  const runtime = createRuntime({
    buildBeautyDiscoverySemanticContract: () => ({
      planner_mode: 'step_aware',
      request_class: 'sunscreen',
      target_step_family: 'sunscreen',
      semantic_family: 'oil_control',
      primary_role_id: 'daily_sunscreen',
    }),
    buildBeautyDiscoveryQueryPackFromContract: () => [
      'lightweight sunscreen oily skin',
    ],
    fetchExternalSeedSupplementFromBackend: async () => new Promise(() => {}),
    searchPivotaBackendProducts: async () => {
      backendCalled += 1;
      throw new Error('backend child should not be called after external direct timeout');
    },
    prepareInvokeSemanticOwnerContext: ({ semanticRewriteResultMeta }) => ({
      semanticOwnerQueryPack: semanticRewriteResultMeta.normalized_query_pack,
      semanticOwnerQueryTotal: semanticRewriteResultMeta.normalized_query_pack.length,
      semanticOwnerSupportRoleQueryPack: [],
      semanticOwnerTargetStepFamily: 'sunscreen',
      semanticOwnerSemanticFamily: 'oil_control',
      semanticOwnerQueryStepStrength: 'exact_step',
      semanticOwnerMinQueriesBeforeBudgetGuard: 1,
      buildVariantRequestBody: (_body, queryValue, queryIndex) => ({
        search: {
          query: queryValue,
          query_index: queryIndex,
          query_total: semanticRewriteResultMeta.normalized_query_pack.length,
        },
      }),
      evaluateSemanticOwnerBeautyAdoption: ({ upstreamData }) => ({
        adopt: Array.isArray(upstreamData?.products) && upstreamData.products.length > 0,
        hitDecision: {
          hit_quality:
            Array.isArray(upstreamData?.products) && upstreamData.products.length > 0
              ? 'valid_hit'
              : 'empty',
          valid_products: Array.isArray(upstreamData?.products) ? upstreamData.products : [],
        },
      }),
      describeSemanticOwnerObservationFallback: () => ({
        ignore: false,
        score: 0,
        last_resort_cache_candidate: false,
      }),
      buildSemanticOwnerExternalRescueQueryPack: () => [],
    }),
    runInvokeSemanticOwnerExecution: async ({
      response,
      upstreamData,
      semanticOwnerQueryPack,
    }) => ({
      response,
      upstreamData,
      queryParams: {
        query: semanticOwnerQueryPack[0],
        query_index: 0,
        query_total: semanticOwnerQueryPack.length,
      },
      requestBody: { search: { query: semanticOwnerQueryPack[0] } },
      axiosConfig: {},
      semanticOwnerQueryAttempts: [
        {
          query: semanticOwnerQueryPack[0],
          query_index: 0,
          query_total: semanticOwnerQueryPack.length,
          result_count: Array.isArray(upstreamData?.products) ? upstreamData.products.length : 0,
          adopted: false,
          error:
            upstreamData?.metadata?.external_seed_supplement?.reason ||
            'external_seed_direct_local_timeout',
        },
      ],
      semanticOwnerSupplementTraces: [],
      semanticOwnerExternalRescueQueriesAttempted: [],
      semanticOwnerCacheSourceIsolated: false,
      semanticOwnerCacheSourceIsolationReason: null,
      semanticOwnerLastResortCacheApplied: false,
      semanticOwnerLastResortCacheQuery: null,
    }),
    normalizeAgentProductsListResponse: (body) => body,
  });

  const startedAt = Date.now();
  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'best sunscreen for oily skin',
      target_step_family: 'sunscreen',
    },
    metadata: {
      source: 'public',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      semantic_contract: {
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        semantic_family: 'oil_control',
        primary_role_id: 'daily_sunscreen',
      },
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'best sunscreen for oily skin',
    gatewayRequestId: 'trace-step-aware-external-direct-timeout',
    traceQueryClass: 'query',
    timeoutMs: 700,
    invokeStartedAtMs: Date.now(),
    logger: { warn() {} },
    authHeaders: { authorization: 'Bearer test' },
    operation: 'find_products_multi',
  });

  assert.equal(out.handled, true);
  assert.equal(backendCalled, 0);
  assert.ok(Date.now() - startedAt < 1000);
  assert.deepEqual(out.response.products, []);
  assert.equal(
    out.response.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts?.[0]
      ?.error,
    'external_seed_direct_local_timeout',
  );
});

test('framework local beauty mainline uses direct-only recall for external seed stages', async () => {
  const backendQueries = [];
  const supplementCalls = [];
  const runtime = createRuntime({
    buildRecoRecallPlan: () => ({
      mode: 'framework_generic',
      entries: [
        {
          stage_id: 'framework_stage_a_primary_internal',
          query: 'oil control treatment',
          role_id: 'oil_control_treatment',
          role_rank: 1,
          preferred_step: 'treatment',
          source_scope: 'internal',
          query_index: 0,
        },
        {
          stage_id: 'framework_stage_b_primary_external_seed',
          query: 'oil control treatment',
          role_id: 'oil_control_treatment',
          role_rank: 1,
          preferred_step: 'treatment',
          source_scope: 'external_seed',
          query_index: 1,
        },
      ],
      stages: [
        {
          stage_id: 'framework_stage_a_primary_internal',
          role_id: 'oil_control_treatment',
          role_rank: 1,
          source_scope: 'internal',
          entries: [
            {
              query: 'oil control treatment',
              role_id: 'oil_control_treatment',
              role_rank: 1,
              preferred_step: 'treatment',
              source_scope: 'internal',
              query_index: 0,
            },
          ],
        },
        {
          stage_id: 'framework_stage_b_primary_external_seed',
          role_id: 'oil_control_treatment',
          role_rank: 1,
          source_scope: 'external_seed',
          entries: [
            {
              query: 'oil control treatment',
              role_id: 'oil_control_treatment',
              role_rank: 1,
              preferred_step: 'treatment',
              source_scope: 'external_seed',
              query_index: 1,
            },
          ],
        },
      ],
    }),
    searchPivotaBackendProducts: async ({ query }) => {
      backendQueries.push(String(query || ''));
      return {
        ok: true,
        reason: 'empty',
        actual_http_attempt_count: 1,
        products: [],
      };
    },
    fetchExternalSeedSupplementFromBackend: async (args) => {
      supplementCalls.push(args);
      return {
        products: [
          {
            product_id: 'external_seed_treatment_1',
            merchant_id: 'external_seed',
            title: 'External Oil Control Treatment',
            source: 'external_seed',
          },
        ],
        metadata: {
          attempted: true,
          applied: true,
          reason: 'external_seed_direct_local_hit',
        },
      };
    },
  });

  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'im oily skin, what products should i use?',
      product_only: true,
    },
    metadata: {
      source: 'aurora-bff',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'im oily skin, what products should i use?',
    gatewayRequestId: 'trace-framework-external-direct',
    traceQueryClass: 'query',
    timeoutMs: 6500,
    invokeStartedAtMs: Date.now(),
    logger: { warn() {} },
    authHeaders: { authorization: 'Bearer test' },
    operation: 'find_products_multi',
  });

  assert.equal(out.handled, true);
  assert.deepEqual(backendQueries, ['oil control treatment']);
  assert.equal(supplementCalls.length, 1);
  assert.equal(supplementCalls[0].directOnly, true);
  assert.equal(out.response.products?.[0]?.product_id, 'external_seed_treatment_1');
});

test('step-aware local beauty mainline trims sunscreen primary query pack to critical queries', async () => {
  const attemptedQueries = [];
  let observedSemanticOwnerQueryPack = null;
  const runtime = createRuntime({
    buildBeautyDiscoverySemanticContract: () => ({
      planner_mode: 'step_aware',
      request_class: 'sunscreen',
      target_step_family: 'sunscreen',
      semantic_family: 'oil_control',
      primary_role_id: 'daily_sunscreen',
    }),
    buildBeautyDiscoveryQueryPackFromContract: () => [
      'best sunscreen for oily skin',
      'lightweight sunscreen oily skin',
      'oil control sunscreen',
      'lightweight face sunscreen',
    ],
    searchPivotaBackendProducts: async ({ query }) => {
      attemptedQueries.push(String(query || ''));
      return {
        ok: true,
        reason: 'ok',
        actual_http_attempt_count: 1,
        products:
          query === 'oil control sunscreen'
            ? [
                {
                  product_id: 'spf_critical_1',
                  merchant_id: 'merchant_internal',
                  title: 'Oil Control Sunscreen',
                },
              ]
            : [],
      };
    },
    prepareInvokeSemanticOwnerContext: ({ semanticRewriteResultMeta }) => {
      observedSemanticOwnerQueryPack = semanticRewriteResultMeta.normalized_query_pack;
      return {
        semanticOwnerQueryPack: semanticRewriteResultMeta.normalized_query_pack,
        semanticOwnerQueryTotal: semanticRewriteResultMeta.normalized_query_pack.length,
        semanticOwnerSupportRoleQueryPack: [],
        semanticOwnerTargetStepFamily: 'sunscreen',
        semanticOwnerSemanticFamily: 'oil_control',
        semanticOwnerQueryStepStrength: 'exact_step',
        semanticOwnerMinQueriesBeforeBudgetGuard: 2,
        buildVariantRequestBody: (_body, queryValue, queryIndex) => ({
          search: {
            query: queryValue,
            query_index: queryIndex,
            query_total: semanticRewriteResultMeta.normalized_query_pack.length,
          },
        }),
        evaluateSemanticOwnerBeautyAdoption: ({ upstreamData }) => ({
          adopt: Array.isArray(upstreamData?.products) && upstreamData.products.length > 0,
          hitDecision: {
            hit_quality:
              Array.isArray(upstreamData?.products) && upstreamData.products.length > 0
                ? 'valid_hit'
                : 'empty',
            valid_products: Array.isArray(upstreamData?.products) ? upstreamData.products : [],
          },
        }),
        describeSemanticOwnerObservationFallback: () => ({
          ignore: false,
          score: 0,
          last_resort_cache_candidate: false,
        }),
        buildSemanticOwnerExternalRescueQueryPack: () => [],
      };
    },
    runInvokeSemanticOwnerExecution: async ({
      semanticOwnerQueryPack,
      queryParams,
      upstreamData,
      callTrackedUpstream,
      url,
      buildQueryString,
    }) => {
      const nextQueryParams = {
        ...queryParams,
        query: semanticOwnerQueryPack[1],
        query_index: 1,
      };
      const nextResponse = await callTrackedUpstream('find_products_multi', {
        url: `${url}${buildQueryString(nextQueryParams)}`,
        timeout: 15000,
      });
      return {
        response: nextResponse,
        upstreamData: nextResponse.data,
        queryParams: nextQueryParams,
        requestBody: { search: nextQueryParams },
        axiosConfig: { url: `${url}${buildQueryString(nextQueryParams)}` },
        semanticOwnerQueryAttempts: [
          {
            query: semanticOwnerQueryPack[0],
            query_index: 0,
            query_total: semanticOwnerQueryPack.length,
            result_count: Array.isArray(upstreamData?.products) ? upstreamData.products.length : 0,
            adopted: false,
          },
          {
            query: semanticOwnerQueryPack[1],
            query_index: 1,
            query_total: semanticOwnerQueryPack.length,
            result_count: Array.isArray(nextResponse?.data?.products)
              ? nextResponse.data.products.length
              : 0,
            adopted: true,
          },
        ],
        semanticOwnerSupplementTraces: [],
        semanticOwnerExternalRescueQueriesAttempted: [],
        semanticOwnerCacheSourceIsolated: false,
        semanticOwnerCacheSourceIsolationReason: null,
        semanticOwnerLastResortCacheApplied: false,
        semanticOwnerLastResortCacheQuery: null,
      };
    },
    normalizeAgentProductsListResponse: (body) => body,
  });

  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'best sunscreen for oily skin',
      target_step_family: 'sunscreen',
    },
    metadata: {
      source: 'public',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      semantic_contract: {
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        semantic_family: 'oil_control',
        primary_role_id: 'daily_sunscreen',
      },
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'best sunscreen for oily skin',
    gatewayRequestId: 'trace-step-aware-critical',
    traceQueryClass: 'query',
    timeoutMs: 15000,
    invokeStartedAtMs: Date.now(),
    logger: { warn() {} },
    authHeaders: { authorization: 'Bearer test' },
    operation: 'find_products_multi',
  });

  assert.equal(out.handled, true);
  assert.deepEqual(observedSemanticOwnerQueryPack, [
    'lightweight sunscreen oily skin',
    'oil control sunscreen',
  ]);
  assert.deepEqual(attemptedQueries, [
    'lightweight sunscreen oily skin',
    'oil control sunscreen',
  ]);
  assert.equal(out.response.products?.[0]?.product_id, 'spf_critical_1');
});

test('step-aware local beauty mainline retries after initial query timeout', async () => {
  const attemptedQueries = [];
  const runtime = createRuntime({
    buildBeautyDiscoverySemanticContract: () => ({
      planner_mode: 'step_aware',
      request_class: 'sunscreen',
      target_step_family: 'sunscreen',
      semantic_family: 'oil_control',
      primary_role_id: 'daily_sunscreen',
    }),
    buildBeautyDiscoveryQueryPackFromContract: () => [
      'lightweight sunscreen oily skin',
      'oil control sunscreen',
    ],
    searchPivotaBackendProducts: async ({ query }) => {
      attemptedQueries.push(String(query || ''));
      if (query === 'lightweight sunscreen oily skin') {
        return {
          ok: false,
          reason: 'upstream_timeout',
          actual_http_attempt_count: 1,
          products: [],
        };
      }
      return {
        ok: true,
        reason: 'ok',
        actual_http_attempt_count: 1,
        products: [
          {
            product_id: 'spf_after_timeout_1',
            merchant_id: 'merchant_internal',
            title: 'Oil Control Sunscreen',
          },
        ],
      };
    },
    prepareInvokeSemanticOwnerContext: ({ semanticRewriteResultMeta }) => ({
      semanticOwnerQueryPack: semanticRewriteResultMeta.normalized_query_pack,
      semanticOwnerQueryTotal: semanticRewriteResultMeta.normalized_query_pack.length,
      semanticOwnerSupportRoleQueryPack: [],
      semanticOwnerTargetStepFamily: 'sunscreen',
      semanticOwnerSemanticFamily: 'oil_control',
      semanticOwnerQueryStepStrength: 'exact_step',
      semanticOwnerMinQueriesBeforeBudgetGuard: 2,
      buildVariantRequestBody: (_body, queryValue, queryIndex) => ({
        search: {
          query: queryValue,
          query_index: queryIndex,
          query_total: semanticRewriteResultMeta.normalized_query_pack.length,
        },
      }),
      evaluateSemanticOwnerBeautyAdoption: ({ upstreamData }) => ({
        adopt: Array.isArray(upstreamData?.products) && upstreamData.products.length > 0,
        hitDecision: {
          hit_quality:
            Array.isArray(upstreamData?.products) && upstreamData.products.length > 0
              ? 'valid_hit'
              : 'empty',
          valid_products: Array.isArray(upstreamData?.products) ? upstreamData.products : [],
        },
      }),
      describeSemanticOwnerObservationFallback: () => ({
        ignore: false,
        score: 0,
        last_resort_cache_candidate: false,
      }),
      buildSemanticOwnerExternalRescueQueryPack: () => [],
    }),
    runInvokeSemanticOwnerExecution: async ({
      semanticOwnerQueryPack,
      queryParams,
      upstreamData,
      callTrackedUpstream,
      url,
      buildQueryString,
    }) => {
      const nextQueryParams = {
        ...queryParams,
        query: semanticOwnerQueryPack[1],
        query_index: 1,
      };
      const nextResponse = await callTrackedUpstream('find_products_multi', {
        url: `${url}${buildQueryString(nextQueryParams)}`,
        timeout: 15000,
      });
      return {
        response: nextResponse,
        upstreamData: nextResponse.data,
        queryParams: nextQueryParams,
        requestBody: { search: nextQueryParams },
        axiosConfig: { url: `${url}${buildQueryString(nextQueryParams)}` },
        semanticOwnerQueryAttempts: [
          {
            query: semanticOwnerQueryPack[0],
            query_index: 0,
            query_total: semanticOwnerQueryPack.length,
            result_count: Array.isArray(upstreamData?.products) ? upstreamData.products.length : 0,
            adopted: false,
          },
          {
            query: semanticOwnerQueryPack[1],
            query_index: 1,
            query_total: semanticOwnerQueryPack.length,
            result_count: Array.isArray(nextResponse?.data?.products)
              ? nextResponse.data.products.length
              : 0,
            adopted: true,
          },
        ],
        semanticOwnerSupplementTraces: [],
        semanticOwnerExternalRescueQueriesAttempted: [],
        semanticOwnerCacheSourceIsolated: false,
        semanticOwnerCacheSourceIsolationReason: null,
        semanticOwnerLastResortCacheApplied: false,
        semanticOwnerLastResortCacheQuery: null,
      };
    },
    normalizeAgentProductsListResponse: (body) => body,
  });

  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'best sunscreen for oily skin',
      target_step_family: 'sunscreen',
    },
    metadata: {
      source: 'public',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      semantic_contract: {
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        semantic_family: 'oil_control',
        primary_role_id: 'daily_sunscreen',
      },
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'best sunscreen for oily skin',
    gatewayRequestId: 'trace-step-aware-timeout-retry',
    traceQueryClass: 'query',
    timeoutMs: 6500,
    invokeStartedAtMs: Date.now(),
    logger: { warn() {} },
    authHeaders: { authorization: 'Bearer test' },
    operation: 'find_products_multi',
  });

  assert.equal(out.handled, true);
  assert.deepEqual(attemptedQueries, [
    'lightweight sunscreen oily skin',
    'oil control sunscreen',
  ]);
  assert.equal(out.response.products?.[0]?.product_id, 'spf_after_timeout_1');
  assert.equal(
    out.response.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts?.[0]
      ?.timeout_error,
    true,
  );
});

test('step-aware local beauty mainline caps retry attempts to the shared primary budget', async () => {
  const attemptedTimeouts = [];
  const runtime = createRuntime({
    buildBeautyDiscoverySemanticContract: () => ({
      planner_mode: 'step_aware',
      request_class: 'sunscreen',
      target_step_family: 'sunscreen',
      semantic_family: 'oil_control',
      primary_role_id: 'daily_sunscreen',
    }),
    buildBeautyDiscoveryQueryPackFromContract: () => [
      'lightweight sunscreen oily skin',
      'oil control sunscreen',
    ],
    searchPivotaBackendProducts: async ({ query, timeoutMs }) => {
      attemptedTimeouts.push(Number(timeoutMs || 0));
      return {
        ok: true,
        reason: 'ok',
        actual_http_attempt_count: 1,
        products:
          query === 'oil control sunscreen'
            ? [
                {
                  product_id: 'spf_timeout_cap_1',
                  merchant_id: 'merchant_internal',
                  title: 'Budgeted Oil Control Sunscreen',
                },
              ]
            : [],
      };
    },
    prepareInvokeSemanticOwnerContext: ({ semanticRewriteResultMeta }) => ({
      semanticOwnerQueryPack: semanticRewriteResultMeta.normalized_query_pack,
      semanticOwnerQueryTotal: semanticRewriteResultMeta.normalized_query_pack.length,
      semanticOwnerSupportRoleQueryPack: [],
      semanticOwnerTargetStepFamily: 'sunscreen',
      semanticOwnerSemanticFamily: 'oil_control',
      semanticOwnerQueryStepStrength: 'exact_step',
      semanticOwnerMinQueriesBeforeBudgetGuard: 2,
      buildVariantRequestBody: (_body, queryValue, queryIndex) => ({
        search: {
          query: queryValue,
          query_index: queryIndex,
          query_total: semanticRewriteResultMeta.normalized_query_pack.length,
        },
      }),
      evaluateSemanticOwnerBeautyAdoption: ({ upstreamData }) => ({
        adopt: Array.isArray(upstreamData?.products) && upstreamData.products.length > 0,
        hitDecision: {
          hit_quality:
            Array.isArray(upstreamData?.products) && upstreamData.products.length > 0
              ? 'valid_hit'
              : 'empty',
          valid_products: Array.isArray(upstreamData?.products) ? upstreamData.products : [],
        },
      }),
      describeSemanticOwnerObservationFallback: () => ({
        ignore: false,
        score: 0,
        last_resort_cache_candidate: false,
      }),
      buildSemanticOwnerExternalRescueQueryPack: () => [],
    }),
    runInvokeSemanticOwnerExecution: async ({
      semanticOwnerQueryPack,
      queryParams,
      callTrackedUpstream,
      url,
      buildQueryString,
    }) => {
      const nextQueryParams = {
        ...queryParams,
        query: semanticOwnerQueryPack[1],
        query_index: 1,
      };
      const nextResponse = await callTrackedUpstream('find_products_multi', {
        url: `${url}${buildQueryString(nextQueryParams)}`,
        timeout: 15000,
      });
      return {
        response: nextResponse,
        upstreamData: nextResponse.data,
        queryParams: nextQueryParams,
        requestBody: { search: nextQueryParams },
        axiosConfig: { url: `${url}${buildQueryString(nextQueryParams)}` },
        semanticOwnerQueryAttempts: [],
        semanticOwnerSupplementTraces: [],
        semanticOwnerExternalRescueQueriesAttempted: [],
        semanticOwnerCacheSourceIsolated: false,
        semanticOwnerCacheSourceIsolationReason: null,
        semanticOwnerLastResortCacheApplied: false,
        semanticOwnerLastResortCacheQuery: null,
      };
    },
    normalizeAgentProductsListResponse: (body) => body,
  });

  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'best sunscreen for oily skin',
      target_step_family: 'sunscreen',
    },
    metadata: {
      source: 'public',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      semantic_contract: {
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        semantic_family: 'oil_control',
        primary_role_id: 'daily_sunscreen',
      },
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'best sunscreen for oily skin',
    gatewayRequestId: 'trace-step-aware-budget',
    traceQueryClass: 'query',
    timeoutMs: 500,
    invokeStartedAtMs: Date.now(),
    logger: { warn() {} },
    authHeaders: { authorization: 'Bearer test' },
    operation: 'find_products_multi',
  });

  assert.equal(out.handled, true);
  assert.equal(attemptedTimeouts.length, 2);
  assert.ok(attemptedTimeouts[0] <= 500);
  assert.ok(attemptedTimeouts[1] <= 500);
  assert.ok(attemptedTimeouts[1] > 0);
  assert.equal(out.response.products?.[0]?.product_id, 'spf_timeout_cap_1');
});

test('step-aware local beauty mainline suppresses supplement lanes after primary timeout', async () => {
  const semanticOwnerRuntime = createFindProductsInvokeSemanticOwnerExecutionRuntime({
    FPM_GATE_SIMPLIFY_V1: true,
    FPM_LATENCY_GUARD_SECOND_STAGE_MIN_REMAINING_MS: 700,
    SEARCH_LIMIT_MAX: 20,
  });
  let backendCalled = 0;
  const supplementCalls = [];
  const runtime = createRuntime({
    buildBeautyDiscoverySemanticContract: () => ({
      planner_mode: 'step_aware',
      request_class: 'sunscreen',
      target_step_family: 'sunscreen',
      semantic_family: 'oil_control',
      primary_role_id: 'daily_sunscreen',
    }),
    buildBeautyDiscoveryQueryPackFromContract: () => [
      'lightweight sunscreen oily skin',
      'oil control sunscreen',
    ],
    fetchExternalSeedSupplementFromBackend: async (args) => {
      supplementCalls.push(args);
      return new Promise(() => {});
    },
    searchPivotaBackendProducts: async () => {
      backendCalled += 1;
      return {
        ok: true,
        reason: 'ok',
        actual_http_attempt_count: 1,
        products: [],
      };
    },
    prepareInvokeSemanticOwnerContext: ({ semanticRewriteResultMeta }) => ({
      semanticOwnerQueryPack: semanticRewriteResultMeta.normalized_query_pack,
      semanticOwnerQueryTotal: semanticRewriteResultMeta.normalized_query_pack.length,
      semanticOwnerSupportRoleQueryPack: ['oil control sunscreen'],
      semanticOwnerTargetStepFamily: 'sunscreen',
      semanticOwnerSemanticFamily: 'oil_control',
      semanticOwnerQueryStepStrength: 'exact_step',
      semanticOwnerMinQueriesBeforeBudgetGuard: 2,
      buildVariantRequestBody: (_body, queryValue, queryIndex) => ({
        search: {
          query: queryValue,
          query_index: queryIndex,
          query_total: semanticRewriteResultMeta.normalized_query_pack.length,
        },
      }),
      evaluateSemanticOwnerBeautyAdoption: ({ upstreamData }) => ({
        adopt: Array.isArray(upstreamData?.products) && upstreamData.products.length > 0,
        hitDecision: {
          hit_quality:
            Array.isArray(upstreamData?.products) && upstreamData.products.length > 0
              ? 'valid_hit'
              : 'empty',
          valid_products: Array.isArray(upstreamData?.products) ? upstreamData.products : [],
        },
      }),
      describeSemanticOwnerObservationFallback: () => ({
        ignore: false,
        score: 0,
        last_resort_cache_candidate: false,
      }),
      buildSemanticOwnerExternalRescueQueryPack: () => ['oil control sunscreen'],
    }),
    runInvokeSemanticOwnerExecution: semanticOwnerRuntime.runInvokeSemanticOwnerExecution,
    normalizeAgentProductsListResponse: (body) => body,
  });

  const startedAt = Date.now();
  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'best sunscreen for oily skin',
      target_step_family: 'sunscreen',
    },
    metadata: {
      source: 'public',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      semantic_contract: {
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        semantic_family: 'oil_control',
        primary_role_id: 'daily_sunscreen',
      },
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'best sunscreen for oily skin',
    gatewayRequestId: 'trace-step-aware-timeout-fail-close',
    traceQueryClass: 'query',
    timeoutMs: 700,
    invokeStartedAtMs: Date.now(),
    logger: { warn() {} },
    authHeaders: { authorization: 'Bearer test' },
    operation: 'find_products_multi',
  });

  assert.equal(out.handled, true);
  assert.ok(Date.now() - startedAt < 2000);
  assert.equal(backendCalled, 0);
  assert.equal(supplementCalls.length, 1);
  assert.deepEqual(out.response.products, []);
  assert.equal(
    out.response.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts?.[0]
      ?.error,
    'external_seed_direct_local_timeout',
  );
  assert.equal(
    Array.isArray(out.response.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts),
    true,
  );
  assert.equal(
    out.response.metadata?.search_execution_trace?.primary_failure_stage,
    'primary_upstream_timeout',
  );
  assert.deepEqual(
    out.response.metadata?.search_execution_trace?.supplements_attempted || [],
    [],
  );
});

test('framework local beauty mainline stops after primary timeout before support stages', async () => {
  const executedQueries = [];
  const runtime = createRuntime({
    searchPivotaBackendProducts: async ({ query }) => {
      executedQueries.push(query);
      if (query === 'oil control treatment') {
        return {
          ok: false,
          reason: 'upstream_timeout',
          actual_http_attempt_count: 1,
          products: [],
        };
      }
      return {
        ok: true,
        reason: 'ok',
        actual_http_attempt_count: 1,
        products: [
          {
            product_id: 'moisturizer_1',
            merchant_id: 'merchant_internal',
            title: 'Lightweight Gel Moisturizer',
            retrieval_source: 'internal_search',
            source_tier: 'fresh_internal',
            source_quality_class: 'trusted',
          },
        ],
      };
    },
  });

  const out = await runtime.runLocalBeautyDiscoveryMainline({
    search: {
      query: 'im oily skin, what products should i use?',
      source: 'aurora-bff',
      product_only: true,
    },
    metadata: {
      source: 'aurora-bff',
      catalog_surface: 'beauty',
    },
    requestContract: {
      surface: 'direct',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
      owner_switch_count: 0,
    },
    rawUserQuery: 'im oily skin, what products should i use?',
    gatewayRequestId: 'trace-framework-timeout-stop',
    traceQueryClass: 'query',
    timeoutMs: 2400,
    invokeStartedAtMs: Date.now(),
    logger: { warn() {} },
    authHeaders: { authorization: 'Bearer test' },
    operation: 'find_products_multi',
  });

  assert.equal(out.handled, true);
  assert.deepEqual(executedQueries, ['oil control treatment']);
  assert.deepEqual(out.response.products, []);
  assert.equal(
    out.response.metadata?.search_execution_trace?.primary_failure_stage,
    'primary_upstream_timeout',
  );
  assert.deepEqual(
    out.response.metadata?.search_execution_trace?.supplements_attempted || [],
    [],
  );
});
