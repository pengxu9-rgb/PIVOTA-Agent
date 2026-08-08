'use strict';
/**
 * Regression tests for the content_key drift audit — issue #1916.
 *
 * This script has reported a FALSE GREEN twice, both times on the exact defect class it
 * exists to catch, and both times because a value was computed, reported, and then not
 * read. First `ok` was gated on a counter that only incremented for RETIRED generations,
 * so a brand-new formula scored zero. Then the fix computed a verdict and `main()`
 * re-derived it inline, so hardcoding `ok: true` passed every test.
 *
 * So the rules here are: assert the SHIPPED object, never an upstream ingredient; and
 * every test asserts a way the audit must FAIL. A suite that only checks the green path
 * passed against both broken versions.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const audit = require('../../scripts/audit-content-key-formula-drift.cjs');
const { makeContentKey } = require('../../src/services/contentKey');

const {
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
} = audit;

/** Counts as prod reports them today — the green baseline to perturb. */
const healthyCounts = (over = {}) => ({
  total: 14104,
  v1_current: 12441,
  v0_d2c_url: RETIRED_D2C_BASELINE,
  v0_retailer: RETIRED_RETAILER_BASELINE,
  unreproducible: UNREPRODUCIBLE_BASELINE,
  no_key: 0,
  ...over,
});

const ARGS = { generatedAt: '2026-08-07T00:00:00.000Z' };

/** A row minted by a formula nobody has catalogued — the thing the audit must catch. */
function rogueRow(i, day = '2026-08-01', source = 'rogue_minter_v9') {
  return {
    product_key: `pk_rogue_${i}`,
    brand: `Brand ${i}`,
    title: `Product ${i}`,
    gtin: null,
    canonical_url: `https://example.test/${i}`,
    content_key: `ck_${crypto.createHash('md5').update(`rogue${i}`).digest('hex')}`,
    mint_day: day,
    created_at: new Date(`${day}T04:00:00`),
    source_system: source,
  };
}

function healthyRow(i, day = '2026-07-01') {
  const row = rogueRow(i, day, 'shopify_products_sync');
  row.content_key = makeContentKey(row.brand, row.title, null);
  return row;
}

describe('identifyGeneration', () => {
  test('a row minted by the current authority is v1_current', () => {
    expect(identifyGeneration(healthyRow(1))).toBe('v1_current');
  });

  test('a row minted by an uncatalogued formula is unreproducible', () => {
    expect(identifyGeneration(rogueRow(1))).toBe('unreproducible');
  });

  test('a row with no key is neither, and is not counted as a fork', () => {
    expect(identifyGeneration({ ...rogueRow(1), content_key: null })).toBe('no_key');
  });
});

describe('classifyRows — no date filter, that absence is the point', () => {
  test('rows are tallied by generation regardless of when they were minted', () => {
    // The prior design skipped rows below a watermark, which is exactly how a re-key of
    // a pre-watermark row stayed invisible: the repo's own writers rewrite content_key
    // via ON CONFLICT without touching created_at.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => rogueRow(i, '2026-05-04')), // ancient
      ...Array.from({ length: 3 }, (_, i) => rogueRow(100 + i, '2026-08-01')), // recent
      ...Array.from({ length: 2 }, (_, i) => healthyRow(200 + i)),
    ];
    const { counts, unreproducible } = classifyRows(rows);
    expect(counts.unreproducible).toBe(8);
    expect(counts.v1_current).toBe(2);
    expect(unreproducible).toHaveLength(8);
  });
});

/* These assert the SHIPPED report object, not computeVerdict alone — an earlier suite
 * tested the ingredient and passed while `ok: true` shipped. */
