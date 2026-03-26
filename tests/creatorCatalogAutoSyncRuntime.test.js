const {
  createCreatorCatalogAutoSyncRuntime,
} = require('../src/creatorCatalogAutoSyncRuntime');

function parsePositiveInt(raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const normalized = Math.floor(value);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}

function createRuntime(overrides = {}) {
  return createCreatorCatalogAutoSyncRuntime({
    env: {},
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
    queryDb: jest.fn(async () => ({ rows: [] })),
    axiosClient: { post: jest.fn() },
    parsePositiveInt,
    creatorConfigs: [],
    creatorCatalogCacheTtlSeconds: 7 * 24 * 60 * 60,
    pivotaApiBase: 'https://api.test',
    adminApiKey: 'test-admin-key',
    ...overrides,
  });
}

describe('creatorCatalogAutoSyncRuntime', () => {
  test('prefers explicit env merchant scope and dedupes values', async () => {
    const queryDb = jest.fn(async () => ({ rows: [{ merchant_id: 'db_merch_1' }] }));
    const runtime = createRuntime({
      env: {
        CATALOG_SYNC_MERCHANT_IDS: 'merch_env_1, merch_env_2, merch_env_1',
        DATABASE_URL: 'postgres://test',
      },
      queryDb,
    });

    await expect(runtime.resolveCatalogSyncMerchantIds()).resolves.toEqual({
      merchantIds: ['merch_env_1', 'merch_env_2'],
      source: 'env',
    });
    expect(queryDb).not.toHaveBeenCalled();
  });

  test('falls back to creator configs when discovery is empty', async () => {
    const queryDb = jest.fn(async () => ({ rows: [] }));
    const runtime = createRuntime({
      env: {
        DATABASE_URL: 'postgres://test',
      },
      queryDb,
      creatorConfigs: [
        { merchantIds: ['merch_cfg_1', 'merch_cfg_2'] },
        { merchantIds: ['merch_cfg_2', 'merch_cfg_3'] },
      ],
    });

    await expect(runtime.resolveCatalogSyncMerchantIds()).resolves.toEqual({
      merchantIds: ['merch_cfg_1', 'merch_cfg_2', 'merch_cfg_3'],
      source: 'creator_configs_fallback',
    });
    expect(queryDb).toHaveBeenCalled();
  });

  test('suppresses invalid merchant after failed sync attempt', async () => {
    const axiosClient = {
      post: jest.fn(async () => {
        const error = new Error('Shopify API error: 404');
        error.response = {
          status: 404,
          data: {
            detail: {
              message: 'Shopify API error: 404',
            },
          },
        };
        throw error;
      }),
    };
    const runtime = createRuntime({
      env: {
        CREATOR_CATALOG_AUTO_SYNC_ENABLED: 'true',
        CREATOR_CATALOG_AUTO_SYNC_INVALID_MERCHANT_COOLDOWN_SECONDS: '600',
      },
      axiosClient,
      creatorConfigs: [{ merchantIds: ['merch_bad'] }],
    });

    await runtime.runCreatorCatalogAutoSync();

    expect(axiosClient.post).toHaveBeenCalledTimes(1);
    expect(runtime.catalogSyncState.target_source).toBe('creator_configs_fallback');
    expect(runtime.catalogSyncState.target_count).toBe(1);
    const suppression = runtime.getCatalogSyncSuppressionStatus('merch_bad');
    expect(suppression.suppressed).toBe(true);
    expect(suppression.reason).toBe('invalid_merchant_cooldown');
    expect(suppression.invalid_merchant).toBe(true);
  });
});
