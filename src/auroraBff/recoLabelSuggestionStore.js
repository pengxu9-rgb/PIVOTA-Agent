const crypto = require('crypto');
const { query } = require('../db');

const MAX_MEM_ENTRIES = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_PRELABEL_MEM_MAX || 4000);
  const v = Number.isFinite(n) ? Math.trunc(n) : 4000;
  return Math.max(100, Math.min(20000, v));
})();

const DB_RETRY_COOLDOWN_MS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_PRELABEL_DB_RETRY_COOLDOWN_MS || 15000);
  const v = Number.isFinite(n) ? Math.trunc(n) : 15000;
  return Math.max(1000, Math.min(300000, v));
})();

const RECO_LABEL_SUGGESTIONS_TABLE_SQL = [
  `
  CREATE TABLE IF NOT EXISTS reco_label_suggestions (
    id TEXT PRIMARY KEY,
    anchor_product_id TEXT NOT NULL,
    block TEXT NOT NULL,
    candidate_product_id TEXT NOT NULL,
    suggested_label TEXT NOT NULL,
    wrong_block_target TEXT NULL,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    rationale_user_visible TEXT NOT NULL DEFAULT '',
    flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    model_name TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    request_id TEXT NULL,
    session_id TEXT NULL,
    snapshot JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_reco_label_suggestions_anchor_block
    ON reco_label_suggestions(anchor_product_id, block)
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_reco_label_suggestions_candidate
    ON reco_label_suggestions(candidate_product_id)
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_reco_label_suggestions_confidence
    ON reco_label_suggestions(confidence DESC)
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_reco_label_suggestions_input_hash
    ON reco_label_suggestions(input_hash)
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_reco_label_suggestions_created_at
    ON reco_label_suggestions(created_at DESC)
  `,
  `
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_reco_label_suggestions_input_model_prompt_block
    ON reco_label_suggestions(input_hash, model_name, prompt_version, block)
  `,
];

const state = {
  dbUnavailable: false,
  dbUnavailableUntilMs: 0,
  tableReady: false,
  tableInitPromise: null,
  memById: new Map(),
  memByInput: new Map(),
};

function normalizeString(value, max = 512) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function stableJson(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return '{}';
  }
}

function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normalizeFlags(value) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const token = String(raw || '').trim().toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 16) break;
  }
  return out;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: normalizeString(row.id, 128),
    anchor_product_id: normalizeString(row.anchor_product_id, 200),
    block: normalizeString(row.block, 64),
    candidate_product_id: normalizeString(row.candidate_product_id, 200),
    suggested_label: normalizeString(row.suggested_label, 64),
    wrong_block_target: normalizeString(row.wrong_block_target, 64) || null,
    confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : 0,
    rationale_user_visible: normalizeString(row.rationale_user_visible, 400),
    flags: normalizeFlags(row.flags),
    model_name: normalizeString(row.model_name, 120),
    prompt_version: normalizeString(row.prompt_version, 120),
    input_hash: normalizeString(row.input_hash, 128),
    request_id: normalizeString(row.request_id, 200) || null,
    session_id: normalizeString(row.session_id, 200) || null,
    snapshot: row.snapshot && typeof row.snapshot === 'object' && !Array.isArray(row.snapshot) ? row.snapshot : null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function touchMem(entry) {
  if (!entry || !entry.id) return;
  state.memById.delete(entry.id);
  state.memById.set(entry.id, entry);
  if (entry.input_hash) {
    const key = `${entry.input_hash}::${entry.model_name}::${entry.prompt_version}::${entry.block}`.toLowerCase();
    state.memByInput.set(key, entry.id);
  }
  while (state.memById.size > MAX_MEM_ENTRIES) {
    const oldest = state.memById.keys().next().value;
    if (!oldest) break;
    const oldEntry = state.memById.get(oldest);
    state.memById.delete(oldest);
    if (oldEntry?.input_hash) {
      const oldKey = `${oldEntry.input_hash}::${oldEntry.model_name}::${oldEntry.prompt_version}::${oldEntry.block}`.toLowerCase();
      state.memByInput.delete(oldKey);
    }
  }
}

function inputLookupKey({ inputHash, modelName, promptVersion, block }) {
  return `${normalizeString(inputHash, 128)}::${normalizeString(modelName, 120)}::${normalizeString(promptVersion, 120)}::${normalizeString(block, 64)}`.toLowerCase();
}

function isMissingTableError(err) {
  return String(err?.code || '') === '42P01';
}

