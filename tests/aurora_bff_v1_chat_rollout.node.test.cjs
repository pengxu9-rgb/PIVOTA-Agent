const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const recoHybridResolver = require('../src/auroraBff/usecases/recoHybridResolveCandidates');

const routesModuleId = require.resolve('../src/auroraBff/routes');
const chatRoutesModuleId = require.resolve('../src/auroraBff/routes/chat');
const schemasModuleId = require.resolve('../src/auroraBff/schemas');

function resetAuroraModules() {
  delete require.cache[routesModuleId];
  delete require.cache[chatRoutesModuleId];
  delete require.cache[schemasModuleId];
}

async function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  resetAuroraModules();
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    resetAuroraModules();
  }
}

function createApp() {
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });
  return app;
}

function buildHeaders() {
  return {
    'X-Aurora-UID': 'uid_v1_chat_rollout',
    'X-Trace-ID': 'trace_v1_chat_rollout',
    'X-Brief-ID': 'brief_v1_chat_rollout',
    'X-Lang': 'EN',
  };
}

test('V1ChatRequestSchema accepts optional context on legacy /v1/chat bodies', () => {
  resetAuroraModules();
  const { V1ChatRequestSchema } = require('../src/auroraBff/schemas');
  const parsed = V1ChatRequestSchema.safeParse({
    message: 'what ingredient is best for acne?',
    context: {
      locale: 'en',
      profile: {},
    },
  });

  assert.equal(parsed.success, true);
});

test('buildSkillRequest normalizes frontend language, camelCase profile fields, and routine slot maps', () => {
  resetAuroraModules();
  const { buildSkillRequest } = require('../src/auroraBff/routes/chat');

  const skillRequest = buildSkillRequest({
    body: {
      message: 'Recommend a calming mask',
      language: 'CN',
      session: {
        profile: {
          skinType: 'dry',
          goals: ['hydration'],
          budgetTier: '$50',
          currentRoutine: {
            routine_id: 'routine_map_123',
            am: {
              cleanser: 'Gentle Cleanser',
              sunscreen: 'SPF 50',
            },
            pm: {
              moisturizer: 'Barrier Cream',
            },
          },
        },
      },
      messages: [
        { role: 'assistant', content: 'Welcome back.' },
        { role: 'user', content: 'I want something calming.' },
      ],
    },
    headers: {},
  });

  assert.equal(skillRequest.context.locale, 'zh-CN');
  assert.equal(skillRequest.context.profile.skinType, 'dry');
  assert.equal(skillRequest.context.profile.skin_type, 'dry');
  assert.deepEqual(skillRequest.context.profile.goals, ['hydration']);
  assert.deepEqual(skillRequest.context.profile.concerns, ['hydration']);
  assert.equal(skillRequest.context.profile.budget_tier, '$50');
  assert.equal(skillRequest.context.current_routine?.routine_id, 'routine_map_123');
  assert.equal(skillRequest.context.current_routine?.am_steps?.length, 2);
  assert.equal(skillRequest.context.current_routine?.am_steps?.[0]?.products?.[0]?.name, 'Gentle Cleanser');
  assert.equal(skillRequest.context.current_routine?.pm_steps?.length, 1);
  assert.deepEqual(skillRequest.params.messages, [
    { role: 'assistant', content: 'Welcome back.' },
    { role: 'user', content: 'I want something calming.' },
  ]);
});

