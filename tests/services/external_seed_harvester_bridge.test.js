const {
  buildExternalSeedHarvesterCandidates,
  buildVariantSourceUrl,
  extractRawIngredientText,
  filterCandidatesForHarvester,
  shouldExcludeCandidate,
} = require('../../src/services/externalSeedHarvesterBridge');

describe('externalSeedHarvesterBridge', () => {
  test('extracts raw ingredient text from seeded descriptions and emits variant-level harvester candidates', () => {
    const row = {
      id: 'eps_ole_1',
      external_product_id: 'ext_ole_1',
      market: 'US',
      canonical_url: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum',
      title: 'Banana Bright Vitamin C Serum',
      seed_data: {
        brand: 'Ole Henriksen',
        snapshot: {
          canonical_url: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum',
          title: 'Banana Bright Vitamin C Serum',
          variants: [
            {
              sku: '41609',
              variant_id: '41609',
              option_value: '30ml',
              url: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum',
              currency: 'USD',
              price: '68.00',
              stock: 'In Stock',
              description: 'A brightening serum.\n\nIngredients and Safety: Water, Ascorbic Acid, Glycerin.',
              image_url: 'https://cdn.example.com/ole.jpg',
            },
          ],
        },
      },
    };

    expect(
      extractRawIngredientText('A brightening serum.\n\nIngredients and Safety: Water, Ascorbic Acid, Glycerin.'),
    ).toBe('Water, Ascorbic Acid, Glycerin.');

    const candidates = buildExternalSeedHarvesterCandidates(row);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        candidate_id: 'extseed:eps_ole_1:41609',
        sku_key: 'extseed:eps_ole_1:41609',
        brand: 'Ole Henriksen',
        product_name: 'Banana Bright Vitamin C Serum - 30ml',
        source_ref: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum?variant=41609',
        raw_ingredient_text: 'Water, Ascorbic Acid, Glycerin.',
      }),
    );
  });

  test('appends variant query parameter when seed only stores generic PDP url', () => {
    expect(buildVariantSourceUrl('https://www.pixibeauty.com/products/on-the-glow-blush', '42457583845472')).toBe(
      'https://www.pixibeauty.com/products/on-the-glow-blush?variant=42457583845472',
    );
    expect(
      buildVariantSourceUrl(
        'https://www.pixibeauty.com/products/on-the-glow-blush?variant=42457583845472',
        '999999',
      ),
    ).toBe('https://www.pixibeauty.com/products/on-the-glow-blush?variant=42457583845472');

    const row = {
      id: 'eps_pixi_1',
      external_product_id: 'ext_pixi_1',
      market: 'US',
      canonical_url: 'https://www.pixibeauty.com/products/on-the-glow-blush',
      title: 'On-the-Glow Blush',
      seed_data: {
        brand: 'Pixi Beauty',
        snapshot: {
          canonical_url: 'https://www.pixibeauty.com/products/on-the-glow-blush',
          title: 'On-the-Glow Blush',
          variants: [
            {
              sku: 'PIXI-CASSIS',
              variant_id: '42457583845472',
              option_value: 'Cassis',
              url: 'https://www.pixibeauty.com/products/on-the-glow-blush',
            },
          ],
        },
      },
    };

    const candidates = buildExternalSeedHarvesterCandidates(row);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].source_ref).toBe(
      'https://www.pixibeauty.com/products/on-the-glow-blush?variant=42457583845472',
    );
  });

  test('filters blocker rows out of the default harvester export set', () => {
    const rows = [
      {
        id: 'eps_good_1',
        domain: 'example.com',
        market: 'US',
        canonical_url: 'https://example.com/en-us/good-product.html',
        title: 'Good Product',
        seed_data: {
          brand: 'Example',
          snapshot: {
            canonical_url: 'https://example.com/en-us/good-product.html',
            title: 'Good Product',
            variants: [
              {
                sku: 'GOOD-1',
                variant_id: 'GOOD-1',
                currency: 'USD',
                price: '20.00',
                stock: 'In Stock',
                image_url: 'https://cdn.example.com/good.jpg',
              },
            ],
          },
        },
      },
      {
        id: 'eps_blocked_1',
        domain: 'example.com',
        market: 'US',
        canonical_url: 'https://example.com/en-us/contact-us.html',
        title: 'Promotional Terms',
        seed_data: {
          snapshot: {
            canonical_url: 'https://example.com/en-us/contact-us.html',
            description: 'Promotional Terms & Conditions',
            variants: [],
          },
        },
      },
    ];

    const result = filterCandidatesForHarvester(rows);
    expect(result.exported).toHaveLength(1);
    expect(result.exported[0].row.id).toBe('eps_good_1');
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ anomaly_type: 'non_product_fallback_page' })]),
    );
  });

  test('excludes gift cards, kits, bundles, collections, and default title candidates from harvester export', () => {
    expect(
      shouldExcludeCandidate({
        product_name: 'Pixi E-Gift Card 200 - Default Title',
      }),
    ).toBe(true);
    expect(
      shouldExcludeCandidate({
        product_name: 'Ultimate Glow Skin Routine Set - Default Title',
      }),
    ).toBe(true);
    expect(
      shouldExcludeCandidate({
        product_name: 'Best Of Pixi Bundle - Default Title',
      }),
    ).toBe(true);
    expect(
      shouldExcludeCandidate({
        product_name: 'daily brightness boosters kit - KIT',
      }),
    ).toBe(true);
    expect(
      shouldExcludeCandidate({
        product_name: 'Glow2OH Dark Spot Toner Duo - 6.5 oz',
      }),
    ).toBe(true);
    expect(
      shouldExcludeCandidate({
        product_name: 'The Eye, Lash & Brow Collection',
      }),
    ).toBe(true);
    expect(
      shouldExcludeCandidate({
        product_name: 'Banana Bright Vitamin C Serum - 30ml',
      }),
    ).toBe(false);

    const rows = [
      {
        id: 'eps_bundle_1',
        domain: 'pixibeauty.com',
        market: 'US',
        canonical_url: 'https://www.pixibeauty.com/products/ultimate-glow-mystery-box',
        title: 'Ultimate Glow Skin Routine Set - Default Title',
        seed_data: {
          brand: 'PIXI BEAUTY',
          snapshot: {
            canonical_url: 'https://www.pixibeauty.com/products/ultimate-glow-mystery-box',
            title: 'Ultimate Glow Skin Routine Set - Default Title',
            variants: [
              {
                sku: 'PIXI-BUNDLE-1',
                variant_id: 'PIXI-BUNDLE-1',
                title: 'Default Title',
              },
            ],
          },
        },
      },
    ];

    const result = filterCandidatesForHarvester(rows);
    expect(result.exported).toHaveLength(0);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row_id: 'eps_bundle_1',
          reason: 'candidate_policy_filtered',
        }),
      ]),
    );
  });
});
