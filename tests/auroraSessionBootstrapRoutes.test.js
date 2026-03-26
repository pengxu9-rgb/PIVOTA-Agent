const express = require('express');
const request = require('supertest');

const { mountSessionBootstrapRoutes } = require('../src/auroraBff/routes/sessionBootstrapRoutes');

function buildApp(overrides = {}) {
  const app = express();

  const deps = {
    logger: { warn: jest.fn(), error: jest.fn() },
    buildRequestContext: jest.fn(() => ({
      request_id: 'req_bootstrap_1',
      trace_id: 'trace_bootstrap_1',
      aurora_uid: 'uid_bootstrap_1',
      lang: 'EN',
      state: 'IDLE_CHAT',
      trigger_source: 'http',
    })),
    requireAuroraUid: jest.fn(),
    resolveIdentity: jest.fn(async () => ({
      auroraUid: 'uid_bootstrap_1',
      userId: 'user_bootstrap_1',
    })),
    getProfileForIdentity: jest.fn(async () => ({
      skinType: 'oily',
      concerns: ['acne'],
    })),
    getRecentSkinLogsForIdentity: jest.fn(async () => [{ date: '2026-03-20', redness: 1 }]),
    isCheckinDue: jest.fn(() => false),
    summarizeProfileForContext: jest.fn((profile) => profile || null),
    buildEnvelope: jest.fn((ctx, payload) => ({
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      ...payload,
    })),
    makeAssistantMessage: jest.fn((text) => text),
    makeEvent: jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data })),
  };

  mountSessionBootstrapRoutes(app, {
    ...deps,
    ...overrides,
  });

  return { app, deps: { ...deps, ...overrides } };
}

describe('mountSessionBootstrapRoutes', () => {
  test('session bootstrap returns session_bootstrap card and session patch', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .get('/v1/session/bootstrap')
      .expect(200);

    expect(deps.resolveIdentity).toHaveBeenCalled();
    expect(res.body.cards[0]).toEqual(
      expect.objectContaining({
        type: 'session_bootstrap',
        payload: expect.objectContaining({
          db_ready: true,
          is_returning: true,
          checkin_due: false,
        }),
      }),
    );
    expect(res.body.session_patch).toEqual(
      expect.objectContaining({
        profile: expect.objectContaining({ skinType: 'oily' }),
        recent_logs: expect.any(Array),
        checkin_due: false,
        is_returning: true,
      }),
    );
  });

  test('session bootstrap degrades to db_ready=false when profile load fails', async () => {
    const { app } = buildApp({
      getProfileForIdentity: jest.fn(async () => {
        throw new Error('db down');
      }),
      getRecentSkinLogsForIdentity: jest.fn(async () => []),
      isCheckinDue: jest.fn(() => true),
    });

    const res = await request(app)
      .get('/v1/session/bootstrap')
      .expect(200);

    expect(res.body.cards[0]).toEqual(
      expect.objectContaining({
        type: 'session_bootstrap',
        payload: expect.objectContaining({
          db_ready: false,
          is_returning: false,
          checkin_due: true,
        }),
        field_missing: [{ field: 'profile', reason: 'db_not_configured_or_unavailable' }],
      }),
    );
  });

  test('session bootstrap missing aurora uid returns bootstrap failure envelope', async () => {
    const err = new Error('missing uid');
    err.status = 401;
    err.code = 'MISSING_AURORA_UID';
    const { app } = buildApp({
      requireAuroraUid: jest.fn(() => {
        throw err;
      }),
    });

    const res = await request(app)
      .get('/v1/session/bootstrap')
      .expect(401);

    expect(res.body.cards[0]).toEqual(
      expect.objectContaining({
        type: 'error',
        payload: { error: 'MISSING_AURORA_UID' },
      }),
    );
  });
});
