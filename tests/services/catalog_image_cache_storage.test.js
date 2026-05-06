const {
  buildCatalogImageCacheKey,
  extFromContentType,
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
});
