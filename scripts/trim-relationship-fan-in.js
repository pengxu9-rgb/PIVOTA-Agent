#!/usr/bin/env node
'use strict';

// Trim stored dupe / competitive_alternative candidates that serve more anchors than the fan-in
// cap. One-off, complementary to the whole-graph cap the builder applies at write time (which
// bounds NEW edges but never trims existing ones).
//
// Rule (shares its "live" definition and cap with src/auroraBff/relationshipFanIn.js, imported,
// never duplicated): the cap counts DISTINCT anchors, so rows are grouped per ANCHOR (a pair may
// hold both a dupe and a competitive_alternative row). For each candidate, rank its anchor groups
// by their best row: state rank human_approved > ai_approved > queued, then score_total DESC, then
// anchor_ref ASC. Keep every row of the top `cap` groups; move every row of the other groups to
// `needs_evidence` with reason_flag `fan_in_trim`. A group holding a human_approved row is NEVER
// touched: when more than `cap` groups hold one they are all kept (reported as a conflict) and
// every non-human group is trimmed. No deletes; expires_at and updated_at are left as they are
// (a needs_evidence row is out of the serving view and out of the fresh window regardless), so a
// revert restores the row exactly: label_state, reason_flags verbatim, updated_at, and the
// provenance stamp removed. Each trimmed row carries provenance.fan_in_trim = { previous_label_state,
// previous_reason_flags, previous_updated_at, run_id }, so --revert-from-provenance <run_id> works
// without the ledger.
//
// Dry-run by default. --apply requires --confirm APPLY_RELGRAPH_FAN_IN_TRIM and writes per
// candidate inside one transaction under the same advisory lock the builder takes
// (pg_advisory_xact_lock(hashtext('relgraph_fan_in:<candidate>'))). The revert manifest is
// DURABLE (src/services/relgraphOpsManifest.js): one ledger row per candidate batch, written in
// that candidate's transaction, plus a header with totals and sha256 — the job's /tmp is gone
// when the container ends. Batches are also echoed to stdout as RELGRAPH_OPS_MANIFEST lines.
// --revert <run_id> --apply --confirm reads the ledger (--revert-file <path> reads a local file)
// and restores rows that are still `needs_evidence` with the `fan_in_trim` flag. Idempotent:
// trimmed rows are no longer counted, so a rerun plans nothing.
//
// Run AFTER the score rescore (ranking uses score_total); or pass --rescored-manifest <path> to
// rank a dry run by the rescore's projected scores.
//
//   node scripts/trim-relationship-fan-in.js --market US --out /tmp/trim.json
//   node scripts/trim-relationship-fan-in.js --market US --out /tmp/trim.json --apply --confirm APPLY_RELGRAPH_FAN_IN_TRIM
//   node scripts/trim-relationship-fan-in.js --revert <run_id> --apply --confirm APPLY_RELGRAPH_FAN_IN_TRIM

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');
const manifestStore = require('../src/services/relgraphOpsManifest');
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
  // An absent flag is the fallback, never 0-clamped-to-min (that made the default batch size 1 and
  // the default cap 1).
  if (value == null || String(value).trim() === '') return fallback;
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

