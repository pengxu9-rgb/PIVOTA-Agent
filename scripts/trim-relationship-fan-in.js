#!/usr/bin/env node
'use strict';

// Trim stored dupe / competitive_alternative candidates that serve more anchors than the fan-in
// cap. One-off, complementary to the whole-graph cap the builder applies at write time (which
// bounds NEW edges but never trims existing ones).
//
// Rule (shares its "live" definition and cap with src/auroraBff/relationshipFanIn.js, imported,
// never duplicated): for each candidate, rank its counted rows (serving states while unexpired;
// queued states while unexpired and fresh) by state rank human_approved > ai_approved > queued,
// then score_total DESC, then anchor_ref ASC. Keep the top `cap`; move the rest to
// `needs_evidence` with reason_flag `fan_in_trim`. human_approved rows are NEVER touched: when a
// candidate has more than `cap` of them they are all kept (reported as a conflict) and every
// non-human row is trimmed. No deletes. expires_at is left as is (needs_evidence rows are out of
// the serving view regardless), so a revert restores the row exactly.
//
// Dry-run by default. --apply requires --confirm APPLY_RELGRAPH_FAN_IN_TRIM and writes per
// candidate inside one transaction under the same advisory lock the builder takes
// (pg_advisory_xact_lock(hashtext('relgraph_fan_in:<candidate>'))). Every run writes a manifest
// (--out) with the previous state per row; --revert <manifest> --apply --confirm restores rows
// that are still `needs_evidence` with the `fan_in_trim` flag. Idempotent: trimmed rows are no
// longer counted, so a rerun plans nothing.
//
// Run AFTER the score rescore (ranking uses score_total); or pass --rescored-manifest <path> to
// rank a dry run by the rescore's projected scores.
//
//   node scripts/trim-relationship-fan-in.js --market US --out /tmp/trim.json
//   node scripts/trim-relationship-fan-in.js --market US --out /tmp/trim.json --apply --confirm APPLY_RELGRAPH_FAN_IN_TRIM
//   node scripts/trim-relationship-fan-in.js --revert /tmp/trim.json --apply --confirm APPLY_RELGRAPH_FAN_IN_TRIM

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');
const {
  DEFAULT_MAX_ANCHORS_PER_CANDIDATE,
  DEFAULT_QUEUED_FRESH_DAYS,
  FAN_IN_CAPPED_RELATION_TYPES,
  LIVE_LABEL_STATES,
  PENDING_LABEL_STATES,
  fanInLockKey,
  normalizeQueuedFreshDays,
} = require('../src/auroraBff/relationshipFanIn');

const CONFIRM_TOKEN = 'APPLY_RELGRAPH_FAN_IN_TRIM';
const TRIM_FLAG = 'fan_in_trim';
const TRIMMED_LABEL_STATE = 'needs_evidence';
const DEFAULT_MARKET = 'US';
const STATE_RANK = { human_approved: 3, ai_approved: 2, review_ready: 1, generated: 1 };

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeLower(value, max = 512) {
  return normalizeString(value, max).toLowerCase();
}

