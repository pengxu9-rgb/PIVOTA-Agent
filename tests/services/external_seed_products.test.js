const {
  availabilityToInStock,
  buildExternalSeedProduct,
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

  test('surfaces refreshed PDP and ingredient fields at product top-level', () => {
    const row = {
      id: 'eps_rare_1',
      external_product_id: 'ext_rare_1',
      canonical_url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
      destination_url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
      title: 'Positive Light Tinted Moisturizer Broad Spectrum SPF 20 Sunscreen',
      seed_data: {
        brand: 'Rare Beauty',
        pdp_description_raw: 'A flexible tinted moisturizer.',
        pdp_ingredients_raw: 'Water, Niacinamide, Ceramide NP',
        pdp_active_ingredients_raw: 'Niacinamide',
        pdp_how_to_use_raw: 'Blend with fingers or brush.',
        seed_description_origin: 'pdp_product_description',
        pdp_field_capture_status: {
          description_raw: 'present',
          details_sections: 'present',
          ingredients_raw: 'present',
          active_ingredients_raw: 'present',
          how_to_use_raw: 'present',
        },
        active_ingredients: ['Niacinamide'],
        key_ingredients: ['Ceramide NP'],
        ingredient_intel: {
          raw_ingredient_text_clean: 'Water, Niacinamide, Ceramide NP',
          inci_list: ['Water', 'Niacinamide', 'Ceramide NP'],
        },
        pdp_details_sections: [
          { heading: 'How to use', body: 'Blend with fingers or brush.' },
          { heading: 'Details', body: 'Light to medium coverage.' },
        ],
        snapshot: {
          canonical_url:
            'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
          variants: [
            {
              variant_id: '39775686983815',
              price: '30.00',
              currency: 'USD',
              stock: 'In Stock',
            },
          ],
        },
      },
    };

    const product = buildExternalSeedProduct(row);
    expect(product.pdp_description_raw).toBe('A flexible tinted moisturizer.');
    expect(product.pdp_ingredients_raw).toBe('Water, Niacinamide, Ceramide NP');
    expect(product.pdp_active_ingredients_raw).toBe('Niacinamide');
    expect(product.pdp_how_to_use_raw).toBe('Blend with fingers or brush.');
    expect(product.raw_ingredient_text_clean).toBe('Water, Niacinamide, Ceramide NP');
    expect(product.inci_list).toEqual(['Water', 'Niacinamide', 'Ceramide NP']);
    expect(product.active_ingredients).toEqual(['Niacinamide']);
    expect(product.key_ingredients).toEqual(['Ceramide NP']);
    expect(product.pdp_details_sections).toHaveLength(2);
    expect(product.seed_description_origin).toBe('pdp_product_description');
    expect(product.pdp_field_capture_status).toMatchObject({
      ingredients_raw: 'present',
      how_to_use_raw: 'present',
    });
  });
});
