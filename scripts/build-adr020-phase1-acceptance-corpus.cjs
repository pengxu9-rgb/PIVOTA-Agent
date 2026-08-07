#!/usr/bin/env node
'use strict';

/**
 * ADR-020 Phase 1 — rebuild the acceptance corpus from judged parity reports.
 *
 * Reads one or more scripts/audit-recall-lane-parity.cjs reports, applies the
 * relevance rubric in scripts/lib/adr020_recall_relevance.cjs to BOTH lanes,
 * and emits tests/fixtures/adr020_phase1_gap_scope.json.
 *
 * WHAT CHANGED vs THE 2026-07-30 FIXTURE
 * --------------------------------------
 *   - The corpus is in-domain. The parity harness defaulted to a generic
 *     multi-category recall corpus run against what is effectively a beauty
 *     catalog, so "running shoes" / "black leather sneakers" / "aroma diffuser"
 *     had no correct answers in the data at all. Those buckets are dropped.
 *   - A gap now requires a RELEVANCE JUDGEMENT. The old fixture recorded the
 *     raw parity diff, so anything the seed lane happened to substring-match
 *     became an acceptance target (Ombré *Leather* Eau de Parfum for "black
 *     leather sneakers"). A gap is now "a product graded RELEVANT that the seed
 *     lane returned and the catalog lane did not".
 *   - Both lanes are judged, so the report carries catalog-lane precision
 *     rather than only the seed lane's diff. Without that number a corpus
 *     cannot distinguish "the catalog lane missed a good answer" from "the
 *     catalog lane returned a better one".
 *
 * MULTI-PASS AGREEMENT
 * --------------------
 * The Railway public proxy stalls and individual lane calls intermittently
 * error, so a single pass is not trustworthy. Pass several reports: per query,
 * passes where either lane errored are discarded, and a product is only
 * recorded as a gap when it is missing from the catalog lane in a MAJORITY of
 * the surviving passes. Queries with no clean pass are reported as
 * `unmeasured`, never as gaps.
 *
 * Usage:
 *   node scripts/build-adr020-phase1-acceptance-corpus.cjs \
 *     --report a.json --report b.json --report c.json \
 *     [--out tests/fixtures/adr020_phase1_gap_scope.json]
 *
 * Read-only: consumes report JSON, writes one fixture. No database access.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  GRADE,
  GRADE_LABEL,
  judgeProduct,
  hasRubric,
} = require('./lib/adr020_recall_relevance.cjs');

const DEFAULT_OUT = 'tests/fixtures/adr020_phase1_gap_scope.json';
const CORPUS_PATH = 'tests/fixtures/adr020_phase1_recall_corpus.jsonl';
const RUBRIC_PATH = 'scripts/lib/adr020_recall_relevance.cjs';

function argValues(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === `--${name}`) {
      const v = process.argv[i + 1];
      if (v && !v.startsWith('--')) out.push(v);
    }
  }
  return out;
}

function argValue(name, fallback = '') {
  return argValues(name)[0] ?? fallback;
}

function productKeyOf(item) {
  return (
    item.external_product_id ||
    item.product_key ||
    `${String(item.brand ?? '')}|${String(item.title ?? '')}`
  );
}

/** Every product the seed lane returned for a query row. */
function seedReturns(row) {
  return [
    ...(row.matches || []).map((m) => m.seed),
    ...(row.only_in_seed || []),
  ].filter(Boolean);
}

/** Every product the catalog lane returned for a query row. */
function catalogReturns(row) {
  return [
    ...(row.matches || []).map((m) => m.catalog),
    ...(row.only_in_catalog || []),
  ].filter(Boolean);
}

function gradeCounts(items, query) {
  const counts = { relevant: 0, partial: 0, irrelevant: 0, unjudged: 0 };
  for (const item of items) {
    const j = judgeProduct(query, item);
    if (!j) counts.unjudged += 1;
    else counts[j.grade_label] += 1;
  }
  return counts;
}

/**
 * Collapse N passes of one query into a single judged verdict.
 * `cleanRows` are rows where neither lane errored.
 */
/**
 * Under a stalling Railway proxy a lane can return an EMPTY result set without
 * throwing, so `catalog_count: 0` is indistinguishable from a timeout. Observed
 * 2026-08-07: "concealer for dark circles" returned 8/8 in a healthy pass
 * (4-6s lane latency) and 0/0 in a degraded one (35-40s). Averaging those
 * together manufactures a deficit that is a transport artifact.
 *
 * A zero is therefore only believed when EVERY clean pass agrees on it. If any
 * pass proves a lane can return rows for this query, passes where that lane
 * came back empty are dropped as stalls. This is deliberately asymmetric:
 * returning N products proves those N exist; returning none proves nothing
 * while the transport is unreliable.
 */
function dropStalledPasses(cleanRows) {
  const maxSeed = Math.max(0, ...cleanRows.map((r) => Number(r.seed_count) || 0));
  const maxCatalog = Math.max(0, ...cleanRows.map((r) => Number(r.catalog_count) || 0));
  const kept = cleanRows.filter(
    (r) =>
      ((Number(r.seed_count) || 0) > 0 || maxSeed === 0) &&
      ((Number(r.catalog_count) || 0) > 0 || maxCatalog === 0),
  );
  // Two passes can stall on opposite lanes and eliminate each other; never
  // collapse a query to zero observations.
  return kept.length ? kept : cleanRows;
}

