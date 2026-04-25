const {
  inferBeautyRoleIntent,
  evaluateProductForBeautyRole,
  applyBeautyRoleCompatibleSelection,
} = require('../src/modules/policy/beautyRoleCompatibleSelection');

describe('beauty role compatible selection policy', () => {
  test('infers clear moisturizer and sunscreen role intents', () => {
    expect(
      inferBeautyRoleIntent({
        queryText: 'My skin feels dry and tight after washing. What moisturizer should I use first?',
      }),
    ).toBe('moisturizer');
    expect(
      inferBeautyRoleIntent({
        queryText: 'I have oily skin, what sunscreen should I buy?',
      }),
    ).toBe('sunscreen');
    expect(
      inferBeautyRoleIntent({
        queryText: 'Combination skin, clogged pores, Seattle winter, simple routine.',
      }),
    ).toBe('moisturizer');
  });

  test('keeps simple routine and first-buy asks focused on routine-compatible moisturizers', () => {
    const result = applyBeautyRoleCompatibleSelection({
      operation: 'find_products_multi',
      invokeSearchRail: 'authoritative_shopping',
      queryText: 'I have combination skin with clogged pores in Seattle winter and want a simple routine.',
      search: {
        catalog_surface: 'beauty',
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'beauty',
      },
      beautyRequest: {
        domain: 'beauty',
        user_goal: 'I have combination skin with clogged pores in Seattle winter and want a simple routine.',
        skin_context: { skin_type: 'combination', concerns: ['clogged pores'] },
        scenario_context: { location: 'Seattle', season: 'winter' },
        constraints: { routine_complexity: 'simple' },
      },
      responseBody: {
        products: [
          { canonical_title: 'Air Angel Peptide Plumping Gel Cream', brand: 'Dieux', canonical_category: 'external' },
          { canonical_title: 'Triple Lipid-Peptide Cream', brand: 'Skinfix', canonical_category: 'external' },
          { canonical_title: 'Acne Healing Dots Jumbo', brand: 'Peace Out Skincare', canonical_category: 'external' },
          { canonical_title: 'Acne Healing Dots', brand: 'Peace Out Skincare', canonical_category: 'external' },
        ],
        metadata: {},
      },
    });

    expect(result.products.map((product) => product.canonical_title)).toEqual([
      'Air Angel Peptide Plumping Gel Cream',
      'Triple Lipid-Peptide Cream',
    ]);
    expect(result.metadata.beauty_role_compatible_selection).toMatchObject({
      applied: true,
      role: 'moisturizer',
      original_count: 4,
      selected_count: 2,
    });
    expect(result.metadata.beauty_role_compatible_selection.dropped_titles.map((row) => row.title)).toEqual(
      expect.arrayContaining(['Acne Healing Dots Jumbo', 'Acne Healing Dots']),
    );
  });

  test('scores retinoid-conflicting and spf moisturizer rows below role-compatible moisturizers', () => {
    const queryText = 'I have dry sensitive skin, use tretinoin at night, and want a moisturizer under $30.';
    const tripleLipid = evaluateProductForBeautyRole(
      { canonical_title: 'Triple Lipid-Peptide Cream', canonical_category: 'Moisturizer' },
      'moisturizer',
      queryText,
    );
    const dayscreen = evaluateProductForBeautyRole(
      { canonical_title: 'Dayscreen Moisturizer SPF 30', canonical_category: 'Moisturizer' },
      'moisturizer',
      queryText,
    );
    const revive = evaluateProductForBeautyRole(
      { canonical_title: 'Revive Firming Moisturizer : Ginseng + Retinol', canonical_category: 'Moisturizer' },
      'moisturizer',
      queryText,
    );

    expect(tripleLipid.role_fit).toBe('role_match');
    expect(dayscreen.role_fit).toBe('role_mismatch');
    expect(revive.role_fit).toBe('hard_invalid');
    expect(revive.hard_reasons).toContain('active_conflict');
  });

  test('filters moisturizer requests to role-compatible rows before beauty expert projection', () => {
    const result = applyBeautyRoleCompatibleSelection({
      operation: 'find_products_multi',
      invokeSearchRail: 'authoritative_shopping',
      queryText: 'I have dry sensitive skin, use tretinoin at night, and want a moisturizer under $30.',
      search: {
        catalog_surface: 'beauty',
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'beauty',
      },
      beautyRequest: {
        domain: 'beauty',
        user_goal: 'I have dry sensitive skin, use tretinoin at night, and want a moisturizer under $30.',
        skin_context: { skin_type: 'dry sensitive' },
        routine_context: { actives: ['tretinoin'] },
      },
      responseBody: {
        products: [
          { canonical_title: 'Calming Barrier Serum', canonical_category: 'Serum' },
          { canonical_title: 'Dayscreen Moisturizer SPF 30', canonical_category: 'Moisturizer' },
          { canonical_title: 'Revive Firming Moisturizer : Ginseng + Retinol', canonical_category: 'Moisturizer' },
          { canonical_title: 'Triple Lipid-Peptide Cream', canonical_category: 'Moisturizer' },
        ],
        metadata: {},
      },
    });

    expect(result.products.map((product) => product.canonical_title)).toEqual([
      'Triple Lipid-Peptide Cream',
    ]);
    expect(result.reason_codes).toContain('beauty_role_compatible_selection_applied');
    expect(result.metadata.beauty_role_compatible_selection).toMatchObject({
      applied: true,
      role: 'moisturizer',
      original_count: 4,
      selected_count: 1,
    });
    expect(result.metadata.beauty_role_compatible_selection.dropped_titles.map((row) => row.title)).toEqual(
      expect.arrayContaining([
        'Calming Barrier Serum',
        'Dayscreen Moisturizer SPF 30',
        'Revive Firming Moisturizer : Ginseng + Retinol',
      ]),
    );
  });

  test('drops makeup hair and tools from creator skincare audience requests', () => {
    const result = applyBeautyRoleCompatibleSelection({
      operation: 'find_products_multi',
      invokeSearchRail: 'authoritative_shopping',
      queryText: 'My audience has dry sensitive skin, what moisturizer should I recommend?',
      search: {
        catalog_surface: 'beauty',
      },
      metadata: {
        source: 'creator_agent',
        catalog_surface: 'beauty',
        beauty_domain_hint: 'beauty',
      },
      beautyRequest: {
        domain: 'beauty',
        user_goal: 'My audience has dry sensitive skin, what moisturizer should I recommend?',
        skin_context: { skin_type: 'dry sensitive' },
        scenario_context: { audience: 'creator audience' },
      },
      responseBody: {
        products: [
          { canonical_title: 'Pixi + Maryam Maquillage Anywhere Gloss | MaryamNYC Limited Edition', canonical_category: 'Lip Gloss' },
          { canonical_title: 'Sensitive Skin Set', canonical_category: 'Skincare Set' },
          { canonical_title: 'Oil Control Duo: Invisimatte Powder And Dry Shampoo', canonical_category: 'Hair Set' },
          { canonical_title: 'Triple Lipid-Peptide Cream', canonical_category: 'Moisturizer' },
          { canonical_title: "Sigma Dry'n Shape® Tower Face & Eyes", canonical_category: 'Beauty Tool' },
        ],
        metadata: {},
      },
    });

    expect(result.products.map((product) => product.canonical_title)).toEqual([
      'Triple Lipid-Peptide Cream',
    ]);
    expect(result.metadata.beauty_role_compatible_selection.hard_dropped_count).toBe(3);
  });

  test('keeps sunscreen rows for explicit sunscreen comparisons', () => {
    const result = applyBeautyRoleCompatibleSelection({
      operation: 'find_products_multi',
      invokeSearchRail: 'authoritative_shopping',
      queryText: 'I have oily skin, what sunscreen should I buy?',
      search: {
        catalog_surface: 'beauty',
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'beauty',
      },
      beautyRequest: {
        domain: 'beauty',
        user_goal: 'I have oily skin, what sunscreen should I buy?',
      },
      responseBody: {
        products: [
          { canonical_title: 'Birch Mild-Up Sunscreen UVLock SPF 50+ Broad Spectrum', canonical_category: 'Sunscreen' },
          { canonical_title: 'Daily Soothing Sun Shield SPF50+ PA++++', canonical_category: 'Sunscreen' },
          { canonical_title: 'Calming Barrier Serum', canonical_category: 'Serum' },
        ],
        metadata: {},
      },
    });

    expect(result.products.map((product) => product.canonical_title)).toEqual([
      'Birch Mild-Up Sunscreen UVLock SPF 50+ Broad Spectrum',
      'Daily Soothing Sun Shield SPF50+ PA++++',
    ]);
  });

  test('infers exact-product sunscreen role from authoritative product rows and drops cross-role noise', () => {
    const result = applyBeautyRoleCompatibleSelection({
      operation: 'find_products_multi',
      invokeSearchRail: 'authoritative_shopping',
      queryText: 'Is Beauty of Joseon Relief Sun Aqua-Fresh good for oily skin under makeup?',
      search: {
        catalog_surface: 'beauty',
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'beauty',
      },
      beautyRequest: {
        domain: 'beauty',
        user_goal: 'Is Beauty of Joseon Relief Sun Aqua-Fresh good for oily skin under makeup?',
        skin_context: { skin_type: 'oily' },
        product_context: { canonical_product_ref: 'beauty of joseon relief sun aqua-fresh' },
        scenario_context: { use_case: 'under makeup' },
      },
      responseBody: {
        products: [
          {
            canonical_title: 'Relief Sun Aqua-Fresh 10ml',
            canonical_category: 'Sunscreen',
            product_type: 'Sunscreen',
            description: 'SPF 50+ PA++++ lightweight fast-absorbing sunscreen.',
          },
          { canonical_title: 'The Ordinary Niacinamide 10% + Zinc 1%', canonical_category: 'Serum' },
          { canonical_title: 'Moroccanoil Treatment Original', brand: 'Moroccanoil', canonical_category: 'external' },
          { canonical_title: 'Small Eyeshadow Brush', canonical_category: 'Beauty Tool' },
        ],
        metadata: {},
      },
    });

    expect(result.products.map((product) => product.canonical_title)).toEqual([
      'Relief Sun Aqua-Fresh 10ml',
    ]);
    expect(result.metadata.beauty_role_compatible_selection).toMatchObject({
      applied: true,
      role: 'sunscreen',
      original_count: 4,
      selected_count: 1,
    });
    expect(result.metadata.beauty_role_compatible_selection.dropped_titles.map((row) => row.title)).toEqual(
      expect.arrayContaining([
        'The Ordinary Niacinamide 10% + Zinc 1%',
        'Moroccanoil Treatment Original',
        'Small Eyeshadow Brush',
      ]),
    );
  });

  test('returns an honest empty response when moisturizer recall only contains incompatible rows', () => {
    const result = applyBeautyRoleCompatibleSelection({
      operation: 'find_products_multi',
      invokeSearchRail: 'authoritative_shopping',
      queryText: 'I have dry sensitive skin, use tretinoin at night, and want a moisturizer under $30.',
      search: {
        catalog_surface: 'beauty',
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'beauty',
      },
      beautyRequest: {
        domain: 'Beauty',
        user_goal: 'I have dry sensitive skin, use tretinoin at night, and want a moisturizer under $30.',
        skin_context: { skin_type: 'dry sensitive' },
        routine_context: { actives: ['tretinoin'] },
      },
      responseBody: {
        products: [
          { canonical_title: 'Calming Barrier Serum', canonical_category: 'Serum' },
          { canonical_title: 'Dayscreen Moisturizer SPF 30', canonical_category: 'Moisturizer' },
          { canonical_title: 'Revive Firming Moisturizer : Ginseng + Retinol', canonical_category: 'Moisturizer' },
        ],
        metadata: {},
      },
    });

    expect(result.products).toEqual([]);
    expect(result.reply).toBe('I do not have a role-compatible grounded skincare match from the current catalog for that request yet.');
    expect(result.has_good_match).toBe(false);
    expect(result.match_confidence).toBe('none');
    expect(result.reason_codes).toEqual(
      expect.arrayContaining([
        'beauty_role_compatible_selection_applied',
        'beauty_role_compatible_selection_empty',
      ]),
    );
  });
});
