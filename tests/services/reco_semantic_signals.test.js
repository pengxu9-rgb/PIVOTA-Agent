const { inferVerticalFromProduct } = require('../../src/services/recoSemanticSignals');

describe('recoSemanticSignals', () => {
  test('classifies primer categories as makeup before serum texture copy', () => {
    const signal = inferVerticalFromProduct({
      title: 'Reflect Glow Prep Primer',
      category: 'Primer',
      product_type: 'Primer',
      description: '95% skincare-infused red serum primer for crystal glow, plumping and grip.',
    });

    expect(signal.vertical).toBe('makeup');
  });

  test('classifies string catalog category paths as makeup signals', () => {
    const signal = inferVerticalFromProduct({
      title: 'Skin Tint Blurring Elixir',
      brand: 'Kylie Cosmetics',
      category_path: 'beauty/makeup/face/foundation',
    });

    expect(signal.vertical).toBe('makeup');
  });
});
