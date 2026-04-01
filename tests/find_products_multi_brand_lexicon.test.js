const {
  detectBrandEntities,
  hasExplicitCategoryHint,
  buildBrandQueryVariants,
} = require('../src/findProductsMulti/brandLexicon');

describe('findProductsMulti brand lexicon', () => {
  test('detects apparel and footwear brands used by creator search', () => {
    expect(detectBrandEntities('zara blazer', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['zara']),
      }),
    );
    expect(detectBrandEntities('uniqlo cardigan', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['uniqlo']),
      }),
    );
    expect(detectBrandEntities('alo yoga set', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['alo yoga']),
      }),
    );
    expect(detectBrandEntities('free people dress', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['free people']),
      }),
    );
  });

  test('treats fashion category terms as explicit category hints', () => {
    expect(hasExplicitCategoryHint('zara blazer')).toBe(true);
    expect(hasExplicitCategoryHint('uniqlo cardigan')).toBe(true);
    expect(hasExplicitCategoryHint('new balance sneakers')).toBe(true);
    expect(hasExplicitCategoryHint('skims sleepwear')).toBe(true);
    expect(hasExplicitCategoryHint('alo yoga')).toBe(false);
  });

  test('keeps useful brand query variants for multi-word fashion brands', () => {
    expect(buildBrandQueryVariants('free people dress', ['free people'])).toEqual(
      expect.arrayContaining(['free people dress', 'free people', 'freepeople']),
    );
    expect(buildBrandQueryVariants('arc teryx jacket', ['arc teryx'])).toEqual(
      expect.arrayContaining(['arc teryx jacket', 'arc teryx', 'arcteryx']),
    );
  });
});
