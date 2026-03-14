const { buildRequestContext } = require('../requestContext');
const {
  ActivityLogSchema,
  ActivityListQuerySchema,
} = require('../schemas');
const {
  appendActivityForIdentity,
  listActivityForIdentity,
  getActivityEventByIdForIdentity,
  getActivityDetail,
} = require('../activityStore');
const {
  listDiagnosisArtifactsForIdentity,
  getDiagnosisArtifactById,
  getIngredientPlanByArtifactId,
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeActivityPayload(payload) {
  if (!isPlainObject(payload)) return {};
  return payload;
}

function activityKindForEventType(eventType) {
  const token = String(eventType || '').trim().toLowerCase();
  if (token === 'skin_analysis') return 'skin_analysis';
  if (token === 'tracker_logged') return 'tracker_logged';
  if (token === 'profile_updated') return 'profile_updated';
  if (token === 'chat_started') return 'chat_started';
  if (token === 'travel_plan_created' || token === 'travel_plan_updated' || token === 'travel_plan_archived') {
    return 'travel_plan';
  }
  return null;
}

function mapActivityItem(item) {
  if (!item || typeof item !== 'object') return null;
  const activityKind = activityKindForEventType(item.event_type);
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
    activity_kind: activityKind,
    detail_available: Boolean(activityKind && item.activity_id),
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

function isSyntheticSkinAnalysisArtifactEligible(artifactRow) {
  if (!artifactRow || typeof artifactRow !== 'object') return false;
  const artifact = artifactRow.artifact_json && typeof artifactRow.artifact_json === 'object'
    ? artifactRow.artifact_json
    : {};
  const artifactType = String(artifact.artifact_type || artifact.type || '').trim().toLowerCase();
  if (artifactType === 'skin_analysis_kb_snapshot_v1') return false;

  return Boolean(
    isPlainObject(artifact.analysis_context) ||
    isPlainObject(artifact.overall_confidence) ||
    isPlainObject(artifact.skinType) ||
    isPlainObject(artifact.barrierStatus) ||
    isPlainObject(artifact.sensitivity) ||
    isPlainObject(artifact.goals) ||
    Array.isArray(artifact.concerns) ||
    Array.isArray(artifact.photos),
  );
}

function buildSyntheticSkinAnalysisActivityFromArtifact(artifactRow) {
  if (!artifactRow || typeof artifactRow !== 'object') return null;
  if (!isSyntheticSkinAnalysisArtifactEligible(artifactRow)) return null;
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
  const sessionId = String(sessionNode.session_id || artifactRow.session_id || '').trim();

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

function trimText(value, max = 160) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toFiniteNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function humanizeToken(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function pickLang(lang, cn, en) {
  return String(lang || '').toUpperCase() === 'CN' ? cn : en;
}

function withQuery(path, query = {}) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const text = String(value || '').trim();
    if (!text) continue;
    sp.set(key, text);
  }
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

function buildAction(action_id, deeplink, label, variant = 'secondary') {
  return {
    action_id,
    deeplink,
    label,
    variant,
  };
}

function normalizeStringArray(value, max = 8) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => trimText(item, 120))
    .filter(Boolean)
    .slice(0, max);
}

function normalizeConcernArray(value, max = 8) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return trimText(item, 120);
      if (!isPlainObject(item)) return null;
      const evidence = trimText(item.evidence_text || item.evidenceText || item.summary || item.description, 120);
      const type = humanizeToken(item.type || item.concern_type || item.id || item.name || item.label);
      return evidence || type;
    })
    .filter(Boolean)
    .slice(0, max);
}

