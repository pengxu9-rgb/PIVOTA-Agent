const { randomUUID } = require('crypto');
const { query } = require('../db');
const { runMigrations } = require('../db/migrate');

let dbReady = false;
let dbAttempted = false;

const mem = new Map();

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

function normalizeRow(row) {
  return {
    jobId: row.job_id,
    status: row.status,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    referenceImageUrl: row.reference_image_url || undefined,
    selfieImageUrl: row.selfie_image_url || undefined,
    undertone: row.undertone || undefined,
    result: row.result_json || undefined,
    error: row.error_message || undefined,
    market: row.market,
    locale: row.locale,
    shareId: row.share_id || row.job_id,
  };
}

async function createJob({ market, locale, referenceImageUrl, selfieImageUrl, undertone }) {
  const jobId = randomUUID();
  const now = nowIso();
  const baseJob = {
    jobId,
    status: 'pending',
    progress: 0,
    createdAt: now,
    updatedAt: now,
    referenceImageUrl,
    selfieImageUrl,
    undertone,
    result: undefined,
    error: undefined,
    market,
    locale,
    shareId: jobId,
  };

  const okDb = await ensureDbReady();
  if (!okDb) {
    mem.set(jobId, baseJob);
    return baseJob;
  }

  await query(
    `
    INSERT INTO look_replicator_jobs (
      job_id, share_id, status, progress, market, locale,
      reference_image_url, selfie_image_url, undertone,
      result_json, error_code, error_message,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9,
      $10, $11, $12,
      $13, $14
    )
  `,
    [
      jobId,
      jobId,
      'pending',
      0,
      market,
      locale,
      referenceImageUrl || null,
      selfieImageUrl || null,
      undertone || null,
      null,
      null,
      null,
      now,
      now,
    ],
  );

  return baseJob;
}

async function getJob(jobId) {
  const okDb = await ensureDbReady();
  if (!okDb) return mem.get(jobId) || null;

  const res = await query('SELECT * FROM look_replicator_jobs WHERE job_id = $1', [jobId]);
  if (!res.rows || res.rows.length === 0) return null;
  return normalizeRow(res.rows[0]);
}

async function getShare(shareId) {
  const okDb = await ensureDbReady();
  if (!okDb) return mem.get(shareId) || null;

  const res = await query('SELECT * FROM look_replicator_jobs WHERE share_id = $1', [shareId]);
  if (!res.rows || res.rows.length === 0) return null;
  return normalizeRow(res.rows[0]);
}

async function updateJob(jobId, patch) {
  const okDb = await ensureDbReady();
  const now = nowIso();
  if (!okDb) {
    const existing = mem.get(jobId);
    if (!existing) return null;
    const merged = { ...existing, ...patch, updatedAt: now };
    mem.set(jobId, merged);
    if (patch.shareId && patch.shareId !== jobId) {
      mem.set(patch.shareId, merged);
    }
    return merged;
  }

  const fields = [];
  const values = [];
  let i = 1;

  function setField(col, val) {
    fields.push(`${col} = $${i}`);
    values.push(val);
    i += 1;
  }

  if (patch.status !== undefined) setField('status', patch.status);
  if (patch.progress !== undefined) setField('progress', patch.progress);
  if (patch.result !== undefined) setField('result_json', patch.result);
  if (patch.error !== undefined) setField('error_message', patch.error);
  if (patch.shareId !== undefined) setField('share_id', patch.shareId);

  setField('updated_at', now);
  values.push(jobId);

  await query(`UPDATE look_replicator_jobs SET ${fields.join(', ')} WHERE job_id = $${i}`, values);
  return getJob(jobId);
}

module.exports = {
  createJob,
  getJob,
  getShare,
  updateJob,
};
