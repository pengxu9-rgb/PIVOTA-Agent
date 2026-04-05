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

  test('rewrites known Tom Ford Shopify assets onto sdcdn mirrors', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_tf_1',
        merchant_id: 'external_seed',
        title: 'Tom Ford Beauty Product',
        image_url:
          'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QS01_2000x2000_1.jpg?v=1774376799',
        variants: [
          {
            id: 'sku_tf_1',
            sku: 'T1QS01',
            image_url:
              'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QS01_2000x2000_1.jpg?v=1774376799',
            price: { amount: 96, currency: 'USD' },
          },
        ],
      },
      relatedProducts: [
        {
          id: 'rec_tf_1',
          merchant_id: 'external_seed',
          title: 'TF Rec',
          image_url:
            'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QT01_3000x3000_0.png?v=1774376799',
          price: '90.00',
          currency: 'USD',
        },
      ],
      entryPoint: 'agent',
    });

    expect(payload.product.image_url).toBe(
      'https://sdcdn.io/tf/tf_sku_T1QS01_2000x2000_1.jpg?height=1400px&width=1400px',
    );
    expect(payload.product.variants[0].image_url).toBe(
      'https://sdcdn.io/tf/tf_sku_T1QS01_2000x2000_1.jpg?height=1400px&width=1400px',
    );
    expect(payload.modules.find((module) => module.type === 'recommendations')?.data?.items[0]?.image_url).toBe(
      'https://sdcdn.io/tf/tf_sku_T1QT01_3000x3000_0.png?height=1400px&width=1400px',
    );
  });

  test('preserves similar metadata on the PDP recommendations module', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_meta_1',
        merchant_id: 'external_seed',
        title: 'Focused Cleanser',
        image_url: 'https://example.com/cleanser.png',
        price: { amount: 44, currency: 'USD' },
      },
      relatedProducts: {
        items: [
          {
            id: 'rec_meta_1',
            merchant_id: 'external_seed',
            title: 'Adjacent Serum',
            image_url: 'https://example.com/serum.png',
            price: '42.00',
            currency: 'USD',
          },
        ],
        metadata: {
          low_confidence: true,
          low_confidence_reason_codes: ['UNDERFILL_FOR_QUALITY'],
          retrieval_mix: { internal: 0, external: 1 },
          selection_mix: {
            same_brand_same_category: 0,
            same_brand_other_category: 1,
            other_brand_same_category: 0,
            other_brand_same_vertical: 0,
            semantic_peer: 0,
          },
        },
      },
      entryPoint: 'agent',
    });

    expect(payload.modules.find((module) => module.type === 'recommendations')?.data?.metadata).toEqual(
      expect.objectContaining({
        low_confidence: true,
        low_confidence_reason_codes: ['UNDERFILL_FOR_QUALITY'],
        retrieval_mix: { internal: 0, external: 1 },
      }),
    );
  });

  test('normalizes encoded whitespace in sdcdn Tom Ford asset names', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_tf_2',
        merchant_id: 'external_seed',
        title: 'Tom Ford Beauty Product',
        image_url:
          'https://sdcdn.io/tf/tf_sku_T2SS02%20_3000x3000_1.png?width=650px&height=750px',
      },
      relatedProducts: [
        {
          id: 'rec_tf_2',
          merchant_id: 'external_seed',
          title: 'TF Rec 2',
          image_url:
            'https://sdcdn.io/tf/tf_sku_T2SS02%20_3000x3000_0.png?width=650px&height=750px',
          price: '90.00',
          currency: 'USD',
        },
      ],
      entryPoint: 'agent',
    });

    expect(payload.product.image_url).toBe(
      'https://sdcdn.io/tf/tf_sku_T2SS02_3000x3000_1.png?width=650px&height=750px',
    );
    expect(payload.modules.find((module) => module.type === 'recommendations')?.data?.items[0]?.image_url).toBe(
      'https://sdcdn.io/tf/tf_sku_T2SS02_3000x3000_1.png?width=650px&height=750px',
    );
  });

  test('aliases known missing Tom Ford sdcdn assets onto existing siblings', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_tf_3',
        merchant_id: 'external_seed',
        title: 'Tom Ford Beauty Product',
        image_url:
          'https://sdcdn.io/tf/tf_sku_T2SS02%20_3000x3000_0.png?width=650px&height=750px',
      },
      entryPoint: 'agent',
    });

    expect(payload.product.image_url).toBe(
      'https://sdcdn.io/tf/tf_sku_T2SS02_3000x3000_1.png?width=650px&height=750px',
    );
  });

  test('cleans polluted Tom Ford external-seed sections before emitting canonical PDP modules', () => {
    const pollutedIngredientRaw =
      'Key Ingredients Sodium PCA, Glycerin, Hyaluronic Acid, and Algae Extract help create a soothing lather. Tom Ford Research’s caffeine-containing ingredients: - White Porcelain Cacao: A rare variety of cacao - Caffeine: At heightened concentrations utilized by Tom Ford Research - Gyokuro: A highly prized Japanese tea Ingredients: Water Aqua Eau, Glycerin, Myristic Acid, Behenic Acid, Sodium Methyl Cocoyl Taurate, Palmitic Acid, Potassium Hydroxide, Lauric Acid, Stearic Acid, Tocopheryl Acetate, Sodium Hyaluronate, Cucumis Sativus (cucumber) Fruit Extract, Pyrus Malus (apple) Fruit Extract, Scutellaria Baicalensis Root Extract, Camellia Sinensis Leaf Extract, Algae Extract, Sorbitol, Caffeine, Sodium Pca, Theobroma Cacao (cocoa) Seed Extract, Magnesium Nitrate, Sodium Sulfite, Sucrose, Sodium Metabisulfite, Peg-3 Distearate, Butylene Glycol, Fragrance (parfum), Limonene, Linalool, Bht, Tetrasodium Edta, Disodium Edta, Phenoxyethanol, Methylchloroisothiazolinone, Methylisothiazolinone, Mica, Titanium Dioxide (ci 77891), Iron Oxides (ci 77491) Please be aware that ingredient lists & safety information may change or vary from time to time. Please refer to the ingredient list & safety information on the product package you receive for the most up-to-date information.';
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_tf_live_1',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'TOM FORD RESEARCH Cleansing Concentrate',
        brand: 'Tom Ford Beauty',
        description:
          'Key Notes Skin Type Skin Concern Finish Coverage This cleanser transforms from a tiny pearl to a luscious foam, rinsing clean, and leaving skin feeling refreshed and energized. Infused with hyaluronic acid, the formula is perfect for all skin types, including sensitive. Benefits Set Includes Shades Included What Else You Need To Know Free From',
        image_url:
          'https://sdcdn.io/tf/tf_sku_T93Y01_2000x2000_0.png?height=1400px&width=1400px',
        image_urls: [
          'https://sdcdn.io/tf/tf_sku_T93Y01_2000x2000_0.png?height=1400px&width=1400px',
          'https://www.tomfordbeauty.com/cdn/shop/files/tf_sku_T93Y01_2000x2000_0.png?width=2000',
          'http://www.tomfordbeauty.com/cdn/shop/files/tf_sku_T93Y01_2000x2000_0.png',
          'https://www.tomfordbeauty.com/cdn/shop/files/Menu.svg?width=24',
          'https://www.tomfordbeauty.com/cdn/shop/files/icon-cart.svg?width=24',
          'https://sdcdn.io/tf/tf_sku_TAGL01_2000x2000_0.png?width=650px&height=750px',
          'https://sdcdn.io/tf/tf_sku_T6CK01_2000x2000_0.png?width=650px&height=750px',
        ],
        price: { amount: 100, currency: 'USD' },
        variants: [
          {
            id: '52015779545301',
            sku: 'T93Y01',
            title: '125.0 ml',
            image_url:
              'https://sdcdn.io/tf/tf_sku_T93Y01_2000x2000_0.png?height=1400px&width=1400px',
            image_urls: [
              'https://sdcdn.io/tf/tf_sku_T93Y01_2000x2000_0.png?height=1400px&width=1400px',
              'https://www.tomfordbeauty.com/cdn/shop/files/tf_sku_T93Y01_2000x2000_0.png?width=2000',
              'http://www.tomfordbeauty.com/cdn/shop/files/tf_sku_T93Y01_2000x2000_0.png',
            ],
            price: { amount: 100, currency: 'USD' },
          },
        ],
        active_ingredients: {
          items: ['Glycerin', 'Hyaluronic acid'],
          source_origin: 'retail_pdp',
          source_quality_status: 'captured',
        },
        ingredients_inci: {
          raw_text: pollutedIngredientRaw,
          items: [
            'Sodium PCA',
            'Glycerin',
            'Hyaluronic Acid',
            'and Algae Extract help create a soothing lather. Tom Ford Research’s caffeine-containing ingredients:',
            '- White Porcelain Cacao: A rare variety of cacao',
            '- Caffeine: At heightened concentrations utilized by Tom Ford Research',
            '- Gyokuro: A highly prized Japanese tea',
            'Ingredients: Water Aqua Eau',
            'Myristic Acid',
          ],
          source_origin: 'retail_pdp',
          source_quality_status: 'captured',
        },
        raw_ingredient_text_clean: pollutedIngredientRaw,
        pdp_how_to_use_raw:
          '- Apply a pearl-sized amount to the fingertips - Add lukewarm water to generate a rich foam - Using fingers, massage lather onto the skin in a circular motion - Rinse clean with warm water',
        pdp_details_sections: [
          {
            heading: 'PRODUCT DETAILS',
            body:
              'Key Notes Skin Type Skin Concern Finish Coverage This cleanser transforms from a tiny pearl to a luscious foam, rinsing clean, and leaving skin feeling refreshed and energized. Infused with hyaluronic acid, the formula is perfect for all skin types, including sensitive. Benefits Set Includes Shades Included What Else You Need To Know Free From',
          },
        ],
        category: 'Serum',
      },
      entryPoint: 'agent',
    });

    const mediaUrls = payload.modules
      .find((module) => module.type === 'media_gallery')
      ?.data?.items?.map((item) => item.url);
    const ingredientsModule = payload.modules.find((module) => module.type === 'ingredients_inci');

    expect(payload.product.description).toBe(
      'This cleanser transforms from a tiny pearl to a luscious foam, rinsing clean, and leaving skin feeling refreshed and energized. Infused with hyaluronic acid, the formula is perfect for all skin types, including sensitive.',
    );
    expect(mediaUrls).toEqual([
      'https://sdcdn.io/tf/tf_sku_T93Y01_2000x2000_0.png?height=1400px&width=1400px',
    ]);
    expect(payload.modules.find((module) => module.type === 'active_ingredients')).toBeFalsy();
    expect(ingredientsModule?.data?.raw_text).toBe(
      'Water Aqua Eau, Glycerin, Myristic Acid, Behenic Acid, Sodium Methyl Cocoyl Taurate, Palmitic Acid, Potassium Hydroxide, Lauric Acid, Stearic Acid, Tocopheryl Acetate, Sodium Hyaluronate, Cucumis Sativus (cucumber) Fruit Extract, Pyrus Malus (apple) Fruit Extract, Scutellaria Baicalensis Root Extract, Camellia Sinensis Leaf Extract, Algae Extract, Sorbitol, Caffeine, Sodium Pca, Theobroma Cacao (cocoa) Seed Extract, Magnesium Nitrate, Sodium Sulfite, Sucrose, Sodium Metabisulfite, Peg-3 Distearate, Butylene Glycol, Fragrance (parfum), Limonene, Linalool, Bht, Tetrasodium Edta, Disodium Edta, Phenoxyethanol, Methylchloroisothiazolinone, Methylisothiazolinone, Mica, Titanium Dioxide (ci 77891), Iron Oxides (ci 77491)',
    );
    expect(ingredientsModule?.data?.items).toContain('Water Aqua Eau');
    expect(ingredientsModule?.data?.items).not.toContain(
      'and Algae Extract help create a soothing lather. Tom Ford Research’s caffeine-containing ingredients:',
    );
    expect(payload.modules.find((module) => module.type === 'product_details')).toBeFalsy();
  });
});
