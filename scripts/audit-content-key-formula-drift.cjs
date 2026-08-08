#!/usr/bin/env node
'use strict';
/**
 * audit-content-key-formula-drift — the standing invariant for issue #1916.
 *
 * THE INVARIANT
 * -------------
 * Every catalog_products row carrying a content_key must be reproducible by a KNOWN
 * minter. There are exactly three, and each row is classified by RECOMPUTING them:
 *
 *   v1_current   makeContentKey(brand, title, gtin) — the live authority, mirrored
 *                from pivota-backend/services/catalog_identity.py
 *   v0_d2c_url   sha256(norm(brand)\n norm(title)\n norm(url))   retired 2026-05-25
 *   v0_retailer  sha256(norm(brand)\n norm(title))               retired 2026-05-25
 *
 * Anything reproducible by none of them is `unreproducible`. The two retired
 * populations and the unreproducible population are FROZEN at measured counts, and the
 * audit fails when any of them moves, in either direction.
 *
 * That is the whole gate. No date watermark, no volume threshold.
 *
 * WHY IT IS SHAPED THIS WAY (two heuristics measured and discarded)
 * ----------------------------------------------------------------
 * Earlier revisions tried to separate "a rogue minter wrote these" from "brand/title was
 * edited after minting", because both look identical row-by-row: the stored key no
 * longer recomputes. Two discriminators were proposed and BOTH measured dead on this
 * corpus (prod, 2026-08-07, 14,104 rows):
 *
 *   CONCENTRATION — cluster unreproducible rows by (source_system, mint day) and fail a
 *   dense bucket, on the theory that a minter writes a whole run at once while edits are
 *   diffuse. But ingest is batchy and later repairs target those same cohorts, so the
 *   two populations correlate along the very axis meant to separate them. Measured: the
 *   largest genuine input-rewrite bucket in prod today is 33 rows — already above any
 *   threshold that would also catch a small rogue minter. It misfires on data that
 *   exists right now, and a minter writing 24 rows a day or fanning across source
 *   systems passed straight through it.
 *
 *   WRITE TIME — use `updated_at - created_at`, on the theory that a mint writes both
 *   together while a rewrite leaves a gap of days. Measured medians: correctly-minted v1
 *   rows 47.7 days, rewritten rows 82.2 days, retired rows 75.0 days, and 0.0% of v1
 *   rows have a sub-day gap. The mirrors re-run constantly and every upsert bumps
 *   `updated_at`, so nothing separates. Watermarking on `updated_at` would be worse
 *   still: it is recent for essentially every row, so the whole table — including the
 *   1,600 retired rows — would land above the line.
 *
 * Both failures point at the same thing: do not try to infer INTENT from shape. The
 * population sizes are known exactly, so freeze them. A ratchet cannot be evaded by a
 * minter that writes slowly, spreads across source systems, backdates created_at, or
 * emits nulls — every one of which defeated the concentration gate. The cost is that a
 * legitimate content repair also moves the number and must be re-baselined deliberately.
 * That cost IS the value, and it matches the sentinel-ratchet convention this repo
 * already uses for ADR-009 (see 15a635ee: code-literal baseline + non-growth audit).
 *
 * MEASURED BASELINE (prod, 2026-08-07, 14,104 keyed rows — sums exactly)
 *   v1_current      12,441   88.2%
 *   v0_d2c_url       1,260    8.9%   retired formula, all minted <= 2026-06-01
 *   v0_retailer        340    2.4%   retired formula, all minted <= 2026-05-25
 *   unreproducible      63    0.4%   brand/title edited after minting
 *
 * WHEN THIS GOES RED
 * ------------------
 * Read `unreproducible_clusters` first — it names the (source_system, day) buckets those
 * rows sit in. It is DIAGNOSTIC ONLY and decides nothing. If a cluster matches a content
 * repair you just ran, re-baseline the constant WITH the new measurement and say what
 * you measured. If it does not, something is writing content_key with a formula this
 * repo does not know, which is the whole reason this script exists.
 *
 * Do not widen a baseline into a tolerance band to stop a red. A band reintroduces
 * exactly the "how do we know this number is right" problem that killed both heuristics
 * above.
 *
 * USAGE
 *   railway run -e production -s PIVOTA-Agent node scripts/audit-content-key-formula-drift.cjs
 *   node scripts/audit-content-key-formula-drift.cjs --out reports/x.json
 *
 * Exit 1 when any frozen population has moved. Read-only: issues SELECTs only (see the
 * note at the read-only marker below).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { makeContentKey } = require('../src/services/contentKey');

/**
 * Frozen population counts, measured on prod 2026-08-07 over all 14,104 keyed rows.
 *
 * Ratchets, not estimates. Each may only change when a human re-measures and says so.
 * `!==`, not `>`: a retired row being deleted must not pay for a new one being minted,
 * and an unreproducible row being repaired must not pay for a fresh fork.
 */
const RETIRED_D2C_BASELINE = 1260;
const RETIRED_RETAILER_BASELINE = 340;
const UNREPRODUCIBLE_BASELINE = 63;

const PAGE_SIZE = 2500;

