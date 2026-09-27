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
// Dry-run by default. --apply requires --confirm APPLY_RELGRAPH_RESCORE. Every run writes a
// manifest (--out) with old -> new values per row; --revert <manifest> --apply --confirm restores
// the old values where the current value is still the new one. Idempotent: a row whose stored
// score already equals the projection is skipped, and the UPDATE is guarded on the expected old
// value.
//
//   node scripts/rescore-relationship-edge-scores.js --market US --out /tmp/rescore.json
//   node scripts/rescore-relationship-edge-scores.js --market US --out /tmp/rescore.json --apply --confirm APPLY_RELGRAPH_RESCORE
//   node scripts/rescore-relationship-edge-scores.js --revert /tmp/rescore.json --apply --confirm APPLY_RELGRAPH_RESCORE

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const { DUPE_MIN_SCORE_TOTAL } = require('../src/auroraBff/productRelationshipGraph');
const {
  __internal: { scoreCandidateForAnchor, sourceStrength },
} = require('../src/auroraBff/productRelationshipGraphSources');

const CONFIRM_TOKEN = 'APPLY_RELGRAPH_RESCORE';
const FORMULA_ID = 'graded_pair_evidence_v2';
const DEFAULT_MARKET = 'US';
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_RELATION_TYPES = ['dupe', 'competitive_alternative', 'related_product'];
const DEFAULT_LABEL_STATES = ['human_approved', 'ai_approved', 'generated', 'review_ready'];
const LIVE_LABEL_STATES = new Set(['human_approved', 'ai_approved']);
const SCORE_EPSILON = 0.00005;
// Same constant as productRelationshipGraphSources.TRANSITIVE_HOP_DECAY_FLOOR (not exported).
const TRANSITIVE_HOP_DECAY_FLOOR = 0.75;
const TRANSITIVE_SOURCE_TYPE = 'relationship_graph_transitive_recall';
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
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
// scored (missing snapshots).
function projectRescore(row = {}) {
  const anchorSnapshot = isPlainObject(row.anchor_snapshot) ? row.anchor_snapshot : null;
  const candidateSnapshot = isPlainObject(row.candidate_snapshot) ? row.candidate_snapshot : null;
  if (!anchorSnapshot || !candidateSnapshot) return null;
  const refs = Array.isArray(row.source_refs) ? row.source_refs : [];
  const types = sourceTypes(refs);
  const anchor = stripScoreFields(anchorSnapshot);
  const candidate = { ...stripScoreFields(candidateSnapshot), source_refs: refs };
  const legacyMatch = types.includes('aurora_dupe_kb');
  const intelMatch = types.includes('product_intel_kb');
  const score = scoreCandidateForAnchor(anchor, candidate, { legacyMatch, intelMatch });
  let scoreTotal = Number(score.score_total || 0);
  let hop = null;
  if (types.includes(TRANSITIVE_SOURCE_TYPE)) {
    const stored = Number(candidateSnapshot.transitive_path_confidence);
    hop = Number.isFinite(stored) && stored > 0 && stored <= 1 ? stored : 0;
    scoreTotal *= TRANSITIVE_HOP_DECAY_FLOOR + (1 - TRANSITIVE_HOP_DECAY_FLOOR) * hop;
  }
  const oldBreakdown = isPlainObject(row.score_breakdown) ? row.score_breakdown : {};
  const newBreakdown = {
    category_use_case_match: roundScore(score.category_use_case_match),
    ingredient_functional_similarity: roundScore(score.ingredient_functional_similarity),
    ...(oldBreakdown.skin_fit_similarity != null ? { skin_fit_similarity: roundScore(oldBreakdown.skin_fit_similarity) } : {}),
    price_advantage: roundScore(score.price_advantage),
    evidence_quality: roundScore(score.evidence_quality),
    availability_confidence: roundScore(score.availability_confidence),
    social_reference_strength: roundScore(score.social_reference_strength),
    score_total: roundScore(scoreTotal),
  };
  return {
    id: row.id,
    relation_type: normalizeLower(row.relation_type, 64),
    label_state: normalizeLower(row.label_state, 40),
    old_score_total: row.score_total == null ? null : roundScore(row.score_total),
    new_score_total: roundScore(scoreTotal),
    old_score_breakdown: oldBreakdown,
    new_score_breakdown: newBreakdown,
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

// Batched, guarded UPDATE of score fields only. A row is written only while its score_total is
// still the value the manifest recorded (expected), so a rerun or a concurrent change is a no-op.
async function applyScorePatches({ queryFn, patches = [], batchSize = DEFAULT_BATCH_SIZE } = {}) {
  let written = 0;
  const size = parseInteger(batchSize, DEFAULT_BATCH_SIZE, { min: 1, max: 5000 });
  for (let idx = 0; idx < patches.length; idx += size) {
    const chunk = patches.slice(idx, idx + size).map((p) => ({
      id: p.id,
      expected_score_total: p.expected_score_total,
      score_total: p.score_total,
      score_breakdown: p.score_breakdown,
    }));
    // eslint-disable-next-line no-await-in-loop
    const res = await queryFn(
      `
        WITH patch AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(
            id text, expected_score_total double precision, score_total double precision, score_breakdown jsonb
          )
        )
        UPDATE relationship_candidate_labels AS l
        SET score_total = patch.score_total,
            score_breakdown = patch.score_breakdown
        FROM patch
        WHERE l.id = patch.id
          AND l.score_total IS NOT DISTINCT FROM patch.expected_score_total
        RETURNING l.id
      `,
      [JSON.stringify(chunk)],
    );
    written += Array.isArray(res && res.rows) ? res.rows.length : Number(res && res.rowCount || 0);
  }
  return written;
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
    revert: normalizeString(argValue(argv, 'revert'), 2000),
    ids: idsFile ? JSON.parse(fs.readFileSync(idsFile, 'utf8')) : [],
  };
}

function writeJson(target, payload) {
  if (!target) return;
  const resolved = path.isAbsolute(target) ? target : path.join(process.cwd(), target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function run(argv = process.argv.slice(2), { queryFn = query, now = new Date() } = {}) {
  const options = parseArgs(argv);
  const nowIso = now.toISOString();

  if (options.revert) {
    const manifest = JSON.parse(fs.readFileSync(options.revert, 'utf8'));
    const rows = Array.isArray(manifest.rows) ? manifest.rows : [];
    const patches = rows
      .filter((row) => row.old_score_total != null)
      .map((row) => ({ id: row.id, expected_score_total: row.new_score_total, score_total: row.old_score_total, score_breakdown: row.old_score_breakdown }));
    const written = options.apply ? await applyScorePatches({ queryFn, patches, batchSize: options.batchSize }) : 0;
    const report = { schema_version: 'relgraph_rescore_revert.v1', generated_at: nowIso, dry_run: !options.apply, manifest: options.revert, rows: patches.length, reverted: written };
    writeJson(options.out, report);
    return report;
  }

  const rows = await loadRows({ queryFn, ...options });
  const projections = rows.map(projectRescore).filter(Boolean);
  const summary = summarizeProjections(projections);
  const patches = projections
    .filter((p) => !isUnchanged(p))
    .map((p) => ({ id: p.id, expected_score_total: p.old_score_total, score_total: p.new_score_total, score_breakdown: { ...p.new_score_breakdown, rescored_at: nowIso, rescore_formula: FORMULA_ID } }));
  const written = options.apply ? await applyScorePatches({ queryFn, patches, batchSize: options.batchSize }) : 0;
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
  gateFindings,
  isUnchanged,
  projectRescore,
  run,
  summarizeProjections,
};
