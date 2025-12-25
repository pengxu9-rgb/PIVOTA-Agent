const { randomUUID } = require('crypto');
const { query } = require('../../db');
const { runMigrations } = require('../../db/migrate');

let dbReady = false;
let dbAttempted = false;

const mem = [];

function hasDb() {
  return Boolean(process.env.DATABASE_URL);
}

async function ensureDbReady() {
  if (!hasDb()) return false;
  if (dbReady) return true;
  if (dbAttempted) return false;
  dbAttempted = true;
  if (process.env.SKIP_DB_MIGRATIONS === 'true') {
    dbReady = true;
    return true;
  }
  await runMigrations();
  dbReady = true;
  return true;
}

function nowIso() {
  return new Date().toISOString();
}

async function recordCompatibilitySampleUS(sample) {
  const okDb = await ensureDbReady();
  const createdAt = nowIso();

  if (!okDb) {
    mem.push({ ...sample, createdAt });
    return { sink: 'memory' };
  }

  const idFaceRef = randomUUID();
  const idFaceUser = sample.userFaceProfile ? randomUUID() : null;
  const idReport = randomUUID();

  await query('BEGIN');
  try {
    await query(
      `
      INSERT INTO layer1_face_profile_samples_us (
        id, session_id, source, market, locale, created_at, face_profile_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
      [idFaceRef, sample.sessionId, 'reference', 'US', sample.locale, createdAt, sample.refFaceProfile],
    );

    if (sample.userFaceProfile) {
      await query(
        `
        INSERT INTO layer1_face_profile_samples_us (
          id, session_id, source, market, locale, created_at, face_profile_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
        [idFaceUser, sample.sessionId, 'selfie', 'US', sample.locale, createdAt, sample.userFaceProfile],
      );
    }

    await query(
      `
      INSERT INTO layer1_similarity_report_samples_us (
        id, session_id, market, locale, preference_mode, created_at,
        ref_face_profile_sample_id, user_face_profile_sample_id,
        similarity_report_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
      [
        idReport,
        sample.sessionId,
        'US',
        sample.locale,
        sample.preferenceMode,
        createdAt,
        idFaceRef,
        idFaceUser,
        sample.similarityReport,
      ],
    );

    await query('COMMIT');
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }

  return { sink: 'db' };
}

module.exports = {
  recordCompatibilitySampleUS,
};