/**
 * Parse and VALIDATE. `--limit` is used without coercion downstream, so a malformed
 * value does not error — it quietly changes the answer. `-1` and `2.5` made
 * `rows.length = n` throw RangeError, which exited 1 with EMPTY stdout, indistinguishable
 * from a real audit failure to anything machine-readable; `abc` was NaN, falsy, and
 * silently ignored, giving a full scan under a flag that said otherwise.
 */
function parseArgs(argv) {
  const out = { out: '', limit: 0 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out.out = String(argv[++i] || '');
    else if (arg === '--limit') out.limit = Number(argv[++i] || 0);
  }
  if (out.limit !== 0 && !(Number.isInteger(out.limit) && out.limit > 0)) {
    throw new Error(`--limit must be a positive integer (or omitted), got ${JSON.stringify(out.limit)}.`);
  }
  return out;
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

// --- retired generations ------------------------------------------------------------
// Kept so the audit can NAME what it found, and so those rows classify as known-legacy
// rather than unreproducible. Historical shapes; nothing calls them to mint.

function retiredNormalize(value) {
  return asString(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function retiredHash(parts) {
  return `ck_${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)}`;
}

function normalizeUrl(value) {
  const raw = asString(value);
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * The wall-clock day a row was minted, as `YYYY-MM-DD` — for the DIAGNOSTIC clusters
 * only. Nothing gates on it.
 *
 * `created_at` is `timestamp without time zone`, which node-postgres parses into a JS
 * Date read in the RUNNER'S zone. The query asks Postgres for the formatted day
 * (`to_char`) so the common path never touches a Date; this is the fallback. Note the
 * LOCAL getters: pg put the stored digits into local-time slots, so local getters read
 * them back unchanged, while `toISOString()` re-converts to UTC and reintroduces the
 * offset. A first attempt at this used `toISOString()` and was wrong in the same
 * direction as the bug it was fixing.
 */
function mintDay(createdAt) {
  if (!createdAt) return '';
  if (createdAt instanceof Date) {
    if (Number.isNaN(createdAt.getTime())) return '';
    const y = createdAt.getFullYear();
    const m = String(createdAt.getMonth() + 1).padStart(2, '0');
    const d = String(createdAt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(createdAt).slice(0, 10);
}

/** Prefer the day Postgres formatted; fall back to the raw value only if absent. */
function rowMintDay(row) {
  return asString(row.mint_day) || mintDay(row.created_at);
}

/**
 * Which known minter reproduces this row's stored key, or `unreproducible`.
 *
 * catalog_products.gtin records the GTIN the row has NOW, not the one the minter held at
 * mint time — the seed mirrors pass gtin=None even for rows that later acquire one. So
 * v1 is checked both ways; both are the same formula, and the pair only tells us whether
 * the minter had a GTIN, which is why they share one verdict.
 */
function identifyGeneration(row) {
  const brand = asString(row.brand);
  const title = asString(row.title);
  const stored = asString(row.content_key);
  if (!stored) return 'no_key';
  const gtin = asString(row.gtin);
  if (makeContentKey(brand, title, null) === stored) return 'v1_current';
  if (gtin && makeContentKey(brand, title, gtin) === stored) return 'v1_current';
  if (retiredHash([retiredNormalize(brand), retiredNormalize(title), retiredNormalize(normalizeUrl(row.canonical_url))]) === stored) {
    return 'v0_d2c_url';
  }
  if (retiredHash([retiredNormalize(brand), retiredNormalize(title)]) === stored) return 'v0_retailer';
  return 'unreproducible';
}

/** Tally every row by generation. No date filter — that absence is the point. */
function classifyRows(rows, generationOf = identifyGeneration) {
  const counts = {
    total: rows.length,
    v1_current: 0,
    v0_d2c_url: 0,
    v0_retailer: 0,
    unreproducible: 0,
    no_key: 0,
  };
  const unreproducible = [];
  for (const row of rows) {
    const generation = generationOf(row);
    counts[generation] = (counts[generation] || 0) + 1;
    if (generation === 'unreproducible') unreproducible.push(row);
  }
  return { counts, unreproducible };
}

/**
 * Group unreproducible rows by (source_system, mint day). DIAGNOSTIC ONLY — it decides
 * nothing, it tells a human where to look when the ratchet trips.
 *
 * This used to BE the gate, and it was measured wrong in both directions: prod's largest
 * genuine rewrite bucket is 33 rows, above any threshold that would also catch a small
 * rogue minter, while a minter writing 24 rows a day passed straight through.
 */
function clusterUnreproducible(rows) {
  const byBucket = new Map();
  for (const row of rows || []) {
    const bucket = `${row.source_system || 'null'}::${rowMintDay(row) || 'unknown'}`;
    byBucket.set(bucket, (byBucket.get(bucket) || 0) + 1);
  }
  return Array.from(byBucket.entries())
    .map(([bucket, count]) => {
      const [source_system, day] = bucket.split('::');
      return { source_system, day, unreproducible_rows: count };
    })
    .sort((a, b) => b.unreproducible_rows - a.unreproducible_rows);
}

/**
 * THE VERDICT. Pure, exported, directly tested — because this is exactly where the audit
 * has been wrong twice.
 *
 * First it gated on a counter that only ever incremented for retired generations, so a
 * brand-new formula scored zero and reported green. Then, after that was fixed, `main()`
 * re-derived the expression inline while building the report, so the tested function's
 * answer was discarded and hardcoding `ok: true` passed every test. Both are one
 * mistake: a value computed, reported, and then not read.
 *
 * Everything deciding `ok` is computed here and `buildReport` returns it verbatim. Do
 * not re-derive any of it at the call site.
 */
function computeVerdict(counts) {
  const populations = [
    { name: 'v0_d2c_url', actual: (counts && counts.v0_d2c_url) || 0, baseline: RETIRED_D2C_BASELINE },
    { name: 'v0_retailer', actual: (counts && counts.v0_retailer) || 0, baseline: RETIRED_RETAILER_BASELINE },
    { name: 'unreproducible', actual: (counts && counts.unreproducible) || 0, baseline: UNREPRODUCIBLE_BASELINE },
  ];
  const moved = populations
    .filter((p) => p.actual !== p.baseline)
    .map((p) => ({ ...p, delta: p.actual - p.baseline }));
  return { populations, moved, ok: moved.length === 0 };
}

/**
 * Assemble the report INCLUDING `ok`. Pure, exported, tested — see computeVerdict for
 * why this is not inlined into main(). `generatedAt` is injected so the output is
 * deterministic under test.
 */
function buildReport({ counts, unreproducibleSample = [], clusters = [], generatedAt, sampled = false }) {
  const verdict = computeVerdict(counts);
  return {
    generated_at: generatedAt || new Date().toISOString(),
    contract:
      'every content_key must be reproducible by a known minter; the retired and ' +
      'unreproducible populations are frozen at measured counts',
    sampled,
    counts,
    populations: verdict.populations,
    moved_populations: verdict.moved,
    unreproducible_clusters: clusters,
    unreproducible_sample: unreproducibleSample.slice(0, 50),
    ok: verdict.ok,
  };
}

function summarize(row) {
  return {
    product_key: row.product_key,
    content_key: row.content_key,
    brand: row.brand,
    title: asString(row.title).slice(0, 120),
    mint_day: rowMintDay(row),
    source_system: row.source_system,
    recomputed: makeContentKey(asString(row.brand), asString(row.title), null),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  // eslint-disable-next-line global-require
  const { closePool, query } = require('../src/db');

  // NOTE: best-effort marker, NOT a guarantee, and an earlier header claimed otherwise.
  // `query()` is `pool.query()` — a checkout per call across a pool — so this lands on
  // one arbitrary connection, is not inside a transaction, and is discarded by the retry
  // path's pool reset. The real guarantee is that this script only issues SELECTs.
  await query('SET default_transaction_read_only = on', []);

  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    // eslint-disable-next-line no-await-in-loop
    const res = await query(
      `
        SELECT product_key, brand, title, gtin, canonical_url, content_key, created_at,
               to_char(created_at, 'YYYY-MM-DD') AS mint_day,
               source_system
        FROM catalog_products
        WHERE content_key IS NOT NULL
        ORDER BY product_key
        LIMIT $1 OFFSET $2
      `,
      [PAGE_SIZE, offset],
    );
    rows.push(...(res.rows || []));
    if ((res.rows || []).length < PAGE_SIZE) break;
    if (args.limit && rows.length >= args.limit) break;
  }
  // --limit is a sampling cap for local runs. It previously only stopped PAGING, so
  // `--limit 100` scored 2,500 rows and the report silently disagreed with the flag.
  if (args.limit && rows.length > args.limit) rows.length = args.limit;

  const { counts, unreproducible } = classifyRows(rows);
  const report = buildReport({
    counts,
    unreproducibleSample: unreproducible.map(summarize),
    clusters: clusterUnreproducible(unreproducible),
    sampled: Boolean(args.limit),
  });

  console.log(JSON.stringify(report, null, 2));
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  await closePool();

  if (!report.ok) {
    const lines = report.moved_populations.map(
      (p) => `${p.name}: ${p.actual} vs frozen baseline ${p.baseline} (${p.delta > 0 ? '+' : ''}${p.delta})`,
    );
    console.error(
      `\nFAIL: a frozen content_key population moved.\n  - ${lines.join('\n  - ')}\n\n` +
        'Read unreproducible_clusters above — it names where those rows sit. If a cluster\n' +
        'matches a content repair you just ran, re-baseline the constant WITH the new\n' +
        'measurement. If it does not, something is writing content_key with a formula this\n' +
        'repo does not know.',
    );
    if (args.limit) {
      console.error(
        '\nNOTE: --limit was set, so these counts come from a SAMPLE and cannot be ' +
          'compared to corpus-wide baselines. Re-run without --limit before acting.',
      );
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  classifyRows,
  buildReport,
  computeVerdict,
  identifyGeneration,
  clusterUnreproducible,
  rowMintDay,
  mintDay,
  RETIRED_D2C_BASELINE,
  RETIRED_RETAILER_BASELINE,
  UNREPRODUCIBLE_BASELINE,
};
