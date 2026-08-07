'use strict';
/**
 * Regression tests for the content_key drift audit — issue #1916.
 *
 * The first version of this script reported a FALSE GREEN on the exact defect class it
 * was written to catch: `formula_drift` only ever incremented in the retired-generation
 * branch, so rows minted by a brand-new formula fell through to `input_rewritten`,
 * which nothing gated. It printed the rogue cluster and then ignored it.
 *
 * These tests exist because an audit is only worth its verdict. Each one asserts a way
 * the audit must FAIL — a suite that only checks the green path would have passed
 * against the broken version.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const audit = require('../../scripts/audit-content-key-formula-drift.cjs');
const { makeContentKey } = require('../../src/services/contentKey');

const {
  parseArgs,
  buildReport,
  identifyGeneration,
  clusterUnreproducible,
  computeVerdict,
  rowMintDay,
  isAboveWatermark,
  mintDay,
  ROGUE_MINTER_CLUSTER_MIN,
  RETIRED_GENERATION_BASELINE,
} = audit;

/** Counts as they look on a healthy prod run — the green baseline to perturb. */
const healthyCounts = (over = {}) => ({
  formula_drift: 0,
  v0_d2c_url: 1260,
  v0_retailer: 340,
  input_rewritten: 8,
  unreproducible: 8,
  ...over,
});

const WATERMARK = '2026-06-02';

/** A row minted by a formula nobody has catalogued — the thing the audit must catch. */
function rogueRow(i, day = '2026-08-01', source = 'rogue_minter_v9') {
  return {
    product_key: `pk_rogue_${i}`,
    brand: `Brand ${i}`,
    title: `Product ${i}`,
    gtin: null,
    canonical_url: `https://example.test/${i}`,
    content_key: `ck_${crypto.createHash('md5').update(`rogue${i}`).digest('hex')}`,
    created_at: new Date(`${day}T04:00:00`),
    source_system: source,
  };
}

/** A row whose key is genuine but whose title was edited after minting. */
function rewrittenRow(i, day) {
  const row = rogueRow(i, day, 'external_product_seeds_mirror_v1');
  row.content_key = makeContentKey(row.brand, 'the title it had when minted', null);
  return row;
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

  test('a row minted by an uncatalogued formula is unreproducible, not v1', () => {
    expect(identifyGeneration(rogueRow(1))).toBe('unreproducible');
  });
});

/* These test `computeVerdict` — the `ok` flag itself — because that is exactly where
 * the audit was wrong. A first pass at this suite exercised only clusterUnreproducible
 * and still passed with the verdict stubbed to ignore every cluster, which is the same
 * mistake one level up: testing the ingredient instead of the answer. */
describe('computeVerdict — the false green, closed', () => {
  const rogueCluster = { source_system: 'rogue_minter_v9', day: '2026-08-01', unreproducible_rows: 400 };

  test('green on a healthy corpus', () => {
    expect(computeVerdict(healthyCounts(), []).ok).toBe(true);
  });

  test('RED on a rogue minter, even with formula_drift at zero', () => {
    // Verbatim the scenario that returned ok:true and exit 0 in the first version.
    const verdict = computeVerdict(healthyCounts(), [rogueCluster]);
    expect(verdict.ok).toBe(false);
    expect(verdict.rogue).toEqual([rogueCluster]);
  });

  test('RED on a retired generation reappearing above the watermark', () => {
    expect(computeVerdict(healthyCounts({ formula_drift: 1 }), []).ok).toBe(false);
  });

  test('RED when the frozen retired population moves in EITHER direction', () => {
    // `>` alone let a deletion pay for a new mint, netting to green.
    expect(computeVerdict(healthyCounts({ v0_retailer: 341 }), []).ok).toBe(false);
    expect(computeVerdict(healthyCounts({ v0_retailer: 339 }), []).ok).toBe(false);
    expect(computeVerdict(healthyCounts(), []).retiredTotal).toBe(RETIRED_GENERATION_BASELINE);
  });

  test('a diffuse rewrite spread stays green, however many buckets it spans', () => {
    const diffuse = Array.from({ length: 40 }, (_, i) => ({
      source_system: 'external_product_seeds_mirror_v1',
      day: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
      unreproducible_rows: ROGUE_MINTER_CLUSTER_MIN - 1,
    }));
    expect(computeVerdict(healthyCounts(), diffuse).ok).toBe(true);
  });

  test('the threshold is a floor, not a range — exactly at it is RED', () => {
    const atThreshold = [{ source_system: 's', day: '2026-08-01', unreproducible_rows: ROGUE_MINTER_CLUSTER_MIN }];
    expect(computeVerdict(healthyCounts(), atThreshold).ok).toBe(false);
  });
});

