const { buildExternalSeedRecallDoc } = require('../src/services/externalSeedRecall');

function buildRecall({ title, category = '', productType = '', description = '' }) {
  return buildExternalSeedRecallDoc({
    row: {
      title,
      seed_category: category,
      seed_product_type: productType,
    },
    seedData: {
      category,
      product_type: productType,
      description,
      snapshot: {
        title,
        category,
        product_type: productType,
        description,
      },
    },
    snapshot: {
      title,
      category,
      product_type: productType,
      description,
    },
  });
}

describe('external seed recall doc', () => {
  test('infers narrow beauty leaf categories before broad source categories', () => {
    const cases = [
      ['The Homecurl Curl-Defining Cream', 'Moisturizer', 'Curl Cream'],
      ['The Controlling Type Hair-Thickening Edge Control Gel', 'Fragrance', 'Hair Gel'],
      ['The Protective Type Frizz-Smoothing Heat Protectant Styling Cream', 'Moisturizer', 'Heat Protectant'],
      ['The Imposter Invisi-Boost Volumizing Dry Shampoo Powder', 'Shampoo', 'Dry Shampoo'],
      ['The Richer One Moisture Repair Deep Conditioner', 'Conditioner', 'Deep Conditioner'],
      ['The Water Boi Reparative Leave-In Detangling Conditioner Spray', 'Conditioner', 'Leave-In Conditioner'],
      ['Natural Moisturizing Factors + HA for Scalp', 'Serum', 'Scalp Treatment'],
      ['Whole Body Deodorant Cream', 'Moisturizer', 'Deodorant'],
      ['Dew N Plump Intense Hydration Slushie Overnight Face Mask', 'Treatment', 'Hydrating Mask'],
      ['Poremizing Quick Clay Stick Mask', 'Treatment', 'Clay Mask'],
      ['You Mist Makeup-Extending Setting Spray', 'Fragrance', 'Setting Spray'],
      ['Brow Harmony Flexible Lifting Gel', '', 'Brow Gel'],
      ['Mushroom Sponge 2-Piece Makeup Blending Sponge', 'Moisturizer', 'Makeup Sponge'],
      ['Powder Puff Setting Brush 170', 'Powder', 'Makeup Brush'],
      ['Micellar Lotion - Cleansing and Make-up Remover', 'Cleanser', 'Makeup Remover'],
    ];

    for (const [title, sourceCategory, expectedCategory] of cases) {
      expect(buildRecall({ title, category: sourceCategory }).category).toBe(expectedCategory);
    }
  });
});
