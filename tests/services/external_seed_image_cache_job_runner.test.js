jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
}));

const {
  buildBackfillArgsFromJob,
  buildRunnerConfig,
} = require('../../src/services/externalSeedImageCacheJobRunner');

describe('externalSeedImageCacheJobRunner', () => {
  test('builds apply backfill args from queued job filters', () => {
    const args = buildBackfillArgsFromJob({
      id: 123,
      filters: {
        product_id: 'ext_123',
        market: 'us',
        limit: 50,
        fetch_mode: 'browser',
        force_cache: true,
      },
    });

    expect(args).toEqual(
      expect.objectContaining({
        apply: true,
        dryRun: false,
        productId: 'ext_123',
        market: 'US',
        limit: 1,
        fetchMode: 'browser',
        forceCache: true,
      }),
    );
  });

  test('defaults runner on but clamps scheduling knobs', () => {
    const config = buildRunnerConfig({
      CATALOG_IMAGE_CACHE_JOB_RUNNER_INTERVAL_MS: '1',
      CATALOG_IMAGE_CACHE_JOB_RUNNER_INITIAL_DELAY_MS: '-1',
      CATALOG_IMAGE_CACHE_JOB_RUNNER_MAX_JOBS_PER_TICK: '99',
    });

    expect(config.enabled).toBe(true);
    expect(config.intervalMs).toBe(5000);
    expect(config.initialDelayMs).toBe(0);
    expect(config.maxJobsPerTick).toBe(10);
  });
});
