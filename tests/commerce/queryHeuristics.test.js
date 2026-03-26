const {
  createCatalogQueryHeuristics,
} = require('../../src/commerce/catalog/queryHeuristics');

function createHelpers(overrides = {}) {
  return createCatalogQueryHeuristics({
    hasPetSearchSignal: (queryText) => /dog|puppy|pet/i.test(String(queryText || '')),
    hasPetHarnessSearchSignal: (queryText) => /harness|leash|collar/i.test(String(queryText || '')),
    hasBeautyMakeupSearchSignal: (queryText) => /foundation|beauty|lipstick|fenty/i.test(String(queryText || '')),
    ...overrides,
  });
}

describe('catalog query heuristics', () => {
  test('looksSkuLikeQuery detects sku-ish ids and ignores plain words', () => {
    const helpers = createHelpers();

    expect(helpers.looksSkuLikeQuery('AB-12345')).toBe(true);
    expect(helpers.looksSkuLikeQuery('lipstick')).toBe(false);
  });

  test('tokenizeQueryForCache adds domain anchors for pet harness and beauty queries', () => {
    const helpers = createHelpers();

    const petTokens = helpers.tokenizeQueryForCache('best dog harness for puppy');
    expect(petTokens).toEqual(
      expect.arrayContaining(['dog', 'pet', 'harness']),
    );

    const beautyTokens = helpers.tokenizeQueryForCache('Fenty foundation please');
    expect(beautyTokens).toEqual(
      expect.arrayContaining(['fenty', 'foundation', 'makeup']),
    );
  });

  test('detectToyOutfitIntentFromQuery distinguishes toy outfit and lingerie intents', () => {
    const helpers = createHelpers();

    expect(helpers.detectToyOutfitIntentFromQuery('labubu clothes and hat')).toEqual({
      toy_intent: true,
      outfit_intent: true,
      lingerie_intent: false,
    });
    expect(helpers.detectToyOutfitIntentFromQuery('women lingerie set')).toEqual({
      toy_intent: false,
      outfit_intent: false,
      lingerie_intent: true,
    });
  });

  test('buildUnderwearExclusionSql advances bind indexes and emits negative filter', () => {
    const helpers = createHelpers();
    const built = helpers.buildUnderwearExclusionSql(4);

    expect(built.sql).toContain('NOT (');
    expect(built.params[0]).toBe('%lingerie%');
    expect(built.nextIndex).toBe(4 + built.params.length);
  });
});
