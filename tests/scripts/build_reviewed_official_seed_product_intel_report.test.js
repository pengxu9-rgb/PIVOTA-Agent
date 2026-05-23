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
  _internals: { brandFromUrl, buildBundle, inferKind },
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
    expect(inferKind('Lilac Dream Hand & Body Wash', '', '', 'Goat milk body wash.')).toBe('cleanser');
    expect(inferKind('Vanilla Absolute Goat Milk Soap', '', '', 'Goat milk bar soap.')).toBe('cleanser');
    expect(inferKind('Honeyed Grapefruit Hand Salve', '', '', 'Goat milk salve for dry hands.')).toBe('skincare');
    expect(inferKind('Candy Cane Whipped Body Cream', '', '', 'Whipped body cream with cocoa powder.')).toBe(
      'skincare',
    );
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
    expect(peelBundle.shopping_card.highlight).toBe('Exfoliating treatment detail');
    expect(facialBundle.shopping_card.highlight).toBe('Facial treatment detail');
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
        title: 'Sigma x Angela Bright Eyeshadow Palette',
        canonical_url: 'https://sigmabeauty.com/products/sigma-x-angela-bright-eyeshadow-palette',
        seed_data: {
          description: '"It finally happened...the Sigma x Angela Bright Eyeshadow Palette. Not eligible for discounts.',
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
    expect(JSON.stringify(paletteBundle)).not.toMatch(/\.{2,}|discount/i);
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
        'Nina Ubhi Favorites Set',
        '',
        '',
        'This is the only brush set you need. Brushes Included: Sigma Switch, E06 Winged Liner Brush.',
      ),
    ).toBe('brush_set');

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

    expect(brushSetBundle.shopping_card.subtitle).toBe('Brush Set');
    expect(brushSetBundle.shopping_card.highlight).toBe('Brush set format detail');
    expect(brushSetBundle.evidence_profile).toBe('official_pdp_seed');
    expect(JSON.stringify(brushSetBundle)).not.toMatch(/force_fill_contract|Formula context captured/i);
    expect(switchBundle.shopping_card.subtitle).toBe('Brush Care');
    expect(switchBundle.shopping_card.highlight).toBe('Brush-care cleaning detail');
    expect(switchBundle.evidence_profile).toBe('official_pdp_seed');
    expect(JSON.stringify(switchBundle)).not.toMatch(/inci_applicability|Formula context captured/i);
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
    expect(bundle.product_intel_core.what_it_is.body).toContain('Pixibeauty skincare product');
    expect(bundle.product_intel_core.what_it_is.body).not.toContain('Tom Ford');
  });
});
