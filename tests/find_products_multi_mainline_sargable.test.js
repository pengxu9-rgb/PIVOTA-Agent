'use strict';

/**
 * #1935 — the buyable beauty mainline lane opts into the sargable text WHERE.
 *
 * THE PROPERTY THAT MAKES THIS SAFE is not the flag, it is that the option is
 * INERT IN CATEGORY-BUCKET MODE: under a category prefix (with the
 * category-browse text union kill-switched, which is how these tests run) the
 * helper takes the category branch and discards the text WHERE, so there is
 * nothing for the sargable shape to change. Since ~70% of beauty queries
 * resolve to a prefix, that is most of the lane's traffic provably untouched.
 * These tests assert byte-identical SQL in that mode rather than trusting the
 * reading. With the union ON, browse mode carries a text arm again — but the
 * arm's NARROWING (dropping merchant_name / source_product_id / catalog_skus)
 * is keyed on the recall_doc flag, NOT on this option (see unionTextArm in
 * canonicalCatalogSearch.js and its tests). The only thing this option still
 * changes under the union is the token arm's spelling — sargable
 * (any-token AND overlap>=min) vs plain (overlap>=min) — which admits the
 * same rows by construction, since overlap>=min implies at least one token
 * matches.
 *
 * In text mode the option DOES change the WHERE — it drops merchant_name,
 * source_product_id and the catalog_skus vertical/sku OR-EXISTS arms. Prod
 * row-parity over 18 text-mode queries returned identical rows AND identical
 * order on every one, zero lost:
 *   - 12 multi-token, 6 of them carrying an ingredient signal so the dropped
 *     catalog_skus arms were live;
 *   - 6 single-significant-token (bare brands laneige/cosrx/anua, bare actives
 *     glycerin/retinol). tokenMatch needs >= 2 tokens, so these collapse the
 *     WHERE to title/brand + recall_doc — the 22-of-25 "glycerin" shape — and
 *     three of them have pools below the 192 candidate cut, where a loss shows
 *     rather than hiding behind saturation.
 * Server-side EXPLAIN: 2798ms -> 850ms.
 */

const SERVER_PATH = require.resolve('../src/server.js');
const { fetchCanonicalChainRows } = require('../src/services/canonicalCatalogSearch');

const FLAG_KEYS = [
  'PIVOT_BEAUTY_MAINLINE_SARGABLE_TEXT_WHERE_ENABLED',
  'PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED',
];