function buildIngredientPlanSummary(planRow) {
  const plan = planRow && isPlainObject(planRow.plan_json) ? planRow.plan_json : {};
  const targets = Array.isArray(plan.targets) ? plan.targets : [];
  const avoid = Array.isArray(plan.avoid) ? plan.avoid : [];
  const conflicts = Array.isArray(plan.conflicts) ? plan.conflicts : [];
  return {
    plan_id: String(planRow && planRow.plan_id || '').trim() || null,
    intensity:
      isPlainObject(plan.intensity) && typeof plan.intensity.level === 'string'
        ? plan.intensity.level
        : trimText(plan.intensity, 40),
    targets: targets
      .map((item) => {
        if (!isPlainObject(item)) return null;
        return {
          ingredient_name: trimText(item.ingredient_name || item.ingredient || item.name, 80),
          why: trimText(item.why || item.reason, 120),
        };
      })
      .filter(Boolean)
      .slice(0, 6),
    avoid: avoid
      .map((item) => {
        if (!isPlainObject(item)) return null;
        return {
          ingredient_name: trimText(item.ingredient_name || item.ingredient || item.name, 80),
          why: trimText(item.why || item.reason, 120),
        };
      })
      .filter(Boolean)
      .slice(0, 6),
    conflicts: conflicts
      .map((item) => (isPlainObject(item) ? trimText(item.summary || item.title || item.conflict, 120) : trimText(item, 120)))
      .filter(Boolean)
      .slice(0, 6),
  };
}

function buildSkinAnalysisSnapshot({ item, artifactRow, ingredientPlanRow, storedSnapshot }) {
  const payload = normalizeActivityPayload(item && item.payload);
  const artifact = artifactRow && isPlainObject(artifactRow.artifact_json) ? artifactRow.artifact_json : {};
  const analysisContext = isPlainObject(artifact.analysis_context) ? artifact.analysis_context : {};
  const photoInput = isPlainObject(artifact.photo_input) ? artifact.photo_input : {};
  const confidence = isPlainObject(artifact.overall_confidence) ? artifact.overall_confidence : {};
  const goalsNode = isPlainObject(artifact.goals) ? artifact.goals : {};
  const base = isPlainObject(storedSnapshot) ? storedSnapshot : {};
  const photos = Array.isArray(artifact.photos) ? artifact.photos : [];
  const sourceMix = Array.isArray(artifact.source_mix)
    ? artifact.source_mix
    : Array.isArray(artifactRow && artifactRow.source_mix) ? artifactRow.source_mix : [];

  return {
    artifact_id: trimText(base.artifact_id || payload.artifact_id || artifactRow && artifactRow.artifact_id, 80),
    analysis_source: trimText(base.analysis_source || payload.analysis_source || analysisContext.analysis_source || photoInput.analysis_source, 80) || 'unknown',
    used_photos: normalizeSkinAnalysisBool(base.used_photos, normalizeSkinAnalysisBool(payload.used_photos, normalizeSkinAnalysisBool(photoInput.used, normalizeSkinAnalysisBool(analysisContext.used_photos, photos.length > 0)))),
    photos_provided: normalizeSkinAnalysisBool(base.photos_provided, normalizeSkinAnalysisBool(payload.photos_provided, normalizeSkinAnalysisBool(photoInput.provided, photos.length > 0))),
    photo_failure_code: trimText(base.photo_failure_code || payload.photo_failure_code || photoInput.photo_failure_code, 80),
    quality_grade: trimText(base.quality_grade || payload.quality_grade || photoInput.quality_grade || analysisContext.quality_grade, 40) || 'unknown',
    photos_count: toFiniteNumber(base.photos_count) ?? toFiniteNumber(payload.photos_count) ?? toFiniteNumber(photoInput.photos_count) ?? photos.length,
    confidence_score: toFiniteNumber(base.confidence_score) ?? toFiniteNumber(confidence.score),
    confidence_level: trimText(base.confidence_level || confidence.level, 24),
    source_mix: normalizeStringArray(base.source_mix || sourceMix, 8),
    skin_type: trimText(base.skin_type || artifact.skinType && artifact.skinType.value, 40),
    barrier_status: trimText(base.barrier_status || artifact.barrierStatus && artifact.barrierStatus.value, 40),
    sensitivity: trimText(base.sensitivity || artifact.sensitivity && artifact.sensitivity.value, 40),
    goals: normalizeStringArray(base.goals || goalsNode.values || [], 8),
    concerns: normalizeConcernArray(base.concerns || artifact.concerns || [], 8),
    ingredient_plan: base.ingredient_plan || buildIngredientPlanSummary(ingredientPlanRow),
    created_at: trimText(base.created_at || artifactRow && artifactRow.created_at || item && item.created_at, 64),
  };
}

