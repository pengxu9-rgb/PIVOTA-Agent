const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const { mountTrackerRoutes } = require('../src/auroraBff/routes/trackerRoutes');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const deps = {
    logger: { warn: jest.fn(), error: jest.fn() },
    buildRequestContext: jest.fn(() => ({
      request_id: 'req_tracker_1',
      trace_id: 'trace_tracker_1',
      aurora_uid: 'uid_tracker_1',
      lang: 'EN',
    })),
    requireAuroraUid: jest.fn(),
    buildEnvelope: jest.fn((ctx, payload) => ({
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      ...payload,
    })),
    makeAssistantMessage: jest.fn((text) => text),
    makeEvent: jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data })),
    resolveIdentity: jest.fn(async () => ({ auroraUid: 'uid_tracker_1', userId: 'user_tracker_1' })),
    upsertSkinLogForIdentity: jest.fn(async (_identity, payload) => ({
      date: payload.date,
      redness: payload.redness,
    })),
    getRecentSkinLogsForIdentity: jest.fn(async (_identity, days) => [
      { date: '2026-02-06', redness: 2 },
      { date: '2026-02-05', redness: 1, days },
    ]),
    isCheckinDue: jest.fn(() => false),
    classifyStorageError: jest.fn((err) => ({
      code: err?.code || null,
      dbError: err?.dbError === true,
      dbNotConfigured: err?.dbNotConfigured === true,
      dbSchemaError: err?.dbSchemaError === true,
    })),
    TrackerLogSchema: z.object({
      date: z.string(),
      redness: z.number().optional(),
      acne: z.number().optional(),
      hydration: z.number().optional(),
      notes: z.string().optional(),
    }),
  };

  mountTrackerRoutes(app, {
    ...deps,
    ...overrides,
  });

  return { app, deps: { ...deps, ...overrides } };
}

describe('mountTrackerRoutes', () => {
  test('tracker log invalid request returns BAD_REQUEST envelope', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/v1/tracker/log')
      .send({})
      .expect(400);

    expect(res.body.cards[0].type).toBe('error');
    expect(res.body.cards[0].payload.error).toBe('BAD_REQUEST');
  });

  test('tracker log happy path returns tracker_log payload and refresh hint', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/v1/tracker/log')
      .send({ date: '2026-02-06', redness: 2 })
      .expect(200);

    expect(deps.upsertSkinLogForIdentity).toHaveBeenCalled();
    expect(res.body.cards[0].type).toBe('tracker_log');
    expect(res.body.cards[0].payload.reco_refresh_hint).toEqual(
      expect.objectContaining({ should_refresh: true, reason: 'checkin_logged' }),
    );
    expect(res.body.session_patch).toEqual(
      expect.objectContaining({
        recent_logs: expect.any(Array),
        checkin_due: false,
      }),
    );
  });

  test('tracker recent storage error maps to DB_UNAVAILABLE envelope', async () => {
    const { app } = buildApp({
      getRecentSkinLogsForIdentity: jest.fn(async () => {
        const err = new Error('db down');
        err.dbError = true;
        throw err;
      }),
    });

    const res = await request(app)
      .get('/v1/tracker/recent')
      .query({ days: 7 })
      .expect(503);

    expect(res.body.cards[0].type).toBe('error');
    expect(res.body.cards[0].payload.error).toBe('DB_UNAVAILABLE');
  });
});
