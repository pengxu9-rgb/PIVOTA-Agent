const {
  composeSyntheticCanonicalProduct,
} = require('../../src/services/pdpIdentityGraph');

describe('pdpIdentityGraph image cache handling', () => {
  test('preserves fresh external seed cached media over stale identity source payload images', () => {
    const cachedUrl = 'https://assets.pivota.cc/catalog-image-cache/ab/abcdef.png';
    const blockedOriginal = 'https://www.guerlain.com/dw/image/v2/BDCZ_PRD/blocked.png?sw=655&sh=655';
    const listing = {
      merchant_id: 'external_seed',
      product_id: 'ext_guerlain_eye',
      source_kind: 'external_seed',
      source_tier: 'brand',
      sellable_item_group_id: 'sig_guerlain_eye',
      product_line_id: 'pl_guerlain_eye',
      source_payload: {
        merchant_id: 'external_seed',
        product_id: 'ext_guerlain_eye',
        title: 'Abeille Royale Youth Repair Eye Care',
        image_url: blockedOriginal,
        images: [{ url: blockedOriginal }],
        image_urls: [{ url: blockedOriginal }],
      },
    };
    const fallbackProduct = {
      merchant_id: 'external_seed',
      product_id: 'ext_guerlain_eye',
      title: 'Abeille Royale Youth Repair Eye Care',
      image_url: cachedUrl,
      images: [cachedUrl],
      image_urls: [cachedUrl],
      seed_data: {
        image_asset_cache_v1: {
          visible_image_urls: [cachedUrl],
          assets: [{ original_url: blockedOriginal, cached_url: cachedUrl, visible_url: cachedUrl }],
        },
      },
    };

    const composed = composeSyntheticCanonicalProduct({
      requestedListing: listing,
      exactListings: [listing],
      lineListings: [],
      fallbackProduct,
    });

    expect(composed.product.image_url).toBe(cachedUrl);
    expect(composed.product.images.map((item) => item.url || item)).toEqual([cachedUrl]);
    expect(composed.product.image_urls.map((item) => item.url || item)).not.toContain(blockedOriginal);
  });
});