describe('buildReport — the object that is printed and exited on', () => {
  test('green when every frozen population is exactly at baseline', () => {
    expect(buildReport({ counts: healthyCounts(), ...ARGS }).ok).toBe(true);
  });

  test('RED on ONE extra unreproducible row, however it got there', () => {
    // This single assertion covers what the concentration gate could not: a minter
    // writing slowly, fanning across source systems, backdating created_at, or emitting
    // nulls. Shape is irrelevant — the count moved.
    const report = buildReport({ counts: healthyCounts({ unreproducible: UNREPRODUCIBLE_BASELINE + 1 }), ...ARGS });
    expect(report.ok).toBe(false);
    expect(report.moved_populations).toEqual([
      { name: 'unreproducible', actual: UNREPRODUCIBLE_BASELINE + 1, baseline: UNREPRODUCIBLE_BASELINE, delta: 1 },
    ]);
  });

  test('RED on a retired population growing — a retired minter came back', () => {
    expect(buildReport({ counts: healthyCounts({ v0_d2c_url: RETIRED_D2C_BASELINE + 1 }), ...ARGS }).ok).toBe(false);
    expect(buildReport({ counts: healthyCounts({ v0_retailer: RETIRED_RETAILER_BASELINE + 1 }), ...ARGS }).ok).toBe(false);
  });

  test('RED on a frozen population SHRINKING too, not just growing', () => {
    // `>` alone let a deletion pay for a new mint, netting to green. Every population is
    // compared with !== for that reason.
    for (const over of [
      { v0_d2c_url: RETIRED_D2C_BASELINE - 1 },
      { v0_retailer: RETIRED_RETAILER_BASELINE - 1 },
      { unreproducible: UNREPRODUCIBLE_BASELINE - 1 },
    ]) {
      expect(buildReport({ counts: healthyCounts(over), ...ARGS }).ok).toBe(false);
    }
  });

  test('a swap that nets to zero across DIFFERENT populations is still RED', () => {
    // One retired row deleted, one fresh fork minted. The totals balance; the audit
    // must not.
    const report = buildReport({
      counts: healthyCounts({ v0_d2c_url: RETIRED_D2C_BASELINE - 1, unreproducible: UNREPRODUCIBLE_BASELINE + 1 }),
      ...ARGS,
    });
    expect(report.ok).toBe(false);
    expect(report.moved_populations).toHaveLength(2);
  });

  test('report.ok agrees with computeVerdict on every combination', () => {
    // The invariant an inline re-derivation broke.
    for (const over of [{}, { unreproducible: 64 }, { v0_retailer: 339 }, { v0_d2c_url: 1261 }]) {
      const counts = healthyCounts(over);
      expect(buildReport({ counts, ...ARGS }).ok).toBe(computeVerdict(counts).ok);
    }
  });

  test('the emitted report is JSON-serializable and carries the verdict', () => {
    const parsed = JSON.parse(JSON.stringify(buildReport({ counts: healthyCounts(), ...ARGS })));
    expect(parsed.ok).toBe(true);
    expect(parsed.populations).toHaveLength(3);
  });

  test('a --limit run is marked sampled, so its counts are not mistaken for the corpus', () => {
    expect(buildReport({ counts: healthyCounts(), sampled: true, ...ARGS }).sampled).toBe(true);
  });
});

describe('clustering is diagnostic only — it must not decide anything', () => {
  test('a concentrated rogue cluster is reported', () => {
    const clusters = clusterUnreproducible(Array.from({ length: 400 }, (_, i) => rogueRow(i)));
    expect(clusters).toEqual([
      { source_system: 'rogue_minter_v9', day: '2026-08-01', unreproducible_rows: 400 },
    ]);
  });

  test('a large DIFFUSE spread is reported too, and neither shape changes the verdict', () => {
    // The old gate failed both ways: it missed 480 rows spread thin, and it fired on a
    // legitimate 33-row rewrite bucket that exists in prod today. Verdict now depends on
    // the count alone, so both of these are just information.
    const spread = Array.from({ length: 480 }, (_, i) => rogueRow(i, `2026-07-${String((i % 7) + 1).padStart(2, '0')}`, `src_${i % 20}`));
    expect(clusterUnreproducible(spread).length).toBeGreaterThan(20);
    const concentrated = healthyCounts({ unreproducible: UNREPRODUCIBLE_BASELINE + 480 });
    expect(buildReport({ counts: concentrated, clusters: clusterUnreproducible(spread), ...ARGS }).ok).toBe(false);
  });

  test('clusters are ordered densest-first and never truncated', () => {
    // The gate is elsewhere now, so there is no reason to hide any of them.
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => rogueRow(i, '2026-08-01', 'big')),
      ...Array.from({ length: 40 }, (_, i) => rogueRow(1000 + i, `2026-06-${String((i % 28) + 1).padStart(2, '0')}`, `small_${i}`)),
    ];
    const clusters = clusterUnreproducible(rows);
    expect(clusters[0].unreproducible_rows).toBe(30);
    expect(clusters.length).toBeGreaterThan(25);
  });

  test('a null source_system buckets rather than vanishing', () => {
    const clusters = clusterUnreproducible([{ ...rogueRow(1), source_system: null }]);
    expect(clusters[0].source_system).toBe('null');
  });
});

