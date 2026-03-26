const {
  createProductIntelCompetitorCoverageRuntime,
} = require('../src/auroraBff/productIntelCompetitorCoverageRuntime');

describe('createProductIntelCompetitorCoverageRuntime', () => {
  function buildRuntime(overrides = {}) {
    return createProductIntelCompetitorCoverageRuntime({
      sanitizeCompetitorCandidates: jest.fn((items, max = 10) => (Array.isArray(items) ? items.slice(0, max) : [])),
      routeCompetitorCandidatePools: jest.fn(({ candidates }) => ({
        compPool: Array.isArray(candidates) ? candidates : [],
        relPool: [],
        routed: {},
        candidateFilterStats: {},
      })),
      initCandidateFilterStats: jest.fn((stats = {}) => ({
        competitors_dropped_non_skincare: Number(stats.competitors_dropped_non_skincare || 0),
        related_dropped_non_skincare: Number(stats.related_dropped_non_skincare || 0),
        dupes_dropped_non_skincare: Number(stats.dupes_dropped_non_skincare || 0),
      })),
      hasCandidateFilterDropStats: jest.fn((stats = {}) =>
        Object.values(stats).some((value) => Number(value || 0) > 0)),
      collectRouterReasonCodeTokens: jest.fn(() => []),
      summarizeRouterReasonCodes: jest.fn(() => []),
      uniqCaseInsensitiveStrings: jest.fn((items = [], max = 32) => {
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
      }),
      applyProductAnalysisGapContract: jest.fn((payload) => payload),
      collectProductIntelEvidenceSourceTypes: jest.fn(() => []),
      getProductAnalysisEvidenceCoverageScore: jest.fn(() => 0.03),
      PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT: 2,
      PRODUCT_INTEL_KB_QUARANTINE_ENABLED: true,
      AURORA_KB_SERVE_POLICY: 'strict',
      ...overrides,
    });
  }

  test('sanitizes competitor payloads and preserves recovered related products', () => {
    const runtime = buildRuntime({
      routeCompetitorCandidatePools: jest.fn(() => ({
        compPool: [{ product_id: 'comp_1', name: 'Competitor 1' }],
        relPool: [{ product_id: 'rel_1', name: 'Related 1' }],
        routed: { internal_reason_codes: ['competitor_category_unknown_blocked'] },
        candidateFilterStats: { competitors_dropped_non_skincare: 1 },
      })),
      summarizeRouterReasonCodes: jest.fn(() => ['competitor_category_unknown_blocked']),
    });

    const result = runtime.sanitizeCompetitorsInPayload({
      assessment: {
        anchor_product: { product_id: 'anchor_1', category: 'serum' },
      },
      competitors: {
        candidates: [
          { product_id: 'comp_1', name: 'Competitor 1' },
          { product_id: 'noise_1', name: 'Noise 1' },
        ],
      },
      related_products: {
        candidates: [{ product_id: 'existing_rel', name: 'Existing Related' }],
      },
      missing_info: ['competitors_missing'],
      provenance: {},
    });

    expect(result.competitors.candidates).toEqual([{ product_id: 'comp_1', name: 'Competitor 1' }]);
    expect(result.related_products.candidates).toEqual([
      { product_id: 'existing_rel', name: 'Existing Related' },
      { product_id: 'rel_1', name: 'Related 1' },
    ]);
    expect(result.missing_info).toEqual(expect.arrayContaining([
      'competitors_low_coverage',
      'competitors_non_skincare_filtered',
    ]));
    expect(result.internal_debug_codes).toEqual(expect.arrayContaining([
      'competitor_category_unknown_blocked',
    ]));
    expect(result.provenance.candidate_filter_stats).toEqual(
      expect.objectContaining({ competitors_dropped_non_skincare: 1 }),
    );
  });

  test('repairs zero-coverage or low-coverage payloads only when contract signals require it', () => {
    const runtime = buildRuntime();

    expect(runtime.shouldRepairCompetitorCoverage({
      assessment: { verdict: 'Unknown' },
      competitors: { candidates: [] },
    })).toBe(true);

    expect(runtime.shouldRepairCompetitorCoverage({
      assessment: { verdict: 'Unknown' },
      competitors: { candidates: [{ product_id: 'comp_1', name: 'Competitor 1' }] },
      missing_info: ['competitors_low_coverage'],
    }, { preferredCount: 2 })).toBe(true);

    expect(runtime.shouldRepairCompetitorCoverage({
      assessment: { verdict: 'Good' },
      competitors: {
        candidates: [
          { product_id: 'comp_1', name: 'Competitor 1' },
          { product_id: 'comp_2', name: 'Competitor 2' },
        ],
      },
    }, { preferredCount: 2 })).toBe(false);
  });

  test('merges internal missing-code sources for downstream consumers', () => {
    const runtime = buildRuntime();

    expect(runtime.getProductAnalysisInternalMissingCodes({
      internal_debug_codes: ['competitors_low_coverage'],
      missing_info_internal: ['analysis_limited'],
      missing_info: ['competitor_sync_aurora_fallback_used'],
    })).toEqual([
      'competitors_low_coverage',
      'analysis_limited',
      'competitor_sync_aurora_fallback_used',
    ]);
  });

  test('quarantines low-evidence KB entries and supports serve_with_labels mode', () => {
    const strictRuntime = buildRuntime();
    const labeledRuntime = buildRuntime({
      AURORA_KB_SERVE_POLICY: 'serve_with_labels',
    });

    const payload = {
      assessment: { verdict: 'Unknown', reasons: ['Insufficient evidence'] },
      evidence: {
        science: { key_ingredients: [], mechanisms: [] },
        social_signals: { typical_positive: [], typical_negative: [] },
        expert_notes: [],
      },
      missing_info: [],
      provenance: {},
    };
    const args = {
      kbEntry: { kb_key: 'product_url:https://brand.example/p1', source_meta: {} },
      payload,
      productUrl: 'https://brand.example/p1',
      anchorTrustContext: {
        level: 'soft_blocked',
        usable_for_anchor_id: false,
        reasons: ['anchor_soft_blocked_url_mismatch'],
      },
    };

    expect(strictRuntime.shouldServeProductIntelKbEntry(args)).toEqual(
      expect.objectContaining({
        serve: false,
        quarantined: true,
      }),
    );
    expect(labeledRuntime.shouldServeProductIntelKbEntry(args)).toEqual(
      expect.objectContaining({
        serve: true,
        quarantined: true,
      }),
    );
  });
});
