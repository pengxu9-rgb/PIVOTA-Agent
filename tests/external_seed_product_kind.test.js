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

    expect(classifyExternalSeedProductKind({ title: 'Power Plush Longwear Foundation Sample' })).toEqual(
      expect.objectContaining({
        family: 'sample',
        reasons: expect.arrayContaining(['sample_like_signal']),
      }),
    );
  });
});