function loadServer(flags = {}) {
  let mod;
  jest.isolateModules(() => {
    const prev = {};
    for (const key of FLAG_KEYS) {
      prev[key] = process.env[key];
      if (flags[key] === undefined) delete process.env[key];
      else process.env[key] = flags[key];
    }
    try {
      mod = require(SERVER_PATH);
    } finally {
      for (const key of FLAG_KEYS) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  });
  return mod._debug;
}

async function captureSql(args) {
  let captured = null;
  await fetchCanonicalChainRows({
    ...args,
    deps: {
      query: async (sql, params) => {
        captured = { sql, params };
        return { rows: [] };
      },
    },
  });
  return captured;
}

const MAINLINE_SHAPE = {
  query: 'gentle cleanser',
  verticalSearch: false,
  tokenMatch: true,
  includeSkuOffers: true,
  marketId: 'US',
  limit: 48,
};

describe('#1935 sargable text WHERE flag', () => {
  test('defaults OFF', () => {
    expect(loadServer({}).PIVOT_BEAUTY_MAINLINE_SARGABLE_TEXT_WHERE_ENABLED).toBe(false);
  });

  test('its own flag turns it on, for each accepted truthy spelling', () => {
    for (const value of ['true', '1', 'yes']) {
      const dbg = loadServer({ PIVOT_BEAUTY_MAINLINE_SARGABLE_TEXT_WHERE_ENABLED: value });
      expect(dbg.PIVOT_BEAUTY_MAINLINE_SARGABLE_TEXT_WHERE_ENABLED).toBe(true);
    }
  });

  test('is INERT without the #1933 tokenMatch flag — flip order matters', () => {
    // The helper gates the sargable lane behind tokenMatch as well, so a config
    // that sets only this flag is a no-op. Pinned because the rollout note and
    // the flag comment both depend on operators knowing the order.
    const dbg = loadServer({ PIVOT_BEAUTY_MAINLINE_SARGABLE_TEXT_WHERE_ENABLED: 'true' });
    expect(dbg.PIVOT_BEAUTY_MAINLINE_SARGABLE_TEXT_WHERE_ENABLED).toBe(true);
    expect(dbg.PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED).toBe(false);
  });

  test('the mainline call site passes it — as LIVE code, not a comment', () => {
    // A bare toContain() here is worthless: review of #1939 showed that
    // prefixing the call site with `// ` left the assertion green, so the test
    // would have reported a fully disabled feature as wired. Anchor to start of
    // line so a commented or stringified occurrence cannot satisfy it.
    const source = require('node:fs').readFileSync(SERVER_PATH, 'utf8');
    const liveCallSite = /^[ \t]*sargableTextWhere: PIVOT_BEAUTY_MAINLINE_SARGABLE_TEXT_WHERE_ENABLED,$/m;
    expect(source).toMatch(liveCallSite);
    // ...and it must sit inside the mainline's fetchCanonicalChainRows call,
    // not somewhere unrelated that happens to match.
    const mainlineCall = source.slice(
      source.indexOf('const canonicalRowsPromise = fetchCanonicalChainRows({'),
    ).slice(0, 4000);
    expect(mainlineCall).toMatch(liveCallSite);
  });
});

describe('#1935 category-bucket mode is provably untouched', () => {
  const BUCKET = {
    ...MAINLINE_SHAPE,
    categoryPathPrefix: 'beauty/skincare/cleanse/',
    categoryMode: 'category_browse',
  };

  // CANONICAL_CATALOG_RECALL_DOC_MATCH MUST BE ON FOR THESE TO MEAN ANYTHING.
  // The helper elects the sargable lane only when tokenMatch AND the recall_doc
  // arm are both on (canonicalCatalogSearch.js, `citableSargableLane`). Without
  // this the option is refused on BOTH sides and every assertion below compares
  // the plain form against the plain form — passing while proving nothing.
  // Review of #1939 caught exactly that: with the env unset, sabotaging the
  // category branch left all of these green.
  const prevRecallDoc = process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH;
  beforeAll(() => { process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH = 'enabled'; });
  afterAll(() => {
    if (prevRecallDoc == null) delete process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH;
    else process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH = prevRecallDoc;
  });

  // Fixture liveness guard: proves the env above actually elects the sargable
  // lane, so a green result from the byte-identity tests means "the option ran
  // and changed nothing", not "the option was never switched on". If this ever
  // fails, the tests below are inert regardless of what they report.
  test('GUARD: the same env DOES change text-mode SQL, so the lane is really elected', async () => {
    const off = await captureSql(MAINLINE_SHAPE);
    const on = await captureSql({ ...MAINLINE_SHAPE, sargableTextWhere: true });
    expect(on.sql).not.toBe(off.sql);
  });

  test('SQL and params are byte-identical with the option on and off', async () => {
    const off = await captureSql(BUCKET);
    const on = await captureSql({ ...BUCKET, sargableTextWhere: true });
    expect(on.sql).toBe(off.sql);
    expect(on.params).toEqual(off.params);
  });

  test('holds with verticalSearch on too — the dropped sku arms are bucket-irrelevant', async () => {
    const off = await captureSql({ ...BUCKET, verticalSearch: true });
    const on = await captureSql({ ...BUCKET, verticalSearch: true, sargableTextWhere: true });
    expect(on.sql).toBe(off.sql);
    expect(on.params).toEqual(off.params);
  });

  test('holds with a brandFilter + merchantId + non-US market', async () => {
    const shape = {
      ...BUCKET,
      verticalSearch: true,
      brandFilter: 'laneige',
      merchantId: 'merch_obs_laneige',
      marketId: 'KR',
    };
    const off = await captureSql(shape);
    const on = await captureSql({ ...shape, sargableTextWhere: true });
    expect(on.sql).toBe(off.sql);
    expect(on.params).toEqual(off.params);
  });

  test('every bind is referenced — no unreferenced param (Postgres 08P01)', async () => {
    // Param drift is the sharp edge in this file: appending a bind that no
    // placeholder references makes the statement fail at execution, not here.
    const on = await captureSql({ ...BUCKET, verticalSearch: true, sargableTextWhere: true });
    const highest = Math.max(...(on.sql.match(/\$(\d+)/g) || []).map((b) => Number(b.slice(1))));
    expect(highest).toBe(on.params.length);
  });
});

describe('#1935 text mode: the option changes the WHERE as designed', () => {
  const prevRecallDoc = process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH;
  beforeAll(() => { process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH = 'enabled'; });
  afterAll(() => {
    if (prevRecallDoc == null) delete process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH;
    else process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH = prevRecallDoc;
  });

  // Match the TEXT arms specifically, not any mention of the column: both
  // columns legitimately appear elsewhere in the same region (merchant_name in
  // the identity rank arm, source_product_id in the market-filter EXISTS), and
  // a bare .not.toContain('p.source_product_id') fails on the market filter
  // while telling you nothing about the arm under test.
  const MERCHANT_TEXT_ARM = "LOWER(COALESCE(m.merchant_name, '')) LIKE $2";
  const SOURCE_ID_TEXT_ARM = "LOWER(COALESCE(p.source_product_id, '')) LIKE $2";

  // The WHERE slice below is taken between two indexOf() markers. If either
  // marker ever stops matching, indexOf returns -1, the slice silently becomes
  // '' and EVERY .not.toContain() assertion passes vacuously. Assert the slice
  // is real before trusting any negative assertion made against it.
  function whereSlice(sql) {
    const start = sql.indexOf('WHERE (');
    const end = sql.indexOf('ORDER BY rank_score');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slice = sql.slice(start, end);
    expect(slice).toContain("LOWER(COALESCE(p.title, '')) LIKE $2"); // positive anchor
    return slice;
  }

  test('ON drops the merchant_name and source_product_id TEXT arms', async () => {
    const on = await captureSql({ ...MAINLINE_SHAPE, sargableTextWhere: true });
    const whereOnly = whereSlice(on.sql);
    expect(whereOnly).not.toContain(MERCHANT_TEXT_ARM);
    expect(whereOnly).not.toContain(SOURCE_ID_TEXT_ARM);
    // ...while the market filter's unrelated use of the same column survives.
    expect(whereOnly).toContain('eps.external_product_id = p.source_product_id');
  });

  test('OFF keeps them — the opt-in is what elects the narrower shape', async () => {
    const off = await captureSql(MAINLINE_SHAPE);
    const whereOnly = whereSlice(off.sql);
    expect(whereOnly).toContain(MERCHANT_TEXT_ARM);
    expect(whereOnly).toContain(SOURCE_ID_TEXT_ARM);
  });

  test('the recall_doc arm — which covers the dropped arms — is present when sargable is on', async () => {
    const on = await captureSql({ ...MAINLINE_SHAPE, sargableTextWhere: true });
    expect(on.sql).toContain('p.recall_doc LIKE ANY');
  });

  test('with recall_doc DISABLED the opt-in is refused and the full WHERE is kept', async () => {
    // The helper's own guard: a lossy WHERE must never be served without the
    // arm that compensates for it. Losing this would reintroduce the
    // "bare glycerin lost 22/25 rows" failure.
    process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH = '';
    try {
      const on = await captureSql({ ...MAINLINE_SHAPE, sargableTextWhere: true });
      const whereOnly = whereSlice(on.sql);
      expect(whereOnly).toContain(MERCHANT_TEXT_ARM);
    } finally {
      // restore what this describe's beforeAll set, not a hardcoded literal —
      // this only happened to be safe because it is the last test in the block
      process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH = 'enabled';
    }
  });
});

describe('#1935 text mode with verticalSearch ON — the arms that carry real risk', () => {
  // MAINLINE_SHAPE has verticalSearch:false, which makes skuTextWhere and
  // verticalWhere empty strings — so the tests above assert the drop in the one
  // configuration where the dropped arms were never there. This exercises the
  // config that actually loses recall surface.
  const prevRecallDoc = process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH;
  beforeAll(() => { process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH = 'enabled'; });
  afterAll(() => {
    if (prevRecallDoc == null) delete process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH;
    else process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH = prevRecallDoc;
  });

  const VERTICAL = { ...MAINLINE_SHAPE, query: 'ceramide barrier cream', verticalSearch: true };

  test('OFF: the catalog_skus vertical/sku arms are present', async () => {
    const off = await captureSql(VERTICAL);
    expect(off.sql).toContain('FROM catalog_skus sw');
    expect(off.sql).toContain('FROM catalog_skus sv');
  });

  test('ON: they are dropped from the WHERE, and recall_doc is there to cover them', async () => {
    const on = await captureSql({ ...VERTICAL, sargableTextWhere: true });
    const start = on.sql.indexOf('WHERE (');
    const end = on.sql.indexOf('ORDER BY rank_score');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const whereOnly = on.sql.slice(start, end);
    expect(whereOnly).toContain("LOWER(COALESCE(p.title, '')) LIKE $2"); // positive anchor
    expect(whereOnly).not.toContain('FROM catalog_skus sw');
    expect(whereOnly).not.toContain('FROM catalog_skus sv');
    expect(whereOnly).toContain('p.recall_doc LIKE ANY');
  });

  test('the vertical RANK arms survive — they are in the projection, not the WHERE', async () => {
    // Dropping recall surface is the tradeoff; dropping the +20/+15 vertical
    // rank signal would be an unintended extra loss.
    const on = await captureSql({ ...VERTICAL, sargableTextWhere: true });
    expect(on.sql).toContain('FROM catalog_skus ss');
    expect(on.sql).toContain('FROM catalog_skus si');
  });

  test('single-token query: tokenWhere is empty, so the WHERE collapses to the risky shape', async () => {
    // This is the cohort the prod parity run had to cover — bare "glycerin".
    const on = await captureSql({ ...MAINLINE_SHAPE, query: 'glycerin', verticalSearch: true, sargableTextWhere: true });
    const whereOnly = on.sql.slice(on.sql.indexOf('WHERE ('), on.sql.indexOf('ORDER BY rank_score'));
    expect(whereOnly).toContain("LOWER(COALESCE(p.title, '')) LIKE $2");
    expect(whereOnly).toContain('p.recall_doc LIKE ANY');
    expect(whereOnly).not.toContain('FROM catalog_skus sv');
  });
});
