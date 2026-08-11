const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { APPLY_CONFIRM_TOKEN: ROUTINE_CONFIRM_TOKEN } = require('../../scripts/run-relationship-graph-routine-job');
const { APPLY_CONFIRM_TOKEN: RENEWAL_CONFIRM_TOKEN } = require('../../scripts/renew-relationship-ai-approved-labels');
const {
  DEFAULT_FAIL_REASONS,
  SYNC_CONFIRM_TOKEN,
  WRAPPER_CONFIRM_TOKEN,
  buildSyncRoutineSteps,
  formatRoutineFailure,
  parseArgs,
  runSyncRoutine,
} = require('../../scripts/run-relationship-graph-sync-routine');

const NOW = new Date('2026-06-08T00:00:00.000Z');
const CUTOFF = '2026-06-08T00:00:00Z';

describe('run-relationship-graph-sync-routine', () => {
  test('parseArgs defaults to dry-run with production safety gates', () => {
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--external-product-ids',
      'seed_1,seed_2',
    ], { now: NOW, cwd: '/tmp/pivota' });

    expect(options.applySync).toBe(false);
    expect(options.applyBuild).toBe(false);
    expect(options.applyReview).toBe(false);
    expect(options.applyRenewal).toBe(false);
    expect(options.skipRenewal).toBe(false);
    expect(options.renewalWindowDays).toBe(14);
    expect(options.dbLock).toBe(true);
    expect(options.lockStaleAfterMinutes).toBe(180);
    expect(options.dbLockHeartbeatMs).toBe(30000);
    expect(options.stepTimeoutMinutes).toBe(20);
    expect(options.stepTimeoutMs).toBe(0);
    expect(options.skipNeedNodes).toBe(false);
    expect(options.maxServingSuppressedPct).toBe(1);
    expect(options.maxServingSuppressedRows).toBe(25);
    expect(options.failOnServingSuppressionReasons).toEqual(DEFAULT_FAIL_REASONS);
    expect(options.recordRunLedger).toBe(false);
    expect(options.affectedProductsFile).toBe('/tmp/pivota/reports/product_relationship_graph/sync_routine_20260608T000000/affected-products.json');
  });

  test('parseArgs requires a cutoff unless review is skipped', () => {
    expect(() => parseArgs(['--external-product-ids', 'seed_1'], { now: NOW })).toThrow(/--cutoff is required/);

    const options = parseArgs([
      '--skip-review',
      '--external-product-ids',
      'seed_1',
    ], { now: NOW });

    expect(options.skipReview).toBe(true);
    expect(options.cutoff).toBe('');
  });

  test('parseArgs rejects ambiguous affected manifest and external ID inputs', () => {
    expect(() => parseArgs([
      '--cutoff',
      CUTOFF,
      '--affected-products-file',
      '/tmp/affected-products.json',
      '--external-product-ids',
      'seed_1',
    ], { now: NOW })).toThrow(/mutually exclusive/);
  });

  test('parseArgs accepts read-only selector mode for scheduled routines', () => {
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--select-hours',
      '24',
      '--select-limit',
      '25',
      '--allow-empty-selection',
      '--allow-empty-build',
    ], { now: NOW, cwd: '/tmp/pivota' });

    expect(options.usesSelector).toBe(true);
    expect(options.selectUpdatedSince).toBe('2026-06-07T00:00:00.000Z');
    expect(options.selectSources).toEqual(['catalog_products', 'external_product_seeds']);
    expect(options.selectLimit).toBe(25);
    expect(options.allowEmptySelection).toBe(true);
    expect(options.allowEmptyBuild).toBe(true);
  });

  test('parseArgs accepts run ledger recording flags', () => {
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--select-updated-since',
      '2026-06-07T00:00:00Z',
      '--record-run-ledger',
      '--run-trigger',
      'railway_cron',
      '--run-ledger-fail-closed',
    ], { now: NOW, cwd: '/tmp/pivota' });

    expect(options.recordRunLedger).toBe(true);
    expect(options.runTrigger).toBe('railway_cron');
    expect(options.runLedgerFailClosed).toBe(true);
  });

  test('parseArgs rejects selector mode combined with catalog sync apply', () => {
    expect(() => parseArgs([
      '--cutoff',
      CUTOFF,
      '--select-updated-since',
      '2026-06-07T00:00:00Z',
      '--apply-sync',
      '--confirm',
      WRAPPER_CONFIRM_TOKEN,
    ], { now: NOW })).toThrow(/apply-sync requires explicit external product ID inputs/);
  });

  test('write modes require wrapper confirmation and block graph writes after dry-run sync', () => {
    expect(() => parseArgs([
      '--cutoff',
      CUTOFF,
      '--external-product-ids',
      'seed_1',
      '--apply-sync',
    ], { now: NOW })).toThrow(/write-mode sync routine jobs require/);

    expect(() => parseArgs([
      '--cutoff',
      CUTOFF,
      '--external-product-ids',
      'seed_1',
      '--apply-build',
      '--confirm',
      WRAPPER_CONFIRM_TOKEN,
    ], { now: NOW })).toThrow(/cannot follow a dry-run catalog sync/);
  });

  test('buildSyncRoutineSteps wires dry-run catalog sync and guarded routine defaults', () => {
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--external-product-ids',
      'seed_1,seed_2',
      '--out-dir',
      '/tmp/relgraph-sync-routine',
      '--step-timeout-minutes',
      '9',
      '--db-lock-heartbeat-ms',
      '15000',
    ], { now: NOW });

    const { steps, artifacts } = buildSyncRoutineSteps(options);

    expect(steps.map((step) => step.id)).toEqual(['ai_approval_renewal', 'catalog_sync', 'relationship_graph_routine']);
    expect(artifacts.affected_products).toBe('/tmp/relgraph-sync-routine/affected-products.json');
    expect(artifacts.ai_renewal).toBe('/tmp/relgraph-sync-routine/ai_renewal.json');

    const renewalArgs = steps[0].args.join(' ');
    expect(renewalArgs).toContain('renew-relationship-ai-approved-labels.js');
    expect(renewalArgs).toContain('--window-days 14');
    expect(renewalArgs).not.toContain('--apply');
    // Renewal must be non-fatal and timeboxed so it can never take down the routine.
    expect(steps[0].optional).toBe(true);
    expect(steps[0].timeoutMs).toBe(9 * 60 * 1000);

    const syncArgs = steps[1].args.join(' ');
    expect(syncArgs).toContain('sync-external-seeds-to-catalog.cjs');
    expect(syncArgs).toContain('--external-product-ids seed_1,seed_2');
    expect(syncArgs).toContain('--affected-products-out /tmp/relgraph-sync-routine/affected-products.json');
    expect(syncArgs).toContain('--dry-run');
    expect(syncArgs).not.toContain('--apply');

    const routineArgs = steps[2].args.join(' ');
    expect(routineArgs).toContain('run-relationship-graph-routine-job.js');
    expect(routineArgs).toContain('--affected-products-file /tmp/relgraph-sync-routine/affected-products.json');
    expect(routineArgs).toContain('--db-lock');
    expect(routineArgs).toContain('--db-lock-heartbeat-ms 15000');
    expect(routineArgs).toContain('--lock-stale-after-minutes 180');
    expect(routineArgs).toContain('--step-timeout-minutes 9');
    expect(routineArgs).toContain('--max-serving-suppressed-pct 1');
    expect(routineArgs).toContain('--max-serving-suppressed-rows 25');
    expect(routineArgs).toContain(`--fail-on-serving-suppression-reasons ${DEFAULT_FAIL_REASONS.join(',')}`);
    expect(routineArgs).toContain('--cutoff 2026-06-08T00:00:00Z');
    expect(routineArgs).not.toContain('--apply-build');
    expect(routineArgs).not.toContain('--skip-need-nodes');
    expect(routineArgs).not.toContain('--confirm');
  });

  test('buildSyncRoutineSteps passes skip-need-nodes into the guarded routine', () => {
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--affected-products-file',
      '/tmp/affected-products.json',
      '--skip-need-nodes',
    ], { now: NOW });

    const { steps } = buildSyncRoutineSteps(options);
    const routineArgs = steps.find((step) => step.id === 'relationship_graph_routine').args.join(' ');

    expect(options.skipNeedNodes).toBe(true);
    expect(routineArgs).toContain('--skip-need-nodes');
  });

  test('buildSyncRoutineSteps wires selector before the guarded routine', () => {
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--select-updated-since',
      '2026-06-07T00:00:00Z',
      '--select-sources',
      'catalog_products',
      '--select-limit',
      '50',
      '--allow-empty-selection',
      '--allow-empty-build',
      '--out-dir',
      '/tmp/relgraph-sync-routine',
      '--step-timeout-ms',
      '2500',
    ], { now: NOW });

    const { steps, artifacts } = buildSyncRoutineSteps(options);

    expect(steps.map((step) => step.id)).toEqual(['ai_approval_renewal', 'affected_product_selector', 'relationship_graph_routine']);
    expect(artifacts.affected_product_selector).toBe('/tmp/relgraph-sync-routine/affected-products.json');
    expect(artifacts.catalog_sync).toBeNull();

    const selectorArgs = steps[1].args.join(' ');
    expect(selectorArgs).toContain('select-relationship-graph-affected-products.js');
    expect(selectorArgs).toContain('--updated-since 2026-06-07T00:00:00Z');
    expect(selectorArgs).toContain('--sources catalog_products');
    expect(selectorArgs).toContain('--limit 50');
    expect(selectorArgs).toContain('--allow-empty-selection');

    const routineArgs = steps[2].args.join(' ');
    expect(routineArgs).toContain('--affected-products-file /tmp/relgraph-sync-routine/affected-products.json');
    expect(routineArgs).toContain('--step-timeout-ms 2500');
    expect(routineArgs).toContain('--allow-empty-build');
    expect(routineArgs).toContain('--db-lock');
  });

  test('existing affected manifest skips sync and passes routine apply confirmation', () => {
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--affected-products-file',
      '/tmp/affected-products.json',
      '--apply-build',
      '--confirm',
      WRAPPER_CONFIRM_TOKEN,
    ], { now: NOW });

    const { steps } = buildSyncRoutineSteps(options);

    expect(steps.map((step) => step.id)).toEqual(['ai_approval_renewal', 'relationship_graph_routine']);
    const routineArgs = steps[1].args.join(' ');
    expect(routineArgs).toContain('--affected-products-file /tmp/affected-products.json');
    expect(routineArgs).toContain('--apply-build');
    expect(routineArgs).toContain(`--confirm ${ROUTINE_CONFIRM_TOKEN}`);
  });

  test('apply sync passes the catalog sync confirmation token before routine apply', () => {
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--external-product-ids',
      'seed_1',
      '--apply-sync',
      '--apply-build',
      '--confirm',
      WRAPPER_CONFIRM_TOKEN,
    ], { now: NOW });

    const { steps } = buildSyncRoutineSteps(options);

    const syncArgs = steps.find((step) => step.id === 'catalog_sync').args.join(' ');
    expect(syncArgs).toContain('--apply');
    expect(syncArgs).toContain(`--confirm ${SYNC_CONFIRM_TOKEN}`);

    const routineArgs = steps.find((step) => step.id === 'relationship_graph_routine').args.join(' ');
    expect(routineArgs).toContain('--apply-build');
    expect(routineArgs).toContain(`--confirm ${ROUTINE_CONFIRM_TOKEN}`);
  });

  test('apply-renewal requires wrapper confirmation and passes the renewal confirm token', () => {
    expect(() => parseArgs([
      '--cutoff',
      CUTOFF,
      '--external-product-ids',
      'seed_1',
      '--apply-renewal',
    ], { now: NOW })).toThrow(/write-mode sync routine jobs require/);

    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--external-product-ids',
      'seed_1',
      '--apply-renewal',
      '--renewal-window-days',
      '21',
      '--confirm',
      WRAPPER_CONFIRM_TOKEN,
    ], { now: NOW });

    const { steps } = buildSyncRoutineSteps(options);
    const renewal = steps.find((step) => step.id === 'ai_approval_renewal');
    const renewalArgs = renewal.args.join(' ');
    expect(renewalArgs).toContain('--window-days 21');
    expect(renewalArgs).toContain('--apply');
    expect(renewalArgs).toContain(`--confirm ${RENEWAL_CONFIRM_TOKEN}`);

    // Renewal apply never leaks into build/review apply.
    const routineArgs = steps.find((step) => step.id === 'relationship_graph_routine').args.join(' ');
    expect(routineArgs).not.toContain('--apply-build');
    expect(routineArgs).not.toContain('--apply-review');
  });

  test('skip-renewal removes the renewal step and artifact', () => {
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--external-product-ids',
      'seed_1',
      '--skip-renewal',
    ], { now: NOW });

    const { steps, artifacts } = buildSyncRoutineSteps(options);
    expect(steps.map((step) => step.id)).toEqual(['catalog_sync', 'relationship_graph_routine']);
    expect(artifacts.ai_renewal).toBeNull();
  });

  test('runSyncRoutine records steps and writes a summary artifact', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-sync-routine-'));
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--external-product-ids',
      'seed_1',
      '--out-dir',
      outDir,
    ], { now: NOW });
    const runner = jest.fn(async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }));

    const summary = await runSyncRoutine(options, { runner, now: NOW });

    expect(summary.ok).toBe(true);
    expect(summary.steps.map((step) => step.id)).toEqual(['ai_approval_renewal', 'catalog_sync', 'relationship_graph_routine']);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(path.join(outDir, 'sync_routine_summary.json'))).toBe(true);
  });

  test('runSyncRoutine records the run ledger when enabled', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-sync-routine-'));
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--external-product-ids',
      'seed_1',
      '--out-dir',
      outDir,
      '--record-run-ledger',
      '--run-trigger',
      'unit_test',
    ], { now: NOW });
    const runner = jest.fn(async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }));
    const ledgerRecorder = jest.fn(async (summary) => ({
      run_id: summary.run_id,
      status: 'passed',
    }));

    const summary = await runSyncRoutine(options, { runner, ledgerRecorder, now: NOW });

    expect(summary.ok).toBe(true);
    expect(ledgerRecorder).toHaveBeenCalledTimes(1);
    expect(ledgerRecorder.mock.calls[0][0]).toEqual(expect.objectContaining({
      ok: true,
      summary_path: path.join(outDir, 'sync_routine_summary.json'),
    }));
    expect(ledgerRecorder.mock.calls[0][1]).toEqual({
      runKind: 'sync_routine',
      trigger: 'unit_test',
    });
    expect(summary.ledger).toEqual(expect.objectContaining({
      requested: true,
      recorded: true,
      trigger: 'unit_test',
      status: 'passed',
    }));
  });

  test('runSyncRoutine fails closed when a child step fails', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-sync-routine-'));
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--external-product-ids',
      'seed_1',
      '--out-dir',
      outDir,
    ], { now: NOW });
    const runner = jest.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'failed' }));

    await expect(runSyncRoutine(options, { runner, now: NOW })).rejects.toMatchObject({
      summary: expect.objectContaining({
        ok: false,
        failed_step: 'catalog_sync',
      }),
    });

    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'sync_routine_summary.json'), 'utf8'));
    expect(summary.ok).toBe(false);
    // The optional renewal step fails without aborting; the run fails at catalog_sync.
    expect(summary.steps[0]).toEqual(expect.objectContaining({
      id: 'ai_approval_renewal',
      status: 'failed',
      optional: true,
    }));
    expect(summary.warnings).toEqual([expect.stringContaining('ai_approval_renewal')]);
    expect(summary.steps[1]).toEqual(expect.objectContaining({
      id: 'catalog_sync',
      status: 'failed',
    }));
  });

  test('runSyncRoutine records failed run ledger before throwing child step errors', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-sync-routine-'));
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--external-product-ids',
      'seed_1',
      '--out-dir',
      outDir,
      '--record-run-ledger',
      '--run-trigger',
      'unit_test',
    ], { now: NOW });
    const runner = jest.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'failed' }));
    const ledgerRecorder = jest.fn(async (summary) => ({
      run_id: summary.run_id,
      status: 'failed',
    }));

    await expect(runSyncRoutine(options, { runner, ledgerRecorder, now: NOW })).rejects.toMatchObject({
      summary: expect.objectContaining({
        ok: false,
        failed_step: 'catalog_sync',
        ledger: expect.objectContaining({
          recorded: true,
          status: 'failed',
        }),
      }),
    });

    expect(ledgerRecorder).toHaveBeenCalledTimes(1);
    expect(ledgerRecorder.mock.calls[0][0]).toEqual(expect.objectContaining({
      ok: false,
      failed_step: 'catalog_sync',
    }));
  });

  test('runSyncRoutine can fail closed on successful runs when ledger recording fails', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-sync-routine-'));
    const options = parseArgs([
      '--cutoff',
      CUTOFF,
      '--external-product-ids',
      'seed_1',
      '--out-dir',
      outDir,
      '--record-run-ledger',
      '--run-ledger-fail-closed',
    ], { now: NOW });
    const runner = jest.fn(async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }));
    const ledgerRecorder = jest.fn(async () => {
      throw new Error('ledger unavailable');
    });

    await expect(runSyncRoutine(options, { runner, ledgerRecorder, now: NOW })).rejects.toMatchObject({
      code: 'RELGRAPH_RUN_LEDGER_FAILED',
      summary: expect.objectContaining({
        ok: true,
        ledger: expect.objectContaining({
          recorded: false,
          error_message: 'ledger unavailable',
        }),
      }),
    });
  });
});

