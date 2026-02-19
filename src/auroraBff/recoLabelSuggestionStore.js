const crypto = require('crypto');
const { query } = require('../db');

const MAX_MEM_ENTRIES = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_PRELABEL_MEM_MAX || 4000);
  const v = Number.isFinite(n) ? Math.trunc(n) : 4000;
  return Math.max(100, Math.min(20000, v));
})();

const state = {
  dbUnavailable: false,
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

  if (state.dbUnavailable) return null;
  try {
    const ttl = Number.isFinite(Number(ttlMs)) ? Math.max(0, Math.trunc(Number(ttlMs))) : 0;
    const res = await query(
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
    const row = mapRow(res?.rows?.[0]);
    if (row) touchMem(row);
    return row || null;
  } catch (err) {
    if (String(err?.code || '') === '42P01' || String(err?.code || '') === 'NO_DATABASE') state.dbUnavailable = true;
    return null;
  }
}

async function upsertSuggestion(entry = {}) {
  const normalized = coerceSuggestion(entry);
  touchMem(normalized);
  if (state.dbUnavailable) return normalized;
  try {
    await query(
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
  } catch (err) {
    if (String(err?.code || '') === '42P01' || String(err?.code || '') === 'NO_DATABASE') state.dbUnavailable = true;
  }
  return normalized;
}

async function getSuggestionsByAnchor({ anchorProductId, block, limit = 120 } = {}) {
  const anchor = normalizeString(anchorProductId, 200);
  const blockToken = normalizeString(block, 64);
  const max = Math.max(1, Math.min(500, Number(limit) || 120));
  const memRows = Array.from(state.memById.values())
    .filter((row) => row.anchor_product_id === anchor && (!blockToken || row.block === blockToken))
    .sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime())
    .slice(0, max);
  if (state.dbUnavailable) return memRows;
  try {
    const params = [anchor];
    let where = 'anchor_product_id = $1';
    if (blockToken) {
      params.push(blockToken);
      where += ` AND block = $${params.length}`;
    }
    params.push(max);
    const res = await query(
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
    const rows = (Array.isArray(res?.rows) ? res.rows : []).map(mapRow).filter(Boolean);
    for (const row of rows) touchMem(row);
    return rows;
  } catch (err) {
    if (String(err?.code || '') === '42P01' || String(err?.code || '') === 'NO_DATABASE') state.dbUnavailable = true;
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
  const confCap = Number.isFinite(Number(confidenceLte)) ? Math.max(0, Math.min(1, Number(confidenceLte))) : null;

  if (state.dbUnavailable) {
    return Array.from(state.memById.values())
      .filter((row) => (!blockToken || row.block === blockToken))
      .filter((row) => (!anchor || row.anchor_product_id === anchor))
      .filter((row) => (confCap == null ? true : row.confidence <= confCap))
      .filter((row) => (wrongBlockOnly ? row.suggested_label === 'wrong_block' : true))
      .sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime())
      .slice(0, max);
  }

  try {
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
    const res = await query(
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
    const rows = (Array.isArray(res?.rows) ? res.rows : []).map(mapRow).filter(Boolean);
    for (const row of rows) touchMem(row);
    return rows;
  } catch (err) {
    if (String(err?.code || '') === '42P01' || String(err?.code || '') === 'NO_DATABASE') state.dbUnavailable = true;
    return [];
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
