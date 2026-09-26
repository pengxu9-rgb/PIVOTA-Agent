'use strict';

// CANONICAL_CATALOG_SINGLE_PAYLOAD_READ: the candidate CTE reads product_payload ONCE per row, from a
// lateral in-memory copy, instead of re-fetching the out-of-line value for every path it reads. These
// tests pin the SQL shape; tests/integration/canonical_single_payload_read_postgres.test.js pins that
// the rows are identical.

const {
  fetchCanonicalChainRows,
  isSinglePayloadReadEnabled,
  __internal: { readPayloadOnce },
} = require('../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');

const FLAGS = [
  'CANONICAL_CATALOG_SINGLE_PAYLOAD_READ',
  'CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER',
  'CANONICAL_CATALOG_RECALL_DOC_MATCH',
  'CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION',
  'SEARCH_NAME_EVIDENCE_ADMISSION',
];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
  process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH = 'enabled';
  process.env.CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION = 'on';
  process.env.SEARCH_NAME_EVIDENCE_ADMISSION = 'on';
  delete process.env.CANONICAL_CATALOG_SINGLE_PAYLOAD_READ;
  delete process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const CASES = [
  ['toner', 'beauty/skincare/tone/', null, false],
  ['cosrx toner', 'beauty/skincare/tone/', 'cosrx', false],
  ['Silver Serum Gloss', 'beauty/skincare/treat/', null, true],
  ['hair mask', null, null, false], // text lane
];

async function capture([q, prefix, brandFilter, contract]) {
  const calls = [];
  await fetchCanonicalChainRows({
    query: q,
    categoryPathPrefix: prefix,
    categoryMode: 'category_browse',
    tokenMatch: true,
    sargableTextWhere: true,
    limit: 200,
    marketId: 'US',
    markets: ['US'],
    includeSkuOffers: true,
    offerScope: { inStockOnly: false, markets: ['US'], currency: null, priceRanges: null },
    brandFilter,
    searchQualityContract: contract ? buildSearchQualityContract({ rawQuery: q }) : null,
    deps: { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } },
  });
  expect(calls).toHaveLength(1);
  return calls[0];
}

function candidateCte(sql) {
  return sql.slice(sql.indexOf('candidate_products AS ('), sql.indexOf('candidate_slots AS ('));
}

const LATERAL = "CROSS JOIN LATERAL (SELECT jsonb_path_query_first(p.product_payload, '$') AS product_payload OFFSET 0) pp";
const PREFILTER_HEAD = 'SELECT p.product_key FROM catalog_products p';

describe('single payload read', () => {
  test('the flag is off unless set', () => {
    expect(isSinglePayloadReadEnabled({})).toBe(false);
    expect(isSinglePayloadReadEnabled({ CANONICAL_CATALOG_SINGLE_PAYLOAD_READ: 'on' })).toBe(true);
    expect(isSinglePayloadReadEnabled({ CANONICAL_CATALOG_SINGLE_PAYLOAD_READ: 'off' })).toBe(false);
  });

  test('the rewrite touches the candidate row alias only', () => {
    expect(readPayloadOnce("p.product_payload->>'a' OR np.product_payload->>'b' OR p0.product_payload"))
      .toBe("pp.product_payload->>'a' OR np.product_payload->>'b' OR p0.product_payload");
  });

  test.each(CASES)('flag off: %s is unchanged', async (...c) => {
    const unset = await capture(c);
    process.env.CANONICAL_CATALOG_SINGLE_PAYLOAD_READ = 'off';
    const off = await capture(c);
    expect(off.sql).toBe(unset.sql);
    expect(unset.sql).not.toContain('jsonb_path_query_first');
  });

  for (const prefilter of ['off', 'on']) {
    test.each(CASES)(`flag on (prefilter ${prefilter}): %s reads the payload once`, async (...c) => {
      process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER = prefilter;
      const off = await capture(c);
      process.env.CANONICAL_CATALOG_SINGLE_PAYLOAD_READ = 'on';
      const on = await capture(c);
      expect(on.params).toEqual(off.params);

      const cte = candidateCte(on.sql);
      expect(cte.split(LATERAL)).toHaveLength(2); // exactly one lateral
      const start = cte.indexOf(PREFILTER_HEAD);
      const prefilterSql = start >= 0 ? cte.slice(start, cte.indexOf('\n      ))', start)) : '';
      const outside = start >= 0 ? cte.replace(prefilterSql, '') : cte;
      // Outer reads of the stored value: the plain projection and the lateral itself, nothing else.
      expect(outside.match(/\bp\.product_payload\b/g)).toHaveLength(2);
      expect(outside).toContain('        p.product_payload,\n');
      // The prefilter subquery is its own row: never correlated to the outer copy.
      expect(prefilterSql).not.toMatch(/\bpp\./);
      // Every read the flag-off CTE made is now a read of the copy.
      const offReads = (candidateCte(off.sql).match(/\bp\.product_payload\b/g) || []).length
        - (prefilterSql.match(/\bp\.product_payload\b/g) || []).length;
      expect((outside.match(/\bpp\.product_payload\b/g) || []).length).toBe(offReads - 1);
    });
  }
});
