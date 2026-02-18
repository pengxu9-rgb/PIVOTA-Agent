const request = require('supertest');

describe('creator catalog auto-sync interval guardrail', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
    prevEnv = {
      CREATOR_CATALOG_CACHE_TTL_SECONDS: process.env.CREATOR_CATALOG_CACHE_TTL_SECONDS,
      CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES:
        process.env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES,
      CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS:
        process.env.CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS,
      CREATOR_CATALOG_AUTO_SYNC_RETRIES:
        process.env.CREATOR_CATALOG_AUTO_SYNC_RETRIES,
      CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS:
        process.env.CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.dontMock('../src/auroraBff/routes');
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
    if (prevEnv.CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS === undefined) {
      delete process.env.CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS;
    } else {
      process.env.CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS =
        prevEnv.CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS;
    }
    if (prevEnv.CREATOR_CATALOG_AUTO_SYNC_RETRIES === undefined) {
      delete process.env.CREATOR_CATALOG_AUTO_SYNC_RETRIES;
    } else {
      process.env.CREATOR_CATALOG_AUTO_SYNC_RETRIES =
        prevEnv.CREATOR_CATALOG_AUTO_SYNC_RETRIES;
    }
    if (prevEnv.CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS === undefined) {
      delete process.env.CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS;
    } else {
      process.env.CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS =
        prevEnv.CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS;
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
    process.env.CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS = '180000';
    process.env.CREATOR_CATALOG_AUTO_SYNC_RETRIES = '2';
    process.env.CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS = '5000';

    const app = require('../src/server');
    const resp = await request(app).get('/health');

    expect(resp.status).toBe(200);
    expect(resp.body?.catalog_sync).toEqual(
      expect.objectContaining({
        interval_minutes: 5,
        interval_minutes_max: 5,
        cache_ttl_seconds: 1200,
        request_timeout_ms: 180000,
        retry_attempts: 2,
        retry_backoff_ms: 5000,
      }),
    );
  });
});