function argValue(argv, name, fallback = '') {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = argv[idx + 1];
  return !value || value.startsWith('--') ? fallback : value;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function compareRows(a, b) {
  return (STATE_RANK[b.label_state] || 0) - (STATE_RANK[a.label_state] || 0) ||
    Number(b.score_total || 0) - Number(a.score_total || 0) ||
    normalizeLower(a.anchor_ref, 260).localeCompare(normalizeLower(b.anchor_ref, 260)) ||
    String(a.id).localeCompare(String(b.id));
}

// Pure. `rows`: the candidate's counted rows (as loadCountedRows returns them). Returns the plan
// for one candidate: rows to trim and whether human_approved rows alone exceed the cap.
function planCandidateTrim(rows = [], { cap = DEFAULT_MAX_ANCHORS_PER_CANDIDATE, projectedScores = new Map() } = {}) {
  const limit = Math.max(1, Math.floor(Number(cap) || DEFAULT_MAX_ANCHORS_PER_CANDIDATE));
  const ranked = rows
    .map((row) => ({ ...row, label_state: normalizeLower(row.label_state, 40), score_total: projectedScores.has(row.id) ? projectedScores.get(row.id) : row.score_total }))
    .sort(compareRows);
  const humanApproved = ranked.filter((row) => row.label_state === 'human_approved');
  const keep = [];
  const trim = [];
  for (const row of ranked) {
    if (row.label_state === 'human_approved' || keep.length < limit) keep.push(row);
    else trim.push(row);
  }
  return {
    counted: ranked.length,
    kept: keep.length,
    trim,
    human_approved_count: humanApproved.length,
    human_approved_conflict: humanApproved.length > limit,
  };
}

// Pure. Plans every candidate. `rowsByCandidate`: Map(candidate ref -> rows).
function planFanInTrim(rowsByCandidate = new Map(), options = {}) {
  const patches = [];
  const candidates = [];
  const conflicts = [];
  const byPreviousState = {};
  for (const [candidateRef, rows] of Array.from(rowsByCandidate.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const plan = planCandidateTrim(rows, options);
    if (plan.human_approved_conflict) conflicts.push({ candidate_ref: candidateRef, human_approved: plan.human_approved_count });
    if (!plan.trim.length) continue;
    candidates.push({ candidate_ref: candidateRef, counted: plan.counted, kept: plan.kept, trimmed: plan.trim.length });
    for (const row of plan.trim) {
      byPreviousState[row.label_state] = (byPreviousState[row.label_state] || 0) + 1;
      patches.push({
        id: row.id,
        candidate_ref: candidateRef,
        anchor_ref: row.anchor_ref,
        relation_type: row.relation_type,
        score_total: row.score_total,
        previous_label_state: row.label_state,
        previous_reason_flags: Array.isArray(row.reason_flags) ? row.reason_flags : [],
      });
    }
  }
  return {
    rows_to_trim: patches.length,
    candidates_affected: candidates.length,
    human_approved_conflicts: conflicts,
    by_previous_state: byPreviousState,
    candidates,
    patches,
  };
}

async function loadCountedRows({ queryFn, market, cap, queuedFreshDays }) {
  const res = await queryFn(
    `
      SELECT id, lower(candidate_product_ref) AS candidate_ref, anchor_ref, relation_type, label_state,
             score_total, reason_flags
      FROM relationship_candidate_labels
      WHERE lower(market) = $1
        AND anchor_type = 'product'
        AND relation_type = ANY($2::text[])
        AND (expires_at IS NULL OR expires_at > now())
        AND (
          label_state = ANY($3::text[])
          OR (label_state = ANY($4::text[]) AND updated_at >= now() - make_interval(days => $5::int))
        )
        AND lower(candidate_product_ref) IN (
          SELECT lower(candidate_product_ref)
          FROM relationship_candidate_labels
          WHERE lower(market) = $1
            AND anchor_type = 'product'
            AND relation_type = ANY($2::text[])
            AND (expires_at IS NULL OR expires_at > now())
            AND (
              label_state = ANY($3::text[])
              OR (label_state = ANY($4::text[]) AND updated_at >= now() - make_interval(days => $5::int))
            )
          GROUP BY lower(candidate_product_ref)
          HAVING count(DISTINCT lower(anchor_ref)) > $6::int
        )
    `,
    [normalizeLower(market, 24) || 'us', Array.from(FAN_IN_CAPPED_RELATION_TYPES), LIVE_LABEL_STATES, PENDING_LABEL_STATES, queuedFreshDays, cap],
  );
  const byCandidate = new Map();
  for (const row of Array.isArray(res && res.rows) ? res.rows : []) {
    const key = normalizeLower(row.candidate_ref, 260);
    if (!byCandidate.has(key)) byCandidate.set(key, []);
    byCandidate.get(key).push(row);
  }
  return byCandidate;
}

async function applyTrimForCandidate({ client, candidateRef, patches, nowIso }) {
  const clientQuery = (text, params) => client.query(text, params);
  await clientQuery('BEGIN');
  try {
    await clientQuery('SELECT pg_advisory_xact_lock(hashtext($1))', [fanInLockKey(candidateRef)]);
    const res = await clientQuery(
      `
        WITH patch AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(id text, previous_label_state text)
        )
        UPDATE relationship_candidate_labels AS l
        SET label_state = $2,
            updated_at = now(),
            reason_flags = ARRAY(
              SELECT DISTINCT flag
              FROM unnest(COALESCE(l.reason_flags, '{}'::text[]) || ARRAY[$3::text]) AS flags(flag)
              WHERE flag IS NOT NULL AND flag <> ''
              ORDER BY flag
            ),
            provenance = jsonb_set(COALESCE(l.provenance, '{}'::jsonb), '{fan_in_trim}', $4::jsonb, true)
        FROM patch
        WHERE l.id = patch.id
          AND l.label_state = patch.previous_label_state
          AND l.label_state <> 'human_approved'
        RETURNING l.id
      `,
      [JSON.stringify(patches.map((p) => ({ id: p.id, previous_label_state: p.previous_label_state }))), TRIMMED_LABEL_STATE, TRIM_FLAG, JSON.stringify({ at: nowIso, candidate_ref: candidateRef, script: 'trim-relationship-fan-in.js' })],
    );
    await clientQuery('COMMIT');
    return Array.isArray(res && res.rows) ? res.rows.length : 0;
  } catch (err) {
    try { await clientQuery('ROLLBACK'); } catch { /* surface the original error */ }
    throw err;
  }
}

async function revertTrim({ queryFn, rows = [], batchSize = 500 }) {
  let reverted = 0;
  for (let idx = 0; idx < rows.length; idx += batchSize) {
    const chunk = rows.slice(idx, idx + batchSize).map((row) => ({ id: row.id, previous_label_state: row.previous_label_state }));
    // eslint-disable-next-line no-await-in-loop
    const res = await queryFn(
      `
        WITH patch AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(id text, previous_label_state text)
        )
        UPDATE relationship_candidate_labels AS l
        SET label_state = patch.previous_label_state,
            updated_at = now(),
            reason_flags = array_remove(COALESCE(l.reason_flags, '{}'::text[]), $2::text)
        FROM patch
        WHERE l.id = patch.id
          AND l.label_state = $3
          AND $2::text = ANY(COALESCE(l.reason_flags, '{}'::text[]))
          AND patch.previous_label_state <> 'human_approved'
        RETURNING l.id
      `,
      [JSON.stringify(chunk), TRIM_FLAG, TRIMMED_LABEL_STATE],
    );
    reverted += Array.isArray(res && res.rows) ? res.rows.length : 0;
  }
  return reverted;
}

function parseArgs(argv = process.argv.slice(2)) {
  const apply = hasFlag(argv, 'apply');
  const confirm = normalizeString(argValue(argv, 'confirm'), 120);
  if (apply && confirm !== CONFIRM_TOKEN) throw new Error(`--apply requires --confirm ${CONFIRM_TOKEN}`);
  return {
    apply,
    market: normalizeString(argValue(argv, 'market', DEFAULT_MARKET), 24).toUpperCase() || DEFAULT_MARKET,
    cap: parseInteger(argValue(argv, 'cap'), DEFAULT_MAX_ANCHORS_PER_CANDIDATE, { min: 1, max: 1000 }),
    queuedFreshDays: normalizeQueuedFreshDays(argValue(argv, 'queued-fresh-days', DEFAULT_QUEUED_FRESH_DAYS)),
    out: normalizeString(argValue(argv, 'out'), 2000),
    revert: normalizeString(argValue(argv, 'revert'), 2000),
    rescoredManifest: normalizeString(argValue(argv, 'rescored-manifest'), 2000),
    batchSize: parseInteger(argValue(argv, 'batch-size'), 500, { min: 1, max: 5000 }),
  };
}

function writeJson(target, payload) {
  if (!target) return;
  const resolved = path.isAbsolute(target) ? target : path.join(process.cwd(), target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function run(argv = process.argv.slice(2), { queryFn = query, runInClient = withClient, now = new Date() } = {}) {
  const options = parseArgs(argv);
  const nowIso = now.toISOString();

  if (options.revert) {
    const manifest = JSON.parse(fs.readFileSync(options.revert, 'utf8'));
    const rows = Array.isArray(manifest.patches) ? manifest.patches : [];
    const reverted = options.apply ? await revertTrim({ queryFn, rows, batchSize: options.batchSize }) : 0;
    const report = { schema_version: 'relgraph_fan_in_trim_revert.v1', generated_at: nowIso, dry_run: !options.apply, manifest: options.revert, rows: rows.length, reverted };
    writeJson(options.out, report);
    return report;
  }

  const projectedScores = new Map();
  if (options.rescoredManifest) {
    const manifest = JSON.parse(fs.readFileSync(options.rescoredManifest, 'utf8'));
    for (const row of Array.isArray(manifest.rows) ? manifest.rows : []) projectedScores.set(row.id, row.new_score_total);
  }
  const rowsByCandidate = await loadCountedRows({ queryFn, market: options.market, cap: options.cap, queuedFreshDays: options.queuedFreshDays });
  const plan = planFanInTrim(rowsByCandidate, { cap: options.cap, projectedScores });

  let trimmed = 0;
  if (options.apply) {
    const byCandidate = new Map();
    for (const patch of plan.patches) {
      if (!byCandidate.has(patch.candidate_ref)) byCandidate.set(patch.candidate_ref, []);
      byCandidate.get(patch.candidate_ref).push(patch);
    }
    for (const [candidateRef, patches] of byCandidate.entries()) {
      // eslint-disable-next-line no-await-in-loop
      trimmed += await runInClient((client) => applyTrimForCandidate({ client, candidateRef, patches, nowIso }));
    }
  }
  const report = {
    schema_version: 'relgraph_fan_in_trim.v1',
    generated_at: nowIso,
    dry_run: !options.apply,
    market: options.market,
    cap: options.cap,
    queued_fresh_days: options.queuedFreshDays,
    ranked_by: options.rescoredManifest ? 'rescored_manifest' : 'stored_score_total',
    summary: {
      candidates_over_cap: rowsByCandidate.size,
      rows_to_trim: plan.rows_to_trim,
      candidates_affected: plan.candidates_affected,
      human_approved_conflicts: plan.human_approved_conflicts.length,
      by_previous_state: plan.by_previous_state,
      trimmed,
    },
    human_approved_conflicts: plan.human_approved_conflicts,
    candidates: plan.candidates,
    patches: plan.patches,
  };
  writeJson(options.out, report);
  return report;
}

if (require.main === module) {
  run()
    .then((report) => { process.stdout.write(`${JSON.stringify({ ...report, patches: undefined, candidates: undefined }, null, 2)}\n`); })
    .catch((err) => { process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`); process.exitCode = 1; })
    .finally(() => closePool().catch(() => {}));
}

module.exports = {
  CONFIRM_TOKEN,
  TRIM_FLAG,
  TRIMMED_LABEL_STATE,
  applyTrimForCandidate,
  loadCountedRows,
  planCandidateTrim,
  planFanInTrim,
  revertTrim,
  run,
};
