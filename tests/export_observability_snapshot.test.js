const {
  summarizeGroup,
  buildHealthRows,
  buildQualityRows,
  buildCasebookForWindow,
} = require('../scripts/export_observability_snapshot');

describe('export_observability_snapshot', () => {
  const bundles = [
    {
      req_id: 'r1',
      ts: new Date().toISOString(),
      query: 'ipsa',
      result_type: 'product_list',
      reason_code: 'CACHE_HIT',
      latency_ms: { total: 100, nlu: 10, lexical: 20, vector: 0, behavior: 0, rank: 5 },
      degrade: { nlu_degraded: false, vector_skipped: false, behavior_skipped: false },
      nlu: { intent_top1: 'lookup', slots: { domain: 'beauty' }, U_pre: 0.2 },
      post: { candidates: 3, domain_entropy_topK: 0.1, lexical_anchor_ratio_topK: 1, U_post: 0.2 },
      top_items: [{ pid: 'p1', domain: 'beauty', source: 'cache' }],
      recall: {
        counts_raw: { external_seed: 0 },
        counts_after_dedup: 8,
        pre_filter_candidates: 8,
        drops: { domain_filter: 1, inventory_filter: 0, constraints_filter: 0 },
      },
    },
    {
      req_id: 'r2',
      ts: new Date().toISOString(),
      query: '约会妆',
      result_type: 'clarify',
      reason_code: 'AMBIGUOUS_MEDIUM',
      latency_ms: { total: 220, nlu: 12, lexical: 30, vector: 0, behavior: 0, rank: 8 },
      degrade: { nlu_degraded: false, vector_skipped: false, behavior_skipped: false },
      nlu: { intent_top1: 'scenario', slots: { domain: 'beauty' }, U_pre: 0.4 },
      post: { candidates: 0, domain_entropy_topK: null, lexical_anchor_ratio_topK: null, U_post: 0.7 },
      top_items: [],
      recall: {
        counts_raw: { external_seed: 0 },
        counts_after_dedup: 7,
        pre_filter_candidates: 7,
        drops: { domain_filter: 2, inventory_filter: 1, constraints_filter: 1 },
      },
    },
  ];

  test('builds health and quality rows', () => {
    const health = buildHealthRows(bundles, '24h', 6);
    const quality = buildQualityRows(health);
    expect(health.length).toBeGreaterThan(0);
    expect(quality.length).toBeGreaterThan(0);
    const overall = health.find((row) => row.group_type === 'overall');
    expect(overall.req_cnt).toBe(2);
    expect(overall.product_list_rate).toBeCloseTo(0.5, 4);
  });

  test('builds casebook sections', () => {
    const casebook = buildCasebookForWindow(
      bundles.concat([
        {
          ...bundles[1],
          req_id: 'r3',
          ts: new Date().toISOString(),
          result_type: 'strict_empty',
          reason_code: 'NO_CANDIDATES',
          query: '狗链',
        },
      ]),
      { casebookTop: 10, maxSamplesPerQuery: 2 },
    );
    expect(Array.isArray(casebook.strict_empty_top_queries)).toBe(true);
    expect(Array.isArray(casebook.quality_risk_top_queries)).toBe(true);
    expect(Array.isArray(casebook.degrade_top_queries)).toBe(true);
  });

  test('summarizeGroup returns expected metrics', () => {
    const summary = summarizeGroup(bundles, { kMin: 6 });
    expect(summary.req_cnt).toBe(2);
    expect(summary.clarify_rate).toBeCloseTo(0.5, 4);
    expect(summary.no_candidate_rate).toBeCloseTo(1, 4);
    expect(summary.pre_filter_candidate_rate).toBeCloseTo(1, 4);
    expect(summary.filtered_to_empty_rate).toBeCloseTo(0.5, 4);
    expect(summary.domain_drop_ratio).toBeGreaterThan(0);
  });
});
