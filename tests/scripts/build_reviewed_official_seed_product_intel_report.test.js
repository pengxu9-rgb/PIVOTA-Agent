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
    firstSentence,
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
    expect(
      sanitizePublicSourceText(
        'These glow-boosting sheet masks are soaked in a serum concentrate that instantly revitalizes tired skin. Whit antioxidant-rich Vitamin C and de-puffing Caffeine, this face mask is designed for restoring radiance.',
      ),
    ).toContain('With antioxidant-rich Vitamin C');
    expect(
      sanitizePublicSourceText(
        'This Vitamin-C Lotion provides the finishing, radiant touch your skin deserves. Not only is your skin treated to rich hydration, but you’ll also enjoy the benefits of key ingredients known for their abilities.',
      ),
    ).toBe(
      'Vitamin-C Lotion is positioned as a hydrating lotion step with a radiant-looking finish.',
    );
    expect(
      sanitizePublicSourceText(
        "If you're looking for a serum that provides a radiant glow - and so much more - you'll find it with Pixi Beauty Vitamin-C Serum. This enriching serum helps improve skin tone and creates a smoother complexion.",
      ),
    ).toBe(
      'Vitamin-C Serum is positioned around a radiant-looking glow and smoother-looking complexion support.',
    );
    expect(
      sanitizePublicSourceText(
        'Vitamin C CremeSerum combines a luxurious hyaluronic serum-gel with encapsulated Vitamin C moisture beads to keep your glow-boosting ingredients feeling.',
      ),
    ).toBe(
      'Vitamin C CremeSerum combines a luxurious hyaluronic serum-gel with encapsulated Vitamin C moisture beads.',
    );
    expect(
      sanitizePublicSourceText(
        'Vitamin C CremeSerum combines a luxurious hyaluronic serum-gel with encapsulated Vitamin C moisture beads to keep your glow-boosting ingredients feeling fresh from the first pump to the last. Why you’ll love it.',
      ),
    ).toBe(
      'Vitamin C CremeSerum combines a luxurious hyaluronic serum-gel with encapsulated Vitamin C moisture beads.',
    );
    expect(
      sanitizePublicSourceText(
        'Vitamin-C Lotion is positioned as a hydrating lotion step with a radiant-looking finish. to revive, protect and revitalize the skin. Use the Vitamin-C Lotion daily as your go-to moisturizer or as needed for a skincare.',
      ),
    ).toBe(
      'Vitamin-C Lotion is positioned as a hydrating lotion step with a radiant-looking finish.',
    );
    expect(
      sanitizePublicSourceText(
        'Vitamin-C Lotion is positioned as a hydrating lotion step with a radiant-looking finish. pick-me-up.',
      ),
    ).toBe(
      'Vitamin-C Lotion is positioned as a hydrating lotion step with a radiant-looking finish.',
    );
    expect(
      sanitizePublicSourceText(
        'Vitamin-C Serum is positioned around a radiant-looking glow and smoother-looking complexion support. while reducing the effects of sun damage and free radicals. Enjoy our multi-use Vitamin-C Serum daily or as needed.',
      ),
    ).toBe(
      'Vitamin-C Serum is positioned around a radiant-looking glow and smoother-looking complexion support.',
    );
    expect(
      sanitizePublicSourceText(
        'Pixi Beauty Vitamin-C Tonic is a daily facial toner that contains Vitamin-C, a potent Antioxidant that is known to boost skin luminosity.',
      ),
    ).toBe(
      'Pixi Beauty Vitamin-C Tonic is a daily facial toner that contains Vitamin-C and is positioned around luminous-looking skin.',
    );
    expect(
      sanitizePublicSourceText(
        'Designed to leave the complexion looking refreshed and Glowing, these soft, pre-soaked wipes are perfect.',
      ),
    ).toBe(
      'Designed to leave the complexion looking refreshed and glowing in a pre-soaked wipe format.',
    );
    expect(
      sanitizePublicSourceText(
        'Designed to leave the complexion looking refreshed and Glowing, these soft, pre-soaked wipes are perfect. for daily use.',
      ),
    ).toBe(
      'Designed to leave the complexion looking refreshed and glowing in a pre-soaked wipe format for daily use.',
    );
    expect(
      sanitizePublicSourceText(
        'Reset your complexion with the Clear Skin Reset Kit, a clarifying routine designed to balance and refresh. Featuring yet gentle formulas, this set works to purify, smooth and soothe while targeting excess oil and visible. With skin-loving. ingredients like.',
      ),
    ).toBe(
      'Reset your complexion with the Clear Skin Reset Kit, a clarifying routine designed to balance and refresh. Featuring gentle formulas, this set supports a clarifying-looking, excess-oil routine.',
    );
    expect(
      sanitizePublicSourceText('Instantly reduces puffiness and under-eye circles.'),
    ).toBe('Positioned around the look of puffiness and under-eye circles.');
    expect(
      sanitizePublicSourceText(
        'Two silky, coordinated shades to use together or solo. MSRP was last offered 12/10/25.',
      ),
    ).toBe('Two silky, coordinated shades to use together or solo.');
    expect(
      sanitizePublicTitleText('Pixi + Maryam Maquillage Dream-y Lit Kit | MaryamNYC Limited Edition'),
    ).toBe('Pixi + Maryam Maquillage Dream-y Lit Kit');
    expect(sanitizeFormulaSummary('Vitamin-C brightens & promotes collagen production')).toBe(
      'Vitamin-C supports radiant-looking tone',
    );
    expect(sanitizeFormulaSummary('Vitamin-C brightens & boosts luminosity')).toBe(
      'Vitamin-C supports luminous-looking tone',
    );
    expect(sanitizeFormulaSummary('Vitamin C brightens and promotes a radiant complexion')).toBe(
      'Vitamin C supports a radiant-looking complexion',
    );
    expect(sanitizeFormulaSummary('Vitamin C – Evens skintone and improves the appearance of skin')).toBe(
      'Vitamin C – Supports the look of more even tone',
    );
    expect(
      sanitizeFormulaSummary(
        'Salicylic acid, Glycolic acid, Lactic acid Salicylic acid, Glycolic acid, Lactic acid',
      ),
    ).toBe('Salicylic acid, Glycolic acid, Lactic acid');
    expect(
      sanitizeFormulaSummary('Salicylic acid, Glycolic acid, Lactic acid Clarity Cleanser'),
    ).toBe('Salicylic acid, Glycolic acid, Lactic acid');
    expect(sanitizeFormulaSummary('Rose Flower Oil soothes & hydrates')).toBe(
      'Rose Flower Oil is listed for soothing and hydrating positioning',
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
    const lipBlushBundle = buildBundle({
      seed: {
        external_product_id: 'ext_lipblush',
        title: 'LipBlush',
        canonical_url: 'https://pixibeauty.com/products/lipblush',
        seed_data: {
          brand: 'PIXI BEAUTY',
          category: 'Lip Tint',
          description: 'Lightweight, water-based lip stain with stale liner copy elsewhere on the row.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_lipblush',
        sellable_item_group_id: 'sig_lipblush',
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
    expect(lipBlushBundle.shopping_card.subtitle).toBe('Lip Tint');
    expect(lipBlushBundle.shopping_card.highlight).toBe('Lip tint format detail');
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

  test('classifies Pixi multi-item sets without generic or stale category leakage', () => {
    const buildPixiBundle = ({ id, title, category = '', description }) =>
      buildBundle({
        seed: {
          external_product_id: id,
          title,
          canonical_url: `https://pixibeauty.com/products/${id}`,
          seed_data: {
            brand: 'PIXI BEAUTY',
            category,
            description,
          },
        },
        inventoryRow: {
          external_product_id: id,
          sellable_item_group_id: `sig_${id}`,
        },
        generatedAt: '2026-05-23T00:00:00.000Z',
        batchName: 'test_batch',
        reviewer: 'codex_test',
      });

    expect(inferKind('Spot Stickers Trio', '', '', 'Bright-C Sticker and blemish sticker set.')).toBe(
      'blemish_patch_set',
    );
    expect(
      inferKind(
        'Choose Your Endless Silky Eye Trio',
        '',
        '',
        'Customizable trio bundle of Endless Silky Eye Pen eyeliner shades.',
      ),
    ).toBe('makeup_set');
    expect(inferKind('Rose Glow Routine', '', '', 'Rose Cream Cleanser and rose skin-care steps.')).toBe(
      'skincare_set',
    );
    expect(
      inferKind('Double Cleanse Duo', '', '', 'EOD Cleansing Oil and cleanser duo. Fragrance-free.'),
    ).toBe('skincare_set');
    expect(
      inferKind(
        'Choose Your Glow Trio',
        'Skincare Set',
        '',
        'On-the-Glow BLUSH and On-the-Glow Bronze cheek color sticks.',
      ),
    ).toBe('makeup_set');
    expect(
      inferKind(
        'Mini Spa Trio',
        '',
        '',
        'Glow Mud Cleanser is a deep pore cleansing face wash with Glycolic Acid for a brighter complexion.',
      ),
    ).toBe('skincare_set');
    expect(inferKind('Misting Must-Haves', '', '', 'All-over glow mist for a luminous, dewy complexion.')).toBe(
      'skincare_set',
    );
    expect(
      inferKind(
        'Vitamin-C Essentials Brightening Bundle',
        '',
        '',
        'Brighten, smooth and refresh your skin with this Vitamin-C skincare set. Includes tonic, patches, serum capsules and eye patches.',
      ),
    ).toBe('skincare_set');
    expect(inferKind('LipTone Trio', '', '', 'Gloss works with lips pH level for a tint.')).toBe(
      'lip_set',
    );
    expect(inferKind('Glow & Go Trio', '', '', 'LipTone gloss trio with pH adaptive pigment.')).toBe(
      'lip_set',
    );
    expect(
      inferKind(
        'Makeup Melting Cleansing Cloths Set of 5',
        '',
        '',
        'Reusable cleansing cloths gently remove makeup.',
      ),
    ).toBe('skincare_tool_set');

    expect(
      buildPixiBundle({
        id: 'spot_stickers_trio',
        title: 'Spot Stickers Trio',
        description: 'Bright-C Sticker and blemish sticker set.',
      }).shopping_card,
    ).toMatchObject({ subtitle: 'Blemish Patch Set', highlight: 'Spot-care sticker set' });
    expect(
      buildPixiBundle({
        id: 'endless_silky_eye_trio',
        title: 'Choose Your Endless Silky Eye Trio',
        description: 'Customizable trio bundle of Endless Silky Eye Pen eyeliner shades.',
      }).shopping_card,
    ).toMatchObject({ subtitle: 'Makeup Set', highlight: 'Eye-makeup routine set' });
    expect(
      buildPixiBundle({
        id: 'rose_glow_routine',
        title: 'Rose Glow Routine',
        description: 'Rose Cream Cleanser and rose skin-care steps.',
      }).shopping_card,
    ).toMatchObject({ subtitle: 'Skincare Set', highlight: 'Cleansing routine set' });
    expect(
      buildPixiBundle({
        id: 'double_cleanse_duo',
        title: 'Double Cleanse Duo',
        description: 'EOD Cleansing Oil and cleanser duo. Fragrance-free.',
      }).shopping_card,
    ).toMatchObject({ subtitle: 'Skincare Set', highlight: 'Cleansing routine set' });
    expect(
      buildPixiBundle({
        id: 'choose_glow_trio',
        title: 'Choose Your Glow Trio',
        category: 'Skincare Set',
        description: 'On-the-Glow BLUSH and On-the-Glow Bronze cheek color sticks.',
      }).shopping_card,
    ).toMatchObject({ subtitle: 'Makeup Set', highlight: 'Cheek color set' });
    expect(
      buildPixiBundle({
        id: 'mini_spa_trio',
        title: 'Mini Spa Trio',
        description:
          'Glow Mud Cleanser • Deep pore cleansing face wash with Glycolic Acid • Gently exfoliates for a brighter complexion.',
      }).shopping_card,
    ).toMatchObject({ subtitle: 'Skincare Set', highlight: 'Cleansing routine set' });
    expect(
      buildPixiBundle({
        id: 'misting_must_haves',
        title: 'Misting Must-Haves',
        description: 'All-over glow mist for a luminous, dewy complexion.',
      }).shopping_card,
    ).toMatchObject({ subtitle: 'Skincare Set', highlight: 'Mist routine set' });
    expect(
      buildPixiBundle({
        id: 'vitamin_c_essentials',
        title: 'Vitamin-C Essentials Brightening Bundle',
        description:
          'Brighten, smooth and refresh your skin with this Vitamin-C skincare set. Includes tonic, patches, serum capsules and eye patches.',
      }).shopping_card,
    ).toMatchObject({ subtitle: 'Skincare Set', highlight: 'Glow routine set' });
    expect(
      buildPixiBundle({
        id: 'liptone_trio',
        title: 'LipTone Trio',
        description: 'Gloss works with lips pH level for a tint.',
      }).shopping_card,
    ).toMatchObject({ subtitle: 'Lip Set', highlight: 'Lip gloss routine set' });
    expect(
      buildPixiBundle({
        id: 'glow_go_trio',
        title: 'Glow & Go Trio',
        description: 'LipTone gloss trio with pH adaptive pigment.',
      }).shopping_card,
    ).toMatchObject({ subtitle: 'Lip Set', highlight: 'Lip gloss routine set' });
    expect(
      buildPixiBundle({
        id: 'cleansing_cloths_set',
        title: 'Makeup Melting Cleansing Cloths Set of 5',
        description: 'Reusable cleansing cloths gently remove makeup.',
      }).shopping_card,
    ).toMatchObject({ subtitle: 'Skincare Tool Set', highlight: 'Cleansing cloth set' });
    expect(
      buildPixiBundle({
        id: 'glow_mist_duo',
        title: 'Glow Mist Duo',
        category: 'Toner',
        description: 'Glow Mist and Hydrating Milky Mist in a duo.',
      }).shopping_card,
    ).toMatchObject({ subtitle: 'Skincare Set', highlight: 'Mist routine set' });
    expect(
      buildPixiBundle({
        id: 'eye_patch_duo',
        title: 'Day & Night Eye Patch Duo',
        description:
          'DetoxifEYE • \"You can achieve that awake look\" - Petra • Hydrates and plumps with hyaluronic acid.',
      }).product_intel_core.what_it_is.body,
    ).toContain('Hydrates and plumps with hyaluronic acid.');
    expect(
      buildPixiBundle({
        id: 'blush_set',
        title: 'On-the-Glow BLUSH New Shades Set',
        description:
          'Hydrating solid tints for cheeks and lips enriched with Ginseng, Aloe Vera and Fruit Extracts that deliver a tint.',
      }).product_intel_core.what_it_is.body,
    ).not.toMatch(/that deliver\./);
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
    expect(sanitizePublicSourceText('Now available in a customizable trio. Save 20% with this kit.')).toBe(
      'Now available in a customizable trio.',
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

  test('classifies noisy Kylie sets and accessories without stale skincare or makeup leakage', () => {
    expect(
      inferKind(
        'Cosmic Kylie Jenner Pouch',
        '',
        '',
        "Shop Kylie Cosmetics featuring makeup, fragrance, and skincare that's clean.",
      ),
    ).toBe('beauty_accessory');
    expect(inferKind('Rosy Radiance Lip Combo', '', '', 'A lip combo with gloss and liner.')).toBe(
      'lip_set',
    );
    expect(
      inferKind(
        'Cosmic Kylie Jenner & Intense 100ml Duo',
        '',
        '',
        "Shop Kylie Cosmetics featuring makeup, fragrance, and skincare that's clean.",
      ),
    ).toBe('fragrance_set');
    expect(
      inferKind(
        '12 Days of Kylie Advent Calendar',
        '',
        '',
        'A multi-item advent calendar with makeup and lip items.',
      ),
    ).toBe('beauty_set');
    expect(inferKind('Loofah', '', '', 'A body exfoliating shower sponge.')).toBe('body_tool');
    expect(
      inferKind('Pressed Blush Powder & Brush Duo', '', '', 'A pressed blush powder and brush duo.'),
    ).toBe('makeup_set');
    expect(inferKind('Hybrid Blush & Foundation Brush Duo', '', '', 'A blush and brush duo.')).toBe(
      'makeup_set',
    );
    expect(inferKind('Glossy Lip Kit & Hybrid Blush Duo', '', '', 'A lip kit and blush duo.')).toBe(
      'makeup_set',
    );
    expect(
      inferKind('Glossy Lip Kit & Skin Tint Blurring Elixir Duo', '', '', 'A lip kit and skin tint duo.'),
    ).toBe('makeup_set');
    expect(
      inferKind('Hybrid Blush & Tinted Butter Balm Duo', '', '', 'A blush and tinted butter balm duo.'),
    ).toBe('makeup_set');
    expect(
      firstSentence(
        sanitizePublicSourceText(
          "Shop Kylie Cosmetics by Kylie Jenner, Kylie Jenner Fragrances and Kylie Skin featuring makeup, fragrance, and skincare that's clean, vegan, cruelty-free, and dermatologist-tested.",
        ),
      ),
    ).toBe('');
    expect(firstSentence('The mesh pouf is designed to help gently exfoliate along with the scrub, so')).toBe(
      'The mesh pouf is designed to help gently exfoliate along with the scrub.',
    );

    const pouchBundle = buildBundle({
      seed: {
        external_product_id: 'ext_kylie_pouch',
        title: 'Cosmic Kylie Jenner Pouch',
        canonical_url: 'https://kyliecosmetics.com/products/cosmic-by-kylie-jenner-eau-de-parfum-pouch',
        seed_data: {
          brand: 'Kylie Cosmetics',
          description:
            "Shop Kylie Cosmetics by Kylie Jenner, Kylie Jenner Fragrances and Kylie Skin featuring makeup, fragrance, and skincare that's clean.",
        },
      },
      inventoryRow: {
        external_product_id: 'ext_kylie_pouch',
        sellable_item_group_id: 'sig_kylie_pouch',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const fragranceBundle = buildBundle({
      seed: {
        external_product_id: 'ext_kylie_cosmic_duo',
        title: 'Cosmic Kylie Jenner 100ml Trio',
        canonical_url: 'https://kyliecosmetics.com/products/cosmic-kylie-jenner-100ml-trio',
        seed_data: {
          brand: 'Kylie Cosmetics',
          description: 'A Cosmic Kylie Jenner fragrance trio.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_kylie_cosmic_duo',
        sellable_item_group_id: 'sig_kylie_cosmic_duo',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const adventBundle = buildBundle({
      seed: {
        external_product_id: 'ext_kylie_advent',
        title: '12 Days of Kylie Advent Calendar',
        canonical_url: 'https://kyliecosmetics.com/products/12-days-of-kylie-advent-calendar',
        seed_data: {
          brand: 'Kylie Cosmetics',
          description: 'A multi-item advent calendar with makeup, lip, and fragrance formats.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_kylie_advent',
        sellable_item_group_id: 'sig_kylie_advent',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(pouchBundle.shopping_card.subtitle).toBe('Beauty Accessory');
    expect(pouchBundle.shopping_card.highlight).toBe('Accessory format detail');
    expect(pouchBundle.product_intel_core.what_it_is.body).not.toMatch(/skincare product/i);
    expect(pouchBundle.shopping_card.intro).not.toMatch(/Shop Kylie Cosmetics/i);
    expect(fragranceBundle.shopping_card.subtitle).toBe('Fragrance Set');
    expect(fragranceBundle.shopping_card.highlight).toBe('Fragrance gift set');
    expect(adventBundle.shopping_card.subtitle).toBe('Beauty Set');
    expect(adventBundle.shopping_card.highlight).toBe('Multi-item advent calendar');
  });

  test('classifies Naturium treatment sprays, cleansing balms, and Vitamin C serums conservatively', () => {
    expect(
      inferKind(
        'Salicylic Acid Body Spray 2%',
        '',
        '',
        '4 FL OZ / 120 ML An acne-fighting spray that clears and prevents blemishes.',
      ),
    ).toBe('body_spray_treatment');
    expect(
      inferKind(
        'Purple Ginseng Cleansing Balm',
        '',
        '',
        'A cleansing balm that dissolves makeup and helps remove sunscreen.',
      ),
    ).toBe('cleanser');
    expect(
      inferKind(
        'The Glow Getter Multi-Oil Body Butter',
        '',
        '',
        'A whipped, multi-oil body butter with shea butter and squalane.',
      ),
    ).toBe('moisturizer');
    expect(
      inferKind(
        'Marshmallow Root Barrier Balm',
        '',
        '',
        'A balm formulated with marshmallow root and colloidal oatmeal to support the skin barrier.',
      ),
    ).toBe('moisturizer');
    expect(
      inferKind(
        'AHA Exfoliating Mask 10%',
        '',
        '',
        'A glycolic and lactic acid exfoliating mask with rice powder and clay.',
      ),
    ).toBe('skincare');
    expect(
      inferKind(
        'Intense Overnight Sleeping Cream - Jumbo',
        '',
        '',
        'A sleeping cream with plant oils and moisture barrier support.',
      ),
    ).toBe('moisturizer');

    const sprayBundle = buildBundle({
      seed: {
        external_product_id: 'ext_naturium_spray',
        title: 'Salicylic Acid Body Spray 2%',
        canonical_url: 'https://naturium.com/products/salicylic-acid-body-spray-2',
        seed_data: {
          brand: 'Naturium',
          description:
            '4 FL OZ / 120 ML An acne-fighting spray that clears and prevents blemishes. Formula highlights include salicylic acid, niacinamide, zinc PCA.',
          ingredient_tokens: ['Salicylic Acid', 'Niacinamide', 'Zinc PCA'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_naturium_spray',
        sellable_item_group_id: 'sig_naturium_spray',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const balmBundle = buildBundle({
      seed: {
        external_product_id: 'ext_naturium_balm',
        title: 'Purple Ginseng Cleansing Balm',
        canonical_url: 'https://naturium.com/products/purple-ginseng-cleansing-balm',
        seed_data: {
          brand: 'Naturium',
          description:
            'Our cleansing balm is formulated with purple ginseng, plant-based esters and a nourishing blend to remove makeup and sunscreen.',
          ingredient_tokens: ['Ginseng Extract', 'Helianthus Annuus Seed Oil', 'Caprylic/Capric Triglyceride'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_naturium_balm',
        sellable_item_group_id: 'sig_naturium_balm',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const vitaminCBundle = buildBundle({
      seed: {
        external_product_id: 'ext_naturium_vitamin_c',
        title: 'Vitamin C Super Serum Plus - Jumbo',
        canonical_url: 'https://naturium.com/products/vitamin-c-super-serum-plus-jumbo',
        seed_data: {
          brand: 'Naturium',
          description:
            'A supercharged, multi-benefit serum with vitamin C, retinol, niacinamide and salicylic acid.',
          ingredient_tokens: ['Vitamin C', 'Retinol', 'Niacinamide', 'Salicylic Acid'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_naturium_vitamin_c',
        sellable_item_group_id: 'sig_naturium_vitamin_c',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const azelaicBundle = buildBundle({
      seed: {
        external_product_id: 'ext_naturium_azelaic',
        title: 'Azelaic Acid Derivative Complex 10% - Jumbo',
        canonical_url: 'https://naturium.com/products/azelaic-acid-derivative-complex-10-jumbo',
        seed_data: {
          brand: 'Naturium',
          description:
            'Double up and save with this jumbo size of our topical azelaic acid serum containing niacinamide, vitamin C and coffee seed extract to help improve.',
          ingredient_tokens: ['Potassium Azeloyl Diglycinate', 'Niacinamide', 'Ethyl Ascorbic Acid'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_naturium_azelaic',
        sellable_item_group_id: 'sig_naturium_azelaic',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const genericMenuBundle = buildBundle({
      seed: {
        external_product_id: 'ext_naturium_barrier',
        title: 'Marshmallow Root Barrier Balm',
        canonical_url: 'https://naturium.com/products/marshmallow-root-barrier-balm',
        seed_data: {
          brand: 'Naturium',
          description:
            'Our balm is formulated with a soothing blend of marshmallow root, centella asiatica, colloidal oatmeal, arnica and milk thistle.',
          ingredient_tokens: [
            'Panthenol (B5), Niacinamide, Salicylic acid, Azelaic acid, Vitamin C (Ascorbic acid), Retinol, Glycerin, Hyaluronic acid, Alpha Arbutin, Squalane, Centella',
          ],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_naturium_barrier',
        sellable_item_group_id: 'sig_naturium_barrier',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(sprayBundle.shopping_card.subtitle).toBe('Body Treatment');
    expect(sprayBundle.shopping_card.highlight).toBe('Body blemish spray detail');
    expect(JSON.stringify(sprayBundle)).not.toMatch(/fragrance|acne-fighting|clears and prevents|4 FL OZ|120 ML/i);
    expect(balmBundle.shopping_card.subtitle).toBe('Cleanser');
    expect(balmBundle.shopping_card.highlight).toBe('Cleanser formula detail');
    expect(balmBundle.product_intel_core.what_it_is.body).toContain('Naturium cleanser');
    expect(vitaminCBundle.shopping_card.highlight).toBe('Vitamin C serum detail');
    expect(azelaicBundle.shopping_card.highlight).toBe('Azelaic acid serum detail');
    expect(azelaicBundle.product_intel_core.what_it_is.body).toContain("This jumbo size is the brand's topical azelaic acid serum");
    expect(azelaicBundle.product_intel_core.what_it_is.body).not.toMatch(/save|help improve\./i);
    expect(genericMenuBundle.shopping_card.subtitle).toBe('Moisturizer');
    expect(genericMenuBundle.evidence_profile).toBe('official_pdp_seed');
    expect(JSON.stringify(genericMenuBundle)).not.toMatch(/Formula context captured|Alpha Arbutin|Retinol/i);
    expect(
      buildBundle({
        seed: {
          external_product_id: 'ext_naturium_niacinamide',
          title: 'Niacinamide Serum 12% Plus Zinc 2% - Jumbo',
          canonical_url: 'https://naturium.com/products/niacinamide-serum-12-plus-zinc-2-jumbo',
          seed_data: {
            brand: 'Naturium',
            description: 'A concentrated niacinamide serum with zinc PCA.',
          },
        },
        inventoryRow: {
          external_product_id: 'ext_naturium_niacinamide',
          sellable_item_group_id: 'sig_naturium_niacinamide',
        },
        generatedAt: '2026-05-24T00:00:00.000Z',
        batchName: 'test_batch',
        reviewer: 'codex_test',
      }).shopping_card.highlight,
    ).toBe('Niacinamide serum detail');
  });

  test('classifies Rare Beauty luminizer, lip cream, and hand cream without generic fallback', () => {
    expect(
      inferKind(
        'Positive Light Liquid Luminizer Mini',
        '',
        '',
        'A mini version of our liquid highlighte r with a dewy glow that also nourish es.',
      ),
    ).toBe('highlighter');
    expect(inferKind('Lip Soufflé Matte Lip Cream', '', '', 'A matte lip cream.')).toBe('lip');
    expect(inferKind('Find Comfort Hydrating Hand Cream', '', '', 'A hydrating hand cream.')).toBe(
      'hand_cream',
    );

    const luminizerBundle = buildBundle({
      seed: {
        external_product_id: 'ext_rare_luminizer',
        title: 'Positive Light Liquid Luminizer Mini',
        canonical_url: 'https://rarebeauty.com/products/positive-light-liquid-luminizer-mini',
        seed_data: {
          brand: 'Rare Beauty',
          description:
            'A mini version of our liquid highlighte r. Keep your skin looking on the bright side all day with a dewy, buildable glow that also nourish es.',
          ingredient_tokens: ['Lotus Extract', 'Gardenia Extract', 'White Water Lily'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_rare_luminizer',
        sellable_item_group_id: 'sig_rare_luminizer',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const lipCreamBundle = buildBundle({
      seed: {
        external_product_id: 'ext_rare_lip_cream',
        title: 'Lip Soufflé Matte Lip Cream',
        canonical_url: 'https://rarebeauty.com/products/lip-souffle-matte-lip-cream',
        seed_data: {
          brand: 'Rare Beauty',
          description: 'A weightless matte lip cream.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_rare_lip_cream',
        sellable_item_group_id: 'sig_rare_lip_cream',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const handCreamBundle = buildBundle({
      seed: {
        external_product_id: 'ext_rare_hand_cream',
        title: 'Find Comfort Hydrating Hand Cream',
        canonical_url: 'https://rarebeauty.com/products/find-comfort-hydrating-hand-cream',
        seed_data: {
          brand: 'Rare Beauty',
          description: 'A hydrating hand cream for daily use.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_rare_hand_cream',
        sellable_item_group_id: 'sig_rare_hand_cream',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(luminizerBundle.shopping_card.subtitle).toBe('Highlighter');
    expect(luminizerBundle.shopping_card.highlight).toBe('Light-diffusing glow');
    expect(JSON.stringify(luminizerBundle)).not.toMatch(/beauty product|highlighte r|nourish es/i);
    expect(lipCreamBundle.shopping_card.subtitle).toBe('Lip Product');
    expect(lipCreamBundle.shopping_card.highlight).toBe('Matte lip formula detail');
    expect(handCreamBundle.shopping_card.subtitle).toBe('Hand Cream');
    expect(handCreamBundle.shopping_card.highlight).toBe('Hand cream format detail');
  });

  test('keeps Fenty essentials out of single-item batches and avoids generic highlights', () => {
    const baseCandidate = {
      domain: 'fentybeauty.com',
      recommended_lane: 'lane_3_kb_rewrite_review',
      seed_missing_fields: '',
      identity_status: 'approved',
      identity_live_read_enabled: true,
      kb_direct_high_quality_ready: false,
      kb_direct_human_reviewed: true,
      kb_direct_quality_state: 'reviewed',
      kb_direct_evidence_profile: 'seller_only',
      main_blocker: 'kb_blocked',
      catalog_attached: true,
      index_serving_eligible: true,
      commerce_doc_public: true,
      terminal_hold: false,
    };

    expect(
      inferKind(
        'Lip Sav’rs Lip Care Essentials',
        '',
        '',
        'Ultra-hydrating lip treatments to soften and smooth dry, chapped lips.',
      ),
    ).toBe('lip_set');
    expect(
      inferKind(
        'Slick-Back Styling Essentials',
        '',
        '',
        'A hair styling gel built around soothing support for hold and styling definition.',
      ),
    ).toBe('hair_care_set');
    expect(
      isConservativeRewriteCandidate(
        { ...baseCandidate, title: 'Lip Sav’rs Lip Care Essentials' },
        { singleItemOnly: true, includeReviewedSellerOnly: true, requirePublicCommerceDoc: true },
      ),
    ).toBe(false);
    expect(
      isConservativeRewriteCandidate(
        { ...baseCandidate, title: 'Slick-Back Styling Essentials' },
        { singleItemOnly: true, includeReviewedSellerOnly: true, requirePublicCommerceDoc: true },
      ),
    ).toBe(false);

    const foundationBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_foundation',
        title: "Soft'lit Naturally Luminous Longwear Foundation - 235",
        canonical_url: 'https://fentybeauty.com/products/softlit-naturally-luminous-longwear-foundation-235',
        seed_data: {
          brand: 'Fenty Beauty',
          description:
            'A foundation for complexion coverage, shade matching, finish control, and longer-wear makeup routines.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_foundation',
        sellable_item_group_id: 'sig_fenty_foundation',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const highlighterBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_highlighter',
        title: "Demi'glow Light-Diffusing Highlighter - Java Jitt'rs",
        canonical_url: 'https://fentybeauty.com/products/demiglow-light-diffusing-highlighter-java-jittrs',
        seed_data: {
          brand: 'Fenty Beauty',
          description:
            'A limited-edition skin tone-based highlighter with a silky-soft feel infused with superfine pearls designed to give a lowkey glow for every tone.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_highlighter',
        sellable_item_group_id: 'sig_fenty_highlighter',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const cleanserBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_cleanser',
        title: 'Melt Awf Jelly Oil Makeup-Melting Cleanser',
        canonical_url: 'https://fentybeauty.com/products/melt-awf-jelly-oil-makeup-melting-cleanser',
        seed_data: {
          brand: 'Fenty Beauty',
          description:
            "Deeply purify pores without stripping with Fenty Skin's cleanser collection. Made to remove all types of makeup + quench skin with skin-loving ingredients.",
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_cleanser',
        sellable_item_group_id: 'sig_fenty_cleanser',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const stylingEssentialsBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_styling',
        title: 'Slick-Back Styling Essentials',
        canonical_url: 'https://fentybeauty.com/products/slick-back-styling-essentials',
        seed_data: {
          brand: 'Fenty Beauty',
          description:
            'A hair styling gel built around ectoin/bisabolol-style soothing support for hold, shape control, and styling definition in hair styling routines.',
          raw_ingredient_text_clean:
            'Amber Bouquet. Fenty Hair’s signature fragrance drips you in notes of warm florals, amber, yuzu, coconut, vanilla + sandalwood.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_styling',
        sellable_item_group_id: 'sig_fenty_styling',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(foundationBundle.shopping_card.highlight).toBe('Luminous longwear base');
    expect(highlighterBundle.shopping_card.highlight).toBe('Light-diffusing glow');
    expect(cleanserBundle.shopping_card.highlight).toBe('Jelly-oil makeup melt');
    expect(stylingEssentialsBundle.evidence_profile).toBe('official_pdp_seed');
    expect(JSON.stringify(stylingEssentialsBundle)).not.toMatch(/Formula context captured|signature fragrance drips/i);
  });

  test('classifies Fenty styling, setting, corrector, and body-care formats without generic fallback', () => {
    expect(inferKind("You Mist Makeup-Extending Setting Spray", '', '', 'A makeup-extending setting spray.')).toBe(
      'setting_spray',
    );
    expect(inferKind('Match Stix Correcting Skinstick - Banana', '', '', 'A correcting skinstick.')).toBe(
      'corrector',
    );
    expect(inferKind('Set it Down Superfine Blurring Setting Powder - Honey', '', '', 'A setting powder.')).toBe(
      'face_powder',
    );
    expect(inferKind('The Gelly Type Strong Hold Gel', '', '', 'A strong hold styling gel.')).toBe(
      'hair_styling',
    );
    expect(
      inferKind(
        'The Protective Type Frizz-Smoothing Heat Protectant Styling Cream',
        '',
        '',
        'A heat protectant styling cream.',
      ),
    ).toBe('hair_styling');
    expect(inferKind('The Homecurl Curl-Defining Cream', '', '', 'A curl-defining cream.')).toBe(
      'hair_styling',
    );
    expect(
      inferKind(
        'Lil Butta Dropz Mini Shimmering Whipped Oil Body Cream Trio',
        '',
        '',
        'A whipped oil body cream trio.',
      ),
    ).toBe('body_care_set');
    expect(inferKind('Hella Extra Mascara-Boosting Lash Primer', '', '', 'A lash primer.')).toBe(
      'eye_makeup',
    );
    expect(inferKind('Grip Trip Hydrating + Plumping Primer', '', '', 'A hydrating primer.')).toBe(
      'primer',
    );

    const settingSprayBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_setting_spray',
        title: 'You Mist Makeup-Extending Setting Spray',
        canonical_url: 'https://fentybeauty.com/products/you-mist-makeup-extending-setting-spray',
        seed_data: {
          brand: 'Fenty Beauty',
          description: 'A makeup-extending setting spray for complexion routines.',
          ingredient_tokens: ['Water', 'Glycerin', 'Film Former'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_setting_spray',
        sellable_item_group_id: 'sig_fenty_setting_spray',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const hairGelBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_hair_gel',
        title: 'The Gelly Type Strong Hold Gel',
        canonical_url: 'https://fentybeauty.com/products/the-gelly-type-strong-hold-gel',
        seed_data: {
          brand: 'Fenty Beauty',
          description: 'A strong hold gel for hair styling routines.',
          ingredient_tokens: ['Water', 'PVP', 'Glycerin'],
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_hair_gel',
        sellable_item_group_id: 'sig_fenty_hair_gel',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(settingSprayBundle.shopping_card.subtitle).toBe('Setting Spray');
    expect(settingSprayBundle.shopping_card.highlight).toBe('Makeup setting spray');
    expect(hairGelBundle.shopping_card.subtitle).toBe('Hair Styling');
    expect(hairGelBundle.shopping_card.highlight).toBe('Hair gel format detail');
    expect(JSON.stringify([settingSprayBundle, hairGelBundle])).not.toMatch(/beauty product|skincare product/i);
  });

  test('classifies remaining Fenty seller-only accessories and bundles without low-quality fallback', () => {
    expect(inferKind("Showstopp'r Football Sponge", '', '', 'A football-shape makeup sponge.')).toBe(
      'makeup_applicator',
    );
    expect(inferKind('Patch Ya Bags Reusable Under Eye Masks', '', '', 'Reusable under eye masks.')).toBe(
      'eye_treatment',
    );
    expect(inferKind("Smurfette n' Reflect Handheld Beauty Mirror", '', '', 'A handheld beauty mirror.')).toBe(
      'beauty_accessory',
    );
    expect(inferKind('Gloss Bomb Key Chain', '', '', 'A key chain accessory.')).toBe('beauty_accessory');
    expect(inferKind('Fuzzy Gloss Bomb Holder', '', '', 'A gloss holder accessory.')).toBe(
      'beauty_accessory',
    );
    expect(
      inferKind('Fenty Icon The Case Semi-Matte Refillable Lipstick — Navy Edition', '', '', 'A refillable lipstick case.'),
    ).toBe('beauty_accessory');
    expect(inferKind("Fenty Skin Travel-Size Start'r Set with Mineral SPF - EU", '', '', 'A skin set with SPF.')).toBe(
      'skincare_set',
    );
    expect(inferKind('Butta Drop Body Care Bundle', '', '', 'A body care and fragrance bundle.')).toBe(
      'body_care_set',
    );
    expect(inferKind('Build Your Own AM + PM Moisturizer Bundle', '', '', 'A moisturizer bundle.')).toBe(
      'skincare_set',
    );
    expect(inferKind('Build Your Own Blush + Brush Bundle', '', '', 'A blush and brush bundle.')).toBe(
      'makeup_set',
    );
    expect(inferKind('Match Stix Shimmer Skinstick - Starstruck', '', '', 'A shimmer skinstick.')).toBe(
      'highlighter',
    );
    expect(inferKind('Invisimatte Blotting Paper Refill', '', '', 'A blotting paper refill in a compact.')).toBe(
      'blotting_paper',
    );
    expect(inferKind('Slick-Back Styling Essentials', '', '', 'A hair styling gel set.')).toBe('hair_care_set');
    expect(inferKind('Build Your Own Maintenance Crew Bundle', '', '', 'Shop Fenty Hair to repair hair.')).toBe(
      'hair_care_set',
    );
    expect(
      inferKind('Build Your Own Body Care + Fragrance Bundle', '', '', 'Hydration plus spicy floral fragrance.'),
    ).toBe('body_care_set');
    expect(inferKind('Glossy Posse VIII 3-Piece Lip Luminizer Set', '', '', 'Shop lip gloss.')).toBe(
      'lip_set',
    );
    expect(inferKind('Lux Balm Trio', '', '', 'A lip balm essentials set.')).toBe('lip_set');
    expect(inferKind('Build Your Own 5-Piece Lip Gloss Vault', '', '', 'A customizable lip routine.')).toBe(
      'lip_set',
    );
    expect(inferKind('Double Gloss Lip Layering Duo', '', '', 'Lip gloss layering duo.')).toBe('lip_set');
    expect(inferKind('Build Your Own Prime + Set Bundle', '', '', 'Choose primer + setting powder + setting spray.')).toBe(
      'makeup_set',
    );
    expect(sanitizePublicSourceText('Bleenndd, perfeeccttt, HIKE!')).not.toMatch(/perfect|perfeeccttt/i);
    expect(sanitizePublicSourceText('A perfect wash of color.')).toContain('sheer wash of color');
    expect(
      sanitizePublicSourceText(
        'An ultra comfortable sheer lipstick with the perfect amount of nourishing color and shine.',
      ),
    ).not.toMatch(/\bperfect\b/i);
    expect(sanitizePublicSourceText('NEW! Free Fuzzy Gloss Bomb Holder on + orders.')).not.toMatch(
      /\b(?:free|orders?)\b/i,
    );

    const spongeBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_football_sponge',
        title: "Showstopp'r Football Sponge",
        canonical_url: 'https://fentybeauty.com/products/showstoppr-football-sponge',
        seed_data: {
          brand: 'Fenty Beauty',
          description:
            'Bleenndd, perfeeccttt, HIKE! Get that Fenty Face game-day ready with this seasonal sponge in a football-shape design.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_football_sponge',
        sellable_item_group_id: 'sig_fenty_football_sponge',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const mirrorBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_mirror',
        title: "Smurfette n' Reflect Handheld Beauty Mirror",
        canonical_url: 'https://fentybeauty.com/products/smurfette-reflect-handheld-beauty-mirror',
        seed_data: {
          brand: 'Fenty Beauty',
          description: 'A handheld beauty mirror for makeup routines.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_mirror',
        sellable_item_group_id: 'sig_fenty_mirror',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const blottingBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_blotting_paper',
        title: 'Invisimatte Blotting Paper Refill',
        canonical_url: 'https://fentybeauty.com/products/invisimatte-blotting-paper-refill',
        seed_data: {
          brand: 'Fenty Beauty',
          description:
            'Ultra portable blotting paper that lets you touch up in stealth mode, made to refill the mirrored compact that looks like a lipstick case.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_blotting_paper',
        sellable_item_group_id: 'sig_fenty_blotting_paper',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const hairSetBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_hair_set',
        title: 'Slick-Back Styling Essentials',
        canonical_url: 'https://fentybeauty.com/products/slick-back-styling-essentials',
        seed_data: {
          brand: 'Fenty Beauty',
          description:
            'A hair styling gel built around ectoin/bisabolol-style soothing support for hold, shape control, and styling definition in hair styling routines.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_hair_set',
        sellable_item_group_id: 'sig_fenty_hair_set',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const powderBrushBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_powder_brush',
        title: 'Build Your Own Setting Powder + Brush Bundle',
        canonical_url: 'https://fentybeauty.com/products/build-your-own-setting-powder-brush-bundle',
        seed_data: {
          brand: 'Fenty Beauty',
          description: 'Keep your look fresh with a setting powder + compatible brush of your choice.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_powder_brush',
        sellable_item_group_id: 'sig_fenty_powder_brush',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const lipGlossBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_lip_gloss_vault',
        title: 'Build Your Own 5-Piece Lip Gloss Vault',
        canonical_url: 'https://fentybeauty.com/products/build-your-own-lip-gloss-vault',
        seed_data: {
          brand: 'Fenty Beauty',
          description: 'Prep, line + fill your pout with this customizable lip routine.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_lip_gloss_vault',
        sellable_item_group_id: 'sig_fenty_lip_gloss_vault',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const keychainBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_keychain',
        title: 'Gloss Bomb Key Chain',
        canonical_url: 'https://fentybeauty.com/products/gloss-bomb-key-chain',
        seed_data: {
          brand: 'Fenty Beauty',
          description: 'NEW! Free Fuzzy Gloss Bomb Holder on + orders.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_keychain',
        sellable_item_group_id: 'sig_fenty_keychain',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const lipLinerBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_lip_liner',
        title: "Trace'd Out Longwear Waterproof Pencil Lip Liner — Extra Thigh",
        canonical_url: 'https://fentybeauty.com/products/traced-out-pencil-lip-liner',
        seed_data: {
          brand: 'Fenty Beauty',
          description: 'An eyeliner for defining lash lines and shaping eye looks.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_lip_liner',
        sellable_item_group_id: 'sig_fenty_lip_liner',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });
    const lipstickCaseBundle = buildBundle({
      seed: {
        external_product_id: 'ext_fenty_icon_case',
        title: 'Fenty Icon The Case Semi-Matte Refillable Lipstick — Navy Edition',
        canonical_url: 'https://fentybeauty.com/products/fenty-icon-case-navy-edition',
        seed_data: {
          brand: 'Fenty Beauty',
          description:
            'Fenty Icon is made to be seen. The Fill and the Case were designed to work together, so pair your fave shade with this ultra-luxe case.',
        },
      },
      inventoryRow: {
        external_product_id: 'ext_fenty_icon_case',
        sellable_item_group_id: 'sig_fenty_icon_case',
      },
      generatedAt: '2026-05-24T00:00:00.000Z',
      batchName: 'test_batch',
      reviewer: 'codex_test',
    });

    expect(spongeBundle.shopping_card.subtitle).toBe('Makeup Applicator');
    expect(spongeBundle.shopping_card.highlight).toBe('Makeup sponge format detail');
    expect(mirrorBundle.shopping_card.subtitle).toBe('Beauty Accessory');
    expect(mirrorBundle.shopping_card.highlight).toBe('Accessory format detail');
    expect(blottingBundle.shopping_card.subtitle).toBe('Blotting Paper');
    expect(blottingBundle.shopping_card.highlight).toBe('Oil-blotting paper refill');
    expect(hairSetBundle.shopping_card.subtitle).toBe('Hair Care Set');
    expect(hairSetBundle.shopping_card.highlight).toBe('Hair styling set');
    expect(powderBrushBundle.shopping_card.subtitle).toBe('Makeup Set');
    expect(powderBrushBundle.shopping_card.highlight).toBe('Setting powder and brush set');
    expect(lipGlossBundle.shopping_card.subtitle).toBe('Lip Set');
    expect(lipGlossBundle.shopping_card.highlight).toBe('Lip gloss routine set');
    expect(keychainBundle.shopping_card.subtitle).toBe('Beauty Accessory');
    expect(lipLinerBundle.shopping_card.subtitle).toBe('Lip Product');
    expect(lipLinerBundle.shopping_card.intro).toContain('lip liner');
    expect(lipstickCaseBundle.shopping_card.subtitle).toBe('Beauty Accessory');
    expect(JSON.stringify([
      spongeBundle,
      mirrorBundle,
      blottingBundle,
      hairSetBundle,
      powderBrushBundle,
      lipGlossBundle,
      keychainBundle,
      lipLinerBundle,
      lipstickCaseBundle,
    ])).not.toMatch(
      /beauty product|perfeeccttt|perfect amount|\bfree\b|\borders?\b|eyeliner for defining lash|lip product listed on the official source page as Invisimatte/i,
    );
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
        title: 'Vitamin-C Serum',
        kb_direct_quality_state: 'reviewed',
        kb_direct_evidence_profile: 'seller_only',
        main_blocker: 'kb_blocked',
      }),
    ).toBe(false);
    expect(
      isConservativeRewriteCandidate(
        {
          ...base,
          title: 'Vitamin-C Serum',
          kb_direct_quality_state: 'reviewed',
          kb_direct_evidence_profile: 'seller_only',
          main_blocker: 'kb_blocked',
        },
        { includeReviewedSellerOnly: true },
      ),
    ).toBe(true);
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
    expect(
      isConservativeRewriteCandidate(
        { ...base, title: 'Misting Must-Haves' },
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
    expect(
      isConservativeRewriteCandidate({
        ...base,
        title: 'Vitamin-C Tonic Travel Size',
        kb_direct_human_reviewed: false,
        kb_direct_quality_state: 'limited',
        kb_direct_evidence_profile: 'seller_only',
        kb_direct_blocking_issues: 'not_reviewed|not_displayable_gate',
        main_blocker: 'kb_blocked',
      }),
    ).toBe(false);
    expect(
      isConservativeRewriteCandidate(
        {
          ...base,
          title: 'Vitamin-C Tonic Travel Size',
          kb_direct_human_reviewed: false,
          kb_direct_quality_state: 'limited',
          kb_direct_evidence_profile: 'seller_only',
          kb_direct_blocking_issues: 'not_reviewed|not_displayable_gate',
          main_blocker: 'kb_blocked',
        },
        { includeNotReviewedOfficialSource: true },
      ),
    ).toBe(true);
    expect(
      isConservativeRewriteCandidate(
        {
          ...base,
          title: 'Vitamin-C Tonic Travel Size',
          kb_direct_human_reviewed: false,
          kb_direct_quality_state: 'limited',
          kb_direct_evidence_profile: 'seller_only',
          kb_direct_blocking_issues: 'not_reviewed|missing_card_highlight',
          main_blocker: 'kb_blocked',
        },
        { includeNotReviewedOfficialSource: true },
      ),
    ).toBe(false);
    expect(
      isConservativeRewriteCandidate(
        {
          ...base,
          title: 'Vitamin-C Tonic Travel Size',
          kb_direct_human_reviewed: false,
          kb_direct_quality_state: 'limited',
          kb_direct_evidence_profile: 'seller_only',
          kb_direct_blocking_issues: 'not_reviewed|not_displayable_gate',
          main_blocker: 'kb_blocked',
          commerce_doc_public: false,
        },
        { includeNotReviewedOfficialSource: true },
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
        external_product_id: 'reviewed_seller_only',
        domain: 'pixibeauty.com',
        title: 'Vitamin-C Serum',
        recommended_lane: 'lane_3_kb_rewrite_review',
        seed_missing_fields: '',
        identity_status: 'approved',
        identity_live_read_enabled: true,
        kb_direct_high_quality_ready: false,
        kb_direct_human_reviewed: true,
        kb_direct_quality_state: 'reviewed',
        kb_direct_evidence_profile: 'seller_only',
        main_blocker: 'kb_blocked',
        catalog_attached: true,
        index_serving_eligible: true,
        commerce_doc_public: true,
        terminal_hold: false,
      },
      {
        external_product_id: 'not_reviewed_official_source',
        domain: 'pixibeauty.com',
        title: 'Vitamin-C Cleansing Cloths',
        recommended_lane: 'lane_3_kb_rewrite_review',
        seed_missing_fields: '',
        identity_status: 'approved',
        identity_live_read_enabled: true,
        kb_direct_high_quality_ready: false,
        kb_direct_human_reviewed: false,
        kb_direct_quality_state: 'limited',
        kb_direct_evidence_profile: 'seller_only',
        kb_direct_blocking_issues: 'not_reviewed|not_displayable_gate',
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

    expect(
      selectInventoryRows(rows, {
        domain: 'pixibeauty.com',
        lane: 'lane_3_kb_rewrite_review',
        limit: 10,
        requirePublicCommerceDoc: true,
        singleItemOnly: true,
        includeReviewedSellerOnly: true,
      }).map((row) => row.external_product_id),
    ).toEqual(['safe', 'reviewed_seller_only']);

    expect(
      selectInventoryRows(rows, {
        domain: 'pixibeauty.com',
        lane: 'lane_3_kb_rewrite_review',
        limit: 10,
        requirePublicCommerceDoc: true,
        singleItemOnly: true,
        includeNotReviewedOfficialSource: true,
      }).map((row) => row.external_product_id),
    ).toEqual(['safe', 'not_reviewed_official_source']);
  });
});
