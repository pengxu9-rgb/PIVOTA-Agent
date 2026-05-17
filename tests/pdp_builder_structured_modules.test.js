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
        pdp_how_to_use_raw: 'Apply after cleansing. Use SPF in the morning.',
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
    expect(variantSelector.data.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variant_id: 'sku_red_s',
          display_label: 'Color: Red / Size: Small',
          options: expect.arrayContaining([
            expect.objectContaining({ name: 'Color', value: 'Red' }),
            expect.objectContaining({ name: 'Size', value: 'Small' }),
          ]),
        }),
        expect.objectContaining({
          variant_id: 'sku_blue_m',
          display_label: 'Color: Blue / Size: Medium',
        }),
      ]),
    );
    expect(variantSelector.data.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Color',
          values: expect.arrayContaining([
            expect.objectContaining({ value: 'Red', selected: true }),
            expect.objectContaining({ value: 'Blue', selected: false }),
          ]),
        }),
        expect.objectContaining({
          name: 'Size',
          values: expect.arrayContaining([
            expect.objectContaining({ value: 'Small', selected: true }),
            expect.objectContaining({ value: 'Medium', selected: false }),
          ]),
        }),
      ]),
    );
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
    expect(activeIngredients?.data?.items).toEqual(expect.arrayContaining(['Ceramide NP']));
    expect(ingredientsInci?.data?.items).toEqual(['Water', 'Glycerin', 'Ceramide NP']);
    expect(howToUse?.data?.steps).toEqual(['Apply after cleansing.', 'Use SPF in the morning.']);
    expect(payload.product.source).toBe('external_seed');
    expect(payload.product.external_redirect_url).toBe('https://merchant.example/products/barrier-cream');
    expect(payload.product.canonical_url).toBe('https://merchant.example/products/barrier-cream');
  });

  test('surfaces reviewed bundle component refs in product facts without merging component ingredients', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_skin1004_gift_set',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Every Love, Every Moment Gift Set',
        description: 'A limited-edition 3-step pore care set.',
        image_url: 'https://example.com/gift-set.png',
        product_family: 'set_or_collection',
        bundle_component_refs: [
          {
            merchant_id: 'external_seed',
            product_id: 'ext_skin1004_clay_stick_mask',
            title: 'Poremizing Quick Clay Stick Mask',
            size_label: '27g',
            inheritance_scope: ['how_to_use', 'ingredients_inci'],
            review_state: 'reviewed',
          },
          {
            merchant_id: 'external_seed',
            product_id: 'ext_skin1004_fresh_ampoule',
            title: 'Poremizing Fresh Ampoule',
            size_label: '50ml',
            inheritance_scope: ['how_to_use', 'ingredients_inci'],
            review_state: 'reviewed',
          },
        ],
        key_ingredients: ['Centella Asiatica Extract', 'Kaolin'],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const productFacts = payload.modules.find((module) => module.type === 'product_facts');
    const ingredientsInci = payload.modules.find((module) => module.type === 'ingredients_inci');

    expect(productFacts?.data?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'Set includes',
          content: expect.stringContaining('Poremizing Quick Clay Stick Mask - 27g'),
          component_refs: expect.arrayContaining([
            expect.objectContaining({
              product_id: 'ext_skin1004_clay_stick_mask',
              inheritance_scope: ['how_to_use', 'ingredients_inci'],
            }),
          ]),
        }),
      ]),
    );
    expect(ingredientsInci).toBeFalsy();
  });

  test('emits variant selector for a single displayable size variant', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_single_size',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Heartleaf Calming Cream',
        description: 'Barrier-supporting cream.',
        canonical_url: 'https://merchant.example/products/heartleaf-calming-cream',
        image_url: 'https://example.com/heartleaf-calming-cream.png',
        product_options: [{ name: 'Size' }],
        variants: [
          {
            id: 'sku_50ml',
            title: '50ml',
            price: { amount: 19, currency: 'USD' },
            variant_attributes: {
              option1: '50ml',
              selected_options: [{ name: 'Size', value: '50ml' }],
            },
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const variantSelector = payload.modules.find((module) => module.type === 'variant_selector');

    expect(variantSelector).toBeTruthy();
    expect(variantSelector?.data?.selected_variant_id).toBe('sku_50ml');
    expect(variantSelector?.data?.variants).toEqual([
      expect.objectContaining({
        variant_id: 'sku_50ml',
        display_label: 'Size: 50ml',
        options: [expect.objectContaining({ name: 'Size', value: '50ml' })],
      }),
    ]);
    expect(variantSelector?.data?.options).toEqual([
      expect.objectContaining({
        name: 'Size',
        values: [expect.objectContaining({ value: '50ml', selected: true })],
      }),
    ]);
    expect(payload.product.default_variant_id).toBe('sku_50ml');
    expect(payload.product.variants).toEqual([
      expect.objectContaining({
        variant_id: 'sku_50ml',
        title: '50ml',
        options: [expect.objectContaining({ name: 'Size', value: '50ml' })],
      }),
    ]);
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
    expect(activeIngredients?.data?.source_quality_status).toBe('regulatory_active');
    expect(activeIngredients?.data?.items).not.toContain('Zinc PCA');
    expect(ingredientsInci?.data?.items).toContain('1,2-Hexanediol');
    expect(ingredientsInci?.data?.items).not.toContain('1');
    expect(ingredientsInci?.data?.items).not.toContain('2-Hexanediol');
  });

  test('does not augment official sunscreen active block from incidental INCI colorants', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_ole_spf',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Banana Bright Mineral Sunscreen SPF 30',
        category: 'Sunscreen',
        description: 'A 100% mineral sunscreen with SPF 30.',
        image_url: 'https://example.com/ole-spf.png',
        pdp_active_ingredients_raw:
          'Zinc Oxide 16.3%\nEnhanced Vitamin C (Ascorbic Acid)\nBanana Powder-Inspired Pigments\nNiacinamide\nAloe Leaf Juice',
        active_ingredients: [
          'Zinc Oxide 16.3%',
          'Enhanced Vitamin C (Ascorbic Acid)',
          'Banana Powder-Inspired Pigments',
          'Niacinamide',
          'Aloe Leaf Juice',
        ],
        ingredients_inci: {
          raw_text:
            'Aqua/Water/Eau, Zinc Oxide, Niacinamide, Aloe Barbadensis Leaf Juice, Tetrahexyldecyl Ascorbate, Iron Oxides (Ci 77491, Ci 77492), Titanium Dioxide (Ci 77891).',
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const activeIngredients = payload.modules.find((module) => module.type === 'active_ingredients');

    expect(activeIngredients?.data?.items).toEqual(['Zinc Oxide']);
    expect(activeIngredients?.data?.items).not.toContain('Titanium Dioxide');
  });

  test('preserves enriched similar card presentation fields in recommendations', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_anchor',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Anchor Product',
        image_url: 'https://example.com/anchor.png',
        price: { amount: 18, currency: 'USD' },
      },
      relatedProducts: [
        {
          product_id: 'ext_related',
          merchant_id: 'external_seed',
          title: 'Related Product',
          description: 'A lightweight toner that supports visible hydration.',
          category: 'Toner',
          card_highlight: 'Supports visible hydration',
          shopping_card: { highlight: 'Supports visible hydration' },
          search_card: { highlight_candidate: 'Supports visible hydration' },
          image_url: 'https://example.com/related.png',
          price: { amount: 16, currency: 'USD' },
        },
      ],
      entryPoint: 'agent',
    });

    const recommendations = payload.modules.find((module) => module.type === 'recommendations');
    expect(recommendations?.data?.items?.[0]).toEqual(
      expect.objectContaining({
        product_id: 'ext_related',
        category: 'Toner',
        description: 'A lightweight toner that supports visible hydration.',
        card_highlight: 'Supports visible hydration',
        shopping_card: { highlight: 'Supports visible hydration' },
        search_card: { highlight_candidate: 'Supports visible hydration' },
      }),
    );
  });

  test('recomputes recommendation highlight status from fallback excerpt when highlight fields are missing', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_anchor_three',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Anchor Product',
        image_url: 'https://example.com/anchor.png',
        price: { amount: 18, currency: 'USD' },
      },
      relatedProducts: [
        {
          product_id: 'ext_related_three',
          merchant_id: 'external_seed',
          title: 'Flawless Pore Prep Primer',
          description:
            'A pore-focused makeup primer meant to smooth the look of texture before complexion products and create a more even, makeup-ready base.',
          category: 'Primer',
          image_url: 'https://example.com/primer.png',
          search_card: {
            title_candidate: 'TIRTIR Global Flawless Pore Prep Primer',
            compact_candidate: 'Primer',
          },
          shopping_card: {
            title: 'TIRTIR Global Flawless Pore Prep Primer',
            subtitle: 'Primer',
          },
          card_highlight_status: 'highlight_missing',
        },
      ],
      entryPoint: 'agent',
    });

    expect(payload.modules.find((module) => module.type === 'recommendations')?.data?.items?.[0]).toEqual(
      expect.objectContaining({
        product_id: 'ext_related_three',
        card_highlight_status: 'ready',
        card_image_status: 'ready',
        card_highlight: expect.any(String),
      }),
    );
  });

  test('promotes shopping-card fallback fields onto recommendation cards for older PDP clients', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_anchor_two',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Anchor Product',
        image_url: 'https://example.com/anchor.png',
        price: { amount: 18, currency: 'USD' },
      },
      relatedProducts: [
        {
          product_id: 'ext_related_two',
          merchant_id: 'external_seed',
          title: 'Related Product',
          image_url: 'https://example.com/related.png',
          price: { amount: 16, currency: 'USD' },
          shopping_card: {
            title: 'Related Product',
            subtitle: 'Spot Patch',
            intro: 'Hydrocolloid patch for overnight blemish care.',
          },
          search_card: {
            compact_candidate: 'Spot Patch',
            intro_candidate: 'Hydrocolloid patch for overnight blemish care.',
          },
        },
      ],
      entryPoint: 'agent',
    });

    expect(payload.modules.find((module) => module.type === 'recommendations')?.data?.items?.[0]).toEqual(
      expect.objectContaining({
        card_subtitle: 'Spot Patch',
        card_highlight: 'Hydrocolloid patch for overnight blemish care.',
        card_intro: 'Hydrocolloid patch for overnight blemish care.',
        description: 'Hydrocolloid patch for overnight blemish care.',
      }),
    );
  });

  test('falls back to product intel what-it-is when related cards lack explicit highlight copy', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_anchor_three',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Anchor Product',
        image_url: 'https://example.com/anchor.png',
        price: { amount: 18, currency: 'USD' },
      },
      relatedProducts: [
        {
          product_id: 'ext_related_three',
          merchant_id: 'external_seed',
          title: 'Bright-C Stickers',
          image_url: 'https://example.com/related.png',
          price: { amount: 16, currency: 'USD' },
          product_intel: {
            product_intel_core: {
              what_it_is: {
                body: 'Designed to target the look of post-breakout marks overnight.',
              },
            },
          },
          shopping_card: {
            title: 'Bright-C Stickers',
            subtitle: 'Spot Patches',
          },
          search_card: {
            compact_candidate: 'Spot Patches',
          },
        },
      ],
      entryPoint: 'agent',
    });

    expect(payload.modules.find((module) => module.type === 'recommendations')?.data?.items?.[0]).toEqual(
      expect.objectContaining({
        card_subtitle: 'Spot Patches',
        card_highlight: 'Designed to target the look of post-breakout marks overnight.',
        card_intro: 'Designed to target the look of post-breakout marks overnight.',
        description: 'Designed to target the look of post-breakout marks overnight.',
      }),
    );
  });

  test('does not let legacy generic how-to fields surface for external seeds', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_legacy_how_to',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Legacy How-To Product',
        image_url: 'https://example.com/legacy-how-to.png',
        price: { amount: 18, currency: 'USD' },
        how_to_use: {
          title: 'How to use',
          steps: ['Legacy fallback step that should stay hidden.'],
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(payload.modules.find((module) => module.type === 'how_to_use')).toBeFalsy();
  });

  test('surfaces force-filled ingredient status as a reviewed note without fake INCI items', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_force_filled_ingredients',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Hydrating Sunscreen Milk SPF 45',
        category: 'Sunscreen',
        image_url: 'https://example.com/spf.png',
        price: { amount: 36, currency: 'USD' },
        ingredient_intel: {
          force_fill_contract: {
            contract_version: 'pivota.pdp.force_fill.v1',
            source_origin: 'pivota_force_fill',
            source_quality_status: 'force_filled_pending_source',
            content_review_state: 'assistant_reviewed',
            display_note:
              'Full INCI has not been captured from an approved source yet. Check the merchant page before purchase if you avoid specific ingredients.',
          },
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const ingredientsInci = payload.modules.find((module) => module.type === 'ingredients_inci');
    expect(ingredientsInci?.data).toEqual(
      expect.objectContaining({
        title: 'Ingredients',
        items: [],
        force_filled: true,
        source_quality_status: 'force_filled_pending_source',
        raw_text: expect.stringContaining('Full INCI has not been captured'),
      }),
    );
    expect(ingredientsInci).toBeTruthy();
  });

  test('keeps active-compatibility FAQ out of actives/how-to and exposes it as a question', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_krave_gbr',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Great Barrier Relief',
        category: 'Serum',
        description: 'A barrier-support serum for irritated skin.',
        image_url: 'https://example.com/gbr.png',
        price: { amount: 28, currency: 'USD' },
        pdp_active_ingredients_raw:
          'Yes, Great Barrier Relief works well with active ingredients or treatments such as AHAs, BHAs, retinols/retinoids, Vitamin C, etc.',
        active_ingredients: ['Niacinamide'],
        pdp_how_to_use_raw:
          'Oat So Simple Water Cream Pair with a water-based moisturizer. Shop Now Great Body Relief Pair with this barrier restoring body lotion. Shop Now',
        pdp_ingredients_raw:
          'Tamanu Oil: Soothes irritation. Full Ingredients: Water, Propanediol, Niacinamide, Ceramide NP. PETA-certified vegan and cruelty-free. NOTE: Patch test first.',
        details_sections: [
          {
            heading: 'How to Pair',
            content:
              'Oat So Simple Water Cream Pair with a water-based moisturizer. Shop Now Great Body Relief Pair with this barrier restoring body lotion. Shop Now',
          },
          {
            heading: 'Can I use this with an active ingredient?',
            content:
              'Yes, Great Barrier Relief works well with active ingredients or treatments such as AHAs, BHAs, retinols/retinoids, Vitamin C, etc.',
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
      includeEmptyReviews: true,
    });

    const activeIngredients = payload.modules.find((module) => module.type === 'active_ingredients');
    const ingredientsInci = payload.modules.find((module) => module.type === 'ingredients_inci');
    const howToUse = payload.modules.find((module) => module.type === 'how_to_use');
    const overview = payload.modules.find((module) => module.type === 'product_overview');
    const supplemental = payload.modules.find((module) => module.type === 'supplemental_details');
    const reviews = payload.modules.find((module) => module.type === 'reviews_preview');

    expect(activeIngredients?.data?.items).toEqual(['Niacinamide']);
    expect(activeIngredients?.data?.items).not.toEqual(expect.arrayContaining(['AHAs', 'BHAs']));
    expect(ingredientsInci?.data?.items).toEqual(['Water', 'Propanediol', 'Niacinamide', 'Ceramide NP']);
    expect(howToUse).toBeFalsy();
    expect(overview?.data?.sections?.[0]?.content).toBe('A barrier-support serum for irritated skin.');
    expect(supplemental?.data?.sections || []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'How to Pair',
          content: expect.stringContaining('Oat So Simple Water Cream Pair with a water-based moisturizer.'),
        }),
      ]),
    );
    expect(supplemental?.data?.sections?.find((section) => section.heading === 'How to Pair')?.content).not.toMatch(
      /shop now/i,
    );
    expect(supplemental?.data?.sections || []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ heading: 'Can I use this with an active ingredient?' })]),
    );
    expect(reviews?.data?.questions).toEqual([
      expect.objectContaining({
        question: 'Can I use this with an active ingredient?',
        source: 'merchant_faq',
      }),
    ]);
  });

  test('keeps numeric duration ranges together in how-to steps', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_duration_range',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Calming Pad',
        category: 'Pad',
        description: 'A calming pad.',
        image_url: 'https://example.com/pad.png',
        pdp_how_to_use_raw:
          'After cleansing, apply the pad to areas of concern and leave it on for 10 - 20 minutes like a mask. Then gently wipe across the face.',
        pdp_field_quality_summary: {
          how_to_use_raw: {
            source_origin: 'official_html',
            source_quality_status: 'high',
          },
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const howToUse = payload.modules.find((module) => module.type === 'how_to_use');
    expect(howToUse?.data?.steps).toEqual([
      'After cleansing, apply the pad to areas of concern and leave it on for 10 - 20 minutes like a mask.',
      'Then gently wipe across the face.',
    ]);
  });

  test('preserves rich official details and cleaned pairing guidance for external-seed PDPs', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_krave_oil_lala',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Oil La La',
        category: 'Serum',
        image_url: 'https://example.com/oil-lala-main.png',
        pdp_description_raw:
          "Treat your skin like something you love. Don't believe the rumors. Oils aren't the enemy of oily, breakout-prone skin.",
        pdp_details_sections: [
          {
            heading: 'Details',
            body:
              "Treat your skin like something you love.\n\nDon't believe the rumors. Oils aren't the enemy of oily, breakout-prone skin.\n\nWhy is it different: Targets the root cause of breakouts by transforming acne-causing sebum.\n\nHelps with: Balancing sebum production.\n\nMade for: All skin types, especially oily, breakout-prone skin.",
          },
          {
            heading: 'How to Pair',
            body:
              'Matcha Hemp Hydrating Cleanser\n\nPair with this gentle cleanser that restores hydration and antioxidants to the skin.\n\nShop Now\nOat So Simple Water Cream\n\nPair with this lightweight moisturizer for extra hydration and soothe sensitized skin.\n\nShop Now',
          },
          {
            heading: 'Clinical Results',
            body: '98% noticed an overall clearer complexion after using this serum.',
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(payload.modules.find((module) => module.type === 'supplemental_details')?.data?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'Details',
          content: expect.stringContaining('Why is it different: Targets the root cause of breakouts'),
        }),
        expect.objectContaining({
          heading: 'How to Pair',
          content: expect.stringContaining('Matcha Hemp Hydrating Cleanser'),
        }),
      ]),
    );
    expect(payload.modules.find((module) => module.type === 'supplemental_details')?.data?.sections).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('Shop Now') })]),
    );
    expect(payload.modules.find((module) => module.type === 'product_facts')?.data?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'Clinical Results',
          content: '98% noticed an overall clearer complexion after using this serum.',
        }),
      ]),
    );
  });

  test('filters transactional and marketing callout detail sections from external-seed primer PDPs', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_tirtir_primer',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Flawless Pore Prep Primer',
        category: 'Primer',
        image_url: 'https://example.com/flawless-primer.png',
        pdp_description_raw: 'COOL THE HEAT. KEEP IT BLUR. For calm skin and a flawless, soft-focus canvas',
        details_sections: [
          {
            heading: 'Flawless Pore Prep Primer',
            body: 'Flawless Pore Prep PrimerYour email Product notification for Notify Me',
          },
          {
            heading: 'Flawless Pore Prep Primer',
            body: '$17.60 Regular price $22.00',
          },
          {
            heading: 'BLUE BOTANICAL RELIEF',
            body: 'Helps calm and comfort stressed skin',
          },
          {
            heading: 'PORE DEFENSE COMPLEX',
            body: 'Helps refine the look of pores and excess oil',
          },
          {
            heading: 'FRESH HERBAL COMPLEX',
            body: 'Helps refresh skin and support balanced skin temperature',
          },
          {
            heading: 'Clinically Tested for Visible Pore Reduction',
            body:
              '69.11% reduction in pore size immediately after use. 50.73% maintained after 24 hours.',
          },
        ],
        ingredients_inci: {
          items: [
            'Guai azulene',
            'Chamomilla Recutita (Matricaria) Flower Water',
            'Rosa Damascena Flower Water',
            'Butylene Glycol',
            '1,2-Hexanediol',
            'Enantia Chlorantha Bark Extract',
            'Oleanolic Acid',
            'Glycerin',
            'Silybum Marianum Extract',
            'Water',
            'Zingiber Officinale (Ginger) Root Extract',
            'Mentha Piperita (Peppermint) Leaf Extract',
            'Leuconostoc/Radish Root Ferment Filtrate',
            'BLUE BOTANICAL RELIEF',
            'PORE DEFENSE COMPLEX',
            'FRESH HERBAL COMPLEX',
          ],
          source_origin: 'pdp_section',
          source_quality_status: 'authoritative',
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const supplemental = payload.modules.find((module) => module.type === 'supplemental_details');
    const productFacts = payload.modules.find((module) => module.type === 'product_facts');
    const ingredientsInci = payload.modules.find((module) => module.type === 'ingredients_inci');

    expect(supplemental).toBeFalsy();
    expect(productFacts?.data?.sections).toEqual([
      expect.objectContaining({
        heading: 'Clinical Results',
        content: expect.stringContaining('69.11% reduction in pore size'),
      }),
    ]);
    expect(ingredientsInci?.data?.items).toEqual(
      expect.not.arrayContaining(['BLUE BOTANICAL RELIEF', 'PORE DEFENSE COMPLEX', 'FRESH HERBAL COMPLEX']),
    );
    expect(ingredientsInci?.data?.items).toEqual(
      expect.arrayContaining([
        'Chamomilla Recutita (Matricaria) Flower Water',
        'Leuconostoc/Radish Root Ferment Filtrate',
      ]),
    );
  });

  test('extracts concise overview and suppresses faq and cross-sell noise for refreshed Fenty sunscreen seeds', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_fenty_hydra_mini',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Hydra Vizor Mini Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
        category: 'Sunscreen',
        image_url: 'https://example.com/hydra-mini.png',
        pdp_description_raw: [
          'YOUR DONE-IN-ONE MOISTURIZER:',
          'HYDRATES, BRIGHTENS, SMOOTHS + PROTECTS WITH MINERAL SPF',
          '',
          'STRAIGHT UP:',
          "A mini moisturizer that works hard, so you don't have to, instantly boosting skin's hydration and moisture barrier. It improves skin's texture, tone, elasticity and the look of dark spots.",
          'THE LOWDOWN:',
          'Instantly boosts hydration by 52%',
          'Improves texture, tone + elasticity and the look of dark spots',
          'What else?!',
          "Noncomedogenic (won't clog pores). For all skin types, especially sensitive.",
          "The #'s don't lie:",
          'After one week:',
          "98% users agree it doesn't feel greasy on skin",
          'Tap into our blog: Mastering Moisturizer with SPF.',
          'Fill Weight: 30 mL / 1 fl. oz.',
        ].join('\n'),
        pdp_details_sections: [
          { heading: 'Concerns', body: 'Dryness, Pores', source_kind: 'embedded_product_json_tags' },
          { heading: 'Format', body: 'Lotion', source_kind: 'embedded_product_json_tags' },
          {
            heading: 'Details',
            body: [
              'YOUR DONE-IN-ONE MOISTURIZER:',
              'HYDRATES, BRIGHTENS, SMOOTHS + PROTECTS WITH MINERAL SPF',
              '',
              'STRAIGHT UP:',
              "A mini moisturizer that works hard, so you don't have to, instantly boosting skin's hydration and moisture barrier.",
              'THE LOWDOWN:',
              'Instantly boosts hydration by 52%',
              'Read more',
            ].join('\n'),
            source_kind: 'accordion_control',
          },
          {
            heading: 'SPF FAQ',
            body: 'What does SPF 30 mean?\n\nLets break it down.',
            source_kind: 'accordion_control',
          },
          {
            heading: 'Earth-conscious details',
            body: 'Its protective outer box is made of FSC material and is recyclable.',
            source_kind: 'accordion_control',
          },
          {
            heading: 'Fat Water Niacinamide Pore-Refining Toner Serum with Barbados Cherry',
            body: '4.6 star rating\n\n(10963)\n\n€34 €27,20\n\nMaximum of 5 allowed',
            source_kind: 'heading_sibling',
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const overview = payload.modules.find((module) => module.type === 'product_overview');
    const supplemental = payload.modules.find((module) => module.type === 'supplemental_details');

    expect(overview?.data?.sections).toEqual([
      expect.objectContaining({
        heading: 'Description',
        content: expect.stringContaining('A mini moisturizer that works hard'),
      }),
    ]);
    expect(overview?.data?.sections?.[0]?.content).not.toMatch(/THE LOWDOWN|What else|Tap into our blog|Fill Weight/i);
    expect((overview?.data?.sections?.[0]?.content || '').length).toBeLessThan(420);

    const supplementalHeadings = (supplemental?.data?.sections || []).map((section) => section.heading);
    expect(supplementalHeadings).toEqual(expect.arrayContaining(['Concerns', 'Format', 'Category']));
    expect(supplementalHeadings).not.toEqual(
      expect.arrayContaining([
        'Details',
        'SPF FAQ',
        'Earth-conscious details',
        'Fat Water Niacinamide Pore-Refining Toner Serum with Barbados Cherry',
      ]),
    );
  });

  test('suppresses external seed ingredient provenance notes from user-visible PDP details', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_tirtir_lip_balm',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Water Mellow Lip Balm',
        category: 'Lip Balm',
        pdp_description_raw: 'A glossy lip balm with a soft tint and non-sticky finish.',
        pdp_details_sections: [
          {
            heading: 'Variant ingredient source',
            body:
              'Official TIRTIR ingredient sheet is variant-level. This PDP stores the listed default variant ingredient row; shade-specific pigments may vary by variant. Stored variant: WATER MELLOW LIP BALM 01 ICY BLUE.',
          },
          {
            heading: 'Texture',
            body: 'Glossy, non-sticky finish with a soft, buttery texture.',
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const supplementalText = JSON.stringify(
      payload.modules.find((module) => module.type === 'supplemental_details')?.data || {},
    );
    expect(supplementalText).not.toMatch(/Variant ingredient source|This PDP stores|Stored variant/i);
    expect(JSON.stringify(payload.modules.find((module) => module.type === 'product_facts')?.data || {})).toMatch(
      /Glossy, non-sticky finish/,
    );
  });

  test('dedupes repeated overview summary text for refreshed external-seed PDPs', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_fenty_hydra_full',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
        category: 'Sunscreen',
        image_url: 'https://example.com/hydra-full.png',
        pdp_description_raw:
          "Boosts skin's hydration and moisture barrier. Improves texture, tone + elasticity. Powered by Hyaluronic Acid, Niacinamide + mineral SPF - great for sensitive skin.\n\nBoosts skin's hydration and moisture barrier. Improves texture, tone + elasticity. Powered by Hyaluronic Acid, Niacinamide + mineral SPF - great for sensitive skin.",
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const overview = payload.modules.find((module) => module.type === 'product_overview');
    expect(overview?.data?.sections).toEqual([
      expect.objectContaining({
        heading: 'Description',
        content:
          "Boosts skin's hydration and moisture barrier. Improves texture, tone + elasticity. Powered by Hyaluronic Acid, Niacinamide + mineral SPF - great for sensitive skin.",
      }),
    ]);
  });

  test('uses ingredient authority instead of legacy active block fragments for external seeds', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_fenty_cherry_cleanser',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: "Cherry Dub Pore Purify'r Gel Cleanser with Niacinamide + Aloe Juice",
        category: 'Cleanser',
        description:
          'A foaming gel cleanser with Triple Cherry Complex, niacinamide, and aloe juice.',
        image_url: 'https://example.com/cherry-cleanser.png',
        price: { amount: 28, currency: 'USD' },
        pdp_active_ingredients_raw:
          "Triple Cherry Complex\n\nThree forms of Vitamin C-rich Barbados Cherry (enzyme, ferment + fruit water); brighten, clarify + renew skin\n\nNiacinamide (Vitamin B3)\n\nRefines pores + skin's texture\n\nAloe Juice\n\nSoothes + conditions",
        ingredient_intel: {
          active_ingredients: ['Niacinamide', 'Vitamin C (Ascorbic acid)'],
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const activeIngredients = payload.modules.find((module) => module.type === 'active_ingredients');

    expect(activeIngredients?.data?.items).toEqual(['Niacinamide']);
    expect(activeIngredients?.data?.items.join(' ')).not.toMatch(/Triple Cherry|clarify|renew skin|Aloe Juice/i);
    expect(activeIngredients?.data?.items).not.toContain('Vitamin C (Ascorbic acid)');
  });

  test('keeps reviewed external seed active ingredients when label differs from INCI synonym', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_ole_banana_eye',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Banana Bright+ Eye Crème',
        category: 'Eye Cream',
        description: 'A vitamin C eye cream that brightens the look of dark circles.',
        image_url: 'https://example.com/banana-eye.png',
        price: { amount: 46, currency: 'USD' },
        active_ingredients: ['Vitamin C'],
        reviewed_active_ingredients_v1: {
          contract_version: 'external_seed.reviewed_active_ingredients.v1',
          status: 'approved',
          active_ingredients: ['Vitamin C'],
          source_url: 'https://olehenriksen.com/products/banana-bright-eye-creme',
          reviewed_by: 'codex',
          reviewed_at: '2026-05-17T00:00:00.000Z',
        },
        ingredients_inci: {
          items: [
            'Aqua/Water/Eau',
            'Simmondsia Chinensis (Jojoba) Seed Oil',
            '3-O-Ethyl Ascorbic Acid',
            'Tetrahexyldecyl Ascorbate',
            'Ascorbic Acid',
            'Glycerin',
          ],
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const activeIngredients = payload.modules.find((module) => module.type === 'active_ingredients');

    expect(activeIngredients?.data?.items).toEqual(['Vitamin C']);
    expect(activeIngredients?.data?.source_origin).toBe('reviewed_active_ingredients');
    expect(activeIngredients?.data?.source_quality_status).toBe('high');
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

  test('preserves product-line size detail labels for mini and full-size options', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_rare_primer_mini',
        merchant_id: 'external_seed',
        title: 'Always an Optimist Pore Diffusing Primer Mini',
        image_url: 'https://example.com/primer-mini.png',
        product_line_option_name: 'Size',
        product_line_options: [
          {
            option_id: 'external_seed:ext_rare_primer_full',
            option_name: 'Size',
            axis: 'size',
            value: 'full size',
            label: 'Full Size',
            secondary_label: '0.94 fl oz / 28 mL',
            product_id: 'ext_rare_primer_full',
            merchant_id: 'external_seed',
            selected: false,
          },
          {
            option_id: 'external_seed:ext_rare_primer_mini',
            option_name: 'Size',
            axis: 'size',
            value: 'mini',
            label: 'Mini',
            secondary_label: '0.50 fl oz / 15 mL',
            product_id: 'ext_rare_primer_mini',
            merchant_id: 'external_seed',
            selected: true,
          },
        ],
        variants: [
          {
            id: 'v-mini',
            title: 'Default Title',
            price: { amount: 17, currency: 'USD' },
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const variantSelector = payload.modules.find((module) => module.type === 'variant_selector');
    expect(variantSelector?.data?.product_line_options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Full Size', secondary_label: '0.94 fl oz / 28 mL' }),
        expect.objectContaining({ label: 'Mini', secondary_label: '0.50 fl oz / 15 mL', selected: true }),
      ]),
    );
  });

  test('keeps a hidden implicit single external variant contract for blocked default-only rows', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_pixi_spot',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Overnight Spot Stickers',
        category: 'Treatment',
        image_url: 'https://example.com/spot.png',
        price: { amount: 12, currency: 'USD' },
        variants: [
          {
            id: 'v_default',
            title: 'Default Title',
            source_quality_status: 'blocked',
            price: { amount: 12, currency: 'USD' },
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(payload.product.default_variant_id).toBe('v_default');
    expect(payload.product.variants).toEqual([
      expect.objectContaining({
        variant_id: 'v_default',
        title: '',
        options: [],
        hidden_from_selector: true,
        source_quality_status: 'blocked',
      }),
    ]);
    expect(payload.modules.find((module) => module.type === 'variant_selector')).toBeFalsy();
  });

  test('renders a single external-seed size variant when authoritative size detail exists', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_skin1004_toner',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Tea-Trica Purifying Toner',
        category: 'Toner',
        image_url: 'https://example.com/toner.png',
        price: { amount: 17, currency: 'USD' },
        size_detail_label: '210ml',
        in_stock: true,
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const variantSelector = payload.modules.find((module) => module.type === 'variant_selector');
    expect(variantSelector).toBeTruthy();
    expect(variantSelector?.data?.variants).toEqual([
      expect.objectContaining({
        variant_id: 'ext_skin1004_toner',
        display_label: 'Size: 210ml',
        options: [expect.objectContaining({ name: 'Size', value: '210ml', axis_kind: 'size' })],
      }),
    ]);
    expect(payload.product.default_variant_id).toBe('ext_skin1004_toner');
    expect(payload.product.variants).toEqual([
      expect.objectContaining({
        variant_id: 'ext_skin1004_toner',
        title: '210ml',
        options: [expect.objectContaining({ name: 'Size', value: '210ml', axis_kind: 'size' })],
      }),
    ]);
  });

  test('renders captured single external-seed Format: Single item selector labels', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_roundlab_ampoule',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: '1025 Dokdo Ampoule',
        category: 'Ampoule',
        image_url: 'https://example.com/dokdo-ampoule.png',
        price: { amount: 31, currency: 'USD' },
        variants: [
          {
            id: 'v_single',
            title: 'Single item',
            options: [{ name: 'Format', value: 'Single item', axis_kind: 'format' }],
            display_label: 'Format: Single item',
            axis_kind: 'format',
            source_quality_status: 'captured',
            price: { amount: 31, currency: 'USD' },
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const variantSelector = payload.modules.find((module) => module.type === 'variant_selector');
    expect(variantSelector).toBeTruthy();
    expect(variantSelector?.data?.variants).toEqual([
      expect.objectContaining({
        variant_id: 'v_single',
        display_label: 'Format: Single item',
        options: [],
        source_quality_status: 'captured',
      }),
    ]);
    expect(payload.product.variants).toEqual([
      expect.objectContaining({
        variant_id: 'v_single',
        title: 'Single item',
        options: [],
        display_label: 'Format: Single item',
        source_quality_status: 'captured',
      }),
    ]);
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

  test('renders formula ingredients when catalog path corrects stale brush category', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_fenty_tint_stick',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Eaze Drop Blur + Smooth Tint Stick - 10',
        category: 'Brush',
        catalog_category_path: 'beauty/makeup/face/foundation',
        category_path: ['beauty', 'makeup', 'face', 'foundation'],
        image_url: 'https://example.com/eaze-drop-10.png',
        pdp_ingredients_raw:
          'DIMETHICONE, OCTYLDODECANOL, SYNTHETIC WAX, ALUMINUM STARCH OCTENYLSUCCINATE, SILICA, ETHYLENE/PROPYLENE COPOLYMER, RICINUS COMMUNIS (CASTOR) SEED OIL, SODIUM HYALURONATE',
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(payload.pdp_schema_profile).toBe('beauty_formula');
    expect(payload.modules.find((module) => module.type === 'ingredients_inci')?.data?.items).toEqual(
      expect.arrayContaining(['DIMETHICONE', 'OCTYLDODECANOL', 'SYNTHETIC WAX']),
    );
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
    expect(payload.modules.find((module) => module.type === 'active_ingredients')).toBeFalsy();
    expect(payload.modules.find((module) => module.type === 'materials')).toBeFalsy();
  });

  test('suppresses active ingredient module for external seed skincare sets with formula category path', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_ole_duo',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Hunt for Hydration Full-Size Moisturizer & Eye Crème Duo',
        category_path: ['beauty', 'skincare', 'moisturizers'],
        product_type: 'Moisturizer',
        image_url: 'https://example.com/hydration-duo.png',
        price: { amount: 83, currency: 'USD' },
        pdp_ingredients_raw: 'Water, Glycerin, Ceramide NP, Panthenol, Niacinamide',
        pdp_active_ingredients_raw: 'Active Ingredients: Ceramide NP, Panthenol, Niacinamide',
        active_ingredients: ['Ceramide NP', 'Panthenol', 'Niacinamide'],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(payload.pdp_schema_profile).toBe('beauty_formula');
    expect(payload.modules.find((module) => module.type === 'active_ingredients')).toBeFalsy();
    expect(payload.modules.find((module) => module.type === 'ingredients_inci')).toBeFalsy();
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

  test('preserves savings presentation evidence on PDP product and variants', () => {
    const paymentOfferEvidence = {
      pricing_confidence: 'display_estimate',
      offers: [
        {
          payment_offer_id: 'PIVOTA_TEST_CARD3',
          display: { badge: '3% card benefit' },
          application_policy: {
            affects_shopify_discount: false,
            affects_psp_amount_v1: false,
          },
        },
      ],
      decisions: [],
    };
    const storeDiscountEvidence = {
      offers: [{ discount_id: 'PIVOTA_TEST_AMOUNT10', status: 'available' }],
    };

    const payload = buildPdpPayload({
      product: {
        product_id: 'shopify_product_1',
        merchant_id: 'merch_test',
        title: 'Savings Serum',
        image_url: 'https://example.com/serum.png',
        price: { amount: 10, currency: 'USD' },
        payment_offer_evidence: paymentOfferEvidence,
        payment_offer_badges: ['3% card benefit'],
        store_discount_evidence: storeDiscountEvidence,
        variants: [
          {
            id: 'variant_1',
            title: 'Default',
            price: { amount: 10, currency: 'USD' },
            payment_offer_evidence: paymentOfferEvidence,
            payment_offer_badges: ['3% card benefit'],
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(payload.product.payment_offer_evidence).toEqual(paymentOfferEvidence);
    expect(payload.product.payment_offer_badges).toEqual(['3% card benefit']);
    expect(payload.product.store_discount_evidence).toEqual(storeDiscountEvidence);
    expect(payload.product.variants[0].payment_offer_evidence).toEqual(paymentOfferEvidence);
    expect(payload.product.variants[0].payment_offer_badges).toEqual(['3% card benefit']);
  });

  test('does not split uppercase product prose into fake Fenty facts', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_fenty_sharpener',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Trace’d Out Dual Pencil Sharpener',
        image_url: 'https://example.com/sharpener.png',
        price: { amount: 8, currency: 'USD' },
        details_sections: [
          {
            heading: 'Details',
            body:
              "MADE SPECIFICALLY FOR THE CREAMY TEXTURE OF TRACE'D OUT PENCIL LIP LINER.\n\nSTRAIGHT UP Dull is out, precision is in. The creamy texture you love about Trace'd Out stays that way thanks to its non-wooden casing. THE LOWDOWN - Made for Trace'd Out Pencil Lip Liner to sharpen without breaking - Go mess free with a protective cap.",
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const facts = payload.modules.find((module) => module.type === 'product_facts');
    const overview = payload.modules.find((module) => module.type === 'product_overview');
    const supplemental = payload.modules.find((module) => module.type === 'supplemental_details');

    expect(facts?.data?.sections || []).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ heading: 'Texture' }),
        expect.objectContaining({ heading: 'Free Of' }),
      ]),
    );
    expect(overview?.data?.sections?.[0]?.content).toMatch(/Dull is out, precision is in/i);
    expect(overview?.data?.sections?.[0]?.content).not.toMatch(/STRAIGHT UP|THE LOWDOWN/i);
    expect(supplemental?.data?.sections || []).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ heading: 'Details' })]),
    );
  });

  test('emits category_kind + passes fashion_meta through for apparel products', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'sig_apparel_1',
        merchant_id: 'm1',
        title: 'Push-Up Lingerie Set',
        category: 'Apparel/Lingerie',
        fashion_meta: {
          size_fit_chart: {
            columns: ['Size', 'Bust', 'Underbust'],
            rows: [
              { label: 'S', values: ['32A-32B', '70-74cm'] },
              { label: 'M', values: ['34B-34C', '74-78cm'] },
            ],
            note: 'Measurements in cm; bust range matches US sizing.',
            tip: 'Between sizes? Size up for fuller bust.',
          },
          model: { info: "Model is 5'8\" wearing M", avatar_url: null },
          material: '90% nylon, 10% spandex',
          origin: 'Made in Vietnam',
          care: 'Hand wash cold; lay flat to dry',
          styling_pairings: [
            { name: 'Silk Robe', brand: 'GR', price: 38, img: 'https://example.com/robe.jpg' },
          ],
        },
        variants: [
          { id: 'v_s', title: 'S', price: { amount: 23, currency: 'USD' } },
          { id: 'v_m', title: 'M', price: { amount: 23, currency: 'USD' } },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });
    expect(payload.product.category_kind).toBe('fashion');
    expect(payload.product.fashion_meta).toBeDefined();
    expect(payload.product.fashion_meta.material).toBe('90% nylon, 10% spandex');
    expect(payload.product.fashion_meta.size_fit_chart.rows).toHaveLength(2);
    expect(payload.product.electronics_meta).toBeUndefined();
  });

  test('emits category_kind = electronics + passes electronics_meta through', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'sig_electronics_1',
        merchant_id: 'm1',
        title: 'WH-1000XM5 Wireless Headphones',
        category: 'Electronics/Audio/Headphones',
        electronics_meta: {
          spec_groups: [
            { group: 'Battery', icon: 'battery', rows: [['Playback', '30 hours']] },
          ],
          in_box: ['Headphones', 'Carrying case', 'USB-C cable'],
          pro_reviews: [
            { source: 'Wirecutter', verdict: 'Top pick', score: '4.6', url: 'https://wirecutter.example/sony' },
          ],
        },
        variants: [{ id: 'v_black', title: 'Black', price: { amount: 399, currency: 'USD' } }],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });
    expect(payload.product.category_kind).toBe('electronics');
    expect(payload.product.electronics_meta.in_box).toContain('Headphones');
    expect(payload.product.electronics_meta.pro_reviews).toHaveLength(1);
    expect(payload.product.fashion_meta).toBeUndefined();
  });

  test('omits fashion_meta / electronics_meta blocks when source product lacks them', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'sig_no_meta',
        merchant_id: 'm1',
        title: 'Plain T-Shirt',
        category: 'Apparel/Tops',
        variants: [{ id: 'v_one', title: 'One Size', price: { amount: 12, currency: 'USD' } }],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });
    expect(payload.product.category_kind).toBe('fashion');
    expect(payload.product.fashion_meta).toBeUndefined();
    expect(payload.product.electronics_meta).toBeUndefined();
  });

  test('falls back to category_kind = generic when no signal matches', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'sig_generic',
        merchant_id: 'm1',
        title: 'Random Object',
        variants: [{ id: 'v_one', title: 'Default', price: { amount: 5, currency: 'USD' } }],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });
    expect(payload.product.category_kind).toBe('generic');
  });

  test('respects an explicit product.category_kind override', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'sig_explicit',
        merchant_id: 'm1',
        title: 'Mystery Item',
        category: 'Apparel/Lingerie', // would normally infer fashion
        category_kind: 'generic', // explicit override wins
        variants: [{ id: 'v_one', title: 'Default', price: { amount: 5, currency: 'USD' } }],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });
    expect(payload.product.category_kind).toBe('generic');
  });

  test('overlays sample fashion_meta for a known sample product_id', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'sample_fashion_lingerie_001',
        merchant_id: 'm_sample',
        title: 'Sample Push-Up Lingerie Set',
        variants: [{ id: 'v_m', title: 'M', price: { amount: 28, currency: 'USD' } }],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });
    expect(payload.product.category_kind).toBe('fashion');
    expect(payload.product.fashion_meta).toBeDefined();
    expect(payload.product.fashion_meta.material).toMatch(/nylon/i);
    expect(payload.product.fashion_meta.size_fit_chart.rows.length).toBeGreaterThan(0);
    expect(payload.product.fashion_meta.styling_pairings.length).toBeGreaterThan(0);
  });

  test('overlays sample electronics_meta for a known sample product_id', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'sample_electronics_macbook_air_m3',
        merchant_id: 'm_sample',
        title: 'Sample MacBook Air M3',
        variants: [{ id: 'v_base', title: '13"', price: { amount: 1099, currency: 'USD' } }],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });
    expect(payload.product.category_kind).toBe('electronics');
    expect(payload.product.electronics_meta).toBeDefined();
    expect(payload.product.electronics_meta.configurator_groups.length).toBeGreaterThan(0);
    expect(payload.product.electronics_meta.in_box).toContain('MacBook Air');
  });

  test('upstream fashion_meta wins over the sample overlay', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'sample_fashion_lingerie_001', // matches an overlay key
        merchant_id: 'm_sample',
        title: 'Sample',
        fashion_meta: {
          material: 'CUSTOM upstream material', // upstream override
        },
        variants: [{ id: 'v_m', title: 'M', price: { amount: 28, currency: 'USD' } }],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });
    expect(payload.product.fashion_meta.material).toBe('CUSTOM upstream material');
    // Upstream-only field set; overlay-only fields (e.g. size_fit_chart) are NOT merged.
    expect(payload.product.fashion_meta.size_fit_chart).toBeUndefined();
  });
});
