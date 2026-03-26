function createIdentityRoutesRuntime(options = {}) {
  const {
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
    summarizeProfileForContext,
    classifyStorageError,
  } = options;

  function summarizeProfile(profile) {
    return typeof summarizeProfileForContext === 'function'
      ? summarizeProfileForContext(profile)
      : profile || null;
  }

  function buildErrorEnvelope(
    ctx,
    {
      assistantText = 'Invalid request.',
      error = 'BAD_REQUEST',
      details,
      reason,
      payload = {},
      eventCode = error,
      sessionPatch = {},
    } = {},
  ) {
    return buildEnvelope(ctx, {
      assistant_message: makeAssistantMessage(assistantText),
      suggested_chips: [],
      cards: [
        {
          card_id: `err_${ctx.request_id}`,
          type: 'error',
          payload: {
            error,
            ...(details !== undefined ? { details } : {}),
            ...(reason !== undefined ? { reason } : {}),
            ...(payload && typeof payload === 'object' ? payload : {}),
          },
        },
      ],
      session_patch: sessionPatch,
      events: [makeEvent(ctx, 'error', { code: eventCode })],
    });
  }

  function resolveStorageFailure(err, fallbackCode, options = {}) {
    const {
      authNotConfiguredMessage,
      dbUnavailableMessage,
      genericMessage,
      explicitStatusByCode = {},
      explicitMessageByCode = {},
    } = options;
    const storageFailure =
      typeof classifyStorageError === 'function'
        ? classifyStorageError(err)
        : { code: err?.code || null, dbError: false, dbNotConfigured: false, dbSchemaError: false };
    const { code: storageCode, dbError, dbNotConfigured, dbSchemaError } = storageFailure;
    const fallbackErrorCode =
      err && err.code ? err.code : err && err.message ? err.message : fallbackCode;
    const code = storageCode || fallbackErrorCode;
    const explicitStatus = Object.prototype.hasOwnProperty.call(explicitStatusByCode, code)
      ? explicitStatusByCode[code]
      : null;
    const status =
      explicitStatus ||
      (code === 'AUTH_NOT_CONFIGURED'
        ? 503
        : dbError || dbSchemaError || dbNotConfigured
          ? 503
          : err && typeof err.status === 'number' && err.status >= 400 && err.status < 600
            ? err.status
            : 500);
    const error =
      dbNotConfigured
        ? 'DB_NOT_CONFIGURED'
        : dbSchemaError
          ? 'DB_SCHEMA_NOT_READY'
          : dbError
            ? 'DB_UNAVAILABLE'
            : code;
    const assistantText =
      explicitMessageByCode[code] ||
      (code === 'AUTH_NOT_CONFIGURED'
        ? authNotConfiguredMessage
        : dbError
          ? dbUnavailableMessage
          : genericMessage);

    return {
      status,
      code,
      error,
      assistantText,
      payload:
        storageCode && !dbNotConfigured && !dbSchemaError && !dbError
          ? { code: storageCode }
          : storageCode
            ? { code: storageCode }
            : {},
    };
  }

  function buildSessionBootstrapSuccessEnvelope(
    ctx,
    { profile = null, recentLogs = [], checkinDue = false, isReturning = false, dbError = null } = {},
  ) {
    const profileSummary = summarizeProfile(profile);
    const cards = [
      {
        card_id: `bootstrap_${ctx.request_id}`,
        type: 'session_bootstrap',
        payload: {
          profile: profileSummary,
          recent_logs: recentLogs,
          checkin_due: Boolean(checkinDue),
          is_returning: Boolean(isReturning),
          db_ready: !dbError,
        },
        ...(dbError
          ? { field_missing: [{ field: 'profile', reason: 'db_not_configured_or_unavailable' }] }
          : {}),
      },
    ];
    const events = [
      makeEvent(ctx, 'state_entered', {
        state: ctx.state || 'unknown',
        trigger_source: ctx.trigger_source,
      }),
    ];

    return buildEnvelope(ctx, {
      assistant_message: null,
      suggested_chips: [],
      cards,
      session_patch: {
        profile: profileSummary,
        recent_logs: recentLogs,
        checkin_due: Boolean(checkinDue),
        is_returning: Boolean(isReturning),
      },
      events,
    });
  }

  function buildSessionBootstrapFailureEnvelope(ctx, err) {
    return buildErrorEnvelope(ctx, {
      assistantText: 'Failed to bootstrap session.',
      error: err.code || 'BOOTSTRAP_FAILED',
      eventCode: err.code || 'BOOTSTRAP_FAILED',
    });
  }

  function buildProfileUpdateBadRequestEnvelope(ctx, details) {
    return buildErrorEnvelope(ctx, {
      assistantText: 'Invalid request.',
      error: 'BAD_REQUEST',
      details,
      eventCode: 'BAD_REQUEST',
    });
  }

  function buildProfileSavedEnvelope(ctx, updatedProfile, fields = []) {
    const profileSummary = summarizeProfile(updatedProfile);
    return buildEnvelope(ctx, {
      assistant_message: null,
      suggested_chips: [],
      cards: [
        {
          card_id: `profile_${ctx.request_id}`,
          type: 'profile',
          payload: { profile: profileSummary },
        },
      ],
      session_patch: { profile: profileSummary },
      events: [makeEvent(ctx, 'profile_saved', { fields })],
    });
  }

  function buildProfileDeletedEnvelope(ctx, result) {
    return buildEnvelope(ctx, {
      assistant_message: null,
      suggested_chips: [],
      cards: [
        {
          card_id: `profile_delete_${ctx.request_id}`,
          type: 'profile_deleted',
          payload: {
            ok: Boolean(result && result.ok),
            deleted: Boolean(result && result.deleted),
            storage: result?.storage || null,
          },
        },
      ],
      session_patch: {
        profile: null,
        recent_logs: [],
        checkin_due: true,
        is_returning: false,
      },
      events: [makeEvent(ctx, 'profile_deleted', { storage: result?.storage || null })],
    });
  }

  function toStorageFailure(err, fallbackCode) {
    const resolved = resolveStorageFailure(err, fallbackCode, {
      dbUnavailableMessage: 'Storage is not ready yet. Please try again shortly.',
      genericMessage:
        fallbackCode === 'PROFILE_DELETE_FAILED'
          ? 'Failed to delete profile data.'
          : 'Failed to save profile.',
      explicitStatusByCode: {
        BAD_REQUEST: 400,
      },
      explicitMessageByCode: {
        BAD_REQUEST: 'Invalid request.',
      },
    });

    return {
      status: resolved.status,
      code: resolved.code,
      errorCode: resolved.error,
      userMessage: resolved.assistantText,
      payload: resolved.payload,
    };
  }

  function buildProfileStorageFailureEnvelope(ctx, err, fallbackCode) {
    const failure = toStorageFailure(err, fallbackCode);
    return {
      status: failure.status,
      code: failure.code,
      body: buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(failure.userMessage),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error: failure.errorCode,
              ...(failure.status >= 400 && failure.status < 500
                ? {}
                : failure.code
                  ? { code: failure.code }
                  : {}),
              ...(failure.payload || {}),
            },
          },
        ],
        session_patch: {},
        events: [
          makeEvent(ctx, 'error', {
            code:
              (failure.status >= 400 && failure.status < 500 ? err.code : failure.code) ||
              fallbackCode,
          }),
        ],
      }),
    };
  }

  function buildAuthStartSuccessEnvelope(ctx, challenge) {
    return buildEnvelope(ctx, {
      assistant_message: makeAssistantMessage(
        ctx.lang === 'CN'
          ? '我已把验证码发送到你的邮箱。请输入验证码完成登录。'
          : "I've sent a sign-in code to your email. Enter the code to continue.",
      ),
      suggested_chips: [],
      cards: [
        {
          card_id: `auth_start_${ctx.request_id}`,
          type: 'auth_challenge',
          payload: {
            email: challenge.email,
            challenge_id: challenge.challengeId,
            expires_at: challenge.expiresAt,
            expires_in_seconds: challenge.expiresInSeconds,
            delivery: challenge.delivery,
            ...(challenge.debug_code ? { debug_code: challenge.debug_code } : {}),
            ...(challenge.delivery_error ? { delivery_error: challenge.delivery_error } : {}),
          },
        },
      ],
      session_patch: {},
      events: [makeEvent(ctx, 'auth_started', { delivery: challenge.delivery })],
    });
  }

  function buildAuthStartFailureEnvelope(ctx, err) {
    const failure = resolveStorageFailure(err, 'AUTH_START_FAILED', {
      authNotConfiguredMessage:
        ctx.lang === 'CN' ? '登录暂不可用（缺少配置）。' : 'Sign-in is not configured yet.',
      dbUnavailableMessage:
        ctx.lang === 'CN'
          ? '登录暂不可用（存储未就绪）。请稍后重试。'
          : 'Sign-in is not ready yet (storage unavailable). Please try again shortly.',
      genericMessage:
        ctx.lang === 'CN' ? '验证码发送失败，请稍后重试。' : "Couldn't send a sign-in code. Please try again.",
      explicitStatusByCode: {
        INVALID_EMAIL: 400,
      },
      explicitMessageByCode: {
        INVALID_EMAIL: 'Invalid request.',
      },
    });

    return {
      status: failure.status,
      body: buildErrorEnvelope(ctx, {
        assistantText: failure.assistantText,
        error: failure.error,
        payload: failure.payload,
        eventCode: failure.code,
      }),
    };
  }

  function buildAuthInvalidCodeEnvelope(ctx, verification) {
    return buildErrorEnvelope(ctx, {
      assistantText: ctx.lang === 'CN' ? '验证码无效或已过期。' : 'Invalid or expired code.',
      error: 'INVALID_CODE',
      reason: verification && verification.reason,
      eventCode: 'INVALID_CODE',
    });
  }

  function buildAuthSessionEnvelope(ctx, { session, userId, email, method = null } = {}) {
    return buildEnvelope(ctx, {
      assistant_message: makeAssistantMessage(ctx.lang === 'CN' ? '登录成功。' : 'Signed in.'),
      suggested_chips: [],
      cards: [
        {
          card_id: `auth_${ctx.request_id}`,
          type: 'auth_session',
          payload: {
            token: session.token,
            expires_at: session.expiresAt,
            user: { user_id: userId, email },
          },
        },
      ],
      session_patch: {},
      events: [
        makeEvent(ctx, 'auth_verified', {
          user_id: userId,
          ...(method ? { method } : {}),
        }),
      ],
    });
  }

  function buildAuthVerifyFailureEnvelope(ctx, err) {
    const failure = resolveStorageFailure(err, 'AUTH_VERIFY_FAILED', {
      authNotConfiguredMessage:
        ctx.lang === 'CN' ? '登录暂不可用（缺少配置）。' : 'Sign-in is not configured yet.',
      dbUnavailableMessage:
        ctx.lang === 'CN'
          ? '登录暂不可用（存储未就绪）。请稍后重试。'
          : 'Sign-in is not ready yet (storage unavailable). Please try again shortly.',
      genericMessage: ctx.lang === 'CN' ? '登录失败，请稍后重试。' : 'Sign-in failed. Please try again.',
    });

    return {
      status: failure.status,
      body: buildErrorEnvelope(ctx, {
        assistantText: failure.assistantText,
        error: failure.error,
        payload: failure.payload,
        eventCode: failure.code,
      }),
    };
  }

  function buildAuthPasswordLoginFailureEnvelope(ctx, verification) {
    const isLocked = verification && verification.reason === 'locked';
    const status = isLocked ? 429 : verification && verification.reason === 'no_password_set' ? 409 : 401;
    const assistantText =
      verification && verification.reason === 'no_password_set'
        ? ctx.lang === 'CN'
          ? '该邮箱尚未设置密码，请先用邮箱验证码登录后再设置密码。'
          : 'No password is set for this email yet. Use an email code to sign in first, then set a password.'
        : isLocked
          ? ctx.lang === 'CN'
            ? '尝试次数过多，请稍后再试。'
            : 'Too many attempts. Please try again later.'
          : ctx.lang === 'CN'
            ? '邮箱或密码错误。'
            : 'Invalid email or password.';

    return {
      status,
      body: buildErrorEnvelope(ctx, {
        assistantText,
        error: isLocked ? 'PASSWORD_LOCKED' : 'INVALID_CREDENTIALS',
        reason: verification && verification.reason,
        payload: verification && verification.locked_until ? { locked_until: verification.locked_until } : {},
        eventCode: isLocked ? 'PASSWORD_LOCKED' : 'INVALID_CREDENTIALS',
      }),
    };
  }

  function buildAuthPasswordLoginStorageFailureEnvelope(ctx, err) {
    const failure = resolveStorageFailure(err, 'AUTH_PASSWORD_LOGIN_FAILED', {
      authNotConfiguredMessage:
        ctx.lang === 'CN' ? '登录暂不可用（缺少配置）。' : 'Sign-in is not configured yet.',
      dbUnavailableMessage:
        ctx.lang === 'CN'
          ? '登录暂不可用（存储未就绪）。请稍后重试。'
          : 'Sign-in is not ready yet (storage unavailable). Please try again shortly.',
      genericMessage: ctx.lang === 'CN' ? '登录失败，请稍后重试。' : 'Sign-in failed. Please try again.',
    });

    return {
      status: failure.status,
      body: buildErrorEnvelope(ctx, {
        assistantText: failure.assistantText,
        error: failure.error,
        payload: failure.payload,
        eventCode: failure.code,
      }),
    };
  }

  function buildUnauthorizedEnvelope(ctx, assistantText) {
    return buildErrorEnvelope(ctx, {
      assistantText,
      error: 'UNAUTHORIZED',
      eventCode: 'UNAUTHORIZED',
    });
  }

  function buildAuthPasswordSetSuccessEnvelope(ctx, userId) {
    return buildEnvelope(ctx, {
      assistant_message: makeAssistantMessage(
        ctx.lang === 'CN'
          ? '密码已设置。下次你可以用邮箱 + 密码直接登录（仍可用邮箱验证码）。'
          : 'Password set. Next time you can sign in with email + password (OTP still works too).',
      ),
      suggested_chips: [],
      cards: [
        {
          card_id: `auth_password_set_${ctx.request_id}`,
          type: 'auth_password_set',
          payload: { ok: true },
        },
      ],
      session_patch: {},
      events: [makeEvent(ctx, 'auth_password_set', { user_id: userId })],
    });
  }

  function buildAuthPasswordSetFailureEnvelope(ctx, err) {
    const failure = resolveStorageFailure(err, 'AUTH_PASSWORD_SET_FAILED', {
      authNotConfiguredMessage:
        ctx.lang === 'CN' ? '登录暂不可用（缺少配置）。' : 'Sign-in is not configured yet.',
      dbUnavailableMessage:
        ctx.lang === 'CN'
          ? '暂时无法保存密码（存储未就绪）。请稍后重试。'
          : "Couldn't save password yet (storage unavailable). Please try again shortly.",
      genericMessage:
        ctx.lang === 'CN' ? '设置密码失败，请稍后重试。' : "Couldn't set password. Please try again.",
      explicitStatusByCode: {
        INVALID_PASSWORD: 400,
        UNAUTHORIZED: 401,
      },
      explicitMessageByCode: {
        INVALID_PASSWORD:
          ctx.lang === 'CN' ? '密码格式不正确（至少 8 位）。' : 'Invalid password (min 8 characters).',
        UNAUTHORIZED: ctx.lang === 'CN' ? '请先登录。' : 'Please sign in first.',
      },
    });

    return {
      status: failure.status,
      body: buildErrorEnvelope(ctx, {
        assistantText: failure.assistantText,
        error: failure.error,
        payload: failure.payload,
        eventCode: failure.code,
      }),
    };
  }

  function buildAuthMeEnvelope(ctx, identity) {
    return buildEnvelope(ctx, {
      assistant_message: null,
      suggested_chips: [],
      cards: [
        {
          card_id: `me_${ctx.request_id}`,
          type: 'auth_me',
          payload: {
            user: { user_id: identity.userId, email: identity.userEmail },
          },
        },
      ],
      session_patch: {},
      events: [makeEvent(ctx, 'value_moment', { kind: 'auth_me' })],
    });
  }

  function buildAuthMeFailureEnvelope(ctx, err) {
    return buildErrorEnvelope(ctx, {
      assistantText: 'Failed to load session.',
      error: err.code || 'AUTH_ME_FAILED',
      eventCode: err.code || 'AUTH_ME_FAILED',
    });
  }

  function buildAuthLogoutEnvelope(ctx) {
    return buildEnvelope(ctx, {
      assistant_message: makeAssistantMessage(ctx.lang === 'CN' ? '已退出登录。' : 'Signed out.'),
      suggested_chips: [],
      cards: [
        {
          card_id: `logout_${ctx.request_id}`,
          type: 'auth_logout',
          payload: { ok: true },
        },
      ],
      session_patch: {},
      events: [makeEvent(ctx, 'auth_logout', {})],
    });
  }

  function buildAuthLogoutFailureEnvelope(ctx, err) {
    return buildErrorEnvelope(ctx, {
      assistantText: 'Failed to sign out.',
      error: err.code || 'AUTH_LOGOUT_FAILED',
      eventCode: err.code || 'AUTH_LOGOUT_FAILED',
    });
  }

  return {
    buildBadRequestEnvelope: (ctx, details) => buildErrorEnvelope(ctx, {
      assistantText: 'Invalid request.',
      error: 'BAD_REQUEST',
      details,
      eventCode: 'BAD_REQUEST',
    }),
    buildSessionBootstrapSuccessEnvelope,
    buildSessionBootstrapFailureEnvelope,
    buildProfileUpdateBadRequestEnvelope,
    buildProfileSavedEnvelope,
    buildProfileDeletedEnvelope,
    buildProfileStorageFailureEnvelope,
    buildAuthStartSuccessEnvelope,
    buildAuthStartFailureEnvelope,
    buildAuthInvalidCodeEnvelope,
    buildAuthSessionEnvelope,
    buildAuthVerifyFailureEnvelope,
    buildAuthPasswordLoginFailureEnvelope,
    buildAuthPasswordLoginStorageFailureEnvelope,
    buildUnauthorizedEnvelope,
    buildAuthPasswordSetSuccessEnvelope,
    buildAuthPasswordSetFailureEnvelope,
    buildAuthMeEnvelope,
    buildAuthMeFailureEnvelope,
    buildAuthLogoutEnvelope,
    buildAuthLogoutFailureEnvelope,
  };
}

module.exports = {
  createIdentityRoutesRuntime,
};
