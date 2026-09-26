'use strict';

// CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER: evaluate the category-browse predicate first, over
// catalog_products alone, and keep only the matching product keys. The rewrite must be EXACT -- the
// same predicate text, the same binds -- so these tests pin the SQL shape; the PostgreSQL test
// (tests/integration/canonical_candidate_key_prefilter_postgres.test.js) pins the result sets.

const {
  fetchCanonicalChainRows,
  isCandidateKeyPrefilterEnabled,
  __internal: { whereReadsOnlyCandidateRow },
} = require('../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');

const FLAGS = [
  'CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER',
  'SEARCH_NAME_EVIDENCE_ADMISSION',
  'CANONICAL_CATALOG_RECALL_DOC_MATCH',
  'CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION',
];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
  // Prod's lane configuration as read from the live gateway on 2026-09-26.
  process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH = 'enabled';
  process.env.CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION = 'on';
  delete process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// The beauty mainline call (server.js searchBeautyExternalSeedProductsMainline), no budget.
function mainlineArgs(query, categoryPathPrefix, extra = {}) {
  return {
    query,
    categoryPathPrefix,
    categoryMode: 'category_browse',
    verticalSearch: /niacinamide|retinol/.test(query),
    tokenMatch: true,
    sargableTextWhere: true,
    limit: 200,
    marketId: 'US',
    markets: ['US'],
    includeSkuOffers: true,
    offerScope: { inStockOnly: false, markets: ['US'], currency: null, priceRanges: null },
    ...extra,
  };
}

async function capture(args) {
  const calls = [];
  await fetchCanonicalChainRows({
    ...args,
    deps: { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } },
  });
  expect(calls).toHaveLength(1);
  return calls[0];
}

// The candidate CTE's WHERE up to the first conjunct that is always appended after it.
function candidateWhere(sql) {
  const start = sql.indexOf('      WHERE ', sql.indexOf('LEFT JOIN catalog_merchants m ON m.merchant_id = p.merchant_id'));
  const end = sql.indexOf('\n        AND ', start);
  return sql.slice(start + '      WHERE '.length, end);
}

const PREFILTER_HEAD = 'p.product_key = ANY(ARRAY(\n        SELECT p.product_key FROM catalog_products p\n        WHERE ';

const CASES = [
  ['hair mask', 'beauty/haircare/'],
  ['niacinamide toner', 'beauty/skincare/tone/'],
  ['toner', 'beauty/skincare/tone/'],
  ['niacinamide', 'beauty/skincare/treat/'],
];

