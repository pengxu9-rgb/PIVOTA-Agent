#!/usr/bin/env node
'use strict';

// Rescore stored relationship-graph labels with the CURRENT similarity formula.
//
// Why: the 8,503 edges built in June carry scores from the old `max(channels) + constants`
// formula (mean 0.97). Serving orders edges by score_total DESC, so on a shared anchor every one
// of them outranks any edge the #2290/#2293 formula produces (0.7x). This script recomputes
// score_total and score_breakdown for stored rows from their stored snapshots, using exactly the
// builder's path: productRelationshipGraphSources.scoreCandidateForAnchor (base + graded pair
// evidence; provenance in evidence_quality) and, for two-hop rows, the same hop decay
// (TRANSITIVE_HOP_DECAY_FLOOR). It touches ONLY score_total and score_breakdown: never
// label_state, expires_at, reviewed_at or updated_at (updated_at feeds the AI-review cutoff and
// the fan-in freshness window; a rescore must not re-queue or refresh anything).
//
// Dry-run by default. --apply requires --confirm APPLY_RELGRAPH_RESCORE. An apply writes its
// revert manifest DURABLY (src/services/relgraphOpsManifest.js: one ledger row per applied batch,
// in the batch's own transaction, plus a header with totals and sha256; the container's /tmp is
// gone when the job ends) and echoes each batch to stdout as RELGRAPH_OPS_MANIFEST log lines.
// --revert <run_id> --apply --confirm reads the ledger and restores the old values where the
// current value is still the new one; --revert-file <path> does the same from a local file
// (a dry-run --out, or log lines rebuilt with decodeManifestLogLines). Idempotent: a row whose
// stored score already equals the projection is skipped, and every UPDATE is guarded on the
// expected old value.
//
//   node scripts/rescore-relationship-edge-scores.js --market US --out /tmp/rescore.json
//   node scripts/rescore-relationship-edge-scores.js --market US --apply --confirm APPLY_RELGRAPH_RESCORE
//   node scripts/rescore-relationship-edge-scores.js --revert <run_id> --apply --confirm APPLY_RELGRAPH_RESCORE

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');
const { DUPE_MIN_SCORE_TOTAL } = require('../src/auroraBff/productRelationshipGraph');
const manifestStore = require('../src/services/relgraphOpsManifest');
const {
  __internal: { scoreCandidateForAnchor, sourceStrength, TRANSITIVE_HOP_DECAY_FLOOR },
} = require('../src/auroraBff/productRelationshipGraphSources');

const CONFIRM_TOKEN = 'APPLY_RELGRAPH_RESCORE';
const FORMULA_ID = 'graded_pair_evidence_v2';
const DEFAULT_MARKET = 'US';
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_RELATION_TYPES = ['dupe', 'competitive_alternative', 'related_product'];
const DEFAULT_LABEL_STATES = ['human_approved', 'ai_approved', 'generated', 'review_ready'];
const LIVE_LABEL_STATES = new Set(['human_approved', 'ai_approved']);
const SCORE_EPSILON = 0.00005;
const TRANSITIVE_SOURCE_TYPE = 'relationship_graph_transitive_recall';
const TRANSITIVE_ROUNDING_TOLERANCE = 0.00015;
const CATEGORY_MIN_FOR_ALTERNATIVES = 0.55;
// Fields the builder itself carries on a candidate that describe a score, never a product. They
// ride along inside stored snapshots (coerceRelationshipEdge copies the object) and must not be
// read as an explicit similarity by the scorer.
const SCORE_FIELDS_ON_SNAPSHOT = [
  'similarity_score', 'similarityScore', 'score_total', 'scoreTotal', 'vector_score', 'score_breakdown', 'scoreBreakdown',
  'category_use_case_match', 'ingredient_functional_similarity', 'price_advantage', 'evidence_quality',
  'availability_confidence', 'social_reference_strength', 'transitive_path_confidence', 'transitive_bridge_ref',
];

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

