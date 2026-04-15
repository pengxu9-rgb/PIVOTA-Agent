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

  test('does not misread "outfit" as the short tom ford alias "tf"', () => {
    expect(detectBrandEntities('zara blazer outfit', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: ['zara'],
      }),
    );
    expect(detectBrandEntities('mango dress outfit', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: ['mango'],
      }),
    );
  });

  test('detects common beauty and luxury brands used by public search', () => {
    expect(detectBrandEntities('the ordinary', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['the ordinary']),
      }),
    );
    expect(detectBrandEntities('charlotte tilbury', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['charlotte tilbury']),
      }),
    );
    expect(detectBrandEntities('nars', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['nars']),
      }),
    );
    expect(detectBrandEntities('la mer', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['la mer']),
      }),
    );
    expect(detectBrandEntities('la roche-posay', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['la roche posay']),
      }),
    );
    expect(detectBrandEntities("kiehl's", { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(["kiehl s"]),
      }),
    );
    expect(detectBrandEntities('mac', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['mac cosmetics', 'mac']),
      }),
    );
    expect(detectBrandEntities('estee lauder', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['estee lauder']),
      }),
    );
    expect(detectBrandEntities('lancome', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['lancome']),
      }),
    );
    expect(detectBrandEntities('milk makeup', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['milk makeup']),
      }),
    );
    expect(detectBrandEntities('tower 28', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['tower 28 beauty', 'tower 28']),
      }),
    );
    expect(detectBrandEntities('supergoop', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['supergoop']),
      }),
    );
    expect(detectBrandEntities('summer fridays lip balm', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['summer fridays']),
      }),
    );
    expect(detectBrandEntities("paula's choice", { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['paula s choice']),
      }),
    );
    expect(detectBrandEntities('naturium', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['naturium']),
      }),
    );
    expect(detectBrandEntities('dermalogica', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['dermalogica']),
      }),
    );
    expect(detectBrandEntities('moroccanoil', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['moroccanoil']),
      }),
    );
    expect(detectBrandEntities('gisou hair oil', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['gisou']),
      }),
    );
  });

  test('keeps short beauty brand aliases token-boundary safe', () => {
    expect(detectBrandEntities('macbook case', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: false,
        brands: [],
      }),
    );
    expect(detectBrandEntities('ysl lipstick', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: true,
        brands: expect.arrayContaining(['yves saint laurent', 'ysl']),
      }),
    );
    expect(detectBrandEntities('outfit', { candidateProducts: [] })).toEqual(
      expect.objectContaining({
        brand_like: false,
        brands: [],
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
