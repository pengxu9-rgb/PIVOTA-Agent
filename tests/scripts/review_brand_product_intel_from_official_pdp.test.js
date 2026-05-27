const {
  buildInsightBundle,
  buildPlan,
  inferRole,
  isWeakExistingInsight,
  readSeedFacts,
} = require('../../scripts/review-brand-product-intel-from-official-pdp.cjs');

function row(overrides = {}) {
  return {
    external_product_id: 'ext_tf_lip',
    title: 'Lip Color Lipstick',
    brand: 'TOM FORD BEAUTY',
    canonical_url: 'https://www.tomfordbeauty.com/product/lip-color',
    seed_data: {
      brand: 'TOM FORD BEAUTY',
      pdp_description_raw: 'A rich lip color with a satin finish and multidimensional shade payoff.',
      pdp_ingredients_raw: 'Ingredients: Ricinus Communis (Castor) Seed Oil; Synthetic Wax; Silica.',
      pdp_how_to_use_raw: 'Apply directly to lips from the bullet or with a lip brush.',
      variants: [
        {
          title: '100 Equus',
          options: [{ name: 'Shade', value: '100 Equus' }, { name: 'Size', value: '0.1 oz' }],
        },
      ],
    },
    product_key: 'pk_tf_lip',
    pivota_signature_id: 'sig_tf_lip',
    ...overrides,
  };
}

function kbEntry(bundle) {
  return {
    kb_key: 'product:ext_tf_lip',
    analysis: { product_intel_v1: bundle },
    source: 'aurora_product_intel_kb',
    source_meta: { quality_state: bundle.quality_state || 'reviewed' },
  };
}

function weakBundle() {
  return {
    quality_state: 'reviewed',
    evidence_profile: 'seller_plus_formula',
    product_intel_core: {
      quality_state: 'reviewed',
      what_it_is: {
        headline: 'Lipstick identity',
        body: 'A Tom Ford Beauty lipstick listed on the official source page as Lip Color Lipstick.',
      },
      why_it_stands_out: [
        { headline: 'Official product detail', body: 'Official product detail.' },
        { headline: 'Formula context captured', body: 'Formula context captured.' },
      ],
      best_for: [{ label: 'Lipstick', tag: 'lipstick' }],
    },
    shopping_card: { title: 'Lip Color Lipstick', subtitle: 'Lipstick', highlight: 'Lipstick identity' },
    search_card: { title_candidate: 'Lip Color Lipstick', compact_candidate: 'Lipstick', highlight_candidate: 'Lipstick identity' },
  };
}

function strongBundle() {
  return {
    quality_state: 'reviewed',
    evidence_profile: 'official_pdp_reviewed_formula',
    product_intel_core: {
      quality_state: 'reviewed',
      what_it_is: {
        headline: 'Lip color',
        body: 'A satin-finish lipstick with official shade data and a disclosed ingredient list.',
      },
      why_it_stands_out: [
        {
          headline: 'Shade and format are clear',
          body: 'The PDP exposes a named shade and size so shoppers can compare the SKU without a generic selector.',
        },
        {
          headline: 'Ingredient list is available',
          body: 'The official source exposes a full ingredient list for formula-sensitive review.',
        },
      ],
      best_for: [{ label: 'Color payoff', tag: 'color_payoff' }],
    },
    shopping_card: { title: 'Lip Color Lipstick', subtitle: 'Lip color', highlight: 'Satin finish' },
    search_card: { title_candidate: 'Lip Color Lipstick', compact_candidate: 'Lip color', highlight_candidate: 'Satin finish' },
  };
}

