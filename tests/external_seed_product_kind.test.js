const {
  classifyExternalSeedProductKind,
  isIngredientAuthorityEligibleExternalSeed,
} = require('../src/services/externalSeedProductKind');

describe('external seed product kind classification', () => {
  test('classifies formula refill pouches as single-formula products', () => {
    expect(
      classifyExternalSeedProductKind({
        title: 'Oat So Simple Water Cream Refill Pouch',
        seed_data: {
          product_type: 'Moisturizer refill',
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'single_formula',
        reasons: expect.arrayContaining(['formula_refill_packaging_signal']),
      }),
    );
  });

  test('keeps reviewed accessories out of formula ingredient requirements', () => {
    expect(classifyExternalSeedProductKind({ title: 'Bojagi', seed_data: { product_type: 'Accessory' } })).toEqual(
      expect.objectContaining({
        family: 'accessory',
      }),
    );
    expect(classifyExternalSeedProductKind({ title: 'Nobang Soap Saver' })).toEqual(
      expect.objectContaining({
        family: 'accessory',
      }),
    );
    expect(
      classifyExternalSeedProductKind({
        title: 'Jurlique Lavender Candle',
        canonical_url: 'https://jurlique.com/products/lavender-candle-gwp-1',
        seed_data: { product_type: 'Aromatherapy', tags: ['candles'] },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'accessory',
        reasons: expect.arrayContaining(['accessory_signal']),
      }),
    );
    expect(classifyExternalSeedProductKind({ title: 'Aromatherapy Diffuser' })).toEqual(
      expect.objectContaining({
        family: 'accessory',
        reasons: expect.arrayContaining(['accessory_signal']),
      }),
    );
    expect(classifyExternalSeedProductKind({ title: 'Find Comfort Hydrating Body Lotion Pump' })).toEqual(
      expect.objectContaining({
        family: 'accessory',
        reasons: expect.arrayContaining(['accessory_signal']),
      }),
    );
    expect(classifyExternalSeedProductKind({ title: 'Soft Pooch Blush Dog Toy - Faith' })).toEqual(
      expect.objectContaining({
        family: 'accessory',
        reasons: expect.arrayContaining(['pet_accessory_signal']),
      }),
    );
    expect(
      classifyExternalSeedProductKind({
        title: 'Soft Pooch Blush Dog Toy - Faith',
        seed_data: {
          product_family: 'accessory',
          description:
            'A plush dog toy inspired by the Soft Pinch blush tube so your pet can play with makeup as much as you do.',
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'accessory',
        reasons: expect.arrayContaining(['explicit_product_family_signal']),
      }),
    );
  });

  test('classifies skincare duo or set as collection even with formula category path', () => {
    expect(
      classifyExternalSeedProductKind({
        title: 'Hunt for Hydration Full-Size Moisturizer & Eye Crème Duo',
        category_path: ['beauty', 'skincare', 'moisturizers'],
        seed_data: {
          category_path: 'beauty/skincare/moisturizers',
          product_type: 'Moisturizer',
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'set_or_collection',
        reasons: expect.arrayContaining(['bundle_set_signal']),
      }),
    );
  });

  test('honors reviewed explicit product kind from seed data', () => {
    expect(
      classifyExternalSeedProductKind({
        title: 'Own Your Glow Palette',
        category_path: ['beauty', 'makeup', 'face'],
        seed_data: {
          product_kind: 'bundle',
          snapshot: {
            product_kind: 'bundle',
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'set_or_collection',
        reasons: expect.arrayContaining(['explicit_product_kind_signal']),
      }),
    );
  });

  test('overrides stale bundle product kind for formula makeup category paths', () => {
    expect(
      classifyExternalSeedProductKind({
        title: 'Gel Eyeliner',
        category_path: ['beauty', 'makeup', 'eye', 'eyeliner'],
        product_type: 'Eyeliner',
        seed_data: {
          product_kind: 'bundle',
          category: 'Gift Sets',
          product_type: 'Eyeliner',
          source_page_type: 'collection',
          category_path: 'beauty/makeup/eye/eyeliner',
          snapshot: {
            product_kind: 'bundle',
            category: 'Gift Sets',
            product_type: 'Eyeliner',
            source_page_type: 'collection',
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'single_formula',
        reasons: expect.arrayContaining(['stale_bundle_kind_overridden_by_formula_category']),
      }),
    );
  });

  test('overrides stale bundle product kind for strong formula category text', () => {
    expect(
      classifyExternalSeedProductKind({
        title: "Pro Filt'r Instant Retouch Concealer — #210",
        canonical_url: 'https://fentybeauty.com/products/pro-filtr-instant-retouch-concealer-420-concealer',
        seed_data: {
          product_kind: 'bundle',
          category: 'Foundations & Concealers',
          source_page_type: 'product',
          snapshot: {
            product_kind: 'bundle',
            category: 'Foundations & Concealers',
            source_page_type: 'product',
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'single_formula',
        reasons: expect.arrayContaining(['stale_bundle_kind_overridden_by_formula_category_text']),
      }),
    );
  });

  test('overrides stale bundle product kind for shade-variant formula titles without category text', () => {
    expect(
      classifyExternalSeedProductKind({
        title: "Pro Filt'r Instant Retouch Concealer — #210",
        canonical_url: 'https://fentybeauty.com/products/pro-filtr-instant-retouch-concealer-420-concealer',
        seed_data: {
          product_kind: 'bundle',
          snapshot: {
            product_kind: 'bundle',
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'single_formula',
        reasons: expect.arrayContaining(['stale_bundle_kind_overridden_by_formula_variant_title']),
      }),
    );
  });

  test('keeps reviewed lip component pair products as sets, not stale single-formula variants', () => {
    expect(
      classifyExternalSeedProductKind({
        title: 'A Moment Matte Liquid Lipstick & Always and Forever Lip Liner',
        canonical_url: 'https://kyliecosmetics.com/products/a-moment-matte-liquid-lipstick-always-and-forever-lip-liner',
        seed_data: {
          product_family: 'set_or_collection',
          product_type: 'Matte Liquid Lipstick',
          snapshot: {
            product_family: 'set_or_collection',
            product_type: 'Matte Liquid Lipstick',
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'set_or_collection',
        reasons: expect.arrayContaining(['formula_component_pair_signal']),
      }),
    );

    expect(
      classifyExternalSeedProductKind({
        title: 'Match My Energy Gloss Drip & Iced Latte Lip Liner',
        seed_data: {
          product_type: 'Lip Gloss',
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'set_or_collection',
        reasons: expect.arrayContaining(['formula_component_pair_signal']),
      }),
    );
  });

  test('overrides stale accessory product kind for formula makeup PDPs', () => {
    expect(
      classifyExternalSeedProductKind({
        title: 'TERRACOTTA LIGHT THE SUN-KISSED NATURAL HEALTHY GLOW POWDER',
        product_type: 'Face Powder',
        canonical_url: 'https://www.guerlain.com/us/en-us/p/terracotta-light-the-sun-kissed-natural-healthy-glow-powder',
        seed_data: {
          product_family: 'accessory',
          product_type: 'Face Powder',
          snapshot: {
            product_family: 'accessory',
            product_type: 'Face Powder',
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'single_formula',
        reasons: expect.arrayContaining(['stale_accessory_kind_overridden_by_formula_signal']),
      }),
    );

    expect(
      classifyExternalSeedProductKind({
        title: 'Foundation Brush 02',
        product_type: 'Brush',
        seed_data: {
          product_family: 'accessory',
          product_type: 'Brush',
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'accessory',
        reasons: expect.arrayContaining(['explicit_product_family_signal']),
      }),
    );

    expect(
      classifyExternalSeedProductKind({
        title: 'Cosmic Tray',
        product_type: 'Fragrance accessory',
        canonical_url: 'https://kyliecosmetics.com/products/cosmic-by-kylie-jenner-eau-de-parfum-fragrance-tray',
        seed_data: {
          product_family: 'accessory',
          product_type: 'Fragrance accessory',
          snapshot: {
            product_family: 'accessory',
            product_type: 'Fragrance accessory',
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'accessory',
        reasons: expect.arrayContaining(['explicit_product_family_signal']),
      }),
    );
  });

  test('lets strong collection titles override stale single-formula seed kind', () => {
    expect(
      classifyExternalSeedProductKind({
        title: 'The Smooth Skin Collection',
        seed_data: {
          product_kind: 'single_formula',
          snapshot: {
            product_kind: 'single_formula',
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'set_or_collection',
        reasons: expect.arrayContaining(['collection_bundle_overrides_single_formula_signal']),
      }),
    );
  });

  test('classifies hidden free-gift app products as non-merch', () => {
    expect(
      classifyExternalSeedProductKind({
        title: 'Blush Brush (100% off)',
        canonical_url: 'https://pixibeauty.com/products/blush-brush-sca_clone_freegift',
        seed_data: {
          description: 'This product is used for the app BOGOS.io Free Gift BOGO Bundle to work.',
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'non_merch',
        reasons: expect.arrayContaining(['non_merch_signal']),
      }),
    );

    expect(classifyExternalSeedProductKind({ title: 'Mystery Gift' })).toEqual(
      expect.objectContaining({
        family: 'non_merch',
        reasons: expect.arrayContaining(['non_merch_signal']),
      }),
    );
  });

  test('classifies beauty-branded apparel as non-merch', () => {
    expect(classifyExternalSeedProductKind({ title: 'Pixi 25th Anniversary Hoodie' })).toEqual(
      expect.objectContaining({
        family: 'non_merch',
        reasons: expect.arrayContaining(['apparel_non_merch_signal']),
      }),
    );
  });

  test('classifies advent and 12-days calendars as collection sets', () => {
    expect(classifyExternalSeedProductKind({ title: '12 Days of Icons Calendar' })).toEqual(
      expect.objectContaining({
        family: 'set_or_collection',
        reasons: expect.arrayContaining(['bundle_set_signal']),
      }),
    );

    expect(classifyExternalSeedProductKind({ title: '12 Days of Kylie Advent Calendar' })).toEqual(
      expect.objectContaining({
        family: 'set_or_collection',
        reasons: expect.arrayContaining(['bundle_set_signal']),
      }),
    );
  });

  test('classifies reviewed beauty merch edge cases without suppressing sample ingredients', () => {
    expect(classifyExternalSeedProductKind({ title: 'Hooded Bath Towel' })).toEqual(
      expect.objectContaining({
        family: 'accessory',
        reasons: expect.arrayContaining(['accessory_signal']),
      }),
    );

    const sample = {
      title: 'Wisp Lash Mascara Mini Deluxe Sample',
      seed_data: {
        product_type: 'Mascara',
      },
    };
    expect(classifyExternalSeedProductKind(sample)).toEqual(
      expect.objectContaining({
        family: 'sample',
        reasons: expect.arrayContaining(['sample_like_signal']),
      }),
    );
    expect(isIngredientAuthorityEligibleExternalSeed(sample)).toBe(true);

    expect(classifyExternalSeedProductKind({ title: 'Ampoule Mask Packs' })).toEqual(
      expect.objectContaining({
        family: 'set_or_collection',
        reasons: expect.arrayContaining(['bundle_set_signal']),
      }),
    );

    expect(classifyExternalSeedProductKind({ title: 'Kylash False Lashes' })).toEqual(
      expect.objectContaining({
        family: 'accessory',
        reasons: expect.arrayContaining(['false_lash_accessory_signal']),
      }),
    );

    expect(classifyExternalSeedProductKind({ title: 'Power Plush Longwear Foundation Sample' })).toEqual(
      expect.objectContaining({
        family: 'sample',
        reasons: expect.arrayContaining(['sample_like_signal']),
      }),
    );

    expect(
      classifyExternalSeedProductKind({
        title: 'Koko K Matte Liquid Lipstick Sample',
        canonical_url: 'https://kyliecosmetics.com/products/koko-k-matte-liquid-lipstick-sample',
        seed_data: {
          product_kind: 'single_formula',
          product_type: 'Sample',
          snapshot: {
            product_kind: 'single_formula',
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        family: 'sample',
        reasons: expect.arrayContaining(['sample_like_signal']),
      }),
    );
  });
});
