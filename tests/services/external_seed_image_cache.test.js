const {
  buildImageAssetBackfillPlanForRow,
  classifyImageFetchResult,
  collectExternalSeedImageCandidates,
  isSafeOriginalImageUrl,
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

  test('collects image candidates from root, snapshot, variants, and media shapes', () => {
    const candidates = collectExternalSeedImageCandidates({
      image_url: 'https://example.com/root.jpg',
      seed_data: {
        image_urls: ['https://example.com/root.jpg', 'https://example.com/root-2.jpg'],
        snapshot: {
          variants: [{ image_url: 'https://example.com/variant.jpg' }],
          media: [{ url: 'https://example.com/media.jpg' }],
        },
      },
    });

    expect(candidates.map((item) => item.url)).toEqual([
      'https://example.com/root.jpg',
      'https://example.com/root-2.jpg',
      'https://example.com/media.jpg',
      'https://example.com/variant.jpg',
    ]);
  });
});
