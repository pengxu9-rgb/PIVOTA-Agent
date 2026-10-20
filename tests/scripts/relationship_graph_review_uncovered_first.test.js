jest.mock('../../src/services/relationshipGraphServingProgress', () => ({
  ...jest.requireActual('../../src/services/relationshipGraphServingProgress'),
  readServingSnapshot: jest.fn(async () => ({ servedEdges: 0, anchors: new Set() })),
  readReviewMetrics: jest.fn(() => ({ reviewed_count: 0, approved_count: 0, review_error_count: 0, review_error_rate: 0, guard_blocked_count: 0 })),
}));

const { buildCronArgs } = require('../../scripts/run-relationship-graph-sync-routine-cron');
const syncRoutine = require('../../scripts/run-relationship-graph-sync-routine');
const routineJob = require('../../scripts/run-relationship-graph-routine-job');
const review = require('../../scripts/review-relationship-candidate-labels');

// 2026-10-20: of 26,617 generated competitive_alternative labels only 5,933 sat on the 2,616 anchors
// with no served alternative, and score order spent the nights on anchors that already had a rail.
// RELGRAPH_SYNC_REVIEW_UNCOVERED_FIRST must reach the review query at every layer, and stay off unless set.
const NOW = new Date('2026-10-20T10:37:00.000Z');

test('the cron passes --review-uncovered-first only when RELGRAPH_SYNC_REVIEW_UNCOVERED_FIRST is true', () => {
  expect(buildCronArgs({ RELGRAPH_SYNC_REVIEW_UNCOVERED_FIRST: 'true' }, { now: NOW }).args).toContain('--review-uncovered-first');
  expect(buildCronArgs({ RELGRAPH_SYNC_REVIEW_UNCOVERED_FIRST: 'false' }, { now: NOW }).args).not.toContain('--review-uncovered-first');
  expect(buildCronArgs({}, { now: NOW }).args).not.toContain('--review-uncovered-first');
});

test('the sync routine and the routine job hand it on, and the review step gets --uncovered-first', () => {
  const sync = syncRoutine.parseArgs(['--cutoff', '2026-01-01T00:00:00Z', '--external-product-ids', 'seed_1',
    '--review-uncovered-first', '--out-dir', '/tmp/relgraph-uncovered-first'], { now: NOW });
  expect(sync.reviewUncoveredFirst).toBe(true);
  const routineStep = syncRoutine.buildSyncRoutineSteps(sync).steps.find((step) => step.id === 'relationship_graph_routine');
  expect(routineStep.args).toContain('--review-uncovered-first');

  const job = routineJob.parseArgs(['--cutoff', '2026-01-01T00:00:00Z', '--review-uncovered-first', '--out-dir', '/tmp/relgraph-uncovered-first'],
    { now: NOW });
  const reviewStep = routineJob.buildRoutineSteps(job).steps.find((s) => s.id === 'ai_review');
  expect(reviewStep.args).toContain('--uncovered-first');

  const off = routineJob.parseArgs(['--cutoff', '2026-01-01T00:00:00Z', '--out-dir', '/tmp/relgraph-uncovered-first'], { now: NOW });
  expect(routineJob.buildRoutineSteps(off).steps.find((s) => s.id === 'ai_review').args).not.toContain('--uncovered-first');
  expect(review.parseArgs(['--cutoff', '2026-01-01T00:00:00Z', '--uncovered-first']).uncoveredFirst).toBe(true);
  expect(review.parseArgs(['--cutoff', '2026-01-01T00:00:00Z']).uncoveredFirst).toBe(false);
});

test('off, the queue query is the plain score order; on, it ranks uncovered anchors first', async () => {
  const seen = [];
  const queryFn = async (sql, params) => { seen.push({ sql, params }); return { rows: [] }; };
  await review.runReview({ cutoff: '2026-01-01T00:00:00Z', limit: 5, apply: false, queryFn, provider: { __meta: { model: 'm' } },
    negativeTtlDays: 0, out: '' });
  await review.runReview({ cutoff: '2026-01-01T00:00:00Z', limit: 5, apply: false, queryFn, provider: { __meta: { model: 'm' } },
    negativeTtlDays: 0, out: '', uncoveredFirst: true });
  const queues = seen.filter(({ sql }) => /label_state = 'generated'/.test(sql) && /LIMIT \$3::int/.test(sql));
  expect(queues).toHaveLength(2);
  expect(queues[0].sql).not.toMatch(/anchor_covered/);
  expect(queues[0].sql).toMatch(/ORDER BY score_total DESC NULLS LAST, created_at ASC, id ASC/);
  expect(queues[1].sql).toMatch(/ORDER BY anchor_covered ASC, CASE WHEN anchor_covered THEN 0 ELSE anchor_rank END ASC/);
  expect(queues[1].params).toEqual(queues[0].params);
});
