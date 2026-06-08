const path = require('node:path');

const { WRAPPER_CONFIRM_TOKEN } = require('../../scripts/run-relationship-graph-sync-routine');
const {
  buildCronArgs,
  parseBooleanEnv,
  runCron,
} = require('../../scripts/run-relationship-graph-sync-routine-cron');

const NOW = new Date('2026-06-08T12:30:45.000Z');

function argValue(args, name) {
  const idx = args.indexOf(`--${name}`);
  return idx === -1 ? '' : args[idx + 1];
}

describe('run-relationship-graph-sync-routine-cron', () => {
  test('parseBooleanEnv handles common enabled and disabled values', () => {
    expect(parseBooleanEnv('true')).toBe(true);
    expect(parseBooleanEnv('1')).toBe(true);
    expect(parseBooleanEnv('off', true)).toBe(false);
    expect(parseBooleanEnv('', true)).toBe(true);
  });

  test('buildCronArgs defaults to dry-run selector mode with safety gates inherited', () => {
    const config = buildCronArgs({}, { now: NOW });

    expect(config.enabled).toBe(true);
    expect(config.dryRun).toBe(true);
    expect(argValue(config.args, 'market')).toBe('US');
    expect(argValue(config.args, 'select-updated-since')).toBe('2026-06-07T12:30:45.000Z');
    expect(argValue(config.args, 'cutoff')).toBe('2026-06-07T12:30:45.000Z');
    expect(argValue(config.args, 'select-sources')).toBe('catalog_products,external_product_seeds');
    expect(argValue(config.args, 'select-limit')).toBe('250');
    expect(argValue(config.args, 'limit')).toBe('200');
    expect(argValue(config.args, 'review-limit')).toBe('250');
    expect(argValue(config.args, 'out-dir')).toBe(path.join(
      '/tmp',
      'relationship-graph-sync-routine',
      'relgraph_sync_cron_20260608T123045',
    ));
    expect(config.args).toContain('--allow-empty-selection');
    expect(config.args).toContain('--allow-empty-build');
    expect(config.args).not.toContain('--apply-build');
    expect(config.args).not.toContain('--apply-review');
  });

  test('buildCronArgs accepts env tuning without changing write posture', () => {
    const config = buildCronArgs({
      RELGRAPH_SYNC_MARKET: 'jp',
      RELGRAPH_SYNC_SELECT_HOURS: '6',
      RELGRAPH_SYNC_SELECT_LIMIT: '12',
      RELGRAPH_SYNC_LIMIT: '34',
      RELGRAPH_SYNC_REVIEW_LIMIT: '56',
      RELGRAPH_SYNC_OUT_DIR: '/tmp/custom-relgraph',
      RELGRAPH_SYNC_SKIP_REVIEW: 'true',
      RELGRAPH_SYNC_SKIP_SERVING_AUDIT: '1',
      RELGRAPH_SYNC_MAX_SERVING_SUPPRESSED_PCT: '0.5',
      RELGRAPH_SYNC_FAIL_ON_SERVING_SUPPRESSION_REASONS: 'ai_approved_dupe_quarantined',
    }, { now: NOW });

    expect(argValue(config.args, 'market')).toBe('JP');
    expect(argValue(config.args, 'select-updated-since')).toBe('2026-06-08T06:30:45.000Z');
    expect(argValue(config.args, 'select-limit')).toBe('12');
    expect(argValue(config.args, 'limit')).toBe('34');
    expect(argValue(config.args, 'review-limit')).toBe('56');
    expect(argValue(config.args, 'out-dir')).toBe('/tmp/custom-relgraph');
    expect(argValue(config.args, 'cutoff')).toBe('');
    expect(config.args).toContain('--skip-review');
    expect(config.args).toContain('--skip-serving-audit');
    expect(argValue(config.args, 'max-serving-suppressed-pct')).toBe('0.5');
    expect(argValue(config.args, 'fail-on-serving-suppression-reasons')).toBe('ai_approved_dupe_quarantined');
  });

  test('buildCronArgs fails closed for write-mode env without explicit confirmation', () => {
    expect(() => buildCronArgs({
      RELGRAPH_SYNC_APPLY_BUILD: 'true',
    }, { now: NOW })).toThrow(/RELGRAPH_SYNC_ALLOW_WRITES=true/);

    expect(() => buildCronArgs({
      RELGRAPH_SYNC_APPLY_BUILD: 'true',
      RELGRAPH_SYNC_ALLOW_WRITES: 'true',
      RELGRAPH_SYNC_CONFIRM: 'wrong',
    }, { now: NOW })).toThrow(/RELGRAPH_SYNC_CONFIRM=APPLY_RELGRAPH_SYNC_ROUTINE/);

    const config = buildCronArgs({
      RELGRAPH_SYNC_APPLY_BUILD: 'true',
      RELGRAPH_SYNC_ALLOW_WRITES: 'true',
      RELGRAPH_SYNC_CONFIRM: WRAPPER_CONFIRM_TOKEN,
    }, { now: NOW });

    expect(config.dryRun).toBe(false);
    expect(config.args).toContain('--apply-build');
    expect(argValue(config.args, 'confirm')).toBe(WRAPPER_CONFIRM_TOKEN);
  });

  test('buildCronArgs rejects catalog sync apply because selector cron is read-only selection', () => {
    expect(() => buildCronArgs({
      RELGRAPH_SYNC_APPLY_SYNC: 'true',
    }, { now: NOW })).toThrow(/APPLY_SYNC is not supported/);
  });

  test('runCron can be disabled with a no-op report', async () => {
    const report = await runCron({
      env: {
        RELGRAPH_SYNC_CRON_ENABLED: 'false',
      },
      now: NOW,
    });

    expect(report).toEqual(expect.objectContaining({
      enabled: false,
      skipped: true,
      ok: true,
      reason: 'RELGRAPH_SYNC_CRON_ENABLED=false',
    }));
  });

  test('runCron delegates to the guarded sync routine in selector mode', async () => {
    const runner = jest.fn(async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }));
    const report = await runCron({
      env: {
        RELGRAPH_SYNC_SELECT_LIMIT: '2',
        RELGRAPH_SYNC_LIMIT: '3',
        RELGRAPH_SYNC_REVIEW_LIMIT: '4',
        RELGRAPH_SYNC_OUT_DIR: '/tmp/relgraph-cron-test',
      },
      now: NOW,
      cwd: '/tmp/pivota',
      runner,
    });

    expect(report.ok).toBe(true);
    expect(report.summary.steps.map((step) => step.id)).toEqual([
      'affected_product_selector',
      'relationship_graph_routine',
    ]);
    expect(runner).toHaveBeenCalledTimes(2);
    const selectorArgs = runner.mock.calls[0][1].join(' ');
    expect(selectorArgs).toContain('--limit 2');
    const routineArgs = runner.mock.calls[1][1].join(' ');
    expect(routineArgs).toContain('--db-lock');
    expect(routineArgs).toContain('--allow-empty-build');
  });
});
