const { extractIntentRuleBased } = require('../src/findProductsMulti/intent');
const { applyFindProductsMultiPolicy } = require('../src/findProductsMulti/policy');

function makeRawProduct(overrides) {
  return {
    id: overrides?.id || 'p1',
    title: overrides?.title || 'Default Product',
    description: overrides?.description || 'Default description',
    price: overrides?.price ?? 10,
    currency: overrides?.currency || 'USD',
    image_url: overrides?.image_url || 'https://example.com/x.png',
    inventory_quantity: overrides?.inventory_quantity ?? 10,
    ...(overrides || {}),
  };
}

describe('find_products_multi intent + filtering', () => {
  test('intent: cold mountain outerwear is human_apparel and ignores toy history', () => {
    const intent = extractIntentRuleBased(
      '周末要去山上，天气会很冷，推荐几件外套/大衣吧',
      ['Labubu 娃娃衣服', '公仔 配件', '盲盒'],
      []
    );

    expect(intent.primary_domain).toBe('human_apparel');
    expect(intent.target_object.type).toBe('human');
    expect(intent.history_usage.used).toBe(false);
    expect(intent.hard_constraints.must_exclude_keywords).toEqual(
      expect.arrayContaining(['Labubu', 'doll', 'toy', '娃娃'])
    );
    expect(intent.history_usage.ignored_queries).toEqual(
      expect.arrayContaining(['Labubu 娃娃衣服', '公仔 配件', '盲盒'])
    );
  });

  test('filters toy products out for human outerwear intent; weak tier when <3 matches', () => {
    const intent = extractIntentRuleBased(
      '周末要去山上，天气会很冷，推荐几件外套/大衣吧',
      ['Labubu 娃娃衣服'],
      []
    );

    const toys = Array.from({ length: 10 }).map((_, i) =>
      makeRawProduct({
        id: `toy-${i}`,
        title: 'Labubu doll clothes set',
        description: 'Cute doll outfit for Labubu-style vinyl face doll',
      })
    );
    const humans = [
      makeRawProduct({
        id: 'h1',
        title: 'Warm Down Jacket',
        description: 'A warm down jacket for cold weather',
      }),
      makeRawProduct({
        id: 'h2',
        title: 'Windproof Hiking Shell Jacket',
        description: 'Windproof waterproof shell jacket for hiking',
      }),
    ];

    const resp = applyFindProductsMultiPolicy({
      response: { products: [...toys, ...humans], reply: null },
      intent,
      requestPayload: { search: { query: 'x' } },
    });

    expect(resp.products).toHaveLength(2);
    expect(resp.products.map((p) => p.id)).toEqual(expect.arrayContaining(['h1', 'h2']));
    expect(resp.products.find((p) => String(p.id).startsWith('toy-'))).toBeUndefined();
    expect(resp.has_good_match).toBe(false);
    expect(['weak', 'none']).toContain(resp.match_tier);
    expect(resp.reason_codes).toEqual(expect.arrayContaining(['WEAK_RELEVANCE']));
  });

  test('filters to empty → has_good_match=false, match_tier=none and reason codes present', () => {
    const intent = extractIntentRuleBased(
      '周末要去山上，天气会很冷，推荐几件外套/大衣吧',
      ['Labubu 娃娃衣服'],
      []
    );

    const toys = Array.from({ length: 6 }).map((_, i) =>
      makeRawProduct({
        id: `toy-${i}`,
        title: 'Cute bunny outfit for Labubu doll',
        description: 'Doll clothes and accessories for toy figures',
      })
    );

    const resp = applyFindProductsMultiPolicy({
      response: { products: toys, reply: null },
      intent,
      requestPayload: { search: { query: 'x' } },
    });

    expect(resp.products).toHaveLength(0);
    expect(resp.has_good_match).toBe(false);
    expect(resp.match_tier).toBe('none');
    expect(resp.reason_codes).toEqual(
      expect.arrayContaining(['NO_DOMAIN_MATCH', 'FILTERED_TO_EMPTY'])
    );
  });
});

