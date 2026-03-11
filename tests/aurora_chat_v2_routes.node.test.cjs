const assert = require('assert');
const test = require('node:test');
const express = require('express');
const request = require('supertest');

const { registerRoutes } = require('../src/auroraBff');
const { __resetRouterForTests, __setLegacyChatProxyForTests } = require('../src/auroraBff/routes/chat');

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
});

test.after(() => {
  delete process.env.AURORA_CHAT_V2_STUB_RESPONSES;
  __resetRouterForTests();
});

test('POST /v1/chat/stream proxies deep-dive prompts to legacy chat route', async () => {
  __setLegacyChatProxyForTests(async () => ({
    status: 200,
    data: {
      assistant_message: { role: 'assistant', content: 'This explanation stays grounded in your latest photo-based analysis.' },
      cards: [
        {
          card_id: 'analysis_followup_story_test',
          type: 'analysis_story_v2',
          payload: { summary: 'This explanation stays grounded in your latest photo-based analysis.' },
        },
      ],
      events: [
        {
          event_name: 'analysis_followup_action_routed',
          data: { action_id: 'chip.aurora.next_action.deep_dive_skin', fell_back_to_generic: false },
        },
      ],
      suggested_chips: [],
      session_patch: {},
    },
  }));

  const app = createApp();
  const response = await request(app)
    .post('/v1/chat/stream')
    .send({
      message: 'Tell me more about my skin',
      language: 'EN',
    })
    .expect(200);

  const parsed = parseSse(response.text);
  const resultPayload = parsed.find((event) => event.event === 'result')?.data;
  assert.equal(parsed.some((event) => event.event === 'thinking'), false);
  assert.ok(Array.isArray(resultPayload?.cards));
  assert.equal(resultPayload?.cards?.[0]?.type, 'analysis_story_v2');
  assert.equal(
    resultPayload?.events?.some((event) => event && event.event_name === 'analysis_followup_action_routed'),
    true,
  );
  assert.strictEqual(parsed[parsed.length - 1]?.event, 'done');
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
