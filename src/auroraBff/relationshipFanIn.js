'use strict';

// Global (whole-graph) fan-in cap for dupe / competitive_alternative candidates.
//
// #2290 capped how many anchors one candidate may serve PER BUILD. The routine job runs one
// `--limit 200` shard a day, labels upsert per (anchor, candidate) pair and nothing deletes stale
// edges, so a hub could still collect 8 anchors per shard. This module bounds the candidate's
// fan-in across the STORED graph: before a build persists its dupe / competitive_alternative
// edges, the candidate's existing anchors are counted and only (cap - existing) NEW anchors may be
// added, best score first, ties on anchor_ref, so a rerun keeps the same edges.
//
// What counts as existing: rows of relationship_candidate_labels for the market whose label_state
// either serves now (human_approved, ai_approved — the product_relationship_edges view) or is
// queued to serve after review (generated, review_ready), and whose expires_at is null or in the
// future. Counting the queue matters for incremental write-mode runs: a shard that writes 8
// `generated` rows today would otherwise let tomorrow's shard write 8 more before review turns
// either set live. Rejected, needs_evidence and expired rows never count. Anchors this build
// re-emits are not "new" and never count against it.
//
// Concurrency: the routine job runs one shard at a time under its own advisory lock (--db-lock)
// and the daily cron launches one routine; the writer additionally takes
// pg_advisory_xact_lock(hashtext('relgraph_fan_in:<candidate>')) and recounts inside that
// transaction, so two writers on one candidate serialise even outside the routine.

const FAN_IN_CAPPED_RELATION_TYPES = new Set(['dupe', 'competitive_alternative']);
const DEFAULT_MAX_ANCHORS_PER_CANDIDATE = 8;
const LIVE_LABEL_STATES = ['human_approved', 'ai_approved'];
const PENDING_LABEL_STATES = ['generated', 'review_ready'];
const COUNTED_LABEL_STATES = [...LIVE_LABEL_STATES, ...PENDING_LABEL_STATES];
const FAN_IN_LOCK_PREFIX = 'relgraph_fan_in:';

function normalizeLower(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  return (text.length > max ? text.slice(0, max) : text).toLowerCase();
}

function isCappedEdge(edge) {
  return Boolean(edge) && FAN_IN_CAPPED_RELATION_TYPES.has(normalizeLower(edge.relation_type, 64));
}

function candidateKey(edge) {
  return normalizeLower(edge.candidate_product_ref, 260);
}

function anchorKey(edge) {
  return normalizeLower(edge.anchor_ref, 260);
}

function fanInLockKey(candidateRef) {
  return `${FAN_IN_LOCK_PREFIX}${normalizeLower(candidateRef, 260)}`;
}

// Pure. `existingAnchorsByCandidate`: Map(lower candidate ref -> Set(lower anchor refs)) of the
// stored graph. Returns kept edges (input order preserved), dropped rejection rows and per-candidate
// stats. A candidate absent from the map has no existing anchors.
function capCandidateFanInGlobal(edges, existingAnchorsByCandidate = new Map(), { cap = DEFAULT_MAX_ANCHORS_PER_CANDIDATE } = {}) {
  const limit = Math.max(1, Math.floor(Number(cap) || DEFAULT_MAX_ANCHORS_PER_CANDIDATE));
  const list = Array.isArray(edges) ? edges : [];
  const byCandidate = new Map();
  list.forEach((edge, index) => {
    if (!isCappedEdge(edge)) return;
    const key = candidateKey(edge);
    if (!byCandidate.has(key)) byCandidate.set(key, []);
    byCandidate.get(key).push({ edge, index });
  });

  const dropIndexes = new Set();
  const dropped = [];
  const stats = new Map();
  let maxExisting = 0;
  let maxTotalBeforeCap = 0;
  for (const [key, rows] of byCandidate.entries()) {
    const existing = existingAnchorsByCandidate.get(key) || new Set();
    const buildAnchors = new Set(rows.map(({ edge }) => anchorKey(edge)));
    let existingOther = 0;
    for (const anchor of existing) if (!buildAnchors.has(anchor)) existingOther += 1;
    const allowedNew = Math.max(0, limit - existingOther);
    const ranked = [...rows].sort((a, b) =>
      Number(b.edge.score_total || 0) - Number(a.edge.score_total || 0) ||
      anchorKey(a.edge).localeCompare(anchorKey(b.edge)) ||
      a.index - b.index);
    let addedNew = 0;
    let keptCount = 0;
    for (const { edge, index } of ranked) {
      const anchor = anchorKey(edge);
      if (existing.has(anchor)) {
        keptCount += 1;
        continue;
      }
      if (addedNew < allowedNew) {
        addedNew += 1;
        keptCount += 1;
        continue;
      }
      dropIndexes.add(index);
      dropped.push({
        anchor_ref: edge.anchor_ref,
        candidate_ref: edge.candidate_product_ref,
        errors: ['candidate_fan_in_cap_global'],
        metrics: {
          relation_type: edge.relation_type,
          score_total: edge.score_total,
          existing_anchors: existingOther,
          allowed_new: allowedNew,
          cap: limit,
        },
      });
    }
    const totalBeforeCap = existingOther + rows.length;
    maxExisting = Math.max(maxExisting, existingOther);
    maxTotalBeforeCap = Math.max(maxTotalBeforeCap, totalBeforeCap);
    stats.set(key, { existing_anchors: existingOther, build_anchors: rows.length, kept: keptCount, dropped: rows.length - keptCount, allowed_new: allowedNew });
  }

  return {
    kept: list.filter((edge, index) => !dropIndexes.has(index)),
    dropped,
    stats,
    cap: limit,
    candidates_checked: byCandidate.size,
    max_existing_anchors: maxExisting,
    max_fan_in_global_before_cap: maxTotalBeforeCap,
  };
}

