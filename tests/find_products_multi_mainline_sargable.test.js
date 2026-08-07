'use strict';

/**
 * #1935 — the buyable beauty mainline lane opts into the sargable text WHERE.
 *
 * THE PROPERTY THAT MAKES THIS SAFE is not the flag, it is that the option is
 * INERT IN CATEGORY-BUCKET MODE: under a category prefix the helper takes the
 * category branch and discards the text WHERE, so there is nothing for the
 * sargable shape to change. Since ~70% of beauty queries resolve to a prefix,
 * that is most of the lane's traffic provably untouched. These tests assert
 * byte-identical SQL in that mode rather than trusting the reading.
 *
 * In text mode the option DOES change the WHERE — it drops merchant_name,
 * source_product_id and the catalog_skus vertical/sku OR-EXISTS arms. Prod
 * row-parity over 12 text-mode queries (6 with an ingredient signal, so the
 * dropped catalog_skus arms were live) returned identical rows AND identical
 * order on every one, zero lost. Latency 2798ms -> 850ms.
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

  test('its own flag turns it on', () => {
    const dbg = loadServer({ PIVOT_BEAUTY_MAINLINE_SARGABLE_TEXT_WHERE_ENABLED: 'true' });
    expect(dbg.PIVOT_BEAUTY_MAINLINE_SARGABLE_TEXT_WHERE_ENABLED).toBe(true);
  });

  test('the mainline call site passes it', () => {
    const source = require('node:fs').readFileSync(SERVER_PATH, 'utf8');
    expect(source).toContain('sargableTextWhere: PIVOT_BEAUTY_MAINLINE_SARGABLE_TEXT_WHERE_ENABLED');
  });
});

describe('#1935 category-bucket mode is provably untouched', () => {
  const BUCKET = {
    ...MAINLINE_SHAPE,
    categoryPathPrefix: 'beauty/skincare/cleanse/',
    categoryMode: 'category_browse',
  };

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

  test('ON drops the merchant_name and source_product_id TEXT arms', async () => {
    const on = await captureSql({ ...MAINLINE_SHAPE, sargableTextWhere: true });
    const whereOnly = on.sql.slice(on.sql.indexOf('WHERE ('), on.sql.indexOf('ORDER BY rank_score'));
    expect(whereOnly).not.toContain(MERCHANT_TEXT_ARM);
    expect(whereOnly).not.toContain(SOURCE_ID_TEXT_ARM);
    // ...while the market filter's unrelated use of the same column survives.
    expect(whereOnly).toContain('eps.external_product_id = p.source_product_id');
  });

  test('OFF keeps them — the opt-in is what elects the narrower shape', async () => {
    const off = await captureSql(MAINLINE_SHAPE);
    const whereOnly = off.sql.slice(off.sql.indexOf('WHERE ('), off.sql.indexOf('ORDER BY rank_score'));
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
      const whereOnly = on.sql.slice(on.sql.indexOf('WHERE ('), on.sql.indexOf('ORDER BY rank_score'));
      expect(whereOnly).toContain(MERCHANT_TEXT_ARM);
    } finally {
      process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH = 'enabled';
    }
  });
});