function collapseQuery(query, meta, allCleanRows) {
  const cleanRows = dropStalledPasses(allCleanRows);
  const passCount = cleanRows.length;
  const stalledPasses = allCleanRows.length - passCount;
  const seenSeed = new Map(); // key -> {item, missingFromCatalog}
  const catalogRelevantPerPass = [];
  const seedRelevantPerPass = [];
  const catalogTotalPerPass = [];
  const seedTotalPerPass = [];

  for (const row of cleanRows) {
    const catalogItems = catalogReturns(row);
    const seedItems = seedReturns(row);
    catalogTotalPerPass.push(catalogItems.length);
    seedTotalPerPass.push(seedItems.length);
    catalogRelevantPerPass.push(gradeCounts(catalogItems, query).relevant);
    seedRelevantPerPass.push(gradeCounts(seedItems, query).relevant);

    const catalogKeys = new Set(catalogItems.map(productKeyOf));
    for (const item of seedItems) {
      const key = productKeyOf(item);
      const entry = seenSeed.get(key) || { item, missing: 0 };
      if (!catalogKeys.has(key)) entry.missing += 1;
      seenSeed.set(key, entry);
    }
  }

  const majority = Math.floor(passCount / 2) + 1;
  const missingRelevant = [];
  const rejected = [];

  for (const { item, missing } of seenSeed.values()) {
    const judged = judgeProduct(query, item);
    if (!judged) continue;
    const record = {
      external_product_id: item.external_product_id || null,
      brand: item.brand || null,
      title: item.title || null,
      grade: judged.grade,
      grade_label: judged.grade_label,
      forms: judged.forms,
      judgement: judged.reason,
      missing_from_catalog_in_passes: `${missing}/${passCount}`,
    };
    if (judged.grade === GRADE.RELEVANT && missing >= majority) missingRelevant.push(record);
    else if (missing >= majority) rejected.push(record);
  }

  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0);
  const seedRelevant = avg(seedRelevantPerPass);
  const catalogRelevant = avg(catalogRelevantPerPass);

  /**
   * A relevant product the catalog lane missed is only a DEFECT when the
   * catalog lane is also SHORT on relevant answers for that query. The two
   * lanes barely overlap (mean overlap@k ~0.04), so without this test every
   * relevant seed result would score as a gap even on queries where the
   * catalog returned eight equally-relevant DIFFERENT products — which is the
   * same mistake the 2026-07-30 corpus made, one level up. "vanilla perfume"
   * is the worked example: the catalog misses the seed lane's lip balms and
   * returns actual eaux de parfum instead.
   */
  const relevanceDeficit = Math.max(0, Math.round((seedRelevant - catalogRelevant) * 100) / 100);
  const isDeficit = relevanceDeficit > 0;

  return {
    query,
    bucket: meta.bucket || null,
    lang: meta.lang || null,
    passes_clean: passCount,
    passes_dropped_as_stalled: stalledPasses,
    seed_returned_avg: avg(seedTotalPerPass),
    catalog_returned_avg: avg(catalogTotalPerPass),
    seed_relevant_avg: seedRelevant,
    catalog_relevant_avg: catalogRelevant,
    relevance_deficit: relevanceDeficit,
    // Acceptance targets: only the queries where the catalog lane actually
    // returns FEWER relevant answers than the seed lane.
    acceptance_target: isDeficit,
    true_gap_count: isDeficit ? missingRelevant.length : 0,
    true_gaps: isDeficit
      ? missingRelevant.sort((a, b) => String(a.title).localeCompare(String(b.title)))
      : [],
    // Relevant seed products the catalog lane does not return, on queries where
    // the catalog is already as good or better. Recorded for audit; closing
    // these is a substitution, not a recall win.
    substitutable_misses: isDeficit
      ? []
      : missingRelevant.sort((a, b) => String(a.title).localeCompare(String(b.title))),
    // Products the old parity-diff fixture would have made acceptance targets.
    rejected_by_relevance: rejected.sort(
      (a, b) => a.grade - b.grade || String(a.title).localeCompare(String(b.title)),
    ),
  };
}

