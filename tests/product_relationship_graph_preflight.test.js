const {
  isIncoherentBeautyEdge,
} = require('../src/auroraBff/productRelationshipGraphPreflight');

function product(overrides = {}) {
  return {
    name: 'Barrier Support Serum',
    brand: 'Fixture Beauty',
    category: 'Skincare > Serum',
    category_taxonomy: ['skincare', 'serum'],
    description: 'Hydrating barrier support for facial skin.',
    ...overrides,
  };
}

describe('product relationship graph incoherence preflight', () => {
  test('flags non-beauty jewelry/crystal rows even when category is mislabeled beauty', () => {
    const reason = isIncoherentBeautyEdge(
      product({ name: 'Rose Quartz Crystal Charm Necklace', category: 'Beauty Product' }),
      product({ name: 'Soft Pink Powder Blush', category: 'Blush', description: 'Cheek color makeup.' }),
      'competitive_alternative',
    );

    expect(reason).toBe('anchor_non_beauty:jewelry_crystal_or_charm');
  });

  test('does not flag legitimate crystal-word beauty products', () => {
    const reason = isIncoherentBeautyEdge(
      product({ name: 'Crystal Deodorant Stick', category: 'Body Care > Deodorant' }),
      product({ name: 'Unscented Deodorant Stick', category: 'Body Care > Deodorant' }),
      'competitive_alternative',
    );

    expect(reason).toBe(null);
  });

  test('flags clear target-area mismatch', () => {
    const reason = isIncoherentBeautyEdge(
      product({ name: 'Ceramide Face Serum', category: 'Skincare > Serum', target_area: 'face' }),
      product({
        name: 'Repair Shampoo for Damaged Hair',
        category: 'Hair Care > Shampoo',
        target_area: 'hair',
        description: 'Hair and scalp cleanser for damaged lengths.',
      }),
      'competitive_alternative',
    );

    expect(reason).toBe('target_area_mismatch:face_vs_hair');
  });

  test('flags clear structural category incoherence', () => {
    const reason = isIncoherentBeautyEdge(
      product({ name: 'Hydrating Barrier Serum', category: 'Skincare > Serum' }),
      product({ name: 'Soft Matte Liquid Foundation', category: 'Makeup > Foundation' }),
      'dupe',
    );

    expect(reason).toBe('category_incoherence:serum_vs_foundation');
  });

  test('keeps compatible structural beauty pairs', () => {
    const reason = isIncoherentBeautyEdge(
      product({ name: 'Barrier Repair Serum', category: 'Skincare > Serum' }),
      product({ name: 'Ceramide Barrier Serum', category: 'Skincare > Serum' }),
      'competitive_alternative',
    );

    expect(reason).toBe(null);
  });

  test('keeps related lip-line pairs', () => {
    const reason = isIncoherentBeautyEdge(
      product({ name: 'Rose Lipstick', category: 'Makeup > Lipstick' }),
      product({ name: 'Rose Lip Liner', category: 'Makeup > Lip Liner' }),
      'related_product',
    );

    expect(reason).toBe(null);
  });
});
