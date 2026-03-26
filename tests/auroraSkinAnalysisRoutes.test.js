const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const { mountSkinAnalysisRoutes } = require('../src/auroraBff/routes/skinAnalysisRoutes');

function buildDeps(overrides = {}) {
  const baseDeps = {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    buildRequestContext: jest.fn(() => ({
      request_id: 'req_skin_analysis_1',
      trace_id: 'trace_skin_analysis_1',
      aurora_uid: 'uid_skin_analysis_1',
      lang: 'EN',
      trigger_source: 'manual',
      state: 'idle',
    })),
    requireAuroraUid: jest.fn(),
    SkinAnalysisRequestSchema: z.object({
      photos: z.array(z.record(z.any())).min(1),
    }),
    buildEnvelope: jest.fn((ctx, payload) => ({
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      ...payload,
    })),
    makeAssistantMessage: jest.fn((text) => text),
    makeEvent: jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data })),
  };

  const merged = {
    ...baseDeps,
    ...overrides,
  };

  return new Proxy(merged, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return target[prop];
      return jest.fn(async () => null);
    },
  });
}

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const deps = buildDeps(overrides);
  mountSkinAnalysisRoutes(app, deps);
  return { app, deps };
}

describe('mountSkinAnalysisRoutes', () => {
  test('skin analysis invalid request returns BAD_REQUEST envelope', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/v1/analysis/skin')
      .send({})
      .expect(400);

    expect(deps.requireAuroraUid).toHaveBeenCalled();
    expect(res.body.cards[0].type).toBe('error');
    expect(res.body.cards[0].payload.error).toBe('BAD_REQUEST');
  });
});
