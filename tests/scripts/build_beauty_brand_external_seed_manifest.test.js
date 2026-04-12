const {
  buildManifestFromExtract,
  computeExtractLimit,
  looksLikeBundleLikeProduct,
  scorePreferredTitleMatch,
} = require('../../scripts/build_beauty_brand_external_seed_manifest.cjs');

describe('build_beauty_brand_external_seed_manifest', () => {
  test('maps catalog-intelligence brand extract products into seed creation manifest items', () => {
    const manifest = buildManifestFromExtract({
      brand: 'La Roche-Posay',
      domain: 'https://www.laroche-posay.us',
      market: 'US',
      limit: 10,
      extractDoc: {
        diagnostics: { source: 'catalog_extract' },
        products: [
          {
            title: 'Anthelios Ultra-Light Invisible Fluid SPF 50+',
            url: 'https://www.laroche-posay.us/anthelios-ultra-light-invisible-fluid-spf-50',
            image_url: 'https://cdn.example.com/anthelios.jpg',
            price: '$39.99',
            currency: 'USD',
            availability: 'in stock',
            variants: [
              {
                id: 'v1',
                sku: 'LRP-ANTHELIOS',
                url: 'https://www.laroche-posay.us/anthelios-ultra-light-invisible-fluid-spf-50',
                price: '$39.99',
                currency: 'USD',
                stock: 'In Stock',
                image_url: 'https://cdn.example.com/anthelios.jpg',
              },
            ],
          },
        ],
      },
    });

    expect(manifest.item_count).toBe(1);
    expect(manifest.items[0]).toEqual(
      expect.objectContaining({
        target_brand: 'La Roche-Posay',
        target_url: 'https://www.laroche-posay.us/anthelios-ultra-light-invisible-fluid-spf-50',
        market: 'US',
        seed_row: expect.objectContaining({
          market: 'US',
          title: 'Anthelios Ultra-Light Invisible Fluid SPF 50+',
          domain: 'laroche-posay.us',
          availability: 'in_stock',
          price_amount: 39.99,
        }),
      }),
    );
  });

  test('filters obvious bundle-like products and keeps the requested limit for single products', () => {
    const manifest = buildManifestFromExtract({
      brand: 'The Inkey List',
      domain: 'https://www.theinkeylist.com',
      market: 'US',
      limit: 1,
      extractDoc: {
        diagnostics: { source: 'catalog_extract' },
        products: [
          {
            title: 'Travel Essentials Routine',
            url: 'https://www.theinkeylist.com/products/travel-essentials-routine',
          },
          {
            title: 'Niacinamide Serum',
            url: 'https://www.theinkeylist.com/products/niacinamide-serum',
            image_url: 'https://cdn.example.com/niacinamide.jpg',
            price: '$12.00',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });

    expect(looksLikeBundleLikeProduct({ title: 'Travel Essentials Routine' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'FREE Hyaluronic Acid Serum 30ml' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'SPF! Canvas Tote Bag ($15 value)' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Niacinamide Serum' })).toBe(false);
    expect(manifest.extracted_product_count).toBe(2);
    expect(manifest.excluded_bundle_like_count).toBe(1);
    expect(manifest.item_count).toBe(1);
    expect(manifest.items[0].target_url).toBe('https://www.theinkeylist.com/products/niacinamide-serum');
  });

  test('prioritizes preferred titles within the brand extract', () => {
    const manifest = buildManifestFromExtract({
      brand: 'The Inkey List',
      domain: 'https://www.theinkeylist.com',
      market: 'US',
      limit: 2,
      preferredTitles: ['10% Niacinamide Serum'],
      extractDoc: {
        diagnostics: { source: 'catalog_extract' },
        products: [
          {
            title: 'Bio-Active Neck Lift Stick',
            url: 'https://www.theinkeylist.com/products/bio-active-neck-lift-stick',
            image_url: 'https://cdn.example.com/neck.jpg',
            price: '$22.00',
            currency: 'USD',
            availability: 'in stock',
          },
          {
            title: '10% Niacinamide Serum',
            url: 'https://www.theinkeylist.com/products/niacinamide-serum',
            image_url: 'https://cdn.example.com/niacinamide.jpg',
            price: '$12.00',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });

    expect(scorePreferredTitleMatch({ title: '10% Niacinamide Serum' }, ['10% Niacinamide Serum'])).toBeGreaterThan(0);
    expect(manifest.matched_preferred_title_count).toBe(1);
    expect(manifest.items[0].seed_row.title).toBe('10% Niacinamide Serum');
  });

  test('expands extract window when preferred titles are provided', () => {
    expect(computeExtractLimit(12, [])).toBe(60);
    expect(computeExtractLimit(12, ['10% Niacinamide Serum'])).toBe(250);
  });
});
