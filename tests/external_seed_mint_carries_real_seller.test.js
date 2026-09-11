// ADR-009 phase 3: the beauty seed mainline must carry the row's real seller (merch_obs_*),
// not the banned `external_seed` sentinel — on EVERY query shape, not just one.
//
// This is a jest suite on purpose. The first version of this change was guarded only by
// source-text assertions in a node:test file, and they all passed while it shipped a no-op:
// `catalogMirrorProjectionSql` is interpolated at FOUR sites (an earlier note said five), and
// `multiCategorySql` wraps it in
// a derived table whose outer SELECT enumerates columns explicitly, so the new column was
// projected by the inner arms and silently dropped by the outer list. No SQL error, no failing
// test. The multi-category shape is the DEFAULT — brand browse, serum, eye makeup, and any
// unclassified beauty query — so most traffic kept serving the sentinel.
//
// So this asserts the BUILT SQL for both branches, and the BUILT ROW.

const path = require('path');

const SERVER_PATH = require.resolve('../src/server.js');

function loadServer({ dbMock }) {
  let mod;
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://test';
  jest.isolateModules(() => {
    jest.doMock('../src/db', () => dbMock);
    try {
      mod = require(SERVER_PATH);
    } finally {
      jest.dontMock('../src/db');
    }
  });
  if (prev == null) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prev;
  return mod._debug;
}

function makeDbMock() {
  const calls = [];
  const run = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return { rows: [] };
  };
  return { calls, mock: { query: jest.fn(run), withClient: jest.fn(async (fn) => fn({ query: run })) } };
}

