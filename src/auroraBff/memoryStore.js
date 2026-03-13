const { query } = require('../db');
const { normalizeTravelProfilePatch } = require('./travelPlans');
const { normalizeCurrentRoutineToV2 } = require('./routineSchemaV2');

function parseRetentionDays() {
  const raw =
    process.env.AURORA_BFF_RETENTION_DAYS ??
    process.env.AURORA_RETENTION_DAYS ??
    process.env.RETENTION_DAYS;
  if (raw === undefined || raw === null || raw === '') return 30;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 30;
  return Math.max(0, Math.min(365, Math.trunc(n)));
}

function persistenceDisabled() {
  return parseRetentionDays() === 0;
}

const EPHEMERAL_MAX_IDENTITIES = (() => {
  const n = Number(process.env.AURORA_BFF_EPHEMERAL_MAX_IDENTITIES || 200);
  const v = Number.isFinite(n) ? Math.trunc(n) : 200;
  return Math.max(10, Math.min(2000, v));
})();

const ephemeral = {
  profiles: new Map(),
  logs: new Map(),
  activities: new Map(),
  experiments: new Map(),
  identityLinks: new Map(),
  shadowVerifyRuns: new Map(),
};

function touchEphemeral(map, key, value) {
  if (!key) return;
  map.delete(key);
  map.set(key, value);
  while (map.size > EPHEMERAL_MAX_IDENTITIES) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) break;
    map.delete(oldestKey);
  }
}

function profileKeyFor({ kind, id }) {
  const k = String(kind || '').trim() || 'unknown';
  const uid = String(id || '').trim();
  if (!uid) return null;
  return `${k}:${uid}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function experimentKeyFor({ kind, id }) {
  const base = profileKeyFor({ kind, id });
  if (!base) return null;
  return `${base}:experiments`;
}

function normalizeAuroraUid(auroraUid) {
  const uid = String(auroraUid || '').trim();
  if (!uid) return null;
  if (uid.length > 128) return uid.slice(0, 128);
  return uid;
}

function normalizeUserId(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return null;
  if (uid.length > 128) return uid.slice(0, 128);
  return uid;
}

function isoDateUTC(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function isoTs(d = new Date()) {
  return d.toISOString();
}

function coerceIsoDate(value) {
  if (!value) return isoDateUTC();
  const raw = String(value).trim();
  if (!raw) return isoDateUTC();
  // Very small validation to avoid SQL errors.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return isoDateUTC();
  return raw;
}

function resolveNextStateFromSessionPatch(patch) {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
  if (!p) return null;

  const state = p.state && typeof p.state === 'object' && !Array.isArray(p.state) ? p.state : null;
  const internalNext = state && typeof state._internal_next_state === 'string'
    ? state._internal_next_state.trim()
    : '';
  if (internalNext) return internalNext;

  const next = typeof p.next_state === 'string' ? p.next_state.trim() : '';
  return next || null;
}

function applySessionPatchNextState(persistedState, patch) {
  const base = persistedState && typeof persistedState === 'object' && !Array.isArray(persistedState)
    ? persistedState
    : {};
  const next = resolveNextStateFromSessionPatch(patch);
  if (!next) return { ...base };
  return { ...base, next_state: next };
}

async function ensureUserProfileRow(auroraUid) {
  const uid = normalizeAuroraUid(auroraUid);
  if (!uid) return null;
  if (persistenceDisabled()) return uid;
  await query(
    `
      INSERT INTO aurora_user_profiles (aurora_uid)
      VALUES ($1)
      ON CONFLICT (aurora_uid) DO NOTHING
    `,
    [uid],
  );
  return uid;
}

async function ensureAccountProfileRow(userId) {
  const uid = normalizeUserId(userId);
  if (!uid) return null;
  if (persistenceDisabled()) return uid;
  await query(
    `
      INSERT INTO aurora_account_profiles (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [uid],
  );
  return uid;
}

function mapProfileToDb(profilePatch) {
  const p = profilePatch || {};
  const goals = Array.isArray(p.goals) ? p.goals : undefined;
  const contraindications = Array.isArray(p.contraindications) ? p.contraindications : undefined;
  const highRiskMedications = Array.isArray(p.high_risk_medications)
    ? p.high_risk_medications
    : Array.isArray(p.highRiskMedications)
      ? p.highRiskMedications
      : undefined;
  const pregnancyDueDate = Object.prototype.hasOwnProperty.call(p, 'pregnancy_due_date')
    ? p.pregnancy_due_date
    : Object.prototype.hasOwnProperty.call(p, 'pregnancyDueDate')
      ? p.pregnancyDueDate
      : undefined;
  const currentRoutine = normalizeCurrentRoutineToV2(p.currentRoutine);
  const itinerary = p.itinerary;
  const travelPlan = p.travel_plan;
  const travelPlans = p.travel_plans;
  const chatContext = p.chatContext;

  return {
    skin_type: p.skinType,
    sensitivity: p.sensitivity,
    barrier_status: p.barrierStatus,
    goals: goals ? JSON.stringify(goals) : undefined,
    region: p.region,
    budget_tier: p.budgetTier,
    current_routine: currentRoutine !== undefined ? JSON.stringify(currentRoutine) : undefined,
    itinerary: itinerary !== undefined ? JSON.stringify(itinerary) : undefined,
    travel_plan: travelPlan !== undefined ? JSON.stringify(travelPlan) : undefined,
    travel_plans: travelPlans !== undefined ? JSON.stringify(travelPlans) : undefined,
    contraindications: contraindications ? JSON.stringify(contraindications) : undefined,
    age_band: p.age_band != null ? p.age_band : p.ageBand,
    pregnancy_status: p.pregnancy_status != null ? p.pregnancy_status : p.pregnancyStatus,
    pregnancy_due_date: pregnancyDueDate,
    lactation_status: p.lactation_status != null ? p.lactation_status : p.lactationStatus,
    high_risk_medications:
      highRiskMedications !== undefined ? JSON.stringify(highRiskMedications) : undefined,
    chat_context: chatContext !== undefined ? chatContext : undefined,
    lang_pref: p.lang_pref,
  };
}

