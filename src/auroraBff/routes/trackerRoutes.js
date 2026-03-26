function ensureFunction(name, value) {
  if (typeof value === 'function') return value;
  throw new Error(`aurora tracker routes missing dependency: ${name}`);
}

function ensureSchema(name, value) {
  if (value && typeof value.safeParse === 'function') return value;
  throw new Error(`aurora tracker routes missing schema: ${name}`);
}

function toTrackerStorageFailure(err, classifyStorageError, fallbackCode) {
  const { code, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
  const status =
    err && typeof err.status === 'number' && Number.isFinite(err.status) && err.status >= 400 && err.status < 600
      ? err.status
      : dbError
        ? 503
        : 500;

  const errorCode =
    status >= 400 && status < 500
      ? err.code || 'BAD_REQUEST'
      : dbNotConfigured
        ? 'DB_NOT_CONFIGURED'
        : dbSchemaError
          ? 'DB_SCHEMA_NOT_READY'
          : dbError
            ? 'DB_UNAVAILABLE'
            : fallbackCode;

  return {
    status,
    code,
    errorCode,
    userMessage:
      status >= 400 && status < 500
        ? 'Invalid request.'
        : dbError
          ? 'Storage is not ready yet. Please try again shortly.'
          : fallbackCode === 'TRACKER_LOG_FAILED'
            ? 'Failed to save tracker log.'
            : 'Failed to load tracker logs.',
  };
}

function mountTrackerRoutes(app, deps = {}) {
  const buildRequestContext = ensureFunction('buildRequestContext', deps.buildRequestContext);
  const requireAuroraUid = ensureFunction('requireAuroraUid', deps.requireAuroraUid);
  const buildEnvelope = ensureFunction('buildEnvelope', deps.buildEnvelope);
  const makeAssistantMessage = ensureFunction('makeAssistantMessage', deps.makeAssistantMessage);
  const makeEvent = ensureFunction('makeEvent', deps.makeEvent);
  const resolveIdentity = ensureFunction('resolveIdentity', deps.resolveIdentity);
  const upsertSkinLogForIdentity = ensureFunction('upsertSkinLogForIdentity', deps.upsertSkinLogForIdentity);
  const getRecentSkinLogsForIdentity = ensureFunction(
    'getRecentSkinLogsForIdentity',
    deps.getRecentSkinLogsForIdentity,
  );
  const isCheckinDue = ensureFunction('isCheckinDue', deps.isCheckinDue);
  const classifyStorageError = ensureFunction('classifyStorageError', deps.classifyStorageError);
  const TrackerLogSchema = ensureSchema('TrackerLogSchema', deps.TrackerLogSchema);

  const logger = deps && typeof deps.logger === 'object' ? deps.logger : null;

  app.post('/v1/tracker/log', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = TrackerLogSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'BAD_REQUEST', details: parsed.error.format() },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const identity = await resolveIdentity(req, ctx);
      const saved = await upsertSkinLogForIdentity(
        { auroraUid: identity.auroraUid, userId: identity.userId },
        parsed.data,
      );
      const recent = await getRecentSkinLogsForIdentity(
        { auroraUid: identity.auroraUid, userId: identity.userId },
        7,
      );
      const recoRefreshHint = {
        should_refresh: true,
        reason: 'checkin_logged',
        effective_window_days: 7,
      };

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `tracker_${ctx.request_id}`,
            type: 'tracker_log',
            payload: { log: saved, recent_logs: recent, reco_refresh_hint: recoRefreshHint },
          },
        ],
        session_patch: { recent_logs: recent, checkin_due: isCheckinDue(recent) },
        events: [makeEvent(ctx, 'tracker_logged', { date: saved?.date || null, reco_refresh: recoRefreshHint.should_refresh })],
        reco_refresh_hint: recoRefreshHint,
      });
      return res.json(envelope);
    } catch (err) {
      const failure = toTrackerStorageFailure(err, classifyStorageError, 'TRACKER_LOG_FAILED');
      logger?.warn?.(
        { err: err?.message || String(err), code: failure.code, status: failure.status },
        'tracker log failed',
      );
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(failure.userMessage),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error: failure.errorCode,
              ...(failure.status >= 400 && failure.status < 500 ? {} : failure.code ? { code: failure.code } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: (failure.status >= 400 && failure.status < 500 ? err.code : failure.code) || 'TRACKER_LOG_FAILED' })],
      });
      return res.status(failure.status).json(envelope);
    }
  });

  app.get('/v1/tracker/recent', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const days = req.query.days ? Number(req.query.days) : 7;
      const identity = await resolveIdentity(req, ctx);
      const recent = await getRecentSkinLogsForIdentity(
        { auroraUid: identity.auroraUid, userId: identity.userId },
        days,
      );
      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [{ card_id: `recent_${ctx.request_id}`, type: 'tracker_recent', payload: { days, logs: recent } }],
        session_patch: { recent_logs: recent, checkin_due: isCheckinDue(recent) },
        events: [makeEvent(ctx, 'tracker_loaded', { days })],
      });
      return res.json(envelope);
    } catch (err) {
      const failure = toTrackerStorageFailure(err, classifyStorageError, 'TRACKER_LOAD_FAILED');
      logger?.warn?.(
        { err: err?.message || String(err), code: failure.code, status: failure.status },
        'tracker recent failed',
      );
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(failure.userMessage),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error: failure.errorCode,
              ...(failure.status >= 400 && failure.status < 500 ? {} : failure.code ? { code: failure.code } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: (failure.status >= 400 && failure.status < 500 ? err.code : failure.code) || 'TRACKER_LOAD_FAILED' })],
      });
      return res.status(failure.status).json(envelope);
    }
  });
}

module.exports = {
  mountTrackerRoutes,
};
