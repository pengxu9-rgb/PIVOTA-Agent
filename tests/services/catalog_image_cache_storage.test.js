const {
  buildCatalogImageCacheKey,
  buildCatalogImageCacheVisibleUrl,
  extFromContentType,
  normalizeCatalogImageCacheKey,
  sha256Buffer,
} = require('../../src/services/catalogImageCacheStorage');

describe('catalogImageCacheStorage', () => {
  test('builds deterministic content-addressed object keys', () => {
    const sha = 'a'.repeat(64);
    expect(buildCatalogImageCacheKey({ sha256: sha, contentType: 'image/png' })).toBe(
      `catalog-image-cache/aa/${sha}.png`,
    );
  });

  test('maps image content types to stable file extensions', () => {
    expect(extFromContentType('image/avif')).toBe('avif');
    expect(extFromContentType('image/webp; charset=binary')).toBe('webp');
    expect(extFromContentType('image/jpeg')).toBe('jpg');
    expect(extFromContentType('text/html')).toBe('bin');
  });

  test('hashes bytes for idempotent cache reuse', () => {
    expect(sha256Buffer(Buffer.from('pivota'))).toBe(
      '940b5b34191b72d2224876ef384f4475e9c796d41c563373edf8dd67e30d462e',
    );
  });

  test('rewrites r2.dev public URLs to the runtime cache asset route by default', () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      CATALOG_IMAGE_CACHE_PUBLIC_BASE_URL: 'https://pub-example.r2.dev',
      CATALOG_IMAGE_CACHE_PROXY_PUBLIC_BASE_URL: 'https://pivota-agent-production.up.railway.app',
    };
    try {
      const sha = 'b'.repeat(64);
      expect(
        buildCatalogImageCacheVisibleUrl({
          cachedUrl: `https://pub-example.r2.dev/catalog-image-cache/bb/${sha}.avif`,
        }),
      ).toBe(`https://pivota-agent-production.up.railway.app/catalog-image-cache/bb/${sha}.avif`);
    } finally {
      process.env = originalEnv;
    }
  });

  test('rejects non-cache object keys for runtime image serving', () => {
    expect(normalizeCatalogImageCacheKey('catalog-image-cache/bb/not-a-digest.avif')).toBe('');
    expect(normalizeCatalogImageCacheKey('../secret')).toBe('');
  });
});
