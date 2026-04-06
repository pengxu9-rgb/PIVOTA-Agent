const {
  availabilityToInStock,
  buildExternalSeedProduct,
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
});
