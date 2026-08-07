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

const audit = require('../../scripts/audit-content-key-formula-drift.cjs');
const { makeContentKey } = require('../../src/services/contentKey');

const {
  identifyGeneration,
  clusterUnreproducible,
  computeVerdict,
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

describe('the wiring in main(), which needs a DB and so is asserted at the source', () => {
  const SOURCE = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'scripts', 'audit-content-key-formula-drift.cjs'),
    'utf8',
  );

  test('the verdict is computed from ALL clusters, not the display sample', () => {
    // `suspects` is sliced to 25 for readability. Gating on it would let cluster 26
    // be a rogue minter that never reaches the verdict — a false green reintroduced
    // by a plausible-looking variable swap.
    expect(SOURCE).toMatch(/computeVerdict\(counts, allClusters\)/);
    expect(SOURCE).not.toMatch(/computeVerdict\(counts, suspects\)/);
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
