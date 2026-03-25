const {
  GUIDANCE_ONLY_UI_SURFACE,
  GUIDANCE_ONLY_DECISION_MODE,
  GUIDANCE_RETRIEVAL_MODE,
  GUIDANCE_EXECUTION_MODE_SERVER_OWNED_LADDER,
  createGuidanceDecisioningRuntime,
} = require('../src/modules/decisioning/shopping_agent/guidanceContext');

function createTestRuntime() {
  return createGuidanceDecisioningRuntime({
    normalizeSearchTextForMatch(value) {
      return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    },
    parseQueryStringArray(value) {
      if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
      const text = String(value || '').trim();
      if (!text) return [];
      return text.split(',').map((item) => item.trim()).filter(Boolean);
    },
    parseQueryBoolean(value) {
      const token = String(Array.isArray(value) ? value[0] : value || '')
        .trim()
        .toLowerCase();
      if (!token) return undefined;
      if (['1', 'true', 'yes', 'on'].includes(token)) return true;
      if (['0', 'false', 'no', 'off'].includes(token)) return false;
      return undefined;
    },
    firstQueryParamValue(value) {
      if (Array.isArray(value)) return String(value[0] || '').trim();
      return String(value || '').trim();
    },
    extractSearchQueryText(query) {
      return String(query?.query || '').trim();
    },
    extractSearchAnchorTokens(queryText) {
      return String(queryText || '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
    },
    isLookupStyleSearchQuery(queryText) {
      return /\bexact\b/i.test(String(queryText || ''));
    },
    buildFallbackCandidateText(product) {
      return String(product?.title || '').trim();
    },
  });
}

describe('Shopping agent guidance context module', () => {
  test('extracts guidance retrieval context for guidance-only skincare decisioning', () => {
    const runtime = createTestRuntime();
    const out = runtime.extractGuidanceRetrievalContext(
      {
        ui_surface: GUIDANCE_ONLY_UI_SURFACE,
        query: 'fragrance free barrier cream',
        negative_constraints: ['silicone'],
        product_only: 'true',
      },
      { queryText: 'fragrance free barrier cream' },
    );

    expect(out.ui_surface).toBe(GUIDANCE_ONLY_UI_SURFACE);
    expect(out.decision_mode).toBe(null);
    expect(out.target_step_family).toBe('moisturizer');
    expect(out.semantic_family).toBe('moisturizer');
    expect(out.retrieval_mode).toBe(GUIDANCE_RETRIEVAL_MODE);
    expect(out.product_only).toBe(true);
    expect(out.is_guidance_only).toBe(true);
    expect(out.is_guidance_recall_first).toBe(true);
    expect(out.is_server_owned_ladder).toBe(true);
    expect(out.execution_mode).toBe(GUIDANCE_EXECUTION_MODE_SERVER_OWNED_LADDER);
    expect(out.negative_constraints).toEqual(expect.arrayContaining(['silicone', 'fragrance_free']));
  });

  test('classifies target relevance and summarizes candidate pools', () => {
    const runtime = createTestRuntime();
    const guidanceQuery = {
      decision_mode: GUIDANCE_ONLY_DECISION_MODE,
      target_step_family: 'serum',
      query: 'repair serum',
    };
    const guidanceContext = runtime.extractGuidanceRetrievalContext(guidanceQuery, {
      queryText: 'repair serum',
    });

    expect(runtime.classifyGuidanceTargetRelevance(
      { title: 'Barrier Repair Serum with Panthenol' },
      'repair serum',
      guidanceContext,
    )).toBe('strong_goal_family');

    expect(runtime.classifyGuidanceTargetRelevance(
      { title: 'Calming Sensitive Skin Serum' },
      'repair serum',
      guidanceContext,
    )).toBe('supportive_family');

    expect(runtime.classifyGuidanceTargetRelevance(
      { title: 'Vitamin C Brightening Serum' },
      'repair serum',
      guidanceContext,
    )).toBe('adjacent_noise');

    const strongPool = runtime.summarizeGuidanceCandidatePool(
      [
        { title: 'Barrier Repair Serum with Panthenol' },
        { title: 'Calming Sensitive Skin Serum' },
      ],
      'repair serum',
      guidanceQuery,
    );
    const weakPool = runtime.summarizeGuidanceCandidatePool(
      [
        { title: 'Vitamin C Brightening Serum' },
        { title: 'Foundation Set' },
      ],
      'repair serum',
      guidanceQuery,
    );

    expect(strongPool.target_relevant_count).toBe(2);
    expect(weakPool.target_relevant_count).toBe(0);
    expect(runtime.compareGuidanceCandidatePools(strongPool, weakPool)).toBe(1);
  });

  test('detects lookup-style guidance query only when lookup signal exists', () => {
    const runtime = createTestRuntime();
    const guidanceContext = runtime.extractGuidanceRetrievalContext(
      {
        decision_mode: GUIDANCE_ONLY_DECISION_MODE,
        target_step_family: 'serum',
        query: 'exact serum sku',
      },
      { queryText: 'exact serum sku' },
    );

    expect(runtime.hasGuidanceLookupStyleQuery('exact serum sku', guidanceContext)).toBe(true);
    expect(runtime.hasGuidanceLookupStyleQuery('repair serum', guidanceContext)).toBe(false);
  });
});
