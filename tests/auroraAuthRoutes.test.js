const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const { mountAuthRoutes } = require('../src/auroraBff/routes/authRoutes');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const deps = {
    logger: { warn: jest.fn(), error: jest.fn() },
    buildRequestContext: jest.fn(() => ({
      request_id: 'req_auth_1',
      trace_id: 'trace_auth_1',
      aurora_uid: 'uid_auth_1',
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
    createOtpChallenge: jest.fn(async () => ({
      email: 'user@example.com',
      challengeId: 'challenge_1',
      expiresAt: '2026-03-23T00:00:00.000Z',
      expiresInSeconds: 600,
      delivery: 'email',
      debug_code: '123456',
    })),
    verifyOtpChallenge: jest.fn(async () => ({
      ok: true,
      userId: 'user_1',
      email: 'user@example.com',
    })),
    createSession: jest.fn(async () => ({
      token: 'session_token_1',
      expiresAt: '2026-03-24T00:00:00.000Z',
    })),
    upsertIdentityLink: jest.fn(async () => {}),
    migrateGuestDataToUser: jest.fn(async () => {}),
    classifyStorageError: jest.fn(() => ({
      code: null,
      dbError: false,
      dbNotConfigured: false,
      dbSchemaError: false,
    })),
    verifyPasswordForEmail: jest.fn(async () => ({
      ok: true,
      userId: 'user_1',
      email: 'user@example.com',
    })),
    resolveIdentity: jest.fn(async () => ({
      auroraUid: 'uid_auth_1',
      userId: 'user_1',
      userEmail: 'user@example.com',
    })),
    setUserPassword: jest.fn(async () => {}),
    getBearerToken: jest.fn((req) => {
      const header = req.get('authorization') || '';
      return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    }),
    revokeSessionToken: jest.fn(async () => {}),
    AuthStartRequestSchema: z.object({ email: z.string().email() }),
    AuthVerifyRequestSchema: z.object({ email: z.string().email(), code: z.string().min(4) }),
    AuthPasswordSetRequestSchema: z.object({ password: z.string().min(8) }),
    AuthPasswordLoginRequestSchema: z.object({
      email: z.string().email(),
      password: z.string().min(8),
    }),
  };

  mountAuthRoutes(app, {
    ...deps,
    ...overrides,
  });

  return { app, deps: { ...deps, ...overrides } };
}

describe('mountAuthRoutes', () => {
  test('auth start invalid request returns BAD_REQUEST envelope', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/v1/auth/start')
      .send({})
      .expect(400);

    expect(res.body.cards[0].type).toBe('error');
    expect(res.body.cards[0].payload.error).toBe('BAD_REQUEST');
  });

  test('auth verify success returns auth_session and migrates guest identity', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/v1/auth/verify')
      .send({ email: 'user@example.com', code: '123456' })
      .expect(200);

    expect(deps.createSession).toHaveBeenCalledWith({ userId: 'user_1' });
    expect(deps.upsertIdentityLink).toHaveBeenCalledWith('uid_auth_1', 'user_1');
    expect(deps.migrateGuestDataToUser).toHaveBeenCalledWith({
      auroraUid: 'uid_auth_1',
      userId: 'user_1',
    });
    expect(res.body.cards[0].type).toBe('auth_session');
  });

  test('password login locked returns PASSWORD_LOCKED', async () => {
    const { app } = buildApp({
      verifyPasswordForEmail: jest.fn(async () => ({
        ok: false,
        reason: 'locked',
        locked_until: '2026-03-24T00:00:00.000Z',
      })),
    });

    const res = await request(app)
      .post('/v1/auth/password/login')
      .send({ email: 'user@example.com', password: 'password123' })
      .expect(429);

    expect(res.body.cards[0].payload.error).toBe('PASSWORD_LOCKED');
  });

  test('password set without identity returns UNAUTHORIZED', async () => {
    const { app } = buildApp({
      resolveIdentity: jest.fn(async () => ({
        auroraUid: 'uid_auth_1',
        userId: null,
        userEmail: null,
      })),
    });

    const res = await request(app)
      .post('/v1/auth/password/set')
      .send({ password: 'password123' })
      .expect(401);

    expect(res.body.cards[0].payload.error).toBe('UNAUTHORIZED');
  });

  test('auth me returns auth_me card for signed-in user', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .get('/v1/auth/me')
      .expect(200);

    expect(res.body.cards[0].type).toBe('auth_me');
    expect(res.body.cards[0].payload.user.user_id).toBe('user_1');
  });

  test('auth logout revokes bearer token and returns auth_logout', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/v1/auth/logout')
      .set('Authorization', 'Bearer session_token_1')
      .send({})
      .expect(200);

    expect(deps.revokeSessionToken).toHaveBeenCalledWith('session_token_1');
    expect(res.body.cards[0].type).toBe('auth_logout');
  });
});
