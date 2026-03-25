const {
  createGuidanceLadderOutcomeRuntime,
} = require('../src/modules/decisioning/shopping_agent/guidanceLadderOutcome');

function createTestRuntime() {
  return createGuidanceLadderOutcomeRuntime({
    compareGuidanceCandidatePools(candidate, current) {
      return Number(candidate?.rank || 0) > Number(current?.rank || 0) ? 1 : -1;
    },
    buildGuidanceFastpathFailureClass(selectedDecision, selectedSummary) {
      if (selectedDecision?.success_contract_result?.failure_class) {
        return selectedDecision.success_contract_result.failure_class;
      }
      if (selectedSummary?.generic_only) return 'generic_family_only';
      return 'no_target_relevant_candidates';
    },
    stabilizeGuidanceFastpathDisplayProducts(products) {
      return Array.isArray(products) ? products.slice() : [];
    },
    normalizeGuidanceDiscoveryProductPdpContract(product) {
      return {
        product_id: product?.product_id || product?.productId || null,
        title: product?.title || null,
        merchant_id: product?.merchant_id || product?.merchantId || null,
      };
    },
    getGuidanceFastpathRemainingBudgetMs() {
      return 1234;
    },
    countCandidateOriginBreakdown(products) {
      const counts = {
        internal_live: 0,
        external_supplement: 0,
        stable_prior: 0,
      };
      for (const product of Array.isArray(products) ? products : []) {
        if (String(product?.merchant_id || product?.merchantId || '') === 'external_seed') {
          counts.external_supplement += 1;
        } else {
          counts.internal_live += 1;
        }
      }
      return counts;
    },
    inferGuidanceDiscoverySourceUsed(products) {
      return (Array.isArray(products) ? products : []).some(
        (product) => String(product?.merchant_id || product?.merchantId || '') === 'external_seed',
      )
        ? 'internal_plus_external_seed'
        : 'internal_only';
    },
  });
}

describe('Shopping agent guidance ladder outcome module', () => {
  test('builds attempt records and budget-exhausted skip records', () => {
    const runtime = createTestRuntime();

    expect(
      runtime.buildGuidanceAttemptRecord({
        attemptIndex: 1,
        attempt: { intent_strength: 'strong_goal_family', selected_query: 'repair serum' },
        clusterQueries: ['repair serum'],
        internalProducts: [{ product_id: 'p1' }],
        externalProducts: [{ product_id: 'p2' }],
        internalQueryTraces: [{ query: 'repair serum', ok: true }],
        externalPhase: { result: { metadata: { retrieval_query_debug: [{ query: 'repair serum' }] } } },
        mergedProducts: [{ product_id: 'p1' }, { product_id: 'p2' }],
        searchDecision: {
          target_relevance_class_counts: { strong_goal_family: 2 },
          step_success_class: 'valid_hit',
          success_contract_result: { satisfied: true },
        },
        candidateSummary: { counts: { strong_goal_family: 2 } },
        durationMs: 88,
        adopted: true,
      }),
    ).toEqual(
      expect.objectContaining({
        attempt_index: 1,
        intent_strength: 'strong_goal_family',
        selected_query: 'repair serum',
        internal_candidate_count: 1,
        external_candidate_count: 1,
        merged_candidate_count: 2,
        step_success_class: 'valid_hit',
        success_contract_satisfied: true,
        adopted: true,
      }),
    );

    expect(
      runtime.buildGuidanceSkippedAttemptRecord({
        attemptIndex: 2,
        attempt: {
          intent_strength: 'supportive_family',
          selected_query: 'soothing serum',
          cluster_queries: ['soothing serum'],
        },
      }),
    ).toEqual({
      attempt_index: 2,
      intent_strength: 'supportive_family',
      selected_query: 'soothing serum',
      cluster_queries: ['soothing serum'],
      adopted: false,
      skipped_reason: 'budget_exhausted',
    });
  });

  test('adopts candidate summaries only when they outrank the current summary', () => {
    const runtime = createTestRuntime();
    expect(runtime.shouldAdoptGuidanceAttempt(null, { rank: 1 })).toBe(true);
    expect(runtime.shouldAdoptGuidanceAttempt({ rank: 1 }, { rank: 2 })).toBe(true);
    expect(runtime.shouldAdoptGuidanceAttempt({ rank: 2 }, { rank: 1 })).toBe(false);
  });

  test('finalizes ladder result into response products, search decision, and metadata', () => {
    const runtime = createTestRuntime();
    const finalized = runtime.finalizeGuidanceLadderResult({
      selectedAttempt: {
        selected_query: 'repair serum',
        intent_strength: 'strong_goal_family',
        mergedProducts: [
          { product_id: 'p1', title: 'Repair Serum', merchant_id: 'internal' },
          { product_id: 'p2', title: 'Barrier Serum', merchant_id: 'external_seed' },
        ],
        displayProducts: [
          { product_id: 'p1', title: 'Repair Serum', merchant_id: 'internal' },
          { product_id: 'p2', title: 'Barrier Serum', merchant_id: 'external_seed' },
        ],
        searchDecision: {
          contract_version: 'v-test',
          hit_quality: 'valid_hit',
          success_contract_result: { satisfied: true, failure_class: null },
          target_relevance_class_counts: { strong_goal_family: 2 },
          candidate_class_counts: { strong_goal_family: 2 },
          topk_bucket_mix: { skincare: 1 },
          query_step_strength: 'strong_goal_family',
        },
      },
      selectedSummary: {
        counts: { strong_goal_family: 2 },
        rank: 2,
      },
      attempts: [{ intent_strength: 'strong_goal_family', selected_query: 'repair serum' }],
      queryText: 'repair serum',
      guidanceContext: {
        target_step_family: 'serum',
        query_step_strength: 'strong_goal_family',
      },
      requestedLimit: 1,
      startedAt: 1,
      allowExternalSeed: true,
      normalizedIntent: { normalized_query: 'repair serum' },
      attemptTrace: [{ attempt_index: 1 }],
      phaseTrace: [{ phase: 'internal_recall' }],
      externalSeedRowsRaw: 12,
      externalSeedRowsRelevant: 4,
      externalSeedRowsAppended: 1,
      beautySearchDecisionContractVersion: 'v-default',
    });

    expect(finalized.responseProducts).toEqual([
      { product_id: 'p1', title: 'Repair Serum', merchant_id: 'internal' },
    ]);
    expect(finalized.searchDecision).toEqual(
      expect.objectContaining({
        contract_version: 'v-test',
        hit_quality: 'valid_hit',
        query_target_step_family: 'serum',
        products_returned_count: 1,
      }),
    );
    expect(finalized.metadata).toEqual(
      expect.objectContaining({
        selected_attempt_query: 'repair serum',
        attempt_count: 1,
        external_seed_rows_fetched: 12,
        external_seed_rows_relevant: 4,
        external_seed_rows_appended: 1,
        query_target_step_family: 'serum',
      }),
    );
  });
});