test('buildSkillRequest derives action params, reply_text, and normalized current routine from session profile', () => {
  resetAuroraModules();
  const { buildSkillRequest } = require('../src/auroraBff/routes/chat');

  const skillRequest = buildSkillRequest({
    body: {
      action: {
        action_id: 'chip.action.add_to_routine',
        kind: 'chip',
        data: {
          reply_text: 'Add this to my routine',
          product_anchor: {
            brand: 'Lab Series',
            name: 'Defense Lotion SPF 35',
            product_type: 'sunscreen',
          },
        },
      },
      anchor_product_id: 'prod_123',
      anchor_product_url: 'https://example.com/products/prod_123',
      session: {
        profile: {
          skin_type: 'dry',
          currentRoutine: {
            routine_id: 'routine_123',
            am_steps: [{ step_id: 'am_cleanser', products: [{ name: 'Gentle Cleanser' }] }],
            pm_steps: [{ step_id: 'pm_moisturizer', products: [{ name: 'Barrier Cream' }] }],
          },
        },
      },
    },
    headers: {},
  });

  assert.equal(skillRequest.params.entry_source, 'chip.action.add_to_routine');
  assert.equal(skillRequest.params.message, 'Add this to my routine');
  assert.deepEqual(skillRequest.params.product_anchor, {
    brand: 'Lab Series',
    name: 'Defense Lotion SPF 35',
    product_type: 'sunscreen',
  });
  assert.equal(skillRequest.params.anchor_product_id, 'prod_123');
  assert.equal(skillRequest.params.anchor_product_url, 'https://example.com/products/prod_123');
  assert.equal(skillRequest.context.current_routine?.routine_id, 'routine_123');
  assert.equal(Array.isArray(skillRequest.context.current_routine?.am_steps), true);
  assert.equal(skillRequest.context.current_routine?.am_steps?.length, 1);
});

test('/v1/chat delegates v2-compatible message+context bodies when skill_router_v2 is enabled', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          message: 'what ingredient is best for acne?',
          context: { locale: 'en', profile: {} },
        })
        .expect(200);

      assert.ok(Array.isArray(response.body.cards));
      assert.ok(Array.isArray(response.body.next_actions));
      assert.equal(response.body.cards.some((card) => card && card.card_type === 'text_response'), true);
      assert.equal(response.body.cards.some((card) => Object.prototype.hasOwnProperty.call(card || {}, 'type')), false);
    },
  );
});

