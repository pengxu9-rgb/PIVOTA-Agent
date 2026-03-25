const {
  createGuidanceFastpathRuntime,
} = require('../src/modules/decisioning/shopping_agent/guidanceFastpath');

function createTestRuntime(nowMs = 1000) {
  return createGuidanceFastpathRuntime({
    normalizeSearchHintToken(value) {
      return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    },
    extractSearchAnchorTokens(queryText) {
      return String(queryText || '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
    },
    normalizeSearchTextForMatch(value) {
      return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    },
    classifyGuidanceTargetRelevance(product) {
      return String(product?.targetClass || 'generic_family');
    },
    buildSearchDecisionProductKey(product) {
      return String(product?.product_id || product?.productId || '').trim();
    },
    classifySharedBeautyCoarseCandidate(product) {
      return {
        offer_type: product?.is_sample ? 'sample' : 'full_size',
      };
    },
    withStageBudget(promise, timeoutMs, phaseName) {
      if (phaseName === 'timeout_phase') {
        const error = new Error('timed out');
        error.code = 'STAGE_TIMEOUT';
        throw error;
      }
      if (phaseName === 'error_phase') {
        throw new Error('boom');
      }
      return promise;
    },
    getNowMs() {
      return nowMs;
    },
  });
}

describe('Shopping agent guidance fastpath module', () => {
  test('returns serum-specific and default phase budgets', () => {
    const runtime = createTestRuntime();
    expect(runtime.getGuidanceFastpathPhaseBudgets('serum')).toEqual({
      internal_recall_ms: 400,
      external_recall_ms: 3600,
    });
    expect(runtime.getGuidanceFastpathPhaseBudgets('moisturizer')).toEqual({
      internal_recall_ms: 800,
      external_recall_ms: 3200,
    });
  });

  test('dedupes and sorts fastpath products by target class, anchors, and internal preference', () => {
    const runtime = createTestRuntime();
    const out = runtime.mergeGuidanceFastpathProducts(
      [
        {
          product_id: 'p1',
          merchant_id: 'external_seed',
          title: 'Repair Serum External',
          targetClass: 'strong_goal_family',
        },
        {
          product_id: 'p1',
          merchant_id: 'external_seed',
          title: 'Repair Serum Duplicate',
          targetClass: 'supportive_family',
        },
        {
          product_id: 'p2',
          merchant_id: 'internal',
          title: 'Repair Serum Internal',
          targetClass: 'strong_goal_family',
        },
        {
          product_id: 'p3',
          merchant_id: 'internal',
          title: 'Generic Serum',
          targetClass: 'generic_family',
        },
      ],
      'repair serum',
      { is_guidance_only: true, target_step_family: 'serum' },
    );

    expect(out.map((item) => item.product_id)).toEqual(['p2', 'p1', 'p3']);
  });

  test('stabilizes moisturizer display by pushing samples behind full-size products', () => {
    const runtime = createTestRuntime();
    const out = runtime.stabilizeGuidanceFastpathDisplayProducts(
      [
        { product_id: 'sample-first', is_sample: true },
        { product_id: 'full-second', is_sample: false },
      ],
      'barrier moisturizer',
      {
        is_guidance_only: true,
        target_step_family: 'moisturizer',
        query_step_strength: 'supportive_family',
      },
    );

    expect(out.map((item) => item.product_id)).toEqual(['full-second', 'sample-first']);
  });

  test('records fastpath phase success and failure states', async () => {
    const runtime = createTestRuntime();

    await expect(runtime.runGuidanceFastpathPhase('ok_phase', 300, async () => ({ ok: true }))).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        phase: 'ok_phase',
        timeout_ms: 300,
        result: { ok: true },
      }),
    );

    await expect(runtime.runGuidanceFastpathPhase('timeout_phase', 300, async () => ({ ok: true }))).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        phase: 'timeout_phase',
        phase_skipped_reason: 'budget_exhausted',
      }),
    );

    await expect(runtime.runGuidanceFastpathPhase('error_phase', 300, async () => ({ ok: true }))).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        phase: 'error_phase',
        phase_skipped_reason: 'error',
      }),
    );
  });

  test('builds fastpath failure class from contract result or candidate summary', () => {
    const runtime = createTestRuntime();

    expect(
      runtime.buildGuidanceFastpathFailureClass(
        { success_contract_result: { failure_class: 'contract_failure' } },
        null,
      ),
    ).toBe('contract_failure');

    expect(runtime.buildGuidanceFastpathFailureClass(null, { adjacent_noise_dominant: true })).toBe(
      'retrieval_direction_weak',
    );
    expect(runtime.buildGuidanceFastpathFailureClass(null, { generic_only: true })).toBe(
      'generic_family_only',
    );
    expect(runtime.buildGuidanceFastpathFailureClass(null, null)).toBe('no_target_relevant_candidates');
  });
});
