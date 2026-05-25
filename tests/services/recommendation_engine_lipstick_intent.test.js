const RecommendationEngine = require('../../src/services/RecommendationEngine');

describe('RecommendationEngine lipstick similar intent', () => {
  const { _internals } = RecommendationEngine;

  beforeEach(() => {
    _internals.resetCache();
  });

  test('classifies lip paint and liquid lip color as lipstick, not generic lip treatment', () => {
    expect(_internals.getSimilarIntentFamilyFromText('Stunna Lip Paint Longwear Fluid Lip Color')).toBe('lipstick');
    expect(_internals.getSimilarIntentFamilyFromText('Fenty Icon Velvet Liquid Lipstick')).toBe('lipstick');
    expect(_internals.getSimilarIntentFamilyFromText('Gloss Bomb Universal Lip Luminizer')).toBe('lip_treatment');
  });

  test('keeps lipstick similar recall from drifting into lip gloss or lip stain candidates', async () => {
    const base = {
      merchant_id: 'external_seed',
      product_id: 'fenty-base-stunna',
      external_product_id: 'fenty-base-stunna',
      source: 'external_seed',
      title: 'Stunna Lip Paint Longwear Fluid Lip Color - Uncensored',
      brand: 'Fenty Beauty',
      category: 'lipstick',
      product_type: 'lipstick',
      category_path: 'beauty/makeup/lip/lipstick',
      catalog_category_path: 'beauty/makeup/lip/lipstick',
      semantic_vertical: 'makeup',
      price: 20,
      currency: 'USD',
      image_url: 'https://cdn.example.test/stunna.jpg',
      availability: 'in_stock',
    };

    const lipstick = {
      merchant_id: 'external_seed',
      product_id: 'fenty-lipstick-2',
      external_product_id: 'fenty-lipstick-2',
      source: 'external_seed',
      title: 'Fenty Icon Velvet Liquid Lipstick - The MVP',
      brand: 'Fenty Beauty',
      category: 'lipstick',
      product_type: 'lipstick',
      category_path: 'beauty/makeup/lip/lipstick',
      catalog_category_path: 'beauty/makeup/lip/lipstick',
      semantic_vertical: 'makeup',
      price: 29,
      currency: 'USD',
      image_url: 'https://cdn.example.test/lipstick.jpg',
      availability: 'in_stock',
    };

    const gloss = {
      merchant_id: 'external_seed',
      product_id: 'fenty-gloss-1',
      external_product_id: 'fenty-gloss-1',
      source: 'external_seed',
      title: 'Gloss Bomb Universal Lip Luminizer - Fenty Glow',
      brand: 'Fenty Beauty',
      category: 'lip gloss',
      product_type: 'lip gloss',
      category_path: 'beauty/makeup/lip/lip-gloss',
      catalog_category_path: 'beauty/makeup/lip/lip-gloss',
      semantic_vertical: 'makeup',
      price: 22,
      currency: 'USD',
      image_url: 'https://cdn.example.test/gloss.jpg',
      availability: 'in_stock',
    };

    const stain = {
      merchant_id: 'external_seed',
      product_id: 'fenty-stain-1',
      external_product_id: 'fenty-stain-1',
      source: 'external_seed',
      title: 'Poutsicle Hydrating Lip Stain - Fuchsia Wife',
      brand: 'Fenty Beauty',
      category: 'lip stain',
      product_type: 'lip stain',
      category_path: 'beauty/makeup/lip/lip-stain',
      catalog_category_path: 'beauty/makeup/lip/lip-stain',
      semantic_vertical: 'makeup',
      price: 27,
      currency: 'USD',
      image_url: 'https://cdn.example.test/stain.jpg',
      availability: 'in_stock',
    };

    const result = await RecommendationEngine.recommend({
      pdp_product: base,
      k: 6,
      options: {
        no_cache: true,
        internal_candidates: [],
        external_candidates: [lipstick, gloss, stain],
      },
    });

    expect(result.items.map((item) => item.product_id)).toEqual(['fenty-lipstick-2']);
    expect(result.debug.base.vertical).toBe('makeup');
    expect(result.debug.layers).toEqual(expect.objectContaining({ L2: 1 }));
  });
});
