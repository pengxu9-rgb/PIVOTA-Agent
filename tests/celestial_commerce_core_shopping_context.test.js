const {
  createShoppingContext,
  validateShoppingContextGrowth,
} = require('../src/modules/contracts/shoppingContext');
const { resolveSourceProfile } = require('../src/api/gateway/sourceProfiles');

describe('ShoppingContext growth guard', () => {
  test('accepts only cross-layer handoff fields', () => {
    const context = createShoppingContext({
      source_profile: resolveSourceProfile('shopping_agent'),
      task_type: 'discovery',
      vertical: 'beauty',
      category: 'skincare',
      normalized_need: {
        query: 'niacinamide serum',
        ingredients_include: ['niacinamide'],
      },
      decision_state: {
        shortlist: [{ product_id: 'p1', merchant_id: 'm1' }],
      },
    });

    expect(context.source_profile.source).toBe('shopping_agent');
    expect(context.task_type).toBe('discovery');
    expect(context.normalized_need.query).toBe('niacinamide serum');
  });

  test('rejects unknown top-level fields', () => {
    const validation = validateShoppingContextGrowth({
      source_profile: resolveSourceProfile('search'),
      task_type: 'exact_product',
      random_blob: true,
    });
    expect(validation.ok).toBe(false);
    expect(validation.unknown_top_level_keys).toContain('random_blob');
  });

  test('rejects ranking features, prompt scratchpad, and module cache fields', () => {
    expect(() =>
      createShoppingContext({
        source_profile: resolveSourceProfile('aurora-bff'),
        task_type: 'discovery',
        normalized_need: {
          query: 'barrier serum',
        },
        decision_state: {
          ranking_features: { score: 0.99 },
        },
      }),
    ).toThrow(/SHOPPING_CONTEXT_INVALID/);

    expect(() =>
      createShoppingContext({
        source_profile: resolveSourceProfile('aurora-bff'),
        task_type: 'discovery',
        conversation_state: {
          prompt_scratchpad: 'internal reasoning',
        },
      }),
    ).toThrow(/SHOPPING_CONTEXT_INVALID/);

    expect(() =>
      createShoppingContext({
        source_profile: resolveSourceProfile('search'),
        task_type: 'exact_product',
        execution_state: {
          module_cache: { hit: true },
        },
      }),
    ).toThrow(/SHOPPING_CONTEXT_INVALID/);
  });
});