function main() {
  const reportPaths = argValues('report');
  if (!reportPaths.length) {
    console.error('at least one --report <path> is required');
    process.exitCode = 1;
    return;
  }
  const outPath = argValue('out', DEFAULT_OUT);

  const reports = reportPaths.map((p) => ({
    path: p,
    data: JSON.parse(fs.readFileSync(path.resolve(p), 'utf8')),
  }));

  // query -> {meta, rowsByPass[]}
  const byQuery = new Map();
  for (const { data } of reports) {
    for (const row of data.per_query || []) {
      const entry = byQuery.get(row.query) || {
        meta: { bucket: row.bucket, lang: row.lang },
        rows: [],
        errored: 0,
      };
      if (row.seed_error || row.catalog_error) entry.errored += 1;
      else entry.rows.push(row);
      byQuery.set(row.query, entry);
    }
  }

  const judged = [];
  const unmeasured = [];
  const unjudgedQueries = [];

  for (const [query, entry] of byQuery) {
    if (!hasRubric(query)) {
      unjudgedQueries.push(query);
      continue;
    }
    if (!entry.rows.length) {
      unmeasured.push({ query, reason: 'every pass errored on at least one lane' });
      continue;
    }
    judged.push(collapseQuery(query, entry.meta, entry.rows));
  }

  judged.sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)) || a.query.localeCompare(b.query));

  const gapQueries = judged.filter((q) => q.true_gap_count > 0);
  const gapProductIds = new Set();
  for (const q of gapQueries) for (const p of q.true_gaps) gapProductIds.add(p.external_product_id);

  const rejectedTotal = judged.reduce((acc, q) => acc + q.rejected_by_relevance.length, 0);
  const substitutableTotal = judged.reduce((acc, q) => acc + q.substitutable_misses.length, 0);
  const catalogEmpty = judged.filter((q) => q.catalog_returned_avg === 0);
  const catalogNoRelevant = judged.filter(
    (q) => q.catalog_returned_avg > 0 && q.catalog_relevant_avg === 0,
  );
  const measured = judged.filter((q) => q.seed_returned_avg > 0 || q.catalog_returned_avg > 0);
  const catalogWins = measured.filter((q) => q.catalog_relevant_avg > q.seed_relevant_avg);
  const sumRelevant = (rows, key) => Math.round(rows.reduce((a, q) => a + q[key], 0) * 100) / 100;
  const sumReturned = (rows, key) => Math.round(rows.reduce((a, q) => a + q[key], 0) * 100) / 100;
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

  const fixture = {
    generated_at: new Date().toISOString(),
    source: `build-adr020-phase1-acceptance-corpus.cjs over ${reports.length} audit-recall-lane-parity.cjs pass(es) vs prod`,
    corpus: CORPUS_PATH,
    rubric: RUBRIC_PATH,
    supersedes: {
      fixture_generated_at: '2026-07-30T11:36:39.299Z',
      what_it_was: 'raw seed-vs-catalog parity diff over a generic multi-category corpus, no relevance judgement',
      why_replaced:
        'the generic corpus had no correct answers in a beauty catalog, so seed-lane substring hits (Ombré Leather Eau de Parfum for "black leather sneakers", tinted moisturizers for "running shoes") became acceptance targets; tuning the ranker to reproduce it would degrade results',
    },
    method: {
      gap_definition:
        'a product graded RELEVANT by the rubric that the seed lane returned and the catalog lane did not, in a majority of error-free passes, ON A QUERY WHERE THE CATALOG LANE RETURNS FEWER RELEVANT ANSWERS THAN THE SEED LANE',
      why_the_deficit_test:
        'the lanes barely overlap, so without it every relevant seed result scores as a gap even where the catalog returned eight equally-relevant different products',
      grades: GRADE_LABEL,
      both_lanes_judged: true,
      passes: reports.map((r) => ({
        path: r.path,
        generated_at: r.data.generated_at,
        market: r.data.market,
        limit: r.data.limit,
      })),
    },
    summary: {
      queries_in_corpus: byQuery.size,
      queries_judged: judged.length,
      queries_unmeasured: unmeasured.length,
      queries_without_rubric: unjudgedQueries.length,
      gap_query_count: gapQueries.length,
      gap_product_count: gapProductIds.size,
      products_rejected_by_relevance: rejectedTotal,
      products_substitutable_not_gaps: substitutableTotal,
      queries_catalog_beats_seed: catalogWins.length,
      queries_measured: measured.length,
      lane_precision: {
        seed_relevant_total: sumRelevant(measured, 'seed_relevant_avg'),
        seed_returned_total: sumReturned(measured, 'seed_returned_avg'),
        seed_precision_pct: pct(
          sumRelevant(measured, 'seed_relevant_avg'),
          sumReturned(measured, 'seed_returned_avg'),
        ),
        catalog_relevant_total: sumRelevant(measured, 'catalog_relevant_avg'),
        catalog_returned_total: sumReturned(measured, 'catalog_returned_avg'),
        catalog_precision_pct: pct(
          sumRelevant(measured, 'catalog_relevant_avg'),
          sumReturned(measured, 'catalog_returned_avg'),
        ),
      },
      queries_catalog_returned_nothing: catalogEmpty.map((q) => q.query),
      queries_catalog_returned_nothing_relevant: catalogNoRelevant.map((q) => q.query),
    },
    unmeasured,
    queries: judged,
  };

  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(fixture, null, 1)}\n`);

  console.log(JSON.stringify(fixture.summary, null, 2));
  console.log(`\nfixture written: ${resolved}`);
  if (unjudgedQueries.length) {
    console.log(`\nqueries with no rubric (add one to ${RUBRIC_PATH}):`);
    for (const q of unjudgedQueries) console.log(`  - ${q}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { collapseQuery, seedReturns, catalogReturns, gradeCounts, productKeyOf };
