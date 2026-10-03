const { query, getPool } = require('../db');

// Id-only keyset avoids renewal's timestamp microsecond cursor trap. Full snapshots
// live for one batch, avoiding the unbounded materialization that caused a 4GB OOM.
const SERVING_SCAN_SQL = `SELECT id, anchor_type, anchor_ref, anchor_snapshot,
  candidate_product_ref, candidate_snapshot, relation_type, label_state,
  market, vertical, category_taxonomy, use_case, score_total, score_breakdown,
  price_evidence, source_refs, evidence_grade, provenance
  FROM relationship_candidate_labels
  WHERE vertical = 'beauty' AND label_state IN ('ai_approved', 'human_approved')
    AND last_verified_at IS NOT NULL AND expires_at > now() AND upper(market) = $1
    AND ($2::text IS NULL OR id > $2::text)
  ORDER BY id LIMIT $3`;

function isTransientDbError(err) {
  const code = String(err?.code || '').trim().toUpperCase();
  const message = String(err?.message || err || '').toLowerCase();
  if (code.startsWith('08')) return true;
  return [
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    '57P01',
    '57P02',
    '57P03',
  ].includes(code) ||
    message.includes('connection reset') ||
    message.includes('connection terminated unexpectedly') ||
    message.includes('server closed the connection unexpectedly') ||
    message.includes('client has encountered a connection error') ||
    message.includes('connection terminated');
}


async function scanServingLabels({ market = 'US', queryFn = query, batchSize = 500,
  collectAnchors = false, collectSuppressedIds = false, queryRetries = 2,
  queryRetryBackoffMs = 1000, closePoolFn = null, onBatch } = {}) {
  // Lazy owner import permits the coverage/source module to reuse this scan.
  const { isRelationshipEdgeServingSafe } = require('../auroraBff/productRelationshipGraph');
  // src/db.query also resets the pool on transient failures. Bypass that reset
  // for the shared default query: a routine may hold its advisory-lock client
  // until this scan returns. Let this scan retry pages without ending that pool.
  const queryPage = queryFn === query ? (sql, params) => {
    const pool = typeof getPool === 'function' ? getPool() : null;
    return pool ? pool.query(sql, params) : query(sql, params);
  } : queryFn;
  const size = Math.max(1, Math.min(500, Math.trunc(Number(batchSize) || 500)));
  const retries = Math.max(0, Math.min(5, Math.trunc(Number(queryRetries) || 0)));
  const backoff = Math.max(0, Math.min(30000, Number(queryRetryBackoffMs) || 0));
  const anchors = new Set();
  const suppressedIds = [];
  let servedEdges = 0;
  let suppressedCount = 0;
  let cursor = null;
  while (true) {
    let rows;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const result = await queryPage(SERVING_SCAN_SQL, [String(market).toUpperCase(), cursor, size]);
        rows = Array.isArray(result?.rows) ? result.rows : [];
        break;
      } catch (error) {
        if (!isTransientDbError(error) || attempt >= retries) throw error;
        try { await closePoolFn?.(); } catch (_) { /* An explicit isolated cleanup hook is best effort. */ }
        await new Promise((resolve) => setTimeout(resolve, backoff * (attempt + 1)));
      }
    }
    for (const row of rows) {
      if (!isRelationshipEdgeServingSafe(row)) {
        suppressedCount += 1;
        if (collectSuppressedIds) suppressedIds.push(row.id);
      } else {
        servedEdges += 1;
        if (collectAnchors) anchors.add(`${row.anchor_type}:${String(row.anchor_ref).trim().toLowerCase()}`);
      }
    }
    const count = rows.length;
    const next = count ? rows[count - 1].id : null;
    rows = null; // No full-snapshot accumulation across batches.
    if (onBatch) await onBatch({ count, cursor: next });
    if (count < size) break;
    if (!next || next === cursor) throw new Error('serving_scan_cursor_did_not_advance');
    cursor = next;
  }
  return { servedEdges, anchors, suppressedIds, suppressedCount };
}

module.exports = { scanServingLabels, SERVING_SCAN_SQL, isTransientDbError };
