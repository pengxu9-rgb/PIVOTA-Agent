const {
  availabilityToInStock,
  buildExternalSeedProduct,
  canonicalizeExternalSeedSnapshot,
  buildExternalSeedBrandSearchProduct,
  collectCachedSeedImageUrls,
  normalizeSeedVariants,
  resolveBeautyCategoryPathPrefixForQuery,
} = require('../../src/services/externalSeedProducts');

describe('externalSeedProducts helper', () => {
  test('resolves beauty query category path prefixes for canonical catalog recall', () => {
    expect(resolveBeautyCategoryPathPrefixForQuery('lipstick')).toBe('beauty/makeup/lip/');
    expect(resolveBeautyCategoryPathPrefixForQuery('fenty beauty lipsticks')).toBe('beauty/makeup/lip/');
    expect(resolveBeautyCategoryPathPrefixForQuery('best red 口红')).toBe('beauty/makeup/lip/');
    expect(resolveBeautyCategoryPathPrefixForQuery('waterproof mascara')).toBe('beauty/makeup/eye/');
    expect(resolveBeautyCategoryPathPrefixForQuery('woody perfume')).toBe('beauty/fragrance/');
    expect(resolveBeautyCategoryPathPrefixForQuery('tom ford fragarance')).toBe('beauty/fragrance/');
    expect(resolveBeautyCategoryPathPrefixForQuery('fragrance-free barrier moisturizer')).toBe(
      'beauty/skincare/moisturize/',
    );
    expect(resolveBeautyCategoryPathPrefixForQuery('unknown beauty object')).toBe('');
  });

  test('uses source merchant labels before brand for external referral offers', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_sony_best_buy',
      external_product_id: 'best-buy:e7b8f47d4dc3621d',
      canonical_url:
        'https://www.bestbuy.com/site/sony-wh-1000xm5-wireless-noise-canceling-over-the-ear-headphones-black/6505726.p?skuId=6505726',
      destination_url:
        'https://www.bestbuy.com/site/sony-wh-1000xm5-wireless-noise-canceling-over-the-ear-headphones-black/6505726.p?skuId=6505726',
      domain: 'bestbuy.com',
      title: 'WH-1000XM5',
      price_amount: '248.00',
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'Sony',
        merchant_inferred: 'Best Buy',
      },
    });

    expect(product.brand).toBe('Sony');
    expect(product.merchant_name).toBe('Best Buy');
  });

  test('prefers cached image asset contract URLs over blocked merchant originals', () => {
    const cachedUrl = 'https://assets.pivota.cc/catalog-image-cache/ab/abcdef.png';
    const blockedOriginal = 'https://www.guerlain.com/dw/image/v2/BDCZ_PRD/blocked.png?sw=655&sh=655';
    const row = {
      id: 'eps_guerlain_eye',
      external_product_id: 'ext_guerlain_eye',
      canonical_url: 'https://www.guerlain.com/us/en-us/p/abeille-royale-youth-repair-eye-care-P062209.html',
      destination_url: 'https://www.guerlain.com/us/en-us/p/abeille-royale-youth-repair-eye-care-P062209.html',
      title: 'Abeille Royale Youth Repair Eye Care',
      image_url: blockedOriginal,
      seed_data: {
        brand: 'Guerlain',
        image_asset_cache_v1: {
          visible_image_urls: [cachedUrl],
          assets: [{ original_url: blockedOriginal, cached_url: cachedUrl, visible_url: cachedUrl }],
        },
        snapshot: {
          image_url: blockedOriginal,
          image_urls: [blockedOriginal],
          variants: [
            {
              variant_id: 'P062209',
              sku: 'P062209',
              title: '15 ml',
              option_name: 'Size',
              option_value: '15 ml',
              image_url: blockedOriginal,
              image_urls: [blockedOriginal],
              images: [blockedOriginal],
              label_image_url: blockedOriginal,
              swatch_image_url: blockedOriginal,
            },
          ],
        },
      },
    };

    expect(collectCachedSeedImageUrls(row.seed_data)).toEqual([cachedUrl]);
    const product = buildExternalSeedProduct(row);
    expect(product.image_url).toBe(cachedUrl);
    expect(product.images[0]).toBe(cachedUrl);
    expect(product.images).not.toContain(blockedOriginal);
    expect(product.variants[0].image_url).toBe(cachedUrl);
    expect(product.variants[0].label_image_url).toBe(cachedUrl);
    expect(product.variants[0].swatch_image_url).toBe(cachedUrl);
    expect(product.variants[0].image_urls).toEqual([cachedUrl]);

    const searchProduct = buildExternalSeedBrandSearchProduct(row);
    expect(searchProduct.image_url).toBe(cachedUrl);
  });

  test('falls back to cached seed gallery when variant original was quarantined from cache', () => {
    const cachedGalleryUrl = 'https://agent.pivota.cc/catalog-image-cache/14/lost-cherry-gallery.jpg';
    const cachedMappedUrl = 'https://agent.pivota.cc/catalog-image-cache/cc/lost-cherry-size.webp';
    const quarantinedVariantUrl =
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T81201_2000x2000_0_broken.png?v=1777211432';
    const mappedVariantUrl =
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T8MK01_2000x2000_0.png?v=1777211432';
    const row = {
      id: 'eps_tom_ford_lost_cherry',
      external_product_id: 'ext_tom_ford_lost_cherry',
      canonical_url: 'https://www.tomfordbeauty.com/products/lost-cherry-eau-de-parfum',
      destination_url: 'https://www.tomfordbeauty.com/products/lost-cherry-eau-de-parfum',
      domain: 'www.tomfordbeauty.com',
      title: 'Lost Cherry Eau de Parfum',
      seed_data: {
        brand: 'Tom Ford Beauty',
        image_asset_cache_v1: {
          visible_image_urls: [cachedGalleryUrl, cachedMappedUrl],
          assets: [
            {
              original_url: mappedVariantUrl,
              cached_url: cachedMappedUrl,
              visible_url: cachedMappedUrl,
            },
          ],
        },
        snapshot: {
          image_urls: [cachedGalleryUrl, cachedMappedUrl],
          images: [cachedGalleryUrl, cachedMappedUrl],
          variants: [
            {
              sku: 'T81201',
              variant_id: '53031546618069',
              option_name: 'Size',
              option_value: '100.0 ml',
              price: '615.00',
              currency: 'USD',
              stock: 'In Stock',
              image_url: quarantinedVariantUrl,
            },
            {
              sku: 'T8MK01',
              variant_id: '53394850218197',
              option_name: 'Size',
              option_value: '30.0 ml',
              price: '255.00',
              currency: 'USD',
              stock: 'In Stock',
              image_url: mappedVariantUrl,
            },
          ],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.image_url).toBe(cachedGalleryUrl);
    expect(product.images).toEqual([cachedGalleryUrl, cachedMappedUrl]);
    expect(product.variants[0].image_url).toBe(cachedGalleryUrl);
    expect(product.variants[0].image_urls).toEqual([cachedGalleryUrl, cachedMappedUrl]);
    expect(product.variants[0].image_urls).not.toContain(quarantinedVariantUrl);
    expect(product.variants[1].image_url).toBe(cachedMappedUrl);
    expect(product.variants[1].image_urls).toEqual([cachedMappedUrl]);
  });

  test('normalizes snapshot variants and carries multi-image fields forward', () => {
    const row = {
      id: 'eps_1',
      canonical_url: 'https://example.com/p/product-1',
      destination_url: 'https://example.com/p/product-1',
      domain: 'example.com',
      title: 'Example Product',
      seed_data: {
        brand: 'Example',
        category: 'Beauty Tools',
        image_urls: ['https://example.com/p1.jpg', 'https://example.com/p2.jpg'],
        snapshot: {
          canonical_url: 'https://example.com/p/product-1',
          variants: [
            {
              sku: 'SKU-1',
              variant_id: 'SKU-1',
              option_name: 'Shade',
              option_value: 'Light',
              price: '19.99',
              currency: 'USD',
              stock: 'In Stock',
              image_urls: ['https://example.com/p1.jpg', 'https://example.com/p2.jpg'],
            },
            {
              sku: 'SKU-2',
              variant_id: 'SKU-2',
              option_name: 'Shade',
              option_value: 'Medium',
              price: '21.99',
              currency: 'USD',
              stock: 'Out of Stock',
              image_urls: ['https://example.com/p3.jpg', 'https://example.com/p4.jpg'],
            },
          ],
        },
      },
    };

    const variants = normalizeSeedVariants(row.seed_data, row);
    expect(variants).toHaveLength(2);
    expect(variants[0]).toEqual(
      expect.objectContaining({
        sku: 'SKU-1',
        image_url: 'https://example.com/p1.jpg',
        images: ['https://example.com/p1.jpg', 'https://example.com/p2.jpg'],
      }),
    );

    const product = buildExternalSeedProduct(row);
    expect(product.variants).toHaveLength(2);
    expect(product.images).toEqual(['https://example.com/p1.jpg', 'https://example.com/p2.jpg']);
    expect(product.variants[1]).toEqual(
      expect.objectContaining({
        sku: 'SKU-2',
        image_url: 'https://example.com/p3.jpg',
      }),
    );
  });

  test('filters site chrome and placeholder images from external seed product galleries', () => {
    const productImage =
      'https://theordinary.com/dw/image/v2/BFKJ_PRD/on/demandware.static/-/Sites-deciem-master/default/dw0fd80738/Images/products/The%20Ordinary/rdn-multi-peptide-lash-and-brow-serum-eu-5ml.png?sw=900&sh=900&sm=fit';
    const productImageResize =
      'https://theordinary.com/dw/image/v2/BFKJ_PRD/on/demandware.static/-/Sites-deciem-master/default/dw0fd80738/Images/products/The%20Ordinary/rdn-multi-peptide-lash-and-brow-serum-eu-5ml.png?sw=860&sh=860&sm=fit';
    const benefitImage =
      'https://theordinary.com/dw/image/v2/BFKJ_PRD/on/demandware.static/-/Sites-deciem-master/default/dw233a3a1a/Images/products/The%20Ordinary/infographics/ord-multi-peptide-lash-brow-benefits-graphic.jpg?sw=900&sh=900&sm=fit';

    const product = buildExternalSeedProduct({
      id: 'eps_theordinary_lash_brow',
      external_product_id: 'ext_theordinary_lash_brow',
      canonical_url: 'https://theordinary.com/en-us/multi-peptide-lash-brow-serum-100111.html',
      destination_url: 'https://theordinary.com/en-us/multi-peptide-lash-brow-serum-100111.html',
      title: 'Multi-Peptide Lash and Brow Serum',
      image_url: productImage,
      seed_data: {
        brand: 'The Ordinary',
        snapshot: {
          image_url: productImage,
          image_urls: [
            productImage,
            benefitImage,
            'https://theordinary.com/on/demandware.static/-/Library-Sites-DeciemSharedLibrary/default/dw665025d6/theordinary/homepage/slotA/heroes-slot-a-mobile.jpg',
            'https://theordinary.com/on/demandware.static/Sites-deciem-us-Site/-/default/dw6a974392/images/theordinary/navbar-email-signup-popup-img-TO.png',
            'https://theordinary.com/on/demandware.static/Sites-deciem-us-Site/-/default/dw7498968d/images/brands-logo/theOrdinary-logo.svg',
            'https://theordinary.com/en-us/iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAAXNSR0IB2cksfwAAAAlwSFlzAAALEwAACxMBAJqcGAAAAANQTFRF+Pj4c64OKQAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAASUVORK5CYII=',
            productImageResize,
          ],
        },
      },
    });

    expect(product.images).toEqual([productImage, benefitImage]);
    expect(product.image_url).toBe(productImage);
  });

  test('filters mixed Shopify content assets out of runtime gallery while preserving section media separately', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_rare_primer_mini',
      external_product_id: 'ext_rare_primer_mini',
      canonical_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
      destination_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
      title: 'Always An Optimist Pore Diffusing Primer Mini',
      seed_data: {
        image_urls: [
          'http://www.rarebeauty.com/cdn/shop/products/AlwaysAnOptimistPrimerMini_Primary_1024x1024.jpg?v=1720000000&width=1200',
          'https://cdn.shopify.com/s/files/1/0317/8349/5241/products/AlwaysAnOptimistPrimerMini_Primary_1024x1024.jpg?v=1720000000',
          'https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-PRIMER-MINI.jpg?v=1720000001',
        ],
        content_image_urls: ['https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-PRIMER-MINI.jpg?v=1720000001'],
        snapshot: {
          pdp_details_sections: [{ heading: 'Overview', body: 'Primer overview.' }],
          image_urls: [
            'https://www.rarebeauty.com/cdn/shop/products/AlwaysAnOptimistPrimerMini_Primary_1024x1024.jpg?v=1720000000',
            'https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-PRIMER-MINI.jpg?v=1720000001',
          ],
          content_image_urls: ['https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-PRIMER-MINI.jpg?v=1720000001'],
        },
      },
    });

    expect(product.images).toEqual([
      'https://www.rarebeauty.com/cdn/shop/products/AlwaysAnOptimistPrimerMini_Primary_1024x1024.jpg?v=1720000000',
    ]);
    expect(product.content_image_urls).toEqual([
      'https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-PRIMER-MINI.jpg?v=1720000001',
    ]);
  });

  test('filters legacy Shopify content files out of gallery even when product images come from cdn.shopify.com', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_rare_primer_live_shape',
      external_product_id: 'ext_rare_primer_live_shape',
      canonical_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
      destination_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
      title: 'Always An Optimist Pore Diffusing Primer Mini',
      seed_data: {
        snapshot: {
          image_urls: [
            'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-Travel-SKU.jpg?v=1762270689',
            'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-Travel-Open-SKU.jpg?v=1617149001',
            'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/diffusing-primer-swatch-1440x1952_490e7974-aa56-4c60-8643-38edfc1538a9.jpg?v=1617149024',
            'https://www.rarebeauty.com/cdn/shop/files/GNAV-SU26-SHOP-ALL.png?v=1774669137',
            'https://www.rarebeauty.com/cdn/shop/products/ILLUMINATING-PRIMER-28ML-SKU-1_6ffb264a-d678-4a6d-85a8-fa2924d6fd0f.jpg?v=1762201378',
            'https://www.rarebeauty.com/cdn/shop/products/4-IN-1-MIST-SKU-1_c9988cd0-b4d3-4fb7-b9e2-5e3a36bf5d05.jpg?v=1762200384',
            'https://www.rarebeauty.com/cdn/shop/products/Setting-Powder-Light-SKU.jpg?v=1762276083',
            'https://www.rarebeauty.com/cdn/shop/products/Powder-Brush-SKU.jpg?v=1762276046',
            'https://www.rarebeauty.com/cdn/shop/products/Eyeshadow-Primer-SKU.jpg?v=1762270691',
            'https://www.rarebeauty.com/cdn/shop/files/PDP-details-image-1268x1268-pore-primer_1024x.jpg?v=1617041406',
            'https://www.rarebeauty.com/cdn/shop/files/PDP-imperfect-circle-primers_1024x.png?v=1616543294',
          ],
          variants: [
            {
              variant_id: 'mini',
              sku: 'mini',
              option_name: 'Variant',
              option_value: 'Mini',
              image_urls: ['https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-Travel-SKU.jpg?v=1762270689'],
            },
          ],
        },
      },
    });

    expect(product.images).toEqual([
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-Travel-SKU.jpg?v=1762270689',
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-Travel-Open-SKU.jpg?v=1617149001',
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/diffusing-primer-swatch-1440x1952_490e7974-aa56-4c60-8643-38edfc1538a9.jpg?v=1617149024',
    ]);
    expect(product.content_image_urls).toEqual([
      'https://www.rarebeauty.com/cdn/shop/files/PDP-details-image-1268x1268-pore-primer_1024x.jpg?v=1617041406',
      'https://www.rarebeauty.com/cdn/shop/files/PDP-imperfect-circle-primers_1024x.png?v=1616543294',
    ]);
  });

  test('keeps only real Fenty product gallery assets and filters shade-finder and award media at runtime', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_fenty_refill_runtime',
      external_product_id: 'ext_fenty_refill_runtime',
      canonical_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
      destination_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
      title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer Refill - EU',
      seed_data: {
        snapshot: {
          image_urls: [
            'https://fentybeauty.com/cdn/shop/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI.jpg?v=1762272037',
            'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI_600x.jpg?v=1762272037',
            'https://fentybeauty.com/cdn/shop/t/12/assets/find-shade.png?v=111',
            'https://fentybeauty.com/cdn/shop/t/12/assets/try-shade.png?v=111',
            'https://fentybeauty.com/cdn/shop/t/12/assets/get-the-look.jpg?v=111',
            'https://fentybeauty.com/cdn/shop/files/FS844250_GLOBAL_HYDRA_VIZOR_INFOGRAPHICS_1200x1500_Ingredients.jpg?v=1762272037',
            'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/HYDRA-VIZOR-BADGE-AWARD.jpg?v=1762272037',
            'https://cdn.accentuate.io/8445381804077/1774977845944/allure_2025_3000x3000-(2).png?v=1774977845944&width=100',
          ],
        },
      },
    });

    expect(product.images).toEqual([
      'https://fentybeauty.com/cdn/shop/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI.jpg?v=1762272037',
    ]);
    expect(product.content_image_urls).toEqual([
      'https://fentybeauty.com/cdn/shop/files/FS844250_GLOBAL_HYDRA_VIZOR_INFOGRAPHICS_1200x1500_Ingredients.jpg?v=1762272037',
    ]);
  });

  test('separates Fenty texture and application assets from product gallery at runtime', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_fenty_hydra_mini_runtime',
      external_product_id: 'ext_fenty_hydra_mini_runtime',
      canonical_url: 'https://fentybeauty.com/products/hydra-vizor-mini-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
      destination_url: 'https://fentybeauty.com/products/hydra-vizor-mini-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
      title: 'Hydra Vizor Mini Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
      seed_data: {
        snapshot: {
          image_urls: [
            'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_POSTHOL2021_T2PRODUCT_ECOMM_MINI_HYDRA_VIZOR_US_1200x1500_FENTYVERSE.jpg?v=1762272039',
            'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_TEXTURE_1200x1500_72DPI_0b694f77-059c-4f40-8c98-140fd70040a9.jpg?v=1760652647',
            'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_SUM25_MVP_T2BEAUTY_HYDRAVIZOR_APPLICATION_LIGHT_TAYLOR_108_1200X1500_72DPI.jpg?v=1760652808',
            'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_CONSUMER_PERCEPTION_1200x1500_72DPI_9d18259c-a31f-4ee6-80fc-c7fed71283ea.jpg?v=1760652647',
            'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_COMPARISON_1200x1500_72DPI_05e22d61-95ab-4f2d-b3a7-8df248edb9be.jpg?v=1760652647',
            'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_INGREDIENTS_1200x1500_72DPI_05c296d8-b761-4b8f-8d45-f861f5acf324.jpg?v=1760652647',
          ],
        },
      },
    });

    expect(product.images).toEqual([
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_POSTHOL2021_T2PRODUCT_ECOMM_MINI_HYDRA_VIZOR_US_1200x1500_FENTYVERSE.jpg?v=1762272039',
    ]);
    expect(product.content_image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_TEXTURE_1200x1500_72DPI_0b694f77-059c-4f40-8c98-140fd70040a9.jpg?v=1760652647',
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_SUM25_MVP_T2BEAUTY_HYDRAVIZOR_APPLICATION_LIGHT_TAYLOR_108_1200X1500_72DPI.jpg?v=1760652808',
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_CONSUMER_PERCEPTION_1200x1500_72DPI_9d18259c-a31f-4ee6-80fc-c7fed71283ea.jpg?v=1760652647',
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_COMPARISON_1200x1500_72DPI_05e22d61-95ab-4f2d-b3a7-8df248edb9be.jpg?v=1760652647',
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_INGREDIENTS_1200x1500_72DPI_05c296d8-b761-4b8f-8d45-f861f5acf324.jpg?v=1760652647',
    ]);
  });

  test('filters mini and refill sibling packshots out of Fenty full-size runtime gallery', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_fenty_hydra_full_runtime',
      external_product_id: 'ext_fenty_hydra_full_runtime',
      canonical_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
      destination_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
      title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
      seed_data: {
        snapshot: {
          image_urls: [
            'https://fentybeauty.com/cdn/shop/files/FS22_REFRESH_HYDRAVIZOR_PDP_FENTYVERSE_1200x.jpg?v=1762272034',
            'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS746400---HYDRA-VIZOR-FRANCHISE-UPDATE-081524_RIH_1200x1500_05.jpg?v=1767728388',
            'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI.jpg?v=1762272036',
            'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_POSTHOL2021_T2PRODUCT_ECOMM_MINI_HYDRA_VIZOR_US_1200x1500_FENTYVERSE.jpg?v=1762272039',
            'https://fentybeauty.com/cdn/shop/files/FS746400---HYDRA-VIZOR-FRANCHISE-UPDATE-081524_RIH_1200x1500_03_1350x1650.jpg?v=1760568262',
            'https://fentybeauty.com/cdn/shop/files/FS_SPR24_T2PRODUCT_ECOMM_HYDRAVIZOR_HUEZ_HOLDER_HOLDER_REFILL_SHADE_4_1200x1500_72_DPI_US_1350x1650.jpg?v=1762286285',
          ],
        },
      },
    });

    expect(product.images).toEqual([
      'https://fentybeauty.com/cdn/shop/files/FS22_REFRESH_HYDRAVIZOR_PDP_FENTYVERSE_1200x.jpg?v=1762272034',
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS746400---HYDRA-VIZOR-FRANCHISE-UPDATE-081524_RIH_1200x1500_05.jpg?v=1767728388',
      'https://fentybeauty.com/cdn/shop/files/FS746400---HYDRA-VIZOR-FRANCHISE-UPDATE-081524_RIH_1200x1500_03_1350x1650.jpg?v=1760568262',
    ]);
  });

  test('re-filters legacy runtime content_image_urls instead of trusting polluted snapshot content', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_fenty_refill_runtime_legacy_content',
      external_product_id: 'ext_fenty_refill_runtime_legacy_content',
      canonical_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
      destination_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
      title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer Refill - EU',
      seed_data: {
        snapshot: {
          image_urls: [
            'https://fentybeauty.com/cdn/shop/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI.jpg?v=1762272037',
          ],
          content_image_urls: [
            'https://fentybeauty.com/cdn/shop/files/FS844250_GLOBAL_HYDRA_VIZOR_INFOGRAPHICS_1200x1500_Ingredients.jpg?v=1762272037',
            'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/HYDRA-VIZOR-BADGE-AWARD.jpg?v=1762272037',
            'https://fentybeauty.com/cdn/shop/t/12/assets/find-shade.png?v=111',
          ],
        },
      },
    });

    expect(product.images).toEqual([
      'https://fentybeauty.com/cdn/shop/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI.jpg?v=1762272037',
    ]);
    expect(product.content_image_urls).toEqual([
      'https://fentybeauty.com/cdn/shop/files/FS844250_GLOBAL_HYDRA_VIZOR_INFOGRAPHICS_1200x1500_Ingredients.jpg?v=1762272037',
    ]);
  });

  test('carries seed review summary into external seed runtime product', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_reviewed_seed',
      external_product_id: 'ext_reviewed_seed',
      canonical_url: 'https://beautyofjoseon.com/products/glow-replenishing-rice-milk',
      destination_url: 'https://beautyofjoseon.com/products/glow-replenishing-rice-milk',
      title: 'Glow Replenishing Rice Milk',
      seed_data: {
        brand: 'Beauty of Joseon',
        snapshot: {
          review_summary: {
            reviewCount: '1,404',
            reviewAverageValue: '4.9',
          },
        },
      },
    });

    expect(product.review_summary).toEqual({
      rating: 4.9,
      review_count: 1404,
    });
  });

  test('carries force-filled PDP review absence without consuming seed audit summaries', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_review_absence_seed',
      external_product_id: 'ext_review_absence_seed',
      canonical_url: 'https://fentybeauty.com/products/example',
      destination_url: 'https://fentybeauty.com/products/example',
      title: 'Example Product',
      seed_data: {
        brand: 'Fenty Beauty',
        review_summary: {
          auditor: 'seed_content_audit_v1',
          review_status: 'auto_corrected',
          issues_detected: ['html_entities_in_description'],
        },
        snapshot: {
          pdp_review_summary: {
            status: 'unavailable',
            unavailable_reason: 'no_approved_merchant_review_source_captured',
            source: 'pivota_force_fill_v1',
            content_review_state: 'approved_absence',
            force_filled: true,
          },
        },
      },
    });

    expect(product.review_summary).toEqual({
      status: 'unavailable',
      review_count: 0,
      scale: 5,
      unavailable_reason: 'no_approved_merchant_review_source_captured',
      source: 'pivota_force_fill_v1',
      content_review_state: 'approved_absence',
      force_filled: true,
    });
  });

  test('carries force-filled estimated reviews and reviewed questions', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_review_estimate_seed',
      external_product_id: 'ext_review_estimate_seed',
      canonical_url: 'https://fentybeauty.com/products/example',
      destination_url: 'https://fentybeauty.com/products/example',
      title: 'Example Product',
      seed_data: {
        brand: 'Fenty Beauty',
        snapshot: {
          pdp_review_summary: {
            status: 'estimated',
            rating: 4.4,
            review_count: 36,
            scale: 5,
            source: 'pivota_force_fill_v1',
            content_review_state: 'approved_estimate',
            force_filled: true,
            questions: [
              {
                question: 'How should I use this product?',
                answer: 'Use it according to the product directions and adjust frequency to your routine.',
                source: 'pivota_force_fill_v1',
              },
            ],
          },
        },
      },
    });

    expect(product.review_summary).toEqual(
      expect.objectContaining({
        status: 'estimated',
        rating: 4.4,
        review_count: 36,
        scale: 5,
        source: 'pivota_force_fill_v1',
        content_review_state: 'approved_estimate',
        force_filled: true,
        questions: [
          expect.objectContaining({
            question: 'How should I use this product?',
            answer: expect.stringContaining('product directions'),
          }),
        ],
      }),
    );
  });

  test('normalizes merchant review preview items and q&a into external seed runtime product', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_review_preview_seed',
      external_product_id: 'ext_review_preview_seed',
      canonical_url: 'https://beautyofjoseon.com/products/glow-replenishing-rice-milk',
      destination_url: 'https://beautyofjoseon.com/products/glow-replenishing-rice-milk',
      title: 'Glow Replenishing Rice Milk',
      seed_data: {
        brand: 'Beauty of Joseon',
        snapshot: {
          review_summary: {
            reviewCount: '1,404',
            reviewAverageValue: '4.9',
            brand_card: { name: 'Beauty of Joseon' },
            preview_items: [
              {
                review_id: 'r_1',
                rating: 5,
                author_label: 'buyer_1',
                title: 'Hydrating and calm',
                text_snippet: 'Leaves skin soft and comfortable.',
                media: [
                  {
                    type: 'image',
                    url: 'https://cdn.example.com/review-1.jpg',
                    thumbnail_url: 'https://cdn.example.com/review-1-thumb.jpg',
                  },
                ],
              },
            ],
            questions: [
              {
                question: 'Does it layer well under sunscreen?',
                answer: 'Yes, it sits comfortably under SPF.',
                source: 'merchant_q_and_a',
              },
            ],
          },
        },
      },
    });

    expect(product.review_summary).toEqual(
      expect.objectContaining({
        rating: 4.9,
        review_count: 1404,
        brand_card: { name: 'Beauty of Joseon' },
        preview_items: [
          expect.objectContaining({
            review_id: 'r_1',
            title: 'Hydrating and calm',
            text_snippet: 'Leaves skin soft and comfortable.',
            media: [
              expect.objectContaining({
                type: 'image',
                url: 'https://cdn.example.com/review-1.jpg',
                thumbnail_url: 'https://cdn.example.com/review-1-thumb.jpg',
              }),
            ],
          }),
        ],
        questions: [
          expect.objectContaining({
            question: 'Does it layer well under sunscreen?',
            answer: 'Yes, it sits comfortably under SPF.',
            source: 'merchant_q_and_a',
          }),
        ],
      }),
    );
  });

  test('normalizes nested product variants and tuple option fields into named options', () => {
    const row = {
      id: 'eps_nested_variant_1',
      canonical_url: 'https://example.com/p/multi-size-shirt',
      destination_url: 'https://example.com/p/multi-size-shirt',
      title: 'Multi Size Shirt',
      seed_data: {
        snapshot: {
          product: {
            options: [{ name: 'Color' }, { name: 'Size' }],
            variants: [
              {
                id: 'SKU-RED-S',
                sku: 'SKU-RED-S',
                option1: 'Red',
                option2: 'S',
                price: '29.00',
                currency: 'USD',
                stock: 'In Stock',
                color_hex: '#ff0000',
                image_url: 'https://example.com/red-s.jpg',
              },
              {
                id: 'SKU-RED-M',
                sku: 'SKU-RED-M',
                option1: 'Red',
                option2: 'M',
                price: '29.00',
                currency: 'USD',
                stock: 'In Stock',
                image_url: 'https://example.com/red-m.jpg',
              },
            ],
          },
        },
      },
    };

    const variants = normalizeSeedVariants(row.seed_data, row);
    expect(variants).toHaveLength(2);
    expect(variants[0]).toEqual(
      expect.objectContaining({
        sku: 'SKU-RED-S',
        options: [
          expect.objectContaining({ name: 'Color', value: 'Red', axis_kind: 'color' }),
          expect.objectContaining({ name: 'Size', value: 'S', axis_kind: 'size' }),
        ],
        color_hex: '#ff0000',
        swatch: { hex: '#ff0000' },
      }),
    );

    const product = buildExternalSeedProduct(row);
    expect(product.variants).toHaveLength(2);
    expect(product.variants[0].options).toEqual([
      expect.objectContaining({ name: 'Color', value: 'Red' }),
      expect.objectContaining({ name: 'Size', value: 'S' }),
    ]);
  });

  test('uses explicit variant query params when external seed options are SKU-only', () => {
    const row = {
      id: 'eps_good_molecules_niacinamide',
      external_product_id: 'ext_good_molecules_niacinamide',
      canonical_url: 'https://www.goodmolecules.com/products/niacinamide-serum',
      destination_url: 'https://v1.goodmolecules.com/products/niacinamide-serum?Size=30ml&Option=Single',
      domain: 'v1.goodmolecules.com',
      title: 'Niacinamide Serum',
      price_amount: 6,
      price_currency: 'USD',
      seed_data: {
        brand: 'Good Molecules',
        snapshot: {
          variants: [
            {
              id: '0d95bc75608b',
              sku: '62835',
              url: 'https://v1.goodmolecules.com/products/niacinamide-serum?Size=30ml&Option=Single',
              option_name: 'Offer',
              option_value: '62835',
              price: '6.00',
              currency: 'USD',
              stock: 'In Stock',
            },
            {
              id: 'dd900dd84932',
              sku: '62835-2',
              url: 'https://v1.goodmolecules.com/products/niacinamide-serum?Size=30ml&Option=2-Pack',
              option_name: 'Offer',
              option_value: '62835-2',
              price: '12.00',
              currency: 'USD',
              stock: 'In Stock',
            },
            {
              id: 'd61150ebb38e',
              sku: '74080',
              deep_link:
                'https://v1.goodmolecules.com/products/niacinamide-serum?Size=75ml&Option=Single&utm_source=pivota',
              option_name: 'Offer',
              option_value: '74080',
              price: '12.00',
              currency: 'USD',
              stock: 'In Stock',
            },
          ],
        },
      },
    };

    const product = buildExternalSeedProduct(row);

    expect(product.selected_variant_id).toBe('0d95bc75608b');
    expect(product.variants[0]).toEqual(
      expect.objectContaining({
        variant_id: '0d95bc75608b',
        sku: '62835',
        title: '30 mL / Single',
        options: [
          expect.objectContaining({ name: 'Size', value: '30 mL', axis_kind: 'volume' }),
          expect.objectContaining({ name: 'Pack', value: 'Single', axis_kind: 'pack' }),
        ],
      }),
    );
    expect(product.variants[1]).toEqual(
      expect.objectContaining({
        title: '30 mL / 2-Pack',
        options: [
          expect.objectContaining({ name: 'Size', value: '30 mL', axis_kind: 'volume' }),
          expect.objectContaining({ name: 'Pack', value: '2-Pack', axis_kind: 'pack' }),
        ],
      }),
    );
    expect(product.variants[2]).toEqual(
      expect.objectContaining({
        title: '75 mL / Single',
        options: [
          expect.objectContaining({ name: 'Size', value: '75 mL', axis_kind: 'volume' }),
          expect.objectContaining({ name: 'Pack', value: 'Single', axis_kind: 'pack' }),
        ],
      }),
    );
  });

  test('normalizes generic Variant volume rows into displayable size options', () => {
    const row = {
      id: 'eps_tf_perfume_100ml',
      external_product_id: 'ext_tf_perfume_100ml',
      canonical_url: 'https://example.com/products/perfume',
      destination_url: 'https://example.com/products/perfume',
      title: 'Perfume',
      seed_data: {
        category: 'Fragrance',
        snapshot: {
          variants: [
            {
              id: 'v1',
              title: '100.0 ml',
              option_name: 'Variant',
              option_value: '100.0 ml',
              image_url: 'https://example.com/perfume-100ml.jpg',
            },
          ],
        },
      },
    };

    const variants = normalizeSeedVariants(row.seed_data, row);
    expect(variants[0]).toEqual(
      expect.objectContaining({
        title: '100.0 ml',
        option_name: 'Size',
        option_value: '100.0 ml',
        axis_kind: 'volume',
        options: [{ name: 'Size', value: '100.0 ml', axis_kind: 'volume' }],
      }),
    );
  });

  test('normalizes merchant-specific size/count axis labels', () => {
    const variants = normalizeSeedVariants(
      {
        snapshot: {
          variants: [
            {
              id: 'v1',
              option_name: 'Choose a size',
              option_value: 'Full (1.7 FL OZ)',
            },
            {
              id: 'v2',
              option_name: 'Ct.',
              option_value: '60 Patches',
            },
            {
              id: 'v3',
              option_name: 'Voume',
              option_value: '80 ml',
            },
          ],
        },
      },
      { title: 'Skincare set' },
    );

    expect(variants[0]).toEqual(
      expect.objectContaining({
        option_name: 'Size',
        option_value: '1.7 fl oz',
        axis_kind: 'volume',
      }),
    );
    expect(variants[1]).toEqual(
      expect.objectContaining({
        option_name: 'Pack',
        option_value: '60 Patches',
        axis_kind: 'pack',
      }),
    );
    expect(variants[2]).toEqual(
      expect.objectContaining({
        option_name: 'Size',
        option_value: '80 mL',
        axis_kind: 'volume',
      }),
    );
  });

  test('normalizes generic Variant shade rows for tinted products when visual evidence exists', () => {
    const variants = normalizeSeedVariants(
      {
        snapshot: {
          variants: [
            {
              id: 'v1',
              option_name: 'Variant',
              option_value: '458 POP ROSE GLOW',
              image_url: 'https://example.com/pop-rose-glow.jpg',
            },
          ],
        },
      },
      { title: 'KISSKISS BEE GLOW honey tint balm' },
    );

    expect(variants[0]).toEqual(
      expect.objectContaining({
        option_name: 'Shade',
        option_value: '458 POP ROSE GLOW',
        axis_kind: 'shade',
        label_image_url: 'https://example.com/pop-rose-glow.jpg',
        source_quality_status: 'captured',
      }),
    );
  });

  test('suppresses wrong Color locale axis for non-tinted skincare products', () => {
    const row = {
      id: 'eps_fenty_refill',
      external_product_id: 'ext_fenty_refill',
      canonical_url: 'https://example.com/products/hydra-vizor-refill',
      destination_url: 'https://example.com/products/hydra-vizor-refill',
      title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer Refill',
      seed_data: {
        category: 'Skincare',
        product_type: 'Moisturizer',
        snapshot: {
          variants: [
            {
              id: 'v1',
              title: 'US',
              option_name: 'Color',
              option_value: 'US',
              image_url: 'https://example.com/refill-us.jpg',
            },
          ],
        },
      },
    };

    const variants = normalizeSeedVariants(row.seed_data, row);
    expect(variants[0]).toEqual(
      expect.objectContaining({
        title: 'Default',
        options: [],
        source_quality_status: 'blocked',
      }),
    );
    expect(variants[0].option_name).toBeUndefined();
    expect(variants[0].option_value).toBeUndefined();
  });

  test('preserves skincare formula variants when Shopify mislabels the axis as Color', () => {
    const row = {
      id: 'eps_tirtir_ampoule_masks',
      external_product_id: 'ext_tirtir_ampoule_masks',
      canonical_url: 'https://tirtir.global/products/ampoule-mask-packs',
      destination_url: 'https://tirtir.global/products/ampoule-mask-packs',
      title: 'Ampoule Mask Packs',
      seed_data: {
        brand: 'TIRTIR GLOBAL',
        category: 'Skincare',
        snapshot: {
          variants: [
            {
              id: '46531699048667',
              title: 'Perfect-C Vita Ampoule Mask Pack',
              option_name: 'Color',
              option_value: 'Perfect-C Vita Ampoule Mask Pack',
              image_url: 'https://example.com/vita-mask.jpg',
            },
            {
              id: '45829626101979',
              title: 'Galactomyces Softening Ampoule Mask Pack',
              option_name: 'Color',
              option_value: 'Galactomyces Softening Ampoule Mask Pack',
              image_url: 'https://example.com/galactomyces-mask.jpg',
            },
          ],
        },
      },
    };

    const variants = normalizeSeedVariants(row.seed_data, row);
    expect(variants).toHaveLength(2);
    expect(variants[0]).toEqual(
      expect.objectContaining({
        title: 'Perfect-C Vita Ampoule Mask Pack',
        option_name: 'Format',
        option_value: 'Perfect-C Vita Ampoule Mask Pack',
        axis_kind: 'format',
        options: [
          {
            name: 'Format',
            value: 'Perfect-C Vita Ampoule Mask Pack',
            axis_kind: 'format',
          },
        ],
        source_quality_status: 'captured',
      }),
    );

    const product = buildExternalSeedProduct(row);
    expect(product.variants).toHaveLength(2);
    expect(product.variants[1]).toEqual(
      expect.objectContaining({
        option_name: 'Format',
        option_value: 'Galactomyces Softening Ampoule Mask Pack',
      }),
    );
  });

  test('preserves lip product color variants with visual evidence even when the title reads skincare-like', () => {
    const row = {
      id: 'eps_laneige_topper',
      external_product_id: 'ext_laneige_topper',
      canonical_url: 'https://us.laneige.com/products/lip-sleeping-mask-topper',
      destination_url: 'https://us.laneige.com/products/lip-sleeping-mask-topper',
      title: 'Lip Sleeping Mask Topper',
      seed_data: {
        brand: 'LANEIGE US',
        snapshot: {
          variants: [
            {
              id: 'v1',
              sku: '272130114',
              option_name: 'Color',
              option_value: 'Pumpkin Pie',
              image_url: 'https://example.com/pumpkin-pie.jpg',
            },
            {
              id: 'v2',
              sku: '272130115',
              option_name: 'Color',
              option_value: 'Hot Cocoa',
              image_url: 'https://example.com/hot-cocoa.jpg',
            },
          ],
        },
      },
    };

    const variants = normalizeSeedVariants(row.seed_data, row);
    expect(variants).toHaveLength(2);
    expect(variants[0]).toEqual(
      expect.objectContaining({
        title: 'Pumpkin Pie',
        option_name: 'Color',
        option_value: 'Pumpkin Pie',
        axis_kind: 'color',
        options: [{ name: 'Color', value: 'Pumpkin Pie', axis_kind: 'color' }],
        source_quality_status: 'captured',
        label_image_url: 'https://example.com/pumpkin-pie.jpg',
      }),
    );
    expect(variants[1]).toEqual(
      expect.objectContaining({
        title: 'Hot Cocoa',
        option_name: 'Color',
        option_value: 'Hot Cocoa',
        axis_kind: 'color',
        options: [{ name: 'Color', value: 'Hot Cocoa', axis_kind: 'color' }],
        source_quality_status: 'captured',
        label_image_url: 'https://example.com/hot-cocoa.jpg',
      }),
    );
  });

  test('preserves tinted shade variants with visual evidence', () => {
    const row = {
      id: 'eps_boj_dn350',
      external_product_id: 'ext_boj_dn350',
      canonical_url: 'https://example.com/products/tinted-fluid-sunscreen',
      destination_url: 'https://example.com/products/tinted-fluid-sunscreen',
      title: 'Daily Tinted Fluid Sunscreen',
      seed_data: {
        category: 'Sunscreen',
        product_type: 'Tinted Sunscreen',
        snapshot: {
          variants: [
            {
              id: 'v1',
              title: 'DN350',
              option_name: 'Shade',
              option_value: 'DN350',
              swatch_image_url: 'https://example.com/dn350-swatch.png',
            },
          ],
        },
      },
    };

    const variants = normalizeSeedVariants(row.seed_data, row);
    expect(variants[0]).toEqual(
      expect.objectContaining({
        title: 'DN350',
        option_name: 'Shade',
        option_value: 'DN350',
        axis_kind: 'shade',
        source_quality_status: 'captured',
        swatch_image_url: 'https://example.com/dn350-swatch.png',
        label_image_url: 'https://example.com/dn350-swatch.png',
      }),
    );
  });

  test('suppresses single Offer UPC variants from customer-facing options', () => {
    const [variant] = normalizeSeedVariants(
      {
        variants: [
          {
            variant_id: 'e3cf79a9b040',
            sku: '769915233636',
            title: '769915233636',
            option_name: 'Offer',
            option_value: '769915233636',
            price: '15.00',
            currency: 'USD',
          },
        ],
      },
      null,
    );

    expect(variant.title).toBe('Default');
    expect(variant.options).toEqual([]);
    expect(variant.option_name).toBeUndefined();
    expect(variant.option_value).toBeUndefined();
  });

  test('uses product-level size when a single Offer SKU variant is otherwise non-displayable', () => {
    const [variant] = normalizeSeedVariants(
      {
        snapshot: {
          size: '5ml',
        },
        variants: [
          {
            variant_id: 'e3cf79a9b040',
            sku: '769915233636',
            title: '769915233636',
            option_name: 'Offer',
            option_value: '769915233636',
            price: '11.47',
            currency: 'USD',
          },
        ],
      },
      {
        title: 'Multi-Peptide Lash and Brow Serum',
        canonical_url: 'https://theordinary.com/en-us/multi-peptide-lash-brow-serum-100111.html',
      },
    );

    expect(variant.title).toBe('5 mL');
    expect(variant.options).toEqual([
      expect.objectContaining({ name: 'Size', value: '5 mL', axis_kind: 'volume' }),
    ]);
    expect(variant.option_name).toBe('Size');
    expect(variant.option_value).toBe('5 mL');
  });

  test('prefers one primary product-level size value when metric and imperial evidence both exist', () => {
    const [variant] = normalizeSeedVariants(
      {
        snapshot: {
          volume: '15ml',
          product_volume: '0.50 fl oz',
        },
        variants: [
          {
            variant_id: 'rare-mini-default',
            sku: 'FGPAOP0002M4',
            title: 'Default Title',
            option_name: 'Title',
            option_value: 'Default Title',
            price: '17.00',
            currency: 'USD',
          },
        ],
      },
      {
        title: 'Always an Optimist Pore Diffusing Primer Mini',
        canonical_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
      },
    );

    expect(variant.options).toEqual([
      expect.objectContaining({ name: 'Size', value: '15 mL', axis_kind: 'volume' }),
    ]);
    expect(variant.option_name).toBe('Size');
    expect(variant.option_value).toBe('15 mL');
  });

  test('surfaces product-level size detail fields for single-SKU exact-item pages', () => {
    const product = buildExternalSeedProduct({
      id: 'seed_rare_mini',
      external_product_id: 'ext_rare_primer_mini',
      title: 'Always an Optimist Pore Diffusing Primer Mini',
      canonical_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
      destination_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
      seed_data: {
        brand: 'Rare Beauty',
        volume: '15ml',
        product_volume: '0.50 fl oz',
        size_detail_label: '0.50 fl oz / 15 mL',
        snapshot: {
          title: 'Always an Optimist Pore Diffusing Primer Mini',
          canonical_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
          destination_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
          volume: '15ml',
          product_volume: '0.50 fl oz',
          size_detail_label: '0.50 fl oz / 15 mL',
          variants: [
            {
              variant_id: 'rare-mini-default',
              sku: 'FGPAOP0002M4',
              title: 'Default Title',
              option_name: 'Title',
              option_value: 'Default Title',
              price: '17.00',
              currency: 'USD',
            },
          ],
        },
      },
    });

    expect(product.volume).toBe('15ml');
    expect(product.product_volume).toBe('0.50 fl oz');
    expect(product.size_detail_label).toBe('0.50 fl oz / 15 mL');
  });

  test('uses net weight evidence to surface a displayable single-SKU size variant', () => {
    const product = buildExternalSeedProduct({
      id: 'seed_medicube_red_succinic',
      external_product_id: 'ext_59522af9624198656cc8881b',
      title: '21% Red Succinic Acid Cleansing Booster Serum',
      canonical_url: 'https://medicube.us/products/red-succinic-acid-peel',
      destination_url: 'https://medicube.us/products/red-succinic-acid-peel',
      seed_data: {
        brand: 'Medicube',
        net_content: '40 g',
        net_size: '1.41 oz',
        size_detail_label: '1.41 oz / 40 g',
        snapshot: {
          title: '21% Red Succinic Acid Cleansing Booster Serum',
          canonical_url: 'https://medicube.us/products/red-succinic-acid-peel',
          destination_url: 'https://medicube.us/products/red-succinic-acid-peel',
          net_content: '40 g',
          net_size: '1.41 oz',
          size_detail_label: '1.41 oz / 40 g',
          variants: [
            {
              variant_id: '40118361587760',
              sku: 'PMEUS55003R00',
              title: 'SINGLE',
              options: [{ name: 'Option', value: 'SINGLE' }],
              option_name: 'Option',
              option_value: 'SINGLE',
              price: '20.50',
              currency: 'USD',
            },
          ],
        },
      },
    });

    expect(product.size_detail_label).toBe('1.41 oz / 40 g');
    expect(product.variants[0]).toEqual(
      expect.objectContaining({
        option_name: 'Size',
        option_value: '40 g',
        display_label: 'Size: 40 g',
      }),
    );
    expect(product.variants[0].hidden_from_selector).toBeUndefined();
  });

  test('keeps official cushion makeup shade variants displayable when variant images exist', () => {
    const product = buildExternalSeedProduct({
      id: 'seed_tirtir_ai_filter_cushion',
      external_product_id: 'ext_tirtir_ai_filter_cushion',
      title: 'Mask Fit AI Filter Cushion',
      canonical_url: 'https://tirtir.global/products/mask-fit-ai-filter-cushion',
      destination_url: 'https://tirtir.global/products/mask-fit-ai-filter-cushion',
      price_currency: 'USD',
      seed_data: {
        brand: 'TIRTIR',
        snapshot: {
          title: 'Mask Fit AI Filter Cushion',
          canonical_url: 'https://tirtir.global/products/mask-fit-ai-filter-cushion',
          variants: [
            {
              variant_id: '47265818738907',
              sku: '01TTF0513',
              title: '10C Shell',
              option_name: 'Color',
              option_value: '10C Shell',
              options: [{ name: 'Color', value: '10C Shell' }],
              price: 17.5,
              currency: 'USD',
              image_url:
                'https://cdn.shopify.com/s/files/1/0663/2757/6795/files/10c_83f91c40-e7ea-46f7-91b8-24397b84f87c.png?v=1770792602',
              image_urls: [
                'https://cdn.shopify.com/s/files/1/0663/2757/6795/files/10c_83f91c40-e7ea-46f7-91b8-24397b84f87c.png?v=1770792602',
              ],
            },
            {
              variant_id: '47265818771675',
              sku: '01TTF0514',
              title: '11C Cool Rosy',
              option_name: 'Color',
              option_value: '11C Cool Rosy',
              options: [{ name: 'Color', value: '11C Cool Rosy' }],
              price: 17.5,
              currency: 'USD',
              image_url:
                'https://cdn.shopify.com/s/files/1/0663/2757/6795/files/11c_ee18b7e5-3aba-4ff4-a87a-093d6351282c.png?v=1770792602',
              image_urls: [
                'https://cdn.shopify.com/s/files/1/0663/2757/6795/files/11c_ee18b7e5-3aba-4ff4-a87a-093d6351282c.png?v=1770792602',
              ],
            },
          ],
        },
      },
    });

    expect(product.variants).toHaveLength(2);
    expect(product.variants[0]).toEqual(
      expect.objectContaining({
        title: '10C Shell',
        option_name: 'Color',
        option_value: '10C Shell',
        axis_kind: 'color',
        display_label: 'Color: 10C Shell',
        source_quality_status: 'captured',
      }),
    );
  });

  test('keeps official cushion shade-range variants displayable for plural color option names', () => {
    const product = buildExternalSeedProduct({
      id: 'seed_tirtir_red_cushion_sachet',
      external_product_id: 'ext_tirtir_red_cushion_sachet',
      title: 'Mask Fit Red Cushion Sachet',
      canonical_url: 'https://tirtir.global/products/mask-fit-red-cushion-sachet',
      destination_url: 'https://tirtir.global/products/mask-fit-red-cushion-sachet',
      price_currency: 'USD',
      seed_data: {
        brand: 'TIRTIR',
        snapshot: {
          title: 'Mask Fit Red Cushion Sachet',
          canonical_url: 'https://tirtir.global/products/mask-fit-red-cushion-sachet',
          variants: [
            {
              variant_id: '47807976276187',
              sku: '99TTX0001',
              title: '10C - 17C',
              option_name: 'Colors',
              option_value: '10C - 17C',
              options: [{ name: 'Colors', value: '10C - 17C' }],
              price: 1.5,
              currency: 'USD',
              image_url:
                'https://cdn.shopify.com/s/files/1/0663/2757/6795/files/Artboard_1_copy_2x_24faeaca-162c-4ba1-9677-c20fdcb6648a.jpg?v=1760662695',
              image_urls: [
                'https://cdn.shopify.com/s/files/1/0663/2757/6795/files/Artboard_1_copy_2x_24faeaca-162c-4ba1-9677-c20fdcb6648a.jpg?v=1760662695',
              ],
            },
            {
              variant_id: '47807976308955',
              sku: '99TTX0002',
              title: '17N - 22C',
              option_name: 'Colors',
              option_value: '17N - 22C',
              options: [{ name: 'Colors', value: '17N - 22C' }],
              price: 1.5,
              currency: 'USD',
              image_url:
                'https://cdn.shopify.com/s/files/1/0663/2757/6795/files/Artboard_1_copy_2_2x_5607f8f3-6e44-49a2-b344-937b616584ee.jpg?v=1760662695',
              image_urls: [
                'https://cdn.shopify.com/s/files/1/0663/2757/6795/files/Artboard_1_copy_2_2x_5607f8f3-6e44-49a2-b344-937b616584ee.jpg?v=1760662695',
              ],
            },
          ],
        },
      },
    });

    expect(product.variants).toHaveLength(2);
    expect(product.variants[0]).toEqual(
      expect.objectContaining({
        title: '10C - 17C',
        option_name: 'Color',
        option_value: '10C - 17C',
        axis_kind: 'color',
        display_label: 'Color: 10C - 17C',
        source_quality_status: 'captured',
      }),
    );
  });

  test('infers product-level size detail labels from quantitative selected variant evidence', () => {
    const product = buildExternalSeedProduct({
      id: 'seed_rare_kit_mini',
      external_product_id: 'ext_rare_kit_mini',
      title: 'Find Comfort Mini Body Essentials - Awaken Confidence',
      canonical_url: 'https://rarebeauty.com/products/find-comfort-mini-body-essentials-awaken-confidence',
      destination_url: 'https://rarebeauty.com/products/find-comfort-mini-body-essentials-awaken-confidence',
      seed_data: {
        brand: 'Rare Beauty',
        snapshot: {
          title: 'Find Comfort Mini Body Essentials - Awaken Confidence',
          canonical_url: 'https://rarebeauty.com/products/find-comfort-mini-body-essentials-awaken-confidence',
          destination_url: 'https://rarebeauty.com/products/find-comfort-mini-body-essentials-awaken-confidence',
          variants: [
            {
              variant_id: 'rare-kit-mini-default',
              title: '75ml',
              option_name: 'Size',
              option_value: '75ml',
              price: '28.00',
              currency: 'USD',
            },
          ],
        },
      },
    });

    expect(product.size_detail_label).toBe('75 mL');
  });

  test('infers single default variant size from seed-level product URL', () => {
    const [variant] = normalizeSeedVariants(
      {
        snapshot: {
          variants: [
            {
              variant_id: '82170',
              sku: '82170',
              title: 'Default',
              option_name: 'Title',
              option_value: 'Default Title',
            },
          ],
        },
      },
      {
        title: 'Pixi + Hello Kitty Glow Tonic Original Size',
        canonical_url: 'https://pixibeauty.com/products/hello-kitty-glow-tonic-250ml',
      },
    );

    expect(variant.title).toBe('250 mL');
    expect(variant.options).toEqual([
      expect.objectContaining({ name: 'Size', value: '250 mL', axis_kind: 'volume' }),
    ]);
    expect(variant.option_name).toBe('Size');
    expect(variant.option_value).toBe('250 mL');
  });

  test('infers single default variant size from seed-level product image', () => {
    const [variant] = normalizeSeedVariants(
      {
        snapshot: {
          image_url:
            'https://cdn.shopify.com/s/files/1/0651/8449/7835/files/3264680025105-VN058001-VIEW-2-RDT-MOISTURISING-LOTION-400ML-2000x2000.jpg?v=1718290512',
          variants: [
            {
              variant_id: '44171552161963',
              sku: 'NXVN058001',
              title: 'Default',
              option_name: 'Title',
              option_value: 'Default Title',
            },
          ],
        },
      },
      {
        title: 'Revitalising Moisturising Milk',
        canonical_url: 'https://us.nuxe.com/products/revitalising-moisturising-milk',
      },
    );

    expect(variant.title).toBe('400 mL');
    expect(variant.options).toEqual([
      expect.objectContaining({ name: 'Size', value: '400 mL', axis_kind: 'volume' }),
    ]);
  });

  test('does not infer one seed-level image size across multiple polluted variants', () => {
    const variants = normalizeSeedVariants(
      {
        snapshot: {
          image_url:
            'https://theordinary.com/Images/products/The%20Ordinary/rdn-100pct-organic-cold-pressed-rose-hip-seed-oil-30ml.png',
          variants: [
            {
              variant_id: 'rose-hip',
              sku: 'rdn-100pct-organic-cold-pressed-rose-hip-seed-oil-30ml',
              title: '[object Object]',
              option_name: 'Offer',
              option_value: 'rdn-100pct-organic-cold-pressed-rose-hip-seed-oil-30ml',
            },
            {
              variant_id: 'marula',
              sku: 'rdn-100pct-cold-pressed-virgin-marula-oil-30ml',
              title: '[object Object]',
              option_name: 'Offer',
              option_value: 'rdn-100pct-cold-pressed-virgin-marula-oil-30ml',
            },
          ],
        },
      },
      {
        title: '100% Organic Virgin Chia Seed Oil',
        canonical_url: 'https://theordinary.com/en-us/100-organic-virgin-chia-seed-face-oil-100395.html',
      },
    );

    expect(variants).toHaveLength(2);
    expect(variants.every((variant) => variant.options.length === 0)).toBe(true);
  });

  test('normalizes merchant weight axes as displayable size variants', () => {
    const [variant] = normalizeSeedVariants(
      {
        variants: [
          {
            variant_id: '40061',
            sku: '40061',
            title: '12 oz',
            option_name: 'Weight',
            option_value: '12 oz',
            price: '38.00',
            currency: 'USD',
          },
        ],
      },
      {
        title: 'Ultra Repair Cream Intense Hydration Jumbo',
        canonical_url: 'https://www.firstaidbeauty.com/products/ultra-repair-cream-intense-hydration-12oz',
      },
    );

    expect(variant.title).toBe('12 oz');
    expect(variant.axis_kind).toBe('volume');
    expect(variant.options).toEqual([
      expect.objectContaining({ name: 'Size', value: '12 oz', axis_kind: 'volume' }),
    ]);
    expect(variant.option_name).toBe('Size');
    expect(variant.option_value).toBe('12 oz');
  });

  test('normalizes mask count variants as displayable pack options', () => {
    const variants = normalizeSeedVariants(
      {
        variants: [
          {
            variant_id: '40999586234416',
            sku: 'KUSMEA1208',
            title: '2 MASKS',
            option_name: 'Option',
            option_value: '2 MASKS',
            price: 6,
            currency: 'USD',
          },
          {
            variant_id: '40659691601968',
            sku: 'KUSMEA1205',
            title: '10+10 MASKS',
            option_name: 'Option',
            option_value: '10+10 MASKS',
            price: 60,
            currency: 'USD',
          },
        ],
      },
      {
        title: 'Deep Peptide Radiance Mask',
        canonical_url: 'https://medicube.us/products/medicube-deep-peptide-radiance-mask-2ea',
      },
    );

    expect(variants).toHaveLength(2);
    expect(variants[0]).toEqual(
      expect.objectContaining({
        title: '2 MASKS',
        axis_kind: 'pack',
        display_label: 'Pack: 2 MASKS',
        options: [expect.objectContaining({ name: 'Pack', value: '2 MASKS', axis_kind: 'pack' })],
      }),
    );
    expect(variants[1]).toEqual(
      expect.objectContaining({
        title: '10+10 MASKS',
        axis_kind: 'pack',
        display_label: 'Pack: 10+10 MASKS',
        options: [expect.objectContaining({ name: 'Pack', value: '10+10 MASKS', axis_kind: 'pack' })],
      }),
    );
  });

  test('splits merchant shade-size axes and suppresses non-tinted skincare shade noise', () => {
    const [variant] = normalizeSeedVariants(
      {
        variants: [
          {
            variant_id: '4100',
            title: 'Lemonade / 3 oz',
            option_name: 'Shade / Size',
            option_value: 'Lemonade / 3 oz',
            image_url: 'https://example.com/lemonade-scrub-3oz.jpg',
          },
        ],
      },
      {
        title: 'Lemonade Smoothing Scrub',
        canonical_url: 'https://www.olehenriksen.com/products/lemonade-smoothing-scrub-3oz',
      },
    );

    expect(variant.title).toBe('3 oz');
    expect(variant.options).toEqual([
      expect.objectContaining({ name: 'Size', value: '3 oz', axis_kind: 'volume' }),
    ]);
    expect(variant.option_name).toBe('Size');
    expect(variant.option_value).toBe('3 oz');
  });

  test('keeps shade-size axes for tinted products with variant imagery', () => {
    const [variant] = normalizeSeedVariants(
      {
        variants: [
          {
            variant_id: '52402575475060',
            title: 'DN350 / 50ml',
            option_name: 'Shade / Size',
            option_value: 'DN350 / 50ml',
            image_url: 'https://example.com/daily-tinted-fluid-sunscreen-dn350.jpg',
          },
        ],
      },
      {
        title: 'Daily Tinted Fluid Sunscreen DN350',
        canonical_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
      },
    );

    expect(variant.title).toBe('DN350 / 50 mL');
    expect(variant.options).toEqual([
      expect.objectContaining({ name: 'Shade', value: 'DN350', axis_kind: 'shade' }),
      expect.objectContaining({ name: 'Size', value: '50 mL', axis_kind: 'volume' }),
    ]);
    expect(variant.option_name).toBeUndefined();
    expect(variant.option_value).toBeUndefined();
  });

  test('treats merchant mini and standard descriptors on color-size axes as size, not format', () => {
    const variants = normalizeSeedVariants(
      {
        variants: [
          {
            variant_id: '39448095064109',
            title: 'Hot Cherry / Standard',
            option_name: 'Color / Size',
            option_value: 'Hot Cherry / Standard',
            image_url: 'https://example.com/fenty-hot-cherry-standard.jpg',
          },
          {
            variant_id: '44008575860781',
            title: 'Hot Cherry / Mini',
            option_name: 'Color / Size',
            option_value: 'Hot Cherry / Mini',
            image_url: 'https://example.com/fenty-hot-cherry-mini.jpg',
          },
        ],
      },
      {
        title: 'Gloss Bomb Heat Universal Lip Luminizer + Plumper - Hot Cherry',
        canonical_url: 'https://fentybeauty.com/products/gloss-bomb-heat-universal-lip-luminizer-plumper',
      },
    );

    expect(variants[1].title).toBe('Hot Cherry / Mini');
    expect(variants[1].options).toEqual([
      expect.objectContaining({ name: 'Color', value: 'Hot Cherry', axis_kind: 'color' }),
      expect.objectContaining({ name: 'Size', value: 'Mini', axis_kind: 'size' }),
    ]);
    expect(variants[1].option_name).toBeUndefined();
    expect(variants[1].option_value).toBeUndefined();
    expect(variants[1].display_label).toBeUndefined();
    expect(variants[1].options).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Format', value: 'Mini' })]),
    );
  });

  test('keeps real generic option axes such as refill selectable', () => {
    const variants = normalizeSeedVariants(
      {
        variants: [
          {
            variant_id: '41148734668848',
            title: 'Extreme Cream',
            option_name: 'Option',
            option_value: 'Full Size',
          },
          {
            variant_id: '41148734701616',
            title: 'Extreme Cream',
            option_name: 'Option',
            option_value: 'Refill',
          },
        ],
      },
      null,
    );

    expect(variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variant_id: '41148734668848',
          options: [expect.objectContaining({ name: 'Format', value: 'Full Size', axis_kind: 'format' })],
          option_name: 'Format',
          option_value: 'Full Size',
        }),
        expect.objectContaining({
          variant_id: '41148734701616',
          options: [expect.objectContaining({ name: 'Format', value: 'Refill', axis_kind: 'format' })],
          option_name: 'Format',
          option_value: 'Refill',
        }),
      ]),
    );
  });

  test('infers selected variant from destination url variant token for external seeds', () => {
    const row = {
      id: 'eps_guerlain_variant_1',
      canonical_url:
        'https://www.guerlain.com/us/en-us/p/kisskiss-bee-glow-98-naturally-derived%C2%B9-honey-tint-balm-P043570.html',
      destination_url:
        'https://www.guerlain.com/us/en-us/p/kisskiss-bee-glow-98-naturally-derived%C2%B9-honey-tint-balm-P043570.html?v=G043573',
      title: 'KISSKISS BEE GLOW 98% naturally-derived¹ honey tint balm',
      image_url:
        'https://www.guerlain.com/dw/image/v2/BDCZ_PRD/on/demandware.static/-/Sites-GSA_master_catalog/default/dw5c71e8b1/01-ProductsViewer/P043570/P043570_G043573_E01_hi-res.jpg?sw=655&sh=655&sfrm=png',
      price_amount: 43,
      price_currency: 'USD',
      seed_data: {
        brand: 'Guerlain',
        title: 'KISSKISS BEE GLOW 98% naturally-derived¹ honey tint balm',
        snapshot: {
          canonical_url:
            'https://www.guerlain.com/us/en-us/p/kisskiss-bee-glow-98-naturally-derived%C2%B9-honey-tint-balm-P043570.html',
          destination_url:
            'https://www.guerlain.com/us/en-us/p/kisskiss-bee-glow-98-naturally-derived%C2%B9-honey-tint-balm-P043570.html?v=G043573',
          image_url:
            'https://www.guerlain.com/dw/image/v2/BDCZ_PRD/on/demandware.static/-/Sites-GSA_master_catalog/default/dw5c71e8b1/01-ProductsViewer/P043570/P043570_G043573_E01_hi-res.jpg?sw=655&sh=655&sfrm=png',
          variants: [
            {
              variant_id: 'c3e266edb7ea',
              sku: 'G043573',
              option_name: 'Variant',
              option_value: '775 POPPY GLOW',
              price: '43.00',
              currency: 'USD',
              image_url:
                'https://www.guerlain.com/dw/image/v2/BDCZ_PRD/on/demandware.static/-/Sites-GSA_master_catalog/default/dw5c71e8b1/01-ProductsViewer/P043570/P043570_G043573_E01_hi-res.jpg?sw=655&sh=655&sfrm=png',
            },
            {
              variant_id: 'd9bb32e25d40',
              sku: 'G043569',
              option_name: 'Variant',
              option_value: '309 HONEY GLOW',
              price: '43.00',
              currency: 'USD',
              image_url:
                'https://www.guerlain.com/dw/image/v2/BDCZ_PRD/on/demandware.static/-/Sites-GSA_master_catalog/default/dw2a0b267a/01-ProductsViewer/P043570/P043569_E01_hi-res.jpg?sw=655&sh=655&sfrm=png',
            },
          ],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.selected_variant_id).toBe('c3e266edb7ea');
    expect(product.default_variant_id).toBe('c3e266edb7ea');
    expect(product.variant_title).toBe('775 POPPY GLOW');
    expect(product.variants[0]).toEqual(
      expect.objectContaining({
        variant_id: 'c3e266edb7ea',
        title: '775 POPPY GLOW',
      }),
    );
  });

  test('does not infer selected variant when image and price signals conflict without an explicit hint', () => {
    const row = {
      id: 'eps_innbeauty_conflict_1',
      canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
      destination_url: 'https://innbeautyproject.com/products/extreme-cream',
      title: 'Extreme Cream',
      image_url:
        'https://cdn.shopify.com/s/files/1/0261/0108/8304/files/Extremecream01_hero.jpg?v=1',
      price_amount: 44,
      price_currency: 'USD',
      seed_data: {
        brand: 'INNBEAUTY Project',
        title: 'Extreme Cream',
        snapshot: {
          canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
          destination_url: 'https://innbeautyproject.com/products/extreme-cream',
          image_url:
            'https://cdn.shopify.com/s/files/1/0261/0108/8304/files/Extremecream01_hero.jpg?v=1',
          variants: [
            {
              variant_id: '41148734668848',
              sku: '0190',
              option_name: 'Option',
              option_value: 'Full Size',
              price: '50.00',
              currency: 'USD',
              image_url:
                'https://cdn.shopify.com/s/files/1/0261/0108/8304/files/Extremecream01_hero.jpg?v=1',
            },
            {
              variant_id: '41148734701616',
              sku: '0191',
              option_name: 'Option',
              option_value: 'Refill',
              price: '44.00',
              currency: 'USD',
              image_url:
                'https://cdn.shopify.com/s/files/1/0261/0108/8304/files/Extremecream_refill.jpg?v=1',
            },
          ],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.selected_variant_id).toBeUndefined();
    expect(product.default_variant_id).toBeUndefined();
    expect(product.variant_title).toBeUndefined();
  });

  test('splits combined color and size seed options and normalizes stale shopify image urls', () => {
    const row = {
      id: 'eps_combined_color_size_1',
      canonical_url: 'https://example.com/p/combined-color-size',
      destination_url: 'https://example.com/p/combined-color-size',
      title: 'Combined Color Size Product',
      seed_data: {
        snapshot: {
          product: {
            options: [{ name: 'Color / Size' }],
            variants: [
              {
                id: 'SKU-35',
                sku: 'SKU-35',
                option1: '35 Rose Topaz / 8.0 g',
                image_url:
                  'https://cdn.shopify.com/s/files/1/2139/2967/files/Rose_Topaz_1200_4ee4c5e8-a218-4e0a-8af8-2db3c98f0c79.png?v=1750422282',
                price: '39.00',
                currency: 'USD',
                stock: 'In Stock',
              },
            ],
          },
        },
      },
    };

    const variants = normalizeSeedVariants(row.seed_data, row);
    expect(variants).toHaveLength(1);
    expect(variants[0].options).toEqual([
      expect.objectContaining({ name: 'Color', value: '35 Rose Topaz', axis_kind: 'color' }),
      expect.objectContaining({ name: 'Size', value: '8.0 g', axis_kind: 'volume' }),
    ]);
    expect(variants[0].image_url).toBe(
      'https://cdn.shopify.com/s/files/1/2139/2967/files/Rose_Topaz_1200_4ee4c5e8-a218-4e0a-8af8-2db3c98f0c79.png?v=1750422282',
    );
  });

  test('narrows polluted variant image galleries back to the active shade family', () => {
    const row = {
      id: 'eps_variant_gallery_pollution_1',
      canonical_url: 'https://example.com/p/tom-ford-lip-color',
      destination_url: 'https://example.com/p/tom-ford-lip-color',
      title: 'Lip Color Satin Matte',
      seed_data: {
        snapshot: {
          product: {
            options: [{ name: 'Color / Size' }],
            variants: [
              {
                id: 'SKU-T1QT01',
                sku: 'SKU-T1QT01',
                option1: '35 Rose Topaz / 8.0 g',
                image_url: 'https://sdcdn.io/tf/tf_sku_T1QT01_2000x2000_1.jpg?height=700&width=700',
                image_urls: [
                  'https://sdcdn.io/tf/tf_sku_T1QT01_2000x2000_1.jpg?height=700&width=700',
                  'https://sdcdn.io/tf/tf_sku_T1QT01_2000x2000_2.jpg?height=700&width=700',
                  'https://sdcdn.io/tf/tf_sku_T1QS01_2000x2000_1.jpg?height=700&width=700',
                ],
                price: '39.00',
                currency: 'USD',
                stock: 'In Stock',
              },
              {
                id: 'SKU-T1QS01',
                sku: 'SKU-T1QS01',
                option1: '36 Tiger Eye / 8.0 g',
                image_url: 'https://sdcdn.io/tf/tf_sku_T1QS01_2000x2000_1.jpg?height=700&width=700',
                image_urls: [
                  'https://sdcdn.io/tf/tf_sku_T1QS01_2000x2000_1.jpg?height=700&width=700',
                  'https://sdcdn.io/tf/tf_sku_T1QS01_2000x2000_2.jpg?height=700&width=700',
                  'https://sdcdn.io/tf/tf_sku_T1QT01_2000x2000_1.jpg?height=700&width=700',
                ],
                price: '39.00',
                currency: 'USD',
                stock: 'In Stock',
              },
            ],
          },
        },
      },
    };

    const variants = normalizeSeedVariants(row.seed_data, row);
    expect(variants).toHaveLength(2);
    expect(variants[0].images).toEqual([
      'https://sdcdn.io/tf/tf_sku_T1QT01_2000x2000_1.jpg',
      'https://sdcdn.io/tf/tf_sku_T1QT01_2000x2000_2.jpg',
    ]);
    expect(variants[1].images).toEqual([
      'https://sdcdn.io/tf/tf_sku_T1QS01_2000x2000_1.jpg',
      'https://sdcdn.io/tf/tf_sku_T1QS01_2000x2000_2.jpg',
    ]);

    const product = buildExternalSeedProduct(row);
    expect(product.variants[0].images).toEqual([
      'https://sdcdn.io/tf/tf_sku_T1QT01_2000x2000_1.jpg',
      'https://sdcdn.io/tf/tf_sku_T1QT01_2000x2000_2.jpg',
    ]);
    expect(product.variants[1].images).toEqual([
      'https://sdcdn.io/tf/tf_sku_T1QS01_2000x2000_1.jpg',
      'https://sdcdn.io/tf/tf_sku_T1QS01_2000x2000_2.jpg',
    ]);
  });

  test('canonicalizes legacy variant containers into snapshot variants and strips legacy copies', () => {
    const seedData = {
      variants: [
        {
          id: 'SKU-WIX-1',
          sku: 'SKU-WIX-1',
          option_name: 'Size',
          option_value: '30ml',
          price: '24.00',
          currency: 'USD',
        },
      ],
      product: {
        variants: [
          {
            id: 'SKU-WIX-2',
            sku: 'SKU-WIX-2',
            option_name: 'Size',
            option_value: '50ml',
            price: '30.00',
            currency: 'USD',
          },
        ],
      },
      snapshot: {},
    };

    const out = canonicalizeExternalSeedSnapshot(seedData, { id: 'eps_legacy_variant_1' }, { stripLegacy: true });
    expect(out.snapshot.variants).toHaveLength(1);
    expect(out.snapshot.variants[0]).toEqual(
      expect.objectContaining({
        sku: 'SKU-WIX-1',
        options: [expect.objectContaining({ name: 'Size', value: '30 mL', axis_kind: 'volume' })],
      }),
    );
    expect(out.variants).toBeUndefined();
    expect(out.product.variants).toBeUndefined();
  });

  test('prefers snapshot fields and keeps stock unknown when variants are unknown', () => {
    const row = {
      id: 'eps_2',
      canonical_url: 'https://example.com/p/stale-row',
      destination_url: 'https://example.com/p/stale-row',
      title: 'Stale Seed Title',
      description: 'Stale row description',
      seed_data: {
        title: 'Even Older Seed Title',
        description: 'Old seed description',
        image_url: 'https://example.com/seed.jpg',
        snapshot: {
          canonical_url: 'https://example.com/p/canonical-product',
          destination_url: 'https://example.com/p/canonical-product',
          title: 'Snapshot Product Title',
          description: 'Snapshot description',
          image_url: 'https://example.com/snapshot.jpg',
          variants: [
            {
              sku: 'SKU-UNKNOWN',
              variant_id: 'SKU-UNKNOWN',
              price: '28.00',
              currency: 'USD',
            },
          ],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.title).toBe('Snapshot Product Title');
    expect(product.description).toBe('Snapshot description');
    expect(product.canonical_url).toBe('https://example.com/p/canonical-product');
    expect(product.image_url).toBe('https://example.com/snapshot.jpg');
    expect(product.in_stock).toBeNull();
    expect(product.inventory_quantity).toBeNull();
  });

  test('marks product out of stock when every variant is explicitly unavailable', () => {
    const row = {
      id: 'eps_3',
      canonical_url: 'https://example.com/p/oos-product',
      destination_url: 'https://example.com/p/oos-product',
      seed_data: {
        title: 'All OOS Product',
        snapshot: {
          canonical_url: 'https://example.com/p/oos-product',
          variants: [
            {
              sku: 'SKU-OOS-1',
              variant_id: 'SKU-OOS-1',
              price: '19.00',
              currency: 'USD',
              stock: 'Out of Stock',
            },
            {
              sku: 'SKU-OOS-2',
              variant_id: 'SKU-OOS-2',
              price: '21.00',
              currency: 'USD',
              inventory_quantity: 0,
            },
          ],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.in_stock).toBe(false);
    expect(product.inventory_quantity).toBe(0);
    expect(product.variants.every((variant) => variant.in_stock === false)).toBe(true);
  });

  test('availabilityToInStock no longer treats unknown availability as in stock', () => {
    expect(availabilityToInStock(null)).toBeNull();
    expect(availabilityToInStock('In Stock')).toBe(true);
    expect(availabilityToInStock('Out of Stock')).toBe(false);
  });

  test('builds lightweight brand-search products without deep variant expansion', () => {
    const row = {
      id: 'eps_fenty_1',
      external_product_id: 'ext_fenty_1',
      canonical_url: 'https://fentybeauty.com/products/gloss-bomb',
      destination_url: 'https://fentybeauty.com/products/gloss-bomb',
      domain: 'fentybeauty.com',
      title: 'Gloss Bomb Universal Lip Luminizer',
      image_url: 'https://example.com/fenty.jpg',
      price_amount: '22.00',
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'Fenty Beauty',
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/gloss-bomb',
          title: 'Gloss Bomb Universal Lip Luminizer',
          image_url: 'https://example.com/fenty.jpg',
        },
      },
    };

    const product = buildExternalSeedBrandSearchProduct(row);
    expect(product).toEqual(
      expect.objectContaining({
        id: 'ext_fenty_1',
        merchant_id: 'external_seed',
        brand: 'Fenty Beauty',
        vendor: 'Fenty Beauty',
        title: 'Gloss Bomb Universal Lip Luminizer',
        canonical_url: 'https://fentybeauty.com/products/gloss-bomb',
        destination_url: 'https://fentybeauty.com/products/gloss-bomb',
        image_url: 'https://example.com/fenty.jpg',
        in_stock: true,
      }),
    );
    expect(product.variants).toBeUndefined();
  });

  test('falls back to configured manual image overrides when a seed has no stored images', () => {
    const row = {
      id: 'eps_patyka_duo',
      canonical_url: 'https://patyka.com/products/duo-mousse-nettoyante-detox-boutique-spa',
      destination_url: 'https://patyka.com/products/duo-mousse-nettoyante-detox-boutique-spa',
      domain: 'patyka.com',
      title: 'Duo Mousse Nettoyante Detox - BOUTIQUE SPA',
      seed_data: {
        brand: 'Patyka',
        snapshot: {
          canonical_url: 'https://patyka.com/products/duo-mousse-nettoyante-detox-boutique-spa',
          variants: [
            {
              sku: 'P0029-P0039',
              variant_id: 'P0029-P0039',
              price: '23.85',
              currency: 'EUR',
              stock: 'In Stock',
            },
          ],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.image_url).toBe(
      'https://cdn.shopify.com/s/files/1/2139/2967/files/Duo_Mousse_Nettoyante_Detox_-_Packshot.jpg?v=1750422282',
    );
    expect(product.images.length).toBeGreaterThan(1);
    expect(product.variants[0]).toEqual(
      expect.objectContaining({
        image_url:
          'https://cdn.shopify.com/s/files/1/2139/2967/files/Duo_Mousse_Nettoyante_Detox_-_Packshot.jpg?v=1750422282',
      }),
    );
  });

  test('projects reviewed structured ingredient ids onto external seed products', () => {
    const row = {
      id: 'eps_ord_1',
      canonical_url: 'https://example.com/p/niacinamide-serum',
      destination_url: 'https://example.com/p/niacinamide-serum',
      title: 'Niacinamide Serum',
      seed_data: {
        category: 'Serum',
        reviewed_ingredient_ids: ['Niacinamide', 'zinc_pca', 'Niacinamide'],
        snapshot: {
          canonical_url: 'https://example.com/p/niacinamide-serum',
          title: 'Niacinamide Serum',
          variants: [],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.ingredient_ids).toEqual(['niacinamide', 'zinc_pca']);
  });

  test('normalizes hyaluronic, peptide, and salicylic aliases onto canonical ingredient ids', () => {
    const row = {
      id: 'eps_multi_alias_1',
      canonical_url: 'https://example.com/p/hydrating-peptide-serum',
      destination_url: 'https://example.com/p/hydrating-peptide-serum',
      title: 'Hydrating Peptide Serum',
      seed_data: {
        category: 'Serum',
        reviewed_ingredient_ids: ['Hyaluronic', 'sodium hyaluronate', 'Copper Peptide', 'peptides', 'Salicylic'],
        snapshot: {
          canonical_url: 'https://example.com/p/hydrating-peptide-serum',
          title: 'Hydrating Peptide Serum',
          variants: [],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.ingredient_ids).toEqual(['hyaluronic_acid', 'peptides', 'salicylic_acid']);
  });

  test('infers skincare serum category from canonical url when explicit seed category is missing', () => {
    const row = {
      id: 'eps_ord_hyaluronic',
      canonical_url: 'https://theordinary.com/en-us/hyaluronic-acid-2-b5-serum-with-ceramides-100637.html',
      destination_url: 'https://theordinary.com/en-us/hyaluronic-acid-2-b5-serum-with-ceramides-100637.html',
      title: 'Hyaluronic Acid 2% + B5 (with Ceramides)',
      seed_data: {
        reviewed_ingredient_ids: ['hyaluronic_acid', 'panthenol'],
        snapshot: {
          canonical_url: 'https://theordinary.com/en-us/hyaluronic-acid-2-b5-serum-with-ceramides-100637.html',
          title: 'Hyaluronic Acid 2% + B5 (with Ceramides)',
          variants: [],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.category).toBe('Serum');
    expect(product.product_type).toBe('Serum');
    expect(product.ingredient_ids).toEqual(['hyaluronic_acid', 'panthenol']);
  });

  test('infers serum category for strong active solution skincare products', () => {
    const row = {
      id: 'eps_salicylic_solution',
      canonical_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
      destination_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
      title: 'Salicylic Acid 2% Solution',
      availability: 'in_stock',
      seed_data: {
        reviewed_ingredient_ids: ['Salicylic Acid'],
        snapshot: {
          canonical_url:
            'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
          title: 'Salicylic Acid 2% Solution',
          variants: [],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.ingredient_ids).toEqual(['salicylic_acid']);
    expect(product.product_type).toBe('Serum');
    expect(product.category).toBe('Serum');
  });

  test('builds recommendation candidates from lean external rows without full seed_data hydration', () => {
    const row = {
      id: 'eps_lean_tom_ford',
      external_product_id: 'ext_lean_tom_ford_serum',
      canonical_url: 'https://www.tomfordbeauty.com/products/tom-ford-research-serum-concentrate',
      destination_url: 'https://www.tomfordbeauty.com/products/tom-ford-research-serum-concentrate',
      domain: 'www.tomfordbeauty.com',
      title: 'TOM FORD RESEARCH Serum Concentrate',
      image_url: 'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png',
      price_amount: 100,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_brand: 'Tom Ford Beauty',
      seed_category: '',
      seed_product_type: '',
      seed_description: 'A concentrated treatment serum.',
    };

    const product = buildExternalSeedProduct(row);
    expect(product).toEqual(
      expect.objectContaining({
        product_id: 'ext_lean_tom_ford_serum',
        merchant_id: 'external_seed',
        brand: 'Tom Ford Beauty',
        vendor: 'Tom Ford Beauty',
        category: 'Serum',
        product_type: 'Serum',
        description: 'A concentrated treatment serum.',
      }),
    );
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0]).toEqual(
      expect.objectContaining({
        variant_id: 'ext_lean_tom_ford_serum',
        image_url: expect.stringContaining('tf_sku_T93Y01_2000x2000_0'),
      }),
    );
  });

  test('normalizes cents-style Shopify bundle pricing and infers hair care category', () => {
    const row = {
      id: 'eps_fenty_hair_bundle',
      external_product_id: 'ext_fenty_hair_bundle',
      canonical_url: 'https://fentybeauty.com/products/deep-moisture-repair-the-maintenance-crew-full-size-bundle',
      destination_url: 'https://fentybeauty.com/products/deep-moisture-repair-the-maintenance-crew-full-size-bundle',
      domain: 'fentybeauty.com',
      title: 'Deep Moisture Repair The Maintenance Crew Full-Size Bundle',
      price_amount: 12100,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_brand: 'Fenty Beauty',
      seed_data: {
        brand: 'Fenty Beauty',
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/deep-moisture-repair-the-maintenance-crew-full-size-bundle',
          description:
            'Unlock endless styles with The Maintenance Crew. Essentials repair and nourish hair, now with our deep conditioner for extra hydration.',
          variants: [
            {
              sku: 'KFH10000005',
              variant_id: 'KFH10000005',
              price: '12100.00',
              currency: 'USD',
            },
          ],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.price).toBe(121);
    expect(product.variants[0].price).toBe(121);
    expect(product.category).toBe('Hair Care');
    expect(product.product_type).toBe('Hair Care');
  });

  test('normalizes cents-style acne treatment pricing and infers treatment category', () => {
    const row = {
      id: 'eps_fenty_bha_treatment',
      external_product_id: 'ext_fenty_bha_treatment',
      canonical_url: 'https://fentybeauty.com/products/blemish-defeatr-bha-spot-targeting-gel',
      destination_url: 'https://fentybeauty.com/products/blemish-defeatr-bha-spot-targeting-gel',
      domain: 'fentybeauty.com',
      title: "Blemish Defeat'r BHA Spot-Targeting Gel",
      price_amount: 2500,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_brand: 'Fenty Beauty',
      seed_data: {
        brand: 'Fenty Beauty',
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/blemish-defeatr-bha-spot-targeting-gel',
          description:
            "Discover Fenty Skin's Salicylic Acid spot-targeting gel fights blemishes, clarifies skin and reduces surface oil.",
          variants: [
            {
              sku: 'FKS10000020',
              variant_id: 'FKS10000020',
              price: '2500.00',
              currency: 'USD',
            },
          ],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.price).toBe(25);
    expect(product.variants[0].price).toBe(25);
    expect(product.category).toBe('Treatment');
    expect(product.product_type).toBe('Treatment');
  });

  test('preserves KRW whole-unit beauty prices instead of treating them as cents', () => {
    const row = {
      id: 'eps_round_lab_dokdo_cream',
      external_product_id: 'ext_round_lab_dokdo_cream',
      canonical_url: 'https://roundlab.co.kr/product/1025-dokdo-cream-80ml/24/',
      destination_url: 'https://roundlab.co.kr/product/1025-dokdo-cream-80ml/24/',
      domain: 'roundlab.co.kr',
      title: '1025 Dokdo Cream 80ml',
      price_amount: 25600,
      price_currency: 'KRW',
      availability: 'in_stock',
      seed_brand: 'Round Lab',
      seed_data: {
        brand: 'Round Lab',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        snapshot: {
          canonical_url: 'https://roundlab.co.kr/product/1025-dokdo-cream-80ml/24/',
          variants: [
            {
              sku: 'RL-DOKDO-CREAM-80',
              variant_id: 'RL-DOKDO-CREAM-80',
              price: '25600.00',
              currency: 'KRW',
            },
          ],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.price).toBe(25600);
    expect(product.currency).toBe('KRW');
    expect(product.variants[0].price).toBe(25600);
    expect(product.variants[0].pricing.current).toEqual({
      amount: 25600,
      currency: 'KRW',
    });
  });

  test('preserves JPY whole-unit beauty prices instead of treating them as cents', () => {
    const row = {
      id: 'eps_biore_uv_essence',
      external_product_id: 'ext_biore_uv_essence',
      canonical_url: 'https://www.kao-kirei.com/ja/item/khg/bioresarasarauv/4901301413246/',
      destination_url: 'https://www.kao-kirei.com/ja/item/khg/bioresarasarauv/4901301413246/',
      domain: 'kao-kirei.com',
      title: 'Biore UV Aqua Rich Watery Essence SPF 50+',
      price_amount: 1980,
      price_currency: 'JPY',
      availability: 'in_stock',
      seed_brand: 'Biore UV',
      seed_data: {
        brand: 'Biore UV',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        snapshot: {
          canonical_url: 'https://www.kao-kirei.com/ja/item/khg/bioresarasarauv/4901301413246/',
          variants: [
            {
              sku: 'BIORE-UV-ESSENCE',
              variant_id: 'BIORE-UV-ESSENCE',
              price: '1980.00',
              currency: 'JPY',
            },
          ],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.price).toBe(1980);
    expect(product.currency).toBe('JPY');
    expect(product.variants[0].price).toBe(1980);
    expect(product.variants[0].pricing.current).toEqual({
      amount: 1980,
      currency: 'JPY',
    });
  });

  test('prefers cleanser intent over generic concentrate terms for lean recommendation candidates', () => {
    const row = {
      id: 'eps_lean_tom_ford_cleanser',
      external_product_id: 'ext_lean_tom_ford_cleanser',
      canonical_url: 'https://www.tomfordbeauty.com/products/tom-ford-research-cleansing-concentrate',
      destination_url: 'https://www.tomfordbeauty.com/products/tom-ford-research-cleansing-concentrate',
      domain: 'www.tomfordbeauty.com',
      title: 'TOM FORD RESEARCH Cleansing Concentrate',
      seed_brand: 'Tom Ford Beauty',
      seed_category: '',
      seed_product_type: '',
    };

    const product = buildExternalSeedProduct(row);
    expect(product.category).toBe('Cleanser');
    expect(product.product_type).toBe('Cleanser');
  });

  test('overrides polluted cleanser category when title/url are not cleanser-like and description is serum-like', () => {
    const row = {
      id: 'eps_krave_oil_lala_like',
      external_product_id: 'ext_krave_oil_lala_like',
      canonical_url: 'https://kravebeauty.com/products/oil-la-la',
      destination_url: 'https://kravebeauty.com/products/oil-la-la',
      domain: 'kravebeauty.com',
      title: 'Oil La La',
      seed_brand: 'KraveBeauty',
      seed_category: 'Cleanser',
      seed_product_type: 'Cleanser',
      seed_description:
        'This serum helps balance breakout-prone skin and layers well with other skincare products. Apply before using your moisturizer.',
    };

    const product = buildExternalSeedProduct(row);
    expect(product.category).toBe('Serum');
    expect(product.product_type).toBe('Serum');
  });

  test('does not infer serum from fragrance marketing copy on lean recommendation candidates', () => {
    const row = {
      id: 'eps_lean_grey_vetiver',
      external_product_id: 'ext_lean_grey_vetiver',
      canonical_url: 'https://www.tomfordbeauty.com/products/grey-vetiver-parfum',
      destination_url: 'https://www.tomfordbeauty.com/products/grey-vetiver-parfum',
      domain: 'www.tomfordbeauty.com',
      title: 'Grey Vetiver Parfum',
      seed_brand: 'Tom Ford Beauty',
      seed_category: '',
      seed_product_type: '',
      seed_description:
        'With its elegant and refined heart of natural vetiver, Grey Vetiver captures the essence of debonair masculinity.',
    };

    const product = buildExternalSeedProduct(row);
    expect(product.category).toBe('Fragrance');
    expect(product.product_type).toBe('Fragrance');
    expect(product.description).toContain('essence of debonair masculinity');
  });

  test('infers beauty makeup categories for lean recommendation candidates', () => {
    const rows = [
      {
        id: 'eps_lean_concealer',
        external_product_id: 'ext_lean_concealer',
        canonical_url: 'https://www.tomfordbeauty.com/products/shade-and-illuminate-concealer',
        destination_url: 'https://www.tomfordbeauty.com/products/shade-and-illuminate-concealer',
        domain: 'www.tomfordbeauty.com',
        title: 'Shade and Illuminate Concealer',
        seed_brand: 'Tom Ford Beauty',
      },
      {
        id: 'eps_lean_lipstick',
        external_product_id: 'ext_lean_lipstick',
        canonical_url: 'https://www.tomfordbeauty.com/products/liquid-lip-luxe-matte',
        destination_url: 'https://www.tomfordbeauty.com/products/liquid-lip-luxe-matte',
        domain: 'www.tomfordbeauty.com',
        title: 'Liquid Lip Luxe Matte',
        seed_brand: 'Tom Ford Beauty',
      },
      {
        id: 'eps_lean_mascara',
        external_product_id: 'ext_lean_mascara',
        canonical_url: 'https://www.tomfordbeauty.com/products/extreme-mascara',
        destination_url: 'https://www.tomfordbeauty.com/products/extreme-mascara',
        domain: 'www.tomfordbeauty.com',
        title: 'Extreme Mascara',
        seed_brand: 'Tom Ford Beauty',
      },
      {
        id: 'eps_lean_brow',
        external_product_id: 'ext_lean_brow',
        canonical_url: 'https://www.tomfordbeauty.com/products/architecture-brow-pencil',
        destination_url: 'https://www.tomfordbeauty.com/products/architecture-brow-pencil',
        domain: 'www.tomfordbeauty.com',
        title: 'Architecture Brow Pencil',
        seed_brand: 'Tom Ford Beauty',
      },
      {
        id: 'eps_lean_powder',
        external_product_id: 'ext_lean_powder',
        canonical_url: 'https://www.tomfordbeauty.com/products/architecture-soft-matte-blurring-powder',
        destination_url: 'https://www.tomfordbeauty.com/products/architecture-soft-matte-blurring-powder',
        domain: 'www.tomfordbeauty.com',
        title: 'Architecture Soft Matte Blurring Powder',
        seed_brand: 'Tom Ford Beauty',
        seed_description:
          'Apply with Foundation Brush 02 for a diffused finish. This soft matte blurring powder helps control shine.',
      },
    ];

    const categories = rows.map((row) => buildExternalSeedProduct(row).category);
    expect(categories).toEqual(['Concealer', 'Lipstick', 'Mascara', 'Brow Pencil', 'Powder']);
  });

  test('prefers title and canonical signals over polluted description text when inferring category', () => {
    const row = {
      id: 'eps_lean_eyeshadow',
      external_product_id: 'ext_lean_eyeshadow',
      canonical_url: 'https://www.sigmabeauty.com/products/ambiance-eyeshadow-palette',
      destination_url: 'https://www.sigmabeauty.com/products/ambiance-eyeshadow-palette',
      domain: 'www.sigmabeauty.com',
      title: 'Ambiance Eyeshadow Palette',
      seed_brand: 'Sigma Beauty',
      seed_description:
        'Complete the look with our matching shader brush and soft bristle brush set for seamless blending.',
    };

    const product = buildExternalSeedProduct(row);
    expect(product.product_family).toBe('single_formula');
    expect(product.category).toBe('Eyeshadow');
    expect(product.product_type).toBe('Eyeshadow');
  });

  test('keeps setting powder as a single formula instead of a set PDP', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_setting_powder',
      external_product_id: 'ext_setting_powder',
      canonical_url: 'https://fentybeauty.com/products/invisimatte-instant-setting-blotting-powder',
      destination_url: 'https://fentybeauty.com/products/invisimatte-instant-setting-blotting-powder',
      domain: 'fentybeauty.com',
      title: 'Invisimatte Instant Setting + Blotting Powder',
      seed_data: {
        brand: 'Fenty Beauty',
        snapshot: {},
      },
    });

    expect(product.product_family).toBe('single_formula');
    expect(product.category).toBe('Powder');
    expect(product.product_type).toBe('Powder');
  });

  test('keeps Set it Down powder as a single formula instead of a set PDP', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_set_it_down_powder',
      external_product_id: 'ext_set_it_down_powder',
      canonical_url: 'https://fentybeauty.com/products/set-it-down-superfine-blurring-setting-powder-cinnamon',
      destination_url: 'https://fentybeauty.com/products/set-it-down-superfine-blurring-setting-powder-cinnamon',
      domain: 'fentybeauty.com',
      title: 'Set it Down Superfine Blurring Setting Powder — Cinnamon',
      seed_data: {
        brand: 'Fenty Beauty',
        snapshot: {},
      },
    });

    expect(product.product_family).toBe('single_formula');
    expect(product.category).toBe('Powder');
    expect(product.product_type).toBe('Powder');
  });

  test('classifies stylized Fenty stick and packette formulas as single formula PDPs', () => {
    const matchStix = buildExternalSeedProduct({
      id: 'eps_match_stix',
      external_product_id: 'ext_match_stix',
      canonical_url: 'https://fentybeauty.com/products/match-stix-contour-skinstick-suedish',
      destination_url: 'https://fentybeauty.com/products/match-stix-contour-skinstick-suedish',
      domain: 'fentybeauty.com',
      title: 'Match Stix Contour Skinstick — Suedish',
      seed_data: { brand: 'Fenty Beauty', snapshot: {} },
    });
    const glossBombStix = buildExternalSeedProduct({
      id: 'eps_gloss_bomb_stix',
      external_product_id: 'ext_gloss_bomb_stix',
      canonical_url: 'https://fentybeauty.com/products/gloss-bomb-stix-high-shine-gloss-stick-rose-amber',
      destination_url: 'https://fentybeauty.com/products/gloss-bomb-stix-high-shine-gloss-stick-rose-amber',
      domain: 'fentybeauty.com',
      title: 'Gloss Bomb Stix High-Shine Gloss Stick — Rose Amber',
      seed_data: { brand: 'Fenty Beauty', snapshot: {} },
    });
    const packette = buildExternalSeedProduct({
      id: 'eps_butta_drop_packette',
      external_product_id: 'ext_butta_drop_packette',
      canonical_url: 'https://fentybeauty.com/products/butta-drop-packette',
      destination_url: 'https://fentybeauty.com/products/butta-drop-packette',
      domain: 'fentybeauty.com',
      title: 'Butta Drop Packette',
      seed_data: { brand: 'Fenty Skin', snapshot: {} },
    });

    expect(matchStix.product_family).toBe('single_formula');
    expect(glossBombStix.product_family).toBe('single_formula');
    expect(packette.product_family).toBe('single_formula');
  });

  test('marks external seed sets as set PDPs and suppresses single-formula ingredient modules', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_bundle',
      external_product_id: 'ext_bundle',
      canonical_url: 'https://example.com/products/radiance-routine-set',
      destination_url: 'https://example.com/products/radiance-routine-set',
      domain: 'example.com',
      title: 'Radiance Routine Set',
      seed_data: {
        brand: 'Example',
        pdp_ingredients_raw: 'Water, Glycerin, Niacinamide, Panthenol',
        pdp_active_ingredients_raw: 'Active Ingredients: Niacinamide, Panthenol',
        snapshot: {},
      },
    });

    expect(product.product_family).toBe('set_or_collection');
    expect(product.category).toBe('Set');
    expect(product.product_type).toBe('Set');
    expect(product.ingredients_inci).toBeUndefined();
    expect(product.active_ingredients).toBeUndefined();
    expect(product.ingredient_intel?.authoritative?.suppressed_reason).toBe('product_family_set_or_collection');
  });

  test('classifies merch stickers and keyrings as accessories instead of formula PDPs', () => {
    const stickers = buildExternalSeedProduct({
      id: 'eps_tirtir_stickers',
      external_product_id: 'ext_tirtir_stickers',
      canonical_url: 'https://tirtir.global/products/tirtir-stickers',
      destination_url: 'https://tirtir.global/products/tirtir-stickers',
      domain: 'tirtir.global',
      title: 'TIRTIR Stickers',
      seed_data: { brand: 'TIRTIR GLOBAL', snapshot: {} },
    });
    const keyring = buildExternalSeedProduct({
      id: 'eps_tirtir_keyring',
      external_product_id: 'ext_tirtir_keyring',
      canonical_url: 'https://tirtir.global/products/waterism-glow-melting-balm-heart-keyring',
      destination_url: 'https://tirtir.global/products/waterism-glow-melting-balm-heart-keyring',
      domain: 'tirtir.global',
      title: 'Waterism Glow Melting Balm Heart Keyring',
      seed_data: { brand: 'TIRTIR GLOBAL', snapshot: {} },
    });

    expect(stickers.product_family).toBe('accessory');
    expect(keyring.product_family).toBe('accessory');
    expect(stickers.category).toBe('Accessory');
    expect(keyring.category).toBe('Accessory');
  });

  test('classifies non-formula beauty tools and consumables as accessories', () => {
    const soapDish = buildExternalSeedProduct({
      id: 'eps_soap_dish',
      external_product_id: 'ext_soap_dish',
      canonical_url: 'https://fentybeauty.com/products/the-fenty-skin-soap-dish',
      destination_url: 'https://fentybeauty.com/products/the-fenty-skin-soap-dish',
      domain: 'fentybeauty.com',
      title: 'The Fenty Skin Soap Dish',
      seed_data: { brand: 'Fenty Skin', snapshot: {} },
    });
    const blottingPaper = buildExternalSeedProduct({
      id: 'eps_blotting_paper',
      external_product_id: 'ext_blotting_paper',
      canonical_url: 'https://fentybeauty.com/products/invisimatte-blotting-paper-refill',
      destination_url: 'https://fentybeauty.com/products/invisimatte-blotting-paper-refill',
      domain: 'fentybeauty.com',
      title: 'Invisimatte Blotting Paper Refill',
      seed_data: { brand: 'Fenty Beauty', snapshot: {} },
    });
    const washcloth = buildExternalSeedProduct({
      id: 'eps_washcloth',
      external_product_id: 'ext_washcloth',
      canonical_url: 'https://fentybeauty.com/products/fenty-skin-washcloth',
      destination_url: 'https://fentybeauty.com/products/fenty-skin-washcloth',
      domain: 'fentybeauty.com',
      title: 'Fenty Skin Washcloth',
      seed_data: { brand: 'Fenty Skin', snapshot: {} },
    });

    expect(soapDish.product_family).toBe('accessory');
    expect(blottingPaper.product_family).toBe('accessory');
    expect(washcloth.product_family).toBe('accessory');
  });

  test('keeps treatment patch stickers eligible as formula products', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_blemish_patch',
      external_product_id: 'ext_blemish_patch',
      canonical_url: 'https://example.com/products/blemish-patch-stickers',
      destination_url: 'https://example.com/products/blemish-patch-stickers',
      domain: 'example.com',
      title: 'Blemish Patch Stickers',
      seed_data: { brand: 'Example', snapshot: {} },
    });

    expect(product.product_family).toBe('single_formula');
  });

  test('classifies cleansing PDP titles as formula products', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_centella_foam_cleansing',
      external_product_id: 'ext_centella_foam_cleansing',
      canonical_url: 'https://example.com/products/centella-foam-cleansing',
      destination_url: 'https://example.com/products/centella-foam-cleansing',
      domain: 'example.com',
      title: 'Centella Foam Cleansing',
      seed_data: { brand: 'Example', snapshot: {} },
    });

    expect(product.product_family).toBe('single_formula');
  });

  test('classifies sunscreen authority rows from title even when seed category is polluted', () => {
    const rows = [
      {
        id: 'eps_haruharu_airyfit',
        external_product_id: 'ext_haruharu_airyfit',
        canonical_url: 'https://haruharuwonder.com/products/black-rice-moisture-airyfit-daily-sunscreen',
        destination_url: 'https://haruharuwonder.com/products/black-rice-moisture-airyfit-daily-sunscreen',
        domain: 'haruharuwonder.com',
        title: 'Moisture Airyfit Daily Sunscreen SPF50+/PA++++ / Unscented',
        category: 'Fragrance',
        seed_data: {
          brand: 'Haruharu Wonder',
          snapshot: {
            title: 'Moisture Airyfit Daily Sunscreen SPF50+/PA++++ / Unscented',
            category: 'Fragrance',
          },
        },
      },
      {
        id: 'eps_round_lab_birch',
        external_product_id: 'ext_round_lab_birch',
        canonical_url: 'https://roundlab.com/products/birch-moisturizing-mild-up-sunscreen-spf-50-pa',
        destination_url: 'https://roundlab.com/products/birch-moisturizing-mild-up-sunscreen-spf-50-pa',
        domain: 'roundlab.com',
        title: 'Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++',
        seed_data: {
          brand: 'Round Lab',
          snapshot: {
            title: 'Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++',
          },
        },
      },
    ];

    const products = rows.map((row) => buildExternalSeedProduct(row));
    expect(products.map((product) => product.category)).toEqual(['Sunscreen', 'Sunscreen']);
    expect(products.map((product) => product.product_type)).toEqual(['Sunscreen', 'Sunscreen']);
  });

  test('prefers makeup form factor over SPF wording when a foundation seed is polluted to sunscreen', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_tomford_architecture_foundation',
      external_product_id: 'ext_tomford_architecture_foundation',
      canonical_url: 'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation',
      destination_url: 'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation',
      domain: 'www.tomfordbeauty.com',
      title: 'Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+',
      seed_brand: 'Tom Ford Beauty',
      seed_category: 'Sunscreen',
      seed_product_type: 'Sunscreen',
      seed_description:
        'A hydrating foundation with broad spectrum SPF 50+ protection and a radiant finish.',
      seed_data: {
        brand: 'Tom Ford Beauty',
        snapshot: {
          canonical_url: 'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation',
          title: 'Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+',
          category: 'Sunscreen',
          product_type: 'Sunscreen',
          description:
            'A hydrating foundation with broad spectrum SPF 50+ protection and a radiant finish.',
          variants: [],
        },
      },
    });

    expect(product.category).toBe('Foundation');
    expect(product.product_type).toBe('Foundation');
  });

  test('still classifies true sunscreen products as sunscreen when no makeup form factor is present', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_true_sunscreen_face_fluid',
      external_product_id: 'ext_true_sunscreen_face_fluid',
      canonical_url: 'https://example.com/products/daily-invisible-sunscreen-spf-50',
      destination_url: 'https://example.com/products/daily-invisible-sunscreen-spf-50',
      domain: 'example.com',
      title: 'Daily Invisible Sunscreen SPF 50',
      seed_brand: 'Example Beauty',
      seed_category: 'Sunscreen',
      seed_product_type: 'Sunscreen',
      seed_description: 'A lightweight daily sunscreen fluid for broad spectrum UV protection.',
      seed_data: {
        brand: 'Example Beauty',
        snapshot: {
          canonical_url: 'https://example.com/products/daily-invisible-sunscreen-spf-50',
          title: 'Daily Invisible Sunscreen SPF 50',
          category: 'Sunscreen',
          product_type: 'Sunscreen',
          description: 'A lightweight daily sunscreen fluid for broad spectrum UV protection.',
          variants: [],
        },
      },
    });

    expect(product.category).toBe('Sunscreen');
    expect(product.product_type).toBe('Sunscreen');
  });

  test('does not infer powder from ingredient-style description mentions when title surface is non-powder', () => {
    const bananaStick = buildExternalSeedProduct({
      id: 'eps_ole_banana_cc_stick',
      external_product_id: 'ext_ole_banana_cc_stick',
      canonical_url: 'https://olehenriksen.com/products/banana-bright-vitamin-cc-stick',
      destination_url: 'https://olehenriksen.com/products/banana-bright-vitamin-cc-stick',
      domain: 'olehenriksen.com',
      title: 'Banana Bright+ Vitamin CC Stick',
      seed_brand: 'Olehenriksen',
      seed_description:
        'A color-correcting eye cream stick, with two forms of vitamin C and banana powder-inspired pigments, that instantly neutralizes dark circles, brightens and hydrates.',
    });
    expect(bananaStick.category).not.toBe('Powder');
    expect(bananaStick.product_type).not.toBe('Powder');

    const lemonadeScrub = buildExternalSeedProduct({
      id: 'eps_ole_lemonade_scrub',
      external_product_id: 'ext_ole_lemonade_scrub',
      canonical_url: 'https://olehenriksen.com/products/lemonade-smoothing-scrub',
      destination_url: 'https://olehenriksen.com/products/lemonade-smoothing-scrub',
      domain: 'olehenriksen.com',
      title: 'Lemonade Smoothing Scrub',
      seed_brand: 'Olehenriksen',
      seed_description:
        'High-potency AHAs help exfoliate while lemon peel powder and ultra-fine sugar gently buff away rough skin.',
    });
    expect(lemonadeScrub.category).not.toBe('Powder');
    expect(lemonadeScrub.product_type).not.toBe('Powder');
  });

  test('prefers primary variant image ordering over stale top-level seed image ordering', () => {
    const row = {
      id: 'eps_tomford_lip_liquid',
      external_product_id: 'ext_tomford_lip_liquid',
      canonical_url: 'https://www.tomfordbeauty.com/products/liquid-lip-luxe-matte',
      destination_url: 'https://www.tomfordbeauty.com/products/liquid-lip-luxe-matte',
      domain: 'www.tomfordbeauty.com',
      title: 'Liquid Lip Luxe Matte',
      image_url:
        'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_0_a5de802c-b211-4ebd-ad88-77963f36118e.png?v=1774387264',
      seed_data: {
        brand: 'Tom Ford Beauty',
        image_urls: [
          'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_0_a5de802c-b211-4ebd-ad88-77963f36118e.png?v=1774387264',
          'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_1G_aaedf664-7463-497f-9976-172f7ced1989.jpg?v=1774387264',
        ],
        snapshot: {
          canonical_url: 'https://www.tomfordbeauty.com/products/liquid-lip-luxe-matte',
          image_url:
            'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_0_a5de802c-b211-4ebd-ad88-77963f36118e.png?v=1774387264',
          image_urls: [
            'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_0_a5de802c-b211-4ebd-ad88-77963f36118e.png?v=1774387264',
            'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_1G_aaedf664-7463-497f-9976-172f7ced1989.jpg?v=1774387264',
          ],
          variants: [
            {
              sku: 'TC4N11',
              variant_id: 'TC4N11',
              option_name: 'Color',
              option_value: 'Velvet Bloom',
              price: '62.00',
              currency: 'USD',
              stock: 'In Stock',
              image_url:
                'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_0.png?v=1774610411',
              image_urls: [
                'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_0.png?v=1774610411',
                'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_1G_72d7b843-7875-4c79-992d-2c4b900e2751.jpg?v=1774610411',
              ],
            },
            {
              sku: 'TC4N09',
              variant_id: 'TC4N09',
              option_name: 'Color',
              option_value: 'Other Shade',
              price: '62.00',
              currency: 'USD',
              stock: 'In Stock',
              image_url:
                'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N09_2000x2000_0.png?v=1774610411',
              image_urls: [
                'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N09_2000x2000_0.png?v=1774610411',
              ],
            },
          ],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.image_url).toBe(
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_0.png?v=1774610411',
    );
    expect(product.images[0]).toBe(
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_0.png?v=1774610411',
    );
    expect(product.images).toContain(
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_1G_72d7b843-7875-4c79-992d-2c4b900e2751.jpg?v=1774610411',
    );
  });

  test('prefers stored recall title and summary when hydrating external seed products', () => {
    const row = {
      id: 'eps_recall_runtime_1',
      external_product_id: 'ext_recall_runtime_1',
      canonical_url: 'https://fentybeauty.com/products/butta-drop',
      destination_url: 'https://fentybeauty.com/products/butta-drop',
      title: 'OFFICIAL: Butta Drop /// SOCIAL HIGHLIGHTS',
      seed_data: {
        brand: 'Fenty Beauty',
        snapshot: {
          title: 'OFFICIAL: Butta Drop /// SOCIAL HIGHLIGHTS',
        },
        derived: {
          recall: {
            retrieval_title: 'Butta Drop Whipped Oil Body Cream',
            retrieval_summary:
              "THE UNDERCOVER BLEMISH FIGHTER THE BLEMISH FIX SO STEALTH, YOU'LL NEVER SEE IT UNDER MAKEUP A rich body cream with tropical oils for soft, radiant skin.",
            retrieval_body:
              "THE UNDERCOVER BLEMISH FIGHTER THE BLEMISH FIX SO STEALTH, YOU'LL NEVER SEE IT UNDER MAKEUP A rich body cream with tropical oils for soft, radiant skin.",
            brand: 'Fenty Beauty',
            category: 'Moisturizer',
            vertical: 'beauty',
            ingredient_tokens: ['glycerin'],
            alias_tokens: ['butta', 'drop', 'body', 'cream'],
            exclusion_flags: {
              gift_card: false,
              donation_bundle: false,
              non_merchandise: false,
            },
            quality_signals: {
              template_polluted: true,
              synthetic_summary: true,
              extractor_description_present: true,
            },
            version: 'v1',
          },
        },
      },
    };

    const product = buildExternalSeedProduct(row, { matchSource: 'recall_title' });
    expect(product.title).toBe('Butta Drop Whipped Oil Body Cream');
    expect(product.description).toBe('A rich body cream with tropical oils for soft, radiant skin.');
    expect(product.external_seed_recall).toEqual(
      expect.objectContaining({
        retrieval_title: 'Butta Drop Whipped Oil Body Cream',
        version: 'v1',
      }),
    );
    expect(product.external_seed_match_source).toBe('recall_title');
    expect(product.brand).toBe('Fenty Beauty');
  });

  test('does not infer makeup highlighters as moisturizers just because description mentions cream', () => {
    const product = buildExternalSeedBrandSearchProduct({
      id: 'eps_fenty_killawatt',
      external_product_id: 'ext_fenty_killawatt',
      canonical_url: 'https://fentybeauty.com/products/mini-killawatt-freestyle-highlighter-wattab',
      destination_url: 'https://fentybeauty.com/products/mini-killawatt-freestyle-highlighter-wattab',
      title: 'Mini Killawatt Freestyle Highlighter — Wattab!*%#',
      seed_data: {
        brand: 'Fenty Beauty',
        snapshot: {
          title: 'Mini Killawatt Freestyle Highlighter — Wattab!*%#',
        },
        derived: {
          recall: {
            retrieval_title: 'Mini Killawatt Freestyle Highlighter — Wattab!*%#',
            retrieval_summary:
              'Weightless, longwear cream-powder hybrid highlighters that range from subtle dayglow to insanely supercharged.',
            retrieval_body:
              'Weightless, longwear cream-powder hybrid highlighters that range from subtle dayglow to insanely supercharged.',
            brand: 'Fenty Beauty',
            category: null,
            vertical: 'makeup',
            ingredient_tokens: [],
            alias_tokens: ['mini', 'killawatt', 'highlighter'],
            exclusion_flags: {
              gift_card: false,
              donation_bundle: false,
              non_merchandise: false,
            },
            quality_signals: {
              template_polluted: false,
              synthetic_summary: false,
              extractor_description_present: true,
            },
            version: 'v1',
          },
        },
      },
    });

    expect(product.category).toBe('Highlighter');
    expect(product.product_type).toBe('Highlighter');
  });

  test('drops blocked non-merch recall rows from brand-search runtime products', () => {
    const product = buildExternalSeedBrandSearchProduct({
      id: 'eps_non_merch',
      external_product_id: 'ext_non_merch',
      canonical_url: 'https://brand.example/pages/store-locator',
      destination_url: 'https://brand.example/pages/store-locator',
      title: 'Store Locator',
      source_page_type: 'page',
      seed_data: {
        derived: {
          recall: {
            retrieval_title: 'Store Locator',
            retrieval_summary: 'Find a store near you.',
            retrieval_body: 'Find a store near you.',
            exclusion_flags: {
              gift_card: false,
              donation_bundle: false,
              non_merchandise: true,
            },
            quality_signals: {
              template_polluted: false,
              synthetic_summary: false,
              extractor_description_present: false,
            },
            quality_state: 'blocked',
            suppression_flags: {
              exclude_from_recall: true,
              exclude_from_similar: true,
            },
            version: 'v1',
          },
        },
      },
    });

    expect(product).toBeNull();
  });

  test('suppresses quarantined PDP fields and non-authoritative active ingredients on external seed runtime products', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_quarantine_runtime',
      external_product_id: 'ext_quarantine_runtime',
      canonical_url: 'https://example.com/products/glow-pad',
      destination_url: 'https://example.com/products/glow-pad',
      title: 'Glow Pad',
      seed_data: {
        active_ingredients: ['Niacinamide', 'Panthenol benefits'],
        pdp_description_raw: 'Fallback description from browser scrape.',
        pdp_how_to_use_raw: 'Apply after cleansing.',
        pdp_faq_items: [
          { question: 'Can I use this daily?', answer: 'Yes.' },
        ],
        pdp_field_quality_summary: {
          description_raw: {
            source_origin: 'browser_fallback',
            source_quality_status: 'quarantined',
          },
          how_to_use_raw: {
            source_origin: 'browser_fallback',
            source_quality_status: 'quarantined',
          },
          faq_items: {
            source_origin: 'browser_fallback',
            source_quality_status: 'quarantined',
          },
          details_sections: {
            source_origin: 'shopify_json',
            source_quality_status: 'high',
          },
        },
        snapshot: {
          title: 'Glow Pad',
          pdp_description_raw: 'Fallback description from browser scrape.',
          pdp_how_to_use_raw: 'Apply after cleansing.',
          pdp_faq_items: [{ question: 'Can I use this daily?', answer: 'Yes.' }],
          pdp_details_sections: [{ heading: 'Product Type', body: 'Pad' }],
          content_image_urls: ['https://cdn.example.com/glow-pad-overview.jpg'],
        },
      },
    });

    expect(product.pdp_description_raw).toBeUndefined();
    expect(product.pdp_how_to_use_raw).toBeUndefined();
    expect(product.pdp_faq_items).toBeUndefined();
    expect(product.pdp_details_sections).toEqual([{ heading: 'Product Type', body: 'Pad' }]);
    expect(product.content_image_urls).toEqual(['https://cdn.example.com/glow-pad-overview.jpg']);
    expect(product.active_ingredients).toBeUndefined();
    expect(product.pdp_field_quality_summary.description_raw.source_quality_status).toBe('quarantined');
  });

  test('preserves reviewed force-filled PDP content while keeping quarantined fields blocked', () => {
    const forceFillContract = {
      contract_version: 'pivota.pdp.force_fill.v1',
      display_note: 'Ingredient details are pending approved source capture.',
      source_origin: 'pivota_force_fill',
      source_quality_status: 'force_filled_pending_source',
      content_review_state: 'assistant_reviewed',
      reason: 'missing_ingredients',
    };
    const product = buildExternalSeedProduct({
      id: 'eps_force_fill_runtime',
      external_product_id: 'ext_force_fill_runtime',
      canonical_url: 'https://example.com/products/tone-up-sunscreen',
      destination_url: 'https://example.com/products/tone-up-sunscreen',
      title: 'Tone-Up Sunscreen',
      seed_data: {
        pdp_description_raw: 'Browser fallback copy should stay quarantined.',
        pdp_how_to_use_raw: 'Apply generously as the last step in your morning routine.',
        ingredient_intel: {
          force_fill_contract: forceFillContract,
        },
        pdp_field_quality_summary: {
          description_raw: {
            source_origin: 'browser_fallback',
            source_quality_status: 'quarantined',
          },
          how_to_use_raw: {
            source_origin: 'pivota_force_fill',
            source_quality_status: 'force_filled_reviewed_pattern',
          },
          ingredients_inci: {
            source_origin: 'pivota_force_fill',
            source_quality_status: 'force_filled_pending_source',
          },
        },
        snapshot: {
          title: 'Tone-Up Sunscreen',
          pdp_description_raw: 'Browser fallback copy should stay quarantined.',
          pdp_how_to_use_raw: 'Apply generously as the last step in your morning routine.',
          ingredient_intel: {
            force_fill_contract: forceFillContract,
          },
        },
      },
    });

    expect(product.pdp_description_raw).toBeUndefined();
    expect(product.pdp_how_to_use_raw).toBe('Apply generously as the last step in your morning routine.');
    expect(product.seed_data.pdp_how_to_use_raw).toBe('Apply generously as the last step in your morning routine.');
    expect(product.ingredient_intel.force_fill_contract).toEqual(forceFillContract);
    expect(product.pdp_field_quality_summary.ingredients_inci.source_quality_status).toBe('force_filled_pending_source');
  });

  test('preserves stored ingredient candidates for single-formula external seeds when authority view is unavailable', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_oil_lala_like',
      external_product_id: 'ext_oil_lala_like',
      canonical_url: 'https://example.com/products/oil-lala-like',
      destination_url: 'https://example.com/products/oil-lala-like',
      title: 'Oil La La Like',
      seed_data: {
        category: 'Serum',
        ingredients_inci: [
          '10% Upcycled Rosehip Oil: Packed with fatty acids',
          'Helianthus Annuus (Sunflower) Seed Oil',
          'Rosa Canina (Rosehip) Fruit Oil',
          'PETA-certified vegan and cruelty-free',
        ],
        snapshot: {
          title: 'Oil La La Like',
          variants: [],
        },
      },
    });

    expect(product.product_family).toBe('single_formula');
    expect(product.ingredients_inci).toEqual([
      '10% Upcycled Rosehip Oil: Packed with fatty acids',
      'Helianthus Annuus (Sunflower) Seed Oil',
      'Rosa Canina (Rosehip) Fruit Oil',
      'PETA-certified vegan and cruelty-free',
    ]);
  });

  test('authoritative external seed snapshots quarantine legacy PDP shadow fields at runtime', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_authoritative_runtime',
      external_product_id: 'ext_authoritative_runtime',
      canonical_url: 'https://example.com/products/barrier-cream',
      destination_url: 'https://example.com/products/barrier-cream',
      title: 'Barrier Cream',
      seed_data: {
        details_sections: [{ heading: 'Legacy', body: 'Legacy shadow details.' }],
        faq_items: [{ question: 'Legacy?', answer: 'Legacy answer.' }],
        how_to_use: 'Legacy directions.',
        external_seed_snapshot_contract: {
          contract_version: 'external_seed.snapshot_contract.v1',
          authoritative: true,
          structured_fields_authoritative: true,
          legacy_fields_quarantined: true,
        },
        pdp_details_sections: [{ heading: 'Overview', body: 'Reviewed barrier overview.' }],
        pdp_faq_items: [{ question: 'Can I use it daily?', answer: 'Yes.' }],
        snapshot: {
          details_sections: [{ heading: 'Legacy', body: 'Legacy snapshot details.' }],
          faq_items: [{ question: 'Legacy?', answer: 'Legacy snapshot answer.' }],
          how_to_use: 'Legacy snapshot directions.',
          external_seed_snapshot_contract: {
            contract_version: 'external_seed.snapshot_contract.v1',
            authoritative: true,
            structured_fields_authoritative: true,
            legacy_fields_quarantined: true,
          },
          pdp_details_sections: [{ heading: 'Overview', body: 'Reviewed barrier overview.' }],
          pdp_faq_items: [{ question: 'Can I use it daily?', answer: 'Yes.' }],
          description: 'Reviewed barrier overview.',
        },
      },
    });

    expect(product.pdp_details_sections).toEqual([{ heading: 'Overview', body: 'Reviewed barrier overview.' }]);
    expect(product.pdp_faq_items).toEqual([
      { question: 'Can I use it daily?', answer: 'Yes.', source_kind: 'merchant_faq' },
    ]);
    expect(product.seed_data.details_sections).toBeUndefined();
    expect(product.seed_data.faq_items).toBeUndefined();
    expect(product.seed_data.how_to_use).toBeUndefined();
    expect(product.seed_data.snapshot.details_sections).toBeUndefined();
    expect(product.seed_data.snapshot.faq_items).toBeUndefined();
    expect(product.seed_data.snapshot.how_to_use).toBeUndefined();
    expect(product.seed_data.snapshot.external_seed_snapshot_contract).toEqual(
      expect.objectContaining({
        authoritative: true,
        legacy_fields_quarantined: true,
      }),
    );
  });

  test('prefers approved snapshot PDP content over thinner root seed shadow fields', () => {
    const canonicalUrl = 'https://example.com/products/barrier-cream';
    const reviewedDescription =
      'Reviewed canonical overview with ceramides and panthenol for daily barrier support.';
    const product = buildExternalSeedProduct({
      id: 'eps_snapshot_priority',
      external_product_id: 'ext_snapshot_priority',
      canonical_url: canonicalUrl,
      destination_url: canonicalUrl,
      title: 'Barrier Cream',
      seed_data: {
        description: 'Thin shadow description.',
        pdp_description_raw: 'Thin shadow description.',
        pdp_details_sections: [{ heading: 'Overview', body: 'Thin shadow section.' }],
        key_ingredients: ['Marketing copy'],
        seed_description_origin: 'shadow_seed',
        source_url: 'https://shadow.example.com/products/barrier-cream',
        pdp_field_quality_summary: {
          description_raw: {
            source_origin: 'shopify_json',
            source_quality_status: 'high',
          },
          details_sections: {
            source_origin: 'shopify_json',
            source_quality_status: 'high',
          },
        },
        snapshot: {
          title: 'Barrier Cream',
          description: reviewedDescription,
          pdp_description_raw: reviewedDescription,
          pdp_details_sections: [
            { heading: 'Overview', body: reviewedDescription },
            { heading: 'How to Use', body: 'Apply after toner.' },
          ],
          key_ingredients: ['Ceramide NP', 'Panthenol'],
          seed_description_origin: 'assistant_reviewed_asset',
          source_url: canonicalUrl,
        },
      },
    });

    expect(product.description).toBe(reviewedDescription);
    expect(product.pdp_description_raw).toBe(reviewedDescription);
    expect(product.pdp_details_sections).toEqual([
      { heading: 'Overview', body: reviewedDescription },
      { heading: 'How to Use', body: 'Apply after toner.' },
    ]);
    expect(product.key_ingredients).toEqual(['Ceramide NP', 'Panthenol']);
    expect(product.seed_description_origin).toBe('assistant_reviewed_asset');
    expect(product.source_url).toBe(canonicalUrl);
  });

  test('projects approved sunscreen active block into external seed product payload', () => {
    const canonicalUrl = 'https://olehenriksen.com/products/banana-bright-mineral-sunscreen-spf-30';
    const activeBlock =
      'Zinc Oxide 16.3%\nEnhanced Vitamin C (Ascorbic Acid)\nBanana Powder-Inspired Pigments\nNiacinamide\nAloe Leaf Juice';
    const product = buildExternalSeedProduct({
      id: 'eps_ole_spf',
      external_product_id: 'ext_ole_spf',
      canonical_url: canonicalUrl,
      destination_url: canonicalUrl,
      title: 'Banana Bright Mineral Sunscreen SPF 30',
      seed_data: {
        brand: 'Olehenriksen',
        category: 'Sunscreen',
        pdp_ingredients_raw:
          'Aqua/Water/Eau, Zinc Oxide, Niacinamide, Aloe Barbadensis Leaf Juice, Tetrahexyldecyl Ascorbate, Iron Oxides (Ci 77491, Ci 77492), Titanium Dioxide (Ci 77891).',
        pdp_active_ingredients_raw: activeBlock,
        active_ingredients: [
          'Zinc Oxide 16.3%',
          'Enhanced Vitamin C (Ascorbic Acid)',
          'Banana Powder-Inspired Pigments',
          'Niacinamide',
          'Aloe Leaf Juice',
        ],
        key_ingredients: [
          'Zinc Oxide 16.3%',
          'Enhanced Vitamin C (Ascorbic Acid)',
          'Banana Powder-Inspired Pigments',
          'Niacinamide',
          'Aloe Leaf Juice',
        ],
        pdp_field_quality_summary: {
          ingredients_raw: {
            source_origin: 'retail_pdp',
            source_quality_status: 'medium',
          },
          active_ingredients_raw: {
            source_origin: 'shopify_json',
            source_quality_status: 'high',
            source_kinds: ['derived_details_section_ingredients'],
            reason_codes: [],
          },
        },
        snapshot: {
          pdp_ingredients_raw:
            'Aqua/Water/Eau, Zinc Oxide, Niacinamide, Aloe Barbadensis Leaf Juice, Tetrahexyldecyl Ascorbate, Iron Oxides (Ci 77491, Ci 77492), Titanium Dioxide (Ci 77891).',
          pdp_active_ingredients_raw: activeBlock,
        },
      },
    });

    expect(product.pdp_active_ingredients_raw).toBe(activeBlock);
    expect(product.key_ingredients).toEqual(
      expect.arrayContaining(['Enhanced Vitamin C (Ascorbic Acid)', 'Aloe Leaf Juice']),
    );
    expect(product.active_ingredients).toEqual(['Zinc Oxide']);
    expect(product.active_ingredients).not.toContain('Titanium Dioxide');
    expect(product.seed_data.pdp_active_ingredients_raw).toBe(activeBlock);
  });
});
