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
