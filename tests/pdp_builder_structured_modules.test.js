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
      'https://cdn.shopify.com/s/files/1/2139/2967/files/Tinted_Blush_1200_f93c0d07-3570-4717-a2ec-d2af4ab28d1b.png',
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
      'https://cdn.shopify.com/s/files/1/2139/2967/files/Related_Blush_1200_4ee4c5e8-a218-4e0a-8af8-2db3c98f0c79.png',
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
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QS01_2000x2000_1.jpg',
    );
    expect(payload.product.variants[0].image_url).toBe(
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QS01_2000x2000_1.jpg',
    );
    expect(payload.modules.find((module) => module.type === 'recommendations')?.data?.items[0]?.image_url).toBe(
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QT01_3000x3000_0.png',
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

  test('uses description overview without duplicating external seed facts', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_hair_bundle',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Deep Moisture Repair The Maintenance Crew Full-Size Bundle',
        description:
          'Unlock endless styles with The Maintenance Crew. Essentials repair and nourish hair, now with our deep conditioner for extra hydration.',
        product_type: 'external',
        category: 'external',
        price: 121,
        currency: 'USD',
        image_url: 'https://example.com/fenty-hair.jpg',
        variants: [
          {
            variant_id: 'v_1',
            title: 'Default Title',
            price: { amount: 121, currency: 'USD' },
            image_url: 'https://example.com/fenty-hair.jpg',
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(payload.modules.find((module) => module.type === 'product_facts')).toBeFalsy();
    expect(payload.modules.find((module) => module.type === 'product_details')?.data?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'Overview',
          content:
            'Unlock endless styles with The Maintenance Crew. Essentials repair and nourish hair, now with our deep conditioner for extra hydration.',
        }),
      ]),
    );
  });

  test('suppresses duplicate description facts when richer structured ingredient modules already exist', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_fenty_bha_treatment',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: "Blemish Defeat'r BHA Spot-Targeting Gel",
        description:
          "Discover Fenty Skin's Salicylic Acid spot-targeting gel fights blemishes, clarifies skin and reduces surface oil. Its unique gel texture dries down quickly and works perfect canvas for makeup.",
        category: 'Treatment',
        price: 25,
        currency: 'USD',
        image_url: 'https://example.com/fenty-bha-gel.jpg',
        variants: [
          {
            variant_id: 'v_1',
            title: 'Default Title',
            price: { amount: 25, currency: 'USD' },
            image_url: 'https://example.com/fenty-bha-gel.jpg',
          },
        ],
        active_ingredients: {
          items: ['Salicylic acid'],
          source_quality_status: 'captured',
        },
        ingredients_inci: {
          raw_text: 'Ingredients: Salicylic Acid, Water, Glycerin',
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(payload.modules.find((module) => module.type === 'active_ingredients')).toBeTruthy();
    expect(payload.modules.find((module) => module.type === 'ingredients_inci')).toBeTruthy();
    expect(payload.modules.find((module) => module.type === 'product_facts')).toBeFalsy();
    expect(payload.modules.find((module) => module.type === 'product_details')).toEqual(
      expect.objectContaining({
        data: {
          sections: expect.arrayContaining([
            expect.objectContaining({
              heading: 'Overview',
              content: expect.stringContaining("Salicylic Acid spot-targeting gel fights blemishes"),
            }),
          ]),
        },
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
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T2SS02_3000x3000_1.png',
    );
    expect(payload.modules.find((module) => module.type === 'recommendations')?.data?.items[0]?.image_url).toBe(
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T2SS02_3000x3000_1.png',
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
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T2SS02_3000x3000_1.png',
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
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png',
    ]);
    expect(payload.modules.find((module) => module.type === 'active_ingredients')).toBeFalsy();
    expect(ingredientsModule?.data?.raw_text).toBe(
      'Water Aqua Eau, Glycerin, Myristic Acid, Behenic Acid, Sodium Methyl Cocoyl Taurate, Palmitic Acid, Potassium Hydroxide, Lauric Acid, Stearic Acid, Tocopheryl Acetate, Sodium Hyaluronate, Cucumis Sativus (cucumber) Fruit Extract, Pyrus Malus (apple) Fruit Extract, Scutellaria Baicalensis Root Extract, Camellia Sinensis Leaf Extract, Algae Extract, Sorbitol, Caffeine, Sodium Pca, Theobroma Cacao (cocoa) Seed Extract, Magnesium Nitrate, Sodium Sulfite, Sucrose, Sodium Metabisulfite, Peg-3 Distearate, Butylene Glycol, Fragrance (parfum), Limonene, Linalool, Bht, Tetrasodium Edta, Disodium Edta, Phenoxyethanol, Methylchloroisothiazolinone, Methylisothiazolinone, Mica, Titanium Dioxide (ci 77891), Iron Oxides (ci 77491)',
    );
    expect(ingredientsModule?.data?.items).toContain('Water Aqua Eau');
    expect(ingredientsModule?.data?.items).not.toContain(
      'and Algae Extract help create a soothing lather. Tom Ford Research’s caffeine-containing ingredients:',
    );
    expect(payload.modules.find((module) => module.type === 'product_details')).toEqual(
      expect.objectContaining({
        data: {
          sections: expect.arrayContaining([
            expect.objectContaining({
              heading: 'Overview',
              content: expect.stringContaining('This cleanser transforms from a tiny pearl to a luscious foam'),
            }),
          ]),
        },
      }),
    );
  });

  test('structures beauty overview facts and collapses repeated pigment families for concealer PDPs', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_tf_concealer_1',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Traceless Soft Matte Concealer',
        brand: 'Tom Ford Beauty',
        description:
          'Key Notes Skin Type Combination, Dry, For All Skin Types, Normal, Oily, Sensitive Skin Concern Finish Matte, Natural/Satin Coverage Buildable, Full The formula merges hydrating skincare ingredients with imperfection-blurring makeup technology. It features hyaluronic acid for instant and 12-hour hydration and vitamin E for antioxidant protection.',
        pdp_description_raw: `
          Key Notes

          Skin Type

          Combination, Dry, For All Skin Types, Normal, Oily, Sensitive

          Skin Concern

          Finish

          Matte, Natural/Satin

          Coverage

          Buildable, Full

          The formula merges hydrating skincare ingredients with imperfection-blurring makeup technology. It features hyaluronic acid for instant and 12-hour hydration and vitamin E for antioxidant protection. Spherical powders ensure silky-smooth, seamless application for comfortable, non-drying wear.

          Benefits

          - Imperfection blurring makeup technology corrects and conceals to diminish the look of imperfections, dark spots, undereye circles and hyperpigmentation

          - Soft-focus powders offer a natural, soft-matte finish

          - Weightless spherical powders provide comfortable, non-drying wear
        `,
        image_url:
          'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0.png?v=1774387551',
        variants: [
          {
            id: '53031544815829',
            sku: 'TC7Y09',
            title: '3C0 Tulle / 3.5 g',
            image_url:
              'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_74c2dfd9-3f5f-4832-af13-85e0ec7891c9.png?v=1774387551',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_74c2dfd9-3f5f-4832-af13-85e0ec7891c9.png?v=1774387551',
              'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_1_dfe99888-59ba-49f2-b8ca-dc58168cbaae.jpg?v=1774387551',
            ],
            price: { amount: 60, currency: 'USD' },
          },
          {
            id: '53031544586453',
            sku: 'TC7Y01',
            title: '0N0 Blanc / 3.5 g',
            image_url:
              'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y01_2000x2000_0_61efefcf-0a72-4b47-9615-c812efa685db.png?v=1774387551',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y01_2000x2000_0_61efefcf-0a72-4b47-9615-c812efa685db.png?v=1774387551',
              'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y01_2000x2000_1.jpg?v=1774387551',
            ],
            price: { amount: 60, currency: 'USD' },
          },
        ],
        pdp_details_sections: [
          {
            heading: 'PRODUCT DETAILS',
            body: `
              Skin Type

              Combination, Dry, For All Skin Types, Normal, Oily, Sensitive

              Finish

              Matte, Natural/Satin

              Coverage

              Buildable, Full

              Benefits

              - Imperfection blurring makeup technology corrects and conceals to diminish the look of imperfections, dark spots, undereye circles and hyperpigmentation

              - Soft-focus powders offer a natural, soft-matte finish

              - Weightless spherical powders provide comfortable, non-drying wear
            `,
          },
        ],
        ingredients_inci: {
          raw_text:
            'Ingredients: Isostearyl Alcohol, Octyldodecyl Myristate, Synthetic Wax, [+/- Mica, Titanium Dioxide (ci 77891), Iron Oxides (ci 77491), Iron Oxides (ci 77492), Iron Oxides (ci 77499)]',
          source_origin: 'retail_pdp',
          source_quality_status: 'captured',
        },
        pdp_how_to_use_raw:
          '- To spot-conceal, apply with Concealer Brush 03 on desired areas, blend in dabbing motion',
        category: 'Concealer',
      },
      entryPoint: 'agent',
    });

    const mediaUrls = payload.modules
      .find((module) => module.type === 'media_gallery')
      ?.data?.items?.map((item) => item.url);
    const factsSections =
      payload.modules.find((module) => module.type === 'product_facts')?.data?.sections || [];
    const ingredientsItems =
      payload.modules.find((module) => module.type === 'ingredients_inci')?.data?.items || [];

    expect(payload.product.description).toBe(
      'The formula merges hydrating skincare ingredients with imperfection-blurring makeup technology. It features hyaluronic acid for instant and 12-hour hydration and vitamin E for antioxidant protection. Spherical powders ensure silky-smooth, seamless application for comfortable, non-drying wear.',
    );
    const detailSections =
      payload.modules.find((module) => module.type === 'product_details')?.data?.sections || [];
    expect(factsSections).toEqual([]);
    expect(detailSections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'Overview',
          content: expect.stringContaining('Skin Type: Combination, Dry, For All Skin Types, Normal, Oily, Sensitive'),
        }),
      ]),
    );
    expect(detailSections[0]?.content).toContain('Finish: Matte, Natural/Satin');
    expect(detailSections[0]?.content).toContain('Coverage: Buildable, Full');
    expect(detailSections[0]?.content).toContain('Benefits');
    expect(detailSections[0]?.content).toContain('Soft-focus powders offer a natural, soft-matte finish');
    expect(ingredientsItems).toEqual(
      expect.arrayContaining([
        'Isostearyl Alcohol',
        'Octyldodecyl Myristate',
        'Synthetic Wax',
        'Mica',
        'Titanium Dioxide (CI 77891)',
        'Iron Oxides (CI 77491 / 77492 / 77499)',
      ]),
    );
    expect(ingredientsItems).not.toContain('Key Ingredients');
    expect(ingredientsItems.filter((item) => /^Iron Oxides\b/i.test(item))).toHaveLength(1);
    expect(mediaUrls).toEqual([
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_74c2dfd9-3f5f-4832-af13-85e0ec7891c9.png',
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_1_dfe99888-59ba-49f2-b8ca-dc58168cbaae.jpg',
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y01_2000x2000_0_61efefcf-0a72-4b47-9615-c812efa685db.png',
    ]);
  });

  test('strips inline beauty template labels out of narrative text and preserves highlight items', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_tf_inline_labels_1',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Soft Matte Complexion Stick',
        brand: 'Tom Ford Beauty',
        category: 'Concealer',
        pdp_description_raw:
          'The formula merges hydrating skincare ingredients with imperfection-blurring makeup technology. Benefits Soft-focus powders offer a natural, soft-matte finish. Free From Parabens, Sulfates',
        ingredients_inci: {
          raw_text: 'Ingredients: Water, Glycerin, Silica',
          source_origin: 'retail_pdp',
          source_quality_status: 'captured',
        },
      },
      entryPoint: 'agent',
    });

    const factsSections =
      payload.modules.find((module) => module.type === 'product_facts')?.data?.sections || [];

    expect(payload.product.description).toBe(
      'The formula merges hydrating skincare ingredients with imperfection-blurring makeup technology.',
    );
    const detailSections =
      payload.modules.find((module) => module.type === 'product_details')?.data?.sections || [];
    expect(factsSections).toEqual([]);
    expect(detailSections[0]?.heading).toBe('Overview');
    expect(detailSections[0]?.content).toContain('Benefits');
    expect(detailSections[0]?.content).toContain(
      'Soft-focus powders offer a natural, soft-matte finish.',
    );
    expect(detailSections[0]?.content).toContain('Free from Parabens, Sulfates');
  });

  test('builds a clean overview for external seeds and filters polluted product facts', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_a2e27f4a7a558c58c2a6a669',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Fenty Beauty Blemish Defeat’r BHA Spot-Targeting Gel',
        brand: 'Fenty Beauty',
        category: 'Treatment',
        pdp_description_raw:
          'THE UNDERCOVER BLEMISH FIGHTER THE BLEMISH FIX SO STEALTH, YOU\'LL NEVER SEE IT UNDER MAKEUP STRAIGHT UP: Shield and combat blemishes without sacrificing your makeup look. This Salicylic Acid-backed, spot-targeting gel fights blemishes, clarifies, reduces surface oil and guards against environmental assailants. Its unique jelly texture dries down quickly, so you can wear it anytime you want, especially under makeup.',
        pdp_details_sections: [
          {
            heading: 'Overview',
            body: 'THE UNDERCOVER BLEMISH FIGHTER THE BLEMISH FIX SO STEALTH, YOU\'LL NEVER SEE IT UNDER MAKEUP STRAIGHT UP: Shield and combat blemishes without sacrificing your makeup look. This Salicylic Acid-backed, spot-targeting gel fights blemishes, clarifies, reduces surface oil and guards against environmental assailants. Its unique jelly texture dries down quickly, so you can wear it anytime you want, especially under makeup. Noncomedogenic (won’t clog pores).',
          },
          {
            heading: 'Details',
            body: 'Details Details THE UNDERCOVER BLEMISH FIGHTER THE BLEMISH FIX SO STEALTH, YOU\'LL NEVER SEE IT UNDER MAKEUP STRAIGHT UP: Shield and combat blemishes without sacrificing your makeup look. This Salicylic Acid-backed, spot-targeting gel fights blemishes, clarifies, reduces surface oil and guards against environmental assailants. Its unique jelly texture dries down quickly, so you can wear it anytime you want, especially under makeup. Learn more Close BHA-GEL GEGEN AKNE. AVOID CONTACT WITH EYES. KEEP OUT OF REACH OF CHILDREN. CUSTOMERSERVICE@FENTYBEAUTY.COM FENTYBEAUTY.COM',
          },
        ],
        ingredients_inci: {
          raw_text:
            'We got you covered fam! Your health and safety are hella important to us. Although the hype is real about our high-quality ingredients, we always recommend consulting your physician about the use of our products during pregnancy or while nursing. Peep the tab on each product&rsquo;s description page and hit up your physician before you glow. &rsquo; tab on each product&rsquo; Ingredients: AQUA/WATER/EAU, PROPANEDIOL, GLYCERIN, SALICYLIC ACID, PANTHENOL, PHENOXYETHANOL.',
          source_origin: 'retail_pdp',
          source_quality_status: 'captured',
        },
      },
      relatedProducts: {
        items: [
          { product_id: 'sim_1', merchant_id: 'external_seed', title: 'Similar 1', price: 18, currency: 'USD' },
        ],
      },
      entryPoint: 'agent',
    });

    const detailsSections =
      payload.modules.find((module) => module.type === 'product_details')?.data?.sections || [];
    const factsSections =
      payload.modules.find((module) => module.type === 'product_facts')?.data?.sections || [];

    expect(payload.product.description).toBe(
      "Shield and combat blemishes without sacrificing your makeup look. This Salicylic Acid-backed, spot-targeting gel fights blemishes, clarifies, reduces surface oil and guards against environmental assailants. Its unique jelly texture dries down quickly, so you can wear it anytime you want, especially under makeup.",
    );
    expect(detailsSections).toEqual([
      expect.objectContaining({
        heading: 'Overview',
        content: expect.stringContaining('Shield and combat blemishes without sacrificing your makeup look.'),
      }),
    ]);
    expect(detailsSections[0]?.content).not.toMatch(
      /AVOID CONTACT WITH EYES|CUSTOMERSERVICE@|Details\b|learn more|BHA-GEL|THE LOWDOWN|The #s don't lie|Fill weight|THE UNDERCOVER|STRAIGHT UP:/i,
    );
    expect(factsSections).toEqual([]);
    const ingredientsItems =
      payload.modules.find((module) => module.type === 'ingredients_inci')?.data?.items || [];
    expect(ingredientsItems).toEqual(
      expect.arrayContaining(['AQUA/WATER/EAU', 'PROPANEDIOL', 'GLYCERIN', 'SALICYLIC ACID', 'PANTHENOL', 'PHENOXYETHANOL.']),
    );
    expect(ingredientsItems.join(' ')).not.toMatch(/we got you covered|health and safety|physician|pregnancy|description page|tab on each product|&rsquo/i);
  });

  test('strips uppercase marketing banner preambles without explicit labels from external seed descriptions', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_a2e27f4a7a558c58c2a6a669',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Fenty Beauty Blemish Defeat’r BHA Spot-Targeting Gel',
        brand: 'Fenty Beauty',
        category: 'Treatment',
        pdp_description_raw:
          "THE UNDERCOVER BLEMISH FIGHTER THE BLEMISH FIX SO STEALTH, YOU'LL NEVER SEE IT UNDER MAKEUP Shield and combat blemishes without sacrificing your makeup look. This Salicylic Acid-backed, spot-targeting gel fights blemishes, clarifies, reduces surface oil and guards against environmental assailants. Its unique jelly texture dries down quickly, so you can wear it anytime you want-especially under makeup.",
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const detailsSections =
      payload.modules.find((module) => module.type === 'product_details')?.data?.sections || [];

    expect(payload.product.description).toBe(
      "Shield and combat blemishes without sacrificing your makeup look. This Salicylic Acid-backed, spot-targeting gel fights blemishes, clarifies, reduces surface oil and guards against environmental assailants. Its unique jelly texture dries down quickly, so you can wear it anytime you want-especially under makeup.",
    );
    expect(detailsSections).toEqual([
      expect.objectContaining({
        heading: 'Overview',
        content:
          "Shield and combat blemishes without sacrificing your makeup look. This Salicylic Acid-backed, spot-targeting gel fights blemishes, clarifies, reduces surface oil and guards against environmental assailants. Its unique jelly texture dries down quickly, so you can wear it anytime you want-especially under makeup.",
      }),
    ]);
    expect(payload.product.description).not.toMatch(/THE UNDERCOVER|BLEMISH FIX SO STEALTH|YOU'LL NEVER SEE IT UNDER MAKEUP/i);
  });

  test('strips synthetic social-summary wrappers from external seed narrative modules', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_a65b2ac9f4206fd7c5edff32',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Vanilla Sex Eau de Parfum',
        brand: 'Tom Ford Beauty',
        category: 'Fragrance',
        pdp_description_raw:
          'OFFICIAL: An enveloping amber scent of vanilla notes, white florals and sandalwood. /// SOCIAL HIGHLIGHTS: Community top pick: 4.8/5 stars on social platforms. Fans love how it feels weightless yet powerful.',
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const detailsSections =
      payload.modules.find((module) => module.type === 'product_details')?.data?.sections || [];
    const factsSections =
      payload.modules.find((module) => module.type === 'product_facts')?.data?.sections || [];

    expect(payload.product.description).toBe(
      'An enveloping amber scent of vanilla notes, white florals and sandalwood.',
    );
    expect(detailsSections).toEqual([
      expect.objectContaining({
        heading: 'Overview',
        content: 'An enveloping amber scent of vanilla notes, white florals and sandalwood.',
      }),
    ]);
    expect(factsSections).toEqual([]);
    expect(JSON.stringify(payload)).not.toMatch(/OFFICIAL:|SOCIAL HIGHLIGHTS/i);
  });

  test('does not split lower-case Finish off copy into a fake finish fact', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_fenty_clf_bundle',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'CLF Bundle',
        brand: 'Fenty Beauty',
        category: 'Moisturizer',
        description:
          "As part of our ongoing partnership with Rihanna's Clara Lionel Foundation, we're launching this limited-edition bundle featuring some Fenty faves. Start with Rich Dip for a spa-worthy soak, then use Butta Drop for nourishing moisture. Finish off any look with Gloss Bomb for a kiss of color + shine. Fill weight: Rich Dip Bubble Bath: 350 mL | Butta Drop Body Cream: 200 mL | Gloss Bomb Universal Lip Luminizer: 9 mL Learn more about CLF and the Rebuild & Reimagine Fund at ClaraLionelFoundation.org",
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const detailsSections =
      payload.modules.find((module) => module.type === 'product_details')?.data?.sections || [];

    expect(payload.product.description).toBe(
      "As part of our ongoing partnership with Rihanna's Clara Lionel Foundation, we're launching this limited-edition bundle featuring some Fenty faves. Start with Rich Dip for a spa-worthy soak, then use Butta Drop for nourishing moisture. Finish off any look with Gloss Bomb for a kiss of color + shine.",
    );
    expect(detailsSections).toEqual([
      expect.objectContaining({
        heading: 'Overview',
        content: payload.product.description,
      }),
    ]);
    expect(detailsSections[0]?.content).not.toMatch(/^Finish:/);
    expect(detailsSections[0]?.content).not.toMatch(/Fill weight|Learn more about CLF/i);
    expect(payload.modules.find((module) => module.type === 'product_facts')).toBeFalsy();
  });

  test('cuts section soup descriptions before how-to and ingredients copy', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_sigma_ambiance',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Ambiance Eyeshadow Palette',
        brand: 'sigma beauty',
        category: 'Eyeshadow',
        pdp_description_raw:
          'DESCRIPTION Get the ultimate golden-hour glow with this landscape of warm matte eyeshadows, shimmer eyeshadows and metallic eyeshadows. Inspired by the sun’s peaceful, ever-changing light, Ambiance sets the mood for any occasion. With neutral-to-bold eye shadows and a beautiful dual-ended makeup brush, this brilliant eyeshadow palette will help you look radiant from sunrise to sunset. HOW TO USE Using the dual-ended beauty brush, apply and blend the eyeshadow shade(s) of your choice onto your eyelids. Net Wt. 0.49oz./14g INGREDIENTS Daze, Daylily, Oasis, Sunspot: Mica, Magnesium Stearate, Silica.',
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const detailsSections =
      payload.modules.find((module) => module.type === 'product_details')?.data?.sections || [];

    expect(payload.product.description).toBe(
      'Get the ultimate golden-hour glow with this landscape of warm matte eyeshadows, shimmer eyeshadows and metallic eyeshadows. Inspired by the sun’s peaceful, ever-changing light, Ambiance sets the mood for any occasion. With neutral-to-bold eye shadows and a beautiful dual-ended makeup brush, this brilliant eyeshadow palette will help you look radiant from sunrise to sunset.',
    );
    expect(detailsSections[0]?.content).toBe(payload.product.description);
    expect(payload.product.description).not.toMatch(/DESCRIPTION|HOW TO USE|INGREDIENTS|Net Wt/i);
    expect(payload.modules.find((module) => module.type === 'product_facts')).toBeFalsy();
  });

  test('falls back to narrative overview when generic DETAILS only contains tag soup', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_naturium_jumbo',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Dew-Glow Moisturizer SPF 50 - Jumbo',
        brand: 'Naturium',
        category: 'Moisturizer',
        pdp_description_raw:
          'Double up & save with this jumbo size of our daily moisturizing sunscreen, formulated with organic/chemical sunscreen filters that apply invisibly on all skin tones to provide broad spectrum SPF 50 PA++++ protection while leaving a dewy, radiant finish.',
        pdp_details_sections: [
          {
            heading: 'BENEFITS',
            body: 'Sunscreen moisturizer with SPF 50 protection\n\nProvides a dewy glow\n\nWorks well under makeup',
          },
          {
            heading: 'DETAILS',
            body: '3.4 FL OZ / 100 ML\nCruelty Free\n\nParaben Free\n\nVegan\n\nGluten Free\n\nFragrance Free\n\nDermatologist Tested',
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const detailsSections =
      payload.modules.find((module) => module.type === 'product_details')?.data?.sections || [];
    const factsSections =
      payload.modules.find((module) => module.type === 'product_facts')?.data?.sections || [];

    expect(payload.product.description).toBe(
      'Double up & save with this jumbo size of our daily moisturizing sunscreen, formulated with organic/chemical sunscreen filters that apply invisibly on all skin tones to provide broad spectrum SPF 50 PA++++ protection while leaving a dewy, radiant finish.',
    );
    expect(detailsSections).toEqual([
      expect.objectContaining({
        heading: 'Overview',
        content: payload.product.description,
      }),
    ]);
    expect(detailsSections[0]?.content).not.toMatch(
      /3\.4 FL OZ|Cruelty Free|Paraben Free|Vegan|Gluten Free|Fragrance Free|Dermatologist Tested/i,
    );
    expect(factsSections).toEqual([
      expect.objectContaining({
        heading: 'BENEFITS',
        content: expect.stringContaining('Sunscreen moisturizer with SPF 50 protection'),
      }),
    ]);
  });
});
