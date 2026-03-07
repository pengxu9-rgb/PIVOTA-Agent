const assert = require('assert');
const test = require('node:test');
const express = require('express');
const request = require('supertest');

const { registerRoutes } = require('../src/auroraBff');
const { __resetRouterForTests } = require('../src/auroraBff/routes/chat');

function createApp() {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  return app;
}

test.beforeEach(() => {
  process.env.AURORA_CHAT_V2_STUB_RESPONSES = '1';
  __resetRouterForTests();
});

test.after(() => {
  delete process.env.AURORA_CHAT_V2_STUB_RESPONSES;
  __resetRouterForTests();
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