describe('the verdict must see a rogue minter (the original false green)', () => {
  test('a concentrated cluster of unreproducible rows is reported as rogue', () => {
    const rows = Array.from({ length: 400 }, (_, i) => rogueRow(i));
    const { all } = clusterUnreproducible(rows, WATERMARK);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      source_system: 'rogue_minter_v9',
      day: '2026-08-01',
      unreproducible_rows: 400,
    });
    // ...and it is over the threshold, so the verdict fails.
    expect(all[0].unreproducible_rows).toBeGreaterThanOrEqual(ROGUE_MINTER_CLUSTER_MIN);
  });

  test('diffuse post-mint rewrites stay BELOW the threshold and do not fail', () => {
    // The measured prod shape: 8 rewritten rows spread across distinct days.
    const rows = ['2026-06-03', '2026-06-15', '2026-07-03', '2026-07-08']
      .flatMap((day, d) => [rewrittenRow(d * 2, day), rewrittenRow(d * 2 + 1, day)]);
    const { all } = clusterUnreproducible(rows, WATERMARK);
    for (const cluster of all) {
      expect(cluster.unreproducible_rows).toBeLessThan(ROGUE_MINTER_CLUSTER_MIN);
    }
  });

  test('rows below the watermark are excluded from clustering', () => {
    const rows = Array.from({ length: 400 }, (_, i) => rogueRow(i, '2026-05-04'));
    expect(clusterUnreproducible(rows, WATERMARK).all).toEqual([]);
  });
});

