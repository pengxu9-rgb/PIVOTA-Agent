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