function buildSkinAnalysisActions(lang, item, snapshot) {
  const prompt = pickLang(
    lang,
    '基于我保存的 skin analysis 继续，不要让我重复目标，直接告诉我下一步该怎么做。',
    'Continue from my saved skin analysis. Do not ask me to restate my goals. Tell me the next best steps.',
  );
  const continueChat = withQuery('/chat', {
    chip_id: 'chip.aurora.next_action.solution_next_steps',
    q: prompt,
    activity_id: item.activity_id,
    artifact_id: snapshot && snapshot.artifact_id,
  });
  return [
    buildAction('continue_chat', continueChat, pickLang(lang, '继续追问', 'Continue chat'), 'primary'),
    buildAction(
      'rerun_analysis',
      withQuery('/chat', { open: 'photo', activity_id: item.activity_id }),
      pickLang(lang, '重新拍照分析', 'Run photo analysis'),
    ),
  ];
}

function buildTrackerSnapshot(item, storedSnapshot) {
  const payload = normalizeActivityPayload(item && item.payload);
  const base = isPlainObject(storedSnapshot) ? storedSnapshot : {};
  return {
    date: trimText(base.date || payload.date, 24),
    redness: toFiniteNumber(base.redness) ?? toFiniteNumber(payload.redness),
    acne: toFiniteNumber(base.acne) ?? toFiniteNumber(payload.acne),
    hydration: toFiniteNumber(base.hydration) ?? toFiniteNumber(payload.hydration),
    notes_excerpt: trimText(base.notes_excerpt || payload.notes_excerpt, 220),
    routine_id: trimText(base.routine_id || payload.routine_id, 120),
    target_product: trimText(base.target_product || payload.target_product, 120),
    sensation: trimText(base.sensation || payload.sensation, 120),
    has_notes: Boolean(base.notes_excerpt || payload.has_notes),
  };
}

function buildProfileSnapshot(item, storedSnapshot) {
  const payload = normalizeActivityPayload(item && item.payload);
  const base = isPlainObject(storedSnapshot) ? storedSnapshot : {};
  const changedFields = normalizeStringArray(base.changed_fields || payload.changed_fields || payload.fields || [], 20);
  const values = isPlainObject(base.values) ? base.values : isPlainObject(payload.values) ? payload.values : {};
  return {
    changed_fields: changedFields,
    values,
  };
}

function buildTravelPlanSnapshot(item, storedSnapshot) {
  const payload = normalizeActivityPayload(item && item.payload);
  const base = isPlainObject(storedSnapshot) ? storedSnapshot : {};
  return {
    trip_id: trimText(base.trip_id || payload.trip_id, 120),
    destination: trimText(base.destination || payload.destination, 120),
    start_date: trimText(base.start_date || payload.start_date, 24),
    end_date: trimText(base.end_date || payload.end_date, 24),
    is_archived: Boolean(base.is_archived != null ? base.is_archived : payload.is_archived),
    itinerary: trimText(base.itinerary || payload.itinerary, 220),
    indoor_outdoor_ratio: toFiniteNumber(base.indoor_outdoor_ratio) ?? toFiniteNumber(payload.indoor_outdoor_ratio),
  };
}

function buildChatStartedSnapshot(item, storedSnapshot) {
  const payload = normalizeActivityPayload(item && item.payload);
  const base = isPlainObject(storedSnapshot) ? storedSnapshot : {};
  return {
    title: trimText(base.title || payload.title, 80),
    chip_id: trimText(base.chip_id || payload.chip_id, 120),
    open: trimText(base.open || payload.open, 40),
    has_query: Boolean(base.has_query != null ? base.has_query : payload.has_query),
    deeplink: item && item.deeplink ? String(item.deeplink) : null,
  };
}

