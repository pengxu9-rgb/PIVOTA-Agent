const { createIdentityRoutesRuntime } = require('../identityRoutesRuntime');

function ensureFunction(name, value) {
  if (typeof value === 'function') return value;
  throw new Error(`aurora auth routes missing dependency: ${name}`);
}

function ensureSchema(name, value) {
  if (value && typeof value.safeParse === 'function') return value;
  throw new Error(`aurora auth routes missing schema: ${name}`);
}

function mountAuthRoutes(app, deps = {}) {
  const buildRequestContext = ensureFunction('buildRequestContext', deps.buildRequestContext);
  const requireAuroraUid = ensureFunction('requireAuroraUid', deps.requireAuroraUid);
  const buildEnvelope = ensureFunction('buildEnvelope', deps.buildEnvelope);
  const makeAssistantMessage = ensureFunction('makeAssistantMessage', deps.makeAssistantMessage);
  const makeEvent = ensureFunction('makeEvent', deps.makeEvent);
  const createOtpChallenge = ensureFunction('createOtpChallenge', deps.createOtpChallenge);
  const verifyOtpChallenge = ensureFunction('verifyOtpChallenge', deps.verifyOtpChallenge);
  const createSession = ensureFunction('createSession', deps.createSession);
  const upsertIdentityLink = ensureFunction('upsertIdentityLink', deps.upsertIdentityLink);
  const migrateGuestDataToUser = ensureFunction('migrateGuestDataToUser', deps.migrateGuestDataToUser);
  const classifyStorageError = ensureFunction('classifyStorageError', deps.classifyStorageError);
  const verifyPasswordForEmail = ensureFunction('verifyPasswordForEmail', deps.verifyPasswordForEmail);
  const resolveIdentity = ensureFunction('resolveIdentity', deps.resolveIdentity);
  const setUserPassword = ensureFunction('setUserPassword', deps.setUserPassword);
  const getBearerToken = ensureFunction('getBearerToken', deps.getBearerToken);
  const revokeSessionToken = ensureFunction('revokeSessionToken', deps.revokeSessionToken);

  const AuthStartRequestSchema = ensureSchema('AuthStartRequestSchema', deps.AuthStartRequestSchema);
  const AuthVerifyRequestSchema = ensureSchema('AuthVerifyRequestSchema', deps.AuthVerifyRequestSchema);
  const AuthPasswordSetRequestSchema = ensureSchema(
    'AuthPasswordSetRequestSchema',
    deps.AuthPasswordSetRequestSchema,
  );
  const AuthPasswordLoginRequestSchema = ensureSchema(
    'AuthPasswordLoginRequestSchema',
    deps.AuthPasswordLoginRequestSchema,
  );

  const logger = deps && typeof deps.logger === 'object' ? deps.logger : null;
  const identityRoutesRuntime = createIdentityRoutesRuntime({
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
    classifyStorageError,
  });

  app.post('/v1/auth/start', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = AuthStartRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json(identityRoutesRuntime.buildBadRequestEnvelope(ctx, parsed.error.format()));
      }

      const challenge = await createOtpChallenge({ email: parsed.data.email, language: ctx.lang });
      return res.json(identityRoutesRuntime.buildAuthStartSuccessEnvelope(ctx, challenge));
    } catch (err) {
      const failure = identityRoutesRuntime.buildAuthStartFailureEnvelope(ctx, err);
      return res.status(failure.status).json(failure.body);
    }
  });

  app.post('/v1/auth/verify', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = AuthVerifyRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json(identityRoutesRuntime.buildBadRequestEnvelope(ctx, parsed.error.format()));
      }

      const verification = await verifyOtpChallenge({ email: parsed.data.email, code: parsed.data.code });
      if (!verification.ok) {
        return res.status(401).json(identityRoutesRuntime.buildAuthInvalidCodeEnvelope(ctx, verification));
      }

      const session = await createSession({ userId: verification.userId });

      if (ctx.aurora_uid) {
        try {
          await upsertIdentityLink(ctx.aurora_uid, verification.userId);
        } catch {
          // ignore
        }
        try {
          await migrateGuestDataToUser({ auroraUid: ctx.aurora_uid, userId: verification.userId });
        } catch (err) {
          logger?.warn?.({ err: err?.message || String(err) }, 'aurora bff: guest->account migration failed');
        }
      }

      return res.json(identityRoutesRuntime.buildAuthSessionEnvelope(ctx, {
        session,
        userId: verification.userId,
        email: verification.email,
      }));
    } catch (err) {
      const failure = identityRoutesRuntime.buildAuthVerifyFailureEnvelope(ctx, err);
      return res.status(failure.status).json(failure.body);
    }
  });

  app.post('/v1/auth/password/login', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = AuthPasswordLoginRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json(identityRoutesRuntime.buildBadRequestEnvelope(ctx, parsed.error.format()));
      }

      const verification = await verifyPasswordForEmail({
        email: parsed.data.email,
        password: parsed.data.password,
      });
      if (!verification.ok) {
        const failure = identityRoutesRuntime.buildAuthPasswordLoginFailureEnvelope(ctx, verification);
        return res.status(failure.status).json(failure.body);
      }

      const session = await createSession({ userId: verification.userId });

      if (ctx.aurora_uid) {
        try {
          await upsertIdentityLink(ctx.aurora_uid, verification.userId);
        } catch {
          // ignore
        }
        try {
          await migrateGuestDataToUser({ auroraUid: ctx.aurora_uid, userId: verification.userId });
        } catch (err) {
          logger?.warn?.({ err: err?.message || String(err) }, 'aurora bff: guest->account migration failed');
        }
      }

      return res.json(identityRoutesRuntime.buildAuthSessionEnvelope(ctx, {
        session,
        userId: verification.userId,
        email: verification.email,
        method: 'password',
      }));
    } catch (err) {
      const failure = identityRoutesRuntime.buildAuthPasswordLoginStorageFailureEnvelope(ctx, err);
      return res.status(failure.status).json(failure.body);
    }
  });

  app.post('/v1/auth/password/set', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const identity = await resolveIdentity(req, ctx);
      const resolvedIdentity = {
        auroraUid: identity.auroraUid || null,
        userId: identity.userId || null,
      };
      if (!resolvedIdentity.userId) {
        return res
          .status(401)
          .json(identityRoutesRuntime.buildUnauthorizedEnvelope(ctx, ctx.lang === 'CN' ? '请先登录。' : 'Please sign in first.'));
      }

      const parsed = AuthPasswordSetRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json(identityRoutesRuntime.buildBadRequestEnvelope(ctx, parsed.error.format()));
      }

      await setUserPassword({ userId: resolvedIdentity.userId, password: parsed.data.password });

      return res.json(identityRoutesRuntime.buildAuthPasswordSetSuccessEnvelope(ctx, resolvedIdentity.userId));
    } catch (err) {
      const failure = identityRoutesRuntime.buildAuthPasswordSetFailureEnvelope(ctx, err);
      return res.status(failure.status).json(failure.body);
    }
  });

  app.get('/v1/auth/me', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const identity = await resolveIdentity(req, ctx);
      if (!identity.userId) {
        return res
          .status(401)
          .json(identityRoutesRuntime.buildUnauthorizedEnvelope(ctx, ctx.lang === 'CN' ? '未登录。' : 'Not signed in.'));
      }

      return res.json(identityRoutesRuntime.buildAuthMeEnvelope(ctx, identity));
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      return res.status(status).json(identityRoutesRuntime.buildAuthMeFailureEnvelope(ctx, err));
    }
  });

  app.post('/v1/auth/logout', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const token = getBearerToken(req);
      if (token) {
        try {
          await revokeSessionToken(token);
        } catch {
          // ignore
        }
      }

      return res.json(identityRoutesRuntime.buildAuthLogoutEnvelope(ctx));
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      return res.status(status).json(identityRoutesRuntime.buildAuthLogoutFailureEnvelope(ctx, err));
    }
  });
}

module.exports = {
  mountAuthRoutes,
};
