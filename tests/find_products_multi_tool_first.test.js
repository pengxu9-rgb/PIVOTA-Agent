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
    expect(Array.isArray(out.follow_up_questions)).toBe(true);

    // Reordering should put kit items first.
    const topIds = (out.products || []).slice(0, 3).map((p) => p.id);
    expect(topIds).toEqual(expect.arrayContaining(['p2', 'p3']));
    expect(String(out.reply || '')).toMatch(/tool-first/i);
  });
});