function buildDetailActions({ kind, lang, item, snapshot }) {
  if (kind === 'skin_analysis') return buildSkinAnalysisActions(lang, item, snapshot);
  if (kind === 'tracker_logged') {
    return [
      buildAction(
        'open_tracker',
        withQuery('/chat', { open: 'checkin', activity_id: item.activity_id }),
        pickLang(lang, '去记录打卡', 'Open check-in'),
        'primary',
      ),
    ];
  }
  if (kind === 'profile_updated') {
    return [
      buildAction('open_profile', withQuery('/profile', { activity_id: item.activity_id }), pickLang(lang, '查看画像', 'Open profile'), 'primary'),
    ];
  }
  if (kind === 'travel_plan') {
    const target = snapshot && snapshot.trip_id ? `/plans/${encodeURIComponent(String(snapshot.trip_id))}` : '/plans';
    return [
      buildAction('open_plans', target, pickLang(lang, '查看计划', 'Open plan'), 'primary'),
    ];
  }
  if (kind === 'chat_started') {
    return [
      buildAction(
        'resume_entry',
        item && item.deeplink ? item.deeplink : '/chat',
        pickLang(lang, '重新开始', 'Open chat'),
        'primary',
      ),
    ];
  }
  return [];
}

async function buildActivityDetail({
  item,
  identity,
  detailRow,
  lang,
  getArtifactById,
  getPlanByArtifactId,
}) {
  const kind = activityKindForEventType(item && item.event_type);
  if (!kind) return null;

  if (kind === 'skin_analysis') {
    const payload = normalizeActivityPayload(item && item.payload);
    const artifactId =
      trimText(payload.artifact_id, 80) ||
      (String(item && item.activity_id || '').startsWith('artifact:')
        ? String(item.activity_id).slice('artifact:'.length)
        : null);
    const artifactRow = artifactId
      ? await getArtifactById({ artifactId, auroraUid: identity.auroraUid, userId: identity.userId })
      : null;
    const ingredientPlanRow = artifactId ? await getPlanByArtifactId({ artifactId }) : null;
    const snapshot = buildSkinAnalysisSnapshot({
      item,
      artifactRow,
      ingredientPlanRow,
      storedSnapshot: detailRow && detailRow.detail_json,
    });
    return {
      kind,
      snapshot,
      actions: buildDetailActions({ kind, lang, item, snapshot }),
    };
  }

  if (kind === 'tracker_logged') {
    const snapshot = buildTrackerSnapshot(item, detailRow && detailRow.detail_json);
    return {
      kind,
      snapshot,
      actions: buildDetailActions({ kind, lang, item, snapshot }),
    };
  }

  if (kind === 'profile_updated') {
    const snapshot = buildProfileSnapshot(item, detailRow && detailRow.detail_json);
    return {
      kind,
      snapshot,
      actions: buildDetailActions({ kind, lang, item, snapshot }),
    };
  }

  if (kind === 'travel_plan') {
    const snapshot = buildTravelPlanSnapshot(item, detailRow && detailRow.detail_json);
    return {
      kind,
      snapshot,
      actions: buildDetailActions({ kind, lang, item, snapshot }),
    };
  }

  const snapshot = buildChatStartedSnapshot(item, detailRow && detailRow.detail_json);
  return {
    kind,
    snapshot,
    actions: buildDetailActions({ kind, lang, item, snapshot }),
  };
}

