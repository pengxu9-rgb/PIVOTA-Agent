const { buildRequestContext } = require('../requestContext');
const {
  ActivityLogSchema,
  ActivityListQuerySchema,
} = require('../schemas');
const {
  appendActivityEventForIdentity,
  listActivityEventsForIdentity,
} = require('../memoryStore');
const {
  listDiagnosisArtifactsForIdentity,
} = require('../diagnosisArtifactStore');

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

function normalizeActivityPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return payload;
}

function mapActivityItem(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    activity_id: item.activity_id != null ? String(item.activity_id) : null,
    event_type: String(item.event_type || '').trim() || 'activity_event',
    payload: normalizeActivityPayload(item.payload),
    deeplink: typeof item.deeplink === 'string' && item.deeplink.trim() ? item.deeplink.trim() : null,
    source: String(item.source || '').trim() || 'unknown',
    occurred_at_ms: Number.isFinite(Number(item.occurred_at_ms))
      ? Math.max(0, Math.trunc(Number(item.occurred_at_ms)))
      : Date.now(),
    created_at: item.created_at ? String(item.created_at) : null,
  };
}

function compareActivityRowsDesc(a, b) {
  const aTs = Number(a && a.occurred_at_ms || 0);
  const bTs = Number(b && b.occurred_at_ms || 0);
  if (aTs !== bTs) return bTs - aTs;
  return String(b && b.activity_id || '').localeCompare(String(a && a.activity_id || ''));
}

function encodeActivityCursor({ occurred_at_ms, activity_id } = {}) {
  if (!Number.isFinite(Number(occurred_at_ms))) return null;
  try {
    return Buffer.from(
      JSON.stringify({
        occurred_at_ms: Math.max(0, Math.trunc(Number(occurred_at_ms))),
        activity_id: String(activity_id || ''),
      }),
    ).toString('base64');
  } catch {
    return null;
  }
}

function decodeActivityCursor(raw) {
  const token = String(raw || '').trim();
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    if (!parsed || !Number.isFinite(Number(parsed.occurred_at_ms))) {
      throw new Error('bad_cursor_payload');
    }
    return {
      occurred_at_ms: Math.max(0, Math.trunc(Number(parsed.occurred_at_ms))),
      activity_id: String(parsed.activity_id || parsed.id || ''),
    };
  } catch {
    const err = new Error('Invalid cursor');
    err.status = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }
}

function eventAfterCursor(event, cursor) {
  if (!cursor) return true;
  const ts = Number(event && event.occurred_at_ms || 0);
  if (ts < cursor.occurred_at_ms) return true;
  if (ts > cursor.occurred_at_ms) return false;
  return String(event && event.activity_id || '').localeCompare(String(cursor.activity_id || '')) < 0;
}

function normalizeSkinAnalysisBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase();
    if (token === 'true' || token === '1' || token === 'yes' || token === 'y' || token === 'on') return true;
    if (token === 'false' || token === '0' || token === 'no' || token === 'n' || token === 'off') return false;
  }
  return fallback;
}

