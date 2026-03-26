const { createProductIntelUrlIngredientRuntime } = require('../src/auroraBff/productIntelUrlIngredientRuntime');

function createRuntime(overrides = {}) {
  const writeCompetitorSnapshot = jest.fn();
  const runtime = createProductIntelUrlIngredientRuntime({
    PRODUCT_URL_INGREDIENT_ANALYSIS_TIMEOUT_MS: 2400,
    PRODUCT_INTEL_INCIDECODER_ENABLED: false,
    PRODUCT_INTEL_INCIDECODER_TIMEOUT_MS: 2000,
    PRODUCT_INTEL_RETAIL_FALLBACK_ENABLED: false,
    PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT: 2,
    AURORA_BFF_RECO_BLOCKS_BUDGET_MS: 3200,
    PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES: 6,
    fetchProductHtmlWithFallback: async () => ({
      ok: true,
      html: '<html><head><title>Brand Serum | Brand</title></head><body>Ingredients: Water, Niacinamide.</body></html>',
      final_strategy: 'axios_default',
      attempts: [{ strategy: 'axios_default', provider: 'native', status: 200 }],
    }),
    extractInciListFromHtml: () => ['Water', 'Niacinamide'],
    extractKeyIngredientsFromHtml: () => ['Niacinamide'],
    fetchDailyMedRegulatorySupplement: async () => null,
    fetchIncidecoderIngredientSupplement: async () => null,
    fetchRetailIngredientSupplement: async () => null,
    buildIngredientConsensus: ({ official = [] }) => ({
      merged: official,
      stats: { overlap_inci_official: official.length },
      confidence_tier: 'high',
      has_conflict: false,
    }),
    canonicalizeIngredientCandidates: (items = []) => items.filter(Boolean),
    buildInciStatus: ({ gapCodes = [], sources = [] }) => ({ gap_codes: gapCodes, sources }),
    deriveKeyIngredientsForAnalysis: () => ['Niacinamide'],
    normalizeInciIngredientName: (value) => String(value || '').trim(),
    deriveIngredientMechanisms: () => ['brightening'],
    deriveIngredientRiskNotes: () => ['Patch test first.'],
    extractRealtimeSocialSignalsFromHtml: () => ({
      has_signal: true,
      platform_scores: { reddit: 0.71 },
      typical_positive: ['lightweight'],
      typical_negative: [],
      risk_for_groups: [],
      notes: ['Social note'],
    }),
    uniqCaseInsensitiveStrings: (items = [], max = 80) => {
      const seen = new Set();
      const out = [];
      for (const raw of Array.isArray(items) ? items : []) {
        const value = String(raw || '').trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
        if (out.length >= max) break;
      }
      return out;
    },
    extractPageTitleFromHtml: () => 'Brand Serum | Brand',
    extractProductPriceFromHtml: () => ({ amount: 29, currency: 'USD', source: 'page_price_signal' }),
    pickFirstTrimmed: (...values) => values.map((value) => String(value || '').trim()).find(Boolean) || '',
    joinBrandAndName: (brand, name) => [brand, name].filter(Boolean).join(' '),
    extractConcentrationSignals: () => ['5% niacinamide'],
    selectAssessmentSummary: ({ summary = '', reasons = [], fallbacks = [] } = {}) =>
      String(summary || '').trim() || reasons.find(Boolean) || fallbacks.find(Boolean) || '',
    normalizePriceObject: (value) => {
      if (!value) return null;
      if (typeof value === 'number') return { amount: value, currency: 'USD' };
      const amount = Number(value.amount);
      if (!Number.isFinite(amount)) return null;
      return { amount, currency: String(value.currency || 'USD').trim() || 'USD' };
    },
    initCandidateFilterStats: (seed = null) => ({
      competitors_dropped_non_skincare: Number(seed?.competitors_dropped_non_skincare || 0),
      related_dropped_non_skincare: Number(seed?.related_dropped_non_skincare || 0),
      dupes_dropped_non_skincare: Number(seed?.dupes_dropped_non_skincare || 0),
    }),
    runRecoBlocksForUrl: async () => ({
      competitors: { candidates: [{ product_id: 'comp-1', name: 'Competitor Serum', recommendation_intent: 'replace' }] },
      related_products: { candidates: [] },
      dupes: { candidates: [] },
      catalog_queries: ['brand serum'],
      internal_reason_codes: [],
      diagnostics: { mode: 'main_path', budget_ms: 3200, timed_out_blocks: [], fallbacks_used: [] },
      confidence_patch: { competitors: { score: 0.81, level: 'med' } },
      provenance_patch: { pipeline: 'reco_blocks_dag.v1', validation_mode: 'soft_fail' },
      tracking: { trace_id: 'trace-1' },
    }),
    sanitizeCompetitorCandidates: (items = []) => items.filter(Boolean),
    collectRouterReasonCodeTokens: () => [],
    summarizeRouterReasonCodes: () => [],
    buildRealtimeCompetitorCandidates: async () => ({ candidates: [] }),
    buildOnPageCompetitorCandidates: () => [],
    routeCompetitorCandidatePools: () => ({ compPool: [], relPool: [], dupePool: [], routed: null }),
    hasCandidateFilterDropStats: () => false,
    inferRecoPriceBand: () => 'mid',
    buildProfileSkinTags: () => ['oily', 'sensitive'],
    buildCompetitorSnapshotKey: () => 'snapshot-key',
    writeCompetitorSnapshot,
    normalizeProductAnalysis: (payload) => ({
      payload,
      field_missing: [{ field: 'assessment' }, { field: 'science' }],
    }),
    getProductAnalysisInternalMissingCodes: () => [],
    reconcileProductAnalysisConsistency: (value) => value,
    applyProductAnalysisGapContract: (value) => value,
    ...overrides,
  });
  return { runtime, writeCompetitorSnapshot };
}

