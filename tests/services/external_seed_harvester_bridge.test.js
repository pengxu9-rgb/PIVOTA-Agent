const {
  buildExternalSeedHarvesterCandidates,
  buildVariantSourceUrl,
  classifyIngredientScope,
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
        seed_description_origin: 'pdp_variant_description',
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

  test('prefers PDP ingredient-class fields over generic description fallback', () => {
    const row = {
      id: 'eps_rare_spf',
      external_product_id: 'ext_rare_spf',
      market: 'US',
      canonical_url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
      title: 'Positive Light Tinted Moisturizer Broad Spectrum SPF 20 Sunscreen',
      seed_data: {
        brand: 'Rare Beauty',
        pdp_ingredients_raw: 'Titanium Dioxide 3.4%, Zinc Oxide 14.37%',
        pdp_active_ingredients_raw: 'Titanium Dioxide, Zinc Oxide',
        seed_description_origin: 'synthetic_summary',
        pdp_description_raw:
          'OFFICIAL: Tinted coverage. /// SOCIAL HIGHLIGHTS: Viral on TikTok. Ingredients: this should not be used.',
        snapshot: {
          canonical_url:
            'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
          title: 'Positive Light Tinted Moisturizer Broad Spectrum SPF 20 Sunscreen',
          variants: [
            {
              sku: 'RARE-SPF-1',
              variant_id: 'RARE-SPF-1',
              url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
            },
          ],
        },
      },
    };

    const candidates = buildExternalSeedHarvesterCandidates(row);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].raw_ingredient_text).toBe('Titanium Dioxide 3.4%, Zinc Oxide 14.37%');
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
        title: 'Good Cleanser',
        seed_data: {
          brand: 'Example',
          snapshot: {
            canonical_url: 'https://example.com/en-us/good-product.html',
            title: 'Good Cleanser',
            category: 'Skincare',
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

  test('classifies skincare vs non-skincare ingredient scope conservatively', () => {
    const skincareRow = {
      title: 'Banana Bright Vitamin C Serum',
      canonical_url: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum',
      seed_data: {
        snapshot: {
          category: 'Skincare',
        },
      },
    };
    const skincareCandidate = {
      product_name: 'Banana Bright Vitamin C Serum - 30ml',
      source_ref: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum?variant=41609',
    };
    expect(classifyIngredientScope(skincareRow, skincareCandidate)).toEqual(
      expect.objectContaining({ decision: 'allow' }),
    );

    const makeupRow = {
      title: 'On-the-Glow Blush',
      canonical_url: 'https://www.pixibeauty.com/products/on-the-glow-blush',
    };
    const makeupCandidate = {
      product_name: 'On-the-Glow Blush - Cassis',
      source_ref: 'https://www.pixibeauty.com/products/on-the-glow-blush?variant=42457583845472',
    };
    expect(classifyIngredientScope(makeupRow, makeupCandidate)).toEqual(
      expect.objectContaining({ decision: 'block', reason: 'non_skincare_product_class' }),
    );

    const lipCandidate = {
      product_name: 'Pout Preserve Peptide Lip Treatment - Sweet Macaron',
      source_ref: 'https://olehenriksen.com/products/pout-preserve-peptide-lip-treatment?variant=45276839575724',
    };
    expect(classifyIngredientScope({}, lipCandidate)).toEqual(
      expect.objectContaining({ decision: 'review' }),
    );

    const ingredientLedSolutionCandidate = {
      product_name: 'Salicylic Acid 2% Solution - 769915231731',
      source_ref: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html?variant=769915231731',
    };
    expect(
      classifyIngredientScope(
        {
          title: 'Salicylic Acid 2% Solution',
          canonical_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
        },
        ingredientLedSolutionCandidate,
      ),
    ).toEqual(expect.objectContaining({ decision: 'allow', reason: 'ingredient_led_solution' }));
  });

  test('allows strong active solution skincare candidates into harvester review scope', () => {
    const solutionRow = {
      title: 'Salicylic Acid 2% Solution',
      canonical_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
    };
    const solutionCandidate = {
      product_name: 'Salicylic Acid 2% Solution - 769915231731',
      source_ref:
        'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html?variant=90f2867a0fd0',
    };
    expect(classifyIngredientScope(solutionRow, solutionCandidate)).toEqual(
      expect.objectContaining({ decision: 'allow', reason: 'ingredient_led_solution' }),
    );
  });

  test('excludes gift cards, bundles, and default title candidates from harvester export', () => {
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

  test('blocks makeup candidates from default harvester export while allowing skincare candidates', () => {
    const rows = [
      {
        id: 'eps_skin_1',
        domain: 'olehenriksen.com',
        market: 'US',
        canonical_url: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum',
        title: 'Banana Bright Vitamin C Serum',
        seed_data: {
          brand: 'Ole Henriksen',
          snapshot: {
            category: 'Skincare',
            canonical_url: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum',
            title: 'Banana Bright Vitamin C Serum',
            variants: [
              {
                sku: '41609',
                variant_id: '41609',
                option_value: '30ml',
                url: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum',
              },
            ],
          },
        },
      },
      {
        id: 'eps_makeup_1',
        domain: 'pixibeauty.com',
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
      },
    ];

    const result = filterCandidatesForHarvester(rows);
    expect(result.exported).toHaveLength(1);
    expect(result.exported[0].row.id).toBe('eps_skin_1');
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row_id: 'eps_makeup_1',
          reason: 'non_skincare_candidate',
        }),
      ]),
    );
  });

  test('exports ingredient-led skincare solutions for harvester review when step family is implicit', () => {
    const rows = [
      {
        id: 'eps_salicylic_solution_1',
        domain: 'theordinary.com',
        market: 'US',
        canonical_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
        title: 'Salicylic Acid 2% Solution',
        seed_data: {
          brand: 'The Ordinary',
          snapshot: {
            category: 'Skincare',
            canonical_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
            title: 'Salicylic Acid 2% Solution',
            variants: [
              {
                sku: '769915231731',
                variant_id: '769915231731',
                option_value: '769915231731',
                url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
              },
            ],
          },
        },
      },
    ];

    const result = filterCandidatesForHarvester(rows);
    expect(result.exported).toHaveLength(1);
    expect(result.exported[0].row.id).toBe('eps_salicylic_solution_1');
    expect(result.exported[0].candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product_name: 'Salicylic Acid 2% Solution - 769915231731',
        }),
      ]),
    );
    expect(result.skipped).toHaveLength(0);
  });
});
