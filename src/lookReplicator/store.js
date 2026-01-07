const { randomUUID } = require('crypto');
const { query } = require('../db');
const { runMigrations } = require('../db/migrate');
const { hashPassword, verifyPassword } = require('./passwords');

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
  try {
    await runMigrations();
    dbReady = true;
    return true;
  } catch (err) {
    // If migrations fail in production (permissions, transient DB issues), fall back to in-memory storage
    // rather than taking down endpoints with 500s. We keep retry eligibility by clearing dbAttempted.
    dbAttempted = false;
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeRow(row) {
  return {
    jobId: row.job_id,
    userId: row.user_id || undefined,
    status: row.status,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    referenceImageUrl: row.reference_image_url || undefined,
    selfieImageUrl: row.selfie_image_url || undefined,
    tryOnImageUrl: row.tryon_image_url || undefined,
    undertone: row.undertone || undefined,
    result: row.result_json || undefined,
    error: row.error_message || undefined,
    market: row.market,
    locale: row.locale,
    shareId: row.share_id || row.job_id,
  };
}

async function createJob({ market, locale, referenceImageUrl, selfieImageUrl, undertone, userId }) {
  const jobId = randomUUID();
  const now = nowIso();
  const baseJob = {
    jobId,
    userId: userId || undefined,
    status: 'pending',
    progress: 0,
    createdAt: now,
    updatedAt: now,
    referenceImageUrl,
    selfieImageUrl,
    tryOnImageUrl: undefined,
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
      job_id, share_id, user_id, status, progress, market, locale,
      reference_image_url, selfie_image_url, undertone,
      tryon_image_url,
      result_json, error_code, error_message,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10,
      $11,
      $12, $13, $14,
      $15, $16
    )
  `,
    [
      jobId,
      jobId,
      userId || null,
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
  if (!res.rows || res.rows.length === 0) return mem.get(jobId) || null;
  return normalizeRow(res.rows[0]);
}

async function getShare(shareId) {
  const okDb = await ensureDbReady();
  if (!okDb) return mem.get(shareId) || null;

  const res = await query('SELECT * FROM look_replicator_jobs WHERE share_id = $1', [shareId]);
  if (!res.rows || res.rows.length === 0) return mem.get(shareId) || null;
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

  // If this job was created while DB was unavailable, it may only exist in memory.
  // Avoid "flapping" from mem -> db causing 404s mid-run by ensuring DB is populated when possible.
  const existingMem = mem.get(jobId);
  if (existingMem) {
    const merged = { ...existingMem, ...patch, updatedAt: now };
    mem.set(jobId, merged);
    if (patch.shareId && patch.shareId !== jobId) {
      mem.set(patch.shareId, merged);
    }
  }

  const existing = existingMem || (await getJob(jobId));

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
  if (patch.userId !== undefined) setField('user_id', patch.userId);
  if (patch.referenceImageUrl !== undefined) setField('reference_image_url', patch.referenceImageUrl);
  if (patch.selfieImageUrl !== undefined) setField('selfie_image_url', patch.selfieImageUrl);
  if (patch.tryOnImageUrl !== undefined) setField('tryon_image_url', patch.tryOnImageUrl);
  if (patch.undertone !== undefined) setField('undertone', patch.undertone);

  setField('updated_at', now);
  values.push(jobId);

  const updateRes = await query(`UPDATE look_replicator_jobs SET ${fields.join(', ')} WHERE job_id = $${i}`, values);

  if (updateRes?.rowCount === 0 && existing) {
    // Insert the job first, then retry the update to persist progress/result.
    try {
      await query(
        `
        INSERT INTO look_replicator_jobs (
          job_id, share_id, status, progress, market, locale,
          reference_image_url, selfie_image_url, undertone,
          tryon_image_url,
          result_json, error_code, error_message,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9,
          $10,
          $11, $12, $13,
          $14, $15
        )
        ON CONFLICT (job_id) DO NOTHING
        `,
        [
          jobId,
          existing.shareId || jobId,
          existing.status || 'pending',
          typeof existing.progress === 'number' ? existing.progress : null,
          existing.market,
          existing.locale,
          existing.referenceImageUrl || null,
          existing.selfieImageUrl || null,
          existing.undertone || null,
          existing.tryOnImageUrl || null,
          existing.result || null,
          null,
          existing.error || null,
          existing.createdAt || now,
          now,
        ],
      );
      await query(`UPDATE look_replicator_jobs SET ${fields.join(', ')} WHERE job_id = $${i}`, values);
    } catch {
      // ignore (fail-closed to existing behavior)
    }
  }
  return getJob(jobId);
}

function uniqueJobsFromMem() {
  const unique = new Map();
  for (const job of mem.values()) {
    if (!job || !job.jobId) continue;
    unique.set(job.jobId, job);
  }
  return Array.from(unique.values());
}

async function listJobs({ limit = 20, before, market, locale, userId } = {}) {
  const okDb = await ensureDbReady();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
  const userIdUuid = userId ? String(userId).trim() : null;

  if (!okDb) {
    let items = uniqueJobsFromMem();
    if (userIdUuid) items = items.filter((j) => j.userId === userIdUuid);
    if (market) items = items.filter((j) => j.market === market);
    if (locale) items = items.filter((j) => j.locale === locale);
    if (before) items = items.filter((j) => j.createdAt < before);
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return items.slice(0, safeLimit);
  }

  const res = await query(
    `
    SELECT * FROM look_replicator_jobs
    WHERE ($1::timestamptz IS NULL OR created_at < $1)
      AND ($2::text IS NULL OR market = $2)
      AND ($3::text IS NULL OR locale = $3)
      AND ($4::uuid IS NULL OR user_id = $4)
    ORDER BY created_at DESC
    LIMIT $5
    `,
    [before || null, market || null, locale || null, userIdUuid || null, safeLimit],
  );

  return (res.rows || []).map(normalizeRow);
}

module.exports = {
  createJob,
  getJob,
  getShare,
  updateJob,
  listJobs,
  createUser: async ({ email, password }) => {
    const okDb = await ensureDbReady();
    if (!okDb) throw new Error('DB_NOT_AVAILABLE');

    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) throw new Error('EMAIL_REQUIRED');
    const pwd = String(password || '');
    if (!pwd) throw new Error('PASSWORD_REQUIRED');

    const passwordHash = await hashPassword(pwd);
    const userId = randomUUID();
    const now = nowIso();

    try {
      await query(
        `
        INSERT INTO look_replicator_users (user_id, email, password_hash, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [userId, normalizedEmail, passwordHash, now, now],
      );
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.toLowerCase().includes('duplicate') || msg.toLowerCase().includes('unique')) {
        const e = new Error('USER_EXISTS');
        e.code = 'USER_EXISTS';
        throw e;
      }
      throw err;
    }

    return { userId, email: normalizedEmail };
  },
  verifyUserCredentials: async ({ email, password }) => {
    const okDb = await ensureDbReady();
    if (!okDb) throw new Error('DB_NOT_AVAILABLE');

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const pwd = String(password || '');
    if (!normalizedEmail || !pwd) return null;

    const res = await query('SELECT user_id, email, password_hash FROM look_replicator_users WHERE email = $1', [
      normalizedEmail,
    ]);
    const row = res?.rows?.[0];
    if (!row) return null;
    const ok = await verifyPassword(pwd, row.password_hash);
    if (!ok) return null;
    return { userId: row.user_id, email: String(row.email || '').toLowerCase() };
  },
};
