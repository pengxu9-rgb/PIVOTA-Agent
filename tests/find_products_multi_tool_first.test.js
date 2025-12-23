const { extractIntentRuleBased } = require('../src/findProductsMulti/intent');
const { applyFindProductsMultiPolicy } = require('../src/findProductsMulti/policy');

describe('find_products_multi tool-first (beauty tools)', () => {
  test('detects beauty tools intent from query', async () => {
    const intent = extractIntentRuleBased('帮我推荐一套化妆刷具，想要粉底刷和散粉刷', [], []);
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.scenario.name).toBe('beauty_tools');
    expect(intent.target_object.type).toBe('human');
    expect(intent.category.required).toEqual(expect.arrayContaining(['cosmetic_tools']));
  });

  test('detects beauty tools intent from Japanese ブラシ query', async () => {
    const intent = extractIntentRuleBased(
      '来週、aespaのNingningのメイクを一通り描くけど、そのメイクに合うブラシのおすすめはある？',
      [],
      []
    );
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.scenario.name).toBe('beauty_tools');
    expect(intent.target_object.type).toBe('human');
  });

  test('keeps beauty tools intent on short follow-up when recent query indicates brushes', async () => {
    const intent = extractIntentRuleBased(
      'A 新手极简：底妆更干净',
      ['来週、aespaのNingningのメイクを一通り描くけど、そのメイクに合うブラシのおすすめはある？'],
      []
    );
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.scenario.name).toBe('beauty_tools');
  });

  test('keeps beauty tools intent on short follow-up when user messages contain brush query', async () => {
    const intent = extractIntentRuleBased(
      'A 新手极简：底妆更干净',
      [],
      [
        { role: 'user', content: '来週、aespaのNingningのメイクを一通り描くけど、そのメイクに合うブラシのおすすめはある？' },
      ]
    );
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.scenario.name).toBe('beauty_tools');
  });

  test('tool-first reply stays in Japanese for Japanese query, and does not recommend unrelated products', async () => {
    const intent = extractIntentRuleBased(
      '来週、aespaのNingningのメイクを一通り描くけど、そのメイクに合うブラシのおすすめはある？',
      [],
      []
    );
    expect(intent.language).toBe('ja');

    const response = {
      products: [
        {
          id: 'toy-1',
          title: 'Labubu Doll Outfit Set',
          description: 'Cute clothes for a doll figure.',
          price: 9.9,
          currency: 'USD',
          inventory_quantity: 10,
        },
      ],
      total: 1,
      page: 1,
      page_size: 20,
      reply: '',
      metadata: { query_source: 'test' },
    };

    const out = applyFindProductsMultiPolicy({
      response,
      intent,
      requestPayload: { search: { query: intent.raw_user_query || '' } },
      metadata: { creator_id: 'creator_demo_001', creator_name: 'Nina Studio' },
      rawUserQuery: '来週、aespaのNingningのメイクを一通り描くけど、そのメイクに合うブラシのおすすめはある？',
    });

    expect(Array.isArray(out.products)).toBe(true);
    expect(out.products.length).toBe(0);
    expect(typeof out.reply).toBe('string');
    // Japanese-only signal
    expect(out.reply).toMatch(/[\u3040-\u30ff]/);
    // No English "Includes:" line
    expect(out.reply).not.toMatch(/Includes:/);
  });

  test('assembles tool_kits and reorders products', async () => {
    const intent = extractIntentRuleBased('makeup brush set for foundation and powder', [], []);
    expect(intent.primary_domain).toBe('beauty');

    const response = {
      products: [
        {
          id: 'p1',
          title: 'Angled Foundation Brush – Seamless, streak-free base',
          description: 'Bristles: soft, resilient. Best with liquids and creams. Product Type: Cosmetic Tools.',
          price: 19.99,
          currency: 'USD',
          inventory_quantity: 10,
          attributes: ['纤维毛'],
        },
        {
          id: 'p2',
          title: '14-Piece Makeup Brush Set – Effortless blending and a polished finish | Logo Edition',
          description: 'What’s inside: 14 brushes. Product type: Cosmetic Tools.',
          price: 49.0,
          currency: 'USD',
          inventory_quantity: 10,
          attributes: ['动物毛'],
        },
        {
          id: 'p3',
          title: 'Makeup Sponge – Teardrop Shape',
          description: 'Makeup sponge for liquid foundation. Cosmetic Tools.',
          price: 8.99,
          currency: 'USD',
          inventory_quantity: 10,
        },
        {
          id: 'p4',
          title: 'Powder Puff (Latex) – Cushion Puff',
          description: 'Powder puff, cushion puff. Cosmetic Tools. latex.',
          price: 5.99,
          currency: 'USD',
          inventory_quantity: 10,
        },
        {
          id: 'p5',
          title: 'Brush Cleaning Pad',
          description: 'Cleaning pad for makeup brushes. Cosmetic Tools.',
          price: 6.99,
          currency: 'USD',
          inventory_quantity: 10,
        },
        {
          id: 'p6',
          title: 'Under‑Eye Detail Brush – Pro-quality finish',
          description: 'Detail brush for under eye. Cosmetic Tools.',
          price: 12.0,
          currency: 'USD',
          inventory_quantity: 10,
        },
      ],
      total: 5,
      page: 1,
      page_size: 20,
      reply: '',
      metadata: { query_source: 'test' },
    };

    const out = applyFindProductsMultiPolicy({
      response,
      intent,
      requestPayload: { search: { query: 'makeup brush set for foundation and powder' } },
      metadata: { creator_id: 'creator_demo_001', creator_name: 'Nina Studio' },
      rawUserQuery: 'makeup brush set for foundation and powder',
    });

    expect(out.policy_version).toMatch(/find_products_multi_policy_v/);
    expect(Array.isArray(out.tool_kits)).toBe(true);
    expect(out.tool_kits.length).toBeGreaterThanOrEqual(1);
    expect((out.tool_kits[0].items || []).length).toBeGreaterThan(0);
    expect(Array.isArray(out.follow_up_questions)).toBe(true);

    // Reordering should put kit items first.
    const topIds = (out.products || []).slice(0, 3).map((p) => p.id);
    expect(topIds).toEqual(expect.arrayContaining(['p2', 'p3']));
    expect(String(out.reply || '')).toMatch(/tool-first/i);
  });

  test('blocks non-tool products for beauty_tools', async () => {
    const intent = extractIntentRuleBased('化妆工具推荐：刷具', [], []);
    expect(intent.primary_domain).toBe('beauty');

    const response = {
      products: [
        {
          id: 'ling-1',
          title: "women's sleepwear set",
          description: 'sleepwear set',
          price: 19.9,
          currency: 'USD',
          inventory_quantity: 10,
        },
        {
          id: 'tool-1',
          title: 'Powder Brush',
          description: 'Cosmetic Tools',
          price: 9.9,
          currency: 'USD',
          inventory_quantity: 10,
        },
      ],
      total: 2,
      page: 1,
      page_size: 20,
      reply: '',
      metadata: { query_source: 'test' },
    };

    const out = applyFindProductsMultiPolicy({
      response,
      intent,
      requestPayload: { search: { query: '化妆工具推荐：刷具' } },
      metadata: { creator_id: 'creator_demo_001', creator_name: 'Nina Studio' },
      rawUserQuery: '化妆工具推荐：刷具',
    });

    const ids = (out.products || []).map((p) => p.id);
    expect(ids).toEqual(['tool-1']);
  });

  test('never assigns brush as sponge role', async () => {
    const intent = extractIntentRuleBased('makeup sponge for foundation', [], []);
    expect(intent.primary_domain).toBe('beauty');

    const response = {
      products: [
        {
          id: 'b1',
          title: 'Under-Eye Detail Brush – Pro-quality finish',
          description: 'Detail brush. Cosmetic Tools.',
          price: 12.0,
          currency: 'USD',
          inventory_quantity: 10,
        },
        {
          id: 'b2',
          title: 'Highlighter Brush – glow',
          description: 'Highlighter brush. Cosmetic Tools.',
          price: 12.0,
          currency: 'USD',
          inventory_quantity: 10,
        },
      ],
      total: 2,
      page: 1,
      page_size: 20,
      reply: '',
      metadata: { query_source: 'test' },
    };

    const out = applyFindProductsMultiPolicy({
      response,
      intent,
      requestPayload: { search: { query: 'makeup sponge for foundation' } },
      metadata: { creator_id: 'creator_demo_001', creator_name: 'Nina Studio' },
      rawUserQuery: 'makeup sponge for foundation',
    });

    const kitA = out.tool_kits?.[0];
    expect(Array.isArray(kitA?.items)).toBe(true);
    // No item should claim role=sponge unless it's truly a sponge product.
    const spongeItems = (kitA.items || []).filter((it) => it.role === 'sponge');
    expect(spongeItems.length).toBe(0);
  });

  test('does not force A/B/C kits when user only wants concealer + powder tools', async () => {
    const intent = extractIntentRuleBased('我只需要遮瑕工具和粉饼上妆的工具', [], []);
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.scenario.name).toBe('beauty_tools');

    const response = {
      products: [],
      total: 0,
      page: 1,
      page_size: 20,
      reply: '',
      metadata: { query_source: 'test' },
    };

    const out = applyFindProductsMultiPolicy({
      response,
      intent,
      requestPayload: { search: { query: '我只需要遮瑕工具和粉饼上妆的工具' } },
      metadata: { creator_id: 'creator_demo_001', creator_name: 'Nina Studio' },
      rawUserQuery: '我只需要遮瑕工具和粉饼上妆的工具',
    });

    expect(String(out.reply || '')).not.toMatch(/A\\s*新手极简|A→B→C/);
    expect(String(out.reply || '')).toMatch(/遮瑕刷/);
    expect(String(out.reply || '')).toMatch(/粉扑/);
  });

  test('celebrity same request asks for clarifiers instead of generic A/B/C kits', async () => {
    const intent = extractIntentRuleBased('我想要明星同款的化妆刷', [], []);
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.scenario.name).toBe('beauty_tools');

    const response = {
      products: [],
      total: 0,
      page: 1,
      page_size: 20,
      reply: '',
      metadata: { query_source: 'test' },
    };

    const out = applyFindProductsMultiPolicy({
      response,
      intent,
      requestPayload: { search: { query: '我想要明星同款的化妆刷' } },
      metadata: { creator_id: 'creator_demo_001', creator_name: 'Nina Studio' },
      rawUserQuery: '我想要明星同款的化妆刷',
    });

    expect(String(out.reply || '')).not.toMatch(/A\\s*新手极简|A→B→C/);
    expect(String(out.reply || '')).toMatch(/哪位明星|参考/);
  });
});
