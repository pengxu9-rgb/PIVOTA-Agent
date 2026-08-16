const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  APPLY_CONFIRM_TOKEN,
  acquirePostgresAdvisoryLock,
  buildRoutineSteps,
  buildLockPath,
  evaluateServingAuditThresholds,
  parseArgs,
  postgresAdvisoryLockParts,
  runCommand,
  runRoutineJob,
  startPostgresAdvisoryLockHeartbeat,
} = require('../../scripts/run-relationship-graph-routine-job');

const NOW = new Date('2026-06-08T00:00:00.000Z');
const CUTOFF = '2026-06-01T00:00:00Z';

describe('run-relationship-graph-routine-job', () => {
  test('parseArgs is dry-run and excludes dupe AI review by default', () => {
    const args = parseArgs([
      '--cutoff',
      CUTOFF,
      '--max-serving-suppressed-pct',
      '3.5',
      '--max-serving-suppressed-rows',
      '12',
      '--db-lock',
      '--db-lock-key',
      'relgraph:test',
      '--lock-stale-after-minutes',
      '180',
      '--step-timeout-minutes',
      '7',
      '--serving-audit-timeout-minutes',
      '12',
      '--db-lock-heartbeat-ms',
      '15000',
      '--skip-need-nodes',
      '--fail-on-serving-suppression-reasons',
      'ai_approved_dupe_quarantined,candidate_ref_unresolvable_nested_product_prefix',
    ], { now: NOW });

    expect(args.applyBuild).toBe(false);
    expect(args.applyReview).toBe(false);
    expect(args.reviewExcludeRelationTypes).toBe('dupe');
    expect(args.maxServingSuppressedPct).toBe(3.5);
    expect(args.maxServingSuppressedRows).toBe(12);
    expect(args.dbLock).toBe(true);
    expect(args.dbLockKey).toBe('relgraph:test');
    expect(args.lockStaleAfterMs).toBe(180 * 60 * 1000);
    expect(args.stepTimeoutMs).toBe(7 * 60 * 1000);
    expect(args.servingAuditTimeoutMs).toBe(12 * 60 * 1000);
    expect(args.dbLockHeartbeatMs).toBe(15000);
    expect(args.skipNeedNodes).toBe(true);
    expect(args.failOnServingSuppressionReasons).toEqual([
      'ai_approved_dupe_quarantined',
      'candidate_ref_unresolvable_nested_product_prefix',
    ]);
    expect(args.outDir).toContain('relationship_graph_routine_20260608T00000');
  });

  test('write mode requires an explicit routine confirmation token', () => {
    expect(() => parseArgs(['--cutoff', CUTOFF, '--apply-build'], { now: NOW })).toThrow(
      /write-mode routine jobs require/,
    );

    const args = parseArgs([
      '--cutoff',
      CUTOFF,
      '--apply-build',
      '--apply-review',
      '--confirm',
      APPLY_CONFIRM_TOKEN,
    ], { now: NOW });

    expect(args.applyBuild).toBe(true);
    expect(args.applyReview).toBe(true);
  });

  test('buildRoutineSteps wires the production sequence and guarded review flags', () => {
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--market',
      'US',
      '--limit',
      '12',
      '--review-limit',
      '7',
      '--affected-products-file',
      '/tmp/affected-products.json',
      '--out-dir',
      '/tmp/relgraph-routine-test',
    ], { now: NOW });

    const { steps } = buildRoutineSteps(options);

    expect(steps.map((step) => step.id)).toEqual([
      'pba_sig_refresh',
      'build',
      'preflight_validation',
      'ai_review',
      'serving_guard_audit',
    ]);
    const refreshArgs = steps[0].args.join(' ');
    expect(refreshArgs).toContain('refresh-product-beauty-attribute-sig-ids.js');
    expect(refreshArgs).toContain('--affected-products-file /tmp/affected-products.json');
    expect(refreshArgs).not.toContain('--apply');

    const buildArgs = steps[1].args.join(' ');
    expect(buildArgs).toContain('build-product-relationship-graph.js');
    expect(buildArgs).toContain('--require-anchors');
    expect(buildArgs).toContain('--affected-products-file /tmp/affected-products.json');
    expect(buildArgs).not.toContain('--skip-need-nodes');
    expect(buildArgs).not.toContain('--apply');

    const reviewArgs = steps[3].args.join(' ');
    expect(reviewArgs).toContain('review-relationship-candidate-labels.js');
    expect(reviewArgs).toContain('--exclude-relation-types dupe');
    expect(reviewArgs).not.toContain('--allow-dupe-ai-approval');
    expect(reviewArgs).not.toContain('--apply');
  });

  test('build write mode applies PBA sig refresh under the routine confirmation', () => {
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--affected-products-file',
      '/tmp/affected-products.json',
      '--apply-build',
      '--confirm',
      APPLY_CONFIRM_TOKEN,
      '--out-dir',
      '/tmp/relgraph-routine-test',
    ], { now: NOW });

    const { steps } = buildRoutineSteps(options);
    const refreshArgs = steps[0].args.join(' ');
    expect(refreshArgs).toContain('--apply');
    expect(refreshArgs).toContain('--confirm REFRESH_PBA_SIG_IDS');
  });

  // The scheduled routine runs with --allow-empty-build because a quiet day
  // selects zero affected products; the sig refresh reads that same manifest
  // and must tolerate the same emptiness, or the job dies at its first step
  // (production 2026-08-16T10:37Z: missing_pba_sig_refresh_filter).
  test('--allow-empty-build extends the empty tolerance to the PBA sig refresh step', () => {
    const argv = [
      '--cutoff',
      CUTOFF,
      '--affected-products-file',
      '/tmp/affected-products.json',
      '--out-dir',
      '/tmp/relgraph-routine-test',
    ];

    const strict = buildRoutineSteps(parseArgs(argv, { now: NOW })).steps;
    expect(strict[0].id).toBe('pba_sig_refresh');
    expect(strict[0].args).not.toContain('--allow-empty-filter');
    expect(strict[1].args).toContain('--require-anchors');

    const lenient = buildRoutineSteps(parseArgs([...argv, '--allow-empty-build'], { now: NOW })).steps;
    expect(lenient[0].id).toBe('pba_sig_refresh');
    expect(lenient[0].args).toContain('--allow-empty-filter');
    expect(lenient[1].args).not.toContain('--require-anchors');
  });

  test('buildRoutineSteps does not run PBA sig refresh without refresh-compatible filters', () => {
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--affected-refs',
      'product:seed_123,content_key:brand:sku',
      '--content-keys-file',
      '/tmp/content-keys.txt',
      '--out-dir',
      '/tmp/relgraph-routine-test',
    ], { now: NOW });

    const { steps } = buildRoutineSteps(options);

    expect(steps.map((step) => step.id)).toEqual([
      'build',
      'preflight_validation',
      'ai_review',
      'serving_guard_audit',
    ]);
    const buildArgs = steps[0].args.join(' ');
    expect(buildArgs).toContain('--affected-refs product:seed_123,content_key:brand:sku');
    expect(buildArgs).toContain('--content-keys-file /tmp/content-keys.txt');
  });

  test('serving audit gets a separate timeout floor from short child-step canaries', () => {
    const options = parseArgs([
      '--skip-review',
      '--skip-build',
      '--skip-validation',
      '--step-timeout-minutes',
      '5',
      '--out-dir',
      '/tmp/relgraph-routine-test',
    ], { now: NOW });

    const { steps } = buildRoutineSteps(options);

    expect(options.stepTimeoutMs).toBe(5 * 60 * 1000);
    expect(options.servingAuditTimeoutMs).toBe(10 * 60 * 1000);
    expect(steps).toEqual([
      expect.objectContaining({
        id: 'serving_guard_audit',
        timeoutMs: 10 * 60 * 1000,
      }),
    ]);
  });

  test('buildRoutineSteps can suppress need nodes for scoped canaries', () => {
    const options = parseArgs([
      '--skip-review',
      '--market',
      'US',
      '--limit',
      '1',
      '--affected-refs',
      'product:10064558194985',
      '--skip-need-nodes',
      '--out-dir',
      '/tmp/relgraph-canary',
    ], { now: NOW });

    const { steps } = buildRoutineSteps(options);
    const buildArgs = steps[0].args.join(' ');

    expect(options.skipNeedNodes).toBe(true);
    expect(buildArgs).toContain('--affected-refs product:10064558194985');
    expect(buildArgs).toContain('--skip-need-nodes');
  });

  test('runRoutineJob records command results and writes a summary manifest', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-routine-'));
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--out-dir',
      outDir,
      '--skip-validation',
    ], { now: NOW });
    const runner = jest.fn(async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }));

    const summary = await runRoutineJob(options, { runner, now: NOW });

    expect(summary.ok).toBe(true);
    expect(summary.steps.map((step) => step.id)).toEqual(['build', 'ai_review', 'serving_guard_audit']);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(path.join(outDir, 'routine_summary.json'))).toBe(true);
  });

  test('runRoutineJob acquires and releases a single-flight lock', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-routine-'));
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--out-dir',
      outDir,
      '--skip-validation',
      '--skip-serving-audit',
    ], { now: NOW });
    const lockDir = buildLockPath(options);
    let sawLockDuringRun = false;
    const runner = jest.fn(async () => {
      sawLockDuringRun = fs.existsSync(path.join(lockDir, 'owner.json'));
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
    });

    const summary = await runRoutineJob(options, { runner, now: NOW });

    expect(summary.ok).toBe(true);
    expect(summary.lock_dir).toBe(lockDir);
    expect(sawLockDuringRun).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test('runRoutineJob rejects when the single-flight lock is already held', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-routine-'));
    const lockDir = path.join(outDir, 'held.lock');
    fs.mkdirSync(lockDir);
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--out-dir',
      outDir,
      '--lock-dir',
      lockDir,
      '--skip-validation',
      '--skip-serving-audit',
    ], { now: NOW });
    const runner = jest.fn(async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }));

    await expect(runRoutineJob(options, { runner, now: NOW })).rejects.toMatchObject({
      code: 'ROUTINE_LOCK_HELD',
      lock_dir: lockDir,
    });
    expect(runner).not.toHaveBeenCalled();
  });

  test('runRoutineJob replaces a stale relationship graph local lock when explicitly allowed', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-routine-'));
    const lockDir = path.join(outDir, 'stale.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify({
      run_id: 'relgraph_routine_20260601T00000',
      started_at: '2026-06-01T00:00:00.000Z',
      pid: 12345,
    })}\n`, 'utf8');
    let replacementOwner = null;
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--out-dir',
      outDir,
      '--lock-dir',
      lockDir,
      '--lock-stale-after-minutes',
      '60',
      '--skip-validation',
      '--skip-serving-audit',
    ], { now: NOW });
    const runner = jest.fn(async () => {
      replacementOwner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
    });

    const summary = await runRoutineJob(options, { runner, now: NOW });

    expect(summary.ok).toBe(true);
    expect(replacementOwner).toEqual(expect.objectContaining({
      run_id: 'relgraph_routine_20260608T000000',
      started_at: NOW.toISOString(),
    }));
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test('runRoutineJob can deliberately skip the local lock', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-routine-'));
    const lockDir = path.join(outDir, 'held.lock');
    fs.mkdirSync(lockDir);
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--out-dir',
      outDir,
      '--lock-dir',
      lockDir,
      '--skip-lock',
      '--skip-validation',
      '--skip-serving-audit',
    ], { now: NOW });
    const runner = jest.fn(async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }));

    const summary = await runRoutineJob(options, { runner, now: NOW });

    expect(summary.ok).toBe(true);
    expect(summary.lock_acquired).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  test('postgresAdvisoryLockParts hashes a stable two-part key', () => {
    const first = postgresAdvisoryLockParts('relgraph:test');
    const second = postgresAdvisoryLockParts('relgraph:test');
    const other = postgresAdvisoryLockParts('relgraph:other');

    expect(first).toEqual(second);
    expect(first.lock_key).toBe('relgraph:test');
    expect(Number.isInteger(first.key_part_1)).toBe(true);
    expect(Number.isInteger(first.key_part_2)).toBe(true);
    expect([first.key_part_1, first.key_part_2]).not.toEqual([other.key_part_1, other.key_part_2]);
  });

  test('acquirePostgresAdvisoryLock uses try-lock and releases the same key parts', async () => {
    const queries = [];
    const client = {
      query: jest.fn(async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ released: true }] };
        throw new Error(`unexpected sql: ${sql}`);
      }),
    };

    const acquired = await acquirePostgresAdvisoryLock(client, 'relgraph:test');
    await acquired.release();

    expect(acquired.lock.acquired).toBe(true);
    expect(queries).toEqual([
      expect.objectContaining({ sql: expect.stringContaining('pg_try_advisory_lock') }),
      expect.objectContaining({ sql: expect.stringContaining('pg_advisory_unlock') }),
    ]);
    expect(queries[1].params).toEqual(queries[0].params);
  });

  test('startPostgresAdvisoryLockHeartbeat keeps the advisory-lock client active', async () => {
    const client = {
      query: jest.fn(async () => ({ rows: [{ ok: true }] })),
    };

    const heartbeat = startPostgresAdvisoryLockHeartbeat(client, { intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await heartbeat.stop();

    expect(client.query).toHaveBeenCalledWith(
      'SELECT 1 AS relationship_graph_routine_db_lock_keepalive',
    );
  });

  test('runRoutineJob executes under a Postgres advisory lock when requested', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-routine-'));
    const client = {
      query: jest.fn(async (sql) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ released: true }] };
        throw new Error(`unexpected sql: ${sql}`);
      }),
    };
    const withDbClient = jest.fn(async (fn) => fn(client));
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--out-dir',
      outDir,
      '--skip-validation',
      '--skip-serving-audit',
      '--db-lock',
      '--db-lock-key',
      'relgraph:test',
    ], { now: NOW });
    const runner = jest.fn(async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }));

    const summary = await runRoutineJob(options, { runner, now: NOW, withDbClient });

    expect(summary.ok).toBe(true);
    expect(summary.db_lock).toEqual(expect.objectContaining({
      requested: true,
      acquired: true,
      lock_key: 'relgraph:test',
    }));
    expect(withDbClient).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toContain('pg_try_advisory_lock');
    expect(client.query.mock.calls.at(-1)[0]).toContain('pg_advisory_unlock');
    expect(runner).toHaveBeenCalled();
  });

  test('runRoutineJob passes the child step timeout to the runner', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-routine-'));
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--out-dir',
      outDir,
      '--skip-validation',
      '--skip-serving-audit',
      '--step-timeout-ms',
      '1234',
    ], { now: NOW });
    const runner = jest.fn(async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }));

    await runRoutineJob(options, { runner, now: NOW });

    expect(runner).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 1234 }),
    );
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'routine_summary.json'), 'utf8'));
    expect(summary.options.step_timeout_ms).toBe(1234);
    expect(summary.steps[0]).toEqual(expect.objectContaining({
      timed_out: false,
      timeout_ms: 1234,
    }));
  });

  test('runRoutineJob passes the serving audit timeout override to that child step', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-routine-'));
    const options = parseArgs([
      '--skip-review',
      '--skip-build',
      '--skip-validation',
      '--out-dir',
      outDir,
      '--step-timeout-ms',
      '1234',
      '--serving-audit-timeout-ms',
      '5678',
    ], { now: NOW });
    const runner = jest.fn(async (_command, args) => {
      const outIdx = args.indexOf('--out');
      const artifact = args[outIdx + 1];
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, `${JSON.stringify({ total_rows: 0, suppressed_rows: 0, suppressed_pct: 0 })}\n`);
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
    });

    await runRoutineJob(options, { runner, now: NOW });

    expect(runner).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 5678 }),
    );
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'routine_summary.json'), 'utf8'));
    expect(summary.options.step_timeout_ms).toBe(1234);
    expect(summary.options.serving_audit_timeout_ms).toBe(5678);
    expect(summary.steps[0]).toEqual(expect.objectContaining({
      id: 'serving_guard_audit',
      timeout_ms: 5678,
    }));
  });

  test('runCommand terminates a timed-out child step', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 1000)'],
      { timeoutMs: 50 },
    );

    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain('step timed out after 50ms');
  });

  test('runRoutineJob fails before steps when Postgres advisory lock is held', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-routine-'));
    const client = {
      query: jest.fn(async (sql) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: false }] };
        throw new Error(`unexpected sql: ${sql}`);
      }),
    };
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--out-dir',
      outDir,
      '--skip-validation',
      '--skip-serving-audit',
      '--db-lock',
      '--db-lock-key',
      'relgraph:test',
    ], { now: NOW });
    const runner = jest.fn(async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }));

    await expect(runRoutineJob(options, {
      runner,
      now: NOW,
      withDbClient: async (fn) => fn(client),
    })).rejects.toMatchObject({
      code: 'ROUTINE_DB_LOCK_HELD',
      lock_key: 'relgraph:test',
    });

    expect(runner).not.toHaveBeenCalled();
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'routine_summary.json'), 'utf8'));
    expect(summary.ok).toBe(false);
    expect(summary.failed_step).toBe('db_advisory_lock');
    expect(summary.db_lock).toEqual(expect.objectContaining({
      requested: true,
      acquired: false,
      error_code: 'ROUTINE_DB_LOCK_HELD',
    }));
  });

  test('evaluateServingAuditThresholds reports row and percent violations', () => {
    const violations = evaluateServingAuditThresholds(
      {
        total_rows: 100,
        suppressed_rows: 8,
        suppressed_pct: 8,
        by_reason: {
          ai_approved_dupe_quarantined: 1,
          related_product_same_family_variant: 2,
        },
      },
      {
        maxServingSuppressedRows: 5,
        maxServingSuppressedPct: 2.5,
        failOnServingSuppressionReasons: ['ai_approved_dupe_quarantined'],
      },
    );

    expect(violations).toEqual([
      expect.objectContaining({ metric: 'suppressed_rows', observed: 8, max: 5 }),
      expect.objectContaining({ metric: 'suppressed_pct', observed: 8, max: 2.5 }),
      expect.objectContaining({
        metric: 'suppression_reason',
        reason: 'ai_approved_dupe_quarantined',
        observed: 1,
        max: 0,
      }),
    ]);
  });

  test('runRoutineJob fails closed when serving audit thresholds are exceeded', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-routine-'));
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--out-dir',
      outDir,
      '--skip-build',
      '--skip-validation',
      '--skip-review',
      '--max-serving-suppressed-pct',
      '1',
    ], { now: NOW });
    const runner = jest.fn(async (_command, args) => {
      const outIdx = args.indexOf('--out');
      const artifact = args[outIdx + 1];
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, `${JSON.stringify({
        total_rows: 100,
        safe_rows: 95,
        suppressed_rows: 5,
        suppressed_pct: 5,
      })}\n`, 'utf8');
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
    });

    await expect(runRoutineJob(options, { runner, now: NOW })).rejects.toMatchObject({
      code: 'SERVING_AUDIT_THRESHOLD_VIOLATION',
    });

    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'routine_summary.json'), 'utf8'));
    expect(summary.ok).toBe(false);
    expect(summary.failed_step).toBe('serving_guard_audit_thresholds');
    expect(summary.steps[0].threshold_violations).toEqual([
      expect.objectContaining({ metric: 'suppressed_pct', observed: 5, max: 1 }),
    ]);
  });
});
