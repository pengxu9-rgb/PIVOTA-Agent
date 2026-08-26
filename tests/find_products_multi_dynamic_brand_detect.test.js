// GATEWAY_DYNAMIC_BRAND_DETECT — recognize real catalog brands (the long tail
// beyond the ~56 hardcoded static aliases: Skin1004, Anuko, Beauty of Joseon,
// ...) so branded queries stop falling to ingredient/external-seed junk. Node
// analog of pivota-backend #1033, in the service the gateway actually uses.
const { detectBrandEntities } = require('../src/findProductsMulti/brandLexicon');
const brandDict = require('../src/findProductsMulti/brandDictionaryCache');

describe('dynamic catalog brand detection', () => {
  const prev = process.env.GATEWAY_DYNAMIC_BRAND_DETECT;
  afterEach(() => {
    if (prev === undefined) delete process.env.GATEWAY_DYNAMIC_BRAND_DETECT;
    else process.env.GATEWAY_DYNAMIC_BRAND_DETECT = prev;
    brandDict.__setBrandSetForTest([]);
  });

  // skin1004 / anuko are NOT in STATIC_BRAND_ALIASES — genuine long-tail.
  test('flag OFF: long-tail catalog brand NOT detected (byte-identical today)', () => {
    delete process.env.GATEWAY_DYNAMIC_BRAND_DETECT;
    brandDict.__setBrandSetForTest(['skin1004', 'anuko']);
    expect(detectBrandEntities('skin1004 poremizing deep cleansing foam', { candidateProducts: [] }).brand_like).toBe(false);
  });

  test('flag ON: detects a long-tail catalog brand the candidates never surfaced', () => {
    process.env.GATEWAY_DYNAMIC_BRAND_DETECT = '1';
    brandDict.__setBrandSetForTest(['skin1004', 'anuko', 'beauty of joseon']);
    const r = detectBrandEntities('skin1004 poremizing deep cleansing foam', { candidateProducts: [] });
    expect(r.brand_like).toBe(true);
    expect(r.detection_mode).toBe('catalog');
    expect(r.brands).toContain('skin1004');
    const r2 = detectBrandEntities('beauty of joseon glow deep serum', { candidateProducts: [] });
    expect(r2.detection_mode).toBe('catalog'); // multi-token span
    const r3 = detectBrandEntities('anuko nourishing hair butter', { candidateProducts: [] });
    expect(r3.brands).toContain('anuko');
  });

  test('flag ON: generic category queries are NOT over-detected', () => {
    process.env.GATEWAY_DYNAMIC_BRAND_DETECT = '1';
    brandDict.__setBrandSetForTest(['skin1004', 'serum', 'cleanser']);
    for (const q of ['acne cleanser', 'hydrating gel moisturizer', 'gentle face wash']) {
      expect(detectBrandEntities(q, { candidateProducts: [] }).brand_like).toBe(false);
    }
  });

  test('flag ON: existing static brands still win first', () => {
    process.env.GATEWAY_DYNAMIC_BRAND_DETECT = '1';
    brandDict.__setBrandSetForTest([]);
    const r = detectBrandEntities('the ordinary niacinamide', { candidateProducts: [] });
    expect(r.brand_like).toBe(true);
    expect(r.detection_mode).toBe('static');
  });

  // Candidate-derived (not catalog-dictionary) aliases: every >=4-char vendor
  // token used to become a standalone brand alias, so vendor "Briogeo Hair
  // Care" made the bare token "hair" a brand signal and 'hair conditioner'
  // came back brand_like. Generic category nouns must only count inside a
  // multi-token phrase that also carries a distinctive token.
  test('vendor generic noun is NOT a standalone dynamic alias', () => {
    const candidateProducts = [{ vendor: 'Briogeo Hair Care' }];
    for (const q of ['hair conditioner', 'hair mask', 'care package']) {
      const r = detectBrandEntities(q, { candidateProducts });
      expect(r.brand_like).toBe(false);
      expect(r.brands).toEqual([]);
    }
  });

  test('vendor with generic nouns stays detectable via phrase and distinctive token', () => {
    const candidateProducts = [{ vendor: 'Briogeo Hair Care' }];
    const phrase = detectBrandEntities('briogeo hair care shampoo', { candidateProducts });
    expect(phrase.brand_like).toBe(true);
    expect(phrase.detection_mode).toBe('dynamic');
    expect(phrase.brands).toContain('briogeo hair care');
    expect(phrase.brands).not.toContain('hair');
    expect(phrase.brands).not.toContain('care');

    const bare = detectBrandEntities('briogeo shampoo', { candidateProducts });
    expect(bare.brand_like).toBe(true);
    expect(bare.brands).toContain('briogeo');
  });

  test('vendor name made ONLY of generic nouns emits no dynamic aliases', () => {
    const candidateProducts = [{ vendor: 'Hair Care' }, { brand: 'Skin Serum' }];
    for (const q of ['hair care', 'skin serum', 'hair care skin serum']) {
      expect(detectBrandEntities(q, { candidateProducts }).brand_like).toBe(false);
    }
  });

  test('matchCatalogBrand respects min length + flag gate', () => {
    delete process.env.GATEWAY_DYNAMIC_BRAND_DETECT;
    brandDict.__setBrandSetForTest(['anuko']);
    expect(brandDict.matchCatalogBrand('anuko hair butter')).toBe(null); // flag off
    process.env.GATEWAY_DYNAMIC_BRAND_DETECT = '1';
    brandDict.__setBrandSetForTest(['abc']);
    expect(brandDict.matchCatalogBrand('abc serum')).toBe(null); // < min len
    brandDict.__setBrandSetForTest(['anuko']);
    expect(brandDict.matchCatalogBrand('anuko hair butter')).toBe('anuko');
  });
});
