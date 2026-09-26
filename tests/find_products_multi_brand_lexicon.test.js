const {
  detectBrandEntities,
  hasExplicitCategoryHint,
  buildBrandQueryVariants,
  resolveBeautyBrandBrowseQuery,
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

  // A multi-word alias must never span the gap between OTHER words'
  // characters: "r co" (r_and_co) is a substring of "hai[r co]nditioner",
  // so every "<word ending in r> conditioner" query resolved the R+Co brand
  // and — through the search-quality contract's brand_mismatch constraint —
  // served only R+Co products or near-zero. Same for the compacted form
  // ("rco" inside "hairconditioner"). 156 of the 168 static aliases were
  // mid-word matchable before the token-boundary fix.
  test.each([
    ['hair conditioner'],
    ['repair conditioner'],
    ['color conditioner'],
    ['silver conditioner'],
    ['lavender conditioner'],
    ['curly hair conditioner'],
    ['leave-in conditioner'],
  ])('multi-word alias "r co" does not span the word gap in %s', (query) => {
    const resolved = resolveBeautyBrandBrowseQuery(query);
    expect(resolved.matched).toBe(false);
    expect(detectBrandEntities(query, { candidateProducts: [] })).toEqual(
      expect.objectContaining({ brand_like: false, brands: [] }),
    );
  });

  test.each([
    ['r co'],
    ['r+co'],
    ['r and co'],
    ['randco'],
    ['r co shampoo'],
    ['r+co conditioner'],
  ])('real R+Co queries still resolve the brand: %s', (query) => {
    const resolved = resolveBeautyBrandBrowseQuery(query);
    expect(resolved.matched).toBe(true);
    expect(resolved.brand_key).toBe('r_and_co');
  });

  test('compact alias forms still match as whole token runs, not mid-word', () => {
    expect(detectBrandEntities('tomford lipstick', { candidateProducts: [] })).toEqual(
      expect.objectContaining({ brand_like: true, brands: expect.arrayContaining(['tom ford']) }),
    );
    // "dior" inside "diorshow" / "nars" inside "lunars" no longer fire:
    // brand credit requires a whole token (run), not a substring of one.
    expect(detectBrandEntities('lunars eyeshadow', { candidateProducts: [] })).toEqual(
      expect.objectContaining({ brand_like: false, brands: [] }),
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
