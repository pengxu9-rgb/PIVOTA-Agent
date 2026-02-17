const { query } = require('../db');

const MAX_IN_MEMORY_ENTRIES = (() => {
  const n = Number(process.env.AURORA_PRODUCT_INTEL_KB_MAX_MEM_ENTRIES || 600);
  const v = Number.isFinite(n) ? Math.trunc(n) : 600;
  return Math.max(80, Math.min(6000, v));
})();

const state = {
  memIndex: new Map(),
  dbUnavailable: false,
};

function normalizeKey(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (s.length > 512) return s.slice(0, 512);
  return s;
}

function touchLru(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_IN_MEMORY_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) break;
    map.delete(oldestKey);
  }
}

function coerceJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeJsonbParam(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
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

function mapRowToEntry(row) {
  if (!row) return null;
  const kbKey = normalizeKey(row.kb_key);
  if (!kbKey) return null;

  return {
    kb_key: kbKey,
    analysis:
      row.analysis && typeof row.analysis === 'object' && !Array.isArray(row.analysis)
        ? row.analysis
        : coerceJson(row.analysis) || null,
    source: row.source ? String(row.source) : null,
    source_meta:
      row.source_meta && typeof row.source_meta === 'object' && !Array.isArray(row.source_meta)
        ? row.source_meta
        : coerceJson(row.source_meta),
    last_success_at: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
    last_error:
      row.last_error && typeof row.last_error === 'object' && !Array.isArray(row.last_error)
        ? row.last_error
        : coerceJson(row.last_error),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function readFromDb(kbKey) {
  if (state.dbUnavailable) return null;
  try {
    const res = await query(
      `
        SELECT kb_key, analysis, source, source_meta, last_success_at, last_error, created_at, updated_at
        FROM aurora_product_intel_kb
        WHERE kb_key = $1
        LIMIT 1
      `,
      [kbKey],
    );
    const row = res && Array.isArray(res.rows) ? res.rows[0] : null;
    return mapRowToEntry(row);
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    if (code === 'NO_DATABASE' || code === '42P01') {
      state.dbUnavailable = true;
      return null;
    }
    return null;
  }
}

async function upsertToDb(entry) {
  if (state.dbUnavailable) return;
  const kbKey = normalizeKey(entry && entry.kb_key);
  if (!kbKey) return;

  const analysis = normalizeJsonbParam(entry.analysis || null);
  const sourceMeta = normalizeJsonbParam(entry.source_meta || null);
  const lastError = normalizeJsonbParam(entry.last_error || null);
  const source = entry.source ? String(entry.source) : null;
  const lastSuccessAt = entry.last_success_at ? new Date(entry.last_success_at).toISOString() : null;

  try {
    await query(
      `
        INSERT INTO aurora_product_intel_kb (
          kb_key,
          analysis,
          source,
          source_meta,
          last_success_at,
          last_error,
          updated_at
        )
        VALUES ($1, $2::jsonb, $3, $4::jsonb, $5::timestamptz, $6::jsonb, now())
        ON CONFLICT (kb_key) DO UPDATE SET
          analysis = EXCLUDED.analysis,
          source = EXCLUDED.source,
          source_meta = EXCLUDED.source_meta,
          last_success_at = EXCLUDED.last_success_at,
          last_error = EXCLUDED.last_error,
          updated_at = now()
      `,
      [kbKey, analysis, source, sourceMeta, lastSuccessAt, lastError],
    );
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    if (code === 'NO_DATABASE' || code === '42P01') state.dbUnavailable = true;
  }
}

async function getProductIntelKbEntry(kbKey) {
  const key = normalizeKey(kbKey);
  if (!key) return null;

  const memHit = state.memIndex.get(key);
  if (memHit) return memHit;

  const dbHit = await readFromDb(key);
  if (dbHit) {
    touchLru(state.memIndex, key, dbHit);
    return dbHit;
  }

  return null;
}

async function upsertProductIntelKbEntry(entry) {
  const kbKey = normalizeKey(entry && entry.kb_key);
  if (!kbKey) return;

  const normalized = {
    kb_key: kbKey,
    analysis: entry.analysis && typeof entry.analysis === 'object' && !Array.isArray(entry.analysis) ? entry.analysis : null,
    source: entry.source || null,
    source_meta: entry.source_meta || null,
    last_success_at: entry.last_success_at || null,
    last_error: entry.last_error || null,
  };

  touchLru(state.memIndex, kbKey, normalized);
  await upsertToDb(normalized);
}

module.exports = {
  normalizeKey,
  getProductIntelKbEntry,
  upsertProductIntelKbEntry,
};
