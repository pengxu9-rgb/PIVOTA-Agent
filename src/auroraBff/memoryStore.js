const { query } = require('../db');

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
  identityLinks: new Map(),
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
  const currentRoutine = p.currentRoutine;
  const itinerary = p.itinerary;

  return {
    skin_type: p.skinType,
    sensitivity: p.sensitivity,
    barrier_status: p.barrierStatus,
    goals: goals ? JSON.stringify(goals) : undefined,
    region: p.region,
    budget_tier: p.budgetTier,
    current_routine: currentRoutine !== undefined ? JSON.stringify(currentRoutine) : undefined,
    itinerary: itinerary !== undefined ? JSON.stringify(itinerary) : undefined,
    contraindications: contraindications ? JSON.stringify(contraindications) : undefined,
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

function mapProfileFromDb(row) {
  if (!row) return null;
  return {
    aurora_uid: row.aurora_uid,
    skinType: row.skin_type || null,
    sensitivity: row.sensitivity || null,
    barrierStatus: row.barrier_status || null,
    goals: Array.isArray(row.goals) ? row.goals : row.goals ? row.goals : [],
    region: row.region || null,
    budgetTier: row.budget_tier || null,
    currentRoutine: row.current_routine || null,
    itinerary: row.itinerary || null,
    contraindications: Array.isArray(row.contraindications)
      ? row.contraindications
      : row.contraindications
        ? row.contraindications
        : [],
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
  return {
    user_id: row.user_id,
    skinType: row.skin_type || null,
    sensitivity: row.sensitivity || null,
    barrierStatus: row.barrier_status || null,
    goals: Array.isArray(row.goals) ? row.goals : row.goals ? row.goals : [],
    region: row.region || null,
    budgetTier: row.budget_tier || null,
    currentRoutine: row.current_routine || null,
    itinerary: row.itinerary || null,
    contraindications: Array.isArray(row.contraindications)
      ? row.contraindications
      : row.contraindications
        ? row.contraindications
        : [],
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
          contraindications: [],
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
          contraindications: [],
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
    ...(p.contraindications !== undefined ? { contraindications: Array.isArray(p.contraindications) ? p.contraindications : [] } : {}),
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
  if (persistenceDisabled()) return upsertEphemeralProfile({ kind: 'guest', id: uid }, profilePatch);

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
  const patchDb = mapProfileToDb(profilePatch);

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
        contraindications,
        lang_pref,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
      ON CONFLICT (aurora_uid) DO UPDATE SET
        skin_type = EXCLUDED.skin_type,
        sensitivity = EXCLUDED.sensitivity,
        barrier_status = EXCLUDED.barrier_status,
        goals = EXCLUDED.goals,
        region = EXCLUDED.region,
        budget_tier = EXCLUDED.budget_tier,
        current_routine = EXCLUDED.current_routine,
        itinerary = EXCLUDED.itinerary,
        contraindications = EXCLUDED.contraindications,
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
      normalizeJsonbParam(merged.contraindications ?? null),
      merged.lang_pref ?? null,
    ],
  );

  return getUserProfile(uid);
}

async function upsertAccountProfile(userId, profilePatch) {
  const uid = normalizeUserId(userId);
  if (!uid) return null;
  if (persistenceDisabled()) return upsertEphemeralProfile({ kind: 'account', id: uid }, profilePatch);

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
  const patchDb = mapProfileToDb(profilePatch);

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
        contraindications,
        lang_pref,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
      ON CONFLICT (user_id) DO UPDATE SET
        skin_type = EXCLUDED.skin_type,
        sensitivity = EXCLUDED.sensitivity,
        barrier_status = EXCLUDED.barrier_status,
        goals = EXCLUDED.goals,
        region = EXCLUDED.region,
        budget_tier = EXCLUDED.budget_tier,
        current_routine = EXCLUDED.current_routine,
        itinerary = EXCLUDED.itinerary,
        contraindications = EXCLUDED.contraindications,
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
      normalizeJsonbParam(merged.contraindications ?? null),
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

  const res = await query(
    `
      INSERT INTO aurora_skin_logs (
        aurora_uid, log_date, redness, acne, hydration, notes, target_product, sensation, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
      ON CONFLICT (aurora_uid, log_date) DO UPDATE SET
        redness = EXCLUDED.redness,
        acne = EXCLUDED.acne,
        hydration = EXCLUDED.hydration,
        notes = EXCLUDED.notes,
        target_product = EXCLUDED.target_product,
        sensation = EXCLUDED.sensation,
        updated_at = now()
      RETURNING *
    `,
    [uid, date, redness, acne, hydration, notes, targetProduct, sensation],
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

  const res = await query(
    `
      INSERT INTO aurora_account_skin_logs (
        user_id, log_date, redness, acne, hydration, notes, target_product, sensation, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
      ON CONFLICT (user_id, log_date) DO UPDATE SET
        redness = EXCLUDED.redness,
        acne = EXCLUDED.acne,
        hydration = EXCLUDED.hydration,
        notes = EXCLUDED.notes,
        target_product = EXCLUDED.target_product,
        sensation = EXCLUDED.sensation,
        updated_at = now()
      RETURNING *
    `,
    [uid, date, redness, acne, hydration, notes, targetProduct, sensation],
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
    if ((!accountProfile || !Array.isArray(accountProfile.contraindications) || accountProfile.contraindications.length === 0) && Array.isArray(guestProfile.contraindications) && guestProfile.contraindications.length) {
      patch.contraindications = guestProfile.contraindications;
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
      }
      ephemeral.identityLinks.delete(identity.aurora_uid);
    }

    return { ok: true, deleted: true, storage: 'ephemeral' };
  }

  if (identity.user_id) {
    // Hard-delete account profile and logs (ON DELETE CASCADE).
    await query(`DELETE FROM aurora_account_profiles WHERE user_id = $1`, [identity.user_id]);
    // Also delete any guest->account links for this account.
    await query(`DELETE FROM aurora_identity_links WHERE user_id = $1`, [identity.user_id]);
  }

  if (identity.aurora_uid) {
    // Hard-delete guest profile and logs (ON DELETE CASCADE).
    await query(`DELETE FROM aurora_user_profiles WHERE aurora_uid = $1`, [identity.aurora_uid]);
  }

  return { ok: true, deleted: true, storage: 'db' };
}

module.exports = {
  isoDateUTC,
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
  saveLastAnalysisForIdentity,
  deleteIdentityData,
  isCheckinDue,
};
