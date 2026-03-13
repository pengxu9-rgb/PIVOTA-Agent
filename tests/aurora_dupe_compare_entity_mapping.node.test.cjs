const test = require('node:test');
const assert = require('node:assert/strict');

const { SkillRouter } = require('../src/auroraBff/orchestrator/skill_router');

test('skill_router maps dupe_compare entities into anchor and comparison targets', () => {
  const router = new SkillRouter({});
  const request = { params: {} };

  router._applyClassificationEntities(request, {
    intent: 'dupe_compare',
    entities: {
      products: [
        'CeraVe Hydrating Cleanser',
        'La Roche-Posay Toleriane Hydrating Gentle Cleanser',
      ],
    },
  });

  assert.deepEqual(request.params.product_anchor, { name: 'CeraVe Hydrating Cleanser' });
  assert.deepEqual(request.params.comparison_targets, [
    { name: 'La Roche-Posay Toleriane Hydrating Gentle Cleanser' },
  ]);
});

test('skill_router preserves explicit dupe anchor and fills comparison targets from remaining entities', () => {
  const router = new SkillRouter({});
  const request = {
    params: {
      product_anchor: { name: 'CeraVe Hydrating Cleanser' },
    },
  };

  router._applyClassificationEntities(request, {
    intent: 'dupe_compare',
    entities: {
      products: [
        'CeraVe Hydrating Cleanser',
        'La Roche-Posay Toleriane Hydrating Gentle Cleanser',
        'Vanicream Gentle Facial Cleanser',
      ],
    },
  });

  assert.deepEqual(request.params.product_anchor, { name: 'CeraVe Hydrating Cleanser' });
  assert.deepEqual(request.params.comparison_targets, [
    { name: 'La Roche-Posay Toleriane Hydrating Gentle Cleanser' },
    { name: 'Vanicream Gentle Facial Cleanser' },
  ]);
});

test('skill_router extracts dupe_compare pair from free-text compare syntax when classifier products are missing', () => {
  const router = new SkillRouter({});
  const request = {
    params: {
      user_message: 'Compare CeraVe Hydrating Cleanser and La Roche-Posay Toleriane Hydrating Gentle Cleanser',
    },
  };

  router._applyClassificationEntities(request, {
    intent: 'dupe_compare',
    entities: {
      products: [],
      user_question: 'Compare CeraVe Hydrating Cleanser and La Roche-Posay Toleriane Hydrating Gentle Cleanser',
    },
  });

  assert.deepEqual(request.params.product_anchor, { name: 'CeraVe Hydrating Cleanser' });
  assert.deepEqual(request.params.comparison_targets, [
    { name: 'La Roche-Posay Toleriane Hydrating Gentle Cleanser' },
  ]);
});