describe('watermark comparison is timezone-independent', () => {
  // created_at is `timestamp without time zone`; node-postgres hands back a Date in
  // the RUNNER'S zone. Comparing that against a UTC-parsed watermark shifted the
  // boundary by the runner's offset — an 8-hour false-green window from Asia/Shanghai.
  //
  // THESE CASES ARE RUN UNDER SEVERAL EXPLICIT ZONES, and that is the whole point.
  // The first version of this block inherited the runner's zone, which made it a
  // tautology wherever local == UTC — i.e. on every GitHub Actions runner and every
  // Railway container. Mutation-tested: restoring the toISOString() bug passes 22/22
  // under TZ=UTC and fails only under a non-UTC zone. It caught the bug on the
  // author's laptop and would have missed it in CI. Zone-independent, not zone-lucky.
  // Setting process.env.TZ mid-run does NOT work: V8 caches the zone, so the reassign
  // is ignored once any Date has been touched. Measured — with the toISOString bug
  // restored and an in-test TZ reassignment, the suite still passed 32/32 under an
  // outer TZ=UTC. And that is not a fixable test weakness: when local IS UTC the two
  // implementations are mathematically identical, so no in-process assertion can tell
  // them apart. The only honest check is a process that STARTS in another zone.
  const ZONES = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati'];
  const AUDIT = path.join(__dirname, '..', '..', 'scripts', 'audit-content-key-formula-drift.cjs');

  /** Evaluate an expression against the audit module in a child process fixed to `zone`. */
  function inZone(zone, expression) {
    return execFileSync(
      process.execPath,
      ['-e', `const a=require(${JSON.stringify(AUDIT)});process.stdout.write(String(${expression}))`],
      { env: { ...process.env, TZ: zone }, encoding: 'utf8' },
    );
  }

  test.each(ZONES)('the boundary holds under TZ=%s', (zone) => {
    // Each Date is constructed inside the child, so it carries that zone's reading of
    // the wall clock — exactly what pg-types produces on a runner in that zone.
    expect(inZone(zone, `a.isAboveWatermark(new Date('2026-06-01T23:59:59'),'${WATERMARK}')`)).toBe('false');
    expect(inZone(zone, `a.isAboveWatermark(new Date('2026-06-02T00:30:00'),'${WATERMARK}')`)).toBe('true');
    expect(inZone(zone, `a.isAboveWatermark(new Date('2026-06-02T07:30:00'),'${WATERMARK}')`)).toBe('true');
    expect(inZone(zone, "a.mintDay(new Date('2026-06-02T00:30:00'))")).toBe('2026-06-02');
  });

  test.each(ZONES)('the Postgres-supplied day wins under TZ=%s', (zone) => {
    // The path production actually takes: to_char() already formatted the day, so no
    // JS Date is involved and the runner's zone cannot shift it. Previously untested —
    // every test row went through the JS fallback instead.
    expect(
      inZone(zone, "a.rowMintDay({mint_day:'2026-06-02',created_at:new Date('2026-05-01T00:00:00')})"),
    ).toBe('2026-06-02');
    expect(inZone(zone, "a.rowMintDay({created_at:new Date('2026-06-02T00:30:00')})")).toBe('2026-06-02');
  });
  // Straddling WATERMARK (2026-06-02). The 00:30 and 07:30 cases are the ones the
  // bug got wrong: from Asia/Shanghai they shifted back a day and read as below.
  const BOUNDARY = [
    ['2026-06-01T17:30:00', false],
    ['2026-06-01T23:59:59', false],
    ['2026-06-02T00:30:00', true],
    ['2026-06-02T07:30:00', true],
    ['2026-06-02T23:59:59', true],
  ];

  test.each(BOUNDARY)('%s -> above=%s regardless of local zone', (stamp, expected) => {
    expect(isAboveWatermark(new Date(stamp), WATERMARK)).toBe(expected);
  });

  test('the day bucket is the stored wall-clock day, not the local one', () => {
    expect(mintDay(new Date('2026-06-02T00:30:00'))).toBe('2026-06-02');
    expect(mintDay('2026-06-02 00:30:00')).toBe('2026-06-02');
  });

  test('a missing created_at is never counted as above the watermark', () => {
    expect(isAboveWatermark(null, WATERMARK)).toBe(false);
    expect(mintDay(null)).toBe('');
  });
});

/* buildReport is the object main() actually prints and exits on. computeVerdict being
 * correct is not enough — an earlier revision computed it, discarded it, and re-derived
 * `ok` inline while assembling this object, so `ok: true` shipped while all 22 tests
 * passed. These assert the SHIPPED verdict, not an upstream ingredient. */
describe('buildReport — the object that is printed and exited on', () => {
  const args = { watermark: WATERMARK, generatedAt: '2026-08-07T00:00:00.000Z' };
  const rogueCluster = { source_system: 'rogue_minter_v9', day: '2026-08-01', unreproducible_rows: 400 };

  test('a healthy corpus reports ok:true', () => {
    expect(buildReport({ counts: healthyCounts(), ...args }).ok).toBe(true);
  });

  test('a rogue cluster reaches report.ok, not just computeVerdict', () => {
    const report = buildReport({ counts: healthyCounts(), allClusters: [rogueCluster], ...args });
    expect(report.ok).toBe(false);
    expect(report.suspected_rogue_minters).toEqual([rogueCluster]);
  });

  test('report.ok agrees with computeVerdict on every combination', () => {
    // The invariant the re-derivation broke: these two must never disagree.
    for (const counts of [healthyCounts(), healthyCounts({ formula_drift: 1 }), healthyCounts({ v0_retailer: 339 })]) {
      for (const clusters of [[], [rogueCluster]]) {
        expect(buildReport({ counts, allClusters: clusters, ...args }).ok)
          .toBe(computeVerdict(counts, clusters).ok);
      }
    }
  });

  test('the verdict reads ALL clusters, not the truncated display sample', () => {
    // suspects is sliced to 25 for readability; gating on it would let cluster 26 be a
    // rogue minter that never reaches the verdict.
    const report = buildReport({ counts: healthyCounts(), suspects: [], allClusters: [rogueCluster], ...args });
    expect(report.ok).toBe(false);
  });

  test('the emitted report is JSON-serializable and carries the verdict', () => {
    const parsed = JSON.parse(JSON.stringify(buildReport({ counts: healthyCounts(), ...args })));
    expect(parsed.ok).toBe(true);
    expect(parsed.watermark).toBe(WATERMARK);
    expect(parsed.rogue_minter_cluster_min).toBe(ROGUE_MINTER_CLUSTER_MIN);
  });
});

