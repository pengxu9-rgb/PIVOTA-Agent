describe('product image normalization helpers', () => {
  let imageDebug;

  beforeAll(() => {
    jest.resetModules();
    const app = require('../../src/server');
    imageDebug = app?._debug || {};
  });

  test('collects image candidates from seed_data snapshot arrays', () => {
    const normalizeProductImages = imageDebug.normalizeProductImages;
    expect(typeof normalizeProductImages).toBe('function');

    const { primaryImageUrl, normalizedImages } = normalizeProductImages({
      id: 'ext_1',
      image_url: '',
      images: [],
      image_urls: [],
      seed_data: {
        snapshot: {
          image_urls: [{ url: 'https://cdn.example.com/seed-primary.jpg' }],
        },
      },
    });

    expect(primaryImageUrl).toBe('https://cdn.example.com/seed-primary.jpg');
    expect(Array.isArray(normalizedImages)).toBe(true);
    expect(normalizedImages[0]).toBe('https://cdn.example.com/seed-primary.jpg');
  });

  test('collects image candidates from variants/media object arrays', () => {
    const normalizeProductImages = imageDebug.normalizeProductImages;
    const { primaryImageUrl, normalizedImages } = normalizeProductImages({
      id: 'ext_2',
      image_url: '',
      images: [],
      variants: [{ image_url: 'https://cdn.example.com/variant.jpg' }],
      media: [{ src: 'https://cdn.example.com/media.jpg' }],
    });

    expect(primaryImageUrl).toBe('https://cdn.example.com/variant.jpg');
    expect(normalizedImages).toEqual(
      expect.arrayContaining([
        'https://cdn.example.com/variant.jpg',
        'https://cdn.example.com/media.jpg',
      ]),
    );
  });
});
