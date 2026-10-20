jest.mock('../../src/services/relationshipGraphServingProgress', () => ({
  ...jest.requireActual('../../src/services/relationshipGraphServingProgress'),
  readServingSnapshot: jest.fn(async () => ({ servedEdges: 0, anchors: new Set() })),
  readReviewMetrics: jest.fn(() => ({ reviewed_count: 0, approved_count: 0, review_error_count: 0, review_error_rate: 0, guard_blocked_count: 0 })),
}));

const { buildCronArgs } = require('../../scripts/run-relationship-graph-sync-routine-cron');
const syncRoutine = require('../../scripts/run-relationship-graph-sync-routine');
const routineJob = require('../../scripts/run-relationship-graph-routine-job');
const review = require('../../scripts/review-relationship-candidate-labels');

// Peng 2026-10-20: the nightly reviews up to 10,000 generated labels. Every layer between the cron
// env and the review query clamps the limit, silently (parseNumber caps without an error), so each
// one must carry the same cap or 10,000 quietly becomes 5,000 somewhere on the way.
const NOW = new Date('2026-06-08T12:30:45.000Z');
const argAfter = (args, name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

test('the cron passes RELGRAPH_SYNC_REVIEW_LIMIT up to 10,000, and caps above it', () => {
  expect(argAfter(buildCronArgs({ RELGRAPH_SYNC_REVIEW_LIMIT: '10000' }, { now: NOW }).args, 'review-limit')).toBe('10000');
  expect(argAfter(buildCronArgs({ RELGRAPH_SYNC_REVIEW_LIMIT: '25000' }, { now: NOW }).args, 'review-limit')).toBe('10000');
});

test('the cron reviews the global backlog when scoping is off and the cutoff reaches back', () => {
  const { args } = buildCronArgs({ RELGRAPH_SYNC_REVIEW_LIMIT: '10000', RELGRAPH_SYNC_SCOPE_REVIEW_TO_BUILD: 'false',
    RELGRAPH_SYNC_CUTOFF: '2026-01-01T00:00:00Z' }, { now: NOW });
  expect(args).not.toContain('--scope-review-to-build-anchors');
  expect(argAfter(args, 'cutoff')).toBe('2026-01-01T00:00:00Z');
});

test('the sync routine keeps 10,000 and hands it to the routine job', () => {
  const options = syncRoutine.parseArgs(['--cutoff', '2026-06-08T00:00:00Z', '--external-product-ids', 'seed_1',
    '--review-limit', '10000', '--out-dir', '/tmp/relgraph-review-limit'], { now: NOW });
  expect(options.reviewLimit).toBe(10000);
  const routine = syncRoutine.buildSyncRoutineSteps(options).steps.find((step) => step.id === 'relationship_graph_routine');
  expect(argAfter(routine.args, 'review-limit')).toBe('10000');
  expect(syncRoutine.parseArgs(['--cutoff', '2026-06-08T00:00:00Z', '--external-product-ids', 'seed_1', '--review-limit', '25000'],
    { now: NOW }).reviewLimit).toBe(10000);
});

test('the routine job keeps 10,000 and passes it to the review step as --limit', () => {
  const options = routineJob.parseArgs(['--cutoff', '2026-06-01T00:00:00Z', '--review-limit', '10000', '--out-dir', '/tmp/relgraph-review-limit'],
    { now: NOW });
  expect(options.reviewLimit).toBe(10000);
  const step = routineJob.buildRoutineSteps(options).steps.find((s) => s.id === 'ai_review');
  expect(argAfter(step.args, 'limit')).toBe('10000');
  expect(routineJob.parseArgs(['--cutoff', '2026-06-01T00:00:00Z', '--review-limit', '25000'], { now: NOW }).reviewLimit).toBe(10000);
});

test('the review script accepts --limit up to 10,000, and caps above it', () => {
  expect(review.parseArgs(['--cutoff', '2026-06-01T00:00:00Z', '--limit', '10000']).limit).toBe(10000);
  expect(review.parseArgs(['--cutoff', '2026-06-01T00:00:00Z', '--limit', '25000']).limit).toBe(10000);
});