function markDbUnavailable(err) {
  const code = String(err?.code || '');
  if (code === 'NO_DATABASE' || code === '42P01') {
    state.dbUnavailable = true;
    state.dbUnavailableUntilMs = Date.now() + DB_RETRY_COOLDOWN_MS;
  }
}

function shouldUseDbNow() {
  if (!state.dbUnavailable) return true;
  if (Date.now() >= Number(state.dbUnavailableUntilMs || 0)) {
    state.dbUnavailable = false;
    state.dbUnavailableUntilMs = 0;
    return true;
  }
  return false;
}

async function ensureRecoLabelSuggestionsTable() {
  if (state.tableReady) return true;
  if (state.tableInitPromise) return state.tableInitPromise;
  state.tableInitPromise = (async () => {
    for (const stmt of RECO_LABEL_SUGGESTIONS_TABLE_SQL) {
      await query(stmt);
    }
    state.tableReady = true;
    return true;
  })()
    .catch((err) => {
      markDbUnavailable(err);
      return false;
    })
    .finally(() => {
      state.tableInitPromise = null;
    });
  return state.tableInitPromise;
}

function selectMemRows({ anchor = '', blockToken = '', confCap = null, wrongBlockOnly = false, max = 120 } = {}) {
  return Array.from(state.memById.values())
    .filter((row) => (anchor ? row.anchor_product_id === anchor : true))
    .filter((row) => (blockToken ? row.block === blockToken : true))
    .filter((row) => (confCap == null ? true : row.confidence <= confCap))
    .filter((row) => (wrongBlockOnly ? row.suggested_label === 'wrong_block' : true))
    .sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime())
    .slice(0, max);
}

function rowIdentity(row) {
  const id = normalizeString(row?.id, 128);
  if (id) return `id:${id}`;
  return [
    normalizeString(row?.anchor_product_id, 200),
    normalizeString(row?.block, 64),
    normalizeString(row?.candidate_product_id, 200),
    normalizeString(row?.input_hash, 128),
  ].join('::');
}

