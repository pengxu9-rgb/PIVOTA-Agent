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
    const productOverview = payload.modules.find((module) => module.type === 'product_overview');
    const supplementalDetails = payload.modules.find((module) => module.type === 'supplemental_details');
    const productDetails = payload.modules.find((module) => module.type === 'product_details');
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
    expect(productOverview?.data?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'Description',
          content: 'A restorative cream for dry skin.',
        }),
      ]),
    );
    expect(supplementalDetails).toBeFalsy();
    expect(productDetails).toBeFalsy();
    expect(payload.modules.some((module) =>
      module.type === 'product_overview' &&
      module.data?.sections?.some((section) => section.heading === 'Category'),
    )).toBe(false);
    expect(activeIngredients?.data?.items).toEqual(
      expect.arrayContaining(['Helps support the skin barrier.']),
    );
    expect(ingredientsInci?.data?.items).toEqual(['Water', 'Glycerin', 'Ceramide NP']);
    expect(howToUse?.data?.steps).toEqual(['Apply after cleansing.', 'Use SPF in the morning.']);
    expect(payload.product.source).toBe('external_seed');
    expect(payload.product.external_redirect_url).toBe('https://merchant.example/products/barrier-cream');
    expect(payload.product.canonical_url).toBe('https://merchant.example/products/barrier-cream');
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
});
