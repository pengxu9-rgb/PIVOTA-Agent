jest.mock('../../src/services/relationshipGraphServingProgress', () => ({
  ...jest.requireActual('../../src/services/relationshipGraphServingProgress'),
  readServingSnapshot: jest.fn(async () => ({ servedEdges: 0, anchors: new Set() })),
  readReviewMetrics: jest.fn(() => ({ reviewed_count: 0, approved_count: 0, review_error_count: 0, review_error_rate: 0, guard_blocked_count: 0 })),
}));

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const routineJob = require('../../scripts/run-relationship-graph-routine-job');
const syncRoutine = require('../../scripts/run-relationship-graph-sync-routine');

// The build's `relgraph evidence readiness:` line must survive two layers: the routine job keeps a
// step's stderr only in its /tmp summary, and the sync routine (which the cron runs and whose
// summary reaches the logs and run ledger) records only the routine job's own stderr tail. On
// 2026-10-16 the line was absent from both after the build first printed it.
const NOW = new Date('2026-06-08T00:00:00.000Z');
const READINESS = 'relgraph evidence readiness: unique_exact_listings 487 (sampled anchors 100, pairs 812, products limit 500)';
const tempRoots = [];
const tempDir = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempRoots.push(dir); return dir; };
afterAll(() => tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
afterEach(() => jest.restoreAllMocks());

// A stand-in for the routine job's children: the build prints the readiness line followed by
// nothing; the serving audit (which runs later) writes its artifact and a warning of its own.
function routineRunner({ buildStderr = `some build warning\n${READINESS}\n`, failReview = false } = {}) {
  return jest.fn(async (_command, args) => {
    const script = String(args[0] || '');
    if (script.endsWith('build-product-relationship-graph.js')) return { exitCode: 0, stdout: '{"anchor_count":2}', stderr: buildStderr };
    if (script.endsWith('review-product-relationship-graph-labels.js') && failReview) return { exitCode: 1, stdout: '', stderr: 'review exploded' };
    if (script.endsWith('audit-relationship-graph-serving-guard.js')) {
      const out = args[args.indexOf('--out') + 1];
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ total_rows: 0, suppressed_rows: 0, suppressed_pct: 0 }));
    }
    return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
  });
}

async function routineJobStderr(deps, argv) {
  let stderr = '';
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
  try {
    await routineJob.main(argv, deps);
  } finally {
    spy.mockRestore();
  }
  return stderr;
}

const routineArgv = (outDir) => ['--cutoff', '2026-06-01T00:00:00Z', '--out-dir', outDir, '--skip-validation'];

test('the routine job ends its stderr with the build step\'s readiness line', async () => {
  const stderr = await routineJobStderr({ runner: routineRunner(), now: NOW }, routineArgv(tempDir('relgraph-relay-routine-')));
  expect(stderr.trimEnd().split('\n').pop()).toBe(READINESS);
});

test('end to end: the sync routine records the readiness line in its routine step stderr_tail', async () => {
  // Layer 1: the routine job, as the sync routine's child.
  const routineStderr = await routineJobStderr({ runner: routineRunner(), now: NOW }, routineArgv(tempDir('relgraph-relay-routine-')));
  // Layer 2: the sync routine, whose child (the routine job) wrote exactly that stderr.
  const options = syncRoutine.parseArgs(['--cutoff', '2026-06-08T00:00:00Z', '--external-product-ids', 'seed_1',
    '--out-dir', tempDir('relgraph-relay-sync-')], { now: NOW });
  const runner = jest.fn(async (_command, args) => (String(args.join(' ')).includes('run-relationship-graph-routine-job')
    ? { exitCode: 0, stdout: '{"ok":true}', stderr: routineStderr } : { exitCode: 0, stdout: '{"ok":true}', stderr: '' }));
  const summary = await syncRoutine.runSyncRoutine(options, { runner, now: NOW });
  const step = summary.steps.find((record) => record.id === 'relationship_graph_routine');
  expect(step.stderr_tail.trimEnd().split('\n').pop()).toBe(READINESS);
});

test('only the last readiness line is relayed, and nothing when the build printed none', async () => {
  const twice = await routineJobStderr({ runner: routineRunner({ buildStderr: `${READINESS.replace('487', '1')}\n${READINESS}\n` }), now: NOW },
    routineArgv(tempDir('relgraph-relay-routine-')));
  expect(twice.match(/relgraph evidence readiness:/g)).toHaveLength(1);
  expect(twice.trimEnd().split('\n').pop()).toBe(READINESS);
  const none = await routineJobStderr({ runner: routineRunner({ buildStderr: 'no readiness here\n' }), now: NOW },
    routineArgv(tempDir('relgraph-relay-routine-')));
  expect(none).not.toMatch(/relgraph evidence readiness:/);
});

test('evidenceReadinessRelayLine reads the build step only', () => {
  expect(routineJob.evidenceReadinessRelayLine({ steps: [{ id: 'build', stderr_tail: `x\n${READINESS}\ny\n` }] })).toBe(READINESS);
  expect(routineJob.evidenceReadinessRelayLine({ steps: [{ id: 'ai_review', stderr_tail: `${READINESS}\n` }] })).toBe('');
  expect(routineJob.evidenceReadinessRelayLine(null)).toBe('');
  expect(routineJob.evidenceReadinessRelayLine({ steps: [{ id: 'build', stderr_tail: `${READINESS}\n` }], failed_step: 'ai_review' })).toBe(READINESS);
});
