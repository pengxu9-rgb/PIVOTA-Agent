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

async function recordLayer1BundleSampleUS(sample) {
  const okDb = await ensureDbReady();
  const createdAt = nowIso();

  if (!okDb) {
    mem.push({ ...sample, createdAt });
    return { sink: 'memory' };
  }

  const id = randomUUID();
  await query(
    `
    INSERT INTO layer1_bundle_samples_us (
      id, session_id, market, locale, preference_mode, created_at, bundle_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
  `,
    [id, sample.sessionId, 'US', sample.locale, sample.preferenceMode, createdAt, sample.bundle],
  );

  return { sink: 'db' };
}

module.exports = {
  recordLayer1BundleSampleUS,
};

