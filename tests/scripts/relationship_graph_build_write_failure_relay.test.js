const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runRoutineJob, parseArgs, buildWriteFailureRelayLine, buildWriteFailureMetrics } = require('../../scripts/run-relationship-graph-routine-job');
const { extractRelationshipGraphRunRecord } = require('../../src/services/relationshipGraphRunLedger');

// The build is a piped child of the routine job, itself a piped child of the sync routine: its
// RELGRAPH_BUILD_WRITE_FAILED line and its write-failure counts would otherwise die with the
// container's /tmp (controller review of gw#2537).
const cutoff = '2026-01-01T00:00:00Z';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-write-relay-'));
const LINE = JSON.stringify({ severity: 'ERROR', message: 'RELGRAPH_BUILD_WRITE_FAILED', write_failed_count: 2, attempted_write_count: 40,
  write_integrity_violation_count: 1, write_failed_by_code: { '22P02': 1, 23505: 1 },
  samples: [{ edge_id: 'e1', anchor_ref: 'product:a', candidate_ref: 'product:b', relation_type: 'related_product', code: '23505' }] });
const BUILD_SUMMARY = { anchor_count: 3, edge_count: 38, rejected_count: 2, write_failed_count: 2, attempted_write_count: 40,
  write_integrity_violation_count: 1, write_failed_by_code: { '22P02': 1, 23505: 1 } };