test('/v1/chat turns current frontend reco freeform payload with camelCase profile into non-empty reco output', async () => {
  await withEnv(
    {
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      const originalResolve = recoHybridResolver.runRecoHybridResolveCandidates;
      recoHybridResolver.runRecoHybridResolveCandidates = async () => ({
        rows: [
          {
            product_id: 'prod_mask_1',
            merchant_id: 'merchant_mask_1',
            brand: 'Winona',
            name: 'Hydrating Repair Mask',
            reasons: ['Supports hydration and barrier comfort.'],
            match_state: 'exact',
          },
        ],
        recommendation_meta: {
          source_mode: 'llm_catalog_hybrid',
          llm_seed_count: 6,
          exact_match_count: 1,
          fuzzy_match_count: 0,
          unresolved_seed_count: 0,
        },
      });
      __resetRouterForTests();
      try {
        const response = await supertest(createApp())
          .post('/v1/chat')
          .set({
            ...buildHeaders(),
            'X-Lang': 'CN',
          })
          .send({
            session: {
              state: 'IDLE_CHAT',
              profile: {
                skinType: 'combination',
                goals: ['hydration', 'brightening'],
                currentRoutine: {
                  am: {
                    cleanser: 'Gentle Cleanser',
                    sunscreen: 'SPF 50',
                  },
                  pm: {
                    moisturizer: 'Barrier Cream',
                  },
                },
              },
            },
            message: 'Recommend a facial mask that suits me.',
            language: 'CN',
            client_state: { state: 'IDLE_CHAT' },
            messages: [{ role: 'user', content: 'I want something hydrating.' }],
          })
          .expect(200);

        assert.ok(Array.isArray(response.body.cards));
        assert.ok(Array.isArray(response.body.next_actions));
        assert.equal(response.body.cards.some((card) => card && card.card_type === 'recommendations'), true);
        assert.equal(response.body.cards.some((card) => card && card.card_type === 'effect_review'), false);
        assert.equal(response.body.cards.some((card) => card && card.card_type === 'empty_state'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(response.body, 'assistant_message'), false);
      } finally {
        recoHybridResolver.runRecoHybridResolveCandidates = originalResolve;
      }
    },
  );
});

test('/v1/chat allows target_step reco requests even without profile and calls hybrid resolver', async () => {
  await withEnv(
    {
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      const originalResolve = recoHybridResolver.runRecoHybridResolveCandidates;
      let resolveCalled = false;
      recoHybridResolver.runRecoHybridResolveCandidates = async () => {
        resolveCalled = true;
        return {
          rows: [{ product_id: 'p1', merchant_id: 'm1', name: 'Test Mask', match_state: 'exact' }],
          recommendation_meta: {
            source_mode: 'llm_catalog_hybrid',
            llm_seed_count: 6,
            exact_match_count: 1,
            fuzzy_match_count: 0,
            unresolved_seed_count: 0,
          },
        };
      };
      __resetRouterForTests();

      try {
        const response = await supertest(createApp())
          .post('/v1/chat')
          .set(buildHeaders())
          .send({
            message: 'Recommend a facial mask that suits me.',
            context: { locale: 'en', profile: {} },
          })
          .expect(200);

        assert.equal(resolveCalled, true);
        assert.equal(response.body.cards.some((card) => card && card.card_type === 'recommendations'), true);
      } finally {
        recoHybridResolver.runRecoHybridResolveCandidates = originalResolve;
      }
    },
  );
});

test('/v1/chat delegates chip.action.add_to_routine to v2 when skill_router_v2 is enabled', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          action: {
            action_id: 'chip.action.add_to_routine',
            kind: 'chip',
            data: {
              reply_text: 'Add this to my routine',
              product_anchor: {
                brand: 'Lab Series',
                name: 'Defense Lotion SPF 35',
                product_type: 'sunscreen',
              },
            },
          },
          session: {
            state: 'IDLE_CHAT',
            profile: {
              currentRoutine: {
                routine_id: 'routine_123',
                am_steps: [{ step_id: 'am_cleanser', products: [{ name: 'Gentle Cleanser' }] }],
                pm_steps: [{ step_id: 'pm_moisturizer', products: [{ name: 'Barrier Cream' }] }],
              },
            },
          },
        })
        .expect(200);

      assert.ok(Array.isArray(response.body.cards));
      assert.equal(response.body.cards.some((card) => card && Object.prototype.hasOwnProperty.call(card, 'card_type')), true);
      assert.equal(response.body.cards.some((card) => card && Object.prototype.hasOwnProperty.call(card, 'type')), false);
      assert.ok(Array.isArray(response.body.next_actions));
    },
  );
});

test('/v1/chat keeps legacy contract for message+context bodies when skill_router_v2 is disabled', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_SKILL_ROUTER_V2: 'false',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          message: 'Tell me about niacinamide',
          context: { locale: 'en', profile: {} },
        })
        .expect(200);

      assert.ok(Array.isArray(response.body.cards));
      assert.equal(response.body.cards.some((card) => Object.prototype.hasOwnProperty.call(card || {}, 'type')), true);
      assert.equal(Object.prototype.hasOwnProperty.call(response.body, 'next_actions'), false);
      assert.notEqual(String(response.body.assistant_message?.content || '').trim(), 'Invalid request.');
    },
  );
});

test('/v1/chat keeps legacy interactive action/session flows even when skill_router_v2 is enabled', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_SKILL_ROUTER_V2: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: '1',
    },
    async () => {
      const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');
      __resetRouterForTests();

      const response = await supertest(createApp())
        .post('/v1/chat')
        .set(buildHeaders())
        .send({
          action: {
            action_id: 'chip.start.reco_products',
            kind: 'chip',
            data: { reply_text: 'Recommend products now', include_alternatives: false },
          },
          session: { state: 'S2_DIAGNOSIS' },
        })
        .expect(200);

      assert.ok(Array.isArray(response.body.cards));
      assert.equal(response.body.cards.some((card) => Object.prototype.hasOwnProperty.call(card || {}, 'type')), true);
      assert.equal(response.body.cards.some((card) => Object.prototype.hasOwnProperty.call(card || {}, 'card_type')), false);
    },
  );
});
