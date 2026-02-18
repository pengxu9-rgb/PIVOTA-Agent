describe('catalog sync merchant target resolution', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    prevEnv = {
      CATALOG_SYNC_MERCHANT_IDS: process.env.CATALOG_SYNC_MERCHANT_IDS,
      CREATOR_CATALOG_MERCHANT_IDS: process.env.CREATOR_CATALOG_MERCHANT_IDS,
      DATABASE_URL: process.env.DATABASE_URL,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED:
        process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.dontMock('../src/db');
    jest.resetModules();
    if (!prevEnv) return;

    if (prevEnv.CATALOG_SYNC_MERCHANT_IDS === undefined) {
      delete process.env.CATALOG_SYNC_MERCHANT_IDS;
    } else {
      process.env.CATALOG_SYNC_MERCHANT_IDS = prevEnv.CATALOG_SYNC_MERCHANT_IDS;
    }
    if (prevEnv.CREATOR_CATALOG_MERCHANT_IDS === undefined) {
      delete process.env.CREATOR_CATALOG_MERCHANT_IDS;
    } else {
      process.env.CREATOR_CATALOG_MERCHANT_IDS =
        prevEnv.CREATOR_CATALOG_MERCHANT_IDS;
    }
    if (prevEnv.DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = prevEnv.DATABASE_URL;
    }
    if (prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED === undefined) {
      delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    } else {
      process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED =
        prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    }
  });

  test('prefers explicit env merchant scope override', async () => {
    const queryMock = jest.fn(async () => ({ rows: [] }));
    jest.doMock('../src/db', () => ({ query: queryMock }));

    process.env.CATALOG_SYNC_MERCHANT_IDS =
      'merch_env_1, merch_env_2, merch_env_1';
    process.env.DATABASE_URL = 'postgres://test';

    const app = require('../src/server');
    const result = await app._debug.resolveCatalogSyncMerchantIds();

    expect(result).toEqual({
      merchantIds: ['merch_env_1', 'merch_env_2'],
      source: 'env',
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  test('discovers approved connected merchants from onboarding', async () => {
    const queryMock = jest.fn(async (sql) => {
      const text = String(sql || '');
      if (text.includes('FROM merchant_onboarding')) {
        return {
          rows: [
            { merchant_id: 'merch_live_1' },
            { merchant_id: 'merch_live_2' },
          ],
        };
      }
      return { rows: [] };
    });
    jest.doMock('../src/db', () => ({ query: queryMock }));

    delete process.env.CATALOG_SYNC_MERCHANT_IDS;
    process.env.DATABASE_URL = 'postgres://test';

    const app = require('../src/server');
    const result = await app._debug.resolveCatalogSyncMerchantIds();

    expect(result).toEqual({
      merchantIds: ['merch_live_1', 'merch_live_2'],
      source: 'merchant_onboarding',
    });
  });

  test('falls back to creator configs when db discovery is empty', async () => {
    const queryMock = jest.fn(async () => ({ rows: [] }));
    jest.doMock('../src/db', () => ({ query: queryMock }));

    delete process.env.CATALOG_SYNC_MERCHANT_IDS;
    process.env.DATABASE_URL = 'postgres://test';

    const app = require('../src/server');
    const result = await app._debug.resolveCatalogSyncMerchantIds();

    expect(result.source).toBe('creator_configs_fallback');
    expect(Array.isArray(result.merchantIds)).toBe(true);
    expect(result.merchantIds).toContain('merch_efbc46b4619cfbdf');
  });
});
