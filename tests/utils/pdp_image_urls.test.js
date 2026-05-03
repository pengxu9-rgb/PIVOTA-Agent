const {
  buildPdpImageDedupeKey,
  classifyShopifyLikeAsset,
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

  test('preserves valid sdcdn Tom Ford assets instead of rewriting them to stale Shopify URLs', () => {
    expect(
      normalizePdpImageUrl(
        'https://sdcdn.io/tf/tf_sku_T73C23_2000x2000_0.png?height=700&width=700',
      ),
    ).toBe('https://sdcdn.io/tf/tf_sku_T73C23_2000x2000_0.png');
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

  test('rewrites Pixi storefront /files assets to the official Shopify CDN path', () => {
    expect(
      normalizePdpImageUrl(
        'https://pixibeauty.com/files/Pixi_Skintreats_OvernightSpot-Stickers_July_2025_01.jpg',
      ),
    ).toBe(
      'https://cdn.shopify.com/s/files/1/1463/5858/files/Pixi_Skintreats_OvernightSpot-Stickers_July_2025_01.jpg',
    );
  });

  test('upgrades Shopify-like asset URLs to https', () => {
    expect(
      normalizePdpImageUrl(
        'http://www.pixibeauty.com/cdn/shop/files/Pixi_Skintreats_OvernightSpot-Stickers_July_2025_01_1200x600.jpg?v=1752780704',
      ),
    ).toBe(
      'https://www.pixibeauty.com/cdn/shop/files/Pixi_Skintreats_OvernightSpot-Stickers_July_2025_01_1200x600.jpg?v=1752780704',
    );
  });

  test('drops bogus bare-host files image URLs', () => {
    expect(normalizePdpImageUrl('http://files/Pixi_Skintreats_OvernightSpot-Stickers_July_2025_01.jpg')).toBe('');
  });

  test('dedupes merchant-host Shopify product assets against canonical Shopify CDN aliases', () => {
    const merchantProduct =
      'http://www.rarebeauty.com/cdn/shop/products/AlwaysAnOptimistPrimerMini_Primary_1024x1024.jpg?v=1720000000&width=1200';
    const cdnAlias =
      'https://cdn.shopify.com/s/files/1/0317/8349/5241/products/AlwaysAnOptimistPrimerMini_Primary_1024x1024.jpg?v=1720000000';

    expect(buildPdpImageDedupeKey(merchantProduct)).toBe(buildPdpImageDedupeKey(cdnAlias));
    expect(
      normalizePdpImageUrls([
        merchantProduct,
        cdnAlias,
      ]),
    ).toEqual([
      'https://www.rarebeauty.com/cdn/shop/products/AlwaysAnOptimistPrimerMini_Primary_1024x1024.jpg?v=1720000000',
    ]);
  });

  test('classifies Shopify product and content asset paths separately', () => {
    expect(
      classifyShopifyLikeAsset(
        new URL('https://www.rarebeauty.com/cdn/shop/products/primer-main.jpg?v=1720000000'),
      ),
    ).toBe('product');
    expect(
      classifyShopifyLikeAsset(
        new URL('https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-PRIMER.jpg?v=1720000000'),
      ),
    ).toBe('content');
    expect(
      classifyShopifyLikeAsset(
        new URL('https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-SKU.jpg?v=1762270689'),
      ),
    ).toBe('product');
    expect(
      classifyShopifyLikeAsset(
        new URL('https://cdn.shopify.com/s/files/1/0314/1143/7703/files/PDP-details-image-1268x1268-pore-primer_1024x.jpg?v=1617041406'),
      ),
    ).toBe('content');
  });
});
