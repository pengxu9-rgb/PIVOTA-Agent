const {
  createCatalogCacheRuntime,
} = require('../../src/commerce/catalog/cacheSearchRuntime');

function buildRuntime(overrides = {}) {
  return createCatalogCacheRuntime({
    logger: {
      warn: jest.fn(),
    },
    queryDb: jest.fn().mockResolvedValue({ rows: [] }),
    config: {
      searchLimitMax: 20,
      findProductsMultiVectorEnabled: false,
      hasDatabase: false,
      ...(overrides.config || {}),
    },
    helpers: {
      getCreatorConfig: jest.fn().mockReturnValue({ merchantIds: ['m1'] }),
      buildSellableStatusPredicate: jest.fn().mockReturnValue('TRUE'),
      isProductSellable: jest.fn().mockReturnValue(true),
      applyShopifyCurrencyOverride: jest.fn().mockResolvedValue(undefined),
      buildUnderwearExclusionSql: jest.fn().mockImplementation((startIndex) => ({
        sql: 'TRUE',
        params: [],
        nextIndex: startIndex,
      })),
      detectToyOutfitIntentFromQuery: jest.fn().mockReturnValue({
        toy_intent: false,
        outfit_intent: false,
        lingerie_intent: false,
      }),
      tokenizeQueryForCache: jest
        .fn()
        .mockImplementation((value) => String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean)),
      looksSkuLikeQuery: jest.fn().mockReturnValue(false),
      scoreByTagFacetOverlap: jest.fn().mockReturnValue({ score: 0 }),
      scorePairOverlap: jest.fn().mockReturnValue({ score: 0 }),
      embedText: jest.fn(),
      semanticSearchCreatorProductsFromCache: jest.fn(),
      ...(overrides.helpers || {}),
    },
  });
}

describe('createCatalogCacheRuntime', () => {
  test('loadCreatorSellableFromCache throws UNKNOWN_CREATOR when creator config is missing', async () => {
    const runtime = buildRuntime({
      helpers: {
        getCreatorConfig: jest.fn().mockReturnValue(null),
      },
    });

    await expect(runtime.loadCreatorSellableFromCache('missing')).rejects.toMatchObject({
      code: 'UNKNOWN_CREATOR',
    });
  });

  test('detects pet and beauty search signals', () => {
    const runtime = buildRuntime();

    expect(runtime.hasPetSearchSignal('best dog leash')).toBe(true);
    expect(runtime.hasPetHarnessSearchSignal('small dog harness')).toBe(true);
    expect(runtime.hasPetLeashSearchSignal('need a puppy leash')).toBe(true);
    expect(runtime.hasBeautyMakeupSearchSignal('foundation and lipstick')).toBe(true);
    expect(runtime.hasBeautyCatalogProductSignal('Fenty beauty foundation brush')).toBe(true);
    expect(runtime.hasStrictPetHarnessCatalogSignal('adjustable no-pull dog harness')).toBe(true);
  });

  test('buildPetFallbackQuery keeps harness-specific variants', () => {
    const runtime = buildRuntime();

    expect(runtime.buildPetFallbackQuery({ language: 'zh' }, '想买狗狗牵引绳')).toContain('牵引绳');
    expect(runtime.buildPetFallbackQuery({ language: 'fr' }, 'dog harness')).toContain('harnais');
    expect(runtime.buildPetFallbackQuery({ language: 'en' }, 'warm clothes for dogs')).toContain('dog jacket');
  });

  test('blendBeautyDiversitySupplement dedupes and rotates categories', () => {
    const runtime = buildRuntime();

    const internal = [
      { id: 'p1', title: 'Soft Foundation', product_type: 'foundation' },
      { id: 'p2', title: 'Eye Palette', product_type: 'eyeshadow' },
      { id: 'p3', title: 'Brush Set', product_type: 'brush' },
    ];
    const supplement = [
      { id: 'p2', title: 'Eye Palette', product_type: 'eyeshadow' },
      { id: 'p4', title: 'Lip Tint', product_type: 'lipstick' },
      { id: 'p5', title: 'Hydrating Serum', product_type: 'serum' },
    ];

    const result = runtime.blendBeautyDiversitySupplement(internal, supplement, 5);
    expect(result.map((item) => item.id)).toEqual(['p1', 'p2', 'p4', 'p5', 'p3']);
  });
});
