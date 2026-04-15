const {
  availabilityToInStock,
  buildExternalSeedProduct,
  canonicalizeExternalSeedSnapshot,
  buildExternalSeedBrandSearchProduct,
  normalizeSeedVariants,
} = require('../../src/services/externalSeedProducts');

describe('externalSeedProducts helper', () => {
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
          { name: 'Color', value: 'Red' },
          { name: 'Size', value: 'S' },
        ],
        color_hex: '#ff0000',
        swatch: { hex: '#ff0000' },
      }),
    );

    const product = buildExternalSeedProduct(row);
    expect(product.variants).toHaveLength(2);
    expect(product.variants[0].options).toEqual([
      { name: 'Color', value: 'Red' },
      { name: 'Size', value: 'S' },
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
        title: '30ml / Single',
        options: [
          { name: 'Size', value: '30ml' },
          { name: 'Option', value: 'Single' },
        ],
      }),
    );
    expect(product.variants[1]).toEqual(
      expect.objectContaining({
        title: '30ml / 2-Pack',
        options: [
          { name: 'Size', value: '30ml' },
          { name: 'Option', value: '2-Pack' },
        ],
      }),
    );
    expect(product.variants[2]).toEqual(
      expect.objectContaining({
        title: '75ml / Single',
        options: [
          { name: 'Size', value: '75ml' },
          { name: 'Option', value: 'Single' },
        ],
      }),
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
      { name: 'Color', value: '35 Rose Topaz' },
      { name: 'Size', value: '8.0 g' },
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
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QT01_2000x2000_1.jpg',
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QT01_2000x2000_2.jpg',
    ]);
    expect(variants[1].images).toEqual([
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QS01_2000x2000_1.jpg',
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QS01_2000x2000_2.jpg',
    ]);

    const product = buildExternalSeedProduct(row);
    expect(product.variants[0].images).toEqual([
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QT01_2000x2000_1.jpg',
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QT01_2000x2000_2.jpg',
    ]);
    expect(product.variants[1].images).toEqual([
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QS01_2000x2000_1.jpg',
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QS01_2000x2000_2.jpg',
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
        options: [{ name: 'Size', value: '30ml' }],
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
    expect(product.category).toBe('Eyeshadow');
    expect(product.product_type).toBe('Eyeshadow');
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
});