describe('candidate-key prefilter', () => {
  test('the flag is off unless set, and reads the usual on-values', () => {
    expect(isCandidateKeyPrefilterEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'on', 'enabled', ' TRUE ']) {
      expect(isCandidateKeyPrefilterEnabled({ CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER: v })).toBe(true);
    }
    for (const v of ['0', 'false', 'off', '']) {
      expect(isCandidateKeyPrefilterEnabled({ CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER: v })).toBe(false);
    }
  });

  test.each(CASES)('flag off: %s emits the statement it always did', async (q, prefix) => {
    const unset = await capture(mainlineArgs(q, prefix));
    process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER = 'off';
    const off = await capture(mainlineArgs(q, prefix));
    expect(off.sql).toBe(unset.sql);
    expect(off.params).toEqual(unset.params);
    expect(unset.sql).not.toContain('ANY(ARRAY(');
  });

  test.each(CASES)('flag on: %s wraps the SAME predicate, byte for byte, with the same binds', async (q, prefix) => {
    const off = await capture(mainlineArgs(q, prefix));
    process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER = 'on';
    const on = await capture(mainlineArgs(q, prefix));
    const original = candidateWhere(off.sql);
    expect(candidateWhere(on.sql)).toBe(`${PREFILTER_HEAD}${original}\n      ))`);
    // Nothing else in the statement moves.
    expect(on.sql.replace(`${PREFILTER_HEAD}${original}\n      ))`, original)).toBe(off.sql);
    expect(on.params).toEqual(off.params);
  });

  test.each([['off'], ['on']])('flag on: the search-quality contract path is wrapped too (name evidence %s)', async (nameEvidence) => {
    process.env.SEARCH_NAME_EVIDENCE_ADMISSION = nameEvidence;
    // The name-evidence suite's own query: names a product, so the admission arm is built.
    const contract = buildSearchQualityContract({ rawQuery: 'Silver Serum Gloss' });
    const args = mainlineArgs('Silver Serum Gloss', 'beauty/skincare/treat/', { searchQualityContract: contract });
    const off = await capture(args);
    // With the admission flag on, the predicate reads the sibling carrier CTE; it must still be moved.
    expect(off.sql.includes('name_evidence_carriers')).toBe(nameEvidence === 'on');
    process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER = 'on';
    const on = await capture(args);
    const original = candidateWhere(off.sql);
    expect(candidateWhere(on.sql)).toBe(`${PREFILTER_HEAD}${original}\n      ))`);
    expect(on.params).toEqual(off.params);
  });

  test('flag on: a predicate that reads the merchants join is left alone (RECALL_DOC off -> plain clause)', async () => {
    process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH = 'off';
    const off = await capture(mainlineArgs('hair mask', 'beauty/haircare/'));
    expect(candidateWhere(off.sql)).toContain('m.merchant_name');
    process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER = 'on';
    const on = await capture(mainlineArgs('hair mask', 'beauty/haircare/'));
    expect(on.sql).toBe(off.sql);
  });

  // Brand / merchant scope: the planner drives from those selective, indexable conjuncts, and the prefilter
  // (a whole-catalog pass over the category/text predicate) made prod 15-80x SLOWER there.
  test.each([
    ['an explicit brand filter', mainlineArgs('the ordinary serum', 'beauty/skincare/treat/', { brandFilter: 'the ordinary' })],
    ['a contract brand constraint', mainlineArgs('the ordinary serum', 'beauty/skincare/treat/',
      { searchQualityContract: buildSearchQualityContract({ rawQuery: 'the ordinary serum' }) })],
    ['a merchant scope', mainlineArgs('toner', 'beauty/skincare/tone/', { merchantId: 'merch_x' })],
  ])('flag on: not applied under %s', async (_label, a) => {
    const off = await capture(a);
    expect(off.sql).toMatch(/brand|merchant_id = \$/i); // the scope really is in the statement
    process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER = 'on';
    const on = await capture(a);
    expect(on.sql).toBe(off.sql);
    expect(on.sql).not.toContain('ANY(ARRAY(');
  });

  test('flag on: a plain category query is still wrapped (the gate is not a blanket off)', async () => {
    process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER = 'on';
    const on = await capture(mainlineArgs('serum', 'beauty/skincare/treat/'));
    expect(on.sql).toContain('ANY(ARRAY(');
  });

  test('flag on: the text lane (no category prefix) is not touched', async () => {
    const off = await capture(mainlineArgs('hair mask', null));
    process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER = 'on';
    const on = await capture(mainlineArgs('hair mask', null));
    expect(on.sql).toBe(off.sql);
  });

  test('flag on: category-only browse (union off) is wrapped as well', async () => {
    process.env.CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION = 'off';
    const off = await capture(mainlineArgs('toner', 'beauty/skincare/tone/'));
    process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER = 'on';
    const on = await capture(mainlineArgs('toner', 'beauty/skincare/tone/'));
    expect(candidateWhere(on.sql)).toBe(`${PREFILTER_HEAD}${candidateWhere(off.sql)}\n      ))`);
  });
});

describe('whereReadsOnlyCandidateRow', () => {
  test('accepts predicates over p, and aliases the predicate declares itself', () => {
    expect(whereReadsOnlyCandidateRow("(p.category_path LIKE $6 OR LOWER(COALESCE(p.title, '')) LIKE $2)")).toBe(true);
    expect(whereReadsOnlyCandidateRow(
      'p.title LIKE $2 OR EXISTS (SELECT 1 FROM catalog_skus sv WHERE sv.product_key = p.product_key)',
    )).toBe(true);
    expect(whereReadsOnlyCandidateRow('(SELECT n FROM name_evidence_carriers) <= $9 AND p.brand = $4')).toBe(true);
  });

  test('a dotted string literal is not a qualifier', () => {
    expect(whereReadsOnlyCandidateRow(
      "coalesce(p.product_payload #>> '{a,b}', '') = 'external_seed.source_unavailable.v1'",
    )).toBe(true);
  });

  test('refuses any outer alias', () => {
    expect(whereReadsOnlyCandidateRow("p.title LIKE $2 OR LOWER(COALESCE(m.merchant_name, '')) LIKE $2")).toBe(false);
    expect(whereReadsOnlyCandidateRow('ips.serving_eligible AND p.title LIKE $2')).toBe(false);
    expect(whereReadsOnlyCandidateRow('EXISTS (SELECT 1 FROM catalog_skus s WHERE s.product_key = o.product_key)')).toBe(false);
  });
});
