const {
  buildServingStatusSql,
  formatServingStatusText,
  parseArgs,
  runServingStatusReport,
  summarizeServingStatusRows,
} = require('../../scripts/report-relationship-graph-serving-status');

const NOW = '2026-06-08T12:00:00.000Z';

function row(overrides = {}) {
  return {
    id: overrides.id || 'rcl_test',
    anchor_type: 'product',
    anchor_ref: 'product:anchor_1',
    candidate_product_ref: 'product:candidate_1',
    relation_type: 'competitive_alternative',
    label_state: 'human_approved',
    market: 'US',
    vertical: 'beauty',
    score_total: 0.9,
    last_verified_at: NOW,
    expires_at: '2026-07-08T12:00:00.000Z',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe('report-relationship-graph-serving-status', () => {
  test('parseArgs accepts readiness gates without forcing exit failure by default', () => {
    const options = parseArgs([
      '--all-markets',
      '--limit',
      '500',
      '--top-anchors',
      '5',
      '--min-anchor-count',
      '200',
      '--min-approved-alternative-anchor-pct',
      '70',
      '--min-niche-specialist-count',
      '100',
      '--max-expiring-7d',
      '12',
      '--max-ai-approved-pct',
      '60',
      '--max-expiring-14d-pct',
      '40',
      '--fail-on-expiry-risk',
      '--json',
    ]);

    expect(options).toEqual(expect.objectContaining({
      market: '',
      limit: 500,
      topAnchors: 5,
      failOnReadiness: false,
      failOnExpiryRisk: true,
      json: true,
    }));
    expect(options.thresholds).toEqual(expect.objectContaining({
      minAnchorCount: 200,
      minApprovedAlternativeAnchorPct: 70,
      minNicheSpecialistCount: 100,
      maxExpiring7d: 12,
      maxAiApprovedPct: 60,
      maxExpiring14dPct: 40,
    }));
  });

  test('expiring-14d percentage gate flags a renewal outage cliff', () => {
    const cliff = summarizeServingStatusRows([
      row({ id: 'e1', expires_at: '2026-06-15T12:00:00.000Z' }),
      row({ id: 'e2', expires_at: '2026-06-18T12:00:00.000Z' }),
      row({ id: 'safe', expires_at: '2026-07-20T12:00:00.000Z' }),
    ], {
      generatedAt: NOW,
      thresholds: { maxExpiring14dPct: 30 },
    });

    expect(cliff.expiry_windows.expiring_14d).toBe(2);
    expect(cliff.expiry_windows.expiring_14d_pct).toBe(66.67);
    expect(cliff.checks.expiring_14d_pct.status).toBe('fail');
    expect(cliff.ok).toBe(false);

    const inactive = summarizeServingStatusRows([
      row({ id: 'e1', expires_at: '2026-06-15T12:00:00.000Z' }),
    ], { generatedAt: NOW });
    expect(inactive.checks.expiring_14d_pct.status).toBe('not_applicable');
  });

  test('buildServingStatusSql uses the runtime active/fresh serving predicates', () => {
    const { sql, params } = buildServingStatusSql({ market: 'us', limit: 25 });

    expect(sql).toMatch(/FROM relationship_candidate_labels/);
    expect(sql).toMatch(/label_state IN \('human_approved','ai_approved'\)/);
    expect(sql).toMatch(/last_verified_at IS NOT NULL/);
    expect(sql).toMatch(/expires_at > now\(\)/);
    expect(sql).toMatch(/upper\(market\) = \$1/);
    expect(sql).toMatch(/LIMIT \$2::int/);
    expect(params).toEqual(['US', 25]);
  });

  test('summarizes live coverage and fails runbook readiness when niche coverage is missing', () => {
    const summary = summarizeServingStatusRows([
      row({
        id: 'alt_1',
        anchor_ref: 'product:anchor_1',
        candidate_product_ref: 'product:candidate_1',
        relation_type: 'competitive_alternative',
      }),
      row({
        id: 'dupe_1',
        anchor_ref: 'product:anchor_2',
        candidate_product_ref: 'product:candidate_2',
        relation_type: 'dupe',
        label_state: 'ai_approved',
      }),
      row({
        id: 'related_1',
        anchor_ref: 'product:anchor_2',
        candidate_product_ref: 'product:candidate_3',
        relation_type: 'related_product',
        label_state: 'human_approved',
        expires_at: '2026-06-12T12:00:00.000Z',
      }),
    ], {
      generatedAt: NOW,
      topAnchors: 2,
      thresholds: {
        minAnchorCount: 2,
        minApprovedAlternativeAnchorPct: 70,
        minNicheSpecialistCount: 1,
        maxExpiring7d: 0,
        maxAiApprovedPct: 50,
      },
    });

    expect(summary.ok).toBe(false);
    expect(summary.coverage).toEqual(expect.objectContaining({
      total_rows: 3,
      distinct_anchor_count: 2,
      distinct_candidate_count: 3,
      approved_alternative_anchor_count: 2,
      approved_alternative_anchor_pct: 100,
      niche_specialist_count: 0,
      human_approved_rows: 2,
      ai_approved_rows: 1,
      ai_approved_pct: 33.33,
    }));
    expect(summary.expiry_windows.expiring_7d).toBe(1);
    expect(summary.checks.anchor_count.status).toBe('pass');
    expect(summary.checks.approved_alternative_anchor_pct.status).toBe('pass');
    expect(summary.checks.niche_specialist_count.status).toBe('fail');
    expect(summary.checks.expiring_7d.status).toBe('fail');
    expect(summary.by_relation_type).toEqual({
      competitive_alternative: 1,
      dupe: 1,
      related_product: 1,
    });
    expect(summary.top_anchors[0]).toEqual({ anchor_ref: 'product:anchor_2', edge_count: 2 });
  });

  test('passes readiness when live coverage meets thresholds', () => {
    const rows = [
      row({
        id: 'alt_1',
        anchor_ref: 'product:anchor_1',
        candidate_product_ref: 'product:candidate_1',
        relation_type: 'competitive_alternative',
      }),
      row({
        id: 'niche_1',
        anchor_ref: 'product:anchor_2',
        candidate_product_ref: 'product:candidate_2',
        relation_type: 'niche_specialist',
      }),
      row({
        id: 'dupe_1',
        anchor_ref: 'product:anchor_2',
        candidate_product_ref: 'product:candidate_3',
        relation_type: 'dupe',
      }),
    ];

    const summary = summarizeServingStatusRows(rows, {
      generatedAt: NOW,
      thresholds: {
        minAnchorCount: 2,
        minApprovedAlternativeAnchorPct: 70,
        minNicheSpecialistCount: 1,
      },
    });

    expect(summary.ok).toBe(true);
    expect(summary.checks.niche_specialist_count.status).toBe('pass');
  });

  test('runServingStatusReport delegates to an injectable query function', async () => {
    const queryFn = jest.fn(async () => ({
      rows: [
        row({
          id: 'niche_1',
          relation_type: 'niche_specialist',
        }),
      ],
    }));

    const report = await runServingStatusReport({
      queryFn,
      market: 'US',
      limit: 10,
      generatedAt: NOW,
      thresholds: {
        minAnchorCount: 1,
        minApprovedAlternativeAnchorPct: 0,
        minNicheSpecialistCount: 1,
      },
    });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][0]).toMatch(/relationship_candidate_labels/);
    expect(queryFn.mock.calls[0][1]).toEqual(['US', 10]);
    expect(report.query.predicate).toContain("label_state IN ('human_approved','ai_approved')");
    expect(report.ok).toBe(true);
  });

  test('formatServingStatusText includes compact coverage, expiry, and gate details', () => {
    const report = summarizeServingStatusRows([
      row({
        relation_type: 'niche_specialist',
      }),
    ], {
      generatedAt: NOW,
      thresholds: {
        minAnchorCount: 1,
        minApprovedAlternativeAnchorPct: 0,
        minNicheSpecialistCount: 1,
      },
    });
    const text = formatServingStatusText(report);

    expect(text).toContain('relationship graph serving status: ready');
    expect(text).toContain('rows=1 anchors=1 candidates=1');
    expect(text).toContain('niche_specialist=1');
    expect(text).toContain('- niche_specialist_count: pass metric=1 threshold=1 count');
  });
});
