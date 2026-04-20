const {
  buildManifestFromExtract,
  buildManifestFromSourceAttempts,
  computeExtractLimit,
  looksLikeBundleLikeProduct,
  looksLikeNonProductCatalogPage,
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

  test('filters category/list pages from catalog extractor output', () => {
    const manifest = buildManifestFromExtract({
      brand: 'Round Lab',
      domain: 'https://roundlab.co.kr',
      market: 'KR',
      limit: 2,
      extractDoc: {
        diagnostics: { source: 'catalog_extract' },
        products: [
          {
            title: 'ALL - 소나무 진정 시카',
            url: 'https://roundlab.co.kr/category/%EC%86%8C%EB%82%98%EB%AC%B4-%EC%A7%84%EC%A0%95-%EC%8B%9C%EC%B9%B4/119/',
          },
          {
            title: 'Birch Juice Moisturizing Sunscreen SPF50+',
            url: 'https://roundlab.co.kr/product/birch-juice-moisturizing-sunscreen/1234/',
            image_url: 'https://cdn.example.com/birch.jpg',
            price: '25,000원',
            currency: 'KRW',
            availability: 'in stock',
          },
        ],
      },
    });

    expect(looksLikeNonProductCatalogPage({ title: 'ALL - 포 맨', url: 'https://roundlab.co.kr/category/foo/108/' })).toBe(true);
    expect(looksLikeNonProductCatalogPage({ title: 'Birch Juice Sunscreen', url: 'https://roundlab.co.kr/product/birch-juice-sunscreen/1234/' })).toBe(false);
    expect(manifest.excluded_non_product_page_count).toBe(1);
    expect(manifest.item_count).toBe(1);
    expect(manifest.items[0].seed_row.market).toBe('KR');
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

  test('keeps high-similarity preferred titles as recall aliases even below strong-match threshold', () => {
    const manifest = buildManifestFromExtract({
      brand: 'Round Lab',
      domain: 'https://roundlab.com',
      market: 'US',
      limit: 1,
      preferredTitles: ['Birch Juice Moisturizing Sunscreen SPF50+ PA++++'],
      extractDoc: {
        diagnostics: { source: 'catalog_extract' },
        products: [
          {
            title: 'Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++',
            url: 'https://roundlab.com/products/birch-moisturizing-mild-up-sunscreen-spf-50-pa',
            image_url: 'https://cdn.example.com/roundlab.jpg',
            price: '$28.00',
            currency: 'USD',
            availability: 'out of stock',
          },
        ],
      },
    });

    expect(scorePreferredTitleMatch(
      { title: 'Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++' },
      ['Birch Juice Moisturizing Sunscreen SPF50+ PA++++'],
    )).toBe(60);
    expect(manifest.matched_preferred_title_count).toBe(0);
    expect(manifest.items[0].alias_preferred_titles).toEqual([
      'Birch Juice Moisturizing Sunscreen SPF50+ PA++++',
    ]);
    expect(manifest.items[0].seed_row.seed_data.search_aliases).toContain(
      'Birch Juice Moisturizing Sunscreen SPF50+ PA++++',
    );
  });

  test('expands extract window when preferred titles are provided', () => {
    expect(computeExtractLimit(12, [])).toBe(60);
    expect(computeExtractLimit(12, ['10% Niacinamide Serum'])).toBe(250);
  });

  test('uses a secondary source only when the primary source cannot satisfy the preferred target', () => {
    const primaryManifest = buildManifestFromExtract({
      brand: 'La Roche-Posay',
      domain: 'https://www.laroche-posay.us/our-products/sun/face-sunscreen/anthelios-aox-antioxidant-serum-with-spf-50-sunscreen-3606000403703.html',
      market: 'US',
      limit: 1,
      preferredTitles: ['Anthelios AOX Antioxidant Serum with SPF 50 Sunscreen'],
      sourceRole: 'primary',
      extractDoc: {
        diagnostics: {
          discovery_strategy: 'seed_page',
          failure_category: 'bot_challenge',
          block_provider: 'cloudflare',
        },
        products: [],
      },
    });
    const secondaryManifest = buildManifestFromExtract({
      brand: 'La Roche-Posay',
      domain: 'https://www.ulta.com/p/anthelios-aox-daily-antioxidant-face-serum-spf-50-xlsImpprod12101063?sku=2285142',
      market: 'US',
      limit: 1,
      preferredTitles: ['Anthelios AOX Antioxidant Serum with SPF 50 Sunscreen'],
      sourceRole: 'secondary_fallback',
      extractDoc: {
        diagnostics: {
          discovery_strategy: 'seed_page',
          failure_category: null,
          block_provider: null,
        },
        products: [
          {
            title: 'Anthelios AOX Daily Antioxidant Face Serum SPF 50',
            url: 'https://www.ulta.com/p/anthelios-aox-daily-antioxidant-face-serum-spf-50-xlsImpprod12101063?sku=2285142',
            image_url: 'https://cdn.example.com/lrp-aox.jpg',
            price: '$44.99',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });

    const manifest = buildManifestFromSourceAttempts({
      brand: 'La Roche-Posay',
      domain: primaryManifest.domain,
      fallbackDomains: [secondaryManifest.domain],
      market: 'US',
      limit: 1,
      preferredTitles: ['Anthelios AOX Antioxidant Serum with SPF 50 Sunscreen'],
      sourceManifests: [primaryManifest, secondaryManifest],
    });

    expect(manifest.item_count).toBe(1);
    expect(manifest.fallback_used).toBe(true);
    expect(manifest.source_attempts[0]).toMatchObject({
      source_role: 'primary',
      used_in_manifest: false,
      diagnostics_summary: expect.objectContaining({
        failure_category: 'bot_challenge',
        block_provider: 'cloudflare',
      }),
    });
    expect(manifest.source_attempts[1]).toMatchObject({
      source_role: 'secondary_fallback',
      used_in_manifest: true,
      added_item_count: 1,
    });
    expect(manifest.items[0]).toMatchObject({
      source_role: 'secondary_fallback',
      target_url: 'https://www.ulta.com/p/anthelios-aox-daily-antioxidant-face-serum-spf-50-xlsImpprod12101063?sku=2285142',
      matched_preferred_titles: ['Anthelios AOX Antioxidant Serum with SPF 50 Sunscreen'],
    });
    expect(manifest.items[0].seed_row.seed_data.search_aliases).toContain(
      'Anthelios AOX Antioxidant Serum with SPF 50 Sunscreen',
    );
    expect(manifest.items[0].seed_row.seed_data.snapshot.authority_source).toMatchObject({
      source_role: 'secondary_fallback',
      source_url: 'https://www.ulta.com/p/anthelios-aox-daily-antioxidant-face-serum-spf-50-xlsImpprod12101063?sku=2285142',
    });
  });

  test('does not consume secondary source rows once the primary source already satisfies preferred titles', () => {
    const primaryManifest = buildManifestFromExtract({
      brand: 'Neutrogena',
      domain: 'https://www.neutrogena.com/products/sun/invisible-daily-defense-face-serum-spf-60/6811153',
      market: 'US',
      limit: 1,
      preferredTitles: ['Invisible Daily Defense Face Serum SPF 60+'],
      sourceRole: 'primary',
      extractDoc: {
        diagnostics: {
          discovery_strategy: 'seed_page',
          failure_category: null,
          block_provider: null,
        },
        products: [
          {
            title: 'Invisible Daily Defense Face Serum SPF 60+',
            url: 'https://www.neutrogena.com/products/sun/invisible-daily-defense-face-serum-spf-60/6811153',
            image_url: 'https://cdn.example.com/neutrogena-serum.jpg',
            price: '$19.99',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });
    const secondaryManifest = buildManifestFromExtract({
      brand: 'Neutrogena',
      domain: 'https://www.target.com/p/neutrogena-invisible-daily-defense-face-serum-spf-60',
      market: 'US',
      limit: 1,
      preferredTitles: ['Invisible Daily Defense Face Serum SPF 60+'],
      sourceRole: 'secondary_fallback',
      extractDoc: {
        diagnostics: {
          discovery_strategy: 'seed_page',
          failure_category: null,
          block_provider: null,
        },
        products: [
          {
            title: 'Neutrogena Invisible Daily Defense Sunscreen Serum SPF 60',
            url: 'https://www.target.com/p/neutrogena-invisible-daily-defense-face-serum-spf-60',
            image_url: 'https://cdn.example.com/neutrogena-target.jpg',
            price: '$18.99',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });

    const manifest = buildManifestFromSourceAttempts({
      brand: 'Neutrogena',
      domain: primaryManifest.domain,
      fallbackDomains: [secondaryManifest.domain],
      market: 'US',
      limit: 1,
      preferredTitles: ['Invisible Daily Defense Face Serum SPF 60+'],
      sourceManifests: [primaryManifest, secondaryManifest],
    });

    expect(manifest.item_count).toBe(1);
    expect(manifest.fallback_used).toBe(false);
    expect(manifest.items[0].target_url).toBe(
      'https://www.neutrogena.com/products/sun/invisible-daily-defense-face-serum-spf-60/6811153',
    );
    expect(manifest.source_attempts[1]).toMatchObject({
      source_role: 'secondary_fallback',
      used_in_manifest: false,
      skip_reason: 'primary_sufficient',
    });
  });
});
