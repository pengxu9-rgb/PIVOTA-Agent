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