describe('official PDP manual insight review', () => {
  test('extracts Tom Ford official facts without fallback content', () => {
    const facts = readSeedFacts(row());

    expect(facts.brand).toBe('Tom Ford Beauty');
    expect(facts.rawIngredients).toContain('Ingredients: Ricinus Communis (Castor) Seed Oil');
    expect(facts.variants.labels).toEqual(expect.arrayContaining(['Shade: 100 Equus', 'Size: 0.1 oz']));
    expect(inferRole(facts).label).toBe('Lip color');
  });

  test('classifies Rare Beauty roles from product identity before ingredient prose', () => {
    const facts = (overrides) => ({
      activeIngredients: [],
      rawIngredients: [],
      details: [],
      variants: { labels: [] },
      ...overrides,
    });

    expect(
      inferRole(facts({
        title: 'Find Comfort Body & Hair Fragrance Mist Mini',
        productType: 'Fragrance',
        categoryPath: 'beauty/fragrance/body_mist',
        description: 'A soft body and hair mist.',
      })).label,
    ).toBe('Body fragrance spray');
    expect(
      inferRole(facts({
        title: 'Always an Optimist Soft Radiance Setting Powder',
        productType: 'Setting Powder',
        categoryPath: 'beauty/makeup/face/powder',
        description: 'A loose setting powder with a fragrance-free finish.',
      })).label,
    ).toBe('Face color makeup');
    expect(
      inferRole(facts({
        title: 'Cherry Dub BHA Toner with Salicylic Acid + Aloe Juice',
        productType: 'Toner',
        categoryPath: 'beauty/skincare/toner',
        description: 'A pore-purifying BHA toner with salicylic acid and aloe juice.',
        rawIngredients: ['Water', 'Salicylic Acid', 'Aloe Barbadensis Leaf Juice', 'Fragrance'],
      })).label,
    ).toBe('Exfoliating toner');
    expect(
      inferRole(facts({
        title: 'Peach Glaze Glow Mist',
        productType: 'Face Mist',
        categoryPath: 'beauty/skincare/mist',
        description: 'A glow mist for a skincare routine.',
      })).label,
    ).toBe('Face mist');
    expect(
      inferRole(facts({
        title: 'Pixi + Hello Kitty Hydrating Milky Mist',
        productType: 'Face Mist',
        categoryPath: 'beauty/skincare/mist',
        description: 'A hydrating milky mist for a skincare routine.',
      })).label,
    ).toBe('Face mist');
    expect(
      inferRole(facts({
        title: 'CBD - 8 Bath bombs set - perfect for a relaxing bath',
        productType: 'Bath Bombs',
        categoryPath: 'beauty/body/bath',
        description: 'A bath bomb set for bath and shower routines.',
      })).label,
    ).toBe('Bath and shower soak');
    expect(
      inferRole(facts({
        title: 'Natural Handmade Beard Oil, Beard Softener, Beard Moisture',
        productType: 'Beard Oil',
        categoryPath: 'beauty/body/beard',
        description: 'A beard oil for softening facial hair.',
      })).label,
    ).toBe('Beard oil');
    expect(
      inferRole(facts({
        title: 'Lemonade Smoothing Scrub',
        productType: 'Scrub',
        categoryPath: 'beauty/skincare/exfoliator',
        description: 'A face scrub with AHAs.',
      })).label,
    ).toBe('Face scrub');
    expect(
      inferRole(facts({
        title: 'Truth Serum Duo',
        productType: 'Serum Duo',
        categoryPath: 'beauty/skincare/serum',
        description: 'A duo of vitamin C serum.',
      })).label,
    ).toBe('Skincare set');
    expect(
      inferRole(facts({
        title: 'Positive Light Luminizing Lip Gloss',
        productType: 'Lip Gloss',
        categoryPath: 'beauty/makeup/lip/lip_gloss',
        description: 'Glossy lip color with shine.',
      })).label,
    ).toBe('Lip color');
    expect(
      inferRole(facts({
        title: 'Find Comfort Hydrating Body Lotion with Pump',
        productType: 'Body Lotion',
        categoryPath: 'beauty/body/body_lotion',
        description: 'A hydrating lotion for body care.',
      })).label,
    ).toBe('Body care treatment');
    expect(
      inferRole(facts({
        title: 'Liquid Touch Foundation Brush',
        productType: 'Foundation Brush',
        categoryPath: 'beauty/tools/brushes',
        description: 'A foundation brush packed with soft bristles.',
      })).label,
    ).toBe('Makeup brush');
    expect(
      inferRole(facts({
        title: 'Soft Touch Powder Puff',
        productType: 'Powder Puff',
        categoryPath: 'beauty/tools/applicators',
        description: 'A soft-touch velvet puff for pressed powder.',
      })).label,
    ).toBe('Makeup applicator');
    expect(
      inferRole(facts({
        title: 'Find Comfort Mini Body Essentials - Awaken Confidence',
        productType: 'Body Set',
        categoryPath: 'beauty/body/body_set',
        description: 'A mini body essentials set with body-care and scent formats.',
      })).label,
    ).toBe('Body care set');
    expect(
      inferRole(facts({
        title: 'Find Comfort Stop & Soothe Aromatherapy Pen',
        productType: 'Aromatherapy',
        categoryPath: 'beauty/body/aromatherapy',
        description: 'A click-up aromatherapy format for comfort.',
      })).label,
    ).toBe('Aromatherapy treatment');
    expect(
      inferRole(facts({
        title: '24h Protection Deodorant',
        productType: 'Deodorant',
        categoryPath: 'beauty/body/deodorant',
        description: 'A deodorant format for body care.',
      })).label,
    ).toBe('Deodorant');
    expect(
      inferRole(facts({
        title: 'Rare Beauty T-Shirt',
        productType: 'Apparel',
        categoryPath: 'merch/apparel',
        description: 'A soft cotton tee.',
      })).label,
    ).toBe('Branded apparel');
    expect(
      inferRole(facts({
        title: 'Rare Beauty Enamel Stickers',
        productType: 'Stickers',
        categoryPath: 'merch/accessories',
        description: 'Collectible stickers with metallic accents.',
      })).label,
    ).toBe('Beauty accessory');
    expect(
      inferRole(facts({
        title: 'Cosmic Tray',
        productType: 'Fragrance accessory',
        categoryPath: 'beauty/fragrance/accessory',
        description: 'A fragrance tray accessory for a fragrance line.',
      })).label,
    ).toBe('Beauty accessory');
    expect(
      inferRole(facts({
        title: 'Soft Pooch Blush Dog Toy - Faith',
        productType: 'Pet Toy',
        categoryPath: 'merch/pet',
        description: 'A Soft Pooch dog toy in a new color.',
      })).label,
    ).toBe('Pet accessory');
  });

  test('builds specific source-backed insight copy', () => {
    const bundle = buildInsightBundle(row());

    expect(bundle.quality_state).toBe('reviewed');
    expect(bundle.evidence_profile).toBe('official_pdp_reviewed_formula_and_usage');
    expect(bundle.product_intel_core.what_it_is.body).toContain('satin finish');
    expect(bundle.product_intel_core.why_it_stands_out.map((item) => item.headline)).toContain('Ingredient list is available');
    expect(bundle.product_intel_core.why_it_stands_out.map((item) => item.headline)).not.toContain('Official product detail');
  });

  test('allows Fenty SPF rows through the reviewed official-PDP template', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_spf',
        title: 'Hydra Vizor Invisible Moisturizer SPF 30 with Niacinamide + Kalahari Melon',
        brand: 'FENTY SKIN',
        canonical_url: 'https://fentybeauty.com/products/hydra-vizor-invisible-moisturizer-spf-30',
        seed_data: {
          brand: 'FENTY SKIN',
          pdp_description_raw: 'YOUR DONE-IN-ONE MOISTURIZER: HYDRATES, BRIGHTENS, SMOOTHS + PROTECTS STRAIGHT UP: A lightweight daily moisturizer with SPF 30, niacinamide, and Kalahari melon for a hydrating sunscreen step. THE LOWDOWN: Instantly hydrates.',
          pdp_active_ingredients_raw: 'Active Ingredients: Avobenzone 3%; Homosalate 9%; Octisalate 4.5%.',
          pdp_ingredients_raw: 'Ingredients: Water, Homosalate, Glycerin, Avobenzone, Octisalate, Niacinamide.',
          pdp_how_to_use_raw: 'Apply generously 15 minutes before sun exposure as the last step in your skincare routine.',
          variants: [
            {
              title: '50 ml',
              options: [{ name: 'Size', value: '50 ml' }],
            },
          ],
        },
        product_key: 'pk_fenty_spf',
        pivota_signature_id: 'sig_fenty_spf',
      }),
      { brand: 'Fenty Skin', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.changed).toBe(true);
    expect(plan.evidence_profile).toBe('official_pdp_reviewed_formula_and_usage');
    expect(plan.preview.headline).toBe('Daily sunscreen');
    expect(plan.preview.what_it_is).toContain('Fenty Skin');
    expect(plan.preview.what_it_is).not.toContain('STRAIGHT UP');
    expect(plan.preview.what_it_is).not.toContain('THE LOWDOWN');
    expect(plan.preview.why_it_stands_out.map((item) => item.headline)).toContain('Ingredient list is available');
  });

  test('keeps Fenty hydrating primer out of foundation coverage and matte language', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_soft_silk_primer',
        title: "Pro Filt'r Hydrating Primer - Soft Silk",
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/pro-filtr-hydrating-primer-soft-silk',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            'A lightweight hydrating makeup primer for normal to dry skin, designed to soften dry patches, create a silky soft-focus canvas, and help foundation apply smoothly and wear longer.',
          pdp_ingredients_raw:
            'Aqua/Water/Eau, Dimethicone, Glycerin, Sodium Hyaluronate, Vitis Vinifera (Grape) Seed Oil, Tocopheryl Acetate.',
          pdp_how_to_use_raw:
            'Apply 1-2 pumps, starting at the center of the face and blending outward. For dry skin, apply all over; for normal or combination skin, apply where skin tends to feel dry.',
          pdp_details_sections: [
            {
              heading: 'Related complexion line',
              body: "The related Pro Filt'r complexion line also includes Soft Matte Longwear Foundation, but this SKU is the hydrating primer step.",
            },
          ],
          variants: [
            {
              title: 'Standard',
              options: [{ name: 'Size', value: 'Standard' }],
            },
            {
              title: 'Mini',
              options: [{ name: 'Size', value: 'Mini' }],
            },
          ],
        },
        product_key: 'pk_fenty_soft_silk_primer',
        pivota_signature_id: 'sig_fenty_soft_silk_primer',
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    const previewText = JSON.stringify(plan.preview).toLowerCase();
    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Makeup primer');
    expect(plan.preview.what_it_is).toContain('makeup primer');
    expect(plan.preview.what_it_is).toContain('hydrating prep');
    expect(plan.preview.what_it_is).toContain('smoother makeup canvas');
    expect(plan.preview.what_it_is).toContain('makeup-wear support');
    expect(plan.preview.shopping_highlight).toMatch(/makeup prep|hydration|soft-focus canvas/);
    expect(previewText).not.toContain('matte finish');
    expect(previewText).not.toContain('complexion coverage');
    expect(plan.preview.best_for.map((item) => item.tag)).not.toContain('complexion_coverage');
    expect(previewText).not.toContain('standard');
    expect(previewText).not.toContain('mini');
    expect(plan.preview.shopping_highlight).not.toContain('Standard');
    expect(plan.preview.shopping_highlight).not.toContain('Mini');
  });

  test('allows Kylie component lip combos through the reviewed official-PDP template', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_kylie_combo',
        title: 'Cocoa Precision Pout Lip Liner & Underestimated Gloss Drip',
        brand: 'Kylie Cosmetics',
        canonical_url: 'https://kyliecosmetics.com/products/cocoa-precision-pout-lip-liner-underestimated-gloss-drip',
        seed_data: {
          brand: 'Kylie Cosmetics',
          pdp_description_raw:
            "Kylie's Paris Glam Lip Combo look includes Precision Pout Lip Liner in Cocoa and Gloss Drip in Underestimated.",
          pdp_how_to_use_raw:
            'Use the Precision Pout Lip Liner to line and fill the lips, then apply Gloss Drip to bare lips or over lip color for a mirror-shine finish.',
          pdp_details_sections: [
            {
              heading: 'Included components',
              body: 'This combo includes Precision Pout Lip Liner in Cocoa and Gloss Drip in Underestimated.',
            },
          ],
          variants: [
            {
              title: 'Cocoa liner + Underestimated gloss',
              options: [{ name: 'Set', value: 'Cocoa liner + Underestimated gloss' }],
            },
          ],
        },
        product_key: 'pk_kylie_combo',
        pivota_signature_id: 'sig_kylie_combo',
      }),
      { brand: 'Kylie Cosmetics', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.changed).toBe(true);
    expect(plan.preview.headline).toBe('Lip combo');
    expect(plan.preview.what_it_is).toContain('Kylie Cosmetics');
    expect(plan.preview.what_it_is).not.toContain('Shop');
    expect(plan.preview.why_it_stands_out.map((item) => item.headline)).toEqual(expect.arrayContaining([
      'Component pairing is clear',
      'Finish role is easy to compare',
      'Application order is explicit',
    ]));
    expect(plan.preview.why_it_stands_out.map((item) => item.headline)).not.toContain('Concrete product cues');
    expect(plan.preview.why_it_stands_out[0].body).toContain('Precision Pout Lip Liner');
    expect(plan.preview.why_it_stands_out[1].body).not.toContain('Gloss Drip');
    expect(plan.preview.shopping_highlight).toBe('Cocoa Precision Pout Lip Liner + Underestimated Gloss Drip');
  });

  test('allows Joocyee and Judydoll through the reviewed official-PDP template', () => {
    const joocyeePlan = buildPlan(
      row({
        external_product_id: 'ext_joocyee_brow',
        title: 'Dual-Ended Eyebrow Pencil & Cream 2.0',
        brand: 'Joocyee',
        canonical_url: 'https://joocyee.com/products/dual-ended-eyebrow-pencil-cream-2-0',
        seed_data: {
          brand: 'Joocyee',
          pdp_description_raw:
            'One fine stroke for precise feathered brows, one sweep for brow color that never stains skin.',
          pdp_how_to_use_raw: 'Use the pencil tip to define brows, then sweep the cream through the brow hair.',
          pdp_details_sections: [
            { heading: 'Finish', body: 'Soft matte finish with buildable color.' },
          ],
          variants: [
            { title: '03 Cool Misty Brown', options: [{ name: 'Color', value: '03 Cool Misty Brown' }] },
          ],
        },
      }),
      { brand: 'Joocyee', includeStrong: false },
    );
    const judydollPlan = buildPlan(
      row({
        external_product_id: 'ext_judydoll_contour',
        title: 'Dual-Ended Contour Stick',
        brand: 'Judydoll',
        canonical_url: 'https://judydoll.com/products/dual-ended-contour-stick',
        seed_data: {
          brand: 'Judydoll',
          pdp_description_raw:
            'A dual-ended contour stick for sculpting and highlighting with a creamy, blendable texture.',
          pdp_how_to_use_raw: 'Swipe onto the face and blend with fingers, sponge, or brush.',
          pdp_details_sections: [
            { heading: 'Texture', body: 'Creamy stick format designed for easy blending.' },
          ],
          variants: [
            { title: '02 Warm Yellow Undertones', options: [{ name: 'Shade', value: '02 Warm Yellow Undertones' }] },
          ],
        },
      }),
      { brand: 'Judydoll', includeStrong: false },
    );
    const lipInkPlan = buildPlan(
      row({
        external_product_id: 'ext_judydoll_lip_ink',
        title: 'Silky Matte Lip Ink',
        brand: 'Judydoll',
        canonical_url: 'https://judydoll.com/products/silky-matte-lip-ink',
        seed_data: {
          brand: 'Judydoll',
          pdp_description_raw:
            'Bold, lightweight color with a silky matte feel, transfer-resistant wear, and comfortable non-drying texture.',
          pdp_how_to_use_raw: 'Apply directly to the lips and let the color set for a soft matte finish.',
          pdp_details_sections: [
            { heading: 'Finish', body: 'Silky matte color designed for long-lasting lip wear.' },
          ],
          variants: [
            { title: '10 Terra Ink', options: [{ name: 'Shade', value: '10 Terra Ink' }] },
          ],
        },
      }),
      { brand: 'Judydoll', includeStrong: false },
    );
    const highlighterPlan = buildPlan(
      row({
        external_product_id: 'ext_judydoll_highlighter',
        title: 'Sheer Tinted Highlighter',
        brand: 'Judydoll',
        canonical_url: 'https://judydoll.com/products/sheer-tinted-highlighter',
        seed_data: {
          brand: 'Judydoll',
          pdp_description_raw:
            'A sheer tinted highlighter with buildable glow payoff and a lightweight, blendable finish.',
          pdp_how_to_use_raw: 'Apply to cheekbones, brow bones, or other high points of the face.',
          variants: [
            { title: '03 Peach Sorbet', options: [{ name: 'Shade', value: '03 Peach Sorbet' }] },
          ],
        },
      }),
      { brand: 'Judydoll', includeStrong: false },
    );

    expect(joocyeePlan.blocked).toBe(false);
    expect(joocyeePlan.evidence_profile).toBe('official_pdp_reviewed_line');
    expect(joocyeePlan.preview.what_it_is).toContain('Joocyee');
    expect(judydollPlan.blocked).toBe(false);
    expect(judydollPlan.evidence_profile).toBe('official_pdp_reviewed_line');
    expect(judydollPlan.preview.what_it_is).toContain('Judydoll');
    expect(lipInkPlan.blocked).toBe(false);
    expect(lipInkPlan.preview.headline).toBe('Lip color');
    expect(lipInkPlan.preview.shopping_highlight).not.toBe('Beauty product');
    expect(highlighterPlan.blocked).toBe(false);
    expect(highlighterPlan.preview.shopping_highlight).toContain('glow payoff');
    expect(highlighterPlan.preview.shopping_highlight).not.toContain('bronzing/contour');
  });

  test('allows Flower Knows, RMS Beauty, and Catkin through source-backed roles', () => {
    const flowerPlan = buildPlan(
      row({
        external_product_id: 'ext_flower_palette',
        title: 'Midsummer Fairytales Embossed Five-Color Makeup Palette',
        brand: 'Flower Knows',
        canonical_url: 'https://flowerknows.co/products/midsummer-fairytales-embossed-five-color-makeup-palette-usa',
        seed_data: {
          brand: 'Flower Knows',
          pdp_description_raw: 'A five-color makeup palette with embossed pans and a soft powder texture.',
          pdp_details_sections: [{ heading: 'Color story', body: 'Five shades are arranged for eye looks.' }],
          variants: [{ title: '01 Dream', options: [{ name: 'Color', value: '01 Dream' }] }],
        },
      }),
      { brand: 'Flower Knows', includeStrong: false },
    );
    const rmsEyePlan = buildPlan(
      row({
        external_product_id: 'ext_rms_spf_eye',
        title: 'ReFresh Eye Brightener SPF 30 + Correcting Tint',
        brand: 'RMS Beauty',
        canonical_url: 'https://www.rmsbeauty.com/products/refresh-eye-brightener-spf-30',
        seed_data: {
          brand: 'RMS Beauty',
          pdp_description_raw: 'A correcting eye tint with SPF 30, mineral sunscreen, and hydrating support.',
          pdp_active_ingredients_raw: 'Active Ingredients: Titanium Dioxide 4.9%, Zinc Oxide 6.3%.',
          variants: [{ title: 'Hush', options: [{ name: 'Shade', value: 'Hush' }] }],
        },
      }),
      { includeStrong: false },
    );
    const catkinPlan = buildPlan(
      row({
        external_product_id: 'ext_catkin_balm',
        title: 'CATKIN Tinted Glossy Lip Balm',
        brand: 'CATKIN Cosmetics',
        canonical_url: 'https://www.catkin.com/products/catkin-tinted-glossy-lip-balm',
        seed_data: {
          brand: 'CATKIN Cosmetics',
          pdp_description_raw: 'A tinted glossy lip balm with a shine finish and color selection.',
          pdp_details_sections: [{ heading: 'Finish', body: 'Glossy tinted finish.' }],
          variants: [{ title: 'C01 Peach', options: [{ name: 'Shade', value: 'C01 Peach' }] }],
        },
      }),
      { includeStrong: false },
    );

    expect(flowerPlan.blocked).toBe(false);
    expect(flowerPlan.preview.headline).toBe('Eye makeup');
    expect(flowerPlan.preview.what_it_is).toContain('eye makeup palette');
    expect(rmsEyePlan.blocked).toBe(false);
    expect(rmsEyePlan.preview.headline).toBe('Daily sunscreen');
    expect(rmsEyePlan.preview.what_it_is).toContain('SPF eye brightener');
    expect(catkinPlan.blocked).toBe(false);
    expect(catkinPlan.preview.headline).toBe('Lip treatment');
    expect(catkinPlan.preview.shopping_highlight).toContain('shine finish');
  });

  test('allows brand expansion rows through source-backed roles', () => {
    const intoYouPlan = buildPlan(
      row({
        external_product_id: 'ext_into_you_glaze',
        title: 'INTO YOU Aqua Burst Lip Glaze',
        brand: 'INTO YOU',
        canonical_url: 'https://intoyoucosmetics.com/products/aqua-burst-lip-glaze',
        seed_data: {
          brand: 'INTO YOU',
          pdp_description_raw: 'A glossy lip glaze with a dewy shine finish and shade clarity.',
          pdp_details_sections: [
            { heading: 'Formula', body: 'Lip glaze format with shine finish and comfort-oriented lip care.' },
          ],
          variants: [{ title: 'AB02', options: [{ name: 'Color', value: 'AB02' }] }],
        },
      }),
      { productIds: ['ext_into_you_glaze'], includeStrong: true },
    );
    const baiePlan = buildPlan(
      row({
        external_product_id: 'ext_baie_spf',
        title: 'Organic Mineral Sunscreen for Baby & Children SPF 50',
        brand: 'Baie Botanique',
        canonical_url: 'https://baiebotanique.com/products/organic-mineral-sunscreen-spf-50',
        seed_data: {
          brand: 'Baie Botanique',
          pdp_description_raw: 'A mineral sunscreen moisturizer for daily SPF use.',
          pdp_active_ingredients_raw: 'Zinc Oxide 20%',
          pdp_ingredients_raw: 'Water, Zinc Oxide, Glycerin, Shea Butter.',
          pdp_how_to_use_raw: 'Apply generously before sun exposure.',
          variants: [{ title: '100g', options: [{ name: 'Size', value: '100g' }] }],
        },
      }),
      { productIds: ['ext_baie_spf'], includeStrong: true },
    );
    const linhartPlan = buildPlan(
      row({
        external_product_id: 'ext_linhart_lip_balm',
        title: 'Lip Balm SPF 15',
        brand: 'Linhart Smile Care',
        canonical_url: 'https://linhart.nyc/products/lip-balm-spf-15',
        seed_data: {
          brand: 'Linhart Smile Care',
          pdp_description_raw: 'A lip balm with SPF 15 and shea butter.',
          pdp_active_ingredients_raw: 'Avobenzone 3%; Octinoxate 7.5%',
          pdp_how_to_use_raw: 'Apply to lips before sun exposure.',
          variants: [{ title: 'Vanilla Mint', options: [{ name: 'Flavor', value: 'Vanilla Mint' }] }],
        },
      }),
      { productIds: ['ext_linhart_lip_balm'], includeStrong: true },
    );
    const tirtirPlan = buildPlan(
      row({
        external_product_id: 'ext_tirtir_cushion',
        title: 'My Glow Cream Cushion',
        brand: 'TIRTIR Global',
        canonical_url: 'https://tirtir.global/products/my-glow-cream-cushion',
        seed_data: {
          brand: 'TIRTIR Global',
          pdp_description_raw: 'A cream cushion complexion product with coverage control and glow finish.',
          pdp_ingredients_raw: 'Water, Titanium Dioxide, Glycerin, Dimethicone.',
          pdp_how_to_use_raw: 'Apply with the included puff and tap onto skin.',
          variants: [{ title: '17C Porcelain', options: [{ name: 'Color', value: '17C Porcelain' }] }],
        },
      }),
      { productIds: ['ext_tirtir_cushion'], includeStrong: true },
    );

    expect(intoYouPlan.blocked).toBe(false);
    expect(intoYouPlan.preview.headline).toBe('Lip color');
    expect(intoYouPlan.preview.what_it_is).toContain('INTO YOU');
    expect(baiePlan.blocked).toBe(false);
    expect(baiePlan.preview.headline).toBe('Daily sunscreen');
    expect(baiePlan.preview.what_it_is).toContain('Baie Botanique');
    expect(linhartPlan.blocked).toBe(false);
    expect(linhartPlan.preview.headline).toBe('Lip treatment');
    expect(linhartPlan.preview.what_it_is).toContain('lip balm');
    expect(linhartPlan.preview.what_it_is).not.toContain('tinted lip balm');
    expect(tirtirPlan.blocked).toBe(false);
    expect(tirtirPlan.preview.headline).toBe('Complexion makeup');
    expect(tirtirPlan.preview.what_it_is).toContain('TIRTIR Global');
  });

  test('keeps Kylie lip glaze samples in lip color language', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_kylie_lip_glaze_sample',
        title: 'Rose Bloom Supple Kiss Lip Glaze Deluxe Sample',
        brand: 'Kylie Cosmetics',
        canonical_url: 'https://kyliecosmetics.com/products/rose-bloom-supple-kiss-lip-glaze-deluxe-sample',
        seed_data: {
          brand: 'Kylie Cosmetics',
          pdp_description_raw:
            "Shop Kylie Cosmetics by Kylie Jenner, Kylie Jenner Fragrances and Kylie Skin featuring award-winning makeup, fragrance, and skincare that's clean, vegan, cruelty-free, and dermatologist-tested.",
          pdp_ingredients_raw:
            'POLYBUTENE, TRIDECYL TRIMELLITATE, OCTYLDODECYL STEAROYL STEARATE, ISOCETYL STEARATE, SILICA DIMETHYL SILYLATE, PARFUM/FRAGRANCE, VANILLIN, TITANIUM DIOXIDE (CI 77891).',
          pdp_how_to_use_raw: 'apply to bare lips or over lipstick for a glowy wash of color and shine.',
          variants: [
            {
              title: 'Single item',
              options: [{ name: 'Format', value: 'Single item' }],
            },
          ],
        },
        product_key: 'pk_kylie_lip_glaze_sample',
        pivota_signature_id: 'sig_kylie_lip_glaze_sample',
      }),
      { brand: 'Kylie Cosmetics', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Lip color');
    expect(plan.preview.what_it_is).not.toContain('Kylie Jenner Fragrances');
    expect(plan.preview.why_it_stands_out.map((item) => item.headline)).toEqual(expect.arrayContaining([
      'Ingredient list is available',
      'Usage instructions available',
    ]));
    expect(plan.preview.why_it_stands_out.map((item) => item.headline)).not.toContain('Scent profile cues');
    expect(plan.preview.shopping_highlight).toContain('shine finish');
  });

  test('keeps Ole and INNBeauty skincare repairs out of category and sensitive-claim blockers', () => {
    const oleMistPlan = buildPlan(
      row({
        external_product_id: 'ext_ole_glow_mist',
        title: 'Peach Glaze Glow Mist',
        brand: 'Ole Henriksen',
        canonical_url: 'https://olehenriksen.com/products/peach-glaze-glow-mist',
        seed_data: {
          brand: 'Ole Henriksen',
          pdp_description_raw:
            'A face mist for glow, hydration, and a refreshed skincare step.',
          pdp_key_ingredients_raw: 'Vitamin C; Peach extract',
          pdp_how_to_use_raw: 'Mist onto clean skin or over skincare as directed.',
          variants: [{ title: '2.7 oz', options: [{ name: 'Size', value: '2.7 oz' }] }],
        },
      }),
      { brand: 'Ole Henriksen', includeStrong: false },
    );
    const innLipPlan = buildPlan(
      row({
        external_product_id: 'ext_inn_glaze_lip_oil',
        title: 'Glaze Lip Oil',
        brand: 'INNBeauty Project',
        canonical_url: 'https://www.innbeautyproject.com/products/glaze-lip-oil',
        seed_data: {
          brand: 'INNBeauty Project',
          pdp_description_raw:
            'A glossy lip oil with shade clarity and shine finish.',
          pdp_key_ingredients_raw:
            '- Red Root & Jojoba Oil: Soothes and moisturizes dry, chapped lips\n- Fermented Pomegranate: Gently exfoliate\n- Plant-based Plumping Complex: subtly plump lips',
          pdp_how_to_use_raw: 'Apply directly to lips.',
          variants: [{ title: 'Cookie', options: [{ name: 'Shade', value: 'Cookie' }] }],
        },
      }),
      { brand: 'INNBeauty Project', includeStrong: false },
    );
    const innRetinolPlan = buildPlan(
      row({
        external_product_id: 'ext_inn_retinol_remix',
        title: 'Retinol Remix 1% Retinol',
        brand: 'INNBeauty Project',
        canonical_url: 'https://www.innbeautyproject.com/products/retinol-remix',
        seed_data: {
          brand: 'INNBeauty Project',
          pdp_description_raw:
            '1% Vegan Retinol, Peptide, & Tranexamic Acid work to visibly reduce wrinkles & enlarged pores while brightening & smoothing.',
          pdp_ingredients_raw: 'Water, Glycerin, Retinol, Tranexamic Acid, Palmitoyl Tripeptide-5.',
          pdp_how_to_use_raw: 'Apply a pea-sized amount to clean, dry skin.',
        },
      }),
      { brand: 'INNBeauty Project', includeStrong: false },
    );
    const oleScrubPlan = buildPlan(
      row({
        external_product_id: 'ext_ole_lemonade_scrub',
        title: 'Lemonade Smoothing Scrub',
        brand: 'Ole Henriksen',
        canonical_url: 'https://olehenriksen.com/products/lemonade-smoothing-scrub',
        seed_data: {
          brand: 'Ole Henriksen',
          pdp_description_raw:
            'A face scrub with AHA exfoliation for a smoothing routine.',
          pdp_key_ingredients_raw: 'Glycerin; Glycolic acid; Lactic acid',
          pdp_how_to_use_raw: 'HOW TO',
          variants: [{ title: 'Lemonade / 3 oz', options: [{ name: 'Size', value: '3 oz' }] }],
        },
      }),
      { brand: 'Ole Henriksen', includeStrong: false },
    );

    expect(oleMistPlan.blocked).toBe(false);
    expect(oleMistPlan.changed).toBe(true);
    expect(oleMistPlan.preview.headline).toBe('Face mist');
    expect(JSON.stringify(oleMistPlan.preview)).not.toContain('public_category_mismatch');

    expect(innLipPlan.blocked).toBe(false);
    expect(innLipPlan.changed).toBe(true);
    expect(innLipPlan.preview.headline).toBe('Lip treatment');
    expect(JSON.stringify(innLipPlan.preview).toLowerCase()).not.toMatch(/plump|chapped/);

    expect(innRetinolPlan.blocked).toBe(false);
    expect(innRetinolPlan.changed).toBe(true);
    expect(innRetinolPlan.preview.headline).toBe('Treatment serum');
    expect(JSON.stringify(innRetinolPlan.preview).toLowerCase()).not.toMatch(/wrinkles?|pores?/);

    expect(oleScrubPlan.blocked).toBe(false);
    expect(oleScrubPlan.changed).toBe(true);
    expect(oleScrubPlan.preview.headline).toBe('Face scrub');
    expect(JSON.stringify(oleScrubPlan.preview)).not.toContain('HOW TO');
  });

  test('removes public-sensitive ingredient qualifiers from Pixi lip copy', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_pixi_lip',
        title: 'Pixi + Maryam MatteLast Liquid Lip - Siesta Peach | MaryamNYC Limited Edition',
        brand: 'Pixi Beauty',
        canonical_url: 'https://pixibeauty.com/products/mattelast-liquid-lip',
        seed_data: {
          brand: 'Pixi Beauty',
          pdp_description_raw: 'A matte liquid lip color with a named shade.',
          pdp_active_ingredients_raw: 'Rosehip Oil; Vitamin E; Vegan Beeswax nourishes and conditions.',
          pdp_how_to_use_raw: 'Apply to lips.',
          variants: [
            {
              title: 'Siesta Peach | MaryamNYC Limited Edition',
              options: [{ name: 'Shade', value: 'Siesta Peach | MaryamNYC Limited Edition' }],
            },
          ],
        },
      }),
      { productIds: ['ext_pixi_lip'], includeStrong: true },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.changed).toBe(true);
    expect(JSON.stringify(plan.preview)).not.toMatch(/\bvegan\b/i);
  });

  test('uses sample-specific insight copy instead of generic cue copy', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_kylie_sample',
        title: 'Koko K Matte Liquid Lipstick Sample',
        brand: 'Kylie Cosmetics',
        canonical_url: 'https://kyliecosmetics.com/products/koko-k-matte-liquid-lipstick-sample',
        seed_data: {
          brand: 'Kylie Cosmetics',
          pdp_description_raw:
            'Kylie source marks this listing as a sample and excludes it from recommendation merchandising. No product PDP copy is available.',
          pdp_ingredients_raw:
            'Isododecane, Mica, Dicalcium Phosphate, Octyldodecanol, Hydrogenated Styrene/Isoprene Copolymer, Red 7 Lake (CI 15850), Titanium Dioxide (CI 77891).',
          pdp_how_to_use_raw: 'using the doe foot applicator, define and coat lips with an even layer.',
          variants: [
            {
              title: '0.03 fl oz',
              options: [{ name: 'Size', value: '0.03 fl oz' }],
            },
          ],
        },
        product_key: 'pk_kylie_sample',
        pivota_signature_id: 'sig_kylie_sample',
      }),
      { brand: 'Kylie Cosmetics', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Lip color');
    expect(plan.preview.what_it_is).not.toContain('excludes it from recommendation merchandising');
    expect(JSON.stringify(plan.preview)).not.toContain('product data');
    expect(plan.preview.why_it_stands_out.map((item) => item.headline)).toEqual(expect.arrayContaining([
      'Sample format is explicit',
      'Ingredient list is available',
      'Usage instructions available',
    ]));
    expect(plan.preview.why_it_stands_out.map((item) => item.headline)).not.toContain('Concrete product cues');
    expect(plan.preview.shopping_highlight).not.toContain('shade range');
  });

  test('keeps decimal sample sizes intact in reviewed sample insight copy', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_kylie_sample_decimal',
        title: 'Koko K Matte Liquid Lipstick Sample',
        brand: 'Kylie Cosmetics',
        canonical_url: 'https://kyliecosmetics.com/products/koko-k-matte-liquid-lipstick-sample',
        seed_data: {
          brand: 'Kylie Cosmetics',
          pdp_description_raw:
            'Koko K Matte Liquid Lipstick Sample is a 0.03 fl oz sample of the Kylie Matte Liquid Lipstick formula. The product-line PDP describes the formula as comfortable, smudge-resistant matte lip color.',
          pdp_ingredients_raw:
            'Isododecane, Mica, Dicalcium Phosphate, Octyldodecanol, Hydrogenated Styrene/Isoprene Copolymer, Red 7 Lake (CI 15850), Titanium Dioxide (CI 77891).',
          pdp_how_to_use_raw: 'using the doe foot applicator, define and coat lips with an even layer.',
          variants: [
            {
              title: '0.03 fl oz',
              options: [{ name: 'Size', value: '0.03 fl oz' }],
            },
          ],
        },
        product_key: 'pk_kylie_sample_decimal',
        pivota_signature_id: 'sig_kylie_sample_decimal',
      }),
      { brand: 'Kylie Cosmetics', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.what_it_is).toContain('0.03 fl oz sample');
    expect(plan.preview.what_it_is).not.toBe('Koko K Matte Liquid Lipstick Sample is a 0.');
    expect(JSON.stringify(plan.preview)).not.toContain('product data');
  });

  test('blocks Fenty bronzer candidates when source copy is actually blush copy', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_bronzer_bad_copy',
        title: 'Cheeks Out Freestyle Cream Bronzer — Amber',
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/cheeks-out-freestyle-cream-bronzer-amber',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            'A light-as-air, non-greasy cream blush that instantly melts into skin for an effortless wash of color, giving life to all skin tones.',
          pdp_ingredients_raw: 'Water, Mica, Dimethicone, Silica, Phenoxyethanol.',
          pdp_how_to_use_raw: 'Apply with fingertips or a face brush.',
          variants: [{ title: 'Amber', options: [{ name: 'Shade', value: 'Amber' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(true);
    expect(plan.skip_reason).toBe('candidate_failed_manual_quality_gate:source_role_mismatch_bronzer_blush');
  });

  test('blocks generic Fenty brand-story copy before it can publish', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_brand_story',
        title: 'Hydra Vizor Huez Tinted Moisturizer Broad Spectrum Mineral SPF 30 Sunscreen Refill (EU) — 10',
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/hydra-vizor-huez-tinted-moisturizer-refill-intl-10',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            'Rihanna was inspired to create the world of Fenty Beauty brands after years of partnering with the best of the best in the beauty industry - and still seeing a void.',
          pdp_active_ingredients_raw: 'Zinc Oxide 15.5%',
          pdp_how_to_use_raw: 'Apply generously as the last step of your morning skincare routine before sun exposure.',
          variants: [{ title: '10', options: [{ name: 'Shade', value: '10' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(true);
    expect(plan.skip_reason).toBe('candidate_failed_manual_quality_gate:brand_story_instead_of_product_copy');
  });

  test('blocks variant-only intros when no useful product copy exists', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_variant_only',
        title: 'Hydra Vizor Huez Tinted Moisturizer Broad Spectrum Mineral SPF 30 Sunscreen Refill (EU) — 10',
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/hydra-vizor-huez-tinted-moisturizer-refill-intl-10',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_active_ingredients_raw: 'Zinc Oxide 15.5%',
          variants: [{ title: '10', options: [{ name: 'Shade', value: '10' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(true);
    expect(plan.skip_reason).toBe('candidate_failed_manual_quality_gate:variant_only_intro_without_product_copy');
  });

  test('does not treat multi-size lip luminizer variants as samples', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_lip_luminizer',
        title: 'Gloss Bomb Universal Lip Luminizer — Glass Slipper',
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/gloss-bomb-universal-lip-luminizer-glass-slipper',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            'Rihanna’s award-winning Gloss Bomb Universal Lip Luminizer is a lip gloss with explosive shine.',
          pdp_ingredients_raw: 'Polybutene, Octyldodecanol, Butyrospermum Parkii (Shea) Butter, Silica, Flavor/Aroma.',
          pdp_how_to_use_raw: 'Wear alone or layer over lipstick as a finishing touch.',
          variants: [
            {
              title: 'Glass Slipper / Standard',
              options: [{ name: 'Shade', value: 'Glass Slipper' }, { name: 'Size', value: 'Standard' }],
            },
            {
              title: 'Glass Slipper / Mini',
              options: [{ name: 'Shade', value: 'Glass Slipper' }, { name: 'Size', value: 'Mini' }],
            },
          ],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Lip color');
    expect(plan.preview.why_it_stands_out.map((item) => item.headline)).not.toContain('Sample format is explicit');
  });

  test('rewrites Fenty lip liner insights without marketing intro copy', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_lip_liner',
        title: "Trace'd Out Longwear Waterproof Pencil Lip Liner — Rose Amber",
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/traced-out-longwear-waterproof-pencil-lip-liner-amber-rose',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            "Finally - your ultimate lip liner has arrived. This longwear, creamy pencil is made with pure pigments. Lasts up to 8 hours and resists transfer, feathering and fading. Velvet-matte finish made with pure pigments.",
          pdp_ingredients_raw:
            'Dimethicone, Silica, Trimethylsiloxysilicate, Polyisobutene, Polyethylene, Ozokerite, Synthetic Fluorphlogopite, Disteardimonium Hectorite, Propylene Carbonate.',
          pdp_how_to_use_raw:
            'Trace the outline of your lips with the precision tip. Lay the liner on its side to fill in your lips. Press your lips together to set in place.',
          variants: [
            {
              title: 'Rose Amber',
              options: [{ name: 'Shade', value: 'Rose Amber' }],
            },
          ],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Lip liner');
    expect(plan.preview.what_it_is).toContain('long-wear lip definition');
    expect(plan.preview.what_it_is).toContain('This SKU is Rose Amber');
    expect(plan.preview.what_it_is).not.toContain('Finally');
    expect(plan.preview.why_it_stands_out.map((item) => item.headline)).toEqual(expect.arrayContaining([
      'Wear claims are specific',
      'Application sequence is explicit',
      'Formula disclosure is available',
    ]));
    expect(plan.preview.why_it_stands_out.map((item) => item.headline)).not.toContain('Concrete product cues');
  });

  test('keeps Fenty Hair treatment duos out of fragrance classification', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_hair_duo',
        title: 'The Hydrated + Hot Ones Leave-in Conditioner + Heat Protectant Duo',
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/leave-in-conditioner-heat-protectant-duo',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            'The ultimate hydration + heat protection duo. Fenty Hair leave-in conditioner and heat protectant are made for styling prep, frizz control, and hair hydration.',
          pdp_active_ingredients_raw: 'Hyaluronic acid, amino acids.',
          pdp_how_to_use_raw: 'Apply leave-in conditioner to damp or dry hair, then use heat protectant before hot tools.',
          variants: [{ title: 'Duo', options: [{ name: 'Set', value: 'Duo' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Hair treatment');
    expect(plan.preview.what_it_is).not.toContain('Fine fragrance');
    expect(plan.preview.shopping_highlight).toContain('frizz control');
  });

  test('keeps Fenty Brow MVP styler in brow definition instead of hair care', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_brow_mvp',
        title: 'Brow MVP Ultra Fine Brow Pencil & Styler — Ash Brown',
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/brow-mvp-ultra-fine-brow-pencil-styler-ash-brown',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            'A waterproof ultra-fine brow pencil and built-in paddle brush styler for shaping, defining, and filling brows with precision.',
          pdp_ingredients_raw:
            'Synthetic Wax, Ceresin, Hydrogenated Coco-Glycerides, Mica, Hydrogenated Castor Oil, Polybutene, Cera Microcristallina, Tocopherol, Iron Oxides.',
          pdp_how_to_use_raw:
            'Use the ultra-fine pencil tip to draw hair-like strokes, then blend and shape brows with the attached paddle brush.',
          variants: [{ title: 'Ash Brown', options: [{ name: 'Shade', value: 'Ash Brown' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Brow product');
    expect(plan.preview.what_it_is).toContain('brow product');
    expect(plan.preview.shopping_highlight).toContain('brow definition');
    expect(plan.preview.what_it_is).not.toContain('hair treatment');
    expect(plan.preview.shopping_highlight).not.toContain('scalp');
    expect(plan.preview.shopping_highlight).not.toContain('style refresh');
  });

  test('lets explicit Fenty eyeliner title override stale toner category metadata', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_flypencil_bachelor_pad',
        title: 'Flypencil Longwear Pencil Eyeliner — Bachelor Pad',
        brand: 'FENTY BEAUTY',
        product_type: 'Toner',
        category_path: 'beauty/skincare/toner',
        canonical_url: 'https://fentybeauty.com/products/flypencil-longwear-pencil-eyeliner-bachelor-pad',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            'A creamy, water-resistant pencil eyeliner made for longwear color that glides on and sets in place.',
          pdp_ingredients_raw:
            'Synthetic Wax, Mica, Trimethylsiloxysilicate, Polybutene, Hydrogenated Cottonseed Oil, Silica, Tocopherol, Iron Oxides.',
          pdp_how_to_use_raw:
            'Glide along the lash line, then blend quickly before the liner sets.',
          variants: [{ title: 'Bachelor Pad', options: [{ name: 'Shade', value: 'Bachelor Pad' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Eye makeup');
    expect(plan.preview.what_it_is).toContain('eye makeup');
    expect(plan.preview.what_it_is).not.toContain('face toner');
    expect(plan.preview.shopping_highlight).not.toContain('toning step');
  });

  test('keeps Fenty BHA toner out of fragrance classification when INCI contains fragrance', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_cherry_dub_toner',
        title: 'Cherry Dub BHA Toner with Salicylic Acid + Aloe Juice',
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/cherry-dub-bha-toner-with-salicylic-acid-aloe-juice',
        category_path: 'beauty/skincare/toner',
        product_type: 'Toner',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            'A pore-purifying BHA toner with salicylic acid and aloe juice for a clearer-looking, smoother-feeling skin routine.',
          pdp_active_ingredients_raw: 'Salicylic acid and aloe juice.',
          pdp_ingredients_raw:
            'Water, Salicylic Acid, Aloe Barbadensis Leaf Juice, Glycerin, Fragrance, Sodium Hydroxide.',
          pdp_how_to_use_raw:
            'After cleansing, apply with a cotton pad or hands. Start two to three times weekly and increase as skin tolerates.',
          variants: [{ title: '150 mL', options: [{ name: 'Size', value: '150 mL' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Exfoliating toner');
    expect(plan.preview.what_it_is).toContain('exfoliating toner');
    expect(plan.preview.what_it_is).not.toContain('Fine fragrance');
    expect(plan.preview.shopping_highlight).toContain('BHA');
    expect(plan.preview.best_for.map((item) => item.tag)).toContain('exfoliating_toner_step');
  });

  test('uses bronzer and contour cues for corrected Fenty cream bronzer rows', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_cream_bronzer_amber',
        title: 'Cheeks Out Freestyle Cream Bronzer — Amber',
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/cheeks-out-freestyle-cream-bronzer-amber',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            'Cheeks Out Freestyle Cream Bronzer in Amber is a cream bronzer for warming, defining, or contouring the face, with a blendable cream texture and shade-specific bronze/contour role.',
          pdp_ingredients_raw:
            'Amber: Octyldodecanol, Isononyl Isononanoate, Caprylic/Capric Triglyceride, Synthetic Wax, Mica, Silica Silylate, Iron Oxides.',
          pdp_how_to_use_raw:
            'Use fingertips or a face shaping brush to apply where the sun naturally hits your face. Layer to build pigment or apply to hollows for soft contour.',
          variants: [{ title: 'Amber', options: [{ name: 'Shade', value: 'Amber' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Face color makeup');
    expect(plan.preview.what_it_is).toContain('bronzing or contour definition');
    expect(plan.preview.shopping_highlight).toContain('bronzing/contour role');
    expect(plan.preview.what_it_is).not.toContain('glow payoff');
  });

  test('writes specific copy for Fenty dry shampoo powder', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_dry_shampoo',
        title: 'The Imposter Invisi-Boost Volumizing Dry Shampoo Powder',
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/the-imposter-invisi-boost-volumizing-dry-shampoo',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            'A non-aerosol dry shampoo that stretches washdays, instantly boosts volume + texture and absorbs excess oil without a white cast.',
          pdp_ingredients_raw:
            'Zea Mays (Corn) Starch, Maranta Arundinacea Root Extract, Tapioca Starch, Aqua, Silica, Silica Silylate, Glycerin, Oryza Sativa (Rice) Starch, Panthenol.',
          pdp_how_to_use_raw:
            'Before applying, gently shake the bottle. Hold 6 inches from roots, puff onto oily areas, wait a few seconds, then massage or brush through.',
          variants: [{ title: 'Standard', options: [{ name: 'Size', value: 'Standard bottle' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Dry shampoo powder');
    expect(plan.preview.what_it_is).toContain('dry shampoo powder');
    expect(plan.preview.what_it_is).toContain('non-aerosol format');
    expect(plan.preview.what_it_is).toContain('excess-oil absorption');
    expect(plan.preview.what_it_is).toContain('volume-texture boost');
    expect(plan.preview.what_it_is).not.toContain('hair-care item');
  });

  test('uses face-cleanser language for Fenty Total Cleansr sample', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_total_cleansr_sample',
        title: "Total Cleans'r Remove-It-All Cleanser Deluxe Sample",
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/total-cleansr-deluxe-sample',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            "Get that fresh, clean feeling with a plush creamy cleanser that refines the look of pores and washes away dirt, oil and impurities without leaving skin feeling tight.",
          pdp_ingredients_raw:
            'Aqua/Water/Eau, Sodium Cocoyl Glycinate, Glycerin, Acrylates Copolymer, Malpighia Glabra (Acerola) Fruit Extract, Ginkgo Biloba Leaf Extract, Cocos Nucifera (Coconut) Acid, Phenoxyethanol.',
          pdp_how_to_use_raw:
            'Use day and night. Wet skin, lather, rinse, pat dry. Avoid eye area.',
          variants: [{ title: 'Deluxe sample', options: [{ name: 'Size', value: 'Deluxe sample' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Face cleanser');
    expect(plan.preview.what_it_is).toContain('face cleanser');
    expect(plan.preview.what_it_is).toContain('dirt, oil, and impurity removal');
    expect(plan.preview.what_it_is).not.toContain('toning');
    expect(plan.preview.shopping_highlight).not.toContain('shine finish');
    expect(plan.preview.shopping_highlight).toContain('daily cleansing');
    expect(plan.preview.best_for.map((item) => item.tag)).toEqual(
      expect.arrayContaining(['daily_cleansing', 'pore_cleansing']),
    );
    expect(plan.preview.best_for.map((item) => item.tag)).not.toContain('shine_finish');
  });

  test('does not use opening quotes as what-it-is for Fenty fragrance samples', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_edp_sample',
        title: 'Fenty Eau de Parfum Sample Vial on Card',
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/fenty-eau-de-parfum-sample-vial-on-card',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            '"This exudes everything I feel." SCENT TYPE Warm Floral. KEY NOTES Magnolia, Musk, Tangerine, Bulgarian Rose. THE SCENT A deeply intimate fragrance that is complex, vibrant, raw, spicy and sweet.',
          pdp_ingredients_raw:
            'Alcohol, Parfum, Fragrance, Aqua, Limonene, Citronellol, Linalool, Geraniol, Benzyl Alcohol, Eugenol.',
          pdp_how_to_use_raw:
            'Spritz on pulse points, such as wrists, neck, and behind ears.',
          variants: [{ title: 'Sample vial', options: [{ name: 'Format', value: 'Sample vial' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Fine fragrance');
    expect(plan.preview.what_it_is).toContain('fine fragrance');
    expect(plan.preview.what_it_is).toContain('rose');
    expect(plan.preview.what_it_is).not.toMatch(/^"/);
    expect(plan.preview.what_it_is).not.toContain('This exudes');
  });

  test('does not treat ampersand shade names as lip combos', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_slip_shine',
        title: 'Slip Shine Sheer Shiny Lipstick — Cookies & Cocoa',
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/slip-shine-cookies-cocoa',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw:
            'An ultra comfortable sheer lipstick with nourishing color and shine in universal, easy-to-wear shades.',
          pdp_ingredients_raw:
            'Polybutene, Octyldodecanol, Synthetic Wax, Shea Butter, Squalane, Silica, Titanium Dioxide (CI 77891).',
          pdp_how_to_use_raw: 'Apply directly to lips for sheer color and shine.',
          variants: [{ title: 'Cookies & Cocoa', options: [{ name: 'Shade', value: 'Cookies & Cocoa' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Lip color');
    expect(plan.preview.what_it_is).not.toContain('lip set');
    expect(plan.preview.why_it_stands_out.map((item) => item.headline)).not.toContain('Component pairing is clear');
  });

  test('keeps formula sets with an included case in the formula category', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_sunscreen_case_set',
        title: "Arcane Hydra Vizor Mystery Box Moisturizer Sunscreen + Collector's Case, Mineral SPF",
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/arcane-hydra-vizor-set-mineral-spf-eu',
        seed_data: {
          brand: 'FENTY BEAUTY',
          pdp_description_raw: 'Shield your skin and defend your glow with an Arcane-inspired Hydra Vizor mineral SPF set.',
          pdp_ingredients_raw: 'Water, Zinc Oxide, Glycerin, Niacinamide, Butyrospermum Parkii (Shea) Butter.',
          pdp_how_to_use_raw: 'Apply generously as the last step of your morning skincare routine before sun exposure.',
          variants: [{ title: 'Set', options: [{ name: 'Format', value: 'Set' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Daily sunscreen');
    expect(plan.preview.what_it_is).not.toContain('beauty accessory');
  });

  test('blocks generic accessory insight copy when source evidence is too thin', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_fenty_mesh_tote',
        title: 'Fenty Beauty Mesh Tote',
        brand: 'FENTY BEAUTY',
        canonical_url: 'https://fentybeauty.com/products/fenty-beauty-mesh-tote',
        seed_data: {
          brand: 'FENTY BEAUTY',
          variants: [{ title: '6.7 oz', options: [{ name: 'Size', value: '6.7 oz' }] }],
        },
      }),
      { brand: 'Fenty Beauty', includeStrong: false },
    );

    expect(plan.blocked).toBe(true);
    expect(plan.skip_reason).toBe('candidate_failed_manual_quality_gate:generic_accessory_copy');
  });

  test('keeps Kylie fragrance tray insights in accessory language', () => {
    const plan = buildPlan(
      row({
        external_product_id: 'ext_kylie_tray',
        title: 'Cosmic Tray',
        brand: 'Kylie Cosmetics',
        canonical_url: 'https://kyliecosmetics.com/products/cosmic-by-kylie-jenner-eau-de-parfum-fragrance-tray',
        seed_data: {
          brand: 'Kylie Cosmetics',
          product_family: 'accessory',
          product_type: 'Fragrance accessory',
          pdp_description_raw:
            'Cosmic Tray is a non-formula fragrance tray accessory for the Cosmic by Kylie Jenner Eau de Parfum line, meant to sit alongside fragrance items rather than act as a fragrance formula.',
          pdp_how_to_use_raw:
            'This is a non-formula fragrance tray accessory, so it does not have fragrance application directions. Use it as a tray accessory for the Cosmic by Kylie Jenner fragrance line.',
          pdp_details_sections: [
            {
              heading: 'Accessory status',
              body: 'Cosmic Tray is a fragrance tray accessory, not a fragrance, skincare, or makeup formula.',
            },
          ],
          variants: [
            {
              title: 'Fragrance tray accessory',
              options: [{ name: 'Item', value: 'Fragrance tray accessory' }],
            },
          ],
        },
        product_key: 'pk_kylie_tray',
        pivota_signature_id: 'sig_kylie_tray',
      }),
      { brand: 'Kylie Cosmetics', includeStrong: false },
    );

    expect(plan.blocked).toBe(false);
    expect(plan.preview.headline).toBe('Beauty accessory');
    expect(plan.preview.shopping_highlight).toBe('fragrance display');
    expect(plan.preview.what_it_is).toContain('non-formula fragrance tray accessory');
    expect(plan.preview.why_it_stands_out.map((item) => item.headline)).toContain('Accessory format is explicit');
    expect(plan.preview.why_it_stands_out.map((item) => item.headline)).not.toContain('Shade and size are explicit');
    expect(JSON.stringify(plan.preview)).not.toContain('makeup organization');
  });

  test('treats previous generic reviewed bundles as weak and replaceable', () => {
    expect(isWeakExistingInsight(kbEntry(weakBundle()))).toBe(true);

    const plan = buildPlan(
      row({
        ext_kb_key: 'product:ext_tf_lip',
        ext_analysis: { product_intel_v1: weakBundle() },
        ext_source: 'aurora_product_intel_kb',
        ext_source_meta: { quality_state: 'reviewed' },
      }),
      { brand: 'tom ford', includeStrong: false },
    );

    expect(plan.changed).toBe(true);
    expect(plan.writes.some((write) => write.action === 'update')).toBe(true);
    expect(plan.writes.find((write) => write.action === 'update').existing_weak).toBe(true);
  });

  test('treats legacy Concrete product cues bundles as weak even when reviewed', () => {
    const legacyConcrete = strongBundle();
    legacyConcrete.product_intel_core.why_it_stands_out[0] = {
      headline: 'Concrete product cues',
      body: 'Cues such as hyaluronic acid, niacinamide, SPF, refillable format give shoppers specific comparison points within Fenty Beauty, instead of relying on generic category copy.',
    };

    expect(isWeakExistingInsight(kbEntry(legacyConcrete))).toBe(true);

    const plan = buildPlan(
      row({
        ext_kb_key: 'product:ext_tf_lip',
        ext_analysis: { product_intel_v1: legacyConcrete },
        ext_source: 'aurora_product_intel_kb',
        ext_source_meta: { quality_state: 'reviewed' },
      }),
      { brand: 'tom ford', includeStrong: false },
    );

    const extWrite = plan.writes.find((write) => write.kb_key === 'product:ext_tf_lip');
    expect(extWrite.action).toBe('update');
    expect(extWrite.existing_weak).toBe(true);
  });

  test('protects strong existing reviewed content by default', () => {
    expect(isWeakExistingInsight(kbEntry(strongBundle()))).toBe(false);

    const plan = buildPlan(
      row({
        ext_kb_key: 'product:ext_tf_lip',
        ext_analysis: { product_intel_v1: strongBundle() },
        ext_source: 'aurora_product_intel_kb',
        ext_source_meta: { quality_state: 'reviewed' },
      }),
      { brand: 'tom ford', includeStrong: false },
    );

    expect(plan.changed).toBe(true);
    const extWrite = plan.writes.find((write) => write.kb_key === 'product:ext_tf_lip');
    expect(extWrite.action).toBe('skip');
    expect(extWrite.reason).toBe('protected_high_quality_existing:reviewed');
    const sigWrite = plan.writes.find((write) => write.kb_key === 'product:sig_tf_lip');
    expect(sigWrite.action).toBe('insert');
  });

  test('protects community-supported existing content even when the legacy weak detector fires', () => {
    const communityBundle = weakBundle();
    communityBundle.evidence_profile = 'community_supported';
    communityBundle.product_intel_core.evidence_profile = 'community_supported';

    expect(isWeakExistingInsight(kbEntry(communityBundle))).toBe(true);

    const plan = buildPlan(
      row({
        ext_kb_key: 'product:ext_tf_lip',
        ext_analysis: { product_intel_v1: communityBundle },
        ext_source: 'aurora_product_intel_kb',
        ext_source_meta: { quality_state: 'reviewed', evidence_profile: 'community_supported' },
      }),
      { brand: 'tom ford', includeStrong: false },
    );

    const extWrite = plan.writes.find((write) => write.kb_key === 'product:ext_tf_lip');
    expect(extWrite.action).toBe('skip');
    expect(extWrite.reason).toBe('protected_evidence_profile_existing:community_supported');
    const sigWrite = plan.writes.find((write) => write.kb_key === 'product:sig_tf_lip');
    expect(sigWrite.action).toBe('insert');
  });

  test('can explicitly repair stale url-key insight rows without enabling it by default', () => {
    const staleUrlRow = row({
      url_kb_key: 'url:https://www.tomfordbeauty.com/product/lip-color',
      url_analysis: { product_intel_v1: weakBundle() },
      url_source: 'pivota_manual_reviewed_seller_only_v1',
      url_source_meta: { quality_state: 'eligible' },
    });

    const defaultPlan = buildPlan(staleUrlRow, { brand: 'tom ford', includeStrong: false });
    expect(defaultPlan.writes.some((write) => write.kb_key.startsWith('url:'))).toBe(false);

    const urlPlan = buildPlan(staleUrlRow, { brand: 'tom ford', includeStrong: false, includeUrlKey: true });
    const urlWrite = urlPlan.writes.find((write) => write.kb_key === 'url:https://www.tomfordbeauty.com/product/lip-color');
    expect(urlWrite.action).toBe('update');
    expect(urlWrite.existing_weak).toBe(true);
  });

  test('does not treat polluted legacy raw ingredient text as INCI evidence', () => {
    const serumRow = row({
      external_product_id: 'ext_guerlain_serum',
      title: 'Abeille Royale Youth Watery Oil Serum',
      brand: 'GUERLAIN',
      seed_data: {
        brand: 'GUERLAIN',
        pdp_description_raw: 'A serum that draws on honey and royal jelly cues for a skin-repair routine step.',
        raw_ingredient_text_clean: '$62.00\n4.8\n(273)',
        pdp_how_to_use_raw: 'Apply morning and evening before cream.',
        variants: [{ title: '30 ml', options: [{ name: 'Size', value: '30 ml' }] }],
      },
    });

    const facts = readSeedFacts(serumRow);
    expect(facts.rawIngredients).toEqual([]);
    expect(inferRole(facts).label).toBe('Treatment serum');

    const bundle = buildInsightBundle(serumRow);
    expect(bundle.evidence_profile).toBe('official_pdp_reviewed_line');
    expect(bundle.product_intel_core.why_it_stands_out.map((item) => item.headline)).not.toContain('Ingredient list is available');
  });
});
