// Layer C1 Phase 4a — the external_seed serving gate is unconditionally
// catalog_row_trust.serving_decision='public' (legacy IPS-join branch + flag
// retired). Enforced by findProductsExternalSeedBrandFastpath.

const brandFastpath = require('../../src/findProductsExternalSeedBrandFastpath');

describe.each([
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