describe('flag validation — a typo must not become a false green', () => {
  test('a non-zero-padded watermark is rejected, not silently accepted', () => {
    // '2026-07-01' >= '2026-6-2' is FALSE at index 5, so every row would read as below
    // the line and a corpus holding a rogue cluster would report a clean green.
    expect(() => parseArgs(['node', 'x', '--watermark', '2026-6-2'])).toThrow(/zero padding/);
    expect(() => parseArgs(['node', 'x', '--watermark', 'june'])).toThrow(/YYYY-MM-DD/);
  });

  test('a well-formed watermark is accepted, and omitting it uses the default', () => {
    expect(parseArgs(['node', 'x', '--watermark', '2026-06-02']).watermark).toBe('2026-06-02');
    expect(parseArgs(['node', 'x']).watermark).toBe(WATERMARK);
  });

  test('--limit rejects values that would crash or be silently ignored', () => {
    // -1 threw RangeError -> exit 1 with EMPTY stdout, indistinguishable from a real
    // audit failure. 'abc' was NaN -> falsy -> full scan under a flag saying otherwise.
    expect(() => parseArgs(['node', 'x', '--limit', '-1'])).toThrow(/positive integer/);
    expect(() => parseArgs(['node', 'x', '--limit', '2.5'])).toThrow(/positive integer/);
    expect(() => parseArgs(['node', 'x', '--limit', 'abc'])).toThrow(/positive integer/);
    expect(parseArgs(['node', 'x', '--limit', '100']).limit).toBe(100);
  });
});

describe('the wiring in main(), which needs a DB and so is asserted at the source', () => {
  const SOURCE = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'scripts', 'audit-content-key-formula-drift.cjs'),
    'utf8',
  );

  test('main() emits buildReport\'s object rather than assembling its own', () => {
    // Superseded as a correctness check by the buildReport suite above — kept only to
    // catch main() drifting back to a hand-rolled report literal, which is how the
    // re-derived `ok` got in.
    expect(SOURCE).toMatch(/const report = buildReport\(/);
    expect(SOURCE).not.toMatch(/ok: counts\.formula_drift/);
  });

  test('the process exit code follows the verdict', () => {
    expect(SOURCE).toMatch(/if \(!report\.ok\) \{/);
    expect(SOURCE).toMatch(/process\.exitCode = 1;/);
  });

  test('the query asks Postgres for the day, so no JS Date can shift it', () => {
    expect(SOURCE).toMatch(/to_char\(created_at, 'YYYY-MM-DD'\) AS mint_day/);
  });
});

describe('clustering does not silently drop failures', () => {
  test('every cluster reaches the verdict even when the sample is truncated', () => {
    // 30 distinct source systems, one row each, is more than the 25-row sample.
    const rows = Array.from({ length: 30 }, (_, i) => rogueRow(i, '2026-08-01', `src_${i}`));
    const { shown, all } = clusterUnreproducible(rows, WATERMARK);
    expect(shown).toHaveLength(25);
    expect(all).toHaveLength(30);
  });
});
