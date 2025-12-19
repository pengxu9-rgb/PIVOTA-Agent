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
  test('discovery/chitchat intent routes to discovery and asks clarifying question', () => {
    const intent = extractIntentRuleBased('你好', ['Labubu 娃娃衣服', '公仔 配件'], []);
    expect(intent.scenario.name).toBe('discovery');
    expect(intent.ambiguity.needs_clarification).toBe(true);
    expect(intent.history_usage.used).toBe(false);

    const resp = applyFindProductsMultiPolicy({
      response: { products: [], reply: null },
      intent,
      requestPayload: { search: { query: '你好' } },
      metadata: { creator_name: 'Nina Studio' },
    });

    expect(resp.products).toHaveLength(0);
    expect(resp.has_good_match).toBe(false);
    expect(resp.reason_codes).toEqual(expect.arrayContaining(['NEEDS_CLARIFICATION', 'CHITCHAT_ROUTED']));
    expect(String(resp.reply)).toContain('Nina');
  });

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
      expect.arrayContaining(['Labubu', 'doll', '娃娃'])
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

  test('pet hiking apparel query filters out toy featured bleed-through', () => {
    const intent = extractIntentRuleBased(
      "it's fun to see some cute toys. i actually need a jacket for my dog to go hiking. can you find dog's apparel?",
      ['labubu doll clothes', 'blind box'],
      []
    );
    expect(intent.target_object.type).toBe('pet');
    expect(intent.primary_domain).toBe('sports_outdoor');

    const toys = [
      makeRawProduct({
        id: 'toy-1',
        title: 'Cute Rabbit Outfit for Labubu Doll',
        description: 'Doll clothes outfit set',
      }),
    ];
    const pets = [
      makeRawProduct({
        id: 'pet-1',
        title: 'Warm Fall/Winter Utility-Style Overalls for Dogs',
        description: 'Warm overalls for dogs',
      }),
      makeRawProduct({
        id: 'pet-2',
        title: 'Knitted Sweater for Dogs & Cats',
        description: 'A classic knit sweater for pets',
      }),
    ];

    const resp = applyFindProductsMultiPolicy({
      response: { products: [...toys, ...pets], reply: null },
      intent,
      requestPayload: { search: { query: 'dog hiking jacket' } },
    });

    expect(resp.products.map((p) => p.id)).toEqual(expect.arrayContaining(['pet-1', 'pet-2']));
    expect(resp.products.map((p) => p.id)).not.toEqual(expect.arrayContaining(['toy-1']));
  });

  test('pet jacket products are not mis-tagged as human outerwear', () => {
    const intent = extractIntentRuleBased('need a jacket for my dog', [], []);
    expect(intent.target_object.type).toBe('pet');

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'pet-jacket-1',
            title: 'Warm Winter Jacket for Dogs & Cats',
            description: 'A warm jacket for pets',
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: 'dog jacket' } },
    });

    expect(resp.products.map((p) => p.id)).toEqual(['pet-jacket-1']);
  });

  test('stale pivota rule tags do not hard-block pet jackets', () => {
    const intent = extractIntentRuleBased('need a warm jacket for my dog', [], []);
    expect(intent.target_object.type).toBe('pet');

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'pet-jacket-stale-1',
            title: 'Warm Winter Jacket for Dogs & Cats',
            description: 'A warm jacket for pets',
            attributes: {
              pivota: {
                version: 'ann_v1',
                domain: { value: 'human_apparel', confidence: 0.9, source: 'rule_v1' },
                target_object: { value: 'human', confidence: 0.95, source: 'rule_v1' },
                category_path: { value: ['human_apparel', 'outerwear'], confidence: 0.75, source: 'rule_v1' },
              },
            },
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: 'dog jacket' } },
    });

    expect(resp.products.map((p) => p.id)).toEqual(['pet-jacket-stale-1']);
  });

  test('spanish pet hiking apparel query is detected as pet and filters toy items', () => {
    const intent = extractIntentRuleBased(
      'Voy a ir de senderismo con mi perro este fin de semana. Va a hacer frío, por favor encuentra ropa adecuada para mi perro.',
      ['Labubu', 'blind box'],
      []
    );
    expect(intent.language).toBe('es');
    expect(intent.target_object.type).toBe('pet');

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'toy-1',
            title: 'Cute Rabbit Outfit for Labubu Doll',
            description: 'Doll clothes outfit set',
          }),
          makeRawProduct({
            id: 'pet-1',
            title: 'Warm Fall/Winter Utility-Style Overalls for Dogs & Cats',
            description: 'Warm overalls for dogs',
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: 'senderismo perro ropa' } },
    });

    expect(resp.products.map((p) => p.id)).toEqual(['pet-1']);
  });

  test('filters lingerie for spanish pet query (better no than bad)', () => {
    const intent = extractIntentRuleBased(
      'Voy a ir de senderismo con mi perro. Por favor, encuentra ropa para mi perro.',
      [],
      []
    );
    expect(intent.target_object.type).toBe('pet');
    expect(intent.language).toBe('es');

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'ling-1',
            title: 'Conjunto de lencería de encaje',
            description: 'Ropa interior para mujer',
          }),
          makeRawProduct({
            id: 'pet-1',
            title: 'Warm Overalls for Dogs & Cats',
            description: 'Warm overalls for dogs',
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: 'senderismo perro ropa' } },
    });

    expect(resp.products.map((p) => p.id)).toEqual(['pet-1']);
    expect(resp.products.find((p) => p.id === 'ling-1')).toBeUndefined();
  });

  test('does not treat "catsuit" lingerie as pet apparel (avoid cat substring false positive)', () => {
    const intent = extractIntentRuleBased('我要狗狗的外套', [], []);
    expect(intent.target_object.type).toBe('pet');
    expect(intent.language).toBe('zh');

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'ling-1',
            title: 'Sexy lace catsuit bodysuit',
            description: 'lingerie set',
          }),
          makeRawProduct({
            id: 'pet-1',
            title: 'Warm sweater for dogs & cats',
            description: 'dog sweater',
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: '我要狗狗的外套' } },
    });

    expect(resp.products.map((p) => p.id)).toEqual(['pet-1']);
  });

  test('pet detection does not break when product has CJK option labels', () => {
    const intent = extractIntentRuleBased(
      'Voy a ir de senderismo con mi perro. Hace frío. Necesito un abrigo para mi perro.',
      [],
      []
    );
    expect(intent.target_object.type).toBe('pet');

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'pet-1',
            title: 'Warm Fall/Winter Padded Winter Vest for Dogs & Cats',
            description: 'Warm padded vest for pets',
            options: [{ name: '尺寸', values: ['S', 'M', 'L'] }],
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: 'senderismo perro abrigo' } },
    });

    expect(resp.products.map((p) => p.id)).toEqual(['pet-1']);
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
