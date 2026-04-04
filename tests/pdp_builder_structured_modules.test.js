const { buildPdpPayload } = require('../src/pdpBuilder');

describe('pdpBuilder structured modules for external-seed style products', () => {
  test('emits variant selector and structured detail modules from canonical product data', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_123',
        merchant_id: 'external_seed',
        title: 'Barrier Cream',
        description: 'A restorative cream for dry skin.',
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
        active_ingredients: {
          items: ['Ceramide NP'],
          source_quality_status: 'reviewed',
        },
        ingredients_inci: {
          items: ['Water', 'Glycerin', 'Ceramide NP'],
          raw_text: 'Ingredients: Water, Glycerin, Ceramide NP',
        },
        how_to_use: {
          title: 'How to use',
          steps: ['- Step 1: Apply after cleansing. - Step 2: Use SPF in the morning.'],
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
      expect.arrayContaining(['Ceramide NP']),
    );
    expect(ingredientsInci?.data?.items).toEqual(['Water', 'Glycerin', 'Ceramide NP']);
    expect(howToUse?.data?.steps).toEqual(['Apply after cleansing.', 'Use SPF in the morning.']);
  });

  test('suppresses low-confidence single active ingredient when ingredients are much richer', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_456',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Tinted Blush',
        category: 'Makeup',
        image_url:
          'https://cdn.shopify.com/s/files/1/2139/2967/files/Tinted_Blush_1200_f93c0d07-3570-4717-a2ec-d2af4ab28d1b.png?v=1750422282',
        active_ingredients: ['Mica'],
        ingredients_inci: {
          raw_text: 'Ingredients: Mica, Dimethicone, Silica, Iron Oxides, Titanium Dioxide',
        },
        how_to_use: {
          raw_text: '- Swipe onto cheeks. - Blend with fingertips. - Repeat as needed.',
        },
      },
      relatedProducts: [
        {
          id: 'rec_1',
          merchant_id: 'external_seed',
          title: 'Related Blush',
          image_url:
            'https://cdn.shopify.com/s/files/1/2139/2967/files/Related_Blush_1200_4ee4c5e8-a218-4e0a-8af8-2db3c98f0c79.png?v=1750422282',
          price: '24.00',
          currency: 'USD',
        },
      ],
      entryPoint: 'agent',
    });

    expect(payload.product.image_url).toBe(
      'https://cdn.shopify.com/s/files/1/2139/2967/files/Tinted_Blush_1200.png',
    );
    expect(payload.modules.find((module) => module.type === 'active_ingredients')).toBeFalsy();
    expect(
      payload.modules.find((module) => module.type === 'ingredients_inci')?.data?.items,
    ).toEqual([
      'Mica',
      'Dimethicone',
      'Silica',
      'Iron Oxides',
      'Titanium Dioxide',
    ]);
    expect(payload.modules.find((module) => module.type === 'how_to_use')?.data?.steps).toEqual([
      'Swipe onto cheeks.',
      'Blend with fingertips.',
      'Repeat as needed.',
    ]);
    expect(payload.modules.find((module) => module.type === 'recommendations')?.data?.items[0]?.image_url).toBe(
      'https://cdn.shopify.com/s/files/1/2139/2967/files/Related_Blush_1200.png',
    );
  });
});
