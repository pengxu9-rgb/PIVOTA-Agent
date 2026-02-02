const { query } = require('../db');

function normalizeAuroraUid(auroraUid) {
  const uid = String(auroraUid || '').trim();
  if (!uid) return null;
  if (uid.length > 128) return uid.slice(0, 128);
  return uid;
}

function isoDateUTC(d = new Date()) {
  return d.toISOString().slice(0, 10);
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

function mapProfileToDb(profilePatch) {
  const p = profilePatch || {};
  return {
    skin_type: p.skinType,
    sensitivity: p.sensitivity,
    barrier_status: p.barrierStatus,
    goals: Array.isArray(p.goals) ? p.goals : undefined,
    region: p.region,
    budget_tier: p.budgetTier,
    current_routine: p.currentRoutine,
    contraindications: Array.isArray(p.contraindications) ? p.contraindications : undefined,
    lang_pref: p.lang_pref,
  };
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
    contraindications: Array.isArray(row.contraindications)
      ? row.contraindications
      : row.contraindications
        ? row.contraindications
        : [],
    lang_pref: row.lang_pref || null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

async function getUserProfile(auroraUid) {
  const uid = normalizeAuroraUid(auroraUid);
  if (!uid) return null;
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

async function upsertUserProfile(auroraUid, profilePatch) {
  const uid = normalizeAuroraUid(auroraUid);
  if (!uid) return null;

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
        contraindications,
        lang_pref,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
      ON CONFLICT (aurora_uid) DO UPDATE SET
        skin_type = EXCLUDED.skin_type,
        sensitivity = EXCLUDED.sensitivity,
        barrier_status = EXCLUDED.barrier_status,
        goals = EXCLUDED.goals,
        region = EXCLUDED.region,
        budget_tier = EXCLUDED.budget_tier,
        current_routine = EXCLUDED.current_routine,
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
      merged.goals ?? null,
      merged.region ?? null,
      merged.budget_tier ?? null,
      merged.current_routine ?? null,
      merged.contraindications ?? null,
      merged.lang_pref ?? null,
    ],
  );

  return getUserProfile(uid);
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

async function upsertSkinLog(auroraUid, log) {
  const uid = normalizeAuroraUid(auroraUid);
  if (!uid) return null;
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

async function getRecentSkinLogs(auroraUid, days = 7) {
  const uid = normalizeAuroraUid(auroraUid);
  if (!uid) return [];
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

function isCheckinDue(recentLogs) {
  if (!Array.isArray(recentLogs) || recentLogs.length === 0) return true;
  const latest = recentLogs[0];
  if (!latest || !latest.date) return true;
  const today = isoDateUTC();
  return latest.date !== today;
}

module.exports = {
  isoDateUTC,
  normalizeAuroraUid,
  getUserProfile,
  upsertUserProfile,
  upsertSkinLog,
  getRecentSkinLogs,
  isCheckinDue,
};

