const { extractIntentRuleBased } = require('../src/findProductsMulti/intent');
const { applyFindProductsMultiPolicy, buildFindProductsMultiContext } = require('../src/findProductsMulti/policy');

function withPolicyEnv(envOverrides, fn) {
  const keys = Object.keys(envOverrides || {});
  const backup = {};
  for (const key of keys) {
    backup[key] = process.env[key];
    process.env[key] = String(envOverrides[key]);
  }
  jest.resetModules();
  const policy = require('../src/findProductsMulti/policy');
  try {
    return fn(policy);
  } finally {
    jest.resetModules();
    for (const key of keys) {
      if (backup[key] == null) delete process.env[key];
      else process.env[key] = backup[key];
    }
  }
}

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

  test('medium ambiguity returns clarification payload instead of drifting products', () => {
    const intent = extractIntentRuleBased('约会妆推荐', [], []);
    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'p1',
            title: 'Date Makeup Foundation',
            description: 'Longwear foundation and base makeup',
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: '约会妆推荐' } },
      metadata: { ambiguity_score_pre: 0.45 },
    });

    expect(Array.isArray(resp.products)).toBe(true);
    expect(resp.products).toHaveLength(0);
    expect(resp.clarification).toEqual(
      expect.objectContaining({
        question: expect.any(String),
        options: expect.any(Array),
        reason_code: expect.any(String),
      }),
    );
    expect(resp.metadata?.search_decision?.final_decision).toBe('clarify');
    expect(resp.reason_codes).toEqual(expect.arrayContaining(['AMBIGUITY_CLARIFY']));
  });

  test('balanced domain filter recovers near-taxonomy candidates when strict filter empties', () => {
    withPolicyEnv(
      {
        SEARCH_DOMAIN_HARD_FILTER_MODE: 'balanced',
        SEARCH_DOMAIN_BEAUTY_FAIL_OPEN: 'false',
      },
      ({ applyFindProductsMultiPolicy: applyWithEnv }) => {
        const intent = extractIntentRuleBased('hiking backpack recommendations', [], []);
        const resp = applyWithEnv({
          response: {
            products: [
              makeRawProduct({
                id: 'h-1',
                title: 'Alpine Pack 30L',
                description: 'Lightweight pack with chest strap',
                category: 'backpack',
              }),
            ],
            reply: null,
          },
          intent,
          requestPayload: { search: { query: 'hiking backpack recommendations' } },
          metadata: { ambiguity_score_pre: 0.2 },
          rawUserQuery: 'hiking backpack recommendations',
        });

        expect(resp.products).toHaveLength(1);
        expect(resp.metadata?.search_decision?.post_quality?.candidates).toBe(1);
      },
    );
  });

  test('scenario query returns products when post-quality thresholds are met', () => {
    withPolicyEnv(
      {
        SEARCH_CLARIFY_MIN_RECALL_CANDIDATES: '6',
        SEARCH_CLARIFY_MIN_ANCHOR_RATIO: '0.12',
        SEARCH_CLARIFY_MAX_DOMAIN_ENTROPY: '0.5',
      },
      ({ applyFindProductsMultiPolicy: applyWithEnv }) => {
        const intent = extractIntentRuleBased('约会妆推荐', [], []);
        const products = [
          makeRawProduct({
            id: 'p1',
            title: 'Date Makeup Foundation',
            description: 'foundation base makeup',
          }),
          makeRawProduct({
            id: 'p2',
            title: 'Longwear Concealer',
            description: 'concealer base coverage',
          }),
          makeRawProduct({
            id: 'p3',
            title: 'Volumizing Mascara',
            description: 'eye makeup mascara',
          }),
          makeRawProduct({
            id: 'p4',
            title: 'Soft Brown Eyeliner',
            description: 'eye makeup liner',
          }),
          makeRawProduct({
            id: 'p5',
            title: 'Hydrating Lipstick',
            description: 'lip makeup lipstick',
          }),
          makeRawProduct({
            id: 'p6',
            title: 'Setting Spray',
            description: 'makeup finish hold',
          }),
        ];
        const resp = applyWithEnv({
          response: { products, reply: null },
          intent,
          requestPayload: { search: { query: '约会妆推荐' } },
          metadata: { ambiguity_score_pre: 0.4 },
          rawUserQuery: '约会妆推荐',
        });

        expect(resp.products.length).toBeGreaterThan(0);
        expect(resp.clarification).toBeUndefined();
        expect(resp.metadata?.search_decision?.final_decision).toBe('products_returned');
      },
    );
  });

  test('scenario query clarifies when post-quality fails', () => {
    withPolicyEnv(
      {
        SEARCH_CLARIFY_MIN_RECALL_CANDIDATES: '6',
        SEARCH_CLARIFY_MIN_ANCHOR_RATIO: '0.2',
        SEARCH_CLARIFY_MAX_DOMAIN_ENTROPY: '0.45',
      },
      ({ applyFindProductsMultiPolicy: applyWithEnv }) => {
        const intent = extractIntentRuleBased('出差买什么', [], []);
        const products = Array.from({ length: 6 }).map((_, idx) =>
          makeRawProduct({
            id: `u${idx + 1}`,
            title: `Generic Product ${idx + 1}`,
            description: 'misc catalog item',
          }),
        );
        const resp = applyWithEnv({
          response: { products, reply: null },
          intent,
          requestPayload: { search: { query: '出差买什么' } },
          metadata: { ambiguity_score_pre: 0.42 },
          rawUserQuery: '出差买什么',
        });

        expect(resp.products).toHaveLength(0);
        expect(resp.clarification).toEqual(
          expect.objectContaining({
            question: expect.any(String),
          }),
        );
        expect(resp.metadata?.search_decision?.final_decision).toBe('clarify');
      },
    );
  });

  test('scenario query can pass post-quality with derived anchor basis', () => {
    withPolicyEnv(
      {
        SEARCH_SCENARIO_ANCHOR_MODE: 'derived',
        SEARCH_SCENARIO_DERIVED_MIN_RECALL_CANDIDATES: '4',
        SEARCH_SCENARIO_DERIVED_MIN_ANCHOR_RATIO: '0.1',
        SEARCH_SCENARIO_DERIVED_MAX_DOMAIN_ENTROPY: '0.6',
        SEARCH_CLARIFY_MIN_RECALL_CANDIDATES: '6',
        SEARCH_CLARIFY_MIN_ANCHOR_RATIO: '0.2',
        SEARCH_CLARIFY_MAX_DOMAIN_ENTROPY: '0.45',
      },
      ({ applyFindProductsMultiPolicy: applyWithEnv }) => {
        const intent = extractIntentRuleBased('出差带什么', [], []);
        const products = [
          makeRawProduct({
            id: 't1',
            title: 'Business Travel Toiletry Kit',
            description: 'travel toiletry organizer and bottles',
            category: 'travel_accessories',
          }),
          makeRawProduct({
            id: 't2',
            title: 'Packing Cubes Set',
            description: 'lightweight luggage organizer for trip',
            category: 'travel_accessories',
          }),
          makeRawProduct({
            id: 't3',
            title: 'Carry-on Toiletry Bottles Set',
            description: 'portable travel toiletry bottles',
            category: 'travel_accessories',
          }),
          makeRawProduct({
            id: 't4',
            title: 'Carry-on Compression Pouch',
            description: 'portable travel storage bag',
            category: 'travel_accessories',
          }),
          makeRawProduct({
            id: 't5',
            title: 'Passport Wallet Organizer',
            description: 'travel document organizer for business trips',
            category: 'travel_accessories',
          }),
        ];
        const resp = applyWithEnv({
          response: { products, reply: null },
          intent,
          requestPayload: { search: { query: '出差带什么' } },
          metadata: {
            ambiguity_score_pre: 0.4,
            association_plan: {
              applied: true,
              domain_key: 'travel',
              scenario_key: 'business_trip',
              category_keywords: ['travel toiletries', 'packing cubes', 'adapter'],
            },
          },
          rawUserQuery: '出差带什么',
        });

        expect(resp.products.length).toBeGreaterThan(0);
        expect(resp.clarification).toBeUndefined();
        expect(resp.metadata?.search_decision?.post_quality?.anchor_mode).toBe('derived');
        expect(resp.metadata?.search_decision?.final_decision).toBe('products_returned');
      },
    );
  });

  test('high ambiguity enforces strict empty', () => {
    const intent = extractIntentRuleBased('你好', [], []);
    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({ id: 'p1', title: 'Random Product', description: 'Unrelated item' }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: '你好' } },
      metadata: { ambiguity_score_pre: 0.8 },
    });

    expect(resp.products).toHaveLength(0);
    expect(resp.metadata?.search_decision?.final_decision).toBe('strict_empty');
    expect(resp.reason_codes).toEqual(expect.arrayContaining(['AMBIGUITY_STRICT_EMPTY']));
    expect(resp.clarification).toBeUndefined();
  });

  test('discovery intent: English greeting routes to discovery', () => {
    const intent = extractIntentRuleBased('hi', [], []);
    expect(intent.scenario.name).toBe('discovery');
    expect(intent.primary_domain).toBe('other');
    expect(intent.target_object.type).toBe('unknown');
  });

  test('intent: "clothing" should not be treated as greeting', () => {
    const intent = extractIntentRuleBased('women clothing dress top skirt outfit', [], []);
    expect(intent.primary_domain).toBe('human_apparel');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('women_clothing');
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

  test('intent: lingerie query is human_apparel (human) and is not treated as browse', () => {
    const intent = extractIntentRuleBased('性感内衣', [], []);
    expect(intent.language).toBe('zh');
    expect(intent.primary_domain).toBe('human_apparel');
    expect(intent.target_object.type).toBe('human');
    expect(intent.category.required).toEqual(expect.arrayContaining(['lingerie']));
    expect(intent.ambiguity.needs_clarification).toBe(false);
  });

  test('intent: women clothing with budget is human_apparel (human) with USD price max', () => {
    const intent = extractIntentRuleBased('帮我选几件20美金左右的女生衣服', [], []);
    expect(intent.language).toBe('zh');
    expect(intent.primary_domain).toBe('human_apparel');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('women_clothing');
    expect(intent.category.required).toEqual(expect.arrayContaining(['apparel']));
    expect(intent.hard_constraints.price.currency).toBe('USD');
    expect(intent.hard_constraints.price.max).toBeGreaterThanOrEqual(20);
  });

  test('intent: pet gift with min budget parses as USD price min (30+)', () => {
    const intent = extractIntentRuleBased('我要送朋友，可以贵一点，30美金以上的狗狗衣服', [], []);
    expect(intent.target_object.type).toBe('pet');
    expect(intent.hard_constraints.price.currency).toBe('USD');
    expect(intent.hard_constraints.price.min).toBe(30);
    expect(intent.hard_constraints.price.max).toBeNull();
  });

  test('new chat: base makeup tools should not inherit sleepwear mission from recent_queries', () => {
    const latest = '干皮冬天用什么底妆工具不卡粉';
    const intent = extractIntentRuleBased(latest, ['绿色睡衣', '睡衣', 'pajamas'], [{ role: 'user', content: latest }]);
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.scenario.name).toBe('beauty_tools');
    expect(intent.target_object.type).toBe('human');
  });

  test('date makeup query is classified as beauty general (non-tool)', () => {
    const intent = extractIntentRuleBased('我今晚有个约会，要化妆，要推荐点商品吧？', [], []);
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('general');
    expect(intent.ambiguity.needs_clarification).toBe(false);
  });

  test('travel skincare query is classified as beauty general', () => {
    const intent = extractIntentRuleBased('出差护肤推荐', [], []);
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('general');
  });

  test('dog leash query expansion stays leash-focused', async () => {
    const { intent, adjustedPayload } = await buildFindProductsMultiContext({
      payload: {
        search: {
          query: '有没有狗链推荐？',
        },
      },
      metadata: {
        expansion_mode: 'aggressive',
      },
    });

    const expanded = String(adjustedPayload?.search?.query || '');
    expect(intent.target_object.type).toBe('pet');
    expect(expanded).toMatch(/dog leash|pet leash|lead|dog collar/i);
    expect(expanded).not.toMatch(/dog jacket|pet apparel/i);
  });

  test('pet min budget is prioritized in results ordering (>= $30 first)', () => {
    const intent = extractIntentRuleBased('我要送朋友，可以贵一点，30美金以上的狗狗衣服', [], []);
    expect(intent.target_object.type).toBe('pet');

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'p-low',
            title: 'Warm Fall/Winter Padded Vest for Dogs',
            description: 'Dog apparel',
            price: 24.99,
          }),
          makeRawProduct({
            id: 'p-ok-1',
            title: 'Premium Winter Coat for Dogs',
            description: 'Dog coat',
            price: 30.99,
          }),
          makeRawProduct({
            id: 'p-ok-2',
            title: 'Outdoor-Ready Padded Jacket for Dogs',
            description: 'Dog jacket',
            price: 35.0,
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: '30美金以上 狗狗衣服' } },
    });

    expect(resp.products.map((p) => p.id).slice(0, 2)).toEqual(['p-ok-1', 'p-ok-2']);
    expect(resp.products.map((p) => p.id)).toEqual(expect.arrayContaining(['p-low']));
  });

  test('pet harness is recognized and not filtered; large-dog query asks for measurements', () => {
    const intent = extractIntentRuleBased('大型犬的衣服或者背带', [], []);
    expect(intent.target_object.type).toBe('pet');
    expect(intent.category.required).toEqual(expect.arrayContaining(['pet_harness']));

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'h-1',
            title: 'No-pull Dog Harness (XL/XXL)',
            description: 'Dog harness for walking',
            price: 34.0,
          }),
          makeRawProduct({
            id: 'c-1',
            title: 'Warm Coat for Dogs (XXL)',
            description: 'Dog jacket for winter',
            price: 32.0,
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: '大型犬 衣服 背带' } },
    });

    expect(resp.products.map((p) => p.id)).toEqual(expect.arrayContaining(['h-1', 'c-1']));
    expect(String(resp.reply)).toContain('胸围');
    expect(String(resp.reply)).toContain('背长');
  });

  test('large dog sizing signal ranks XXL ahead of XS when prices are equal group', () => {
    const intent = extractIntentRuleBased('大型犬的衣服', [], []);
    expect(intent.target_object.type).toBe('pet');

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 's-1',
            title: 'Dog Jacket (XS)',
            description: 'Small breed jacket',
            price: 35,
          }),
          makeRawProduct({
            id: 'l-1',
            title: 'Dog Jacket (XXL)',
            description: 'Large breed jacket',
            price: 35,
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: '大型犬 衣服' } },
    });

    expect(resp.products.map((p) => p.id)[0]).toBe('l-1');
  });

  test('women_clothing allows lingerie as soft-block instead of hard-block', () => {
    const intent = extractIntentRuleBased('帮我选几件20美金左右的女生衣服', [], []);
    expect(intent.scenario.name).toBe('women_clothing');

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'ling-1',
            title: 'Sweet Lace lingerie set',
            description: 'Women underwear set',
            price: 19.9,
          }),
          makeRawProduct({
            id: 'pet-1',
            title: 'Warm Winter Coat for Dogs & Cats',
            description: 'Warm padded coat for pets',
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: '帮我选几件20美金左右的女生衣服' } },
    });

    expect(resp.products.map((p) => p.id)).toEqual(expect.arrayContaining(['ling-1']));
    expect(resp.products.map((p) => p.id)).not.toEqual(expect.arrayContaining(['pet-1']));
    const ling = resp.products.find((p) => p.id === 'ling-1');
    expect(ling.attributes?.pivota?.relevance?.risk_level).toBe('soft_block');
    expect(ling.attributes?.pivota?.relevance?.reason_codes || []).toEqual(
      expect.arrayContaining(['ADULT_NEEDS_CONFIRMATION'])
    );
  });

  test('women clothing weak reply does not ask for windproof/waterproof outerwear slots', () => {
    const intent = extractIntentRuleBased('帮我选几件20美金左右的女生衣服', [], []);
    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'ling-1',
            title: 'Sweet Lace lingerie set',
            description: 'Women underwear set',
            price: 19.9,
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: '帮我选几件20美金左右的女生衣服' } },
    });

    expect(String(resp.reply)).toContain('裙子');
    expect(String(resp.reply)).not.toContain('防风');
    expect(String(resp.reply)).not.toContain('冲锋衣');
  });

  test('lingerie intent filters out pet/toy items (avoid mixed featured pool)', () => {
    const intent = extractIntentRuleBased('性感内衣', [], []);
    expect(intent.target_object.type).toBe('human');

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'toy-1',
            title: 'Labubu doll clothes set',
            description: 'Doll outfit for Labubu-style vinyl face doll',
          }),
          makeRawProduct({
            id: 'pet-1',
            title: 'Warm Winter Coat for Dogs & Cats',
            description: 'Warm padded coat for pets',
          }),
          makeRawProduct({
            id: 'ling-1',
            title: 'Lace lingerie set',
            description: 'Women underwear set',
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: '性感内衣' } },
    });

    expect(resp.products.map((p) => p.id)).toEqual(expect.arrayContaining(['ling-1']));
    expect(resp.products.map((p) => p.id)).not.toEqual(expect.arrayContaining(['toy-1', 'pet-1']));
  });

  test('sexy outfit query should not hard-block lingerie products as unrequested adult', () => {
    const intent = extractIntentRuleBased('当天晚上要给女朋友一个惊喜，准备一套性感的衣服送给她，推荐一些', [], []);
    expect(intent.primary_domain).toBe('human_apparel');
    expect(intent.target_object.type).toBe('human');

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'ling-1',
            title: 'Sweet Lace Sheer Mesh Deep V Backless lingerie set',
            description: 'Sexy lingerie set for women',
          }),
          makeRawProduct({
            id: 'pet-1',
            title: 'Warm Winter Coat for Dogs & Cats',
            description: 'Warm padded coat for pets',
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: '性感的衣服' } },
    });

    expect(resp.products.map((p) => p.id)).toEqual(expect.arrayContaining(['ling-1']));
    expect(resp.products.map((p) => p.id)).not.toEqual(expect.arrayContaining(['pet-1']));
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

  test('does not misclassify "breathable" pet apparel as lingerie ("bra" substring)', () => {
    const intent = extractIntentRuleBased('need a warm jacket for my dog', [], []);
    expect(intent.target_object.type).toBe('pet');

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'pet-1',
            title: 'Warm Winter Jacket for Dogs & Cats',
            description: 'Breathable fabric, warm and comfy for pets',
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: 'dog jacket' } },
    });

    expect(resp.products.map((p) => p.id)).toEqual(['pet-1']);
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

  test('TOY_ONLY_LEFT is only emitted when everything is toy-like', () => {
    const intent = extractIntentRuleBased('need a jacket for my dog', [], []);
    expect(intent.target_object.type).toBe('pet');

    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'ling-1',
            title: 'Sexy lace catsuit bodysuit',
            description: 'lingerie set',
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: { search: { query: 'dog jacket' } },
    });

    // All candidates are hard-blocked, but not because they're toys.
    expect(resp.products).toHaveLength(0);
    expect(resp.reason_codes || []).toEqual(expect.arrayContaining(['ALL_HARD_BLOCKED']));
    expect(resp.reason_codes || []).not.toEqual(expect.arrayContaining(['TOY_ONLY_LEFT']));
  });

  test('beauty general query enforces multi-category diversity and tool cap', () => {
    const intent = {
      language: 'zh',
      primary_domain: 'beauty',
      target_object: { type: 'human', age_group: 'all', notes: '' },
      category: { required: [], optional: [] },
      scenario: { name: 'general', signals: [] },
      hard_constraints: {
        must_exclude_domains: [],
        must_exclude_keywords: [],
      },
      ambiguity: { needs_clarification: false, missing_slots: [], clarifying_questions: [] },
    };
    const products = [
      makeRawProduct({ id: 'tool-1', title: 'Foundation Brush Set' }),
      makeRawProduct({ id: 'tool-2', title: 'Powder Brush Pro' }),
      makeRawProduct({ id: 'tool-3', title: 'Contour Brush Duo' }),
      makeRawProduct({ id: 'tool-4', title: 'Blush Brush' }),
      makeRawProduct({ id: 'tool-5', title: 'Eye Blending Brush' }),
      makeRawProduct({ id: 'tool-6', title: 'Makeup Sponge Puff' }),
      makeRawProduct({ id: 'base-1', title: 'Hydrating Foundation SPF' }),
      makeRawProduct({ id: 'eye-1', title: 'Longwear Mascara' }),
      makeRawProduct({ id: 'lip-1', title: 'Velvet Lipstick' }),
      makeRawProduct({ id: 'skin-1', title: 'Brightening Toner Essence' }),
    ];

    const resp = applyFindProductsMultiPolicy({
      response: { products, reply: null },
      intent,
      requestPayload: { search: { query: '今晚约会妆推荐商品' } },
      rawUserQuery: '今晚约会妆推荐商品',
    });

    const top10 = Array.isArray(resp.products) ? resp.products.slice(0, 10) : [];
    const toolsInTop10 = top10.filter((p) => /brush|sponge|puff|化妆刷|刷具|粉扑/i.test(String(p.title || ''))).length;
    expect(toolsInTop10).toBeLessThanOrEqual(4);
    expect(resp.reason_codes || []).toEqual(expect.arrayContaining(['BEAUTY_DIVERSITY_REORDERED']));
    expect(resp.metadata?.route_debug?.policy?.diversity).toEqual(
      expect.objectContaining({
        applied: true,
        category_mix_topN: expect.any(Object),
      }),
    );
  });

  test('beauty diversity enforces non-tool minimum for non-tool queries', () => {
    const intent = {
      language: 'en',
      primary_domain: 'beauty',
      target_object: { type: 'human', age_group: 'all', notes: '' },
      category: { required: [], optional: [] },
      scenario: { name: 'general', signals: [] },
      hard_constraints: {
        must_exclude_domains: [],
        must_exclude_keywords: [],
      },
      ambiguity: { needs_clarification: false, missing_slots: [], clarifying_questions: [] },
    };
    const products = [
      makeRawProduct({ id: 'tool-1', title: 'Foundation Brush Set' }),
      makeRawProduct({ id: 'tool-2', title: 'Powder Brush Pro' }),
      makeRawProduct({ id: 'tool-3', title: 'Contour Brush Duo' }),
      makeRawProduct({ id: 'tool-4', title: 'Eye Blending Brush' }),
      makeRawProduct({ id: 'tool-5', title: 'Makeup Sponge Puff' }),
    ];

    const resp = applyFindProductsMultiPolicy({
      response: { products, reply: null },
      intent,
      requestPayload: { search: { query: 'date makeup kit recommendation' } },
      rawUserQuery: 'date makeup kit recommendation',
    });

    expect(resp.products.length).toBe(0);
    expect(resp.reason_codes || []).toEqual(
      expect.arrayContaining(['BEAUTY_DIVERSITY_NOT_MET', 'BEAUTY_NON_TOOL_MIN_NOT_MET']),
    );
    expect(resp.metadata?.route_debug?.policy?.diversity).toEqual(
      expect.objectContaining({
        requirement_unmet: true,
        strict_empty: true,
        preserve_primary_on_failure: false,
        required_non_tool_buckets: 2,
      }),
    );
  });
});
