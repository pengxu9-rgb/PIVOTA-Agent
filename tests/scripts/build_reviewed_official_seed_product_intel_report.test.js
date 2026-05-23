jest.mock('../../src/db', () => ({
  closePool: jest.fn(async () => {}),
  query: jest.fn(async () => ({ rows: [] })),
}));

jest.mock('../../scripts/publish_product_intel_pilot_to_kb', () => ({
  buildKbEntriesForRow: jest.fn(() => []),
  fetchExistingProductIntelKbRows: jest.fn(async () => new Map()),
  prepareEntriesForWrite: jest.fn(() => ({ blockedEntries: [] })),
}));

const {
  _internals: {
    brandFromUrl,
    buildBundle,
    inferKind,
    isConservativeRewriteCandidate,
    sanitizeFormulaSummary,
    sanitizePublicSourceText,
    sanitizePublicTitleText,
    selectInventoryRows,
  },
} = require('../../scripts/build-reviewed-official-seed-product-intel-report.cjs');

describe('build-reviewed-official-seed-product-intel-report', () => {
  test('keeps Pixi roll-on eye serum out of fragrance and brush buckets', () => {
    expect(
      inferKind(
        'Roll-On AntioxifEYE Serum Original Size',
        '',
        '',
        'Eye-surround serum with an applicator. Full Ingredient List includes Fragrance.',
      ),
    ).toBe('eye_treatment');
  });

  test('classifies reviewed Pixi set and patch patterns by title before component copy', () => {
    expect(inferKind('On-the-Glow Bronze Collection', '', '', 'Hydrating balm bronzers with fruit extracts.')).toBe(
      'makeup_set',
    );
    expect(inferKind('DetoxifEYE Patches Travel Size Set of 5', '', '', 'Hydrogel eye patches.')).toBe(
      'eye_care_set',
    );
    expect(inferKind('Vitamin-C LipPatch (Set of 3)', '', '', 'Hydrogel lip patches.')).toBe('lip_set');
    expect(inferKind('Choose Your +Hydra LipTreat Trio', '', '', 'Lip treatment trio.')).toBe('lip_set');
    expect(inferKind('Blur, Colour & Set', '', '', 'Complexion base, colour, and setting products.')).toBe(
      'makeup_set',
    );
    expect(inferKind('Pixi + Maryam Maquillage GRWM Routine', '', '', 'Foundation and eye makeup routine.')).toBe(
      'makeup_set',
    );
  });

  test('classifies Pixi spot and treatment formats without generic Beauty Product fallback', () => {
    expect(inferKind('Overnight Spot Stickers', '', '', 'Blemish spot stickers for targeted use.')).toBe(
      'blemish_patch',
    );
    expect(inferKind('Overnight Retinol Oil', '', '', 'Retinol oil for smoother-looking skin.')).toBe('skincare');
  });

  test('keeps Beekman cleansers, soaps, and body care out of powder/generic buckets', () => {
    expect(
      inferKind(
        'Mini Oil Eliminating Foaming Gel Cleanser',
        '',
        '',
        'Controls sebum with kaolin powder listed in formula detail.',
      ),
    ).toBe('cleanser');
    expect(inferKind('Lilac Dream Hand & Body Wash', '', '', 'Goat milk body wash.')).toBe('body_wash');
    expect(inferKind('Vanilla Absolute Goat Milk Soap', '', '', 'Goat milk bar soap.')).toBe('cleanser');
    expect(inferKind('Honeyed Grapefruit Hand Salve', '', '', 'Goat milk salve for dry hands.')).toBe('skincare');
    expect(inferKind('Candy Cane Whipped Body Cream', '', '', 'Whipped body cream with cocoa powder.')).toBe(
      'moisturizer',
    );
    expect(inferKind('Herbal Hair Mask Probiotics', 'Hair Mask', '', 'Probiotic hair treatment.')).toBe(
      'hair_mask',
    );
    expect(inferKind('Firming & Polishing Body Scrub Sea Salt', 'Exfoliant', '', 'Body scrub.')).toBe(
      'body_scrub',
    );
    expect(
      inferKind(
        'Firming & Toning Body Cream Pineapple & Retinol',
        'Body Cream',
        '',
        'Body cream page with related body wash recommendations.',
      ),
    ).toBe('moisturizer');
  });

  test('prioritizes Wave3 hair and scalp title signals over stale skin or makeup categories', () => {
    expect(
      inferKind(
        'BLOOMING ROOTS Botanical Scalp Treatment Oil',
        'Foundation',
        '',
        'Healthy, vibrant hair begins where it grows, at the roots.',
      ),
    ).toBe('scalp_oil');
    expect(
      inferKind(
        'Exploration 02 Ampoule Hydrating Conditioner',
        'Skincare',
        '',
        'Active conditioner, reimagined. A waterless hair conditioning concentrate.',
      ),
    ).toBe('conditioner');
    expect(
      inferKind(
        'Exploration 01 Ampoule Repair Shampoo',
        'Skincare',
        '',
        'Active shampoo, reimagined. A waterless hair cleanse concentrate.',
      ),
    ).toBe('shampoo');
    expect(inferKind('Lucid Leave-In Conditioning Hair Milk', 'Skincare', '', 'Leave-in conditioner.')).toBe(
      'leave_in_conditioner',
    );
    expect(inferKind('Renaissance Nourishing Pre-Wash Hair Oil', 'Beauty Product', '', 'Hair oil.')).toBe(
      'hair_oil',
    );
    expect(
      inferKind(
        'Antarctic ACV Hair Shine Glass Rinse for pH Balance',
        'Beauty Product',
        '',
        'Apple Cider Vinegar rinse for hair.',
      ),
    ).toBe('hair_rinse');
    expect(
      inferKind(
        'Atmosphere Multi-Peptide Hair Density & Scalp Serum',
        'Skincare Treatment',
        '',
        'Scalp serum for hair density concerns.',
      ),
    ).toBe('scalp_serum');

    const bundle = buildBundle({
      seed: {
        external_product_id: 'ext_luna_scalp',
        title: 'Atmosphere Multi-Peptide Hair Density & Scalp Serum',
        canonical_url: 'https://lunanectar.com/products/atmosphere-hair-density-scalp-serum',
        seed_data: {
          brand: 'Luna Nectar',
          category: 'Skincare Treatment',
          description: 'Thinning hair density or excessive shedding?',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_luna_scalp',
        sellable_item_group_id: 'sig_luna_scalp',
      },
      generatedAt: '2026-05-23T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(bundle.shopping_card.subtitle).toBe('Scalp Serum');
    expect(bundle.shopping_card.highlight).toBe('Scalp serum format detail');
    expect(bundle.product_intel_core.what_it_is.body).toContain('A Luna Nectar scalp serum');
    expect(JSON.stringify(bundle)).not.toMatch(/skincare treatment listed|excessive shedding/i);
  });

  test('softens Wave3 public source copy before it enters Product Intel fields', () => {
    expect(
      sanitizePublicSourceText(
        'Our phytoactive house formula offers long-lasting moisture and relief of inflammatory skin conditions.',
      ),
    ).toBe('Our phytoactive house formula offers long-lasting moisture and calming skin-comfort positioning.');
    expect(
      sanitizePublicSourceText(
        'Key benefits: By choosing this Calming Adaptogenic Facial Emulsion you help plant 1 m2 of biodiverse forest.',
      ),
    ).toBe('Key benefits: Calming Adaptogenic Facial Emulsion.');
    expect(
      sanitizePublicSourceText(
        'Fragrance-free, creamy texture is suitable for all skin types, including sensitive skin.',
      ),
    ).toBe(
      'Fragrance-free, creamy texture is positioned by the official page for broad routine use, including sensitive skin.',
    );
    expect(
      sanitizePublicSourceText('Designed to reduce redness, tackle dark spots and target age spots.'),
    ).toBe(
      'Designed to support the look of calmer skin and address the look of uneven tone.',
    );

    const forestBundle = buildBundle({
      seed: {
        external_product_id: 'ext_oio_forest',
        title: 'The Forest Retreat',
        canonical_url: 'https://us.oiolab.co/products/the-forest-retreat',
        seed_data: {
          brand: 'Oio Lab',
          category: 'Skincare',
          description:
            'Key benefits: By choosing this Calming Adaptogenic Facial Emulsion you help plant 1 m2 of biodiverse forest.',
          ingredient_tokens: ['Aqua / Water, Linum Usitatissimum Seed Oil, Glycerin, Isomalt'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_oio_forest',
        sellable_item_group_id: 'sig_oio_forest',
      },
      generatedAt: '2026-05-23T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(forestBundle.product_intel_core.what_it_is.body).toContain(
      'Key benefits: Calming Adaptogenic Facial Emulsion.',
    );
    expect(JSON.stringify(forestBundle)).not.toMatch(/plant 1 m2|biodiverse forest/i);
  });

  test('uses non-workout highlights unless the product is explicitly workout positioned', () => {
    expect(
      buildBundle({
        seed: {
          external_product_id: 'ext_nala_deodorant',
          title: 'Coastal Waters, Extra Strength Natural Deodorant',
          canonical_url: 'https://nalacare.com/products/coastal-waters-extra-strength-natural-deodorant',
          seed_data: {
            brand: 'Nala Care',
            category: 'Deodorant',
            description: 'A natural deodorant with coastal scent positioning.',
          },
        },
        inventoryRow: {
          external_product_id: 'ext_nala_deodorant',
          sellable_item_group_id: 'sig_nala_deodorant',
        },
        generatedAt: '2026-05-23T00:00:00.000Z',
        batchName: 'test_batch',
        reviewer: 'codex_test',
      }).shopping_card.highlight,
    ).toBe('Extra-strength deodorant');
    expect(
      buildBundle({
        seed: {
          external_product_id: 'ext_moss_deodorant',
          title: 'After Workout Deodorant',
          canonical_url: 'https://mossnoor.com/products/after-workout-deodorant',
          seed_data: {
            brand: 'Moss & Noor',
            category: 'Deodorant',
            description: 'After Workout Deodorant is developed for active lifestyles.',
          },
        },
        inventoryRow: {
          external_product_id: 'ext_moss_deodorant',
          sellable_item_group_id: 'sig_moss_deodorant',
        },
        generatedAt: '2026-05-23T00:00:00.000Z',
        batchName: 'test_batch',
        reviewer: 'codex_test',
      }).shopping_card.highlight,
    ).toBe('Post-workout deodorant');
  });

  test('classifies Pixi complexion, lip, and treatment formats without generic fallback', () => {
    expect(
      inferKind(
        'Flawless & Poreless',
        '',
        '',
        'Miracle-in-a-tube primer that visibly blurs pores and controls shine.',
      ),
    ).toBe('primer');
    expect(
      inferKind(
        'H2O SkinVeil',
        '',
        '',
        'Weightless, hydrating loose water-powder that blurs complexion while setting makeup.',
      ),
    ).toBe('face_powder');
    expect(inferKind('Botanical Collagen LipGloss', '', '', 'Lip treatment formulated to volumize lips.')).toBe(
      'lip',
    );
    expect(
      inferKind(
        'Milky Remedy Mask',
        '',
        '',
        'A soothing jelly mask enriched with Coconut, Oat Extract, Chamomile and Sea Buckthorn.',
      ),
    ).toBe('skincare');
    expect(inferKind('LipMask', '', '', 'A leave-on lip mask with a cushion texture.')).toBe('lip');
    expect(
      inferKind(
        'In-Shower Steam Facial',
        '',
        '',
        'A self-heating gel-to-oil facial treatment for use in the shower.',
      ),
    ).toBe('skincare');
  });

  test('uses compact Pixi highlights that are more specific than source identity fallbacks', () => {
    const primerBundle = buildBundle({
      seed: {
        external_product_id: 'ext_primer',
        title: 'Flawless & Poreless',
        canonical_url: 'https://pixibeauty.com/products/flawless-poreless',
        seed_data: {
          description: 'Miracle-in-a-tube primer that visibly blurs pores and controls shine.',
          key_ingredients: ['Soybean Extract', 'Salicylic Acid'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_primer',
        sellable_item_group_id: 'sig_primer',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const maskBundle = buildBundle({
      seed: {
        external_product_id: 'ext_mask',
        title: 'Milky Remedy Mask',
        canonical_url: 'https://pixibeauty.com/products/milky-remedy-mask',
        seed_data: {
          description: 'A soothing jelly mask enriched with Coconut, Oat Extract, Chamomile and Sea Buckthorn.',
          key_ingredients: ['Coconut', 'Oat Extract'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_mask',
        sellable_item_group_id: 'sig_mask',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const peelBundle = buildBundle({
      seed: {
        external_product_id: 'ext_peel',
        title: 'Glycolic Body Peel',
        canonical_url: 'https://pixibeauty.com/products/glycolic-body-peel',
        seed_data: {
          description: 'Skin is left feeling smooth, hydrated and prepped for body moisturizer or oil.',
          key_ingredients: ['Glycolic Acid'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_peel',
        sellable_item_group_id: 'sig_peel',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const facialBundle = buildBundle({
      seed: {
        external_product_id: 'ext_facial',
        title: 'In-Shower Steam Facial',
        canonical_url: 'https://pixibeauty.com/products/in-shower-steam-facial',
        seed_data: {
          description: 'A self-heating gel-to-oil treatment for use in the shower.',
          key_ingredients: ['Glycerin'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_facial',
        sellable_item_group_id: 'sig_facial',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(primerBundle.shopping_card.subtitle).toBe('Primer');
    expect(primerBundle.shopping_card.highlight).toBe('Pore-blurring primer detail');
    expect(maskBundle.shopping_card.subtitle).toBe('Skincare');
    expect(maskBundle.shopping_card.highlight).toBe('Mask format detail');
    expect(
      buildBundle({
        seed: {
          external_product_id: 'ext_lipmask',
          title: 'LipMask',
          canonical_url: 'https://pixibeauty.com/products/lipmask',
          seed_data: {
            description: 'A leave-on lip mask with a cushion texture.',
          },
        },
        inventoryRow: {
          external_product_id: 'ext_lipmask',
          sellable_item_group_id: 'sig_lipmask',
        },
        generatedAt: '2026-05-22T00:00:00.000Z',
        batchName: 'test_batch',
        reviewer: 'codex_test',
      }).shopping_card.highlight,
    ).toBe('Lip mask formula detail');
    expect(peelBundle.shopping_card.highlight).toBe('Exfoliating treatment detail');
    expect(facialBundle.shopping_card.highlight).toBe('Facial treatment detail');
  });

  test('uses tool-specific Pixi sharpener copy instead of eye-makeup formula copy', () => {
    const bundle = buildBundle({
      seed: {
        external_product_id: 'ext_pixi_sharpener',
        title: 'Sharpener',
        canonical_url: 'https://pixibeauty.com/products/sharpener',
        seed_data: {
          brand: 'PIXI BEAUTY',
          category: 'Makeup Sharpener',
          description: 'Keep your favorite liners on point with our precision sharpener.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_pixi_sharpener',
        sellable_item_group_id: 'sig_pixi_sharpener',
      },
      generatedAt: '2026-05-23T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(inferKind('Sharpener', 'Makeup Sharpener', '', 'Keep your favorite liners on point.')).toBe(
      'makeup_sharpener',
    );
    expect(bundle.shopping_card.subtitle).toBe('Makeup Sharpener');
    expect(bundle.shopping_card.highlight).toBe('Pencil sharpener tool');
    expect(bundle.product_intel_core.what_it_is.body).toContain('makeup sharpener');
  });

  test('keeps Pixi tools and oil blends out of stale brush or sharpener categories', () => {
    const faceClothBundle = buildBundle({
      seed: {
        external_product_id: 'ext_pixi_face_cloth',
        title: 'Face Cloth',
        canonical_url: 'https://pixibeauty.com/products/face-cloth',
        seed_data: {
          brand: 'PIXI BEAUTY',
          category: 'Beauty Brush',
          description: 'A soft cloth for cleansing routines.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_pixi_face_cloth',
        sellable_item_group_id: 'sig_pixi_face_cloth',
      },
      generatedAt: '2026-05-23T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const eyePenBundle = buildBundle({
      seed: {
        external_product_id: 'ext_pixi_eye_pen',
        title: 'Endless Silky Eye Pen',
        canonical_url: 'https://pixibeauty.com/products/endless-silky-eye-pen',
        seed_data: {
          brand: 'PIXI BEAUTY',
          category: 'Makeup Sharpener',
          description: 'A silky eyeliner pencil. Use with a sharpener as needed.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_pixi_eye_pen',
        sellable_item_group_id: 'sig_pixi_eye_pen',
      },
      generatedAt: '2026-05-23T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const oilBundle = buildBundle({
      seed: {
        external_product_id: 'ext_pixi_oil',
        title: 'Jasmine Oil Blend',
        canonical_url: 'https://pixibeauty.com/products/jasmine-oil-blend',
        seed_data: {
          brand: 'PIXI BEAUTY',
          description: 'A jasmine oil blend for skin-care routines.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_pixi_oil',
        sellable_item_group_id: 'sig_pixi_oil',
      },
      generatedAt: '2026-05-23T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const facePaletteBundle = buildBundle({
      seed: {
        external_product_id: 'ext_pixi_face_palette',
        title: 'Own Your Glow Palette',
        canonical_url: 'https://pixibeauty.com/products/own-your-glow-palette',
        seed_data: {
          brand: 'PIXI BEAUTY',
          category: 'Face Palette',
          description: 'A face palette for complexion glow.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_pixi_face_palette',
        sellable_item_group_id: 'sig_pixi_face_palette',
      },
      generatedAt: '2026-05-23T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(faceClothBundle.shopping_card.subtitle).toBe('Skincare Tool');
    expect(faceClothBundle.shopping_card.highlight).toBe('Cleansing cloth tool');
    expect(eyePenBundle.shopping_card.subtitle).toBe('Eye Makeup');
    expect(eyePenBundle.shopping_card.highlight).toBe('Eye-makeup formula detail');
    expect(oilBundle.shopping_card.subtitle).toBe('Face Oil');
    expect(oilBundle.shopping_card.highlight).toBe('Face oil formula detail');
    expect(facePaletteBundle.shopping_card.subtitle).toBe('Face Palette');
    expect(facePaletteBundle.shopping_card.highlight).toBe('Complexion palette detail');
  });

  test('classifies Kylie lip, cleanser, palette, mist, and set formats without generic fallback', () => {
    expect(inferKind('Foaming Face Wash', '', '', 'Foaming face wash with glycerin.')).toBe('cleanser');
    expect(inferKind('Supple Kiss Lip Glaze', '', '', 'Glazing lip color with emollient shine.')).toBe('lip');
    expect(inferKind('Tinted Butter Balm', '', '', 'Tinted balm stick with a buttery glide.')).toBe('lip');
    expect(inferKind('The Classic Matte Palette', '', '', 'Pressed matte powder shades.')).toBe('eye_makeup');
    expect(inferKind('Sweet Eclair Hair & Body Mist', '', '', 'Hair and body mist with sweet scent notes.')).toBe(
      'body_mist',
    );
    expect(inferKind('Lip Oil Desserts PR Box', '', '', 'Lip oil collection.')).toBe('lip_set');
    expect(inferKind('Mini High Gloss Duo', '', '', 'Two gloss products.')).toBe('lip_set');
    expect(
      inferKind(
        'Glow Balm Bundle',
        'Skincare Set',
        '',
        'My Glow Balm Bundle features all eight easily wearable shades of my Lip & Cheek Glow Balm.',
      ),
    ).toBe('makeup_set');
    expect(
      inferKind('Plumping Powder Matte Lip Bundle', '', '', 'All seven shades to create everyday lip looks.'),
    ).toBe('lip_set');
    expect(
      inferKind(
        'Transformative Lip Tint & Precision Pout Lip Liner Duo',
        '',
        '',
        'Two lip-adapting shades with a precision pout liner.',
      ),
    ).toBe('lip_set');
    expect(inferKind('Cosmic Kylie Jenner 3-Piece Gift Set', '', '', 'Eau de parfum gift set.')).toBe(
      'fragrance_set',
    );
    expect(inferKind('Cosmic Kylie Jenner 50ml & Body Lotion Gift Set', '', '', 'Eau de parfum and body lotion.')).toBe(
      'fragrance_set',
    );
    expect(inferKind("Kylie’s Maison Margiela Show Look", '', '', 'Makeup look with lip and complexion items.')).toBe(
      'makeup_set',
    );
  });

  test('does not let stale Kylie skincare category override lip-and-cheek source copy', () => {
    const bundle = buildBundle({
      seed: {
        external_product_id: 'ext_kylie_glow_balm_bundle',
        title: 'Glow Balm Bundle',
        canonical_url: 'https://kyliecosmetics.com/products/glow-balm-bundle',
        seed_data: {
          brand: 'Kylie Cosmetics',
          category: 'Skincare Set',
          description:
            'My Glow Balm Bundle features all eight easily wearable shades of my Lip & Cheek Glow Balm.',
          ingredient_tokens: ['Haute Pink: Isodecyl Neopentanoate, Ethylhexyl Isononanoate.'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_kylie_glow_balm_bundle',
        sellable_item_group_id: 'sig_kylie_glow_balm_bundle',
      },
      generatedAt: '2026-05-23T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(bundle.shopping_card.subtitle).toBe('Makeup Set');
    expect(bundle.shopping_card.highlight).toBe('Lip-and-cheek color set');
    expect(bundle.product_intel_core.what_it_is.headline).toBe('Makeup set identity');
    expect(JSON.stringify(bundle)).not.toMatch(/skincare set identity|daily moisturizer/i);
  });

  test('sanitizes Sigma value, retailer, and ellipsis source text before public insight use', () => {
    expect(
      inferKind(
        'Conceal & Correct Duo',
        '',
        '',
        '$68 Value Brighten, correct, and conceal with precision using the Conceal & Correct Duo.',
      ),
    ).toBe('makeup_set');
    expect(
      inferKind(
        'Soft Blend Eye Duo',
        '',
        '',
        '$47 Value Create effortlessly sweet eye looks with the Peach Pie Eye Duo.',
      ),
    ).toBe('makeup_set');
    expect(inferKind('Hydro Melt Lip Mask', '', '', 'Leave-on lip mask with jojoba oil.')).toBe('lip');
    expect(inferKind('Brush Cleanser Trio', '', '', 'Give your brushes a deep, gentle clean.')).toBe(
      'brush_care',
    );
    expect(sanitizePublicTitleText('\u200dROSY EYESHADOW PALETTE (100% off)')).toBe(
      'ROSY EYESHADOW PALETTE',
    );
    expect(sanitizeFormulaSummary('MATTESDemure: Mica, Nylon-12; Bis-Diglyceryl.')).toBe(
      'MATTES Demure: Mica, Nylon-12; Bis-Diglyceryl.',
    );
    expect(
      sanitizePublicSourceText(
        'Your new favorite for blending, use this soft brush. This set is your go-to for fresh coverage. Dry brushes with this genius tool.',
      ),
    ).toBe(
      'Use this soft brush. This set is designed for fresh coverage. Dry brushes with this tool.',
    );

    const lipDuoBundle = buildBundle({
      seed: {
        external_product_id: 'ext_sigma_lip_duo',
        title: 'Hydrating Lip Duo',
        canonical_url: 'https://sigmabeauty.com/products/hydrating-lip-duo',
        seed_data: {
          description:
            '$56 Value Treat your lips with the Hydrating Lip Duo by Sigma Beauty--an exclusive bundle available only at Ulta Beauty.',
          key_ingredients: ['Hyaluronic Acid'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_sigma_lip_duo',
        sellable_item_group_id: 'sig_sigma_lip_duo',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const paletteBundle = buildBundle({
      seed: {
        external_product_id: 'ext_sigma_palette',
        title: '\u200dROSY EYESHADOW PALETTE (100% off)',
        canonical_url: 'https://sigmabeauty.com/products/sigma-x-angela-bright-eyeshadow-palette',
        seed_data: {
          description:
            '"It finally happened...the Sigma x Angela Bright Eyeshadow Palette. Voted one of the best palettes in 2020. Not eligible for discounts.',
          ingredient_tokens: ['MATTESDemure: Mica, Nylon-12; Bis-Diglyceryl.'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_sigma_palette',
        sellable_item_group_id: 'sig_sigma_palette',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const brushCareBundle = buildBundle({
      seed: {
        external_product_id: 'ext_sigma_brush_care',
        title: 'Essential Brush Cleaning Duo',
        canonical_url: 'https://sigmabeauty.com/products/essential-brush-cleaning-duo',
        seed_data: {
          description: 'Clear skin starts with clean makeup brushes.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_sigma_brush_care',
        sellable_item_group_id: 'sig_sigma_brush_care',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(lipDuoBundle.shopping_card.subtitle).toBe('Lip Set');
    expect(lipDuoBundle.shopping_card.highlight).toBe('Lip-care routine set');
    expect(JSON.stringify(lipDuoBundle)).not.toMatch(/\$\d|available only|Ulta Beauty|price or availability/i);
    expect(paletteBundle.shopping_card.subtitle).toBe('Eye Makeup');
    expect(paletteBundle.shopping_card.highlight).toBe('Eye-makeup formula detail');
    expect(paletteBundle.shopping_card.title).toBe('ROSY EYESHADOW PALETTE');
    expect(JSON.stringify(paletteBundle)).not.toMatch(/\.{2,}|discount|100% off|MATTESDemure|;\.|voted one of/i);
    expect(brushCareBundle.shopping_card.subtitle).toBe('Brush Care');
    expect(brushCareBundle.shopping_card.highlight).toBe('Brush-care cleaning detail');
    expect(JSON.stringify(brushCareBundle)).not.toMatch(/community-backed/i);
  });

  test('keeps Sigma brush sets and switch tools out of stale skincare or eye-makeup buckets', () => {
    expect(
      inferKind(
        'Flawless Finish Brush Set',
        'Skin Care',
        '',
        'Achieve a flawless, airbrushed complexion with the Flawless Finish Brush Set. Outlasts frequent brush care.',
      ),
    ).toBe('brush_set');
    expect(
      inferKind(
        'Sigma® Travel Switch',
        '',
        '',
        'Quickly change eyeshadow shades without changing brushes.',
      ),
    ).toBe('brush_care');
    expect(
      inferKind(
        'Sigma® Switch Set',
        '',
        '',
        'Switch shades without switching brushes at home or on the go.',
      ),
    ).toBe('brush_care');
    expect(
      inferKind(
        'Sigma Palmat®',
        '',
        '',
        'The Palmat® is a 2-in-1 brush cleaning tool that deep cleans your brushes.',
      ),
    ).toBe('brush_care');
    expect(
      inferKind(
        'Soft Blend™ 60 Brush',
        '',
        '',
        'A tapered face brush that outlasts all product formulas and frequent brush care.',
      ),
    ).toBe('brush');
    expect(
      inferKind(
        'Nina Ubhi Favorites Set',
        '',
        '',
        'This is the only brush set you need. Brushes Included: Sigma Switch, E06 Winged Liner Brush.',
      ),
    ).toBe('brush_set');
    expect(
      inferKind(
        'Samantha March Favorites Set',
        '',
        '',
        'Perfect products for quick makeup looks. Products Included: Detail Blending brush, Eyeshadow Quad, Tint Renew Lip Oil, and Sigma Switch. HIGHEST-QUALITY FIBERS: synthetic fibers to protect skin.',
      ),
    ).toBe('makeup_set');
    expect(
      inferKind(
        'Paramour False Lashes',
        '',
        '',
        'Add dramatic volume to your lash look with gorgeous falsies designed to blend with your real lashes.',
      ),
    ).toBe('eye_makeup');

    const brushSetBundle = buildBundle({
      seed: {
        external_product_id: 'ext_sigma_brush_set',
        title: 'Flawless Finish Brush Set',
        canonical_url: 'https://sigmabeauty.com/products/flawless-finish-brush-set',
        seed_data: {
          category: 'Skin Care',
          description: 'Achieve a flawless, airbrushed complexion with the Flawless Finish Brush Set.',
          ingredient_intel: {
            force_fill_contract: {
              field: 'ingredients_inci',
              reason: 'approved_source_not_captured',
            },
          },
        },
      },
      inventoryRow: {
        external_product_id: 'ext_sigma_brush_set',
        sellable_item_group_id: 'sig_sigma_brush_set',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const switchBundle = buildBundle({
      seed: {
        external_product_id: 'ext_sigma_switch',
        title: 'Sigma® Travel Switch',
        canonical_url: 'https://sigmabeauty.com/products/sigma-travel-switch',
        seed_data: {
          description: 'Quickly change eyeshadow shades without changing brushes.',
          ingredient_intel: {
            inci_applicability: {
              status: 'not_applicable',
              reason: 'product_family_accessory',
            },
          },
        },
      },
      inventoryRow: {
        external_product_id: 'ext_sigma_switch',
        sellable_item_group_id: 'sig_sigma_switch',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const palmatBundle = buildBundle({
      seed: {
        external_product_id: 'ext_sigma_palmat',
        title: 'Sigma Palmat®',
        canonical_url: 'https://sigmabeauty.com/products/sigma-palmat',
        seed_data: {
          description:
            '<!----> Say goodbye to dirty makeup brushes! The Palmat® is a 2-in-1 brush cleaning tool that deep cleans your brushes.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_sigma_palmat',
        sellable_item_group_id: 'sig_sigma_palmat',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const makeupSetBundle = buildBundle({
      seed: {
        external_product_id: 'ext_sigma_makeup_set',
        title: 'Samantha March Favorites Set',
        canonical_url: 'https://sigmabeauty.com/products/samantha-march-favorites-set',
        seed_data: {
          description:
            'Enjoy this Favorites Set featuring products for quick makeup looks. Products Included: Detail Blending brush, Eyeshadow Quad, Tint Renew Lip Oil, and Sigma Switch. HIGHEST-QUALITY FIBERS: synthetic fibers to protect skin.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_sigma_makeup_set',
        sellable_item_group_id: 'sig_sigma_makeup_set',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const lashesBundle = buildBundle({
      seed: {
        external_product_id: 'ext_sigma_lashes',
        title: 'Paramour False Lashes',
        canonical_url: 'https://sigmabeauty.com/products/paramour-false-lashes',
        seed_data: {
          description:
            'Add dramatic volume to your lash look with these gorgeous falsies designed to blend seamlessly with your real lashes.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_sigma_lashes',
        sellable_item_group_id: 'sig_sigma_lashes',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(brushSetBundle.shopping_card.subtitle).toBe('Brush Set');
    expect(brushSetBundle.shopping_card.highlight).toBe('Brush set format detail');
    expect(brushSetBundle.evidence_profile).toBe('official_pdp_seed');
    expect(JSON.stringify(brushSetBundle)).not.toMatch(/force_fill_contract|Formula context captured/i);
    expect(switchBundle.shopping_card.subtitle).toBe('Brush Care');
    expect(switchBundle.shopping_card.highlight).toBe('Brush-care cleaning detail');
    expect(switchBundle.evidence_profile).toBe('official_pdp_seed');
    expect(JSON.stringify(switchBundle)).not.toMatch(/inci_applicability|Formula context captured/i);
    expect(palmatBundle.shopping_card.subtitle).toBe('Brush Care');
    expect(palmatBundle.shopping_card.highlight).toBe('Brush-care cleaning detail');
    expect(JSON.stringify(palmatBundle)).not.toMatch(/<!|-->|beauty product/i);
    expect(makeupSetBundle.shopping_card.subtitle).toBe('Makeup Set');
    expect(makeupSetBundle.shopping_card.highlight).toBe('Makeup routine set');
    expect(lashesBundle.shopping_card.subtitle).toBe('Eye Makeup');
  });

  test('preserves official Sigma brush-set product names while removing broad marketing claims', () => {
    expect(sanitizePublicTitleText('Award-Winning Brush Set')).toBe('Award-Winning Brush Set');
    expect(
      sanitizePublicSourceText(
        "Discover the ultimate brush collection that has captured beauty lovers' hearts worldwide. The Award-Winning Brush Set combines Sigma face and eye brushes with the Dry'n Shape Tower.",
      ),
    ).toBe("The Award-Winning Brush Set combines Sigma face and eye brushes with the Dry'n Shape Tower.");

    const awardBundle = buildBundle({
      seed: {
        external_product_id: 'ext_sigma_award_brush_set',
        title: 'Award-Winning Brush Set',
        canonical_url: 'https://sigmabeauty.com/products/the-award-winning-brush-set',
        seed_data: {
          brand: 'sigma beauty',
          category: 'Brush Set',
          description:
            "Discover the ultimate brush collection that has captured beauty lovers' hearts worldwide. The Award-Winning Brush Set combines Sigma's most beloved face and eye brushes with the innovative Dry'n Shape Tower for quick and easy drying and storage.",
        },
      },
      inventoryRow: {
        external_product_id: 'ext_sigma_award_brush_set',
        sellable_item_group_id: 'sig_sigma_award_brush_set',
      },
      generatedAt: '2026-05-23T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const favoritesBundle = buildBundle({
      seed: {
        external_product_id: 'ext_sigma_favorites_brush_set',
        title: 'An Knook Favorites Brush Set',
        canonical_url: 'https://sigmabeauty.com/products/an-knook-favorites-brush-set',
        seed_data: {
          brand: 'sigma beauty',
          category: 'Curated Set',
          description:
            "Enjoy this limited-edition Favorites Brush Set, created just for you, featuring a selection of An's brushes.",
        },
      },
      inventoryRow: {
        external_product_id: 'ext_sigma_favorites_brush_set',
        sellable_item_group_id: 'sig_sigma_favorites_brush_set',
      },
      generatedAt: '2026-05-23T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(awardBundle.shopping_card.title).toBe('Award-Winning Brush Set');
    expect(awardBundle.shopping_card.highlight).toBe('Brushes plus drying tower');
    expect(awardBundle.product_intel_core.what_it_is.body).toContain('Award-Winning Brush Set');
    expect(JSON.stringify(awardBundle)).not.toMatch(/captured beauty lovers|hearts worldwide|Brush Set as Brush Set/i);
    expect(favoritesBundle.shopping_card.highlight).toBe('Curated favorites brush set');
    expect(favoritesBundle.product_intel_core.what_it_is.body).toContain('An Knook Favorites Brush Set');
  });

  test('uses clean Sigma brush prose without duplicated beauty wording', () => {
    const bundle = buildBundle({
      seed: {
        external_product_id: 'ext_sigma_brush',
        title: 'F30 Large Powder Brush',
        canonical_url: 'https://sigmabeauty.com/products/f30-large-powder-chrome',
        seed_data: {
          brand: 'sigma beauty',
          description: 'Your classic powder brush in extra-soft SigmaTech fibers.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_sigma_brush',
        sellable_item_group_id: 'sig_sigma_brush',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(bundle.product_intel_core.what_it_is.body).toContain('A Sigma Beauty brush listed');
    expect(bundle.product_intel_core.what_it_is.body).not.toMatch(/beauty beauty/i);
  });

  test('classifies Sigma makeup blenders as applicator tools, not generic beauty products', () => {
    expect(inferKind('3DHD™ Blender', '', '', 'A makeup blender for cream and liquid complexion products.')).toBe(
      'makeup_applicator',
    );

    const bundle = buildBundle({
      seed: {
        external_product_id: 'ext_sigma_blender',
        title: '3DHD™ Blender',
        canonical_url: 'https://sigmabeauty.com/products/3dhdtm-blender',
        seed_data: {
          brand: 'sigma beauty',
          description: 'A makeup blender for applying liquid, cream, and powder formulas.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_sigma_blender',
        sellable_item_group_id: 'sig_sigma_blender',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(bundle.shopping_card.subtitle).toBe('Makeup Applicator');
    expect(bundle.shopping_card.highlight).toBe('Makeup sponge format detail');
    expect(bundle.product_intel_core.what_it_is.body).toContain('makeup applicator');
    expect(bundle.product_intel_core.what_it_is.body).not.toMatch(/beauty product/i);
  });

  test('classifies Sigma makeup brush cups as storage accessories, not brushes', () => {
    expect(inferKind('Makeup Brush Cup', '', '', 'A cup for storing makeup brushes.')).toBe('brush_storage');
    expect(inferKind('Travel-Sized Makeup Brush Cup', '', '', 'A travel cup for makeup brushes.')).toBe(
      'brush_storage',
    );

    const bundle = buildBundle({
      seed: {
        external_product_id: 'ext_sigma_brush_cup',
        title: 'Makeup Brush Cup',
        canonical_url: 'https://sigmabeauty.com/products/makeup-brush-cup',
        seed_data: {
          brand: 'sigma beauty',
          description: 'Store your favorite brushes in a makeup brush cup.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_sigma_brush_cup',
        sellable_item_group_id: 'sig_sigma_brush_cup',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(bundle.shopping_card.subtitle).toBe('Brush Storage');
    expect(bundle.shopping_card.highlight).toBe('Brush storage detail');
    expect(bundle.product_intel_core.what_it_is.body).toContain('brush storage accessory');
  });

  test('uses compact Kylie highlights that avoid beauty-product and source-backed fallbacks', () => {
    const lipBundle = buildBundle({
      seed: {
        external_product_id: 'ext_lip_glaze',
        title: 'Supple Kiss Lip Glaze',
        canonical_url: 'https://kyliecosmetics.com/products/supple-kiss-lip-glaze',
        seed_data: {
          description: 'A glossy lip glaze with emollient shine.',
          key_ingredients: ['Jojoba Oil'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_lip_glaze',
        sellable_item_group_id: 'sig_lip_glaze',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const mistBundle = buildBundle({
      seed: {
        external_product_id: 'ext_mist',
        title: 'Sweet Eclair Hair & Body Mist',
        canonical_url: 'https://kyliecosmetics.com/products/sweet-eclair-hair-body-mist',
        seed_data: {
          description: 'A hair and body mist with sweet scent notes.',
          key_ingredients: ['Fragrance'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_mist',
        sellable_item_group_id: 'sig_mist',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const setBundle = buildBundle({
      seed: {
        external_product_id: 'ext_set',
        title: 'Lip Oil Desserts PR Box',
        canonical_url: 'https://kyliecosmetics.com/products/lip-oil-desserts-pr-box',
        seed_data: {
          description: 'A lip oil collection in a PR box format.',
          key_ingredients: ['Coconut Oil'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_set',
        sellable_item_group_id: 'sig_set',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const fragranceSetBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fragrance_set',
        title: 'Cosmic Kylie Jenner 50ml & Body Lotion Gift Set',
        canonical_url: 'https://kyliecosmetics.com/products/cosmic-kylie-gift-set',
        seed_data: {
          description: 'An eau de parfum and body lotion gift set.',
          key_ingredients: ['Amber Accord'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fragrance_set',
        sellable_item_group_id: 'sig_fragrance_set',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const moisturizerBundle = buildBundle({
      seed: {
        external_product_id: 'ext_moisturizer',
        title: 'Face Moisturizer',
        canonical_url: 'https://kyliecosmetics.com/products/face-moisturizer',
        seed_data: {
          description: 'A moisturizer with ingredients that support gentle exfoliation.',
          key_ingredients: ['Glycerin'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_moisturizer',
        sellable_item_group_id: 'sig_moisturizer',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const lipButterBundle = buildBundle({
      seed: {
        external_product_id: 'ext_lip_butter',
        title: 'Lip Butter',
        canonical_url: 'https://kyliecosmetics.com/products/lip-butter',
        seed_data: {
          description: 'A lip butter inspired by our best-selling lip liner format.',
          key_ingredients: ['Shea Butter'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_lip_butter',
        sellable_item_group_id: 'sig_lip_butter',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(lipBundle.shopping_card.subtitle).toBe('Lip Product');
    expect(lipBundle.shopping_card.highlight).toBe('Shine lip formula detail');
    expect(mistBundle.shopping_card.subtitle).toBe('Body Mist');
    expect(mistBundle.shopping_card.highlight).toBe('Hair-and-body mist detail');
    expect(setBundle.shopping_card.subtitle).toBe('Lip Set');
    expect(setBundle.shopping_card.highlight).toBe('Lip-care routine set');
    expect(fragranceSetBundle.shopping_card.subtitle).toBe('Fragrance Set');
    expect(fragranceSetBundle.shopping_card.highlight).toBe('Fragrance gift set');
    expect(moisturizerBundle.shopping_card.highlight).toBe('Moisturizer formula detail');
    expect(lipButterBundle.shopping_card.highlight).toBe('Creamy lip formula detail');
    expect(lipButterBundle.shopping_card.intro).not.toMatch(/best-selling/i);
  });

  test('does not fall back to a Tom Ford brand when seed brand metadata is missing', () => {
    const bundle = buildBundle({
      seed: {
        external_product_id: 'ext_fixture',
        title: 'Clarity Tonic To-Go',
        canonical_url: 'https://pixibeauty.com/products/clarity-tonic-to-go',
        seed_data: {
          description: 'Formulated with Glycolic, Lactic and Salicylic Acids.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fixture',
        sellable_item_group_id: 'sig_fixture',
      },
      generatedAt: '2026-05-22T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(brandFromUrl('https://pixibeauty.com/products/clarity-tonic-to-go')).toBe('Pixibeauty');
    expect(bundle.product_intel_core.what_it_is.body).toContain('Pixibeauty toner');
    expect(bundle.product_intel_core.what_it_is.body).not.toContain('Tom Ford');
  });

  test('conservative rewrite selection skips protected or non-public Pixi rows', () => {
    const base = {
      domain: 'pixibeauty.com',
      recommended_lane: 'lane_3_kb_rewrite_review',
      seed_missing_fields: '',
      identity_status: 'approved',
      identity_live_read_enabled: true,
      kb_direct_high_quality_ready: false,
      kb_direct_human_reviewed: true,
      kb_direct_quality_state: 'limited',
      kb_direct_evidence_profile: 'seller_only',
      main_blocker: 'kb_displayable_limited',
      catalog_attached: true,
      index_serving_eligible: true,
      commerce_doc_public: true,
      terminal_hold: false,
    };

    expect(isConservativeRewriteCandidate({ ...base, title: 'Glow-y Lip Oil' })).toBe(true);
    expect(
      isConservativeRewriteCandidate({
        ...base,
        title: 'Mini Makeup Fixing Mist',
        kb_direct_evidence_profile: 'community_supported',
      }),
    ).toBe(false);
    expect(
      isConservativeRewriteCandidate({
        ...base,
        title: 'Verified Insight',
        kb_direct_high_quality_ready: true,
      }),
    ).toBe(false);
    expect(isConservativeRewriteCandidate({ ...base, title: 'PixiPerfume Sample' })).toBe(false);
    expect(
      isConservativeRewriteCandidate(
        { ...base, title: 'Daily Glow Duo' },
        { singleItemOnly: true },
      ),
    ).toBe(false);
    expect(isConservativeRewriteCandidate({ ...base, title: 'Pixi Rose Travel Bag' })).toBe(false);
    expect(
      isConservativeRewriteCandidate(
        { ...base, title: 'Glow Mist', commerce_doc_public: false },
        { requirePublicCommerceDoc: true },
      ),
    ).toBe(false);
  });

  test('selectInventoryRows keeps only safe public candidates when requested', () => {
    const rows = [
      {
        external_product_id: 'safe',
        domain: 'pixibeauty.com',
        title: 'Glow-y Lip Oil',
        recommended_lane: 'lane_3_kb_rewrite_review',
        seed_missing_fields: '',
        identity_status: 'approved',
        identity_live_read_enabled: true,
        kb_direct_high_quality_ready: false,
        kb_direct_human_reviewed: true,
        kb_direct_quality_state: 'limited',
        kb_direct_evidence_profile: 'seller_only',
        main_blocker: 'kb_displayable_limited',
        catalog_attached: true,
        index_serving_eligible: true,
        commerce_doc_public: true,
        terminal_hold: false,
      },
      {
        external_product_id: 'protected',
        domain: 'pixibeauty.com',
        title: 'Mini Makeup Fixing Mist',
        recommended_lane: 'lane_3_kb_rewrite_review',
        seed_missing_fields: '',
        identity_status: 'approved',
        identity_live_read_enabled: true,
        kb_direct_high_quality_ready: false,
        kb_direct_human_reviewed: true,
        kb_direct_quality_state: 'eligible',
        kb_direct_evidence_profile: 'community_supported',
        main_blocker: 'kb_blocked',
        catalog_attached: true,
        index_serving_eligible: true,
        commerce_doc_public: true,
        terminal_hold: false,
      },
      {
        external_product_id: 'shadow',
        domain: 'pixibeauty.com',
        title: 'Rose Body Cleanser',
        recommended_lane: 'lane_3_kb_rewrite_review',
        seed_missing_fields: '',
        identity_status: 'approved',
        identity_live_read_enabled: true,
        kb_direct_high_quality_ready: false,
        kb_direct_human_reviewed: true,
        kb_direct_quality_state: 'limited',
        kb_direct_evidence_profile: 'seller_only',
        main_blocker: 'kb_displayable_limited',
        catalog_attached: true,
        index_serving_eligible: false,
        commerce_doc_public: false,
        terminal_hold: false,
      },
    ];

    expect(
      selectInventoryRows(rows, {
        domain: 'pixibeauty.com',
        lane: 'lane_3_kb_rewrite_review',
        limit: 10,
        requirePublicCommerceDoc: true,
        singleItemOnly: true,
      }).map((row) => row.external_product_id),
    ).toEqual(['safe']);
  });
});
