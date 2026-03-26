const { createIdentityRoutesRuntime } = require('../src/auroraBff/identityRoutesRuntime');

function buildRuntime() {
  const deps = {
    buildEnvelope: jest.fn((ctx, payload) => ({
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      ...payload,
    })),
    makeAssistantMessage: jest.fn((text) => ({ text })),
    makeEvent: jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data })),
    summarizeProfileForContext: jest.fn((profile) =>
      profile ? { skinType: profile.skinType || null, concerns: profile.concerns || [] } : null,
    ),
    classifyStorageError: jest.fn((err) => ({
      code: err?.code || null,
      dbError: err?.dbError === true,
      dbNotConfigured: err?.dbNotConfigured === true,
      dbSchemaError: err?.dbSchemaError === true,
    })),
  };

  return {
    deps,
    runtime: createIdentityRoutesRuntime(deps),
  };
}

describe('createIdentityRoutesRuntime', () => {
  const ctx = {
    request_id: 'req_identity_1',
    trace_id: 'trace_identity_1',
    state: 'IDLE_CHAT',
    trigger_source: 'http',
  };

  test('buildSessionBootstrapSuccessEnvelope emits bootstrap card and session patch', () => {
    const { runtime } = buildRuntime();

    const envelope = runtime.buildSessionBootstrapSuccessEnvelope(ctx, {
      profile: { skinType: 'oily', concerns: ['acne'] },
      recentLogs: [{ date: '2026-03-20' }],
      checkinDue: false,
      isReturning: true,
      dbError: null,
    });

    expect(envelope.cards[0]).toEqual(
      expect.objectContaining({
        type: 'session_bootstrap',
        payload: expect.objectContaining({
          profile: { skinType: 'oily', concerns: ['acne'] },
          recent_logs: [{ date: '2026-03-20' }],
          checkin_due: false,
          is_returning: true,
          db_ready: true,
        }),
      }),
    );
    expect(envelope.session_patch).toEqual(
      expect.objectContaining({
        profile: { skinType: 'oily', concerns: ['acne'] },
        recent_logs: [{ date: '2026-03-20' }],
        checkin_due: false,
        is_returning: true,
      }),
    );
  });

  test('buildSessionBootstrapFailureEnvelope emits error card with fallback code', () => {
    const { runtime } = buildRuntime();
    const err = new Error('missing uid');
    err.code = 'MISSING_AURORA_UID';

    const envelope = runtime.buildSessionBootstrapFailureEnvelope(ctx, err);

    expect(envelope.cards[0]).toEqual(
      expect.objectContaining({
        type: 'error',
        payload: { error: 'MISSING_AURORA_UID' },
      }),
    );
    expect(envelope.events).toEqual([
      expect.objectContaining({
        event_name: 'error',
        data: { code: 'MISSING_AURORA_UID' },
      }),
    ]);
  });

  test('buildProfileSavedEnvelope emits profile card and session patch', () => {
    const { runtime } = buildRuntime();

    const envelope = runtime.buildProfileSavedEnvelope(
      ctx,
      { skinType: 'dry', concerns: ['hydration'] },
      ['skinType', 'concerns'],
    );

    expect(envelope.cards[0]).toEqual(
      expect.objectContaining({
        type: 'profile',
        payload: {
          profile: { skinType: 'dry', concerns: ['hydration'] },
        },
      }),
    );
    expect(envelope.session_patch).toEqual({
      profile: { skinType: 'dry', concerns: ['hydration'] },
    });
  });

  test('buildProfileStorageFailureEnvelope maps db failures to DB_UNAVAILABLE', () => {
    const { runtime } = buildRuntime();
    const err = new Error('db down');
    err.dbError = true;

    const failure = runtime.buildProfileStorageFailureEnvelope(ctx, err, 'PROFILE_SAVE_FAILED');

    expect(failure.status).toBe(503);
    expect(failure.body.cards[0]).toEqual(
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({ error: 'DB_UNAVAILABLE' }),
      }),
    );
  });

  test('buildAuthSessionEnvelope emits auth session card and method-aware event', () => {
    const { runtime } = buildRuntime();

    const envelope = runtime.buildAuthSessionEnvelope(ctx, {
      session: {
        token: 'session_token_1',
        expiresAt: '2026-03-24T00:00:00.000Z',
      },
      userId: 'user_1',
      email: 'user@example.com',
      method: 'password',
    });

    expect(envelope.cards[0]).toEqual(
      expect.objectContaining({
        type: 'auth_session',
        payload: expect.objectContaining({
          token: 'session_token_1',
          expires_at: '2026-03-24T00:00:00.000Z',
          user: { user_id: 'user_1', email: 'user@example.com' },
        }),
      }),
    );
    expect(envelope.events).toEqual([
      expect.objectContaining({
        event_name: 'auth_verified',
        data: { user_id: 'user_1', method: 'password' },
      }),
    ]);
  });

  test('buildAuthPasswordLoginFailureEnvelope maps locked login to PASSWORD_LOCKED', () => {
    const { runtime } = buildRuntime();

    const failure = runtime.buildAuthPasswordLoginFailureEnvelope(ctx, {
      reason: 'locked',
      locked_until: '2026-03-24T00:00:00.000Z',
    });

    expect(failure.status).toBe(429);
    expect(failure.body.cards[0]).toEqual(
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({
          error: 'PASSWORD_LOCKED',
          reason: 'locked',
          locked_until: '2026-03-24T00:00:00.000Z',
        }),
      }),
    );
  });

  test('buildAuthStartFailureEnvelope maps db schema errors to DB_SCHEMA_NOT_READY', () => {
    const { runtime } = buildRuntime();
    const err = new Error('schema not ready');
    err.dbSchemaError = true;

    const failure = runtime.buildAuthStartFailureEnvelope(ctx, err);

    expect(failure.status).toBe(503);
    expect(failure.body.cards[0]).toEqual(
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({ error: 'DB_SCHEMA_NOT_READY' }),
      }),
    );
  });
});
