const {
  buildPdpImageDedupeKey,
  normalizePdpImageUrl,
  normalizePdpImageUrls,
} = require('../../src/utils/pdpImageUrls');

describe('pdp image URL normalization', () => {
  test('preserves Shopify asset identity and version while stripping transform parameters', () => {
    expect(
      normalizePdpImageUrl(
        'https://www.tomfordbeauty.com/cdn/shop/files/tf_sku_T92601_2000x2000_3_f1574ccd-a709-4b83-989a-987a8e85ffa2.jpg?v=1774596807&width=2000',
      ),
    ).toBe(
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T92601_2000x2000_3_f1574ccd-a709-4b83-989a-987a8e85ffa2.jpg?v=1774596807',
    );
  });

  test('does not dedupe hashed Tom Ford assets into stale bare filenames', () => {
    const urls = normalizePdpImageUrls([
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T92601_2000x2000_3_f1574ccd-a709-4b83-989a-987a8e85ffa2.jpg?v=1774596807',
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T92601_2000x2000_3.jpg',
    ]);

    expect(urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T92601_2000x2000_3_f1574ccd-a709-4b83-989a-987a8e85ffa2.jpg?v=1774596807',
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T92601_2000x2000_3.jpg',
    ]);
    expect(buildPdpImageDedupeKey(urls[0])).not.toBe(buildPdpImageDedupeKey(urls[1]));
  });

  test('resolves Shopify width placeholders into concrete asset URLs', () => {
    expect(
      normalizePdpImageUrl(
        'https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-1268x1268_%7Bwidth%7Dx.jpg?v=1740424675',
      ),
    ).toBe(
      'https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-1268x1268_1024x.jpg?v=1740424675',
    );
  });
});
