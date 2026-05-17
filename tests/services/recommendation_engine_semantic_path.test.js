const { pickLayeredRecommendations, _internals } = require('../../src/services/RecommendationEngine');

describe('RecommendationEngine semantic path helpers', () => {
  test('reads leaf and parent category from string catalog paths', () => {
    const product = {
      title: 'Skin Tint Blurring Elixir',
      brand: 'Kylie Cosmetics',
      category_path: 'beauty/makeup/face/foundation',
    };

    expect(_internals.getLeafCategory(product)).toBe('foundation');
    expect(_internals.getParentCategory(product)).toBe('face');
  });

  test('does not recommend bundles as same-product alternatives for single external PDPs', () => {
    const result = pickLayeredRecommendations({
      baseProduct: {
        merchant_id: 'external_seed',
        product_id: 'ext_skin_tint',
        title: 'Skin Tint Blurring Elixir',
        brand: 'Kylie Cosmetics',
        category_path: 'beauty/makeup/face/foundation',
        price_amount: 34,
        currency: 'USD',
        in_stock: true,
      },
      externalCandidates: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_foundation_duo',
          title: 'Power Plush Foundation & Concealer Duo',
          brand: 'Kylie Cosmetics',
          category_path: 'beauty/makeup/face/foundation',
          price_amount: 68,
          currency: 'USD',
          in_stock: true,
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_cushion_refill',
          title: 'Mask Fit Red Cushion Refill',
          brand: 'TIRTIR Global',
          category_path: 'beauty/makeup/face/foundation',
          price_amount: 22,
          currency: 'USD',
          in_stock: true,
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_power_plush',
          title: 'Power Plush Longwear Foundation',
          brand: 'Kylie Cosmetics',
          category_path: 'beauty/makeup/face/foundation',
          price_amount: 38,
          currency: 'USD',
          in_stock: true,
        },
      ],
      k: 4,
      baseSemantic: {
        vertical: 'makeup',
        signal_strength: 3,
      },
    });

    expect(result.items.map((item) => item.product_id)).toEqual(['ext_power_plush']);
  });
});