function normalizeJsonbParam(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  // node-postgres serializes JS arrays as Postgres arrays, which breaks JSONB inserts.
  // Normalize all JSONB-bound params to JSON text.
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return JSON.stringify(value);
    const first = trimmed[0];
    if (first === '{' || first === '[' || first === '"') return value;
    return JSON.stringify(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function sanitizeActivityPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  try {
    return JSON.parse(JSON.stringify(payload));
  } catch {
    return {};
  }
}

function buildActivityId() {
  return `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeActivityEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const eventType = String(event.event_type || '').trim().slice(0, 80);
  if (!eventType) return null;
  const occurredRaw = Number(event.occurred_at_ms);
  const occurredAtMs = Number.isFinite(occurredRaw) ? Math.max(0, Math.trunc(occurredRaw)) : Date.now();
  const deeplinkRaw = typeof event.deeplink === 'string' ? event.deeplink.trim() : '';
  const sourceRaw = typeof event.source === 'string' ? event.source.trim() : '';
  const activityIdRaw = typeof event.activity_id === 'string' ? event.activity_id.trim() : '';
  return {
    activity_id: activityIdRaw || buildActivityId(),
    event_type: eventType,
    payload: sanitizeActivityPayload(event.payload),
    deeplink: deeplinkRaw ? deeplinkRaw.slice(0, 500) : null,
    source: sourceRaw ? sourceRaw.slice(0, 120) : null,
    occurred_at_ms: occurredAtMs,
  };
}

function mapActivityRowFromDb(row) {
  if (!row) return null;
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {};
  const occurredRaw = Number(row.occurred_at_ms);
  return {
    activity_id: String(row.activity_id || '').trim() || buildActivityId(),
    aurora_uid: typeof row.aurora_uid === 'string' ? row.aurora_uid : null,
    user_id: typeof row.user_id === 'string' ? row.user_id : null,
    event_type: String(row.event_type || '').trim() || 'unknown',
    payload,
    deeplink: typeof row.deeplink === 'string' ? row.deeplink : null,
    source: typeof row.source === 'string' ? row.source : null,
    occurred_at_ms: Number.isFinite(occurredRaw) ? Math.max(0, Math.trunc(occurredRaw)) : Date.now(),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : isoTs(),
    id: Number.isFinite(Number(row.id)) ? Number(row.id) : null,
  };
}

function encodeActivityCursor(row) {
  if (!row) return null;
  const payload = {
    occurred_at_ms: Number(row.occurred_at_ms),
    id: row.id != null ? Number(row.id) : Number.MAX_SAFE_INTEGER,
  };
  if (!Number.isFinite(payload.occurred_at_ms) || !Number.isFinite(payload.id)) return null;
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function decodeActivityCursor(cursor) {
  const token = String(cursor || '').trim();
  if (!token) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    const err = new Error('Invalid cursor');
    err.status = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }
  const occurredAtMs = Number(parsed && parsed.occurred_at_ms);
  const id = Number(parsed && parsed.id);
  if (!Number.isFinite(occurredAtMs) || !Number.isFinite(id)) {
    const err = new Error('Invalid cursor');
    err.status = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }
  return {
    occurred_at_ms: Math.max(0, Math.trunc(occurredAtMs)),
    id: Math.max(0, Math.trunc(id)),
  };
}

function compareActivityRowsDesc(a, b) {
  const aTs = Number(a && a.occurred_at_ms);
  const bTs = Number(b && b.occurred_at_ms);
  if (aTs !== bTs) return bTs - aTs;
  const aId = Number(a && a.id);
  const bId = Number(b && b.id);
  if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) return bId - aId;
  return String(b && b.activity_id ? b.activity_id : '').localeCompare(String(a && a.activity_id ? a.activity_id : ''));
}

function normalizeChatContext(value) {
  if (!isPlainObject(value)) return null;
  return value;
}

function normalizeExperimentEvent(event) {
  if (!isPlainObject(event)) return null;
  const eventTypeRaw =
    event.event_type ||
    event.eventType ||
    event.type ||
    event.name ||
    event.event_name ||
    '';
  const eventType = String(eventTypeRaw || '').trim().slice(0, 120) || 'experiment_event';
  const timestampMsRaw = Number(
    event.timestamp_ms != null ? event.timestamp_ms : event.timestampMs != null ? event.timestampMs : Date.now(),
  );
  const timestampMs = Number.isFinite(timestampMsRaw) ? Math.max(0, Math.trunc(timestampMsRaw)) : Date.now();
  const requestId =
    typeof event.request_id === 'string' && event.request_id.trim()
      ? event.request_id.trim().slice(0, 128)
      : null;
  const traceId =
    typeof event.trace_id === 'string' && event.trace_id.trim()
      ? event.trace_id.trim().slice(0, 128)
      : null;
  const payloadSource = isPlainObject(event.payload)
    ? event.payload
    : isPlainObject(event.event_data)
      ? event.event_data
      : {};
  const payload = {
    ...payloadSource,
    ...(requestId ? { request_id: requestId } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
    timestamp_ms: timestampMs,
  };
  return {
    event_type: eventType,
    event_data: payload,
    timestamp_ms: timestampMs,
    request_id: requestId,
    trace_id: traceId,
  };
}

function mapExperimentRowFromDb(row) {
  if (!row) return null;
  const eventData = isPlainObject(row.event_data) ? row.event_data : {};
  const eventType =
    typeof row.event_type === 'string' && row.event_type.trim() ? row.event_type.trim() : 'experiment_event';
  const ts = row.event_ts ? new Date(row.event_ts).getTime() : Number(eventData.timestamp_ms) || Date.now();
  return {
    id: row.id,
    event_type: eventType,
    event_data: eventData,
    timestamp_ms: Number.isFinite(Number(ts)) ? Math.max(0, Math.trunc(Number(ts))) : Date.now(),
    request_id:
      typeof row.request_id === 'string' && row.request_id.trim()
        ? row.request_id.trim()
        : typeof eventData.request_id === 'string'
          ? eventData.request_id
          : null,
    trace_id:
      typeof row.trace_id === 'string' && row.trace_id.trim()
        ? row.trace_id.trim()
        : typeof eventData.trace_id === 'string'
          ? eventData.trace_id
          : null,
  };
}

function normalizeDateOnlyField(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString().slice(0, 10);
}

function mapProfileFromDb(row) {
  if (!row) return null;
  const pregnancyDueDate = normalizeDateOnlyField(row.pregnancy_due_date);
  return {
    aurora_uid: row.aurora_uid,
    skinType: row.skin_type || null,
    sensitivity: row.sensitivity || null,
    barrierStatus: row.barrier_status || null,
    goals: Array.isArray(row.goals) ? row.goals : row.goals ? row.goals : [],
    region: row.region || null,
    budgetTier: row.budget_tier || null,
    currentRoutine: normalizeCurrentRoutineToV2(row.current_routine),
    active_routine_id: row.active_routine_id || null,
    itinerary: row.itinerary || null,
    travel_plan:
      row.travel_plan && typeof row.travel_plan === 'object' && !Array.isArray(row.travel_plan)
        ? row.travel_plan
        : null,
    travel_plans: Array.isArray(row.travel_plans) ? row.travel_plans : [],
    contraindications: Array.isArray(row.contraindications)
      ? row.contraindications
      : row.contraindications
        ? row.contraindications
        : [],
    age_band: row.age_band || null,
    pregnancy_status: row.pregnancy_status || null,
    pregnancy_due_date: pregnancyDueDate,
    lactation_status: row.lactation_status || null,
    high_risk_medications: Array.isArray(row.high_risk_medications)
      ? row.high_risk_medications
      : row.high_risk_medications
        ? row.high_risk_medications
        : [],
    chatContext: normalizeChatContext(row.chat_context),
    lastAnalysis: row.last_analysis || null,
    lastAnalysisAt: row.last_analysis_at ? new Date(row.last_analysis_at).toISOString() : null,
    lastAnalysisLang: row.last_analysis_lang || null,
    lang_pref: row.lang_pref || null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function mapAccountProfileFromDb(row) {
  if (!row) return null;
  const pregnancyDueDate = normalizeDateOnlyField(row.pregnancy_due_date);
  return {
    user_id: row.user_id,
    skinType: row.skin_type || null,
    sensitivity: row.sensitivity || null,
    barrierStatus: row.barrier_status || null,
    goals: Array.isArray(row.goals) ? row.goals : row.goals ? row.goals : [],
    region: row.region || null,
    budgetTier: row.budget_tier || null,
    currentRoutine: normalizeCurrentRoutineToV2(row.current_routine),
    active_routine_id: row.active_routine_id || null,
    itinerary: row.itinerary || null,
    travel_plan:
      row.travel_plan && typeof row.travel_plan === 'object' && !Array.isArray(row.travel_plan)
        ? row.travel_plan
        : null,
    travel_plans: Array.isArray(row.travel_plans) ? row.travel_plans : [],
    contraindications: Array.isArray(row.contraindications)
      ? row.contraindications
      : row.contraindications
        ? row.contraindications
        : [],
    age_band: row.age_band || null,
    pregnancy_status: row.pregnancy_status || null,
    pregnancy_due_date: pregnancyDueDate,
    lactation_status: row.lactation_status || null,
    high_risk_medications: Array.isArray(row.high_risk_medications)
      ? row.high_risk_medications
      : row.high_risk_medications
        ? row.high_risk_medications
        : [],
    chatContext: normalizeChatContext(row.chat_context),
    lastAnalysis: row.last_analysis || null,
    lastAnalysisAt: row.last_analysis_at ? new Date(row.last_analysis_at).toISOString() : null,
    lastAnalysisLang: row.last_analysis_lang || null,
    lang_pref: row.lang_pref || null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function ensureEphemeralProfile({ kind, id }) {
  const key = profileKeyFor({ kind, id });
  if (!key) return null;
  const existing = ephemeral.profiles.get(key);
  if (existing) return existing;
  const now = isoTs();
  const base =
    kind === 'account'
      ? {
          user_id: id,
          skinType: null,
          sensitivity: null,
          barrierStatus: null,
          goals: [],
          region: null,
          budgetTier: null,
          currentRoutine: null,
          itinerary: null,
          travel_plan: null,
          travel_plans: [],
          contraindications: [],
          age_band: null,
          pregnancy_status: null,
          pregnancy_due_date: null,
          lactation_status: null,
          high_risk_medications: [],
          chatContext: null,
          lastAnalysis: null,
          lastAnalysisAt: null,
          lastAnalysisLang: null,
          lang_pref: null,
          updated_at: now,
          created_at: now,
        }
      : {
          aurora_uid: id,
          skinType: null,
          sensitivity: null,
          barrierStatus: null,
          goals: [],
          region: null,
          budgetTier: null,
          currentRoutine: null,
          itinerary: null,
          travel_plan: null,
          travel_plans: [],
          contraindications: [],
          age_band: null,
          pregnancy_status: null,
          pregnancy_due_date: null,
          lactation_status: null,
          high_risk_medications: [],
          chatContext: null,
          lastAnalysis: null,
          lastAnalysisAt: null,
          lastAnalysisLang: null,
          lang_pref: null,
          updated_at: now,
          created_at: now,
        };
  touchEphemeral(ephemeral.profiles, key, base);
  return base;
}

function upsertEphemeralProfile({ kind, id }, profilePatch) {
  const key = profileKeyFor({ kind, id });
  if (!key) return null;
  const existing = ensureEphemeralProfile({ kind, id });
  if (!existing) return null;
  const p = profilePatch || {};

  const next = {
    ...existing,
    ...(p.skinType !== undefined ? { skinType: p.skinType } : {}),
    ...(p.sensitivity !== undefined ? { sensitivity: p.sensitivity } : {}),
    ...(p.barrierStatus !== undefined ? { barrierStatus: p.barrierStatus } : {}),
    ...(p.goals !== undefined ? { goals: Array.isArray(p.goals) ? p.goals : [] } : {}),
    ...(p.region !== undefined ? { region: p.region } : {}),
    ...(p.budgetTier !== undefined ? { budgetTier: p.budgetTier } : {}),
    ...(p.currentRoutine !== undefined ? { currentRoutine: p.currentRoutine } : {}),
    ...(p.itinerary !== undefined ? { itinerary: p.itinerary } : {}),
    ...(p.travel_plan !== undefined ? { travel_plan: p.travel_plan } : {}),
    ...(p.travel_plans !== undefined ? { travel_plans: Array.isArray(p.travel_plans) ? p.travel_plans : [] } : {}),
    ...(p.contraindications !== undefined ? { contraindications: Array.isArray(p.contraindications) ? p.contraindications : [] } : {}),
    ...(p.age_band !== undefined || p.ageBand !== undefined ? { age_band: p.age_band ?? p.ageBand } : {}),
    ...(p.pregnancy_status !== undefined || p.pregnancyStatus !== undefined
      ? { pregnancy_status: p.pregnancy_status ?? p.pregnancyStatus }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(p, 'pregnancy_due_date') || Object.prototype.hasOwnProperty.call(p, 'pregnancyDueDate')
      ? { pregnancy_due_date: Object.prototype.hasOwnProperty.call(p, 'pregnancy_due_date') ? p.pregnancy_due_date : p.pregnancyDueDate }
      : {}),
    ...(p.lactation_status !== undefined || p.lactationStatus !== undefined
      ? { lactation_status: p.lactation_status ?? p.lactationStatus }
      : {}),
    ...(p.high_risk_medications !== undefined || p.highRiskMedications !== undefined
      ? {
          high_risk_medications: Array.isArray(p.high_risk_medications)
            ? p.high_risk_medications
            : Array.isArray(p.highRiskMedications)
              ? p.highRiskMedications
              : [],
        }
      : {}),
    ...(p.chatContext !== undefined ? { chatContext: normalizeChatContext(p.chatContext) } : {}),
    ...(p.lang_pref !== undefined ? { lang_pref: p.lang_pref } : {}),
    updated_at: isoTs(),
  };

  touchEphemeral(ephemeral.profiles, key, next);
  return next;
}

async function getUserProfile(auroraUid) {
  const uid = normalizeAuroraUid(auroraUid);
  if (!uid) return null;
  if (persistenceDisabled()) {
    const key = profileKeyFor({ kind: 'guest', id: uid });
    return key ? ephemeral.profiles.get(key) || null : null;
  }
  const res = await query(
    `
      SELECT *
      FROM aurora_user_profiles
      WHERE aurora_uid = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [uid],
  );
  return mapProfileFromDb(res.rows && res.rows[0]);
}