test('the routine copies the build\'s write-failure counts and finds its line', async () => {
  const dir = temp();
  try {
    const options = parseArgs(['--cutoff', cutoff, '--skip-review', '--skip-validation', '--skip-serving-audit', '--skip-pba-sig-refresh', '--out-dir', dir]);
    const runner = async (_command, args) => {
      const out = args.indexOf('--out') >= 0 ? args[args.indexOf('--out') + 1] : null;
      if (out && /build/.test(out)) fs.writeFileSync(out, JSON.stringify({ summary: BUILD_SUMMARY, edges: [], rejected_edges: [] }));
      return { exitCode: 0, stdout: '', stderr: `other output\n${LINE}\nrelgraph evidence readiness: ok\n` };
    };
    const summary = await runRoutineJob(options, { runner, progressReader: async () => ({ servedEdges: 0, anchors: new Set() }) });
    expect(summary).toMatchObject({ build_write_failed_count: 2, build_attempted_write_count: 40, build_write_integrity_violation_count: 1,
      build_write_failed_by_code: { '22P02': 1, 23505: 1 } });
    expect(buildWriteFailureRelayLine(summary)).toBe(LINE);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no build report, nothing copied; no line, no relay', () => {
  expect(buildWriteFailureMetrics('/nonexistent/build.json')).toEqual({});
  expect(buildWriteFailureMetrics(null)).toEqual({});
  expect(buildWriteFailureRelayLine({ steps: [{ id: 'build', stderr_tail: 'relgraph evidence readiness: ok' }] })).toBe('');
  expect(buildWriteFailureRelayLine({})).toBe('');
});

test('the run ledger keeps the build\'s write failures', () => {
  const dir = temp();
  try {
    const buildPath = path.join(dir, 'build.json');
    fs.writeFileSync(buildPath, JSON.stringify({ summary: BUILD_SUMMARY }));
    const routinePath = path.join(dir, 'routine_summary.json');
    fs.writeFileSync(routinePath, JSON.stringify({ ok: false, artifacts: { build: buildPath } }));
    const record = extractRelationshipGraphRunRecord({ run_id: 'relgraph_sync_routine_w', ok: false, out_dir: dir, artifacts: { routine_summary: routinePath } });
    expect(record.summary.build_write_failures).toEqual({ write_failed_count: 2, attempted_write_count: 40, write_integrity_violation_count: 1,
      write_failed_by_code: { '22P02': 1, 23505: 1 } });
    expect(record).toMatchObject({ anchor_count: 3, edge_count: 38 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the routine job relays the line on its own stderr, before the readiness line', async () => {
  const { main } = require('../../scripts/run-relationship-graph-routine-job');
  const dir = temp();
  const writes = [];
  const spyErr = jest.spyOn(process.stderr, 'write').mockImplementation((c) => { writes.push(String(c)); return true; });
  const spyOut = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const runner = async (_command, args) => {
      const out = args.indexOf('--out') >= 0 ? args[args.indexOf('--out') + 1] : null;
      if (out && /build/.test(out)) fs.writeFileSync(out, JSON.stringify({ summary: BUILD_SUMMARY, edges: [], rejected_edges: [] }));
      return { exitCode: 0, stdout: '', stderr: `${LINE}\nrelgraph evidence readiness: unique_exact_listings 5\n` };
    };
    await main(['--cutoff', cutoff, '--skip-review', '--skip-validation', '--skip-serving-audit', '--skip-pba-sig-refresh', '--out-dir', dir],
      { runner, progressReader: async () => ({ servedEdges: 0, anchors: new Set() }) });
  } finally { spyErr.mockRestore(); spyOut.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
  const relayed = writes.join('').trim().split('\n');
  expect(relayed.slice(-2)).toEqual([LINE, 'relgraph evidence readiness: unique_exact_listings 5']);
});

test('the sync routine keeps the counts from the routine summary (and so the ledger summary)', async () => {
  const { runSyncRoutine, parseArgs: syncArgs } = require('../../scripts/run-relationship-graph-sync-routine');
  const outDir = temp();
  const recorded = [];
  try {
    const options = syncArgs(['--skip-review', '--select-hours', '24', '--out-dir', outDir], { now: new Date('2026-11-03T10:37:00Z') });
    const runner = async (_command, args) => {
      if (args[0].endsWith('run-relationship-graph-routine-job.js')) {
        const routineOut = args[args.indexOf('--out-dir') + 1];
        fs.mkdirSync(routineOut, { recursive: true });
        fs.writeFileSync(path.join(routineOut, 'routine_summary.json'), JSON.stringify({ ok: true, artifacts: {},
          build_write_failed_count: 2, build_attempted_write_count: 40, build_write_integrity_violation_count: 1,
          build_write_failed_by_code: { '22P02': 1, 23505: 1 } }));
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let summary;
    try {
      summary = await runSyncRoutine(options, { runner, now: new Date('2026-11-03T10:37:00Z'),
        progressReader: async () => ({ servedEdges: 0, anchors: new Set() }), ledgerRecorder: async (s) => { recorded.push(s); return { recorded: true }; } });
    } finally { spy.mockRestore(); }
    expect(summary).toMatchObject({ build_write_failed_count: 2, build_attempted_write_count: 40, build_write_integrity_violation_count: 1,
      build_write_failed_by_code: { '22P02': 1, 23505: 1 } });
    // The ledger keeps the whole sync summary (the recorder itself is off by default outside the cron).
    expect(extractRelationshipGraphRunRecord(summary).summary).toMatchObject({ build_write_failed_count: 2, build_write_integrity_violation_count: 1 });
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

// The sync routine keeps the routine job's stderr only as a tail inside its summary, so on a passing
// night (contained failures under the gate) the line never became a log entry of its own.
async function syncNight({ routineStderr = '', routine = {}, progressReader }) {
  const { runSyncRoutine, parseArgs: syncArgs } = require('../../scripts/run-relationship-graph-sync-routine');
  const outDir = temp();
  const writes = [];
  try {
    const options = syncArgs(['--skip-review', '--select-hours', '24', '--out-dir', outDir], { now: new Date('2026-11-05T10:37:00Z') });
    const runner = async (_command, args) => {
      if (args[0].endsWith('run-relationship-graph-routine-job.js')) {
        const routineOut = args[args.indexOf('--out-dir') + 1];
        fs.mkdirSync(routineOut, { recursive: true });
        fs.writeFileSync(path.join(routineOut, 'routine_summary.json'), JSON.stringify({ ok: true, artifacts: {}, ...routine }));
        return { exitCode: 0, stdout: '', stderr: routineStderr };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((c) => { writes.push(String(c)); return true; });
    let summary;
    try {
      summary = await runSyncRoutine(options, { runner, now: new Date('2026-11-05T10:37:00Z'),
        progressReader: progressReader || (async () => ({ servedEdges: 0, anchors: new Set() })), ledgerRecorder: async () => ({ recorded: true }) });
    } catch (error) {
      summary = error.summary;
    } finally { spy.mockRestore(); }
    const lines = writes.join('').split('\n').filter((line) => line.includes('RELGRAPH_BUILD_WRITE_FAILED'));
    return { summary, lines };
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
}

const COUNTS = { build_write_failed_count: 2, build_attempted_write_count: 40, build_write_integrity_violation_count: 1,
  build_write_failed_by_code: { '22P02': 1, 23505: 1 } };

test('on a passing night the sync routine re-emits the build line as its own log line', async () => {
  const { lines } = await syncNight({ routineStderr: `noise\n${LINE}\nrelgraph evidence readiness: ok\n`, routine: COUNTS });
  expect(lines).toEqual([LINE]);
});

test('a line the tail cut is replaced by a counts-only line from the routine summary', async () => {
  const { lines } = await syncNight({ routineStderr: `${LINE.slice(40)}\nrelgraph evidence readiness: ok\n`, routine: COUNTS });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toEqual({ severity: 'ERROR', message: 'RELGRAPH_BUILD_WRITE_FAILED', run_id: expect.any(String),
    write_failed_count: 2, attempted_write_count: 40, write_integrity_violation_count: 1, write_failed_by_code: { '22P02': 1, 23505: 1 },
    samples_omitted: true });
});

test('a contained night with no integrity violation is a WARNING, and no failures means no line', async () => {
  const warn = await syncNight({ routine: { ...COUNTS, build_write_integrity_violation_count: 0 } });
  expect(JSON.parse(warn.lines[0]).severity).toBe('WARNING');
  const clean = await syncNight({ routine: { build_write_failed_count: 0, build_attempted_write_count: 321 } });
  expect(clean.lines).toEqual([]);
});

test('a failing serving read no longer drops the build counts or the line', async () => {
  let calls = 0;
  const progressReader = async () => {
    calls += 1;
    if (calls > 1) throw new Error('serving read timed out');
    return { servedEdges: 0, anchors: new Set() };
  };
  const { summary, lines } = await syncNight({ routineStderr: `${LINE}\n`, routine: COUNTS, progressReader });
  expect(summary.serving_progress_error).toBe('serving read timed out');
  expect(summary).toMatchObject(COUNTS);
  expect(lines).toEqual([LINE]);
});
