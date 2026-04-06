const {
  availabilityToInStock,
  buildExternalSeedProduct,
  canonicalizeExternalSeedSnapshot,
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
      'https://cdn.shopify.com/s/files/1/2139/2967/files/Rose_Topaz_1200_4ee4c5e8-a218-4e0a-8af8-2db3c98f0c79.png',
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
      'https://cdn.shopify.com/s/files/1/2139/2967/files/Duo_Mousse_Nettoyante_Detox_-_Packshot.jpg',
    );
    expect(product.images.length).toBeGreaterThan(1);
    expect(product.variants[0]).toEqual(
      expect.objectContaining({
        image_url:
          'https://cdn.shopify.com/s/files/1/2139/2967/files/Duo_Mousse_Nettoyante_Detox_-_Packshot.jpg',
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
    ];

    const categories = rows.map((row) => buildExternalSeedProduct(row).category);
    expect(categories).toEqual(['Concealer', 'Lipstick', 'Mascara', 'Brow Pencil']);
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
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_0.png',
    );
    expect(product.images[0]).toBe(
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_0.png',
    );
    expect(product.images).toContain(
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_TC4N11_2000x2000_1G_72d7b843-7875-4c79-992d-2c4b900e2751.jpg',
    );
  });
});
