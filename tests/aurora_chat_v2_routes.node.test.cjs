const assert = require('assert');
const test = require('node:test');
const express = require('express');
const request = require('supertest');

const { registerRoutes } = require('../src/auroraBff');
const {
  __resetRouterForTests,
  __setInvokeV1MainlineChatForTests,
  __resetInvokeV1MainlineChatForTests,
} = require('../src/auroraBff/routes/chat');

function createApp() {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  return app;
}

function parseSse(responseText) {
  return String(responseText || '')
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event:\s*(\w+)/m)?.[1] || null;
      const dataText = block.match(/^data:\s*(.+)$/m)?.[1] || '{}';
      return {
        event,
        data: JSON.parse(dataText),
      };
    });
}

test.beforeEach(() => {
  process.env.AURORA_CHAT_V2_STUB_RESPONSES = '1';
  __resetRouterForTests();
  __resetInvokeV1MainlineChatForTests();
});

test.after(() => {
  delete process.env.AURORA_CHAT_V2_STUB_RESPONSES;
  __resetRouterForTests();
  __resetInvokeV1MainlineChatForTests();
});

test('POST /v2/chat accepts legacy intent payloads and returns next_actions', async () => {
  const app = createApp();
  const response = await request(app)
    .post('/v2/chat')
    .send({
      intent: 'ingredient_report',
      params: { ingredient_query: 'retinol' },
      context: { locale: 'en', profile: {} },
    })
    .expect(200);

  assert.ok(Array.isArray(response.body.cards));
  assert.ok(Array.isArray(response.body.next_actions));
  assert.ok(response.body.next_actions.length > 0);
});

test('POST /v2/chat accepts free-form payloads and returns text_response cards', async () => {
  const app = createApp();
  const response = await request(app)
    .post('/v2/chat')
    .send({
      message: 'what ingredient is best for acne?',
      context: { locale: 'en', profile: {} },
    })
    .expect(200);

  const cardTypes = new Set((response.body.cards || []).map((card) => card.card_type));
  assert.ok(cardTypes.has('text_response'));
  assert.ok(Array.isArray(response.body.next_actions));
});

test('POST /v2/chat answers dryness questions even when profile says oily', async () => {
  const app = createApp();
  const response = await request(app)
    .post('/v2/chat')
    .send({
      message: 'My skin feels dry and tight lately. What should I do?',
      context: {
        locale: 'en',
        profile: { skin_type: 'oily' },
      },
    })
    .expect(200);

  const textAnswer = response.body.cards?.[0]?.sections?.find((section) => section.type === 'text_answer')?.text_en || '';
  assert.equal(response.body.cards?.[0]?.card_type, 'text_response');
  assert.match(textAnswer, /dry|tight|gentle|barrier|hydr/i);
  assert.match(textAnswer, /oily|greasy|occlusive|congest/i);
  assert.doesNotMatch(textAnswer, /cannot assist with dryness because your profile indicates oily skin/i);
});

test('POST /v2/chat prepends answer-first text on free-text skill routes', async () => {
  const app = createApp();
  const response = await request(app)
    .post('/v2/chat')
    .send({
      message: 'Tell me about retinol',
      context: { locale: 'en', profile: {} },
    })
    .expect(200);

  const cardTypes = (response.body.cards || []).map((card) => card.card_type);
  assert.equal(cardTypes[0], 'text_response');
  assert.ok(cardTypes.includes('aurora_ingredient_report'));
});

test('POST /v2/chat/stream emits ordered SSE events with a single result', async () => {
  const app = createApp();
  const response = await request(app)
    .post('/v2/chat/stream')
    .send({
      message: 'how do I start a simple skincare routine?',
      context: { locale: 'en', profile: {} },
    })
    .expect(200);

  const text = response.text;
  const events = [...text.matchAll(/^event:\s*(\w+)/gm)].map((match) => match[1]);
  const resultCount = events.filter((eventName) => eventName === 'result').length;

  assert.ok(events.includes('thinking'));
  assert.ok(events.includes('chunk'));
  assert.strictEqual(resultCount, 1);
  assert.ok(events.indexOf('chunk') > events.indexOf('thinking'));
  assert.ok(events.indexOf('result') > events.indexOf('chunk'));
  assert.strictEqual(events[events.length - 1], 'done');
});

