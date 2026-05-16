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
});
