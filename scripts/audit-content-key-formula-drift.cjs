#!/usr/bin/env node
'use strict';
/**
 * audit-content-key-formula-drift — the standing invariant for issue #1916.
 *
 * INVARIANT
 * ---------
 * For every catalog_products row minted on or after WATERMARK, the stored content_key
 * must equal `makeContentKey(brand, title, gtin)` — the one minter, mirrored from
 * pivota-backend/services/catalog_identity.py.
 *
 * WHY A WATERMARK AND NOT "ALL ROWS"
 * ----------------------------------
 * Two retired generations are baked into the corpus and will never reproduce:
 *
 *   v0-d2c      ck = sha256(norm(brand)\n norm(title)\n norm(url))   1,260 rows, all 2026-05
 *   v0-retailer ck = sha256(norm(brand)\n norm(title))                 340 rows, all 2026-05
 *
 * Both were replaced by v1 on 2026-05-25 and nothing has minted under them since.
 * Re-keying 1,600 live rows to satisfy an audit would rewrite index_pipeline_state
 * primary keys for no serving benefit, so the audit is watermarked instead: the
 * decision is "existing keys are immutable, new keys are reproducible", and the
 * watermark is where that promise starts. Rows below it are counted and reported,
 * never failed on.
 *
 * MEASURED 2026-08-07 at watermark 2026-06-02: 6,960 rows above it, 6,952 reproduce
 * under v1, 8 are input-rewritten, 0 carry a retired generation, 0 rogue clusters.
 * Audit is green — and green for the right reason this time, see the watermark note.
 *
 * The audit also reports rows ABOVE the watermark whose recompute misses — that is
 * the real signal. Three outcomes, separated in the output:
 *   - `formula_drift`  a RETIRED generation above the watermark → a retired minter is
 *                      running again. Fails.
 *   - `suspected_rogue_minters`  unreproducible rows CONCENTRATED in one
 *                      (source_system, day) bucket → a formula nobody has catalogued.
 *                      Fails. This is the case the audit exists for and the one the
 *                      first version could not see (below).
 *   - `input_rewritten` unreproducible but DIFFUSE → brand/title edited after minting
 *                      (content repairs, brand-surface patches). Stored keys are
 *                      immutable by contract, so this is expected: counted, not
 *                      failed on. A spike still means a rewrite path is running hot.
 *
 * WHY THE VERDICT READS THE CLUSTERS (this script's own bug, fixed here)
 * ---------------------------------------------------------------------
 * The first version gated `ok` on `formula_drift` alone. But `formula_drift` only ever
 * incremented in the RETIRED-generation branch — a brand-new formula fell through to
 * `input_rewritten`, which nothing gated. Fed 400 rows minted by a rogue MD5 formula
 * and dated two months above the watermark, it reported `formula_drift: 0`, `ok: true`,
 * exit 0. It printed the rogue cluster in the report and then ignored it.
 *
 * An audit that cannot see the defect class it was built for is worse than no audit,
 * because it is believed. The verdict now reads the clusters.
 *
 * MEASURED BASELINE (prod, 2026-08-07, 14,104 keyed rows)
 *   v1 (current)      12,441   88.2%
 *   v0-d2c             1,260    8.9%   all created <= 2026-05-25
 *   v0-retailer          340    2.4%   all created <= 2026-05-25
 *   input_rewritten       63    0.4%
 *   fourth formula         0    0.0%   <- what this audit exists to keep at zero
 *
 * USAGE
 *   railway run -e production -s PIVOTA-Agent node scripts/audit-content-key-formula-drift.cjs
 *   node scripts/audit-content-key-formula-drift.cjs --watermark 2026-05-25 --out reports/x.json
 *
 * Exit 1 on any of: a retired generation above the watermark, a concentrated cluster
 * of unreproducible keys, or the frozen retired-generation count moving at all.
 * Read-only: issues SELECTs only (see the note at the read-only marker below).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { makeContentKey } = require('../src/services/contentKey');

// v1 became the minter on 2026-05-25 (pivota-backend, "Centralize content key
// computation"), but the watermark is set a week later, at 2026-06-02, and the gap is
// deliberate. Two things sit between the two dates and neither is drift:
//   - 2026-05-25 is the cutover day itself — 19 rows minted before that day's deploy
//     carry v0-d2c, which a date-granular watermark cannot separate from the rows
//     minted after it.
//   - 2026-05-30 through 2026-06-01 hold 9 rows from the "Ownist" demo cohort, minted
//     by a checkout that had not picked up the change (5 under ownist_test_fixture_v1).
//     The last of them, ts_test_ownist_001_p4, is stored at 2026-06-01 01:32.
//
// That last row is why this date is 06-02 and not 06-01, and the correction is worth
// recording: the original watermark was chosen from timestamps read back through the
// timezone bug this PR fixes. Run from Asia/Shanghai, the buggy comparison shifted it
// to 2026-05-31 and skipped it, so the audit reported green while a retired-generation
// row sat above the line. Fixing the comparison surfaced it immediately. A watermark is
// only as trustworthy as the clock used to pick it.
//
// Do not move this date forward to silence a failure: a new red here means a minter
// other than contentKey.js is running, which is the whole point.
const DEFAULT_WATERMARK = '2026-06-02';

// Frozen count of rows carrying a retired generation, measured on prod 2026-08-07.
// These rows are immutable; the number may only shrink (via deletion), never grow.
const RETIRED_GENERATION_BASELINE = 1600;

/**
 * A (source_system, day) bucket with at least this many unreproducible rows is treated
 * as a rogue minter rather than post-mint editing, and FAILS the audit.
 *
 * Calibrated against the measured shape on prod 2026-08-07: the largest genuine
 * input-rewrite bucket above the watermark is 3 rows, and the whole rewrite population
 * is 8 rows spread over 5 buckets. A real minter writes every row of a run — the
 * smallest mirror batch observed in writer_audit_log is in the hundreds. So 25 sits an
 * order of magnitude above the noise and an order of magnitude below any real batch.
 * If a legitimate rewrite job ever trips this, raise it WITH a measurement, and say
 * what you measured — do not nudge it until the red goes away.
 */
