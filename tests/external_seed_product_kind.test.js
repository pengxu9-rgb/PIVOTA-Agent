const { classifyExternalSeedProductKind } = require('../src/services/externalSeedProductKind');

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
});