describe('createProductIntelUrlIngredientRuntime', () => {
  test('returns null for invalid product URL', async () => {
    const { runtime } = createRuntime();
    await expect(
      runtime.buildProductAnalysisFromUrlIngredients({ productUrl: 'not-a-url', lang: 'EN' }),
    ).resolves.toBeNull();
  });

  test('builds URL ingredient analysis payload and writes competitor snapshot when DAG returns coverage', async () => {
    const { runtime, writeCompetitorSnapshot } = createRuntime();

    const out = await runtime.buildProductAnalysisFromUrlIngredients({
      productUrl: 'https://probe.example/product',
      lang: 'EN',
      parsedProduct: {
        product_id: 'anchor-1',
        brand: 'Brand',
        name: 'Serum',
        display_name: 'Brand Serum',
      },
      profileSummary: {
        skinType: 'oily',
        sensitivity: 'medium',
        barrierStatus: 'healthy',
      },
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    });

    expect(out).toBeTruthy();
    expect(out.payload?.assessment?.anchor_product?.display_name).toBe('Brand Serum');
    expect(out.payload?.provenance?.source).toBe('url_realtime_product_intel');
    expect(out.payload?.competitors?.candidates).toHaveLength(1);
    expect(out.payload?.evidence?.science?.key_ingredients).toEqual(['Niacinamide']);
    expect(out.source_meta).toEqual(
      expect.objectContaining({
        analyzer: 'url_realtime_product_intel_v1',
        source_url: 'https://probe.example/product',
        competitor_count: 1,
        competitor_source: 'reco_blocks_dag',
      }),
    );
    expect(out.field_missing).toEqual([{ field: 'science' }]);
    expect(writeCompetitorSnapshot).toHaveBeenCalledWith(
      'snapshot-key',
      expect.objectContaining({
        competitors: expect.any(Array),
      }),
      expect.objectContaining({
        source: 'realtime_main',
      }),
    );
  });
});
