const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

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
