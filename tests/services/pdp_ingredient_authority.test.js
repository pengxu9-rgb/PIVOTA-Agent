const {
  buildAuthoritativeIngredientView,
  buildStructuredPdpIngredientModules,
} = require('../../src/services/pdpIngredientAuthority');

describe('pdpIngredientAuthority', () => {
  test('parses pure INCI from polluted Great Barrier style raw text', () => {
    const authority = buildAuthoritativeIngredientView({
      pdp_ingredients_raw:
        'Tamanu Oil: Soothes visible redness and supports the skin barrier. Full Ingredients: Water, Glycerin, Caprylic/Capric Triglyceride, 1,2-Hexanediol, Niacinamide, Cetearyl Alcohol. Warning: For external use only.',
      pdp_active_ingredients_raw:
        'Active Ingredients: Niacinamide, Tamanu Oil. Can I use this with an active ingredient?',
    });

    expect(authority.purity_status).toBe('authoritative');
    expect(authority.items).toEqual(
      expect.arrayContaining([
        'Water',
        'Glycerin',
        'Caprylic/Capric Triglyceride',
        '1,2-Hexanediol',
        'Niacinamide',
      ]),
    );
    expect(authority.items).not.toEqual(expect.arrayContaining(['1']));
    expect(authority.items.some((item) => /Tamanu Oil:/i.test(item))).toBe(false);
    expect(authority.items.some((item) => /fades discoloration|supports the skin barrier/i.test(item))).toBe(
      false,
    );
    expect(authority.active_items).toEqual(expect.arrayContaining(['Niacinamide', 'Tamanu Oil']));
  });

  test('suppresses full INCI when only active ingredient block is trustworthy', () => {
    const modules = buildStructuredPdpIngredientModules({
      pdp_active_ingredients_raw:
        'Active Ingredients: Salicylic Acid, Zinc PCA. Can I use this with an active ingredient?',
      description:
        'Best for blemish-prone skin. How to Pair: layer with our calming serum.',
    });

    expect(modules.ingredientsInciData).toBeNull();
    expect(modules.activeIngredientsData).toEqual(
      expect.objectContaining({
        items: ['Salicylic Acid', 'Zinc PCA'],
      }),
    );
    expect(modules.authority.purity_status).toBe('suppressed');
    expect(modules.authority.suppressed_reason).toBe('full_inci_low_purity');
  });

  test('prefers existing authoritative ingredient block when already clean', () => {
    const authority = buildAuthoritativeIngredientView({
      ingredient_intel: {
        authoritative: {
          raw_text: 'Water, Glycerin, Niacinamide',
          items: ['Water', 'Glycerin', 'Niacinamide'],
          active_items: ['Niacinamide'],
          source_origin: 'kb_reviewed',
          purity_status: 'authoritative',
        },
      },
    });

    expect(authority.source_origin).toBe('kb_reviewed');
    expect(authority.items).toEqual(['Water', 'Glycerin', 'Niacinamide']);
    expect(authority.active_items).toEqual(['Niacinamide']);
  });

  test('parses inline full ingredient list from generic details sections', () => {
    const authority = buildAuthoritativeIngredientView({
      pdp_details_sections: [
        {
          heading: 'Details',
          content:
            'Key Ingredients\nRice Extract\nRice Amino Acids\nFull Ingredient List: AQUA, METHYLPROPANEDIOL, PROPANEDIOL, 1,2-HEXANEDIOL, GLYCERIN, ORYZA SATIVA (RICE) EXTRACT, RICE AMINO ACIDS. Warning: For external use only.',
        },
      ],
    });

    expect(authority.purity_status).toBe('authoritative');
    expect(authority.items).toEqual(
      expect.arrayContaining([
        'AQUA',
        'METHYLPROPANEDIOL',
        'PROPANEDIOL',
        '1,2-HEXANEDIOL',
        'GLYCERIN',
        'ORYZA SATIVA (RICE) EXTRACT',
        'RICE AMINO ACIDS',
      ]),
    );
  });
});
