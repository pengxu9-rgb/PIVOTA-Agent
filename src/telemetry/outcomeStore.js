const crypto = require('crypto');

const { query } = require('../db');
const { runMigrations } = require('../db/migrate');
const { OutcomeSampleV0Schema } = require('./schemas/outcomeSampleV0');

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
  } catch {
    dbAttempted = false;
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeMarket(v) {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'JP') return 'JP';
  return 'US';
}

function tableForMarket(market) {
  return market === 'JP' ? 'outcome_samples_jp' : 'outcome_samples_us';
}

function hashSessionId(sessionId) {
  const raw = String(sessionId || '').trim();
  if (!raw) return null;
  const salt = String(process.env.TELEMETRY_SESSION_SALT || '').trim();
  if (!salt) return null;
  const h = crypto.createHmac('sha256', salt);
  h.update(raw);
  return h.digest('hex');
}

function shouldStoreSessionHash(event) {
  const envAllow = String(process.env.TELEMETRY_STORE_SESSION_HASH || '').trim() === 'true';
  if (envAllow) return true;
  const optIn = Boolean(event?.payload && event.payload.optIn === true);
  return optIn;
}

function clampRating(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < 1 || i > 5) return null;
  return i;
}

function normalizeIssueTags(tags) {
  const allowed = new Set(['base', 'eye', 'lip', 'other']);
  const out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const s = String(t || '').trim().toLowerCase();
    if (allowed.has(s) && !out.includes(s)) out.push(s);
  }
  return out.length ? out : null;
}

function baseSample({ market, jobId, locale, preferenceMode, createdAt }) {
  return OutcomeSampleV0Schema.parse({
    schemaVersion: 'v0',
    market: normalizeMarket(market),
    jobId,
    locale: locale || 'en',
    preferenceMode: preferenceMode || 'structure',
    createdAt: createdAt || nowIso(),
    engineVersions: { layer2: 'unknown', layer3: 'unknown' },
    signals: {},
    qualityFlags: {
      lookSpecLowConfidence: false,
      anyAdjustmentLowConfidence: false,
      anyFallbackUsed: false,
    },
    usedTechniques: [],
    usedRules: [],
    contextFingerprint: {},
  });
}

function mergeSignalsFromEvent(sample, event) {
  const merged = { ...sample, signals: { ...(sample.signals || {}) } };
  const payload = event.payload || {};

  if (event.eventType === 'rating') {
    const rating = clampRating(payload.rating);
    if (rating != null) merged.signals.rating = rating;
  } else if (event.eventType === 'issue_tags') {
    const tags = normalizeIssueTags(payload.issueTags || payload.tags);
    if (tags) merged.signals.issueTags = tags;
  } else if (event.eventType === 'share') {
    merged.signals.shared = true;
  } else if (event.eventType === 'add_to_cart') {
    merged.signals.addToCart = true;
  } else if (event.eventType === 'checkout_start') {
    merged.signals.checkoutStarted = true;
  } else if (event.eventType === 'checkout_success') {
    merged.signals.checkoutSuccess = true;
  }

  return merged;
}

function mergeSessionHash(sample, event) {
  if (!event.sessionId) return sample;
  if (!shouldStoreSessionHash(event)) return sample;
  const h = hashSessionId(event.sessionId);
  if (!h) return sample;
  return { ...sample, sessionIdHash: h };
}

function mergeCreatedAt(sample, event) {
  const ts = String(event.createdAt || '').trim();
  if (!ts) return sample;
  const prev = Date.parse(sample.createdAt);
  const next = Date.parse(ts);
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return sample;
  if (next < prev) return { ...sample, createdAt: ts };
  return sample;
}

function upsertSqlParams(sample) {
  const rating = typeof sample.signals?.rating === 'number' ? sample.signals.rating : null;
  return [sample.jobId, sample.market, sample.locale, sample.preferenceMode, sample, rating];
}

async function upsertOutcomeSample(sample) {
  const okDb = await ensureDbReady();
  if (!okDb) {
    mem.set(sample.jobId, sample);
    return sample;
  }

  const table = tableForMarket(sample.market);
  await query(
    `
    INSERT INTO ${table} (
      job_id, market, locale, preference_mode,
      sample_json, rating,
      updated_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6,
      now()
    )
    ON CONFLICT (job_id) DO UPDATE SET
      locale = EXCLUDED.locale,
      preference_mode = EXCLUDED.preference_mode,
      sample_json = EXCLUDED.sample_json,
      rating = EXCLUDED.rating,
      updated_at = now()
  `,
    upsertSqlParams(sample),
  );

  return sample;
}

async function getOutcomeSample({ market, jobId }) {
  const okDb = await ensureDbReady();
  if (!okDb) return mem.get(jobId) || null;
  const table = tableForMarket(normalizeMarket(market));
  const res = await query(`SELECT sample_json FROM ${table} WHERE job_id = $1`, [jobId]);
  const row = res.rows?.[0];
  if (!row) return null;
  return OutcomeSampleV0Schema.parse(row.sample_json);
}

async function ingestOutcomeEventV0(event) {
  const jobId = String(event.jobId || '').trim();
  if (!jobId) throw new Error('jobId required');
  const market = normalizeMarket(event.market);

  const existing =
    (await getOutcomeSample({ market, jobId })) || baseSample({ market, jobId, locale: 'en', preferenceMode: 'structure' });
  const withCreatedAt = mergeCreatedAt(existing, event);
  const withSignals = mergeSignalsFromEvent(withCreatedAt, event);
  const withSession = mergeSessionHash(withSignals, event);

  const validated = OutcomeSampleV0Schema.parse(withSession);
  return upsertOutcomeSample(validated);
}

async function upsertOutcomeSampleFromJobCompletion(samplePatch) {
  const jobId = String(samplePatch.jobId || '').trim();
  if (!jobId) throw new Error('jobId required');
  const market = normalizeMarket(samplePatch.market);
  const existing =
    (await getOutcomeSample({ market, jobId })) ||
    baseSample({
      market,
      jobId,
      locale: samplePatch.locale || 'en',
      preferenceMode: samplePatch.preferenceMode || 'structure',
      createdAt: samplePatch.createdAt || nowIso(),
    });

  const merged = OutcomeSampleV0Schema.parse({
    ...existing,
    ...samplePatch,
    jobId,
    market,
    ...(samplePatch.sessionIdHash ? { sessionIdHash: samplePatch.sessionIdHash } : {}),
  });

  return upsertOutcomeSample(merged);
}

async function listOutcomeSamples({ market, limit = 1000 } = {}) {
  const okDb = await ensureDbReady();
  if (!okDb) return Array.from(mem.values()).slice(0, limit);
  const table = tableForMarket(normalizeMarket(market));
  const res = await query(
    `SELECT sample_json FROM ${table} ORDER BY created_at DESC LIMIT $1`,
    [Math.max(0, Math.min(Number(limit) || 1000, 50000))],
  );
  return (res.rows || []).map((r) => OutcomeSampleV0Schema.parse(r.sample_json));
}

module.exports = {
  ingestOutcomeEventV0,
  upsertOutcomeSampleFromJobCompletion,
  getOutcomeSample,
  listOutcomeSamples,
  // Backward compatible exports
  listOutcomeSamplesUS: (opts) => listOutcomeSamples({ market: 'US', ...(opts || {}) }),
  listOutcomeSamplesJP: (opts) => listOutcomeSamples({ market: 'JP', ...(opts || {}) }),
  hashSessionId,
  ensureDbReady,
};