function buildSyntheticSkinAnalysisActivityFromArtifact(artifactRow) {
  if (!artifactRow || typeof artifactRow !== 'object') return null;
  const artifactId = String(artifactRow.artifact_id || '').trim();
  if (!artifactId) return null;
  const artifact = artifactRow.artifact_json && typeof artifactRow.artifact_json === 'object'
    ? artifactRow.artifact_json
    : {};
  const analysisContext = artifact.analysis_context && typeof artifact.analysis_context === 'object'
    ? artifact.analysis_context
    : {};
  const photoInput = artifact.photo_input && typeof artifact.photo_input === 'object'
    ? artifact.photo_input
    : {};
  const photos = Array.isArray(artifact.photos) ? artifact.photos : [];
  const sessionNode = artifact.identity && typeof artifact.identity === 'object' ? artifact.identity : {};
  const sessionId = String(
    sessionNode.session_id || artifactRow.session_id || '',
  ).trim();

  const usedPhotos = normalizeSkinAnalysisBool(
    photoInput.used,
    normalizeSkinAnalysisBool(analysisContext.used_photos, photos.length > 0),
  );
  const photosProvided = normalizeSkinAnalysisBool(photoInput.provided, photos.length > 0);
  const analysisSource = String(
    analysisContext.analysis_source || photoInput.analysis_source || 'unknown',
  ).trim() || 'unknown';
  const qualityGrade = String(
    photoInput.quality_grade || analysisContext.quality_grade || 'unknown',
  ).trim() || 'unknown';
  const photoFailureCode = String(photoInput.photo_failure_code || '').trim() || null;
  const photosCount = Number.isFinite(Number(photoInput.photos_count))
    ? Math.max(0, Math.trunc(Number(photoInput.photos_count)))
    : photos.length;
  const occurredAtMs = Number.isFinite(Date.parse(String(artifactRow.created_at || artifact.created_at || '')))
    ? Date.parse(String(artifactRow.created_at || artifact.created_at))
    : Date.now();

  return {
    activity_id: `artifact:${artifactId}`,
    event_type: 'skin_analysis',
    payload: {
      artifact_id: artifactId,
      analysis_source: analysisSource,
      used_photos: usedPhotos,
      photos_provided: photosProvided,
      photo_failure_code: photoFailureCode,
      quality_grade: qualityGrade,
      photos_count: photosCount,
    },
    deeplink: sessionId ? `/chat?brief_id=${encodeURIComponent(sessionId)}` : null,
    source: 'diagnosis_artifact_backfill',
    occurred_at_ms: Math.max(0, Math.trunc(occurredAtMs)),
    created_at: artifactRow.created_at || artifact.created_at || null,
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
  const listArtifacts = typeof deps.listDiagnosisArtifactsForIdentity === 'function'
    ? deps.listDiagnosisArtifactsForIdentity
    : listDiagnosisArtifactsForIdentity;

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
      const requestedTypes = Array.isArray(parsed.data.types)
        ? parsed.data.types.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
        : [];
      const includeSkinAnalysis = requestedTypes.length === 0 || requestedTypes.includes('skin_analysis');
      const cursor = decodeActivityCursor(parsed.data.cursor);
      const pageLimit = Number(parsed.data.limit);
      const safeLimit = Number.isFinite(pageLimit) ? Math.max(1, Math.min(50, Math.trunc(pageLimit))) : 20;
      const fetchLimit = Math.max(300, safeLimit * 6);

      const explicit = await listActivity(
        { auroraUid: identity.auroraUid, userId: identity.userId },
        {
          limit: fetchLimit,
          types: requestedTypes.length ? requestedTypes : undefined,
        },
      );
      const explicitItems = Array.isArray(explicit && explicit.items)
        ? explicit.items.map(mapActivityItem).filter(Boolean)
        : [];

      const explicitArtifactIds = new Set(
        explicitItems
          .map((item) => {
            if (!item || item.event_type !== 'skin_analysis') return '';
            const payload = normalizeActivityPayload(item.payload);
            return String(payload.artifact_id || '').trim();
          })
          .filter(Boolean),
      );

      let syntheticItems = [];
      if (includeSkinAnalysis) {
        try {
          const artifacts = await listArtifacts({
            auroraUid: identity.auroraUid,
            userId: identity.userId,
            limit: fetchLimit,
            maxAgeDays: 365,
          });
          syntheticItems = (Array.isArray(artifacts) ? artifacts : [])
            .map(buildSyntheticSkinAnalysisActivityFromArtifact)
            .filter(Boolean)
            .filter((item) => {
              const payload = normalizeActivityPayload(item.payload);
              const artifactId = String(payload.artifact_id || '').trim();
              return artifactId && !explicitArtifactIds.has(artifactId);
            });
        } catch (artifactErr) {
          logger?.warn?.(
            {
              err: artifactErr && artifactErr.message ? artifactErr.message : String(artifactErr),
              code: artifactErr && artifactErr.code ? artifactErr.code : null,
              request_id: ctx.request_id,
              trace_id: ctx.trace_id,
            },
            'activity artifact backfill failed',
          );
        }
      }

      const merged = [...explicitItems, ...syntheticItems]
        .filter((item) => {
          if (!requestedTypes.length) return true;
          return requestedTypes.includes(String(item.event_type || '').trim().toLowerCase());
        })
        .sort(compareActivityRowsDesc)
        .filter((item) => eventAfterCursor(item, cursor));

      const page = merged.slice(0, safeLimit + 1);
      const hasMore = page.length > safeLimit;
      const items = hasMore ? page.slice(0, safeLimit) : page;
      const tail = items.length ? items[items.length - 1] : null;
      const nextCursor = hasMore && tail
        ? encodeActivityCursor({
            occurred_at_ms: tail.occurred_at_ms,
            activity_id: tail.activity_id,
          })
        : null;

      return res.status(200).json({
        items,
        next_cursor: nextCursor,
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
    buildSyntheticSkinAnalysisActivityFromArtifact,
    decodeActivityCursor,
    encodeActivityCursor,
    mapActivityItem,
  },
};
