jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
  closePool: jest.fn(async () => {}),
}));

const {
  _internals: {
    extractTirtirFaqHowToUse,
    findTirtirSheetIngredientRow,
    normalizeTirtirTitleKey,
    scoreTirtirSheetProductName,
  },
} = require('../../scripts/backfill-external-seed-official-html-pdp-fields.cjs');

const inci =
  'Water, Glycerin, Butylene Glycol, Niacinamide, Sodium Hyaluronate, Panthenol, Tocopherol, ' +
  'Fragrance, Potassium Cetyl Phosphate, Citric Acid, Adenosine, Disodium EDTA';

describe('backfill-external-seed-official-html-pdp-fields TIRTIR sheet matching', () => {
  test('normalizes TIRTIR title keys without brand or pack noise', () => {
    expect(normalizeTirtirTitleKey('TIRTIR GLOBAL Waterism Glow Tint Set')).toBe(
      'waterism glow tint',
    );
  });

  test('accepts a variant row that starts with the exact PDP product title', () => {
    expect(scoreTirtirSheetProductName('Waterism Glow Tint', 'Waterism Glow Tint 01 Mauve Rose')).toBeGreaterThanOrEqual(0.9);
  });

  test('rejects unrelated sheet products even when broad brand/category tokens overlap', () => {
    expect(scoreTirtirSheetProductName('Mask Fit Makeup Fixer', 'Mask Fit Red Cushion 21N Ivory')).toBeLessThan(0.8);
  });

  test('selects only product-name matched INCI rows from official TIRTIR sheets', () => {
    const rows = [
      ['No.', 'Milk Skin Toner', inci],
      ['No.', 'Mask Fit Red Cushion 21N Ivory', inci],
      ['No.', 'Waterism Glow Tint 01 Mauve Rose', `${inci}, Rosa Damascena Flower Water`],
    ];

    const match = findTirtirSheetIngredientRow(rows, 'Waterism Glow Tint');

    expect(match).toEqual(
      expect.objectContaining({
        productName: 'Waterism Glow Tint 01 Mauve Rose',
        ingredients: expect.stringContaining('Rosa Damascena Flower Water'),
      }),
    );
    expect(match.score).toBeGreaterThanOrEqual(0.8);
  });

  test('fails closed when the sheet has no row for the PDP product', () => {
    const rows = [
      ['No.', 'Milk Skin Toner', inci],
      ['No.', 'Mask Fit Red Cushion 21N Ivory', inci],
    ];

    expect(findTirtirSheetIngredientRow(rows, 'Mask Fit Makeup Fixer')).toBeNull();
  });

  test('extracts how-to copy from current numbered TIRTIR FAQ blocks', () => {
    const faq = `
      Q1. What is the difference between the two sides of the pad, and how should I use each?
      >
      The gauze-textured side provides gentle physical exfoliation - use this side first to sweep across the skin, removing dead skin cells and residual sebum. The soft, smooth side is for essence delivery - use this side after to pat the remaining formula onto areas of redness or sensitivity.
      >
      Q2. Are these pads suitable for sensitive skin?
      >
      Yes, they are formulated for sensitive-looking skin.
    `;

    expect(extractTirtirFaqHowToUse(faq)).toContain('use this side first to sweep');
  });

  test('extracts setting spray directions from numbered FAQ blocks without an A label', () => {
    const faq = `
      Q1. How do I use the Mask Fit Makeup Fixer?
      >
      Hold the bottle about 20-30 cm from your face and spray evenly after completing your makeup. Allow it to dry naturally for a flawless, long-lasting finish.
    `;

    expect(extractTirtirFaqHowToUse(faq)).toContain('spray evenly');
  });
});
