const { buildRequestContext } = require('../requestContext');
const {
  ActivityLogSchema,
  ActivityListQuerySchema,
} = require('../schemas');
const {
  appendActivityEventForIdentity,
  listActivityEventsForIdentity,
} = require('../memoryStore');

function ensureDependency(name, value) {
  if (typeof value === 'function') return value;
  throw new Error(`activity routes missing dependency: ${name}`);
}

function toActivityStorageError(err, classifyStorageError) {
  const { code, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
  if (dbError) {
    return {
      status: 503,
      body: {
        ok: false,
        error: dbNotConfigured ? 'DB_NOT_CONFIGURED' : dbSchemaError ? 'DB_SCHEMA_NOT_READY' : 'DB_UNAVAILABLE',
        ...(code ? { code } : {}),
      },
    };
  }

  const status =
    err && typeof err.status === 'number' && Number.isFinite(err.status) && err.status >= 400 && err.status < 600
      ? err.status
      : 500;
  return {
    status,
    body: {
      ok: false,
      error: status >= 400 && status < 500 ? String((err && err.code) || 'BAD_REQUEST') : 'ACTIVITY_FAILED',
    },
  };
}

function mountActivityRoutes(app, deps = {}) {
  const logger = deps && typeof deps.logger === 'object' ? deps.logger : null;
  const requireAuroraUid = ensureDependency('requireAuroraUid', deps.requireAuroraUid);
  const resolveIdentity = ensureDependency('resolveIdentity', deps.resolveIdentity);
  const classifyStorageError = ensureDependency('classifyStorageError', deps.classifyStorageError);
  const appendActivity = typeof deps.appendActivityEventForIdentity === 'function'
    ? deps.appendActivityEventForIdentity
    : appendActivityEventForIdentity;
  const listActivity = typeof deps.listActivityEventsForIdentity === 'function'
    ? deps.listActivityEventsForIdentity
    : listActivityEventsForIdentity;

  app.post('/v1/activity/log', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = ActivityLogSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'BAD_REQUEST', details: parsed.error.format() });
      }

      const identity = await resolveIdentity(req, ctx);
      const saved = await appendActivity(
        { auroraUid: identity.auroraUid, userId: identity.userId },
        parsed.data,
      );
      return res.status(200).json({ ok: true, activity_id: saved && saved.activity_id ? saved.activity_id : null });
    } catch (err) {
      const fail = toActivityStorageError(err, classifyStorageError);
      logger?.warn?.(
        {
          err: err && err.message ? err.message : String(err),
          code: err && err.code ? err.code : null,
          status: fail.status,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        },
        'activity log failed',
      );
      return res.status(fail.status).json(fail.body);
    }
  });

  app.get('/v1/activity', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = ActivityListQuerySchema.safeParse({
        limit: req.query ? req.query.limit : undefined,
        cursor: req.query ? req.query.cursor : undefined,
        types: req.query ? req.query.types : undefined,
      });
      if (!parsed.success) {
        return res.status(400).json({ error: 'BAD_REQUEST', details: parsed.error.format() });
      }

      const identity = await resolveIdentity(req, ctx);
      const result = await listActivity(
        { auroraUid: identity.auroraUid, userId: identity.userId },
        parsed.data,
      );

      return res.status(200).json({
        items: Array.isArray(result && result.items) ? result.items : [],
        next_cursor: result && result.next_cursor ? result.next_cursor : null,
      });
    } catch (err) {
      const fail = toActivityStorageError(err, classifyStorageError);
      logger?.warn?.(
        {
          err: err && err.message ? err.message : String(err),
          code: err && err.code ? err.code : null,
          status: fail.status,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        },
        'activity list failed',
      );
      return res.status(fail.status).json(fail.body);
    }
  });
}

module.exports = {
  mountActivityRoutes,
  __internal: {
    toActivityStorageError,
  },
};
