const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/beautyChatMainlineEntry');

test('beauty mainline exact-product context prepends anchor query terms to framework recall roles', () => {
  const targetContext = {
    primary_role_id: 'daily_sunscreen_finish_fit',
    framework_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        query_terms: ['spf fluid oily skin', 'sunscreen under makeup'],
      },
    ],
    semantic_plan: {
      core_roles: [
        {
          role_id: 'daily_sunscreen_finish_fit',
          query_terms: ['sunscreen under makeup'],
        },
      ],
    },
  };

  const out = __internal.augmentBeautyExactProductTargetContext(targetContext, {
    product_context: {
      brand: 'Beauty of Joseon',
      product_name: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
      canonical_product_ref: 'Beauty of Joseon Relief Sun Aqua-Fresh Rice B5 SPF50',
    },
  });

  assert.deepEqual(out.exact_product_anchor_query_terms.slice(0, 2), [
    'Beauty of Joseon Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
    'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
  ]);
  assert.deepEqual(out.framework_roles[0].query_terms.slice(0, 3), [
    'Beauty of Joseon Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
    'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
    'Beauty of Joseon Relief Sun Aqua-Fresh Rice B5 SPF50',
  ]);
  assert.deepEqual(out.semantic_plan.core_roles[0].query_terms.slice(0, 3), [
    'Beauty of Joseon Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
    'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
    'Beauty of Joseon Relief Sun Aqua-Fresh Rice B5 SPF50',
  ]);
});
