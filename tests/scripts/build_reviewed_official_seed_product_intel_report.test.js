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
  });

  test('classifies Pixi spot and treatment formats without generic Beauty Product fallback', () => {
    expect(inferKind('Overnight Spot Stickers', '', '', 'Blemish spot stickers for targeted use.')).toBe(
      'blemish_patch',
    );
    expect(inferKind('Overnight Retinol Oil', '', '', 'Retinol oil for smoother-looking skin.')).toBe('skincare');
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