// Read-only. Existing anchors per candidate for the given candidate refs in the stored graph.
// Fails open (empty map) when there is no database or no labels table: the per-build cap still holds.
async function loadExistingAnchorsByCandidate({
  candidateRefs = [],
  market = 'US',
  queryFn,
  labelStates = COUNTED_LABEL_STATES,
} = {}) {
  const refs = Array.from(new Set((Array.isArray(candidateRefs) ? candidateRefs : []).map((ref) => normalizeLower(ref, 260)).filter(Boolean)));
  const out = new Map();
  if (!refs.length || typeof queryFn !== 'function') return out;
  let res;
  try {
    res = await queryFn(
      `
        SELECT lower(candidate_product_ref) AS candidate_ref, lower(anchor_ref) AS anchor_ref
        FROM relationship_candidate_labels
        WHERE lower(market) = $1
          AND anchor_type = 'product'
          AND relation_type = ANY($2::text[])
          AND lower(candidate_product_ref) = ANY($3::text[])
          AND label_state = ANY($4::text[])
          AND (expires_at IS NULL OR expires_at > now())
      `,
      [normalizeLower(market, 24) || 'us', Array.from(FAN_IN_CAPPED_RELATION_TYPES), refs, labelStates],
    );
  } catch (err) {
    if (['NO_DATABASE', '42P01'].includes(String(err && err.code))) return out;
    throw err;
  }
  for (const row of Array.isArray(res && res.rows) ? res.rows : []) {
    const key = normalizeLower(row.candidate_ref, 260);
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(normalizeLower(row.anchor_ref, 260));
  }
  return out;
}

// Read-only census: candidates whose stored fan-in (dupe + competitive_alternative anchors) exceeds
// the cap, for live rows and for live + queued rows.
async function loadFanInCensus({ market = 'US', cap = DEFAULT_MAX_ANCHORS_PER_CANDIDATE, queryFn, top = 10 } = {}) {
  const limit = Math.max(1, Math.floor(Number(cap) || DEFAULT_MAX_ANCHORS_PER_CANDIDATE));
  const res = await queryFn(
    `
      SELECT
        lower(candidate_product_ref) AS candidate_ref,
        max(candidate_snapshot->>'brand') AS brand,
        max(coalesce(candidate_snapshot->>'name', candidate_snapshot->>'title')) AS name,
        count(DISTINCT lower(anchor_ref)) FILTER (WHERE label_state = ANY($2::text[])) AS live_anchors,
        count(DISTINCT lower(anchor_ref)) AS live_or_pending_anchors
      FROM relationship_candidate_labels
      WHERE lower(market) = $1
        AND anchor_type = 'product'
        AND relation_type = ANY($3::text[])
        AND label_state = ANY($4::text[])
        AND (expires_at IS NULL OR expires_at > now())
      GROUP BY lower(candidate_product_ref)
    `,
    [normalizeLower(market, 24) || 'us', LIVE_LABEL_STATES, Array.from(FAN_IN_CAPPED_RELATION_TYPES), COUNTED_LABEL_STATES],
  );
  const rows = (Array.isArray(res && res.rows) ? res.rows : []).map((row) => ({
    candidate_ref: row.candidate_ref,
    brand: row.brand || null,
    name: row.name || null,
    live_anchors: Number(row.live_anchors || 0),
    live_or_pending_anchors: Number(row.live_or_pending_anchors || 0),
  }));
  const overLive = rows.filter((row) => row.live_anchors > limit);
  const overAny = rows.filter((row) => row.live_or_pending_anchors > limit);
  const bucket = (n) => (n <= 1 ? '1' : n <= 2 ? '2' : n <= 4 ? '3-4' : n <= 8 ? '5-8' : n <= 16 ? '9-16' : n <= 32 ? '17-32' : n <= 64 ? '33-64' : '65+');
  const hist = {};
  for (const row of rows) hist[bucket(row.live_or_pending_anchors)] = (hist[bucket(row.live_or_pending_anchors)] || 0) + 1;
  return {
    market: normalizeLower(market, 24).toUpperCase(),
    cap: limit,
    candidates_with_edges: rows.length,
    over_cap_live: overLive.length,
    over_cap_live_or_pending: overAny.length,
    excess_edges_live: overLive.reduce((sum, row) => sum + (row.live_anchors - limit), 0),
    excess_edges_live_or_pending: overAny.reduce((sum, row) => sum + (row.live_or_pending_anchors - limit), 0),
    max_live_anchors: rows.reduce((max, row) => Math.max(max, row.live_anchors), 0),
    max_live_or_pending_anchors: rows.reduce((max, row) => Math.max(max, row.live_or_pending_anchors), 0),
    fan_in_histogram: hist,
    top: [...rows].sort((a, b) => b.live_or_pending_anchors - a.live_or_pending_anchors).slice(0, top),
  };
}

module.exports = {
  DEFAULT_MAX_ANCHORS_PER_CANDIDATE,
  FAN_IN_CAPPED_RELATION_TYPES,
  LIVE_LABEL_STATES,
  PENDING_LABEL_STATES,
  COUNTED_LABEL_STATES,
  capCandidateFanInGlobal,
  fanInLockKey,
  isCappedEdge,
  loadExistingAnchorsByCandidate,
  loadFanInCensus,
};
