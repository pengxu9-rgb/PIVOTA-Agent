describe('creator catalog auto-sync retry on long timeout', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
    prevEnv = {
      CATALOG_SYNC_MERCHANT_IDS: process.env.CATALOG_SYNC_MERCHANT_IDS,
      CREATOR_CATALOG_AUTO_SYNC_ENABLED: process.env.CREATOR_CATALOG_AUTO_SYNC_ENABLED,
      CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS: process.env.CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS,
      CREATOR_CATALOG_AUTO_SYNC_RETRIES: process.env.CREATOR_CATALOG_AUTO_SYNC_RETRIES,
      CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS:
        process.env.CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS,
      CREATOR_CATALOG_AUTO_SYNC_NON_RETRYABLE_COOLDOWN_SECONDS:
        process.env.CREATOR_CATALOG_AUTO_SYNC_NON_RETRYABLE_COOLDOWN_SECONDS,
      CREATOR_CATALOG_SYNC_ADMIN_KEY: process.env.CREATOR_CATALOG_SYNC_ADMIN_KEY,
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED:
        process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };

    process.env.CATALOG_SYNC_MERCHANT_IDS = 'merch_timeout_case';
    process.env.CREATOR_CATALOG_AUTO_SYNC_ENABLED = 'true';
    process.env.CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS = '120000';
    process.env.CREATOR_CATALOG_AUTO_SYNC_RETRIES = '1';
    process.env.CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS = '1';
    process.env.CREATOR_CATALOG_AUTO_SYNC_NON_RETRYABLE_COOLDOWN_SECONDS = '600';
    process.env.CREATOR_CATALOG_SYNC_ADMIN_KEY = 'admin_sync_key';
    process.env.PIVOTA_API_BASE = 'https://example-pivota.test';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.dontMock('../src/auroraBff/routes');
    jest.dontMock('axios');
    jest.resetModules();
    if (!prevEnv) return;

    const restore = (key) => {
      if (prevEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prevEnv[key];
      }
    };

    restore('CATALOG_SYNC_MERCHANT_IDS');
    restore('CREATOR_CATALOG_AUTO_SYNC_ENABLED');
    restore('CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS');
    restore('CREATOR_CATALOG_AUTO_SYNC_RETRIES');
    restore('CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS');
    restore('CREATOR_CATALOG_AUTO_SYNC_NON_RETRYABLE_COOLDOWN_SECONDS');
    restore('CREATOR_CATALOG_SYNC_ADMIN_KEY');
    restore('PIVOTA_API_BASE');
    restore('AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED');
  });

  test('retries once for timeout and succeeds on second attempt', async () => {
    const axiosPost = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 120000ms exceeded' })
      .mockResolvedValueOnce({ data: { summary: { synced: 10 } } });
    jest.doMock('axios', () => ({ post: axiosPost }));

    const app = require('../src/server');
    await app._debug.runCreatorCatalogAutoSync();

    expect(axiosPost).toHaveBeenCalledTimes(2);
    expect(axiosPost.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        timeout: 120000,
        headers: { 'X-ADMIN-KEY': 'admin_sync_key' },
      }),
    );
    expect(app._debug.catalogSyncState.per_merchant.merch_timeout_case).toEqual(
      expect.objectContaining({
        ok: true,
        attempts: 2,
      }),
    );
  });

  test('skips non-retryable merchants during cooldown window', async () => {
    process.env.CATALOG_SYNC_MERCHANT_IDS = 'merch_bad,merch_good';

    const axiosPost = jest
      .fn()
      .mockRejectedValueOnce({
        response: {
          status: 502,
          data: {
            detail: 'Shopify API error: 404 - {"errors":"Not Found"}',
          },
        },
        message: 'Request failed with status code 502',
      })
      .mockResolvedValueOnce({ status: 200, data: { summary: { synced: 5 } } })
      .mockResolvedValueOnce({ status: 200, data: { summary: { synced: 6 } } });
    jest.doMock('axios', () => ({ post: axiosPost }));

    const app = require('../src/server');
    await app._debug.runCreatorCatalogAutoSync();
    await app._debug.runCreatorCatalogAutoSync();

    expect(axiosPost).toHaveBeenCalledTimes(3);
    expect(app._debug.catalogSyncState.per_merchant.merch_bad).toEqual(
      expect.objectContaining({
        ok: false,
        skipped: true,
        status: 502,
      }),
    );
    expect(app._debug.catalogSyncState.per_merchant.merch_good).toEqual(
      expect.objectContaining({
        ok: true,
        attempts: 1,
      }),
    );
  });
});
