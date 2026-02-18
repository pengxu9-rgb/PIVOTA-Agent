const request = require('supertest');

describe('creator catalog auto-sync interval guardrail', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    prevEnv = {
      CREATOR_CATALOG_CACHE_TTL_SECONDS: process.env.CREATOR_CATALOG_CACHE_TTL_SECONDS,
      CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES:
        process.env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.resetModules();
    if (!prevEnv) return;
    if (prevEnv.CREATOR_CATALOG_CACHE_TTL_SECONDS === undefined) {
      delete process.env.CREATOR_CATALOG_CACHE_TTL_SECONDS;
    } else {
      process.env.CREATOR_CATALOG_CACHE_TTL_SECONDS = prevEnv.CREATOR_CATALOG_CACHE_TTL_SECONDS;
    }
    if (prevEnv.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES === undefined) {
      delete process.env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES;
    } else {
      process.env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES =
        prevEnv.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES;
    }
    if (prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED === undefined) {
      delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    } else {
      process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    }
  });

  test('clamps configured interval to ttl-based max', async () => {
    process.env.CREATOR_CATALOG_CACHE_TTL_SECONDS = '1200';
    process.env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES = '100';

    const app = require('../src/server');
    const resp = await request(app).get('/health');

    expect(resp.status).toBe(200);
    expect(resp.body?.catalog_sync).toEqual(
      expect.objectContaining({
        interval_minutes: 5,
        interval_minutes_max: 5,
        cache_ttl_seconds: 1200,
      }),
    );
  });
});