describe('formatRoutineFailure', () => {
  // Every field asserted below is sentinel-filled: the old formatter printed
  // `err.message` and the summary path, so a test that asserted only on values
  // which happen to be absent (or on the message itself) would pass against the
  // broken version too. Each sentinel is a string the old output could not
  // contain by construction.
  function failureError({ steps, failedStep = 'relationship_graph_routine', extra = {} } = {}) {
    const err = new Error('relationship graph sync routine failed at step: relationship_graph_routine');
    err.summary = {
      ok: false,
      failed_step: failedStep,
      summary_path: '/tmp/relgraph/sync_routine_summary.json',
      steps,
      ...extra,
    };
    return err;
  }

  const FAILED_STEP = {
    id: 'relationship_graph_routine',
    status: 'failed',
    command: '/usr/local/bin/node',
    args: ['/app/scripts/run-relationship-graph-routine.js', '--market', 'US'],
    started_at: '2026-08-10T10:37:47.000Z',
    completed_at: '2026-08-10T10:37:49.000Z',
    exit_code: 3,
    stdout_tail: 'STDOUT_SENTINEL_LAST_LINE',
    stderr_tail: 'Error: STDERR_SENTINEL_ROOT_CAUSE\n    at Object.<anonymous> (/app/scripts/x.js:1:1)',
  };

  test('prints the failing step stderr, which is the only durable record of why a run died', () => {
    const text = formatRoutineFailure(failureError({ steps: [FAILED_STEP] }));

    // The point of the whole change: without this line a Railway operator sees
    // a step name and nothing else.
    expect(text).toContain('STDERR_SENTINEL_ROOT_CAUSE');
    expect(text).toContain('exit_code=3');
    expect(text).toContain('STDOUT_SENTINEL_LAST_LINE');
    expect(text).toContain('/app/scripts/run-relationship-graph-routine.js');
    expect(text).toContain('started_at=2026-08-10T10:37:47.000Z');
    // Preserved from the old behaviour.
    expect(text).toContain('relationship graph sync routine failed at step');
    expect(text).toContain('/tmp/relgraph/sync_routine_summary.json');
  });

  test('reports a timeout kill distinctly from a non-zero exit', () => {
    const text = formatRoutineFailure(failureError({
      steps: [{
        ...FAILED_STEP,
        exit_code: 124,
        signal: 'SIGKILL',
        timed_out: true,
        timeout_ms: 1200000,
        stderr_tail: 'step timed out after 1200000ms',
      }],
    }));

    expect(text).toContain('timed_out=true');
    expect(text).toContain('timeout_ms=1200000');
    expect(text).toContain('signal=SIGKILL');
  });

  test('surfaces optional-step warnings, which abort nothing and are otherwise invisible', () => {
    const text = formatRoutineFailure(failureError({
      steps: [FAILED_STEP],
      extra: { warnings: ['optional step failed: ai_renewal (exit 9)'] },
    }));

    expect(text).toContain('optional step failed: ai_renewal (exit 9)');
  });

  test('appends the ledger error when the run also failed to record itself', () => {
    const err = failureError({ steps: [FAILED_STEP] });
    err.ledger_error = new Error('LEDGER_SENTINEL_UNAVAILABLE');

    expect(formatRoutineFailure(err)).toContain('LEDGER_SENTINEL_UNAVAILABLE');
  });

  test('reports the step named by failed_step, not merely the last one', () => {
    const text = formatRoutineFailure(failureError({
      failedStep: 'catalog_sync',
      steps: [
        { ...FAILED_STEP, id: 'catalog_sync', stderr_tail: 'CHOSEN_BY_NAME' },
        { ...FAILED_STEP, id: 'relationship_graph_routine', status: 'passed', stderr_tail: 'NOT_THIS_ONE' },
      ],
    }));

    expect(text).toContain('CHOSEN_BY_NAME');
    expect(text).not.toContain('NOT_THIS_ONE');
  });

  test('keeps the END of an oversized stderr, where the error actually is', () => {
    const text = formatRoutineFailure(failureError({
      steps: [{
        ...FAILED_STEP,
        stderr_tail: `${'x'.repeat(50000)}\nError: TAIL_SENTINEL_AT_THE_END`,
      }],
    }), { stderrChars: 200 });

    expect(text).toContain('TAIL_SENTINEL_AT_THE_END');
    expect(text.length).toBeLessThan(5000);
  });

  test('falls back to the stack when the error carries no summary', () => {
    const err = new Error('BOOT_SENTINEL_FAILURE');
    expect(formatRoutineFailure(err)).toContain('BOOT_SENTINEL_FAILURE');
    expect(formatRoutineFailure(err)).toContain('run_relationship_graph_sync_routine.test.js');
  });

  test('does not throw when the summary carries no step records', () => {
    const text = formatRoutineFailure(failureError({ steps: undefined }));
    expect(text).toContain('no step record captured');
    expect(text).toContain('relationship_graph_routine');
  });

  // The tests above build the error by hand, so they would still pass if
  // runSyncRoutine named these fields differently. This one drives the real
  // failure path and formats whatever it actually throws.
  test('formats the error runSyncRoutine really throws, not a hand-built one', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-sync-routine-fmt-'));
    const options = parseArgs([
      '--cutoff', CUTOFF,
      '--external-product-ids', 'seed_1',
      '--out-dir', outDir,
    ], { now: NOW });
    const runner = jest.fn(async () => ({
      exitCode: 42,
      stdout: 'REAL_STDOUT_SENTINEL',
      stderr: 'Error: REAL_STDERR_SENTINEL_ROOT_CAUSE',
    }));

    const err = await runSyncRoutine(options, { runner, now: NOW }).catch((e) => e);
    const text = formatRoutineFailure(err);

    expect(text).toContain('REAL_STDERR_SENTINEL_ROOT_CAUSE');
    expect(text).toContain('exit_code=42');
    expect(text).toContain('REAL_STDOUT_SENTINEL');
    expect(text).toContain('failed step: catalog_sync');
    // The optional renewal step failed too; it aborts nothing, so this line is
    // the only place an operator would ever see it.
    expect(text).toContain('ai_approval_renewal');
  });
});
