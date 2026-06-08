const {
  buildServedRowsSql,
  loadServedRelationshipRowsWithRetry,
  parseArgs,
  runServingGuardAudit,
  summarizeSuppressionRows,
} = require('../../scripts/audit-relationship-graph-serving-guard');

const NOW = '2026-06-08T00:00:00.000Z';

function row(overrides = {}) {
  return {
    id: overrides.id || 'prel_test',
    anchor_type: 'product',
    anchor_ref: 'product:anchor_1',
    anchor_snapshot: {
      brand: 'Anchor Brand',
      title: 'Anchor Barrier Serum',
    },
    candidate_product_ref: 'product:candidate_1',
    candidate_snapshot: {
      brand: 'Candidate Brand',
      title: 'Candidate Barrier Serum',
    },
    relation_type: 'competitive_alternative',
    display_label: 'alternative',
    market: 'US',
    vertical: 'beauty',
    category_taxonomy: ['skincare'],
    use_case: 'barrier support',
    score_total: 0.9,
    score_breakdown: { score_total: 0.9 },
    price_evidence: {},
    source_refs: [{ type: 'products_cache', authoritative: true }],
    evidence_grade: 'A',
    review_status: 'approved',
    label_state: 'human_approved',
    why_candidate: {},
    tradeoffs: [],
    watchouts: [],
    provenance: {},
    last_verified_at: NOW,
    expires_at: '2026-07-08T00:00:00.000Z',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe('audit-relationship-graph-serving-guard', () => {
  test('parseArgs accepts audit query retry controls', () => {
    const options = parseArgs([
      '--market',
      'US',
      '--query-retries',
      '4',
      '--query-retry-backoff-ms',
      '250',
    ]);

    expect(options.queryRetries).toBe(4);
    expect(options.queryRetryBackoffMs).toBe(250);
  });

  test('builds a read-only label-store query without pre-filtering audited suppressions', () => {
    const { sql, params } = buildServedRowsSql({ market: 'US', limit: 25 });

    expect(sql).toMatch(/FROM relationship_candidate_labels/);
    expect(sql).toMatch(/label_state IN \('human_approved','ai_approved'\)/);
    expect(sql).toMatch(/last_verified_at IS NOT NULL/);
    expect(sql).toMatch(/expires_at > now\(\)/);
    expect(sql).not.toMatch(/NOT \(label_state = 'ai_approved' AND relation_type = 'dupe'\)/);
    expect(params).toEqual(['US', 25]);
  });

  test('summarizes runtime serving guard suppressions with examples', () => {
    const rows = [
      row({
        id: 'ai_dupe',
        relation_type: 'dupe',
        label_state: 'ai_approved',
      }),
      row({
        id: 'human_dupe',
        relation_type: 'dupe',
        label_state: 'human_approved',
      }),
      row({
        id: 'fenty_shade',
        relation_type: 'related_product',
        label_state: 'ai_approved',
        anchor_snapshot: {
          brand: 'Fenty Beauty',
          title: "Pro Filt'r Soft Matte Longwear Foundation #120",
        },
        candidate_snapshot: {
          brand: 'Fenty Beauty',
          title: "Pro Filt'r Soft Matte Longwear Foundation #130",
        },
      }),
      row({
        id: 'nested_ref',
        relation_type: 'competitive_alternative',
        label_state: 'human_approved',
        candidate_product_ref: 'product:ulta:12345',
      }),
      row({
        id: 'size_like_pair',
        relation_type: 'related_product',
        label_state: 'ai_approved',
        anchor_snapshot: {
          brand: 'Skin Brand',
          title: 'Barrier Serum - 30',
        },
        candidate_snapshot: {
          brand: 'Skin Brand',
          title: 'Barrier Cream - 50',
        },
      }),
    ];

    const summary = summarizeSuppressionRows(rows, {
      generatedAt: NOW,
      examplesPerReason: 2,
    });

    expect(summary.total_rows).toBe(5);
    expect(summary.safe_rows).toBe(2);
    expect(summary.suppressed_rows).toBe(3);
    expect(summary.by_reason.ai_approved_dupe_quarantined).toBe(1);
    expect(summary.by_reason.related_product_mismatched_shade_sku).toBe(1);
    expect(summary.by_reason.related_product_fenty_complexion_sku_flood).toBe(1);
    expect(summary.by_reason.candidate_ref_unresolvable_nested_product_prefix).toBe(1);
    expect(summary.examples_by_reason.ai_approved_dupe_quarantined[0]).toEqual(
      expect.objectContaining({
        id: 'ai_dupe',
        label_state: 'ai_approved',
        relation_type: 'dupe',
      }),
    );
    expect(summary.by_relation_type.related_product.safe).toBe(1);
    expect(summary.by_relation_type.related_product.suppressed).toBe(1);
  });

  test('runs the audit through the injectable query function', async () => {
    const queryFn = jest.fn(async () => ({
      rows: [
        row({
          id: 'ai_dupe',
          relation_type: 'dupe',
          label_state: 'ai_approved',
        }),
      ],
    }));

    const audit = await runServingGuardAudit({
      queryFn,
      market: 'US',
      limit: 10,
      examplesPerReason: 1,
      generatedAt: NOW,
    });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][0]).toMatch(/FROM relationship_candidate_labels/);
    expect(queryFn.mock.calls[0][1]).toEqual(['US', 10]);
    expect(audit.suppressed_rows).toBe(1);
    expect(audit.query.source_table).toBe('relationship_candidate_labels');
    expect(audit.query.retry).toEqual({ attempts: 0, max_retries: 2, errors: [] });
    expect(audit.query.predicate).toContain("label_state IN ('human_approved','ai_approved')");
  });

  test('retries transient read failures and records retry metadata', async () => {
    const transient = new Error('connection terminated unexpectedly');
    transient.code = '57P01';
    const queryFn = jest
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ rows: [row({ id: 'safe_row' })] });
    const closePoolFn = jest.fn(async () => {});

    const audit = await runServingGuardAudit({
      queryFn,
      closePoolFn,
      market: 'US',
      queryRetries: 2,
      queryRetryBackoffMs: 0,
      generatedAt: NOW,
    });

    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(closePoolFn).toHaveBeenCalledTimes(1);
    expect(audit.safe_rows).toBe(1);
    expect(audit.query.retry).toEqual({
      attempts: 1,
      max_retries: 2,
      errors: [
        expect.objectContaining({
          attempt: 1,
          code: '57P01',
          message: 'connection terminated unexpectedly',
        }),
      ],
    });
  });

  test('does not retry non-transient read failures', async () => {
    const err = new Error('relation does not exist');
    err.code = '42P01';
    const queryFn = jest.fn(async () => {
      throw err;
    });

    await expect(loadServedRelationshipRowsWithRetry({
      queryFn,
      queryRetries: 2,
      queryRetryBackoffMs: 0,
    })).rejects.toMatchObject({ code: '42P01' });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});