const ROGUE_MINTER_CLUSTER_MIN = 25;

const PAGE_SIZE = 2500;

const WATERMARK_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse and VALIDATE. Both flags are compared/used without coercion downstream, so a
 * malformed value does not error — it quietly changes the answer:
 *
 *   --watermark 2026-6-2   the natural non-zero-padded spelling of the default.
 *                          `'2026-07-01' >= '2026-6-2'` is FALSE at index 5 ('0'<'6'),
 *                          so EVERY row reads as below the line and a corpus holding a
 *                          400-row rogue cluster reports a clean green, exit 0.
 *   --limit -1 / 2.5       `rows.length = -1` throws RangeError, caught upstream, so
 *                          the process exits 1 with EMPTY stdout — indistinguishable
 *                          from a real audit failure to anything machine-readable.
 *   --limit abc            Number('abc') is NaN, falsy, silently ignored: full scan
 *                          under a flag that says otherwise.
 *
 * The header invites hand-typed watermarks, so this is a typo away, not an attack.
 * Fail loudly on the flag rather than silently on the verdict.
 */
function parseArgs(argv) {
  const out = { watermark: DEFAULT_WATERMARK, out: '', limit: 0 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--watermark') out.watermark = String(argv[++i] || DEFAULT_WATERMARK);
    else if (arg === '--out') out.out = String(argv[++i] || '');
    else if (arg === '--limit') out.limit = Number(argv[++i] || 0);
  }
  if (!WATERMARK_RE.test(out.watermark)) {
    throw new Error(
      `--watermark must be YYYY-MM-DD with zero padding, got ${JSON.stringify(out.watermark)}. ` +
        'An unpadded or malformed date compares as below every row and reports a false green.',
    );
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

// --- retired generations, kept only so the audit can NAME what it found ------------
// These are historical shapes, not fallbacks. Nothing calls them to mint.

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
 * The wall-clock day a row was minted, as `YYYY-MM-DD`.
 *
 * `catalog_products.created_at` is `timestamp without time zone` — a wall clock with
 * no zone. node-postgres parses it into a JS Date interpreted in the RUNNER'S LOCAL
 * ZONE, so comparing it against `new Date('2026-06-01T00:00:00Z')` silently shifts the
 * watermark by the runner's offset. Measured with this repo's own pg-types: run from
 * Asia/Shanghai, rows minted 2026-06-01 00:00-07:59 classify as BELOW the watermark
 * and are skipped entirely — a false-green window whose width depends on who runs the
 * audit. From US Pacific it shifts the other way and fails rows that are fine.
 *
 * The authoritative fix is server-side: the query selects
 * `to_char(created_at, 'YYYY-MM-DD') AS mint_day`, so the day never passes through a
 * JS Date at all. This function is the fallback for callers holding a raw value.
 *
 * Note which getters it uses, and why `toISOString()` is WRONG here: pg placed the
 * stored digits into LOCAL-time slots, so the local getters read them back unchanged,
 * while `toISOString()` re-converts to UTC and re-introduces exactly the offset shift
 * we are trying to remove. (The first attempt at this fix used `toISOString()` and was
 * wrong in the same direction as the bug — the test below is what caught it.)
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

/** Lexicographic compare of `YYYY-MM-DD` — no zone arithmetic, no Date coercion. */
function isAboveWatermark(createdAt, watermark) {
  const day = mintDay(createdAt);
  return day ? day >= watermark : false;
}

/** Prefer the day Postgres formatted; fall back to the raw value only if absent. */
function rowMintDay(row) {
  return asString(row.mint_day) || mintDay(row.created_at);
}

/**
 * THE VERDICT. Pure, exported, and directly tested — because this is precisely where
 * the audit was wrong.
 *
 * The first version computed the rogue clusters, PRINTED them in the report, and then
 * gated `ok` on `formula_drift` alone — which only ever incremented in the retired-
 * generation branch. Rows minted by a brand-new formula fell through to
 * `input_rewritten`, which nothing read. Fed 400 rows from a rogue MD5 minter dated
 * two months above the watermark, it returned `ok: true` and exit 0.
 *
 * Keeping this inline in `main()` is what made it untestable, and untestable is how it
 * stayed wrong: a first pass at these regression tests exercised the clustering helper
 * and still passed with the verdict stubbed to `[]`. Test the verdict, not the
 * ingredients.
 *
 * @param {object} counts   per-generation tallies
 * @param {Array}  clusters ALL clusters, not the truncated display sample
 */
function computeVerdict(counts, clusters) {
  const rogue = (clusters || []).filter(
    (c) => c.unreproducible_rows >= ROGUE_MINTER_CLUSTER_MIN,
  );
  // `!==`, not `>`. The retired population is frozen: those rows are immutable and
  // nothing mints under those formulas any more. `>` let one retired row being deleted
  // pay for one being newly minted, netting to green — a swap this audit must not miss.
  // A legitimate deletion is therefore expected to fail here once, and the fix is to
  // re-baseline the constant deliberately, which is the point.
  const retiredTotal = (counts.v0_d2c_url || 0) + (counts.v0_retailer || 0);
  const retiredMoved = retiredTotal !== RETIRED_GENERATION_BASELINE;
  return {
    rogue,
    retiredTotal,
    retiredMoved,
    ok: (counts.formula_drift || 0) === 0 && !retiredMoved && rogue.length === 0,
  };
}

/**
 * Which generation, if any, reproduces this row's stored key.
 *
 * catalog_products.gtin records the GTIN the row has NOW, not the one the minter held
 * at mint time — the seed mirrors pass gtin=None even for rows that later acquire one.
 * So v1 is checked both ways. Both are the same formula; the pair only tells us
 * whether the minter had a GTIN, which is why they share one verdict.
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

/**
 * Assemble the report — INCLUDING `ok`. Pure, exported, and directly tested.
 *
 * This is extracted for the same reason `computeVerdict` was, and the reason is worth
 * stating because the mistake recurred: an earlier revision called `computeVerdict`,
 * destructured its `ok`, and then re-derived the identical expression inline when
 * building this object. The tested function's answer was discarded and the SHIPPED
 * verdict was an untested copy — hardcoding `ok: true` there passed every test.
 *
 * A source-level test that greps for `computeVerdict(counts, allClusters)` does not
 * help: the call still exists, its result is simply unused. Grepping for the wiring is
 * not testing the wiring. The only fix that holds is making the object the tests
 * construct the same object production emits, which is what this function is for.
 *
 * `generated_at` is injected so the output is deterministic under test.
 */
function buildReport({ counts, drift = [], suspects = [], allClusters = [], watermark, generatedAt }) {
  const { rogue, retiredTotal, retiredMoved, ok } = computeVerdict(counts, allClusters);
  return {
    generated_at: generatedAt || new Date().toISOString(),
    watermark,
    timezone_note:
      'created_at is `timestamp without time zone`; the day comes from Postgres via ' +
      "to_char(), never from a JS Date in the runner's zone — see the header.",
    counts,
    retired_generation_baseline: RETIRED_GENERATION_BASELINE,
    retired_generation_total: retiredTotal,
    retiredMoved,
    rogue_minter_cluster_min: ROGUE_MINTER_CLUSTER_MIN,
    drift_sample: drift.slice(0, 50),
    unreproducible_clusters: suspects,
    suspected_rogue_minters: rogue,
    rogue,
    ok,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  // eslint-disable-next-line global-require
  const { closePool, query } = require('../src/db');

  // NOTE: this is a best-effort marker, NOT a guarantee, and the header used to claim
  // otherwise. `query()` is `pool.query()` — a checkout per call across a pool of
  // DB_POOL_MAX connections — so the setting lands on one arbitrary connection, is not
  // inside a transaction, and is discarded by a pool reset. The real guarantee here is
  // that this script only ever issues SELECTs; keep it that way.
  await query('SET default_transaction_read_only = on', []);

  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    // eslint-disable-next-line no-await-in-loop
    const res = await query(
      `
        SELECT product_key, brand, title, gtin, canonical_url, content_key, created_at,
               to_char(created_at, 'YYYY-MM-DD') AS mint_day,
               source_system, suppression_reason
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

  const counts = {
    total: rows.length,
    above_watermark: 0,
    below_watermark: 0,
    v1_current: 0,
    v0_d2c_url: 0,
    v0_retailer: 0,
    unreproducible: 0,
    formula_drift: 0,
    input_rewritten: 0,
  };
  const drift = [];

  for (const row of rows) {
    const generation = identifyGeneration(row);
    counts[generation] = (counts[generation] || 0) + 1;
    const above = rowMintDay(row) >= args.watermark;
    if (above) counts.above_watermark += 1;
    else counts.below_watermark += 1;

    if (generation === 'v1_current') continue;
    if (!above) continue;

    // Above the watermark and not reproducible under v1. A retired generation up here
    // means a retired minter is running again — that is drift. Anything else is a
    // post-mint rewrite of brand/title, which the immutability contract allows.
    if (generation === 'v0_d2c_url' || generation === 'v0_retailer') {
      counts.formula_drift += 1;
      drift.push({ ...summarize(row), classification: 'retired_generation_above_watermark', generation });
    } else {
      counts.input_rewritten += 1;
    }
  }

  // A fourth formula lands in `unreproducible` and is indistinguishable from an input
  // rewrite ROW BY ROW. It is distinguishable in AGGREGATE: a rewrite is diffuse
  // (content repairs touch scattered rows over months), a new minter is concentrated
  // (one source_system, a tight created_at window, every row it wrote).
  const { shown: suspects, all: allClusters } = clusterUnreproducible(rows, args.watermark);

  const report = buildReport({ counts, drift, suspects, allClusters, watermark: args.watermark });
  const { rogue, retiredTotal, retiredMoved } = report;

  console.log(JSON.stringify(report, null, 2));
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  await closePool();

  if (!report.ok) {
    const reasons = [];
    if (counts.formula_drift > 0) {
      reasons.push(
        `${counts.formula_drift} row(s) above the ${args.watermark} watermark carry a ` +
          'RETIRED content_key generation — a retired minter is running again',
      );
    }
    if (rogue.length) {
      const worst = rogue
        .slice(0, 3)
        .map((c) => `${c.source_system} on ${c.day} (${c.unreproducible_rows} rows)`)
        .join(', ');
      reasons.push(
        `${rogue.length} concentrated cluster(s) of unreproducible keys — ${worst}. ` +
          'That shape is a minter, not post-mint editing: something is writing ' +
          'content_key with a formula this repo does not know',
      );
    }
    if (retiredMoved) {
      reasons.push(
        `retired-generation total moved: ${retiredTotal} vs frozen baseline ` +
          `${RETIRED_GENERATION_BASELINE} — those rows are supposed to be immutable`,
      );
    }
    console.error(`\nFAIL:\n  - ${reasons.join('\n  - ')}`);
    process.exitCode = 1;
  }
}

function summarize(row) {
  return {
    product_key: row.product_key,
    content_key: row.content_key,
    brand: row.brand,
    title: asString(row.title).slice(0, 120),
    created_at: row.created_at,
    source_system: row.source_system,
    recomputed: makeContentKey(asString(row.brand), asString(row.title), null),
  };
}

/**
 * Group unreproducible rows above the watermark by (source_system, created day). A
 * diffuse spread is post-mint editing; a dense cluster is a new minter. Reported so a
 * human can tell them apart without re-running the whole investigation.
 */
function clusterUnreproducible(rows, watermark, generationOf = identifyGeneration) {
  const byBucket = new Map();
  for (const row of rows) {
    if (!(rowMintDay(row) >= watermark)) continue;
    if (generationOf(row) !== 'unreproducible') continue;
    const bucket = `${row.source_system || 'null'}::${rowMintDay(row)}`;
    byBucket.set(bucket, (byBucket.get(bucket) || 0) + 1);
  }
  const clusters = Array.from(byBucket.entries())
    .map(([bucket, count]) => {
      const [source_system, day] = bucket.split('::');
      return { source_system, day, unreproducible_rows: count };
    })
    .sort((a, b) => b.unreproducible_rows - a.unreproducible_rows);
  // No silent truncation: the verdict reads this list, so a dropped cluster is a
  // dropped failure. Report the count that was cut rather than just slicing.
  const shown = clusters.slice(0, 25);
  if (clusters.length > shown.length) {
    console.error(
      `note: ${clusters.length - shown.length} further cluster(s) omitted from the ` +
        'sample; the verdict still considers all of them.',
    );
  }
  return { shown, all: clusters };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  buildReport,
  identifyGeneration,
  rowMintDay,
  computeVerdict,
  clusterUnreproducible,
  isAboveWatermark,
  mintDay,
  DEFAULT_WATERMARK,
  ROGUE_MINTER_CLUSTER_MIN,
  RETIRED_GENERATION_BASELINE,
};
