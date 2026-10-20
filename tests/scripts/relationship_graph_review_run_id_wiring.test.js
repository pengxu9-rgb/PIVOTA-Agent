jest.mock('../../src/services/relationshipGraphServingProgress', () => ({
  ...jest.requireActual('../../src/services/relationshipGraphServingProgress'),
  readServingSnapshot: jest.fn(async () => ({ servedEdges: 0, anchors: new Set() })),
  readReviewMetrics: jest.fn(() => ({ reviewed_count: 0, approved_count: 0, review_error_count: 0, review_error_rate: 0, guard_blocked_count: 0 })),
}));

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const routineJob = require('../../scripts/run-relationship-graph-routine-job');
const { extractRelationshipGraphRunRecord } = require('../../src/services/relationshipGraphRunLedger');

// The run id the review stamps on every row (2026-10-20) must be the routine job's own, and the run
// ledger must keep it with the night's decision list, so the provenance and the ledger name one run.
const NOW = new Date('2026-10-21T10:38:00.000Z');
const tempRoots = [];
const tempDir = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempRoots.push(dir); return dir; };
afterAll(() => tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const argAfter = (args, name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

test('the routine job hands its own run id to the review step', async () => {
  const outDir = tempDir('relgraph-runid-');
  const options = routineJob.parseArgs(['--cutoff', '2026-06-01T00:00:00Z', '--out-dir', outDir, '--skip-validation'], { now: NOW });
  const runner = jest.fn(async (_command, args) => {
    if (String(args[0]).endsWith('audit-relationship-graph-serving-guard.js')) {
      const out = args[args.indexOf('--out') + 1];
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ total_rows: 0, suppressed_rows: 0, suppressed_pct: 0 }));
    }
    return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
  });
  const summary = await routineJob.runRoutineJob(options, { runner, now: NOW });
  const reviewCall = runner.mock.calls.find(([, args]) => String(args[0]).endsWith('review-relationship-candidate-labels.js'));
  expect(argAfter(reviewCall[1], 'run-id')).toBe(summary.run_id);
  expect(summary.run_id).toMatch(/^relgraph_routine_/);
});

test('the run ledger keeps the review run id with the decision list', () => {
  const dir = tempDir('relgraph-ledger-runid-');
  const reviewPath = path.join(dir, 'review.json');
  fs.writeFileSync(reviewPath, JSON.stringify({
    summary: { run_id: 'relgraph_routine_20261021T103800', reviewed_count: 1, approved_count: 1, approved_applied_count: 1, applied_count: 1 },
    decisions: [{ id: 'rcl_1', verdict: 'approve', applied: true, new_label_state: 'ai_approved', relationship_kind: 'substitute' }],
  }));
  const routinePath = path.join(dir, 'routine_summary.json');
  fs.writeFileSync(routinePath, JSON.stringify({ run_id: 'relgraph_routine_20261021T103800', options: {},
    artifacts: { review: reviewPath }, steps: [{ id: 'ai_review', artifact: reviewPath }] }));
  const record = extractRelationshipGraphRunRecord({ run_id: 'relgraph_sync_routine_20261021T103700', options: {},
    artifacts: { routine_summary: routinePath }, steps: [], ok: true, generated_at: NOW.toISOString() });
  const batch = record.summary.recommendation_review_batch;
  expect(batch.review_run_id).toBe('relgraph_routine_20261021T103800');
  expect(batch.decisions).toEqual([expect.objectContaining({ id: 'rcl_1', verdict: 'approve', applied: true })]);
  expect(record.routine_run_id).toBe('relgraph_routine_20261021T103800');
});
