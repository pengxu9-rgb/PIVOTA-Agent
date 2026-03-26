const express = require('express');
const request = require('supertest');

const { UserProfilePatchSchema } = require('../src/auroraBff/schemas');
const { mountProfileRoutes } = require('../src/auroraBff/routes/profileRoutes');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const deps = {
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    buildRequestContext: jest.fn(() => ({
      request_id: 'req_profile_1',
      trace_id: 'trace_profile_1',
      aurora_uid: 'uid_profile_1',
      lang: 'EN',
    })),
    requireAuroraUid: jest.fn(),
    resolveIdentity: jest.fn(async () => ({
      auroraUid: 'uid_profile_1',
      userId: 'user_profile_1',
    })),
    extractProfilePatchFromRoutinePayload: jest.fn(() => null),
    UserProfilePatchSchema,
    upsertProfileForIdentity: jest.fn(async (_identity, patch) => ({
      ...patch,
      saved: true,
    })),
    summarizeProfileForContext: jest.fn((profile) => profile || null),
    buildEnvelope: jest.fn((ctx, payload) => ({
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      ...payload,
    })),
    makeAssistantMessage: jest.fn((text) => text),
    makeEvent: jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data })),
    classifyStorageError: jest.fn((err) => ({
      code: err?.code || null,
      dbError: err?.dbError === true,
      dbNotConfigured: err?.dbNotConfigured === true,
      dbSchemaError: err?.dbSchemaError === true,
    })),
    deleteIdentityData: jest.fn(async () => ({ ok: true, deleted: true, storage: 'memory' })),
    deleteHardCasesForIdentity: jest.fn(async () => ({ deleted: 2 })),
    isPlainObject: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
  };

  mountProfileRoutes(app, {
    ...deps,
    ...overrides,
  });

  return { app, deps: { ...deps, ...overrides } };
}

describe('mountProfileRoutes', () => {
  test('profile update merges routine-derived patch before save', async () => {
    const { app, deps } = buildApp({
      extractProfilePatchFromRoutinePayload: jest.fn(() => ({
        skinType: 'dry',
        goals: ['hydration'],
      })),
    });

    const res = await request(app)
      .post('/v1/profile/update')
      .send({
        currentRoutine: { profile: { skinType: 'dry', goals: ['hydration'] } },
        sensitivity: 'high',
      })
      .expect(200);

    expect(deps.upsertProfileForIdentity).toHaveBeenCalledWith(
      { auroraUid: 'uid_profile_1', userId: 'user_profile_1' },
      expect.objectContaining({
        skinType: 'dry',
        sensitivity: 'high',
        goals: ['hydration'],
      }),
    );
    expect(res.body.cards[0]).toEqual(
      expect.objectContaining({
        type: 'profile',
        payload: expect.objectContaining({
          profile: expect.objectContaining({
            skinType: 'dry',
            sensitivity: 'high',
          }),
        }),
      }),
    );
  });

  test('profile update storage error maps to DB_UNAVAILABLE', async () => {
    const { app } = buildApp({
      upsertProfileForIdentity: jest.fn(async () => {
        const err = new Error('db down');
        err.dbError = true;
        throw err;
      }),
    });

    const res = await request(app)
      .post('/v1/profile/update')
      .send({ skinType: 'oily' })
      .expect(503);

    expect(res.body.cards[0]).toEqual(
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({ error: 'DB_UNAVAILABLE' }),
      }),
    );
  });

  test('profile delete clears session state and runs hard-case cleanup', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/v1/profile/delete')
      .send({})
      .expect(200);

    expect(deps.deleteIdentityData).toHaveBeenCalledWith({
      auroraUid: 'uid_profile_1',
      userId: 'user_profile_1',
    });
    expect(deps.deleteHardCasesForIdentity).toHaveBeenCalledWith({
      auroraUid: 'uid_profile_1',
      userId: 'user_profile_1',
      logger: deps.logger,
    });
    expect(res.body.cards[0]).toEqual(
      expect.objectContaining({
        type: 'profile_deleted',
        payload: expect.objectContaining({ ok: true, deleted: true, storage: 'memory' }),
      }),
    );
    expect(res.body.session_patch).toEqual({
      profile: null,
      recent_logs: [],
      checkin_due: true,
      is_returning: false,
    });
  });
});
