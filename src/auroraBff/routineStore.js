const crypto = require('crypto');
const { query } = require('../db');

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeJsonbParam(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function getLatestRoutineVersion(routineId) {
  const result = await query(
    `SELECT * FROM aurora_routine_versions
     WHERE routine_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [routineId],
  );
  return result.rows[0] || null;
}

async function getRoutineVersionHistory(routineId, limit = 10) {
  const result = await query(
    `SELECT routine_id, version_id, label, intensity, status, areas, created_at
     FROM aurora_routine_versions
     WHERE routine_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [routineId, limit],
  );
  return result.rows;
}

async function getActiveRoutineForIdentity({ auroraUid, userId }) {
  const profileResult = userId
    ? await query('SELECT active_routine_id FROM aurora_account_profiles WHERE user_id = $1', [userId])
    : await query('SELECT active_routine_id FROM aurora_user_profiles WHERE aurora_uid = $1', [auroraUid]);

  const row = profileResult.rows[0];
  if (!row || !row.active_routine_id) return null;

  const routine = await getLatestRoutineVersion(row.active_routine_id);
  if (!routine) return null;

  const history = await getRoutineVersionHistory(row.active_routine_id, 10);
  return { ...routine, version_history: history };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

async function saveRoutineVersion({ auroraUid, userId, routineId, label, intensity, status, amSteps, pmSteps, areas, audit }) {
  const rid = routineId || uuid();
  const vid = uuid();

  await query(
    `INSERT INTO aurora_routine_versions
       (routine_id, version_id, aurora_uid, user_id, label, intensity, status, am_steps, pm_steps, areas, audit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      rid,
      vid,
      auroraUid || null,
      userId || null,
      label || 'My Routine',
      intensity || 'balanced',
      status || 'active',
      normalizeJsonbParam(amSteps || []),
      normalizeJsonbParam(pmSteps || []),
      normalizeJsonbParam(areas || ['face']),
      normalizeJsonbParam(audit || null),
    ],
  );

  const table = userId ? 'aurora_account_profiles' : 'aurora_user_profiles';
  const idCol = userId ? 'user_id' : 'aurora_uid';
  const idVal = userId || auroraUid;
  await query(
    `UPDATE ${table} SET active_routine_id = $1, current_routine = $2, updated_at = now() WHERE ${idCol} = $3`,
    [rid, normalizeJsonbParam({ am: amSteps, pm: pmSteps }), idVal],
  );

  return { routine_id: rid, version_id: vid };
}

async function updateRoutineSteps({ routineId, auroraUid, userId, amSteps, pmSteps, audit }) {
  const current = await getLatestRoutineVersion(routineId);
  if (!current) {
    const err = new Error('Routine not found');
    err.status = 404;
    throw err;
  }
  const nextAudit = audit !== undefined ? audit : current.audit;
  return saveRoutineVersion({
    auroraUid: auroraUid || current.aurora_uid,
    userId: userId || current.user_id,
    routineId,
    label: current.label,
    intensity: current.intensity,
    status: current.status,
    amSteps: amSteps !== undefined ? amSteps : current.am_steps,
    pmSteps: pmSteps !== undefined ? pmSteps : current.pm_steps,
    areas: current.areas,
    audit: nextAudit,
  });
}

module.exports = {
  getLatestRoutineVersion,
  getRoutineVersionHistory,
  getActiveRoutineForIdentity,
  saveRoutineVersion,
  updateRoutineSteps,
};
