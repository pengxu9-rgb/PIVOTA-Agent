const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  extractRelationshipGraphRunRecord,
  recordRelationshipGraphRun,
} = require('../../src/services/relationshipGraphRunLedger');

const GENERATED_AT = '2026-06-08T00:00:00.000Z';
const CUTOFF = '2026-06-07T00:00:00.000Z';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

function buildSummaryFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-run-ledger-'));
  const selectorPath = path.join(dir, 'affected-products.json');
  const buildPath = path.join(dir, 'routine', 'build.json');
  const reviewPath = path.join(dir, 'routine', 'review.json');
  const servingAuditPath = path.join(dir, 'routine', 'serving-audit.json');
  const routineSummaryPath = path.join(dir, 'routine', 'routine_summary.json');
  const summaryPath = path.join(dir, 'sync_routine_summary.json');

  writeJson(selectorPath, {
    schema_version: 'relationship_graph_affected_products.v1',
    market: 'US',
    affected_count: 6,
    selection: {
      updated_since: CUTOFF,
      sources: ['catalog_products', 'external_product_seeds'],
      limit: 250,
    },
  });
  writeJson(buildPath, {
    schema_version: 'product_relationship_graph_build.v1',
    summary: {
      anchor_count: 6,
      edge_count: 19,
      rejected_count: 8,
      applied_count: 0,
    },
    edges: [],
    rejected_edges: [],
  });
  writeJson(reviewPath, {
    schema_version: 'product_relationship_graph_review.v1',
    summary: {
      reviewed_count: 4,
      approved_count: 2,
      rejected_count: 1,
      applied_count: 0,
    },
    decisions: [],
  });
  writeJson(servingAuditPath, {
    schema_version: 'relationship_graph_serving_guard_audit.v1',
    total_rows: 8404,
    safe_rows: 8404,
    suppressed_rows: 0,
    suppressed_pct: 0,
  });
  writeJson(routineSummaryPath, {
    run_id: 'relgraph_routine_20260608T000000',
    generated_at: GENERATED_AT,
    out_dir: path.join(dir, 'routine'),
    db_lock: {
      requested: true,
      acquired: true,
      lock_key: 'relationship_graph_routine',
    },
    options: {
      market: 'US',
      cutoff: CUTOFF,
      dry_run: true,
      apply_build: false,
      apply_review: false,
      db_lock: true,
    },
    artifacts: {
      build: buildPath,
      review: reviewPath,
      serving_audit: servingAuditPath,
    },
    steps: [
      { id: 'build', status: 'passed', completed_at: '2026-06-08T00:00:02.000Z' },
      { id: 'ai_review', status: 'passed', completed_at: '2026-06-08T00:00:04.000Z' },
      { id: 'serving_guard_audit', status: 'passed', completed_at: '2026-06-08T00:00:06.000Z' },
    ],
    ok: true,
  });

  return {
    run_id: 'relgraph_sync_routine_20260608T000000',
    generated_at: GENERATED_AT,
    out_dir: dir,
    options: {
      market: 'US',
      cutoff: CUTOFF,
      dry_run: true,
      apply_sync: false,
      apply_build: false,
      apply_review: false,
      db_lock: true,
      selector: {
        updated_since: CUTOFF,
        sources: ['catalog_products', 'external_product_seeds'],
        limit: 250,
      },
    },
    artifacts: {
      affected_products: selectorPath,
      affected_product_selector: selectorPath,
      routine_summary: routineSummaryPath,
      summary: summaryPath,
    },
    steps: [
      { id: 'affected_product_selector', status: 'passed', completed_at: '2026-06-08T00:00:01.000Z' },
      { id: 'relationship_graph_routine', status: 'passed', completed_at: '2026-06-08T00:00:07.000Z' },
    ],
    ok: true,
    summary_path: summaryPath,
  };
}

describe('relationshipGraphRunLedger', () => {
  test('extractRelationshipGraphRunRecord maps routine artifacts into compact counters', () => {
    const summary = buildSummaryFixture();

    const record = extractRelationshipGraphRunRecord(summary, {
      trigger: 'railway_cron',
    });

    expect(record).toEqual(expect.objectContaining({
      run_id: 'relgraph_sync_routine_20260608T000000',
      run_kind: 'sync_routine',
      trigger: 'railway_cron',
      routine_run_id: 'relgraph_routine_20260608T000000',
      market: 'US',
      status: 'passed',
      dry_run: true,
      cutoff: CUTOFF,
      selector_updated_since: CUTOFF,
      selector_sources: ['catalog_products', 'external_product_seeds'],
      selector_limit: 250,
      affected_count: 6,
      anchor_count: 6,
      edge_count: 19,
      rejected_count: 8,
      reviewed_count: 4,
      approved_count: 2,
      review_rejected_count: 1,
      applied_count: 0,
      serving_total_rows: 8404,
      serving_safe_rows: 8404,
      serving_suppressed_rows: 0,
      serving_suppressed_pct: 0,
      db_lock_requested: true,
      db_lock_acquired: true,
      failed_step: null,
      generated_at: GENERATED_AT,
      completed_at: '2026-06-08T00:00:07.000Z',
    }));
  });

  test('recordRelationshipGraphRun upserts by run_id with aligned parameters', async () => {
    const summary = buildSummaryFixture();
    const queryFn = jest.fn(async () => ({ rowCount: 1 }));

    const record = await recordRelationshipGraphRun(summary, {
      trigger: 'railway_cron',
      queryFn,
    });

    expect(record.status).toBe('passed');
    expect(queryFn).toHaveBeenCalledTimes(1);
    const [sql, params] = queryFn.mock.calls[0];
    expect(sql).toContain('INSERT INTO relationship_graph_routine_runs');
    expect(sql).toContain('ON CONFLICT (run_id) DO UPDATE');
    expect(params).toHaveLength(35);
    expect(params[0]).toBe('relgraph_sync_routine_20260608T000000');
    expect(params[1]).toBe('sync_routine');
    expect(params[2]).toBe('railway_cron');
    expect(params[4]).toBe('relgraph_routine_20260608T000000');
    expect(params[5]).toBe('US');
    expect(params[6]).toBe('passed');
    expect(params[13]).toEqual(['catalog_products', 'external_product_seeds']);
    expect(params[15]).toBe(6);
    expect(params[16]).toBe(6);
    expect(params[17]).toBe(19);
    expect(params[19]).toBe(4);
    expect(params[23]).toBe(8404);
    expect(params[27]).toBe(true);
    expect(params[28]).toBe(true);
    expect(JSON.parse(params[32])).toEqual(expect.objectContaining({
      run_id: 'relgraph_sync_routine_20260608T000000',
      ok: true,
    }));
  });
});
