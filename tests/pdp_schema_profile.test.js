const { PDP_SCHEMA_PROFILES, resolvePdpSchemaProfile } = require('../src/pdpSchemaProfile');

describe('PDP schema profile resolution', () => {
  test('single-formula product family overrides merch words in refill pouch titles', () => {
    expect(
      resolvePdpSchemaProfile({
        title: 'Oat So Simple Water Cream Refill Pouch',
        product_family: 'single_formula',
        pdp_ingredients_raw: 'Water, Butylene Glycol, Squalane, Avena Sativa (Oat) Meal Extract.',
      }),
    ).toBe(PDP_SCHEMA_PROFILES.BEAUTY_FORMULA);
  });

  test('accessory product family keeps pouch products out of formula modules', () => {
    expect(
      resolvePdpSchemaProfile({
        title: 'Lucky Pouch',
        product_family: 'accessory',
        pdp_ingredients_raw: 'Water, Glycerin, Niacinamide.',
      }),
    ).toBe(PDP_SCHEMA_PROFILES.GENERIC_MERCH);
  });

  test('set product family does not become formula from component-level ingredient notes', () => {
    expect(
      resolvePdpSchemaProfile({
        title: 'Every Love, Every Moment Gift Set',
        product_family: 'set_or_collection',
        ingredient_intel: {
          component_level_required: true,
        },
      }),
    ).toBe(PDP_SCHEMA_PROFILES.GENERIC_PRODUCT);
  });

  test('catalog formula category path overrides stale brush category text', () => {
    expect(
      resolvePdpSchemaProfile({
        title: 'Eaze Drop Blur + Smooth Tint Stick - 10',
        category: 'Brush',
        catalog_category_path: 'beauty/makeup/face/foundation',
        pdp_ingredients_raw: 'DIMETHICONE, OCTYLDODECANOL, SYNTHETIC WAX, SILICA.',
      }),
    ).toBe(PDP_SCHEMA_PROFILES.BEAUTY_FORMULA);
  });

  test('catalog tool category path stays beauty tool', () => {
    expect(
      resolvePdpSchemaProfile({
        title: 'Reusable Makeup Sponge',
        category: 'Beauty Tool',
        catalog_category_path: 'beauty/tools/brush',
        ingredients_inci: { items: ['Polyurethane'] },
      }),
    ).toBe(PDP_SCHEMA_PROFILES.BEAUTY_TOOL);
  });
});
