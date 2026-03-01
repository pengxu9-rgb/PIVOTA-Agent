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

describe('find_products_multi slot-aware clarify strategy', () => {
  test('scenario signal in query clarifies category instead of scenario', () => {
    const query = '今晚要出去约会，有什么推荐用的';
    const intent = extractIntentRuleBased(query, [], []);
    const resp = applyFindProductsMultiPolicy({
      response: { products: [], reply: null },
      intent,
      requestPayload: { search: { query } },
      rawUserQuery: query,
      metadata: { ambiguity_score_pre: 0.42 },
    });

    expect(resp.clarification).toEqual(
      expect.objectContaining({
        slot: 'category',
        dedup_key: expect.stringMatching(/^category:/),
      }),
    );
    expect(resp.clarification.reason_code).not.toBe('CLARIFY_SCENARIO');
  });

  test('asked scenario slot skips scenario re-ask', () => {
    const query = '有什么推荐';
    const intent = extractIntentRuleBased(query, [], []);
    const resp = applyFindProductsMultiPolicy({
      response: { products: [], reply: null },
      intent,
      requestPayload: {
        search: { query },
        context: {
          asked_slots: ['scenario'],
          clarify_budget: { max_rounds: 1, used_rounds: 0 },
        },
      },
      rawUserQuery: query,
      metadata: { ambiguity_score_pre: 0.4 },
    });

    expect(resp.clarification).toBeDefined();
    expect(resp.clarification.slot).not.toBe('scenario');
    expect(resp.clarification.reason_code).not.toBe('CLARIFY_SCENARIO');
  });

  test('clarify budget exhausted avoids additional clarify round', () => {
    const query = '推荐点东西';
    const intent = extractIntentRuleBased(query, [], []);
    const resp = applyFindProductsMultiPolicy({
      response: { products: [], reply: null },
      intent,
      requestPayload: {
        search: { query },
        context: {
          clarify_budget: { max_rounds: 1, used_rounds: 1 },
        },
      },
      rawUserQuery: query,
      metadata: { ambiguity_score_pre: 0.4 },
    });

    expect(resp.clarification).toBeUndefined();
    expect(resp.reason_codes).toEqual(expect.arrayContaining(['CLARIFY_BUDGET_EXHAUSTED']));
  });

  test('context fail-open returns directional candidates when scenario is known', () => {
    const query = '今晚约会妆有什么推荐';
    const intent = extractIntentRuleBased(query, [], []);
    const resp = applyFindProductsMultiPolicy({
      response: {
        products: [
          makeRawProduct({
            id: 'o1',
            title: 'Trail Hiking Backpack',
            description: 'waterproof hiking backpack for outdoor travel',
          }),
        ],
        reply: null,
      },
      intent,
      requestPayload: {
        search: { query },
        context: {
          resolved_slots: { scenario: 'date' },
        },
      },
      rawUserQuery: query,
      metadata: { ambiguity_score_pre: 0.45 },
    });

    expect(resp.clarification).toBeUndefined();
    expect(resp.products.length).toBeGreaterThan(0);
    expect(resp.reason_codes).toEqual(expect.arrayContaining(['CONTEXT_FAIL_OPEN']));
    expect(resp.metadata?.search_decision?.post_quality?.context_fail_open_applied).toBe(true);
  });
});