describe('mint day is timezone-independent (diagnostic labels must still be right)', () => {
  // `created_at` is `timestamp without time zone`; pg hands back a Date read in the
  // RUNNER'S zone, so a UTC-based reading shifts the day by the runner's offset.
  //
  // These run in CHILD PROCESSES with TZ fixed, and that is essential. Setting
  // process.env.TZ mid-run does nothing (V8 caches the zone), and no in-process
  // assertion can help either: when local IS UTC the correct and buggy implementations
  // are mathematically identical. Measured — the previous in-process version passed
  // 32/32 with the bug restored under TZ=UTC, i.e. on every CI runner. Only a process
  // that STARTS in another zone can tell them apart.
  const ZONES = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati'];
  const AUDIT = path.join(__dirname, '..', '..', 'scripts', 'audit-content-key-formula-drift.cjs');

  function inZone(zone, expression) {
    return execFileSync(
      process.execPath,
      ['-e', `const a=require(${JSON.stringify(AUDIT)});process.stdout.write(String(${expression}))`],
      { env: { ...process.env, TZ: zone }, encoding: 'utf8' },
    );
  }

  test.each(ZONES)('the stored wall-clock day survives TZ=%s', (zone) => {
    expect(inZone(zone, "a.mintDay(new Date('2026-06-02T00:30:00'))")).toBe('2026-06-02');
    expect(inZone(zone, "a.mintDay(new Date('2026-06-01T23:30:00'))")).toBe('2026-06-01');
  });

  test.each(ZONES)('the Postgres-supplied day wins under TZ=%s', (zone) => {
    // The path production takes: to_char() already formatted it, so no Date is involved.
    expect(
      inZone(zone, "a.rowMintDay({mint_day:'2026-06-02',created_at:new Date('2026-05-01T00:00:00')})"),
    ).toBe('2026-06-02');
    expect(inZone(zone, "a.rowMintDay({created_at:new Date('2026-06-02T00:30:00')})")).toBe('2026-06-02');
  });

  test('a missing or invalid created_at yields no day rather than a wrong one', () => {
    expect(mintDay(null)).toBe('');
    expect(mintDay(new Date('nonsense'))).toBe('');
    expect(rowMintDay({})).toBe('');
  });
});

describe('flag validation — a typo must not become a false green', () => {
  test('--limit rejects values that would crash or be silently ignored', () => {
    expect(() => parseArgs(['node', 'x', '--limit', '-1'])).toThrow(/positive integer/);
    expect(() => parseArgs(['node', 'x', '--limit', '2.5'])).toThrow(/positive integer/);
    expect(() => parseArgs(['node', 'x', '--limit', 'abc'])).toThrow(/positive integer/);
    expect(parseArgs(['node', 'x', '--limit', '100']).limit).toBe(100);
    expect(parseArgs(['node', 'x']).limit).toBe(0);
  });

  test('there is no --watermark to mistype any more', () => {
    // The old flag silently greened everything when spelled 2026-6-2. Removing the date
    // gate removed the flag with it; an unknown flag is simply ignored, not obeyed.
    expect(parseArgs(['node', 'x', '--watermark', '2026-6-2'])).toEqual({ out: '', limit: 0 });
  });
});

describe('the wiring in main(), which needs a DB and so is asserted at the source', () => {
  const SOURCE = require('node:fs').readFileSync(
    path.join(__dirname, '..', '..', 'scripts', 'audit-content-key-formula-drift.cjs'),
    'utf8',
  );

  test("main() emits buildReport's object rather than assembling its own", () => {
    // Superseded as a correctness check by the buildReport suite above; kept to catch
    // main() drifting back to a hand-rolled literal, which is how a re-derived `ok` got
    // in last time.
    expect(SOURCE).toMatch(/const report = buildReport\(/);
    expect(SOURCE).not.toMatch(/ok: counts\./);
  });

  test('the process exit code follows the verdict', () => {
    expect(SOURCE).toMatch(/if \(!report\.ok\) \{/);
    expect(SOURCE).toMatch(/process\.exitCode = 1;/);
  });

  test('the query asks Postgres for the day, so no JS Date can shift it', () => {
    expect(SOURCE).toMatch(/to_char\(created_at, 'YYYY-MM-DD'\) AS mint_day/);
  });

  test('no volume threshold survives in the CODE', () => {
    // The heuristic was measured wrong in both directions and deleted. If it returns it
    // needs its own justification and its own measurement. Comments are stripped first:
    // the header explains at length why concentration was abandoned, and that prose
    // should not be what keeps this test green.
    const code = SOURCE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|--)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/CLUSTER_MIN/);
    expect(code).not.toMatch(/threshold/i);
    // and the verdict must not read the clusters at all
    expect(code).not.toMatch(/computeVerdict\([^)]*cluster/i);
  });
});