async function getAccountProfile(userId) {
  const uid = normalizeUserId(userId);
  if (!uid) return null;
  if (persistenceDisabled()) {
    const key = profileKeyFor({ kind: 'account', id: uid });
    return key ? ephemeral.profiles.get(key) || null : null;
  }
  const res = await query(
    `
      SELECT *
      FROM aurora_account_profiles
      WHERE user_id = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [uid],
  );
  return mapAccountProfileFromDb(res.rows && res.rows[0]);
}

async function upsertUserProfile(auroraUid, profilePatch) {
  const uid = normalizeAuroraUid(auroraUid);
  if (!uid) return null;
  if (persistenceDisabled()) {
    const existingProfile = ensureEphemeralProfile({ kind: 'guest', id: uid }) || {};
    const normalizedPatch = normalizeTravelProfilePatch({ baseProfile: existingProfile, patch: profilePatch || {} });
    return upsertEphemeralProfile({ kind: 'guest', id: uid }, normalizedPatch);
  }

  await ensureUserProfileRow(uid);
  const existingRes = await query(
    `
      SELECT *
      FROM aurora_user_profiles
      WHERE aurora_uid = $1
      LIMIT 1
    `,
    [uid],
  );
  const existing = existingRes.rows && existingRes.rows[0] ? existingRes.rows[0] : { aurora_uid: uid };
  const existingProfile = mapProfileFromDb(existingRes.rows && existingRes.rows[0]) || {};
  const normalizedPatch = normalizeTravelProfilePatch({ baseProfile: existingProfile, patch: profilePatch || {} });
  const patchDb = mapProfileToDb(normalizedPatch);

  const merged = {
    ...existing,
    ...Object.fromEntries(Object.entries(patchDb).filter(([, v]) => v !== undefined)),
  };

  await query(
    `
      INSERT INTO aurora_user_profiles (
        aurora_uid,
        skin_type,
        sensitivity,
        barrier_status,
        goals,
        region,
        budget_tier,
        current_routine,
        itinerary,
        travel_plan,
        travel_plans,
        contraindications,
        age_band,
        pregnancy_status,
        pregnancy_due_date,
        lactation_status,
        high_risk_medications,
        chat_context,
        lang_pref,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
      ON CONFLICT (aurora_uid) DO UPDATE SET
        skin_type = EXCLUDED.skin_type,
        sensitivity = EXCLUDED.sensitivity,
        barrier_status = EXCLUDED.barrier_status,
        goals = EXCLUDED.goals,
        region = EXCLUDED.region,
        budget_tier = EXCLUDED.budget_tier,
        current_routine = EXCLUDED.current_routine,
        itinerary = EXCLUDED.itinerary,
        travel_plan = EXCLUDED.travel_plan,
        travel_plans = EXCLUDED.travel_plans,
        contraindications = EXCLUDED.contraindications,
        age_band = EXCLUDED.age_band,
        pregnancy_status = EXCLUDED.pregnancy_status,
        pregnancy_due_date = EXCLUDED.pregnancy_due_date,
        lactation_status = EXCLUDED.lactation_status,
        high_risk_medications = EXCLUDED.high_risk_medications,
        chat_context = EXCLUDED.chat_context,
        lang_pref = EXCLUDED.lang_pref,
        updated_at = now(),
        deleted_at = NULL
    `,
    [
      uid,
      merged.skin_type ?? null,
      merged.sensitivity ?? null,
      merged.barrier_status ?? null,
      normalizeJsonbParam(merged.goals ?? null),
      merged.region ?? null,
      merged.budget_tier ?? null,
      normalizeJsonbParam(merged.current_routine ?? null),
      normalizeJsonbParam(merged.itinerary ?? null),
      normalizeJsonbParam(merged.travel_plan ?? null),
      normalizeJsonbParam(merged.travel_plans ?? null),
      normalizeJsonbParam(merged.contraindications ?? null),
      merged.age_band ?? null,
      merged.pregnancy_status ?? null,
      merged.pregnancy_due_date ?? null,
      merged.lactation_status ?? null,
      normalizeJsonbParam(merged.high_risk_medications ?? null),
      normalizeJsonbParam(normalizeChatContext(merged.chat_context) ?? null),
      merged.lang_pref ?? null,
    ],
  );

  return getUserProfile(uid);
}

async function upsertAccountProfile(userId, profilePatch) {
  const uid = normalizeUserId(userId);
  if (!uid) return null;
  if (persistenceDisabled()) {
    const existingProfile = ensureEphemeralProfile({ kind: 'account', id: uid }) || {};
    const normalizedPatch = normalizeTravelProfilePatch({ baseProfile: existingProfile, patch: profilePatch || {} });
    return upsertEphemeralProfile({ kind: 'account', id: uid }, normalizedPatch);
  }

  await ensureAccountProfileRow(uid);
  const existingRes = await query(
    `
      SELECT *
      FROM aurora_account_profiles
      WHERE user_id = $1
      LIMIT 1
    `,
    [uid],
  );
  const existing =
    existingRes.rows && existingRes.rows[0]
      ? existingRes.rows[0]
      : { user_id: uid };
  const existingProfile = mapAccountProfileFromDb(existingRes.rows && existingRes.rows[0]) || {};
  const normalizedPatch = normalizeTravelProfilePatch({ baseProfile: existingProfile, patch: profilePatch || {} });
  const patchDb = mapProfileToDb(normalizedPatch);

  const merged = {
    ...existing,
    ...Object.fromEntries(Object.entries(patchDb).filter(([, v]) => v !== undefined)),
  };

  await query(
    `
      INSERT INTO aurora_account_profiles (
        user_id,
        skin_type,
        sensitivity,
        barrier_status,
        goals,
        region,
        budget_tier,
        current_routine,
        itinerary,
        travel_plan,
        travel_plans,
        contraindications,
        age_band,
        pregnancy_status,
        pregnancy_due_date,
        lactation_status,
        high_risk_medications,
        chat_context,
        lang_pref,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
      ON CONFLICT (user_id) DO UPDATE SET
        skin_type = EXCLUDED.skin_type,
        sensitivity = EXCLUDED.sensitivity,
        barrier_status = EXCLUDED.barrier_status,
        goals = EXCLUDED.goals,
        region = EXCLUDED.region,
        budget_tier = EXCLUDED.budget_tier,
        current_routine = EXCLUDED.current_routine,
        itinerary = EXCLUDED.itinerary,
        travel_plan = EXCLUDED.travel_plan,
        travel_plans = EXCLUDED.travel_plans,
        contraindications = EXCLUDED.contraindications,
        age_band = EXCLUDED.age_band,
        pregnancy_status = EXCLUDED.pregnancy_status,
        pregnancy_due_date = EXCLUDED.pregnancy_due_date,
        lactation_status = EXCLUDED.lactation_status,
        high_risk_medications = EXCLUDED.high_risk_medications,
        chat_context = EXCLUDED.chat_context,
        lang_pref = EXCLUDED.lang_pref,
        updated_at = now(),
        deleted_at = NULL
    `,
    [
      uid,
      merged.skin_type ?? null,
      merged.sensitivity ?? null,
      merged.barrier_status ?? null,
      normalizeJsonbParam(merged.goals ?? null),
      merged.region ?? null,
      merged.budget_tier ?? null,
      normalizeJsonbParam(merged.current_routine ?? null),
      normalizeJsonbParam(merged.itinerary ?? null),
      normalizeJsonbParam(merged.travel_plan ?? null),
      normalizeJsonbParam(merged.travel_plans ?? null),
      normalizeJsonbParam(merged.contraindications ?? null),
      merged.age_band ?? null,
      merged.pregnancy_status ?? null,
      merged.pregnancy_due_date ?? null,
      merged.lactation_status ?? null,
      normalizeJsonbParam(merged.high_risk_medications ?? null),
      normalizeJsonbParam(normalizeChatContext(merged.chat_context) ?? null),
      merged.lang_pref ?? null,
    ],
  );

  return getAccountProfile(uid);
}

function mapSkinLogFromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    aurora_uid: row.aurora_uid,
    date: row.log_date ? new Date(row.log_date).toISOString().slice(0, 10) : null,
    redness: typeof row.redness === 'number' ? row.redness : row.redness == null ? null : Number(row.redness),
    acne: typeof row.acne === 'number' ? row.acne : row.acne == null ? null : Number(row.acne),
    hydration:
      typeof row.hydration === 'number' ? row.hydration : row.hydration == null ? null : Number(row.hydration),
    notes: row.notes || null,
    targetProduct: row.target_product || null,
    sensation: row.sensation || null,
    routine_id: row.routine_id || null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function mapAccountSkinLogFromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    date: row.log_date ? new Date(row.log_date).toISOString().slice(0, 10) : null,
    redness: typeof row.redness === 'number' ? row.redness : row.redness == null ? null : Number(row.redness),
    acne: typeof row.acne === 'number' ? row.acne : row.acne == null ? null : Number(row.acne),
    hydration:
      typeof row.hydration === 'number' ? row.hydration : row.hydration == null ? null : Number(row.hydration),
    notes: row.notes || null,
    targetProduct: row.target_product || null,
    sensation: row.sensation || null,
    routine_id: row.routine_id || null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

async function upsertSkinLog(auroraUid, log) {
  const uid = normalizeAuroraUid(auroraUid);
  if (!uid) return null;
  if (persistenceDisabled()) {
    ensureEphemeralProfile({ kind: 'guest', id: uid });
    const date = coerceIsoDate(log && log.date);
    const redness = log && typeof log.redness === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.redness))) : null;
    const acne = log && typeof log.acne === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.acne))) : null;
    const hydration =
      log && typeof log.hydration === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.hydration))) : null;
    const notes = log && typeof log.notes === 'string' ? log.notes.slice(0, 4000) : null;
    const targetProduct = log && typeof log.targetProduct === 'string' ? log.targetProduct.slice(0, 500) : null;
    const sensation = log && typeof log.sensation === 'string' ? log.sensation.slice(0, 500) : null;
    const routineId = log && typeof log.routine_id === 'string' ? log.routine_id.slice(0, 120) : null;

    const key = profileKeyFor({ kind: 'guest', id: uid });
    const logsKey = key ? `${key}:logs` : null;
    if (!logsKey) return null;
    const byDate = ephemeral.logs.get(logsKey) || new Map();
    const now = isoTs();
    const entry = {
      id: `${uid}:${date}`,
      aurora_uid: uid,
      date,
      redness,
      acne,
      hydration,
      notes,
      targetProduct,
      sensation,
      routine_id: routineId,
      updated_at: now,
      created_at: now,
    };
    byDate.set(date, entry);
    touchEphemeral(ephemeral.logs, logsKey, byDate);
    return entry;
  }
  await ensureUserProfileRow(uid);
  const date = coerceIsoDate(log && log.date);

  const redness = log && typeof log.redness === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.redness))) : null;
  const acne = log && typeof log.acne === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.acne))) : null;
  const hydration =
    log && typeof log.hydration === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.hydration))) : null;
  const notes = log && typeof log.notes === 'string' ? log.notes.slice(0, 4000) : null;
  const targetProduct = log && typeof log.targetProduct === 'string' ? log.targetProduct.slice(0, 500) : null;
  const sensation = log && typeof log.sensation === 'string' ? log.sensation.slice(0, 500) : null;
  const routineId = log && typeof log.routine_id === 'string' ? log.routine_id.slice(0, 120) : null;

  const res = await query(
    `
      INSERT INTO aurora_skin_logs (
        aurora_uid, log_date, redness, acne, hydration, notes, target_product, sensation, routine_id, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
      ON CONFLICT (aurora_uid, log_date) DO UPDATE SET
        redness = EXCLUDED.redness,
        acne = EXCLUDED.acne,
        hydration = EXCLUDED.hydration,
        notes = EXCLUDED.notes,
        target_product = EXCLUDED.target_product,
        sensation = EXCLUDED.sensation,
        routine_id = EXCLUDED.routine_id,
        updated_at = now()
      RETURNING *
    `,
    [uid, date, redness, acne, hydration, notes, targetProduct, sensation, routineId],
  );

  return mapSkinLogFromDb(res.rows && res.rows[0]);
}

async function upsertAccountSkinLog(userId, log) {
  const uid = normalizeUserId(userId);
  if (!uid) return null;
  if (persistenceDisabled()) {
    ensureEphemeralProfile({ kind: 'account', id: uid });
    const date = coerceIsoDate(log && log.date);
    const redness = log && typeof log.redness === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.redness))) : null;
    const acne = log && typeof log.acne === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.acne))) : null;
    const hydration =
      log && typeof log.hydration === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.hydration))) : null;
    const notes = log && typeof log.notes === 'string' ? log.notes.slice(0, 4000) : null;
    const targetProduct = log && typeof log.targetProduct === 'string' ? log.targetProduct.slice(0, 500) : null;
    const sensation = log && typeof log.sensation === 'string' ? log.sensation.slice(0, 500) : null;
    const routineId = log && typeof log.routine_id === 'string' ? log.routine_id.slice(0, 120) : null;

    const key = profileKeyFor({ kind: 'account', id: uid });
    const logsKey = key ? `${key}:logs` : null;
    if (!logsKey) return null;
    const byDate = ephemeral.logs.get(logsKey) || new Map();
    const now = isoTs();
    const entry = {
      id: `${uid}:${date}`,
      user_id: uid,
      date,
      redness,
      acne,
      hydration,
      notes,
      targetProduct,
      sensation,
      routine_id: routineId,
      updated_at: now,
      created_at: now,
    };
    byDate.set(date, entry);
    touchEphemeral(ephemeral.logs, logsKey, byDate);
    return entry;
  }
  const date = coerceIsoDate(log && log.date);

  const redness = log && typeof log.redness === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.redness))) : null;
  const acne = log && typeof log.acne === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.acne))) : null;
  const hydration =
    log && typeof log.hydration === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.hydration))) : null;
  const notes = log && typeof log.notes === 'string' ? log.notes.slice(0, 4000) : null;
  const targetProduct = log && typeof log.targetProduct === 'string' ? log.targetProduct.slice(0, 500) : null;
  const sensation = log && typeof log.sensation === 'string' ? log.sensation.slice(0, 500) : null;
  const routineId = log && typeof log.routine_id === 'string' ? log.routine_id.slice(0, 120) : null;

  const res = await query(
    `
      INSERT INTO aurora_account_skin_logs (
        user_id, log_date, redness, acne, hydration, notes, target_product, sensation, routine_id, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
      ON CONFLICT (user_id, log_date) DO UPDATE SET
        redness = EXCLUDED.redness,
        acne = EXCLUDED.acne,
        hydration = EXCLUDED.hydration,
        notes = EXCLUDED.notes,
        target_product = EXCLUDED.target_product,
        sensation = EXCLUDED.sensation,
        routine_id = EXCLUDED.routine_id,
        updated_at = now()
      RETURNING *
    `,
    [uid, date, redness, acne, hydration, notes, targetProduct, sensation, routineId],
  );

  return mapAccountSkinLogFromDb(res.rows && res.rows[0]);
}

async function getRecentSkinLogs(auroraUid, days = 7) {
  const uid = normalizeAuroraUid(auroraUid);
  if (!uid) return [];
  if (persistenceDisabled()) {
    const key = profileKeyFor({ kind: 'guest', id: uid });
    const logsKey = key ? `${key}:logs` : null;
    if (!logsKey) return [];
    const byDate = ephemeral.logs.get(logsKey);
    if (!byDate) return [];
    const n = Math.max(1, Math.min(30, Number(days) || 7));
    return Array.from(byDate.values())
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, n);
  }
  const n = Math.max(1, Math.min(30, Number(days) || 7));
  const res = await query(
    `
      SELECT *
      FROM aurora_skin_logs
      WHERE aurora_uid = $1
      ORDER BY log_date DESC
      LIMIT $2
    `,
    [uid, n],
  );
  return (res.rows || []).map(mapSkinLogFromDb).filter(Boolean);
}

async function getRecentAccountSkinLogs(userId, days = 7) {
  const uid = normalizeUserId(userId);
  if (!uid) return [];
  if (persistenceDisabled()) {
    const key = profileKeyFor({ kind: 'account', id: uid });
    const logsKey = key ? `${key}:logs` : null;
    if (!logsKey) return [];
    const byDate = ephemeral.logs.get(logsKey);
    if (!byDate) return [];
    const n = Math.max(1, Math.min(30, Number(days) || 7));
    return Array.from(byDate.values())
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, n);
  }
  const n = Math.max(1, Math.min(30, Number(days) || 7));
  const res = await query(
    `
      SELECT *
      FROM aurora_account_skin_logs
      WHERE user_id = $1
      ORDER BY log_date DESC
      LIMIT $2
    `,
    [uid, n],
  );
  return (res.rows || []).map(mapAccountSkinLogFromDb).filter(Boolean);
}

function isCheckinDue(recentLogs) {
  if (!Array.isArray(recentLogs) || recentLogs.length === 0) return true;
  const latest = recentLogs[0];
  if (!latest || !latest.date) return true;
  const today = isoDateUTC();
  return latest.date !== today;
}

async function upsertIdentityLink(auroraUid, userId) {
  const uid = normalizeAuroraUid(auroraUid);
  const user = normalizeUserId(userId);
  if (!uid || !user) return null;
  if (persistenceDisabled()) {
    ephemeral.identityLinks.set(uid, user);
    return { aurora_uid: uid, user_id: user };
  }
  await query(
    `
      INSERT INTO aurora_identity_links (aurora_uid, user_id, created_at, last_seen_at)
      VALUES ($1,$2, now(), now())
      ON CONFLICT (aurora_uid) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        last_seen_at = now()
    `,
    [uid, user],
  );
  return { aurora_uid: uid, user_id: user };
}

async function migrateGuestDataToUser({ auroraUid, userId }) {
  const uid = normalizeAuroraUid(auroraUid);
  const user = normalizeUserId(userId);
  if (!uid || !user) return { ok: false, reason: 'missing_identity' };
  if (persistenceDisabled()) {
    // Retention disabled: best-effort ephemeral merge for the active process only.
    ephemeral.identityLinks.set(uid, user);
    const guestKey = profileKeyFor({ kind: 'guest', id: uid });
    const accountKey = profileKeyFor({ kind: 'account', id: user });
    if (guestKey && accountKey) {
      const guest = ephemeral.profiles.get(guestKey);
      const acct = ephemeral.profiles.get(accountKey);
      if (guest && !acct) touchEphemeral(ephemeral.profiles, accountKey, { ...guest, user_id: user });
    }
    return { ok: true, migrated: false };
  }

  const guestProfile = await getUserProfile(uid);
  const guestLogs = await getRecentSkinLogs(uid, 30);

  if (!guestProfile && (!guestLogs || guestLogs.length === 0)) return { ok: true, migrated: false };

  const accountProfile = await getAccountProfile(user);
  const patch = {};

  if (guestProfile) {
    if (!accountProfile || !accountProfile.skinType) patch.skinType = guestProfile.skinType;
    if (!accountProfile || !accountProfile.sensitivity) patch.sensitivity = guestProfile.sensitivity;
    if (!accountProfile || !accountProfile.barrierStatus) patch.barrierStatus = guestProfile.barrierStatus;
    if ((!accountProfile || !Array.isArray(accountProfile.goals) || accountProfile.goals.length === 0) && Array.isArray(guestProfile.goals) && guestProfile.goals.length) {
      patch.goals = guestProfile.goals;
    }
    if (!accountProfile || !accountProfile.region) patch.region = guestProfile.region;
    if (!accountProfile || !accountProfile.budgetTier) patch.budgetTier = guestProfile.budgetTier;
    if (!accountProfile || accountProfile.currentRoutine == null) patch.currentRoutine = guestProfile.currentRoutine;
    if (!accountProfile || accountProfile.itinerary == null) patch.itinerary = guestProfile.itinerary;
    if (
      (!accountProfile || !Array.isArray(accountProfile.travel_plans) || accountProfile.travel_plans.length === 0) &&
      Array.isArray(guestProfile.travel_plans) &&
      guestProfile.travel_plans.length
    ) {
      patch.travel_plans = guestProfile.travel_plans;
    }
    if (
      (!accountProfile || !accountProfile.travel_plan) &&
      guestProfile.travel_plan &&
      typeof guestProfile.travel_plan === 'object' &&
      !Array.isArray(guestProfile.travel_plan)
    ) {
      patch.travel_plan = guestProfile.travel_plan;
    }
    if ((!accountProfile || !Array.isArray(accountProfile.contraindications) || accountProfile.contraindications.length === 0) && Array.isArray(guestProfile.contraindications) && guestProfile.contraindications.length) {
      patch.contraindications = guestProfile.contraindications;
    }
    if (!accountProfile || !accountProfile.age_band) patch.age_band = guestProfile.age_band;
    if (!accountProfile || !accountProfile.pregnancy_status) patch.pregnancy_status = guestProfile.pregnancy_status;
    if (!accountProfile || !accountProfile.lactation_status) patch.lactation_status = guestProfile.lactation_status;
    if (!accountProfile || accountProfile.pregnancy_due_date == null) {
      patch.pregnancy_due_date = guestProfile.pregnancy_due_date ?? null;
    }
    if (
      (!accountProfile ||
        !Array.isArray(accountProfile.high_risk_medications) ||
        accountProfile.high_risk_medications.length === 0) &&
      Array.isArray(guestProfile.high_risk_medications)
    ) {
      patch.high_risk_medications = guestProfile.high_risk_medications;
    }
    if (
      (!accountProfile || !normalizeChatContext(accountProfile.chatContext)) &&
      normalizeChatContext(guestProfile.chatContext)
    ) {
      patch.chatContext = normalizeChatContext(guestProfile.chatContext);
    }
    if (!accountProfile || !accountProfile.lang_pref) patch.lang_pref = guestProfile.lang_pref;
  }

  if (Object.keys(patch).length) {
    await upsertAccountProfile(user, patch);
  } else if (!accountProfile) {
    await ensureAccountProfileRow(user);
  }

  if (guestProfile && guestProfile.lastAnalysis && (!accountProfile || !accountProfile.lastAnalysis)) {
    try {
      await query(
        `
          UPDATE aurora_account_profiles
          SET last_analysis = $2::jsonb,
              last_analysis_at = now(),
              last_analysis_lang = $3,
              updated_at = now(),
              deleted_at = NULL
          WHERE user_id = $1
        `,
        [user, JSON.stringify(guestProfile.lastAnalysis), guestProfile.lastAnalysisLang || null],
      );
    } catch {
      // Best-effort migration; ignore failures.
    }
  }

  if (Array.isArray(guestLogs) && guestLogs.length) {
    for (const log of guestLogs) {
      const date = coerceIsoDate(log && log.date);
      const redness = log && typeof log.redness === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.redness))) : null;
      const acne = log && typeof log.acne === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.acne))) : null;
      const hydration =
        log && typeof log.hydration === 'number' ? Math.max(0, Math.min(5, Math.trunc(log.hydration))) : null;
      const notes = log && typeof log.notes === 'string' ? log.notes.slice(0, 4000) : null;
      const targetProduct = log && typeof log.targetProduct === 'string' ? log.targetProduct.slice(0, 500) : null;
      const sensation = log && typeof log.sensation === 'string' ? log.sensation.slice(0, 500) : null;

      // Preserve existing account logs on conflict.
      // eslint-disable-next-line no-await-in-loop
      await query(
        `
          INSERT INTO aurora_account_skin_logs (
            user_id, log_date, redness, acne, hydration, notes, target_product, sensation, updated_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
          ON CONFLICT (user_id, log_date) DO NOTHING
        `,
        [user, date, redness, acne, hydration, notes, targetProduct, sensation],
      );
    }
  }

  try {
    const guestEvents = await query(
      `
        SELECT *
        FROM aurora_user_experiment_logs
        WHERE aurora_uid = $1
        ORDER BY event_ts ASC
        LIMIT 200
      `,
      [uid],
    );
    for (const row of guestEvents.rows || []) {
      const evt = mapExperimentRowFromDb(row);
      if (!evt) continue;
      // eslint-disable-next-line no-await-in-loop
      await appendExperimentEventForIdentity({ auroraUid: uid, userId: user }, evt);
    }
  } catch {
    // Best-effort migration; ignore failures.
  }

  return { ok: true, migrated: true };
}

function identityFromRequest({ auroraUid, userId }) {
  const uid = normalizeAuroraUid(auroraUid);
  const user = normalizeUserId(userId);
  return { aurora_uid: uid, user_id: user };
}

async function getProfileForIdentity({ auroraUid, userId }) {
  const identity = identityFromRequest({ auroraUid, userId });
  if (identity.user_id) return await getAccountProfile(identity.user_id);
  return await getUserProfile(identity.aurora_uid);
}

async function upsertProfileForIdentity({ auroraUid, userId }, patch) {
  const identity = identityFromRequest({ auroraUid, userId });
  if (identity.user_id) return await upsertAccountProfile(identity.user_id, patch);
  return await upsertUserProfile(identity.aurora_uid, patch);
}

async function getRecentSkinLogsForIdentity({ auroraUid, userId }, days = 7) {
  const identity = identityFromRequest({ auroraUid, userId });
  if (identity.user_id) return await getRecentAccountSkinLogs(identity.user_id, days);
  return await getRecentSkinLogs(identity.aurora_uid, days);
}

async function upsertSkinLogForIdentity({ auroraUid, userId }, log) {
  const identity = identityFromRequest({ auroraUid, userId });
  if (identity.user_id) return await upsertAccountSkinLog(identity.user_id, log);
  return await upsertSkinLog(identity.aurora_uid, log);
}

async function getChatContextForIdentity({ auroraUid, userId }) {
  const identity = identityFromRequest({ auroraUid, userId });
  if (!identity.user_id && !identity.aurora_uid) return null;
  const profile = await getProfileForIdentity({ auroraUid, userId });
  return normalizeChatContext(profile && profile.chatContext ? profile.chatContext : null);
}

async function upsertChatContextForIdentity({ auroraUid, userId }, chatContext) {
  const normalized = normalizeChatContext(chatContext);
  if (!normalized) return null;
  const identity = identityFromRequest({ auroraUid, userId });
  if (!identity.user_id && !identity.aurora_uid) return null;
  if (identity.user_id) return await upsertAccountProfile(identity.user_id, { chatContext: normalized });
  return await upsertUserProfile(identity.aurora_uid, { chatContext: normalized });
}

async function appendExperimentEventForIdentity({ auroraUid, userId }, event) {
  const identity = identityFromRequest({ auroraUid, userId });
  const normalized = normalizeExperimentEvent(event);
  if (!normalized) return null;
  if (!identity.user_id && !identity.aurora_uid) return null;

  if (persistenceDisabled()) {
    const kind = identity.user_id ? 'account' : 'guest';
    const id = identity.user_id || identity.aurora_uid;
    if (!id) return null;
    const key = experimentKeyFor({ kind, id });
    if (!key) return null;
    const existing = Array.isArray(ephemeral.experiments.get(key)) ? ephemeral.experiments.get(key) : [];
    const row = {
      id: `${id}_${normalized.timestamp_ms}_${existing.length + 1}`,
      event_type: normalized.event_type,
      event_data: normalized.event_data,
      timestamp_ms: normalized.timestamp_ms,
      request_id: normalized.request_id,
      trace_id: normalized.trace_id,
    };
    touchEphemeral(ephemeral.experiments, key, [row, ...existing].slice(0, 200));
    return row;
  }

  if (identity.user_id) {
    await ensureAccountProfileRow(identity.user_id);
    const res = await query(
      `
        INSERT INTO aurora_account_experiment_logs (
          user_id,
          event_type,
          event_data,
          event_ts,
          request_id,
          trace_id
        )
        VALUES ($1,$2,$3::jsonb,to_timestamp($4::double precision / 1000.0),$5,$6)
        RETURNING *
      `,
      [
        identity.user_id,
        normalized.event_type,
        normalizeJsonbParam(normalized.event_data),
        normalized.timestamp_ms,
        normalized.request_id,
        normalized.trace_id,
      ],
    );
    return mapExperimentRowFromDb(res.rows && res.rows[0]);
  }

  await ensureUserProfileRow(identity.aurora_uid);
  const res = await query(
    `
      INSERT INTO aurora_user_experiment_logs (
        aurora_uid,
        event_type,
        event_data,
        event_ts,
        request_id,
        trace_id
      )
      VALUES ($1,$2,$3::jsonb,to_timestamp($4::double precision / 1000.0),$5,$6)
      RETURNING *
    `,
    [
      identity.aurora_uid,
      normalized.event_type,
      normalizeJsonbParam(normalized.event_data),
      normalized.timestamp_ms,
      normalized.request_id,
      normalized.trace_id,
    ],
  );
  return mapExperimentRowFromDb(res.rows && res.rows[0]);
}

async function appendActivityEventForIdentity({ auroraUid, userId }, event) {
  const identity = identityFromRequest({ auroraUid, userId });
  if (!identity.user_id && !identity.aurora_uid) return null;
  const normalized = normalizeActivityEvent(event);
  if (!normalized) return null;

  if (persistenceDisabled()) {
    const keys = [];
    if (identity.user_id) {
      const key = profileKeyFor({ kind: 'account', id: identity.user_id });
      if (key) keys.push(`${key}:activity`);
    }
    if (identity.aurora_uid) {
      const key = profileKeyFor({ kind: 'guest', id: identity.aurora_uid });
      if (key) keys.push(`${key}:activity`);
    }
    const row = {
      id: Date.now(),
      activity_id: normalized.activity_id,
      aurora_uid: identity.aurora_uid || null,
      user_id: identity.user_id || null,
      event_type: normalized.event_type,
      payload: normalized.payload,
      deeplink: normalized.deeplink,
      source: normalized.source,
      occurred_at_ms: normalized.occurred_at_ms,
      created_at: isoTs(),
    };
    for (const key of keys) {
      const existing = Array.isArray(ephemeral.activities.get(key)) ? ephemeral.activities.get(key) : [];
      touchEphemeral(ephemeral.activities, key, [row, ...existing].slice(0, 500));
    }
    return mapActivityRowFromDb(row);
  }

  const res = await query(
    `
      INSERT INTO aurora_activity_events (
        activity_id,
        aurora_uid,
        user_id,
        event_type,
        payload,
        deeplink,
        source,
        occurred_at_ms
      )
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
      RETURNING *
    `,
    [
      normalized.activity_id,
      identity.aurora_uid || null,
      identity.user_id || null,
      normalized.event_type,
      normalizeJsonbParam(normalized.payload),
      normalized.deeplink,
      normalized.source,
      normalized.occurred_at_ms,
    ],
  );
  return mapActivityRowFromDb(res.rows && res.rows[0]);
}

async function listActivityEventsForIdentity({ auroraUid, userId }, { limit = 20, cursor = null, types = [] } = {}) {
  const identity = identityFromRequest({ auroraUid, userId });
  if (!identity.user_id && !identity.aurora_uid) {
    return { items: [], next_cursor: null };
  }

  const safeLimitRaw = Number(limit);
  const safeLimit = Number.isFinite(safeLimitRaw) ? Math.max(1, Math.min(50, Math.trunc(safeLimitRaw))) : 20;
  const typeSet = new Set((Array.isArray(types) ? types : []).map((item) => String(item || '').trim()).filter(Boolean));
  const decodedCursor = cursor ? decodeActivityCursor(cursor) : null;

  if (persistenceDisabled()) {
    const keys = [];
    if (identity.user_id) {
      const accountKey = profileKeyFor({ kind: 'account', id: identity.user_id });
      if (accountKey) keys.push(`${accountKey}:activity`);
    }
    if (identity.aurora_uid) {
      const guestKey = profileKeyFor({ kind: 'guest', id: identity.aurora_uid });
      if (guestKey) keys.push(`${guestKey}:activity`);
    }

    const merged = [];
    const seen = new Set();
    for (const key of keys) {
      const list = Array.isArray(ephemeral.activities.get(key)) ? ephemeral.activities.get(key) : [];
      for (const row of list) {
        const activityId = String((row && row.activity_id) || '').trim();
        if (!activityId || seen.has(activityId)) continue;
        seen.add(activityId);
        merged.push(row);
      }
    }

    let rows = merged.sort(compareActivityRowsDesc);
    if (typeSet.size > 0) {
      rows = rows.filter((row) => typeSet.has(String((row && row.event_type) || '').trim()));
    }
    if (decodedCursor) {
      rows = rows.filter((row) => {
        const ts = Number(row && row.occurred_at_ms);
        const id = Number(row && row.id);
        if (!Number.isFinite(ts) || !Number.isFinite(id)) return false;
        if (ts < decodedCursor.occurred_at_ms) return true;
        if (ts > decodedCursor.occurred_at_ms) return false;
        return id < decodedCursor.id;
      });
    }

    const pageRows = rows.slice(0, safeLimit + 1);
    const hasMore = pageRows.length > safeLimit;
    const dataRows = hasMore ? pageRows.slice(0, safeLimit) : pageRows;
    const mapped = dataRows.map((row) => mapActivityRowFromDb(row)).filter(Boolean);
    const nextCursor = hasMore ? encodeActivityCursor(pageRows[safeLimit - 1]) : null;
    return {
      items: mapped.map((item) => ({
        activity_id: item.activity_id,
        event_type: item.event_type,
        payload: item.payload,
        deeplink: item.deeplink,
        source: item.source,
        occurred_at_ms: item.occurred_at_ms,
        created_at: item.created_at,
      })),
      next_cursor: nextCursor,
    };
  }

  const where = [];
  const params = [];
  let idx = 1;

  if (identity.user_id && identity.aurora_uid) {
    where.push(`(user_id = $${idx} OR aurora_uid = $${idx + 1})`);
    params.push(identity.user_id, identity.aurora_uid);
    idx += 2;
  } else if (identity.user_id) {
    where.push(`user_id = $${idx}`);
    params.push(identity.user_id);
    idx += 1;
  } else {
    where.push(`aurora_uid = $${idx}`);
    params.push(identity.aurora_uid);
    idx += 1;
  }

  if (typeSet.size > 0) {
    where.push(`event_type = ANY($${idx}::text[])`);
    params.push(Array.from(typeSet));
    idx += 1;
  }

  if (decodedCursor) {
    where.push(`(occurred_at_ms < $${idx} OR (occurred_at_ms = $${idx} AND id < $${idx + 1}))`);
    params.push(decodedCursor.occurred_at_ms, decodedCursor.id);
    idx += 2;
  }

  params.push(safeLimit + 1);
  const sql = `
    SELECT id, activity_id, aurora_uid, user_id, event_type, payload, deeplink, source, occurred_at_ms, created_at
    FROM aurora_activity_events
    WHERE ${where.join(' AND ')}
    ORDER BY occurred_at_ms DESC, id DESC
    LIMIT $${idx}
  `;
  const res = await query(sql, params);
  const rows = Array.isArray(res.rows) ? res.rows : [];
  const hasMore = rows.length > safeLimit;
  const dataRows = hasMore ? rows.slice(0, safeLimit) : rows;
  const mapped = dataRows.map((row) => mapActivityRowFromDb(row)).filter(Boolean);
  const nextCursor = hasMore ? encodeActivityCursor(dataRows[dataRows.length - 1]) : null;

  return {
    items: mapped.map((item) => ({
      activity_id: item.activity_id,
      event_type: item.event_type,
      payload: item.payload,
      deeplink: item.deeplink,
      source: item.source,
      occurred_at_ms: item.occurred_at_ms,
      created_at: item.created_at,
    })),
    next_cursor: nextCursor,
  };
}

async function saveLastAnalysisForIdentity({ auroraUid, userId }, { analysis, lang }) {
  const identity = identityFromRequest({ auroraUid, userId });
  const analysisObj = analysis && typeof analysis === 'object' && !Array.isArray(analysis) ? analysis : null;
  if (!analysisObj) return null;

  let json = null;
  try {
    json = JSON.stringify(analysisObj);
  } catch {
    json = null;
  }
  if (!json) return null;

  if (persistenceDisabled()) {
    const key = identity.user_id
      ? profileKeyFor({ kind: 'account', id: identity.user_id })
      : profileKeyFor({ kind: 'guest', id: identity.aurora_uid });
    if (!key) return null;
    const existing = ephemeral.profiles.get(key) || ensureEphemeralProfile({ kind: identity.user_id ? 'account' : 'guest', id: identity.user_id || identity.aurora_uid });
    if (!existing) return null;
    const next = {
      ...existing,
      lastAnalysis: analysisObj,
      lastAnalysisAt: isoTs(),
      lastAnalysisLang: typeof lang === 'string' ? lang.trim() || null : null,
      updated_at: isoTs(),
    };
    touchEphemeral(ephemeral.profiles, key, next);
    return next;
  }

  if (identity.user_id) {
    await ensureAccountProfileRow(identity.user_id);
    const res = await query(
      `
        UPDATE aurora_account_profiles
        SET last_analysis = $2::jsonb,
            last_analysis_at = now(),
            last_analysis_lang = $3,
            updated_at = now(),
            deleted_at = NULL
        WHERE user_id = $1
        RETURNING *
      `,
      [identity.user_id, json, typeof lang === 'string' ? lang.trim() || null : null],
    );
    return mapAccountProfileFromDb(res.rows && res.rows[0]);
  }

  await ensureUserProfileRow(identity.aurora_uid);
  const res = await query(
    `
      UPDATE aurora_user_profiles
      SET last_analysis = $2::jsonb,
          last_analysis_at = now(),
          last_analysis_lang = $3,
          updated_at = now(),
          deleted_at = NULL
      WHERE aurora_uid = $1
      RETURNING *
    `,
    [identity.aurora_uid, json, typeof lang === 'string' ? lang.trim() || null : null],
  );
  return mapProfileFromDb(res.rows && res.rows[0]);
}

function normalizeShadowVerifyPayload(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const source = String(p.source || 'shadow_verify').trim() || 'shadow_verify';
  const provider = String(p.provider || 'gemini').trim() || 'gemini';
  const promptVersion = typeof p.prompt_version === 'string' ? p.prompt_version.trim() : '';
  const inputHash = typeof p.input_hash === 'string' ? p.input_hash.trim().toLowerCase() : '';
  const verdict = p.verdict && typeof p.verdict === 'object' && !Array.isArray(p.verdict) ? p.verdict : {};
  const meta = p.meta && typeof p.meta === 'object' && !Array.isArray(p.meta) ? p.meta : {};
  const createdAt = typeof p.created_at === 'string' && p.created_at.trim() ? p.created_at.trim() : isoTs();
  return {
    source,
    provider,
    prompt_version: promptVersion || null,
    input_hash: inputHash || null,
    verdict,
    meta,
    created_at: createdAt,
  };
}

async function saveShadowVerifyForIdentity({ auroraUid, userId }, { shadow }) {
  const identity = identityFromRequest({ auroraUid, userId });
  const hasIdentity = Boolean(identity.user_id) || Boolean(identity.aurora_uid);
  if (!hasIdentity) return null;

  const normalized = normalizeShadowVerifyPayload(shadow);
  if (persistenceDisabled()) {
    const key = identity.user_id
      ? profileKeyFor({ kind: 'account', id: identity.user_id })
      : profileKeyFor({ kind: 'guest', id: identity.aurora_uid });
    if (!key) return null;
    const list = ephemeral.shadowVerifyRuns.get(key) || [];
    const nextId = `${key}:shadow:${Date.now()}:${list.length + 1}`;
    const row = {
      shadow_id: nextId,
      aurora_uid: identity.aurora_uid || null,
      user_id: identity.user_id || null,
      ...normalized,
    };
    list.push(row);
    while (list.length > 20) list.shift();
    touchEphemeral(ephemeral.shadowVerifyRuns, key, list);
    return row;
  }

  if (identity.user_id) {
    await ensureAccountProfileRow(identity.user_id);
  } else if (identity.aurora_uid) {
    await ensureUserProfileRow(identity.aurora_uid);
  }

  const params = [
    identity.aurora_uid || null,
    identity.user_id || null,
    normalized.source,
    normalized.provider,
    normalized.prompt_version,
    normalized.input_hash,
    JSON.stringify(normalized.verdict || {}),
    JSON.stringify(normalized.meta || {}),
    normalized.created_at,
  ];
  const res = await query(
    `
      INSERT INTO aurora_skin_shadow_verify_runs (
        aurora_uid,
        user_id,
        source,
        provider,
        prompt_version,
        input_hash,
        verdict_json,
        meta_json,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::timestamptz)
      RETURNING
        id AS shadow_id,
        aurora_uid,
        user_id,
        source,
        provider,
        prompt_version,
        input_hash,
        verdict_json,
        meta_json,
        created_at
    `,
    params,
  );
  const row = res.rows && res.rows[0] ? res.rows[0] : null;
  if (!row) return null;
  return {
    shadow_id: row.shadow_id,
    aurora_uid: row.aurora_uid || null,
    user_id: row.user_id || null,
    source: row.source || normalized.source,
    provider: row.provider || normalized.provider,
    prompt_version: row.prompt_version || normalized.prompt_version || null,
    input_hash: row.input_hash || normalized.input_hash || null,
    verdict: row.verdict_json && typeof row.verdict_json === 'object' ? row.verdict_json : {},
    meta: row.meta_json && typeof row.meta_json === 'object' ? row.meta_json : {},
    created_at: row.created_at ? new Date(row.created_at).toISOString() : normalized.created_at,
  };
}

function appendShadowIdsToAnalysis(analysisObj, shadowId, maxIds = 20) {
  const base = analysisObj && typeof analysisObj === 'object' && !Array.isArray(analysisObj) ? { ...analysisObj } : {};
  const existing = Array.isArray(base.shadow_ids) ? base.shadow_ids : [];
  const dedup = [];
  const seen = new Set();
  for (const id of existing) {
    const v = String(id || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    dedup.push(v);
  }
  const incoming = String(shadowId || '').trim();
  if (incoming && !seen.has(incoming)) dedup.push(incoming);
  base.shadow_ids = dedup.slice(Math.max(0, dedup.length - Math.max(1, Math.min(100, Number(maxIds) || 20))));
  return base;
}

async function appendShadowIdToLastAnalysisForIdentity({ auroraUid, userId }, { shadowId, maxIds } = {}) {
  const identity = identityFromRequest({ auroraUid, userId });
  const incoming = String(shadowId || '').trim();
  if (!incoming) return null;

  if (persistenceDisabled()) {
    const key = identity.user_id
      ? profileKeyFor({ kind: 'account', id: identity.user_id })
      : profileKeyFor({ kind: 'guest', id: identity.aurora_uid });
    if (!key) return null;
    const existing = ephemeral.profiles.get(key) || ensureEphemeralProfile({ kind: identity.user_id ? 'account' : 'guest', id: identity.user_id || identity.aurora_uid });
    if (!existing) return null;
    const next = {
      ...existing,
      lastAnalysis: appendShadowIdsToAnalysis(existing.lastAnalysis, incoming, maxIds),
      lastAnalysisAt: isoTs(),
      updated_at: isoTs(),
    };
    touchEphemeral(ephemeral.profiles, key, next);
    return next;
  }

  if (identity.user_id) {
    await ensureAccountProfileRow(identity.user_id);
    const profile = await getAccountProfile(identity.user_id);
    const nextAnalysis = appendShadowIdsToAnalysis(profile && profile.lastAnalysis, incoming, maxIds);
    const json = JSON.stringify(nextAnalysis);
    const res = await query(
      `
        UPDATE aurora_account_profiles
        SET last_analysis = $2::jsonb,
            last_analysis_at = now(),
            updated_at = now(),
            deleted_at = NULL
        WHERE user_id = $1
        RETURNING *
      `,
      [identity.user_id, json],
    );
    return mapAccountProfileFromDb(res.rows && res.rows[0]);
  }

  await ensureUserProfileRow(identity.aurora_uid);
  const profile = await getUserProfile(identity.aurora_uid);
  const nextAnalysis = appendShadowIdsToAnalysis(profile && profile.lastAnalysis, incoming, maxIds);
  const json = JSON.stringify(nextAnalysis);
  const res = await query(
    `
      UPDATE aurora_user_profiles
      SET last_analysis = $2::jsonb,
          last_analysis_at = now(),
          updated_at = now(),
          deleted_at = NULL
      WHERE aurora_uid = $1
      RETURNING *
    `,
    [identity.aurora_uid, json],
  );
  return mapProfileFromDb(res.rows && res.rows[0]);
}

async function deleteIdentityData({ auroraUid, userId }) {
  const identity = identityFromRequest({ auroraUid, userId });
  const hasAny = Boolean(identity.aurora_uid) || Boolean(identity.user_id);
  if (!hasAny) return { ok: false, deleted: false, reason: 'missing_identity' };

  if (persistenceDisabled()) {
    if (identity.user_id) {
      const accountKey = profileKeyFor({ kind: 'account', id: identity.user_id });
      if (accountKey) {
        ephemeral.profiles.delete(accountKey);
        ephemeral.logs.delete(`${accountKey}:logs`);
        ephemeral.activities.delete(`${accountKey}:activity`);
        ephemeral.experiments.delete(`${accountKey}:experiments`);
      }
      for (const [k, v] of Array.from(ephemeral.identityLinks.entries())) {
        if (v === identity.user_id) ephemeral.identityLinks.delete(k);
      }
    }

    if (identity.aurora_uid) {
      const guestKey = profileKeyFor({ kind: 'guest', id: identity.aurora_uid });
      if (guestKey) {
        ephemeral.profiles.delete(guestKey);
        ephemeral.logs.delete(`${guestKey}:logs`);
        ephemeral.activities.delete(`${guestKey}:activity`);
        ephemeral.experiments.delete(`${guestKey}:experiments`);
      }
      ephemeral.identityLinks.delete(identity.aurora_uid);
    }

    return { ok: true, deleted: true, storage: 'ephemeral' };
  }

  if (identity.user_id) {
    await query(`DELETE FROM aurora_activity_events WHERE user_id = $1`, [identity.user_id]);
    // Hard-delete account profile and logs (ON DELETE CASCADE).
    await query(`DELETE FROM aurora_account_profiles WHERE user_id = $1`, [identity.user_id]);
    // Also delete any guest->account links for this account.
    await query(`DELETE FROM aurora_identity_links WHERE user_id = $1`, [identity.user_id]);
  }

  if (identity.aurora_uid) {
    await query(`DELETE FROM aurora_activity_events WHERE aurora_uid = $1`, [identity.aurora_uid]);
    // Hard-delete guest profile and logs (ON DELETE CASCADE).
    await query(`DELETE FROM aurora_user_profiles WHERE aurora_uid = $1`, [identity.aurora_uid]);
  }

  return { ok: true, deleted: true, storage: 'db' };
}

module.exports = {
  isoDateUTC,
  resolveNextStateFromSessionPatch,
  applySessionPatchNextState,
  normalizeAuroraUid,
  normalizeUserId,
  getUserProfile,
  upsertUserProfile,
  upsertSkinLog,
  getRecentSkinLogs,
  getAccountProfile,
  upsertAccountProfile,
  getRecentAccountSkinLogs,
  upsertAccountSkinLog,
  upsertIdentityLink,
  migrateGuestDataToUser,
  getProfileForIdentity,
  upsertProfileForIdentity,
  getRecentSkinLogsForIdentity,
  upsertSkinLogForIdentity,
  getChatContextForIdentity,
  upsertChatContextForIdentity,
  appendActivityEventForIdentity,
  listActivityEventsForIdentity,
  appendExperimentEventForIdentity,
  saveLastAnalysisForIdentity,
  saveShadowVerifyForIdentity,
  appendShadowIdToLastAnalysisForIdentity,
  deleteIdentityData,
  isCheckinDue,
};