async function capturedSql(intent, queryText) {
  const db = makeDbMock();
  const dbg = loadServer({ dbMock: db.mock });
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://test';
  try {
    await dbg.queryBeautyExternalSeedRowsFast({
      market: 'US',
      queryText,
      intent,
      inStockOnly: false,
      limit: 20,
      toolScope: 'all_tools',
    });
  } finally {
    if (prev == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  }
  return db.calls.map((c) => c.sql);
}

describe('the mirrored seller reaches every query shape', () => {
  test('the SINGLE-category branch selects catalog_merchant_id', async () => {
    // A one-term intent: `cleanser` resolves to exactly one category term.
    const sqls = await capturedSql(
      { families: ['cleanser'], normalized: 'gentle cleanser', brandBrowse: null, safety: [] },
      'gentle cleanser',
    );
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls.some((s) => s.includes('catalog_merchant_id'))).toBe(true);
  });

  test('the MULTI-category branch selects catalog_merchant_id — the shape that shipped broken', async () => {
    // No families and no category prefix is the DEFAULT intent, and it produces several category
    // terms, which is what routes the query through multiCategorySql's derived table.
    const sqls = await capturedSql(
      { families: [], normalized: 'best beauty products', brandBrowse: null, safety: [] },
      'best beauty products',
    );
    expect(sqls.length).toBeGreaterThan(0);

    const derived = sqls.filter((s) => /FROM\s*\(/i.test(s));
    expect(derived.length).toBeGreaterThan(0);

    for (const sql of derived) {
      // The OUTER list is what dropped the column. Assert it survives the derived table by
      // requiring the name to appear AFTER the closing of the inner arms, not merely somewhere.
      const outer = sql.slice(0, sql.search(/FROM\s*\(/i));
      expect(outer).toContain('catalog_merchant_id');
    }
  });
});

describe('the built row carries the seller', () => {
  const dbg = () => loadServer({ dbMock: makeDbMock().mock });

  test('a row with a mirrored seller serves that seller, not the sentinel', () => {
    const build = dbg().buildBeautyExternalSeedMainlineProduct;
    const product = build({
      external_product_id: 'ext_abc123',
      title: 'Test Serum',
      domain: 'example.com',
      destination_url: 'https://example.com/p/1',
      seed_data: {},
      catalog_merchant_id: 'merch_obs_9ab12cd34ef56789',
    });
    expect(product).toBeTruthy();
    expect(product.merchant_id).toBe('merch_obs_9ab12cd34ef56789');
    expect(product.merchant_id).not.toBe('external_seed');
  });

  test('a row with NO mirrored seller falls back to the sentinel, never to an invented id', () => {
    // The COALESCE(row value, sentinel) shape ADR-009 permits. services/seller_identity.py holds a
    // no-fallback discipline — "minting NEVER invents an identity from nothing" — so the gateway
    // must not synthesise a merch_obs_* of its own. Failing open to the legacy bucket is
    // recoverable; minting a wrong seller is not.
    const build = dbg().buildBeautyExternalSeedMainlineProduct;
    const product = build({
      external_product_id: 'ext_def456',
      title: 'Orphan Seed',
      domain: 'example.com',
      destination_url: 'https://example.com/p/2',
      seed_data: {},
    });
    expect(product).toBeTruthy();
    expect(product.merchant_id).toBe('external_seed');
  });
});

describe('the beauty mainline reports its lanes honestly', () => {
  // WHY THIS EXISTS. Three metadata fields are named `external_seed_*`, and only one of them
  // measures the seed lane. `external_seed_rows_built` is `rankedProducts.length` — the COMBINED
  // post-gate set — and `external_seed_returned_count` is a residual. On a live query they read
  // 70 and 0 while `external_seed_rows_fetched` read 8, which reads as "62 rows vanished". Nothing
  // vanished; the field means something else. That misreading cost two rounds of investigation,
  // so the honest counters are pinned here rather than left to be rediscovered.
  const { _debug } = require('../src/server.js');

  test('the lane classifier matches buildSearchQualityTierCounts', () => {
    const count = _debug.countNonCanonicalChainProducts;
    expect(typeof count).toBe('function');

    const products = [
      { source: 'canonical_chain' },
      { search_recall_source: 'canonical_chain' },
      { catalog_source: 'canonical_chain' },
      { source: 'external_seed' },
      { source: 'merchant_public' },
      {},
    ];
    // Three canonical by each of the three aliases; the other three are the seed lane's, including
    // the empty one — buildSearchQualityTierCounts puts anything not canonical_chain in the else
    // branch, and this must agree with it or the numbers cannot be compared.
    expect(count(products)).toBe(3);
    expect(count([])).toBe(0);
    expect(count(null)).toBe(0);
  });

  test('parity detail: trims, does NOT lowercase, and honours alias precedence', () => {
    // The three properties that make "classified exactly as buildSearchQualityTierCounts" TRUE, and
    // which the first version of this test left unpinned — mutants dropping .trim(), swapping alias
    // precedence, and adding .toLowerCase() all survived it. Each is asserted here against the
    // target's actual behaviour (server.js buildSearchQualityTierCounts: String(a||b||c||'').trim(),
    // compared case-SENSITIVELY to 'canonical_chain').
    const count = _debug.countNonCanonicalChainProducts;

    // trims — a padded canonical value is still canonical, so it must NOT be counted
    expect(count([{ source: '  canonical_chain  ' }])).toBe(0);

    // does NOT lowercase — the target compares case-sensitively, so an upper-case value is NOT
    // canonical and MUST be counted. Adding .toLowerCase() here would silently diverge from it.
    expect(count([{ source: 'CANONICAL_CHAIN' }])).toBe(1);

    // alias precedence: `source` is read FIRST, so a row whose source is seed-ish counts even when a
    // later alias says canonical. Swapping the order flips this.
    expect(count([{ source: 'external_seed', search_recall_source: 'canonical_chain' }])).toBe(1);
    expect(count([{ source: 'canonical_chain', search_recall_source: 'external_seed' }])).toBe(0);
  });

  test('a set that is entirely canonical reports zero seed-lane rows', () => {
    const count = _debug.countNonCanonicalChainProducts;
    expect(count([{ source: 'canonical_chain' }, { source: 'canonical_chain' }])).toBe(0);
  });
});

describe('the re-keyed row is still recognised by the seed-lane owner', () => {
  // P1-2, found in review of #2189 and confirmed against prod. Moving merchant_id off the sentinel
  // removed the ONLY isSeedRoutedLane arm these rows could satisfy: the builder stamps platform
  // 'external' (not 'external_seed'), carried no source_system, and the remaining arm is an
  // ext_/ext: id prefix that 7,031 of 11,814 active attached seeds (59.5%) do NOT have.
  //
  // So ~60% of mainline rows silently stopped reading as seed-lane at that predicate's ~10 call
  // sites (auroraBff/routes.js, guidanceFastpath, catalogTrustPolicy, productGroundingResolver).
  // Nothing failed; the rows simply changed category. Carrying the mirror's source_system restores
  // the arm without touching platform — all 13,896 catalog rows have one.
  const { isExternalSeedLaneProduct } = require('../src/services/externalSeedLane');

  const row = (extra) => ({
    merchant_id: 'merch_obs_7156f2b47335f6e3',
    platform: 'external',
    source: 'external_seed',
    source_product_id: 'ponds_us_14749719363952', // deliberately NOT ext_-prefixed: the 59.5% case
    external_product_id: 'ponds_us_14749719363952',
    ...extra,
  });

  test('a non-ext_ id under an observed seller needs source_system to stay in the lane', () => {
    // Without it — what #2189 shipped — the row falls out of the lane entirely.
    expect(isExternalSeedLaneProduct(row())).toBe(false);
    // With the mirror's source_system carried through, it is recognised again.
    expect(isExternalSeedLaneProduct(row({ source_system: 'external_product_seeds_mirror_v1' }))).toBe(true);
    expect(isExternalSeedLaneProduct(row({ source_system: 'catalog_enrichment_agent_v1' }))).toBe(true);
  });

  test('the ext_-prefixed minority never lost recognition — which is why this hid', () => {
    // 4,783 of 11,814 keep the id-prefix arm, so any spot check that happened to pick one of these
    // sees nothing wrong. That is the shape of the bug: a majority regression invisible to a sample.
    const prefixed = row({ source_product_id: 'ext_abc123', external_product_id: 'ext_abc123' });
    expect(isExternalSeedLaneProduct(prefixed)).toBe(true);
  });

  test('the builder carries source_system, on BOTH query shapes', () => {
    // #2189 added catalog_merchant_id and multiCategorySql's outer SELECT silently dropped it,
    // making the fix a no-op on the default query shape. Same trap, so the same assertion.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

    expect(src).toMatch(/SELECT cp\.source_system[\s\S]{0,400}?AS catalog_source_system/);

    // AND that the builder actually STAMPS it on the product object. Selecting a column the row
    // object never carries is a no-op, and the first version of this test could not tell the
    // difference: deleting the stamp left every assertion green, because the others check the SQL
    // and the predicate, never the object in between. Scoped to the builder's own body so a
    // coincidental match elsewhere cannot satisfy it.
    const fnStart = src.indexOf('function buildBeautyExternalSeedMainlineProduct');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, src.indexOf('\nfunction ', fnStart + 10));
    expect(fnBody).toMatch(/const resolvedSourceSystem = firstNonEmptyString\(row\.catalog_source_system\)/);
    expect(fnBody).toMatch(/source_system: resolvedSourceSystem,/);

    const i = src.indexOf('const multiCategorySql');
    const outer = src.slice(i, src.indexOf('FROM (', i));
    for (const col of ['catalog_merchant_id', 'catalog_source_system']) {
      const declared = outer
        .split('\n')
        .some((l) => !l.trim().startsWith('--') && new RegExp(`\\b${col}\\b`).test(l));
      expect({ col, inOuterSelect: declared }).toEqual({ col, inOuterSelect: true });
    }
  });
});
