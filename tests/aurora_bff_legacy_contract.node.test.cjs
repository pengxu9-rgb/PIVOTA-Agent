'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

const routesModuleId = require.resolve('../src/auroraBff/routes');

function withEnv(overrides, fn) {
  const prev = {};
  const keys = Object.keys(overrides || {});
  for (const key of keys) {
    prev[key] = process.env[key];
    const next = overrides[key];
    if (next == null) delete process.env[key];
    else process.env[key] = String(next);
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
    delete require.cache[routesModuleId];
  }
}

function findCardByType(cards, type) {
  const target = String(type || '').trim().toLowerCase();
  return (Array.isArray(cards) ? cards : []).find((card) => String(card && card.type ? card.type : '').trim().toLowerCase() === target) || null;
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
    'X-Aurora-UID': 'uid_legacy_contract',
    'X-Trace-ID': 'trace_legacy_contract',
    'X-Brief-ID': 'brief_legacy_contract',
    'X-Lang': 'EN',
  };
}

test('legacy response format keeps analysis_summary and strips analysis_story_v2 for /v1/analysis/skin', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_RESPONSE_FORMAT: 'legacy',
    },
    async () => {
      const request = supertest(createApp());
      const resp = await request
        .post('/v1/analysis/skin')
        .set(buildHeaders())
        .send({ use_photo: false, photos: [] })
        .expect(200);

      const cards = Array.isArray(resp.body && resp.body.cards) ? resp.body.cards : [];
      assert.ok(findCardByType(cards, 'analysis_summary'));
      assert.equal(findCardByType(cards, 'analysis_story_v2'), null);
    },
  );
});

test('chatcards response format keeps analysis_story_v2 for /v1/analysis/skin', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_RESPONSE_FORMAT: 'chatcards',
    },
    async () => {
      const request = supertest(createApp());
      const resp = await request
        .post('/v1/analysis/skin')
        .set(buildHeaders())
        .send({ use_photo: false, photos: [] })
        .expect(200);

      const cards = Array.isArray(resp.body && resp.body.cards) ? resp.body.cards : [];
      assert.ok(findCardByType(cards, 'analysis_story_v2'));
    },
  );
});
