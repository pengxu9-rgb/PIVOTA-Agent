// Layer C1 Phase 4a — the external_seed serving gate is unconditionally
// catalog_row_trust.serving_decision='public' (legacy IPS-join branch + flag
// retired). Shared by findProductsExternalSeedDirectRetrieval and
// findProductsExternalSeedBrandFastpath.

const directRetrieval = require('../../src/findProductsExternalSeedDirectRetrieval');
const brandFastpath = require('../../src/findProductsExternalSeedBrandFastpath');

describe.each([
  ['findProductsExternalSeedDirectRetrieval', directRetrieval._internals],
  ['findProductsExternalSeedBrandFastpath', brandFastpath._internals],
])('%s serving gate', (label, internals) => {
  test('SQL builder gates on catalog_row_trust', () => {
    const sql = internals.buildExternalSeedServingEligibleJoinSql();
    expect(sql).toMatch(/INNER\s+JOIN\s+catalog_row_trust\s+crt/i);
    expect(sql).toMatch(/crt\.subject_type\s*=\s*'product'/i);
    expect(sql).toMatch(/crt\.subject_key\s*=\s*cp\.product_key/i);
    expect(sql).toMatch(/crt\.serving_decision\s*=\s*'public'/i);
    expect(sql).not.toMatch(/index_pipeline_state/i);
    expect(sql).not.toMatch(/ips\.serving_eligible/i);
  });
});

test('direct external seed retrieval requires attached serving catalog rows', async () => {
  const queries = [];
  await directRetrieval.retrieveExternalSeedDirectCandidates({
    retrievalQueries: ['barrier serum'],
    relevanceQueryText: 'barrier serum',
    queryTokens: ['barrier', 'serum'],
    safeLimit: 12,
    deps: {
      resolveGuidanceDirectExternalSeedRetrievalBudget: () => ({
        per_variant_limit: 12,
        raw_product_cap: 24,
      }),
      shouldRunExternalSeedExactTitleRecall: () => false,
      queryExternalSeedExactTitleRows: jest.fn(),
      normalizeExactTitleLookupText: (value) => String(value || '').trim().toLowerCase(),
      compactExactTitleLookupText: (value) => String(value || '').replace(/[^a-z0-9]+/gi, '').toLowerCase(),
      buildExternalSeedProduct: (row) => row,
      buildSearchProductKey: (product) => product?.external_product_id || product?.id,
      normalizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase(),
      extractSearchAnchorTokens: (value) => String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean),
      tokenizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean),
      query: jest.fn(async (sql, params) => {
        queries.push({ sql: String(sql), params });
        return { rows: [] };
      }),
    },
  });

  expect(queries).toHaveLength(1);
  expect(queries[0].sql).toMatch(/attached_product_key\s+IS\s+NOT\s+NULL/i);
  expect(queries[0].sql).toMatch(/cp\.product_key\s*=\s*external_product_seeds\.attached_product_key/i);
  expect(queries[0].sql).not.toMatch(/source_product_id\s*=\s*coalesce/i);
});