function mergeRows(primary = [], secondary = [], max = 120) {
  const seen = new Set();
  const out = [];
  for (const row of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    if (!row || typeof row !== 'object') continue;
    const key = rowIdentity(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  out.sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime());
  return out.slice(0, max);
}

function coerceSuggestion(entry = {}) {
  const nowIso = new Date().toISOString();
  const id = normalizeString(entry.id, 128) || crypto.randomUUID();
  const block = normalizeString(entry.block, 64);
  return {
    id,
    anchor_product_id: normalizeString(entry.anchor_product_id, 200),
    block,
    candidate_product_id: normalizeString(entry.candidate_product_id, 200),
    suggested_label: normalizeString(entry.suggested_label, 64) || 'not_relevant',
    wrong_block_target: normalizeString(entry.wrong_block_target, 64) || null,
    confidence: Number.isFinite(Number(entry.confidence)) ? Math.max(0, Math.min(1, Number(entry.confidence))) : 0,
    rationale_user_visible: normalizeString(entry.rationale_user_visible, 400),
    flags: normalizeFlags(entry.flags),
    model_name: normalizeString(entry.model_name, 120) || 'gemini',
    prompt_version: normalizeString(entry.prompt_version, 120) || 'prelabel_v1',
    input_hash: normalizeString(entry.input_hash, 128),
    request_id: normalizeString(entry.request_id, 200) || null,
    session_id: normalizeString(entry.session_id, 200) || null,
    snapshot: entry.snapshot && typeof entry.snapshot === 'object' && !Array.isArray(entry.snapshot) ? entry.snapshot : null,
    created_at: toIso(entry.created_at) || nowIso,
    updated_at: toIso(entry.updated_at) || nowIso,
  };
}

async function getSuggestionByInputHash({ inputHash, modelName, promptVersion, block, ttlMs } = {}) {
  const key = inputLookupKey({ inputHash, modelName, promptVersion, block });
  const memId = state.memByInput.get(key);
  if (memId && state.memById.has(memId)) {
    const memEntry = state.memById.get(memId);
    if (memEntry) {
      const updatedAtMs = new Date(memEntry.updated_at || 0).getTime();
      if (!ttlMs || (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs <= Number(ttlMs))) {
        return memEntry;
      }
    }
  }

  if (!shouldUseDbNow()) return null;
  const run = async () => {
    const ttl = Number.isFinite(Number(ttlMs)) ? Math.max(0, Math.trunc(Number(ttlMs))) : 0;
    return query(
      `
      SELECT id, anchor_product_id, block, candidate_product_id, suggested_label, wrong_block_target,
             confidence, rationale_user_visible, flags, model_name, prompt_version, input_hash,
             request_id, session_id, snapshot, created_at, updated_at
      FROM reco_label_suggestions
      WHERE input_hash = $1
        AND model_name = $2
        AND prompt_version = $3
        AND block = $4
        AND ($5::bigint <= 0 OR updated_at >= (now() - (($5::text || ' milliseconds')::interval)))
      ORDER BY updated_at DESC
      LIMIT 1
      `,
      [
        normalizeString(inputHash, 128),
        normalizeString(modelName, 120),
        normalizeString(promptVersion, 120),
        normalizeString(block, 64),
        ttl,
      ],
    );
  };
  try {
    const res = await run();
    const row = mapRow(res?.rows?.[0]);
    if (row) touchMem(row);
    state.dbUnavailable = false;
    state.dbUnavailableUntilMs = 0;
    return row || null;
  } catch (err) {
    if (isMissingTableError(err)) {
      const initialized = await ensureRecoLabelSuggestionsTable();
      if (initialized) {
        try {
          const retry = await run();
          const row = mapRow(retry?.rows?.[0]);
          if (row) touchMem(row);
          state.dbUnavailable = false;
          state.dbUnavailableUntilMs = 0;
          return row || null;
        } catch (retryErr) {
          markDbUnavailable(retryErr);
          return null;
        }
      }
    } else {
      markDbUnavailable(err);
    }
    return null;
  }
}

async function upsertSuggestion(entry = {}) {
  const normalized = coerceSuggestion(entry);
  touchMem(normalized);
  if (!shouldUseDbNow()) return normalized;
  const run = async () => query(
    `
    INSERT INTO reco_label_suggestions (
      id, anchor_product_id, block, candidate_product_id, suggested_label, wrong_block_target,
      confidence, rationale_user_visible, flags, model_name, prompt_version, input_hash,
      request_id, session_id, snapshot, created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9::jsonb, $10, $11, $12,
      $13, $14, $15::jsonb, $16::timestamptz, $17::timestamptz
    )
    ON CONFLICT (input_hash, model_name, prompt_version, block) DO UPDATE SET
      anchor_product_id = EXCLUDED.anchor_product_id,
      candidate_product_id = EXCLUDED.candidate_product_id,
      suggested_label = EXCLUDED.suggested_label,
      wrong_block_target = EXCLUDED.wrong_block_target,
      confidence = EXCLUDED.confidence,
      rationale_user_visible = EXCLUDED.rationale_user_visible,
      flags = EXCLUDED.flags,
      request_id = EXCLUDED.request_id,
      session_id = EXCLUDED.session_id,
      snapshot = EXCLUDED.snapshot,
      updated_at = now()
    `,
    [
      normalized.id,
      normalized.anchor_product_id,
      normalized.block,
      normalized.candidate_product_id,
      normalized.suggested_label,
      normalized.wrong_block_target,
      normalized.confidence,
      normalized.rationale_user_visible,
      stableJson(normalized.flags),
      normalized.model_name,
      normalized.prompt_version,
      normalized.input_hash,
      normalized.request_id,
      normalized.session_id,
      stableJson(normalized.snapshot),
      normalized.created_at,
      normalized.updated_at,
    ],
  );
  try {
    await run();
    state.dbUnavailable = false;
    state.dbUnavailableUntilMs = 0;
  } catch (err) {
    if (isMissingTableError(err)) {
      const initialized = await ensureRecoLabelSuggestionsTable();
      if (initialized) {
        try {
          await run();
          state.dbUnavailable = false;
          state.dbUnavailableUntilMs = 0;
          return normalized;
        } catch (retryErr) {
          markDbUnavailable(retryErr);
          return normalized;
        }
      }
    } else {
      markDbUnavailable(err);
    }
  }
  return normalized;
}

async function getSuggestionsByAnchor({ anchorProductId, block, limit = 120 } = {}) {
  const anchor = normalizeString(anchorProductId, 200);
  const blockToken = normalizeString(block, 64);
  const max = Math.max(1, Math.min(500, Number(limit) || 120));
  const memRows = selectMemRows({ anchor, blockToken, max });
  if (!shouldUseDbNow()) return memRows;
  const run = async () => {
    const params = [anchor];
    let where = 'anchor_product_id = $1';
    if (blockToken) {
      params.push(blockToken);
      where += ` AND block = $${params.length}`;
    }
    params.push(max);
    return query(
      `
      SELECT id, anchor_product_id, block, candidate_product_id, suggested_label, wrong_block_target,
             confidence, rationale_user_visible, flags, model_name, prompt_version, input_hash,
             request_id, session_id, snapshot, created_at, updated_at
      FROM reco_label_suggestions
      WHERE ${where}
      ORDER BY updated_at DESC
      LIMIT $${params.length}
      `,
      params,
    );
  };
  try {
    const res = await run();
    const rows = (Array.isArray(res?.rows) ? res.rows : []).map(mapRow).filter(Boolean);
    for (const row of rows) touchMem(row);
    state.dbUnavailable = false;
    state.dbUnavailableUntilMs = 0;
    return mergeRows(rows, memRows, max);
  } catch (err) {
    if (isMissingTableError(err)) {
      const initialized = await ensureRecoLabelSuggestionsTable();
      if (initialized) {
        try {
          const retry = await run();
          const rows = (Array.isArray(retry?.rows) ? retry.rows : []).map(mapRow).filter(Boolean);
          for (const row of rows) touchMem(row);
          state.dbUnavailable = false;
          state.dbUnavailableUntilMs = 0;
          return mergeRows(rows, memRows, max);
        } catch (retryErr) {
          markDbUnavailable(retryErr);
          return memRows;
        }
      }
    } else {
      markDbUnavailable(err);
    }
    return memRows;
  }
}

async function listQueueCandidatesWithSuggestions({
  block,
  limit = 100,
  confidenceLte = null,
  wrongBlockOnly = false,
  anchorProductId = '',
} = {}) {
  const max = Math.max(1, Math.min(500, Number(limit) || 100));
  const blockToken = normalizeString(block, 64);
  const anchor = normalizeString(anchorProductId, 200);
  const hasConfidenceCap =
    confidenceLte != null &&
    !(typeof confidenceLte === 'string' && !confidenceLte.trim());
  const confCap = hasConfidenceCap && Number.isFinite(Number(confidenceLte))
    ? Math.max(0, Math.min(1, Number(confidenceLte)))
    : null;
  const memRows = selectMemRows({
    anchor,
    blockToken,
    confCap,
    wrongBlockOnly,
    max,
  });

  if (!shouldUseDbNow()) return memRows;

  const run = async () => {
    const params = [];
    const where = [];
    if (blockToken) {
      params.push(blockToken);
      where.push(`s.block = $${params.length}`);
    }
    if (anchor) {
      params.push(anchor);
      where.push(`s.anchor_product_id = $${params.length}`);
    }
    if (confCap != null) {
      params.push(confCap);
      where.push(`s.confidence <= $${params.length}`);
    }
    if (wrongBlockOnly) {
      params.push('wrong_block');
      where.push(`s.suggested_label = $${params.length}`);
    }
    params.push(max);
    return query(
      `
      SELECT s.id, s.anchor_product_id, s.block, s.candidate_product_id, s.suggested_label, s.wrong_block_target,
             s.confidence, s.rationale_user_visible, s.flags, s.model_name, s.prompt_version, s.input_hash,
             s.request_id, s.session_id, s.snapshot, s.created_at, s.updated_at
      FROM reco_label_suggestions s
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.updated_at DESC
      LIMIT $${params.length}
      `,
      params,
    );
  };
  try {
    const res = await run();
    const rows = (Array.isArray(res?.rows) ? res.rows : []).map(mapRow).filter(Boolean);
    for (const row of rows) touchMem(row);
    state.dbUnavailable = false;
    state.dbUnavailableUntilMs = 0;
    return mergeRows(rows, memRows, max);
  } catch (err) {
    if (isMissingTableError(err)) {
      const initialized = await ensureRecoLabelSuggestionsTable();
      if (initialized) {
        try {
          const retry = await run();
          const rows = (Array.isArray(retry?.rows) ? retry.rows : []).map(mapRow).filter(Boolean);
          for (const row of rows) touchMem(row);
          state.dbUnavailable = false;
          state.dbUnavailableUntilMs = 0;
          return mergeRows(rows, memRows, max);
        } catch (retryErr) {
          markDbUnavailable(retryErr);
          return memRows;
        }
      }
    } else {
      markDbUnavailable(err);
    }
    return memRows;
  }
}

module.exports = {
  upsertSuggestion,
  getSuggestionsByAnchor,
  getSuggestionByInputHash,
  listQueueCandidatesWithSuggestions,
  __internal: {
    coerceSuggestion,
    mapRow,
    state,
  },
};
