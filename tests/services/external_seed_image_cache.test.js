const {
  buildImageAssetBackfillPlanForRow,
  classifyImageFetchResult,
  collectExternalSeedImageCandidates,
  isSafeOriginalImageUrl,
  selectImageCandidatesForFetch,
  shouldCacheOriginalImageUrl,
} = require('../../src/services/externalSeedImageCache');

describe('externalSeedImageCache', () => {
  test('classifies blocked, stale, invalid, and valid image fetches', () => {
    expect(
      classifyImageFetchResult({
        url: 'https://www.guerlain.com/dw/image/foo.png',
        fetch_method: 'direct',
        http_status: 403,
        content_type: 'text/html',
      }),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        status: 'server_fetch_blocked',
        reason_codes: ['http_403'],
      }),
    );

    expect(
      classifyImageFetchResult({
        url: 'https://sdcdn.io/tf/missing.jpg',
        fetch_method: 'direct',
        http_status: 404,
        content_type: 'text/plain',
      }),
    ).toEqual(expect.objectContaining({ ok: false, status: 'stale_404' }));

    expect(
      classifyImageFetchResult({
        url: 'https://example.com/not-image',
        fetch_method: 'direct',
        http_status: 200,
        content_type: 'text/html',
        bytes: 4096,
      }),
    ).toEqual(expect.objectContaining({ ok: false, status: 'invalid_content_type' }));

    expect(
      classifyImageFetchResult({
        url: 'https://cdn.shopify.com/s/files/1/test.jpg',
        fetch_method: 'direct',
        http_status: 200,
        content_type: 'image/jpeg',
        bytes: 4096,
      }),
    ).toEqual(expect.objectContaining({ ok: true, status: 'direct_fetch_ok' }));
  });

  test('rejects low-resolution thumbnails from visible image health', () => {
    expect(
      classifyImageFetchResult({
        url: 'https://example.com/thumb.jpg',
        fetch_method: 'direct',
        http_status: 200,
        content_type: 'image/jpeg',
        bytes: 5000,
        width: 150,
        height: 150,
      }),
    ).toEqual(expect.objectContaining({
      ok: false,
      status: 'too_small_or_placeholder',
      reason_codes: ['too_small_or_placeholder'],
    }));
  });

  test('keeps safe original images and caches high-risk merchant images before surfacing', () => {
    const shopify = 'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC7Y09_3000x3000_4.jpg';
    const guerlain =
      'https://www.guerlain.com/dw/image/v2/BDCZ_PRD/on/demandware.static/-/Sites-GSA_master_catalog/default/dw0da3bbae/01-ProductsViewer/P062209/P062209_G062209_E01_hi-res.png?sw=655&sh=655';
    const stale = 'https://sdcdn.io/tf/tf_sku_TC7Y09_3000x3000_4.jpg';

    expect(isSafeOriginalImageUrl(shopify)).toBe(true);
    expect(shouldCacheOriginalImageUrl(shopify)).toBe(false);
    expect(shouldCacheOriginalImageUrl(guerlain)).toBe(true);

    const plan = buildImageAssetBackfillPlanForRow(
      {
        id: 'seed_1',
        external_product_id: 'ext_1',
        image_url: guerlain,
        seed_data: {
          snapshot: {
            image_urls: [guerlain, shopify, stale],
          },
        },
      },
      {
        [guerlain]: {
          ok: true,
          status: 'cached',
          cached_url: 'https://assets.pivota.cc/catalog-image-cache/ab/abcdef.png',
          fetch_method: 'browser',
          content_type: 'image/png',
          bytes: 1000,
          sha256: 'abcdef',
          reason_codes: [],
        },
        [shopify]: {
          ok: true,
          status: 'direct_fetch_ok',
          fetch_method: 'direct',
          content_type: 'image/jpeg',
          bytes: 1000,
          reason_codes: [],
        },
        [stale]: {
          ok: false,
          status: 'stale_404',
          fetch_method: 'direct',
          content_type: 'text/plain',
          reason_codes: ['stale_404'],
        },
      },
    );

    expect(plan.visible_image_urls).toEqual([
      'https://assets.pivota.cc/catalog-image-cache/ab/abcdef.png',
      shopify,
    ]);
    expect(plan.next_seed_data.snapshot.image_urls).toEqual(plan.visible_image_urls);
    expect(plan.quarantine_assets).toEqual([
      expect.objectContaining({
        original_url: stale,
        status: 'stale_404',
        reason_codes: ['stale_404'],
      }),
    ]);
  });

  test('does not surface high-risk original URLs when cache is still missing', () => {
    const guerlain = 'https://www.guerlain.com/dw/image/foo.png';
    const plan = buildImageAssetBackfillPlanForRow(
      {
        id: 'seed_1',
        external_product_id: 'ext_1',
        seed_data: { snapshot: { image_urls: [guerlain] } },
      },
      {
        [guerlain]: {
          ok: true,
          status: 'direct_fetch_ok',
          fetch_method: 'direct',
          content_type: 'image/png',
          bytes: 1000,
          reason_codes: [],
        },
      },
    );

    expect(plan.visible_image_urls).toEqual([]);
    expect(plan.next_seed_data.snapshot.image_urls).toEqual([]);
    expect(plan.quarantine_assets[0].reason_codes).toContain('cache_required_missing_cached_url');
  });

  test('dedupes visible gallery by content hash and caps extra surfaceable images', () => {
    const urls = [
      'https://cdn.shopify.com/s/files/1/test-1.jpg',
      'https://cdn.shopify.com/s/files/1/test-1-copy.jpg',
      'https://cdn.shopify.com/s/files/1/test-2.jpg',
      'https://cdn.shopify.com/s/files/1/test-3.jpg',
    ];
    const plan = buildImageAssetBackfillPlanForRow(
      {
        id: 'seed_1',
        external_product_id: 'ext_1',
        image_url: urls[0],
        seed_data: {
          snapshot: {
            image_urls: urls,
          },
        },
      },
      {
        [urls[0]]: { ok: true, status: 'direct_fetch_ok', content_type: 'image/jpeg', bytes: 1000, sha256: 'same', width: 1200, height: 1200 },
        [urls[1]]: { ok: true, status: 'direct_fetch_ok', content_type: 'image/jpeg', bytes: 1000, sha256: 'same', width: 1200, height: 1200 },
        [urls[2]]: { ok: true, status: 'direct_fetch_ok', content_type: 'image/jpeg', bytes: 1000, sha256: 'second', width: 1200, height: 1200 },
        [urls[3]]: { ok: true, status: 'direct_fetch_ok', content_type: 'image/jpeg', bytes: 1000, sha256: 'third', width: 1200, height: 1200 },
      },
      { maxVisibleImages: 2 },
    );

    expect(plan.visible_image_urls).toHaveLength(2);
    expect(plan.visible_image_urls).toContain(urls[0]);
    expect(plan.quarantine_assets.map((item) => item.reason_codes)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['duplicate_image_asset']),
        expect.arrayContaining(['visible_gallery_cap_exceeded']),
      ]),
    );
  });

  test('keeps swatch-only images out of visible gallery', () => {
    const swatch = 'https://cdn.shopify.com/s/files/1/swatch.jpg';
    const product = 'https://cdn.shopify.com/s/files/1/product.jpg';
    const plan = buildImageAssetBackfillPlanForRow(
      {
        id: 'seed_1',
        external_product_id: 'ext_1',
        seed_data: {
          snapshot: {
            image_urls: [product],
            variants: [{ swatch_image_url: swatch }],
          },
        },
      },
      {
        [product]: { ok: true, status: 'direct_fetch_ok', content_type: 'image/jpeg', bytes: 1000, sha256: 'product', width: 1200, height: 1200 },
        [swatch]: { ok: true, status: 'direct_fetch_ok', content_type: 'image/jpeg', bytes: 1000, sha256: 'swatch', width: 80, height: 80 },
      },
    );

    expect(plan.visible_image_urls).toEqual([product]);
    expect(plan.quarantine_assets).toEqual([
      expect.objectContaining({
        original_url: swatch,
        reason_codes: expect.arrayContaining(['variant_swatch_not_gallery_image']),
      }),
    ]);
  });

  test('prefilters fetch candidates to high-quality gallery/product images', () => {
    const selected = selectImageCandidatesForFetch(
      {
        image_url: 'https://example.com/root_3000x3000.jpg',
        seed_data: {
          snapshot: {
            image_urls: [
              'https://example.com/small.jpg?sw=150&sh=150',
              'https://example.com/large.jpg?sw=655&sh=655',
            ],
            variants: [
              { swatch_image_url: 'https://example.com/swatch.jpg' },
              { image_url: 'https://example.com/variant_hi-res.jpg' },
            ],
          },
        },
      },
      { maxFetchCandidates: 3 },
    );

    expect(selected.map((item) => item.url)).toEqual([
      'https://example.com/root_3000x3000.jpg',
      'https://example.com/large.jpg?sw=655&sh=655',
      'https://example.com/variant_hi-res.jpg',
    ]);
  });

  test('collects image candidates from root, snapshot, variants, and media shapes', () => {
    const candidates = collectExternalSeedImageCandidates({
      image_url: 'https://example.com/root.jpg',
      seed_data: {
        image_urls: ['https://example.com/root.jpg', 'https://example.com/root-2.jpg'],
        snapshot: {
          variants: [
            {
              image_url: 'https://example.com/variant.jpg',
              label_image_url: 'https://example.com/variant-label.jpg',
              swatch_image_url: 'https://example.com/variant-swatch.jpg',
            },
          ],
          media: [{ url: 'https://example.com/media.jpg' }],
        },
      },
    });

    expect(candidates.map((item) => item.url)).toEqual([
      'https://example.com/root.jpg',
      'https://example.com/root-2.jpg',
      'https://example.com/media.jpg',
      'https://example.com/variant.jpg',
      'https://example.com/variant-label.jpg',
      'https://example.com/variant-swatch.jpg',
    ]);
  });
});