test('POST /v2/chat/stream free-form chunks reconstruct the final text answer', async () => {
  const app = createApp();
  const response = await request(app)
    .post('/v2/chat/stream')
    .send({
      message: 'how do I start a simple skincare routine?',
      context: { locale: 'en', profile: {} },
    })
    .expect(200);

  const parsed = parseSse(response.text);
  const chunkText = parsed
    .filter((event) => event.event === 'chunk')
    .map((event) => event.data.text)
    .join('');
  const resultPayload = parsed.find((event) => event.event === 'result')?.data;
  const finalAnswer = resultPayload?.cards?.[0]?.sections?.find((section) => section.type === 'text_answer')?.text_en;

  assert.ok(chunkText.length > 0);
  assert.equal(chunkText, finalAnswer);
});

test('POST /v1/chat/stream is an alias of the v2 stream handler', async () => {
  const app = createApp();
  const response = await request(app)
    .post('/v1/chat/stream')
    .send({
      message: 'how do I start a simple skincare routine?',
      context: { locale: 'en', profile: {} },
    })
    .expect(200);

  const events = [...response.text.matchAll(/^event:\s*(\w+)/gm)].map((match) => match[1]);
  assert.ok(events.includes('thinking'));
  assert.ok(events.includes('result'));
  assert.strictEqual(events[events.length - 1], 'done');
});

test('POST /v1/chat/stream proxies generic skincare reco requests to the v1 mainline envelope', async () => {
  __setInvokeV1MainlineChatForTests(async () => ({
    request_id: 'req_stream_framework',
    trace_id: 'trace_stream_framework',
    assistant_message: {
      role: 'assistant',
      content: 'Priority order: Oil-control treatment -> Lightweight moisturizer -> Daily sunscreen.',
      format: 'markdown',
    },
    suggested_chips: [],
    cards: [
      {
        card_id: 'card_framework_reco',
        type: 'recommendations',
        payload: {
          framework_summary: {
            concern_text: 'oily skin',
          },
          primary_role_id: 'oil_control_treatment',
          recommendations: [
            {
              product_id: 'prod_serum_1',
              matched_role_id: 'oil_control_treatment',
              display_name: 'Oil Balance Serum',
            },
          ],
          recommendation_meta: {
            framework_owner_source: 'generic_concern_framework_resolver',
            framework_owner_state: 'trusted',
            primary_role_id: 'oil_control_treatment',
            primary_recommendation_id: 'prod_serum_1',
          },
        },
      },
    ],
    session_patch: {},
    events: [],
  }));

  const app = createApp();
  const response = await request(app)
    .post('/v1/chat/stream')
    .send({
      message: 'im oily skin, what product should i use?',
      context: {
        locale: 'en',
        profile: {
          skinType: 'oily',
          goals: ['oil control'],
        },
      },
      client_state: { state: 'IDLE_CHAT' },
    })
    .expect(200);

  const parsed = parseSse(response.text);
  const result = parsed.find((event) => event.event === 'result')?.data || {};
  assert.equal(result.request_id, 'req_stream_framework');
  assert.equal(result.cards?.[0]?.type, 'recommendations');
  assert.equal(result.cards?.[0]?.payload?.primary_role_id, 'oil_control_treatment');
  assert.equal(result.cards?.[0]?.payload?.recommendation_meta?.framework_owner_source, 'generic_concern_framework_resolver');
  const thinkingSteps = parsed.filter((event) => event.event === 'thinking').map((event) => event.data?.step);
  assert.ok(thinkingSteps.includes('routing_framework_mainline'));
});
