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
});
