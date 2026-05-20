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

  test('keeps blemish patch stickers in skincare treatment intent instead of accessory fallback', () => {
    expect(_internals.getSimilarIntentFamilyFromText('Clarity Blemish Stickers')).toBe('blemish_patch');

    const result = pickLayeredRecommendations({
      baseProduct: {
        merchant_id: 'external_seed',
        product_id: 'ext_clarity_stickers',
        title: 'Clarity Blemish Stickers',
        brand: 'PIXI BEAUTY',
        category_path: 'beauty/skincare/treat/treatment',
        price_amount: 12,
        currency: 'USD',
        in_stock: true,
      },
      externalCandidates: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_overnight_spot_stickers',
          title: 'Overnight Spot Stickers',
          brand: 'PIXI BEAUTY',
          category_path: 'beauty/skincare/treat/treatment',
          price_amount: 12,
          currency: 'USD',
          in_stock: true,
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_logo_stickers',
          title: 'PIXI Logo Stickers',
          brand: 'PIXI BEAUTY',
          category_path: 'beauty/accessories/stickers',
          price_amount: 5,
          currency: 'USD',
          in_stock: true,
        },
      ],
      k: 4,
      baseSemantic: {
        vertical: 'skincare',
        signal_strength: 3,
      },
    });

    expect(result.items.map((item) => item.product_id)).toEqual(['ext_overnight_spot_stickers']);
    expect(result.debug.filters.by_confidence).toBeGreaterThanOrEqual(1);
  });

  test('treats lip blush and lip tint titles as lips intent peers', () => {
    expect(_internals.getSimilarIntentFamilyFromText('LipBlush')).toBe('lip_treatment');
    expect(_internals.getSimilarIntentFamilyFromText('Lip Tint')).toBe('lip_treatment');
    expect(_internals.getSimilarIntentFamilyFromText('Hydra LipTreat')).toBe('lip_treatment');
    expect(_internals.getSimilarIntentFamilyFromText('Rose Lip Nourisher')).toBe('lip_treatment');

    const result = pickLayeredRecommendations({
      baseProduct: {
        merchant_id: 'external_seed',
        product_id: 'ext_lipblush',
        title: 'LipBlush',
        brand: 'PIXI BEAUTY',
        category_path: 'beauty/makeup/lips/lip-tint',
        price_amount: 14,
        currency: 'USD',
        in_stock: true,
      },
      externalCandidates: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_lip_tint',
          title: 'Lip Tint',
          brand: 'PIXI BEAUTY',
          category_path: 'beauty/makeup/lips/lip-tint',
          price_amount: 14,
          currency: 'USD',
          in_stock: true,
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_eye_pen',
          title: 'Endless Silky Eye Pen',
          brand: 'PIXI BEAUTY',
          category_path: 'beauty/makeup/eye/eyeliner',
          price_amount: 12,
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

    expect(result.items.map((item) => item.product_id)).toEqual(['ext_lip_tint']);
  });
});
