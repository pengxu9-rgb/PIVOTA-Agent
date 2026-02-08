const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../db');

const DEFAULT_KB_PATH = path.join(__dirname, '..', '..', 'data', 'dupe_kb.jsonl');

const MAX_IN_MEMORY_ENTRIES = (() => {
  const n = Number(process.env.AURORA_DUPE_KB_MAX_MEM_ENTRIES || 500);
  const v = Number.isFinite(n) ? Math.trunc(n) : 500;
  return Math.max(50, Math.min(5000, v));
})();

const state = {
  fileLoaded: false,
  fileIndex: new Map(),
  memIndex: new Map(),
  dbUnavailable: false,
};

function normalizeKey(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (s.length > 256) return s.slice(0, 256);
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

  // node-postgres serializes JS arrays as Postgres arrays; normalize JSONB params to JSON text.
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

function getKbPath() {
  const explicit = process.env.AURORA_DUPE_KB_PATH;
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  return DEFAULT_KB_PATH;
}

function loadFileIndexOnce() {
  if (state.fileLoaded) return;
  state.fileLoaded = true;

  const filePath = getKbPath();
  if (!fs.existsSync(filePath)) return;

  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  const lines = raw.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = String(lineRaw || '').trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    try {
      const obj = JSON.parse(line);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      const kbKey = normalizeKey(obj.kb_key || obj.kbKey || obj.key);
      if (!kbKey) continue;
      state.fileIndex.set(kbKey, obj);
    } catch {
      // ignore
    }
  }
}

function mapRowToEntry(row) {
  if (!row) return null;
  const kbKey = normalizeKey(row.kb_key);
  if (!kbKey) return null;

  return {
    kb_key: kbKey,
    original: row.original && typeof row.original === 'object' ? row.original : coerceJson(row.original),
    dupes: Array.isArray(row.dupes) ? row.dupes : coerceJson(row.dupes) || [],
    comparables: Array.isArray(row.comparables) ? row.comparables : coerceJson(row.comparables) || [],
    verified: row.verified === true,
    verified_at: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    verified_by: row.verified_by ? String(row.verified_by) : null,
    source: row.source ? String(row.source) : null,
    source_meta: row.source_meta && typeof row.source_meta === 'object' ? row.source_meta : coerceJson(row.source_meta),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function readFromDb(kbKey) {
  if (state.dbUnavailable) return null;
  try {
    const res = await query(
      `
        SELECT kb_key, original, dupes, comparables, verified, verified_at, verified_by, source, source_meta, created_at, updated_at
        FROM aurora_dupe_kb
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

  const original = normalizeJsonbParam(entry.original || null);
  const dupes = normalizeJsonbParam(Array.isArray(entry.dupes) ? entry.dupes : []);
  const comparables = normalizeJsonbParam(Array.isArray(entry.comparables) ? entry.comparables : []);
  const sourceMeta = normalizeJsonbParam(entry.source_meta || null);

  const verified = entry.verified === true;
  const verifiedAt = entry.verified_at ? new Date(entry.verified_at).toISOString() : verified ? new Date().toISOString() : null;
  const verifiedBy = entry.verified_by ? String(entry.verified_by) : null;
  const source = entry.source ? String(entry.source) : null;

  try {
    await query(
      `
        INSERT INTO aurora_dupe_kb (
          kb_key,
          original,
          dupes,
          comparables,
          verified,
          verified_at,
          verified_by,
          source,
          source_meta,
          updated_at
        )
        VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6::timestamptz, $7, $8, $9::jsonb, now())
        ON CONFLICT (kb_key) DO UPDATE SET
          original = EXCLUDED.original,
          dupes = EXCLUDED.dupes,
          comparables = EXCLUDED.comparables,
          verified = EXCLUDED.verified,
          verified_at = EXCLUDED.verified_at,
          verified_by = EXCLUDED.verified_by,
          source = EXCLUDED.source,
          source_meta = EXCLUDED.source_meta,
          updated_at = now()
      `,
      [kbKey, original, dupes, comparables, verified, verifiedAt, verifiedBy, source, sourceMeta],
    );
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    if (code === 'NO_DATABASE' || code === '42P01') state.dbUnavailable = true;
  }
}

async function getDupeKbEntry(kbKey) {
  const key = normalizeKey(kbKey);
  if (!key) return null;

  const memHit = state.memIndex.get(key);
  if (memHit) return memHit;

  const dbHit = await readFromDb(key);
  if (dbHit) {
    touchLru(state.memIndex, key, dbHit);
    return dbHit;
  }

  loadFileIndexOnce();
  const fileHit = state.fileIndex.get(key);
  if (fileHit) {
    touchLru(state.memIndex, key, fileHit);
    return fileHit;
  }

  return null;
}

async function upsertDupeKbEntry(entry) {
  const kbKey = normalizeKey(entry && entry.kb_key);
  if (!kbKey) return;

  const normalized = {
    kb_key: kbKey,
    original: entry.original ?? null,
    dupes: Array.isArray(entry.dupes) ? entry.dupes : [],
    comparables: Array.isArray(entry.comparables) ? entry.comparables : [],
    verified: entry.verified === true,
    verified_at: entry.verified_at || null,
    verified_by: entry.verified_by || null,
    source: entry.source || null,
    source_meta: entry.source_meta || null,
  };

  touchLru(state.memIndex, kbKey, normalized);
  await upsertToDb(normalized);
}

module.exports = {
  normalizeKey,
  getDupeKbEntry,
  upsertDupeKbEntry,
};