// Pure. `rows`: the candidate's counted rows (as loadCountedRows returns them). Groups them per
// anchor, ranks the groups by their best row, keeps the top `cap` groups (and every group holding a
// human_approved row) and trims the other groups whole.
function planCandidateTrim(rows = [], { cap = DEFAULT_MAX_ANCHORS_PER_CANDIDATE, projectedScores = new Map() } = {}) {
  const limit = Math.max(1, Math.floor(Number(cap) || DEFAULT_MAX_ANCHORS_PER_CANDIDATE));
  const normalized = rows.map((row) => ({ ...row, label_state: normalizeLower(row.label_state, 40), score_total: projectedScores.has(row.id) ? projectedScores.get(row.id) : row.score_total }));
  const groups = new Map();
  for (const row of normalized) {
    const key = normalizeLower(row.anchor_ref, 260);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const rankedGroups = Array.from(groups.values())
    .map((groupRows) => ({ rows: groupRows, best: [...groupRows].sort(compareRows)[0], human: groupRows.some((row) => row.label_state === 'human_approved') }))
    .sort((a, b) => compareRows(a.best, b.best));
  const humanGroups = rankedGroups.filter((group) => group.human);
  let kept = 0;
  const trim = [];
  for (const group of rankedGroups) {
    if (group.human || kept < limit) {
      kept += 1;
    } else {
      trim.push(...[...group.rows].sort(compareRows));
    }
  }
  return {
    counted: rankedGroups.length,
    counted_rows: normalized.length,
    kept,
    trim,
    human_approved_count: humanGroups.length,
    human_approved_conflict: humanGroups.length > limit,
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
        previous_updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : (row.updated_at || null),
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
             score_total, reason_flags, updated_at
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

async function applyTrimForCandidate({ client, candidateRef, patches, nowIso, manifest = null, batchIndex = 0, market = 'US' }) {
  const clientQuery = (text, params) => client.query(text, params);
  await clientQuery('BEGIN');
  try {
    await clientQuery('SELECT pg_advisory_xact_lock(hashtext($1))', [fanInLockKey(candidateRef)]);
    // updated_at is NOT bumped: the row leaves the serving view and the fresh window by state, and
    // the previous value stays in place for an exact revert. The before-values are stamped into
    // provenance.fan_in_trim; the flag is appended verbatim (no re-sort, no dedupe of what was there).
    const res = await clientQuery(
      `
        WITH patch AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(id text, previous_label_state text, prev jsonb)
        )
        UPDATE relationship_candidate_labels AS l
        SET label_state = $2,
            reason_flags = CASE WHEN $3::text = ANY(COALESCE(l.reason_flags, '{}'::text[]))
              THEN l.reason_flags ELSE COALESCE(l.reason_flags, '{}'::text[]) || ARRAY[$3::text] END,
            provenance = jsonb_set(COALESCE(l.provenance, '{}'::jsonb), '{fan_in_trim}', patch.prev, true)
        FROM patch
        WHERE l.id = patch.id
          AND l.label_state = patch.previous_label_state
          AND l.label_state <> 'human_approved'
        RETURNING l.id
      `,
      [JSON.stringify(patches.map((p) => ({ id: p.id, previous_label_state: p.previous_label_state, prev: { previous_label_state: p.previous_label_state, previous_reason_flags: p.previous_reason_flags, previous_updated_at: p.previous_updated_at, run_id: manifest, candidate_ref: candidateRef, at: nowIso } }))), TRIMMED_LABEL_STATE, TRIM_FLAG],
    );
    const landedIds = new Set((Array.isArray(res && res.rows) ? res.rows : []).map((row) => row.id));
    const landed = patches.filter((p) => landedIds.has(p.id)).map((p) => ({ id: p.id, candidate_ref: candidateRef, anchor_ref: p.anchor_ref, relation_type: p.relation_type, previous_label_state: p.previous_label_state, previous_reason_flags: p.previous_reason_flags, previous_updated_at: p.previous_updated_at }));
    if (manifest) {
      await manifestStore.writeManifestBatch({ queryFn: clientQuery, runId: manifest, kind: 'fan_in_trim', market, batchIndex, rows: landed, now: new Date(nowIso) });
    }
    await clientQuery('COMMIT');
    return landed;
  } catch (err) {
    try { await clientQuery('ROLLBACK'); } catch { /* surface the original error */ }
    throw err;
  }
}

async function revertTrim({ queryFn, rows = [], batchSize = 500, runInClient = withClient, manifest = null, market = 'US', log = () => {}, now = new Date() }) {
  let reverted = 0;
  let batches = 0;
  const digest = manifestStore.createManifestDigest();
  for (let idx = 0; idx < rows.length; idx += batchSize) {
    const chunk = rows.slice(idx, idx + batchSize).map((row) => ({ id: row.id, previous_label_state: row.previous_label_state, previous_reason_flags: Array.isArray(row.previous_reason_flags) ? row.previous_reason_flags : null, previous_updated_at: row.previous_updated_at || null }));
    const batchIndex = batches + 1;
    // eslint-disable-next-line no-await-in-loop
    const landed = await runInClient(async (client) => {
      const clientQuery = (text, params) => client.query(text, params);
      await clientQuery('BEGIN');
      try {
        const res = await revertChunk(clientQuery, chunk);
        const ids = new Set(res.map((row) => row.id));
        const landedRows = chunk.filter((p) => ids.has(p.id)).map((p) => ({ id: p.id, restored_label_state: p.previous_label_state, restored_updated_at: p.previous_updated_at }));
        if (manifest) await manifestStore.writeManifestBatch({ queryFn: clientQuery, runId: manifest, kind: 'fan_in_trim_revert', market, batchIndex, rows: landedRows, now });
        await clientQuery('COMMIT');
        return landedRows;
      } catch (err) {
        try { await clientQuery('ROLLBACK'); } catch { /* surface the original error */ }
        throw err;
      }
    });
    batches += 1;
    reverted += landed.length;
    digest.add(landed);
    if (manifest) for (const line of manifestStore.manifestLogLines(manifest, batchIndex, landed)) log(line);
  }
  return { reverted, batches, digest };
}

// Exact revert: label_state back, reason_flags verbatim from the manifest (else the flag removed),
// updated_at restored to the recorded value (else untouched), provenance.fan_in_trim removed.
async function revertChunk(queryFn, chunk) {
  {
    const res = await queryFn(
      `
        WITH patch AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(id text, previous_label_state text, previous_reason_flags jsonb, previous_updated_at timestamptz)
        )
        UPDATE relationship_candidate_labels AS l
        SET label_state = patch.previous_label_state,
            updated_at = COALESCE(patch.previous_updated_at, l.updated_at),
            reason_flags = CASE WHEN patch.previous_reason_flags IS NULL
              THEN array_remove(COALESCE(l.reason_flags, '{}'::text[]), $2::text)
              ELSE ARRAY(SELECT jsonb_array_elements_text(patch.previous_reason_flags)) END,
            provenance = COALESCE(l.provenance, '{}'::jsonb) - 'fan_in_trim'
        FROM patch
        WHERE l.id = patch.id
          AND l.label_state = $3
          AND $2::text = ANY(COALESCE(l.reason_flags, '{}'::text[]))
          AND patch.previous_label_state <> 'human_approved'
        RETURNING l.id
      `,
      [JSON.stringify(chunk), TRIM_FLAG, TRIMMED_LABEL_STATE],
    );
    return Array.isArray(res && res.rows) ? res.rows : [];
  }
}

// Revert without the ledger: rows carry their before-values in provenance.fan_in_trim.
async function loadRevertRowsFromProvenance({ queryFn, runId, market }) {
  const res = await queryFn(
    `
      SELECT id, provenance->'fan_in_trim' AS prev
      FROM relationship_candidate_labels
      WHERE lower(market) = $1
        AND label_state = $3
        AND provenance ? 'fan_in_trim'
        AND provenance->'fan_in_trim'->>'run_id' = $2
      ORDER BY id
    `,
    [normalizeLower(market, 24) || 'us', runId, TRIMMED_LABEL_STATE],
  );
  const rows = (Array.isArray(res && res.rows) ? res.rows : []).map((row) => {
    const prev = row.prev && typeof row.prev === 'object' ? row.prev : {};
    return { id: row.id, previous_label_state: prev.previous_label_state, previous_reason_flags: Array.isArray(prev.previous_reason_flags) ? prev.previous_reason_flags : null, previous_updated_at: prev.previous_updated_at || null };
  });
  return { run_id: runId, rows, sha256: null };
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
    revert: normalizeString(argValue(argv, 'revert'), 200),
    revertFile: normalizeString(argValue(argv, 'revert-file'), 2000),
    revertFromProvenance: normalizeString(argValue(argv, 'revert-from-provenance'), 200),
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

async function run(argv = process.argv.slice(2), { queryFn = query, runInClient = withClient, now = new Date(), log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const options = parseArgs(argv);
  const nowIso = now.toISOString();

  if (options.revert || options.revertFile || options.revertFromProvenance) {
    let source;
    if (options.revert) source = await manifestStore.readManifest({ queryFn, runId: options.revert });
    else if (options.revertFile) source = JSON.parse(fs.readFileSync(options.revertFile, 'utf8'));
    else source = await loadRevertRowsFromProvenance({ queryFn, runId: options.revertFromProvenance, market: options.market });
    const rows = Array.isArray(source.rows) ? source.rows : Array.isArray(source.patches) ? source.patches : [];
    let manifestLine = null;
    let reverted = 0;
    if (options.apply) {
      const kind = 'fan_in_trim_revert';
      const runId = manifestStore.manifestRunId(kind, now);
      const manifestOptions = { market: options.market, source: options.revert || options.revertFile || `provenance:${options.revertFromProvenance}`, rows_planned: rows.length };
      await manifestStore.writeManifestHeader({ queryFn, runId, kind, market: options.market, dryRun: false, options: manifestOptions, now });
      await manifestStore.writeManifestPlan({ queryFn, runId, kind, market: options.market, now, rows });
      let result;
      try {
        result = await revertTrim({ queryFn, rows, batchSize: options.batchSize, runInClient, manifest: runId, market: options.market, log, now });
      } catch (err) {
        await manifestStore.finalizeManifestHeader({ queryFn, runId, kind, opsStatus: 'failed', error: err && err.message ? err.message : String(err), options: manifestOptions, now });
        throw err;
      }
      await manifestStore.finalizeManifestHeader({ queryFn, runId, kind, opsStatus: 'passed', batchesWritten: result.batches, rows: result.reverted, sha256: result.digest.digest(), options: manifestOptions, now });
      reverted = result.reverted;
      manifestLine = { manifest_run_id: runId, rows: result.reverted, batches: result.batches, sha256: result.digest.digest() };
      log(`MANIFEST ${JSON.stringify(manifestLine)}`);
    }
    const report = { schema_version: 'relgraph_fan_in_trim_revert.v1', generated_at: nowIso, dry_run: !options.apply, source: options.revert || options.revertFile || `provenance:${options.revertFromProvenance}`, source_rows: rows.length, source_sha256: source.sha256 || null, reverted, manifest: manifestLine };
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
  let manifestLine = null;
  if (options.apply) {
    const kind = 'fan_in_trim';
    const runId = manifestStore.manifestRunId(kind, now);
    const manifestOptions = { market: options.market, cap: options.cap, queued_fresh_days: options.queuedFreshDays, ranked_by: options.rescoredManifest ? 'rescored_manifest' : 'stored_score_total', rows_planned: plan.rows_to_trim, candidates_planned: plan.candidates_affected };
    await manifestStore.writeManifestHeader({ queryFn, runId, kind, market: options.market, dryRun: false, options: manifestOptions, now });
    // Write-ahead: every planned row with its before-values lands BEFORE the first write.
    const planChunks = await manifestStore.writeManifestPlan({ queryFn, runId, kind, market: options.market, now, rows: plan.patches });
    log(`MANIFEST_PLAN ${JSON.stringify({ manifest_run_id: runId, rows_planned: plan.patches.length, plan_chunks: planChunks })}`);
    const byCandidate = new Map();
    for (const patch of plan.patches) {
      if (!byCandidate.has(patch.candidate_ref)) byCandidate.set(patch.candidate_ref, []);
      byCandidate.get(patch.candidate_ref).push(patch);
    }
    const digest = manifestStore.createManifestDigest();
    let batches = 0;
    try {
      for (const [candidateRef, patches] of byCandidate.entries()) {
        const batchIndex = batches + 1;
        // eslint-disable-next-line no-await-in-loop
        const landed = await runInClient((client) => applyTrimForCandidate({ client, candidateRef, patches, nowIso, manifest: runId, batchIndex, market: options.market }));
        batches += 1;
        trimmed += landed.length;
        digest.add(landed);
        for (const line of manifestStore.manifestLogLines(runId, batchIndex, landed)) log(line);
      }
    } catch (err) {
      await manifestStore.finalizeManifestHeader({ queryFn, runId, kind, opsStatus: 'failed', batchesWritten: batches, rows: trimmed, sha256: digest.digest(), error: err && err.message ? err.message : String(err), options: manifestOptions, now });
      throw err;
    }
    await manifestStore.finalizeManifestHeader({ queryFn, runId, kind, opsStatus: 'passed', batchesWritten: batches, rows: trimmed, sha256: digest.digest(), options: manifestOptions, now });
    manifestLine = { manifest_run_id: runId, rows: trimmed, batches, sha256: digest.digest() };
    log(`MANIFEST ${JSON.stringify(manifestLine)}`);
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
      anchor_groups_to_trim: new Set(plan.patches.map((p) => `${p.candidate_ref}|${normalizeLower(p.anchor_ref, 260)}`)).size,
      candidates_affected: plan.candidates_affected,
      human_approved_conflicts: plan.human_approved_conflicts.length,
      by_previous_state: plan.by_previous_state,
      trimmed,
    },
    manifest: manifestLine,
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
  loadRevertRowsFromProvenance,
  planCandidateTrim,
  planFanInTrim,
  revertTrim,
  run,
};