function parseList(value, fallback) {
  const items = String(value == null ? '' : value).split(/[,\s]+/).map((item) => normalizeLower(item, 64)).filter(Boolean);
  return items.length ? items : fallback;
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  // An absent flag is the fallback, never 0-clamped-to-min (that made the default batch size 1 and
  // the default cap 1).
  if (value == null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The column default is '{}'; an empty snapshot cannot be scored and must be skipped, not scored 0.
function isEmptySnapshot(value) {
  return !isPlainObject(value) || Object.keys(value).length === 0;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function sourceTypes(sourceRefs) {
  return (Array.isArray(sourceRefs) ? sourceRefs : [])
    .map((ref) => normalizeLower(isPlainObject(ref) ? ref.type || ref.source_type || ref.source : ref, 80))
    .filter(Boolean);
}

function stripScoreFields(snapshot) {
  const out = { ...(isPlainObject(snapshot) ? snapshot : {}) };
  for (const key of SCORE_FIELDS_ON_SNAPSHOT) delete out[key];
  return out;
}

function roundScore(value) {
  return Number(Number(value || 0).toFixed(4));
}

// Pure. Projects the current-formula score for one stored row. Returns null when the row cannot be
// scored (missing or empty snapshots).
//
// Two-hop rows reproduce productRelationshipGraphSources.buildTransitiveRecallCandidate exactly:
// the direct score is computed with intelMatch only (the builder never passes legacyMatch on the
// transitive path; a bridge's aurora_dupe_kb ref must not lift category by +0.12), score_total is
// the direct total decayed by the stored path confidence, category / ingredient keep the bridged
// values the builder stored (they need the bridge, which the row no longer has, and they do not
// feed score_total), and evidence_quality is floored at 0.68 as the builder does.
function projectRescore(row = {}) {
  const anchorSnapshot = isPlainObject(row.anchor_snapshot) ? row.anchor_snapshot : null;
  const candidateSnapshot = isPlainObject(row.candidate_snapshot) ? row.candidate_snapshot : null;
  if (isEmptySnapshot(anchorSnapshot) || isEmptySnapshot(candidateSnapshot)) return null;
  const refs = Array.isArray(row.source_refs) ? row.source_refs : [];
  const types = sourceTypes(refs);
  const transitive = types.includes(TRANSITIVE_SOURCE_TYPE);
  const anchor = stripScoreFields(anchorSnapshot);
  const candidate = { ...stripScoreFields(candidateSnapshot), source_refs: refs };
  const legacyMatch = !transitive && types.includes('aurora_dupe_kb');
  const intelMatch = types.includes('product_intel_kb');
  const score = scoreCandidateForAnchor(anchor, candidate, { legacyMatch, intelMatch });
  let scoreTotal = Number(score.score_total || 0);
  let hop = null;
  let categoryUseCase = score.category_use_case_match;
  let ingredientSimilarity = score.ingredient_functional_similarity;
  let evidenceQuality = score.evidence_quality;
  let availabilityConfidence = score.availability_confidence;
  let socialReferenceStrength = score.social_reference_strength;
  const oldBreakdown = isPlainObject(row.score_breakdown) ? row.score_breakdown : {};
  if (transitive) {
    const stored = Number(candidateSnapshot.transitive_path_confidence);
    hop = Number.isFinite(stored) && stored > 0 && stored <= 1 ? stored : 0;
    scoreTotal = clamp01(scoreTotal * (TRANSITIVE_HOP_DECAY_FLOOR + (1 - TRANSITIVE_HOP_DECAY_FLOOR) * hop));
    const storedCategory = Number(candidateSnapshot.category_use_case_match);
    const storedIngredient = Number(candidateSnapshot.ingredient_functional_similarity);
    categoryUseCase = clamp01(Math.max(score.category_use_case_match, Number.isFinite(storedCategory) ? storedCategory : 0));
    ingredientSimilarity = clamp01(Math.max(score.ingredient_functional_similarity, Number.isFinite(storedIngredient) ? storedIngredient : 0));
    // The builder derived these from the second hop's OWN source refs before merging the bridge's
    // refs into the stored row; the merge cannot be undone, and none of them feed score_total, so
    // the stored values are the builder's values and are kept.
    const storedNumber = (key) => (Number.isFinite(Number(oldBreakdown[key])) ? clamp01(oldBreakdown[key]) : null);
    evidenceQuality = storedNumber('evidence_quality') ?? clamp01(Math.max(score.evidence_quality, 0.68));
    availabilityConfidence = storedNumber('availability_confidence') ?? score.availability_confidence;
    socialReferenceStrength = storedNumber('social_reference_strength') ?? score.social_reference_strength;
  }
  // Two-hop precision: the builder rounds the stored path confidence to 4 decimals before we see
  // it, so the recomputed total can differ from the builder's own by 1e-4 with no formula change.
  // Within that precision the stored total IS the current-formula value and is kept verbatim.
  const recomputedScoreTotal = roundScore(scoreTotal);
  const storedTotal = row.score_total == null ? null : Number(row.score_total);
  if (transitive && storedTotal != null && Math.abs(storedTotal - recomputedScoreTotal) <= TRANSITIVE_ROUNDING_TOLERANCE) {
    scoreTotal = storedTotal;
  }
  const newBreakdown = {
    category_use_case_match: roundScore(categoryUseCase),
    ingredient_functional_similarity: roundScore(ingredientSimilarity),
    ...(oldBreakdown.skin_fit_similarity != null ? { skin_fit_similarity: roundScore(oldBreakdown.skin_fit_similarity) } : {}),
    price_advantage: roundScore(score.price_advantage),
    evidence_quality: roundScore(evidenceQuality),
    availability_confidence: roundScore(availabilityConfidence),
    social_reference_strength: roundScore(socialReferenceStrength),
    score_total: roundScore(scoreTotal),
  };
  return {
    id: row.id,
    relation_type: normalizeLower(row.relation_type, 64),
    label_state: normalizeLower(row.label_state, 40),
    old_score_total: row.score_total == null ? null : roundScore(row.score_total),
    new_score_total: roundScore(scoreTotal),
    old_score_breakdown: isPlainObject(row.score_breakdown) ? row.score_breakdown : null,
    new_score_breakdown: newBreakdown,
    recomputed_score_total: recomputedScoreTotal,
    transitive_hop_confidence: hop,
    source_strength: roundScore(sourceStrength(refs)),
  };
}

function gateFindings(projection) {
  const findings = [];
  if (projection.relation_type === 'dupe' && projection.new_score_total < DUPE_MIN_SCORE_TOTAL) findings.push('dupe_below_floor');
  if ((projection.relation_type === 'dupe' || projection.relation_type === 'competitive_alternative')
    && Number(projection.new_score_breakdown.category_use_case_match || 0) < CATEGORY_MIN_FOR_ALTERNATIVES) {
    findings.push('category_below_threshold');
  }
  return findings;
}

function bucket(value) {
  return (Math.round(Number(value || 0) * 20) / 20).toFixed(2);
}

function isUnchanged(projection) {
  if (projection.old_score_total == null) return false;
  if (Math.abs(projection.old_score_total - projection.new_score_total) >= SCORE_EPSILON) return false;
  const old = projection.old_score_breakdown || {};
  return Object.entries(projection.new_score_breakdown).every(([key, value]) => Math.abs(Number(old[key] ?? NaN) - value) < SCORE_EPSILON);
}

// Rows the run cannot score: counted, never patched.
function summarizeSkipped(rows = [], projections = []) {
  const scored = new Set(projections.map((p) => p.id));
  const skipped = rows.filter((row) => !scored.has(row.id));
  return { skipped_empty_snapshot: skipped.length, skipped_ids: skipped.slice(0, 50).map((row) => row.id) };
}

// Pure. Summarises projections into the report shape.
function summarizeProjections(projections = []) {
  const oldHist = {};
  const newHist = {};
  const byRelation = {};
  const gates = { dupe_below_floor: { total: 0, serving: 0 }, category_below_threshold: { total: 0, serving: 0 } };
  let unchanged = 0;
  for (const p of projections) {
    if (p.old_score_total != null) oldHist[bucket(p.old_score_total)] = (oldHist[bucket(p.old_score_total)] || 0) + 1;
    newHist[bucket(p.new_score_total)] = (newHist[bucket(p.new_score_total)] || 0) + 1;
    const rel = byRelation[p.relation_type] || (byRelation[p.relation_type] = { rows: 0, old_mean: 0, new_mean: 0 });
    rel.rows += 1;
    rel.old_mean += Number(p.old_score_total || 0);
    rel.new_mean += p.new_score_total;
    if (isUnchanged(p)) unchanged += 1;
    for (const finding of gateFindings(p)) {
      gates[finding].total += 1;
      if (LIVE_LABEL_STATES.has(p.label_state)) gates[finding].serving += 1;
    }
  }
  for (const rel of Object.values(byRelation)) {
    rel.old_mean = rel.rows ? roundScore(rel.old_mean / rel.rows) : 0;
    rel.new_mean = rel.rows ? roundScore(rel.new_mean / rel.rows) : 0;
  }
  const sortHist = (h) => Object.fromEntries(Object.entries(h).sort());
  return {
    rows: projections.length,
    unchanged,
    to_update: projections.length - unchanged,
    old_score_histogram: sortHist(oldHist),
    new_score_histogram: sortHist(newHist),
    by_relation_type: byRelation,
    gate_findings: gates,
  };
}

async function loadRows({ queryFn, market, allMarkets, relationTypes, labelStates, limit, ids }) {
  const params = [relationTypes, labelStates];
  const where = ['relation_type = ANY($1::text[])', 'label_state = ANY($2::text[])', "anchor_type = 'product'"];
  if (!allMarkets) {
    params.push(normalizeLower(market, 24) || 'us');
    where.push(`lower(market) = $${params.length}`);
  }
  if (Array.isArray(ids) && ids.length) {
    params.push(ids);
    where.push(`id = ANY($${params.length}::text[])`);
  }
  let limitSql = '';
  if (limit > 0) {
    params.push(limit);
    limitSql = `LIMIT $${params.length}`;
  }
  const res = await queryFn(
    `
      SELECT id, market, relation_type, label_state, score_total, score_breakdown, source_refs,
             anchor_snapshot, candidate_snapshot
      FROM relationship_candidate_labels
      WHERE ${where.join(' AND ')}
      ORDER BY id
      ${limitSql}
    `,
    params,
  );
  return Array.isArray(res && res.rows) ? res.rows : [];
}

// Score UPDATE. Besides the two score columns it stamps provenance.rescore_prev = { score_total,
// score_breakdown, run_id } (the before-values) so a revert can work from the row alone; a revert
// (mode 'revert') restores the recorded values and removes the stamp. Nothing else is touched:
// never label_state, expires_at, reviewed_at, updated_at.
async function updateScoreChunk(queryFn, chunk, { runId = null, mode = 'apply' } = {}) {
  const res = await queryFn(
    `
      WITH patch AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(
          id text, expected_score_total double precision, score_total double precision, score_breakdown jsonb, prev jsonb
        )
      )
      UPDATE relationship_candidate_labels AS l
      SET score_total = patch.score_total,
          score_breakdown = patch.score_breakdown,
          provenance = CASE WHEN $2 = 'revert'
            THEN COALESCE(l.provenance, '{}'::jsonb) - 'rescore_prev'
            ELSE jsonb_set(COALESCE(l.provenance, '{}'::jsonb), '{rescore_prev}', patch.prev, true) END
      FROM patch
      WHERE l.id = patch.id
        AND l.score_total IS NOT DISTINCT FROM patch.expected_score_total
      RETURNING l.id
    `,
    [JSON.stringify(chunk.map((p) => ({
      id: p.id,
      expected_score_total: p.expected_score_total,
      score_total: p.score_total,
      score_breakdown: p.score_breakdown,
      prev: { score_total: p.expected_score_total, score_breakdown: p.previous_score_breakdown == null ? null : p.previous_score_breakdown, run_id: runId },
    }))), mode],
  );
  return new Set((Array.isArray(res && res.rows) ? res.rows : []).map((row) => row.id));
}

// Batched, guarded UPDATE of score fields only. A row is written only while its score_total is
// still the value the manifest recorded (expected), so a rerun or a concurrent change is a no-op.
// Each batch runs in ONE transaction together with its manifest row (the rows that actually
// changed, with their old values), so a mid-run failure leaves exactly the batches that landed,
// every one of them revertible. Returns { written, batches, digest }.
async function applyScorePatches({
  queryFn, patches = [], batchSize = DEFAULT_BATCH_SIZE, runInClient = withClient,
  manifest = null, kind = 'rescore', market = 'US', log = () => {}, now = new Date(), mode = 'apply',
} = {}) {
  let written = 0;
  let batches = 0;
  const digest = manifestStore.createManifestDigest();
  const size = parseInteger(batchSize, DEFAULT_BATCH_SIZE, { min: 1, max: 5000 });
  for (let idx = 0; idx < patches.length; idx += size) {
    const chunk = patches.slice(idx, idx + size);
    const batchIndex = batches + 1;
    // eslint-disable-next-line no-await-in-loop
    const landed = await runInClient(async (client) => {
      const clientQuery = (text, params) => client.query(text, params);
      await clientQuery('BEGIN');
      try {
        const ids = await updateScoreChunk(clientQuery, chunk, { runId: manifest, mode });
        const rows = chunk.filter((p) => ids.has(p.id)).map((p) => ({ id: p.id, old_score_total: p.expected_score_total, old_score_breakdown: p.previous_score_breakdown == null ? null : p.previous_score_breakdown, new_score_total: p.score_total, new_score_breakdown: p.score_breakdown }));
        if (manifest) {
          await manifestStore.writeManifestBatch({ queryFn: clientQuery, runId: manifest, kind, market, batchIndex, rows, now });
        }
        await clientQuery('COMMIT');
        return rows;
      } catch (err) {
        try { await clientQuery('ROLLBACK'); } catch { /* surface the original error */ }
        throw err;
      }
    });
    batches += 1;
    written += landed.length;
    digest.add(landed);
    if (manifest) for (const line of manifestStore.manifestLogLines(manifest, batchIndex, landed)) log(line);
  }
  return { written, batches, digest };
}

// Revert without the ledger: rows carry their before-values in provenance.rescore_prev.
async function loadRevertRowsFromProvenance({ queryFn, runId, market }) {
  const res = await queryFn(
    `
      SELECT id, score_total, score_breakdown, provenance->'rescore_prev' AS prev
      FROM relationship_candidate_labels
      WHERE lower(market) = $1
        AND provenance ? 'rescore_prev'
        AND provenance->'rescore_prev'->>'run_id' = $2
      ORDER BY id
    `,
    [normalizeLower(market, 24) || 'us', runId],
  );
  const rows = (Array.isArray(res && res.rows) ? res.rows : []).map((row) => {
    const prev = isPlainObject(row.prev) ? row.prev : {};
    return { id: row.id, old_score_total: prev.score_total == null ? null : Number(prev.score_total), old_score_breakdown: prev.score_breakdown == null ? null : prev.score_breakdown, new_score_total: row.score_total == null ? null : Number(row.score_total), new_score_breakdown: row.score_breakdown };
  });
  return { run_id: runId, rows, sha256: null };
}

function parseArgs(argv = process.argv.slice(2)) {
  const apply = hasFlag(argv, 'apply');
  const confirm = normalizeString(argValue(argv, 'confirm'), 120);
  if (apply && confirm !== CONFIRM_TOKEN) throw new Error(`--apply requires --confirm ${CONFIRM_TOKEN}`);
  const idsFile = normalizeString(argValue(argv, 'ids-file'), 2000);
  return {
    apply,
    market: normalizeString(argValue(argv, 'market', DEFAULT_MARKET), 24).toUpperCase() || DEFAULT_MARKET,
    allMarkets: hasFlag(argv, 'all-markets'),
    relationTypes: parseList(argValue(argv, 'relation-types'), DEFAULT_RELATION_TYPES),
    labelStates: parseList(argValue(argv, 'label-states'), DEFAULT_LABEL_STATES),
    limit: parseInteger(argValue(argv, 'limit'), 0, { min: 0, max: 1000000 }),
    batchSize: parseInteger(argValue(argv, 'batch-size'), DEFAULT_BATCH_SIZE, { min: 1, max: 5000 }),
    out: normalizeString(argValue(argv, 'out'), 2000),
    revert: normalizeString(argValue(argv, 'revert'), 200),
    revertFile: normalizeString(argValue(argv, 'revert-file'), 2000),
    revertFromProvenance: normalizeString(argValue(argv, 'revert-from-provenance'), 200),
    ids: idsFile ? JSON.parse(fs.readFileSync(idsFile, 'utf8')) : [],
  };
}

// Run an apply (or revert) with a durable manifest: header first, batches inside their own
// transactions, header finalised with totals + sha256 whether the run passed or failed.
async function applyWithManifest({ queryFn, runInClient, patches, options, kind, log, now, mode = 'apply' }) {
  const runId = manifestStore.manifestRunId(kind, now);
  const manifestOptions = { market: options.market, relation_types: options.relationTypes, label_states: options.labelStates, batch_size: options.batchSize, rows_planned: patches.length, source: options.revert || options.revertFile || options.revertFromProvenance || null };
  await manifestStore.writeManifestHeader({ queryFn, runId, kind, market: options.market, dryRun: false, options: manifestOptions, now });
  // Write-ahead: the whole plan with every row's before-values lands BEFORE the first write.
  const planChunks = await manifestStore.writeManifestPlan({ queryFn, runId, kind, market: options.market, now, rows: patches.map((p) => ({ id: p.id, old_score_total: p.expected_score_total, old_score_breakdown: p.previous_score_breakdown == null ? null : p.previous_score_breakdown, new_score_total: p.score_total, new_score_breakdown: p.score_breakdown })) });
  log(`MANIFEST_PLAN ${JSON.stringify({ manifest_run_id: runId, rows_planned: patches.length, plan_chunks: planChunks })}`);
  let result = { written: 0, batches: 0, digest: manifestStore.createManifestDigest() };
  try {
    result = await applyScorePatches({ queryFn, runInClient, patches, batchSize: options.batchSize, manifest: runId, kind, market: options.market, log, now, mode });
  } catch (err) {
    // Batches already committed stay in the ledger; the header records the failure.
    await manifestStore.finalizeManifestHeader({ queryFn, runId, kind, opsStatus: 'failed', error: err && err.message ? err.message : String(err), options: manifestOptions, now });
    throw err;
  }
  await manifestStore.finalizeManifestHeader({ queryFn, runId, kind, opsStatus: 'passed', batchesWritten: result.batches, rows: result.written, sha256: result.digest.digest(), options: manifestOptions, now });
  const manifestLine = { manifest_run_id: runId, rows: result.written, batches: result.batches, sha256: result.digest.digest() };
  log(`MANIFEST ${JSON.stringify(manifestLine)}`);
  return { runId, ...result, manifestLine };
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
    const rows = Array.isArray(source.rows) ? source.rows : [];
    // Rows whose old score was NULL revert back to NULL; nothing is dropped.
    const patches = rows
      .map((row) => ({ id: row.id, expected_score_total: row.new_score_total, score_total: row.old_score_total == null ? null : row.old_score_total, score_breakdown: row.old_score_breakdown == null ? null : row.old_score_breakdown, previous_score_breakdown: row.new_score_breakdown }));
    const applied = options.apply ? await applyWithManifest({ queryFn, runInClient, patches, options, kind: 'rescore_revert', log, now, mode: 'revert' }) : null;
    const report = {
      schema_version: 'relgraph_rescore_revert.v1', generated_at: nowIso, dry_run: !options.apply,
      source: options.revert || options.revertFile || `provenance:${options.revertFromProvenance}`, source_rows: rows.length, source_sha256: source.sha256 || null,
      rows: patches.length, reverted: applied ? applied.written : 0, manifest: applied ? applied.manifestLine : null,
    };
    writeJson(options.out, report);
    return report;
  }

  const rows = await loadRows({ queryFn, ...options });
  const projections = rows.map(projectRescore).filter(Boolean);
  const summary = { ...summarizeProjections(projections), ...summarizeSkipped(rows, projections) };
  const patches = projections
    .filter((p) => !isUnchanged(p))
    .map((p) => ({ id: p.id, expected_score_total: p.old_score_total, previous_score_breakdown: p.old_score_breakdown, score_total: p.new_score_total, score_breakdown: { ...p.new_score_breakdown, rescored_at: nowIso, rescore_formula: FORMULA_ID } }));
  const applied = options.apply ? await applyWithManifest({ queryFn, runInClient, patches, options, kind: 'rescore', log, now }) : null;
  const written = applied ? applied.written : 0;
  const report = {
    schema_version: 'relgraph_rescore.v1',
    generated_at: nowIso,
    dry_run: !options.apply,
    formula: FORMULA_ID,
    dupe_min_score_total: DUPE_MIN_SCORE_TOTAL,
    market: options.allMarkets ? 'ALL' : options.market,
    relation_types: options.relationTypes,
    label_states: options.labelStates,
    summary: { ...summary, written },
    manifest: applied ? applied.manifestLine : null,
    rows: projections.map((p) => ({
      id: p.id, relation_type: p.relation_type, label_state: p.label_state,
      old_score_total: p.old_score_total, new_score_total: p.new_score_total,
      old_score_breakdown: p.old_score_breakdown, new_score_breakdown: p.new_score_breakdown,
      gate_findings: gateFindings(p),
    })),
  };
  writeJson(options.out, report);
  return report;
}

if (require.main === module) {
  run()
    .then((report) => { process.stdout.write(`${JSON.stringify({ ...report, rows: undefined }, null, 2)}\n`); })
    .catch((err) => { process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`); process.exitCode = 1; })
    .finally(() => closePool().catch(() => {}));
}

module.exports = {
  CONFIRM_TOKEN,
  FORMULA_ID,
  DEFAULT_LABEL_STATES,
  DEFAULT_RELATION_TYPES,
  applyScorePatches,
  applyWithManifest,
  gateFindings,
  isEmptySnapshot,
  isUnchanged,
  loadRevertRowsFromProvenance,
  projectRescore,
  run,
  summarizeProjections,
};
