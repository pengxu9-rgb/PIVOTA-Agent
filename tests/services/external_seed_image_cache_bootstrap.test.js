const {
  buildBootstrapConfig,
  buildReportPath,
  getExternalSeedImageCacheBootstrapStatus,
  _internals,
} = require('../../src/services/externalSeedImageCacheBootstrap');

describe('externalSeedImageCacheBootstrap', () => {
  test('stays disabled by default', () => {
    const config = buildBootstrapConfig({});
    expect(config.enabled).toBe(false);
    expect(config.runnable).toBe(false);
  });

  test('requires a bounded filter even when enabled', () => {
    const config = buildBootstrapConfig({
      CATALOG_IMAGE_CACHE_BOOTSTRAP_ENABLED: 'true',
      CATALOG_IMAGE_CACHE_BOOTSTRAP_APPLY: 'true',
    });
    expect(config.enabled).toBe(true);
    expect(config.apply).toBe(true);
    expect(config.runnable).toBe(false);
  });

  test('parses product ids and safe execution defaults', () => {
    const config = buildBootstrapConfig({
      CATALOG_IMAGE_CACHE_BOOTSTRAP_ENABLED: 'true',
      CATALOG_IMAGE_CACHE_BOOTSTRAP_APPLY: 'true',
      CATALOG_IMAGE_CACHE_BOOTSTRAP_PRODUCT_IDS: ' ext_a, ext_b ',
      CATALOG_IMAGE_CACHE_BOOTSTRAP_MARKET: 'us',
      CATALOG_IMAGE_CACHE_BOOTSTRAP_FORCE_CACHE: '1',
      CATALOG_IMAGE_CACHE_BOOTSTRAP_FETCH_MODE: 'invalid',
    });
    expect(config.runnable).toBe(true);
    expect(config.productIds).toEqual(['ext_a', 'ext_b']);
    expect(config.market).toBe('US');
    expect(config.forceCache).toBe(true);
    expect(config.fetchMode).toBe('auto');
  });

  test('builds a deterministic report path without leaking unsafe characters', () => {
    const config = buildBootstrapConfig({
      CATALOG_IMAGE_CACHE_BOOTSTRAP_ENABLED: 'true',
      CATALOG_IMAGE_CACHE_BOOTSTRAP_PRODUCT_IDS: 'ext/foo bar',
      CATALOG_IMAGE_CACHE_BOOTSTRAP_APPLY: 'false',
    });
    const reportPath = buildReportPath(config, { RAILWAY_DEPLOYMENT_ID: 'dep_123' });
    expect(reportPath).toContain('dep_123-ext_foo_bar-dry-run.json');
  });

  test('reports sanitized status without secret values', () => {
    const status = getExternalSeedImageCacheBootstrapStatus({
      CATALOG_IMAGE_CACHE_BOOTSTRAP_ENABLED: 'true',
      CATALOG_IMAGE_CACHE_BOOTSTRAP_PRODUCT_IDS: 'ext_a',
      CATALOG_IMAGE_CACHE_BOOTSTRAP_APPLY: 'true',
      DATABASE_URL: 'postgres://user:secret@example/db',
      CATALOG_IMAGE_CACHE_S3_SECRET_ACCESS_KEY: 'secret',
    });
    expect(status.enabled).toBe(true);
    expect(status.runnable).toBe(true);
    expect(status.database_configured).toBe(true);
    expect(status.filters).toEqual(
      expect.objectContaining({
        product_ids_count: 1,
        market: 'US',
      }),
    );
    expect(JSON.stringify(status)).not.toContain('secret');
  });

  test('boolean parser accepts common truthy and falsy values', () => {
    expect(_internals.parseBoolean('yes')).toBe(true);
    expect(_internals.parseBoolean('off', true)).toBe(false);
    expect(_internals.parseBoolean('', true)).toBe(true);
  });
});
