const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { APPLY_CONFIRM_TOKEN: ROUTINE_CONFIRM_TOKEN } = require('../../scripts/run-relationship-graph-routine-job');
const {
  DEFAULT_FAIL_REASONS,
  SYNC_CONFIRM_TOKEN,
  WRAPPER_CONFIRM_TOKEN,
  buildSyncRoutineSteps,
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
    expect(options.dbLock).toBe(true);
    expect(options.lockStaleAfterMinutes).toBe(180);
    expect(options.maxServingSuppressedPct).toBe(1);
    expect(options.maxServingSuppressedRows).toBe(25);
    expect(options.failOnServingSuppressionReasons).toEqual(DEFAULT_FAIL_REASONS);
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
    ], { now: NOW });

    const { steps, artifacts } = buildSyncRoutineSteps(options);

    expect(steps.map((step) => step.id)).toEqual(['catalog_sync', 'relationship_graph_routine']);
    expect(artifacts.affected_products).toBe('/tmp/relgraph-sync-routine/affected-products.json');

    const syncArgs = steps[0].args.join(' ');
    expect(syncArgs).toContain('sync-external-seeds-to-catalog.cjs');
    expect(syncArgs).toContain('--external-product-ids seed_1,seed_2');
    expect(syncArgs).toContain('--affected-products-out /tmp/relgraph-sync-routine/affected-products.json');
    expect(syncArgs).toContain('--dry-run');
    expect(syncArgs).not.toContain('--apply');

    const routineArgs = steps[1].args.join(' ');
    expect(routineArgs).toContain('run-relationship-graph-routine-job.js');
    expect(routineArgs).toContain('--affected-products-file /tmp/relgraph-sync-routine/affected-products.json');
    expect(routineArgs).toContain('--db-lock');
    expect(routineArgs).toContain('--lock-stale-after-minutes 180');
    expect(routineArgs).toContain('--max-serving-suppressed-pct 1');
    expect(routineArgs).toContain('--max-serving-suppressed-rows 25');
    expect(routineArgs).toContain(`--fail-on-serving-suppression-reasons ${DEFAULT_FAIL_REASONS.join(',')}`);
    expect(routineArgs).toContain('--cutoff 2026-06-08T00:00:00Z');
    expect(routineArgs).not.toContain('--apply-build');
    expect(routineArgs).not.toContain('--confirm');
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
    ], { now: NOW });

    const { steps, artifacts } = buildSyncRoutineSteps(options);

    expect(steps.map((step) => step.id)).toEqual(['affected_product_selector', 'relationship_graph_routine']);
    expect(artifacts.affected_product_selector).toBe('/tmp/relgraph-sync-routine/affected-products.json');
    expect(artifacts.catalog_sync).toBeNull();

    const selectorArgs = steps[0].args.join(' ');
    expect(selectorArgs).toContain('select-relationship-graph-affected-products.js');
    expect(selectorArgs).toContain('--updated-since 2026-06-07T00:00:00Z');
    expect(selectorArgs).toContain('--sources catalog_products');
    expect(selectorArgs).toContain('--limit 50');
    expect(selectorArgs).toContain('--allow-empty-selection');

    const routineArgs = steps[1].args.join(' ');
    expect(routineArgs).toContain('--affected-products-file /tmp/relgraph-sync-routine/affected-products.json');
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

    expect(steps.map((step) => step.id)).toEqual(['relationship_graph_routine']);
    const routineArgs = steps[0].args.join(' ');
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

    const syncArgs = steps[0].args.join(' ');
    expect(syncArgs).toContain('--apply');
    expect(syncArgs).toContain(`--confirm ${SYNC_CONFIRM_TOKEN}`);

    const routineArgs = steps[1].args.join(' ');
    expect(routineArgs).toContain('--apply-build');
    expect(routineArgs).toContain(`--confirm ${ROUTINE_CONFIRM_TOKEN}`);
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
    expect(summary.steps.map((step) => step.id)).toEqual(['catalog_sync', 'relationship_graph_routine']);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(outDir, 'sync_routine_summary.json'))).toBe(true);
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
    expect(summary.steps[0]).toEqual(expect.objectContaining({
      id: 'catalog_sync',
      status: 'failed',
    }));
  });
});
