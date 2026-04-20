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

  test('filters stale non-reviewed existing authority active items against INCI', () => {
    const authority = buildAuthoritativeIngredientView({
      ingredient_intel: {
        authoritative: {
          raw_text: 'Water, Glycerin, Niacinamide, Squalane, Lactic Acid',
          items: ['Water', 'Glycerin', 'Niacinamide', 'Squalane', 'Lactic Acid'],
          active_items: ['Ceramide NP', 'Niacinamide', 'Vitamin C (Ascorbic acid)', 'Squalane'],
          source_origin: 'pdp_section',
          purity_status: 'authoritative',
        },
      },
    });

    expect(authority.source_origin).toBe('pdp_section');
    expect(authority.active_items).toEqual(['Niacinamide', 'Squalane']);
    expect(authority.active_items).not.toEqual(
      expect.arrayContaining(['Ceramide NP', 'Vitamin C (Ascorbic acid)']),
    );
  });

  test('repairs stale sunscreen active items from authoritative INCI', () => {
    const authority = buildAuthoritativeIngredientView({
      title: 'Daily Tinted Fluid Sunscreen DN350 SPF 40',
      category: 'Sunscreen',
      ingredient_intel: {
        authoritative: {
          raw_text:
            'Zinc Oxide (CI 77947), Water, Butyloctyl Salicylate, 1,2-Hexanediol, Tocopherol',
          items: [
            'Zinc Oxide (CI 77947)',
            'Water',
            'Butyloctyl Salicylate',
            '1,2-Hexanediol',
            'Tocopherol',
          ],
          active_items: ['Zinc PCA'],
          source_origin: 'kb_reviewed',
          purity_status: 'authoritative',
        },
      },
    });

    expect(authority.active_items).toEqual(['Zinc Oxide']);
    expect(authority.active_items).not.toContain('Zinc PCA');
  });

  test('filters stale active arrays against authoritative full INCI', () => {
    const authority = buildAuthoritativeIngredientView({
      pdp_ingredients_raw:
        'Full Ingredients: Water (Aqua/Eau), Propanediol, Calophyllum Inophyllum (Tamanu) Seed Oil, Dipropylene Glycol, Niacinamide, Glycerin, Squalane, Lactic Acid.',
      active_ingredients: [
        'Ceramide NP',
        'Niacinamide',
        'Vitamin C (Ascorbic acid)',
        'Glycerin',
        'Hyaluronic acid',
        'Squalane',
        'Lactic Acid',
      ],
    });

    expect(authority.purity_status).toBe('authoritative');
    expect(authority.active_items).toEqual(['Niacinamide', 'Glycerin', 'Squalane', 'Lactic Acid']);
    expect(authority.active_items).not.toEqual(
      expect.arrayContaining([
        'Ceramide NP',
        'Vitamin C (Ascorbic acid)',
        'Hyaluronic acid',
      ]),
    );
  });

  test('parses inline full ingredient list from generic details sections', () => {
    const authority = buildAuthoritativeIngredientView({
      pdp_details_sections: [
        {
          heading: 'Details',
          body:
            'Key Ingredients\nRice Extract\nRice Amino Acids\nFull Ingredient List\nAQUA, METHYLPROPANEDIOL, PROPANEDIOL, 1,2-HEXANEDIOL, GLYCERIN, ORYZA SATIVA (RICE) EXTRACT, RICE AMINO ACIDS. Warning: For external use only.',
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

  test('keeps comma-separated numeric ingredient prefixes together when spaces are present', () => {
    const authority = buildAuthoritativeIngredientView({
      pdp_ingredients_raw:
        'Full Ingredient List: Water, 1, 2-Hexanediol, Glycerin, PEG-60 Hydrogenated Castor Oil.',
    });

    expect(authority.items).toEqual(
      expect.arrayContaining([
        'Water',
        '1, 2-Hexanediol',
        'Glycerin',
        'PEG-60 Hydrogenated Castor Oil',
      ]),
    );
    expect(authority.items).not.toEqual(expect.arrayContaining(['1', '2-Hexanediol']));
  });

  test('filters ingredient function labels from role-annotated ingredient lists', () => {
    const authority = buildAuthoritativeIngredientView({
      pdp_ingredients_raw:
        'Carrier, Water, Emollient, Simmondsia Chinensis (Jojoba) Seed Oil, Humectant, Methylpropanediol, 1,2-Hexanediol, Thickener, Polyvinyl Alcohol, Skin Conditioner, Ceramide NP',
    });

    expect(authority.items).toEqual(
      expect.arrayContaining([
        'Water',
        'Simmondsia Chinensis (Jojoba) Seed Oil',
        'Methylpropanediol',
        '1,2-Hexanediol',
        'Polyvinyl Alcohol',
        'Ceramide NP',
      ]),
    );
    expect(authority.items).not.toEqual(
      expect.arrayContaining([
        'Carrier',
        'Emollient',
        'Humectant',
        'Thickener',
        'Skin Conditioner',
      ]),
    );
  });

  test('reads body-based seed details sections when collecting authority', () => {
    const authority = buildAuthoritativeIngredientView({
      seed_data: {
        pdp_details_sections: [
          {
            heading: 'Full Ingredients',
            body: 'AQUA, GLYCERIN, NIACINAMIDE, PANTHENOL.',
            source_kind: 'html_snapshot_product_content',
          },
        ],
      },
    });

    expect(authority.purity_status).toBe('authoritative');
    expect(authority.items).toEqual(
      expect.arrayContaining([
        'AQUA',
        'GLYCERIN',
        'NIACINAMIDE',
        'PANTHENOL',
      ]),
    );
  });
});
