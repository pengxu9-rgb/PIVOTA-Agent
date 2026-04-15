const { buildPdpPayload } = require('../src/pdpBuilder');

describe('pdpBuilder structured modules for external-seed style products', () => {
  test('emits variant selector and structured detail modules from canonical product data', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_123',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Barrier Cream',
        description: 'A restorative cream for dry skin.',
        canonical_url: 'https://merchant.example/products/barrier-cream',
        image_url: 'https://example.com/hero.png',
        product_options: [
          { name: 'Color' },
          { name: 'Size' },
        ],
        variants: [
          {
            id: 'sku_red_s',
            title: 'Red / Small',
            image_url: 'https://example.com/red-small.png',
            price: { amount: 24, currency: 'USD' },
            variant_attributes: {
              sku: 'SKU-RED-S',
              option1: 'Red',
              option2: 'Small',
              selected_options: [
                { name: 'Color', value: 'Red' },
                { name: 'Size', value: 'Small' },
              ],
            },
          },
          {
            id: 'sku_blue_m',
            title: 'Blue / Medium',
            image_url: 'https://example.com/blue-medium.png',
            price: { amount: 26, currency: 'USD' },
            variant_attributes: {
              sku: 'SKU-BLUE-M',
              option1: 'Blue',
              option2: 'Medium',
              selected_options: [
                { name: 'Color', value: 'Blue' },
                { name: 'Size', value: 'Medium' },
              ],
            },
          },
        ],
        details_sections: [
          {
            title: 'What else you should know',
            content: 'Supports the skin barrier in 7 days.',
          },
        ],
        active_ingredients: [
          {
            title: 'Ceramide NP',
            description: 'Helps support the skin barrier.',
          },
        ],
        ingredients_inci: {
          items: ['Water', 'Glycerin', 'Ceramide NP'],
        },
        how_to_use: {
          title: 'How to use',
          steps: ['Apply after cleansing.', 'Use SPF in the morning.'],
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const variantSelector = payload.modules.find((module) => module.type === 'variant_selector');
    const productFacts = payload.modules.find((module) => module.type === 'product_facts');
    const activeIngredients = payload.modules.find((module) => module.type === 'active_ingredients');
    const ingredientsInci = payload.modules.find((module) => module.type === 'ingredients_inci');
    const howToUse = payload.modules.find((module) => module.type === 'how_to_use');

    expect(variantSelector).toBeTruthy();
    expect(variantSelector.data.selected_variant_id).toBe('sku_red_s');
    expect(payload.product.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variant_id: 'sku_red_s',
          sku_id: 'SKU-RED-S',
          options: expect.arrayContaining([
            expect.objectContaining({ name: 'Color', value: 'Red' }),
            expect.objectContaining({ name: 'Size', value: 'Small' }),
          ]),
        }),
        expect.objectContaining({
          variant_id: 'sku_blue_m',
          options: expect.arrayContaining([
            expect.objectContaining({ name: 'Color', value: 'Blue' }),
            expect.objectContaining({ name: 'Size', value: 'Medium' }),
          ]),
        }),
      ]),
    );

    expect(productFacts?.data?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'What else you should know',
          content: 'Supports the skin barrier in 7 days.',
        }),
      ]),
    );
    expect(activeIngredients?.data?.items).toEqual(
      expect.arrayContaining(['Helps support the skin barrier.']),
    );
    expect(ingredientsInci?.data?.items).toEqual(['Water', 'Glycerin', 'Ceramide NP']);
    expect(howToUse?.data?.steps).toEqual(['Apply after cleansing.', 'Use SPF in the morning.']);
    expect(payload.product.source).toBe('external_seed');
    expect(payload.product.external_redirect_url).toBe('https://merchant.example/products/barrier-cream');
    expect(payload.product.canonical_url).toBe('https://merchant.example/products/barrier-cream');
  });

  test('repairs sunscreen actives from INCI when seed actives drift', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_boj_dn350',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Daily Tinted Fluid Sunscreen DN350 SPF 40',
        category: 'Sunscreen',
        description: 'A mineral tinted fluid sunscreen with SPF 40.',
        image_url: 'https://example.com/dn350.png',
        active_ingredients: ['Zinc PCA'],
        ingredients_inci: {
          raw_text:
            'Zinc Oxide (CI 77947), Water, Butyloctyl Salicylate, 1,2-Hexanediol, Tocopherol',
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const activeIngredients = payload.modules.find((module) => module.type === 'active_ingredients');
    const ingredientsInci = payload.modules.find((module) => module.type === 'ingredients_inci');

    expect(activeIngredients?.data?.items).toEqual(['Zinc Oxide']);
    expect(activeIngredients?.data?.items).not.toContain('Zinc PCA');
    expect(ingredientsInci?.data?.items).toContain('1,2-Hexanediol');
    expect(ingredientsInci?.data?.items).not.toContain('1');
    expect(ingredientsInci?.data?.items).not.toContain('2-Hexanediol');
  });

  test('emits cross-url product line options in variant selector data', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_boj_dn350',
        merchant_id: 'external_seed',
        title: 'Daily Tinted Fluid Sunscreen DN350',
        brand: 'Beauty of Joseon',
        description: 'Tinted daily sunscreen.',
        image_url: 'https://example.com/dn350.png',
        product_line_option_name: 'Shade',
        product_line_options: [
          {
            option_id: 'external_seed:ext_boj_dn310',
            option_name: 'Shade',
            axis: 'shade',
            value: 'dn310',
            label: 'DN310',
            product_id: 'ext_boj_dn310',
            merchant_id: 'external_seed',
            swatch_color: '#d9c4ad',
            selected: false,
          },
          {
            option_id: 'external_seed:ext_boj_dn350',
            option_name: 'Shade',
            axis: 'shade',
            value: 'dn350',
            label: 'DN350',
            product_id: 'ext_boj_dn350',
            merchant_id: 'external_seed',
            swatch_image_url: 'https://example.com/dn350-swatch.png',
            selected: true,
          },
        ],
        variants: [
          {
            id: '52402575475060',
            title: 'Default Title',
            price: { amount: 18, currency: 'USD' },
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const variantSelector = payload.modules.find((module) => module.type === 'variant_selector');
    expect(variantSelector).toBeTruthy();
    expect(variantSelector.data.product_line_option_name).toBe('Shade');
    expect(variantSelector.data.product_line_options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'DN310', product_id: 'ext_boj_dn310', selected: false }),
        expect.objectContaining({ label: 'DN350', product_id: 'ext_boj_dn350', selected: true }),
      ]),
    );
    expect(variantSelector.data.product_line_options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'DN310',
          swatch_color: '#d9c4ad',
          swatch: { hex: '#d9c4ad' },
        }),
        expect.objectContaining({
          label: 'DN350',
          swatch_image_url: 'https://example.com/dn350-swatch.png',
          label_image_url: 'https://example.com/dn350-swatch.png',
        }),
      ]),
    );
    expect(payload.product.product_line_options).toEqual(variantSelector.data.product_line_options);
  });

  test('preserves structured ingredient items without re-splitting numeric INCI commas', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_ingredient_atomic',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Rice Milk Toner',
        description: 'Hydrating toner.',
        canonical_url: 'https://merchant.example/products/rice-milk-toner',
        image_url: 'https://example.com/rice-milk-toner.png',
        ingredients_inci: {
          items: ['AQUA', '1,2-HEXANEDIOL', 'GLYCERIN'],
          source_origin: 'pdp_section',
          source_quality_status: 'authoritative',
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const ingredientsInci = payload.modules.find((module) => module.type === 'ingredients_inci');

    expect(ingredientsInci?.data?.items).toEqual(['AQUA', '1,2-HEXANEDIOL', 'GLYCERIN']);
  });

  test('preserves raw ingredient numeric INCI commas for external seeds', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_ingredient_raw',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Calming Barrier Serum',
        description: 'Hydrating serum.',
        canonical_url: 'https://merchant.example/products/calming-barrier-serum',
        image_url: 'https://example.com/calming-barrier-serum.png',
        pdp_ingredients_raw:
          'Water, Camellia Sinensis Leaf Water, Methylpropanediol, 1,2-Hexanediol, Glycerin',
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const ingredientsInci = payload.modules.find((module) => module.type === 'ingredients_inci');

    expect(ingredientsInci?.data?.items).toEqual([
      'Water',
      'Camellia Sinensis Leaf Water',
      'Methylpropanediol',
      '1,2-Hexanediol',
      'Glycerin',
    ]);
    expect(ingredientsInci?.data?.items).not.toEqual(expect.arrayContaining(['1', '2-Hexanediol']));
  });

  test('classifies merch as generic and suppresses beauty ingredient modules', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_rare_tote',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Puffy Traveler Tote',
        brand: 'Rare Beauty',
        category: 'Tote Bag',
        image_url: 'https://example.com/tote.png',
        price: { amount: 28, currency: 'USD' },
        active_ingredients: ['Cotton'],
        ingredients_inci: { items: ['Polyester'] },
        details_sections: [
          { heading: 'Materials', content: 'Quilted nylon exterior with recycled polyester lining.' },
          { heading: 'Dimensions', content: 'Fits daily essentials and a small makeup pouch.' },
          { heading: 'Care Instructions', content: 'Spot clean with a damp cloth.' },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(payload.pdp_schema_profile).toBe('generic_merch');
    expect(payload.product.pdp_schema_profile).toBe('generic_merch');
    expect(payload.modules.find((module) => module.type === 'active_ingredients')).toBeFalsy();
    expect(payload.modules.find((module) => module.type === 'ingredients_inci')).toBeFalsy();
    expect(payload.modules.find((module) => module.type === 'materials')?.data?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'Materials',
          content: 'Quilted nylon exterior with recycled polyester lining.',
        }),
      ]),
    );
    expect(payload.modules.find((module) => module.type === 'product_specs')?.data?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'Dimensions',
          content: 'Fits daily essentials and a small makeup pouch.',
        }),
      ]),
    );
    expect(payload.modules.find((module) => module.type === 'care_instructions')?.data?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'Care Instructions',
          content: 'Spot clean with a damp cloth.',
        }),
      ]),
    );
  });

  test('keeps formula beauty ingredient modules under beauty formula profile', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_formula',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Glow Replenishing Rice Milk Toner',
        category: 'Toner',
        image_url: 'https://example.com/rice-milk.png',
        price: { amount: 18, currency: 'USD' },
        ingredients_inci: { items: ['Water', 'Glycerin', 'Panthenol'] },
        active_ingredients: ['Glycerin'],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(payload.pdp_schema_profile).toBe('beauty_formula');
    expect(payload.modules.find((module) => module.type === 'ingredients_inci')?.data?.items).toEqual([
      'Water',
      'Glycerin',
      'Panthenol',
    ]);
    expect(payload.modules.find((module) => module.type === 'active_ingredients')?.data?.items).toEqual([
      'Glycerin',
    ]);
    expect(payload.modules.find((module) => module.type === 'materials')).toBeFalsy();
  });

  test('classifies beauty tools separately and emits usage safety without INCI', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_tool',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Reusable Makeup Sponge',
        category: 'Beauty Tool',
        image_url: 'https://example.com/sponge.png',
        price: { amount: 12, currency: 'USD' },
        ingredients_inci: { items: ['Polyurethane'] },
        details_sections: [
          { heading: 'Materials', content: 'Latex-free sponge material.' },
          { heading: 'Usage', content: 'Dampen before applying liquid foundation.' },
          { heading: 'Cleaning', content: 'Wash after each use and air dry.' },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(payload.pdp_schema_profile).toBe('beauty_tool');
    expect(payload.modules.find((module) => module.type === 'ingredients_inci')).toBeFalsy();
    expect(payload.modules.find((module) => module.type === 'usage_safety')?.data?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'How to Use',
          content: 'Dampen before applying liquid foundation.',
        }),
        expect.objectContaining({
          heading: 'Cleaning',
          content: 'Wash after each use and air dry.',
        }),
      ]),
    );
  });
});