function mountActivityRoutes(app, deps = {}) {
  const logger = deps && typeof deps.logger === 'object' ? deps.logger : null;
  const requireAuroraUid = ensureDependency('requireAuroraUid', deps.requireAuroraUid);
  const resolveIdentity = ensureDependency('resolveIdentity', deps.resolveIdentity);
  const classifyStorageError = ensureDependency('classifyStorageError', deps.classifyStorageError);
  const appendActivity = typeof deps.appendActivityForIdentity === 'function'
    ? deps.appendActivityForIdentity
    : appendActivityForIdentity;
  const listActivity = typeof deps.listActivityForIdentity === 'function'
    ? deps.listActivityForIdentity
    : listActivityForIdentity;
  const getActivityById = typeof deps.getActivityEventByIdForIdentity === 'function'
    ? deps.getActivityEventByIdForIdentity
    : getActivityEventByIdForIdentity;
  const getStoredDetail = typeof deps.getActivityDetail === 'function'
    ? deps.getActivityDetail
    : getActivityDetail;
  const listArtifacts = typeof deps.listDiagnosisArtifactsForIdentity === 'function'
    ? deps.listDiagnosisArtifactsForIdentity
    : listDiagnosisArtifactsForIdentity;
  const getArtifactById = typeof deps.getDiagnosisArtifactById === 'function'
    ? deps.getDiagnosisArtifactById
    : getDiagnosisArtifactById;
  const getPlanByArtifactId = typeof deps.getIngredientPlanByArtifactId === 'function'
    ? deps.getIngredientPlanByArtifactId
    : getIngredientPlanByArtifactId;

  app.post('/v1/activity/log', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = ActivityLogSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'BAD_REQUEST', details: parsed.error.format() });
      }

      const identity = await resolveIdentity(req, ctx);
      const saved = await appendActivity({
        auroraUid: identity.auroraUid,
        userId: identity.userId,
        eventType: parsed.data.event_type,
        payload: parsed.data.payload,
        deeplink: parsed.data.deeplink,
        source: parsed.data.source,
        occurredAtMs: parsed.data.occurred_at_ms,
      });
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

      const explicit = await listActivity({
        auroraUid: identity.auroraUid,
        userId: identity.userId,
        limit: fetchLimit,
        eventTypes: requestedTypes.length ? requestedTypes : undefined,
      });
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
            .map(mapActivityItem)
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

  app.get('/v1/activity/:activity_id', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const activityId = String(req && req.params && req.params.activity_id || '').trim();
      if (!activityId) return res.status(400).json({ error: 'BAD_REQUEST' });

      const identity = await resolveIdentity(req, ctx);
      let item = null;
      let detailRow = null;

      if (activityId.startsWith('artifact:')) {
        const artifactId = activityId.slice('artifact:'.length).trim();
        const artifact = artifactId
          ? await getArtifactById({ artifactId, auroraUid: identity.auroraUid, userId: identity.userId })
          : null;
        if (!artifact) return res.status(404).json({ error: 'ACTIVITY_NOT_FOUND' });
        item = mapActivityItem(buildSyntheticSkinAnalysisActivityFromArtifact(artifact));
      } else {
        const event = await getActivityById({
          auroraUid: identity.auroraUid,
          userId: identity.userId,
          activityId,
        });
        if (!event) return res.status(404).json({ error: 'ACTIVITY_NOT_FOUND' });
        item = mapActivityItem(event);
        detailRow = await getStoredDetail(activityId);
      }

      const detail = await buildActivityDetail({
        item,
        identity,
        detailRow,
        lang: ctx.lang,
        getArtifactById,
        getPlanByArtifactId,
      });
      if (!detail) return res.status(404).json({ error: 'ACTIVITY_NOT_FOUND' });

      return res.status(200).json({
        item,
        detail,
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
        'activity detail failed',
      );
      return res.status(fail.status).json(fail.body);
    }
  });
}

module.exports = {
  mountActivityRoutes,
  __internal: {
    toActivityStorageError,
    isSyntheticSkinAnalysisArtifactEligible,
    buildSyntheticSkinAnalysisActivityFromArtifact,
    decodeActivityCursor,
    encodeActivityCursor,
    mapActivityItem,
    activityKindForEventType,
    buildSkinAnalysisSnapshot,
    buildSkinAnalysisActions,
    buildTrackerSnapshot,
    buildProfileSnapshot,
    buildTravelPlanSnapshot,
    buildChatStartedSnapshot,
  },
};
