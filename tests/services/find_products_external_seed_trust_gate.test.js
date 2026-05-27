// Layer C1 Phase 3c — assertions for the trust-gate flag helpers shared by
// findProductsExternalSeedDirectRetrieval and findProductsExternalSeedBrandFastpath.

const directRetrieval = require('../../src/findProductsExternalSeedDirectRetrieval');
const brandFastpath = require('../../src/findProductsExternalSeedBrandFastpath');

const FLAG = 'FIND_PRODUCTS_USES_CATALOG_ROW_TRUST';

function withFlag(value, fn) {
  const prev = process.env[FLAG];
  if (value === undefined) {
    delete process.env[FLAG];
  } else {
    process.env[FLAG] = value;
  }
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

describe.each([
  ['findProductsExternalSeedDirectRetrieval', directRetrieval._internals],
  ['findProductsExternalSeedBrandFastpath', brandFastpath._internals],
])('%s trust-gate flag', (label, internals) => {
  test('flag helper recognizes common truthy values', () => {
    expect(withFlag(undefined, () => internals.findProductsUsesCatalogRowTrust())).toBe(false);
    expect(withFlag('', () => internals.findProductsUsesCatalogRowTrust())).toBe(false);
    expect(withFlag('false', () => internals.findProductsUsesCatalogRowTrust())).toBe(false);
    expect(withFlag('0', () => internals.findProductsUsesCatalogRowTrust())).toBe(false);
    expect(withFlag('true', () => internals.findProductsUsesCatalogRowTrust())).toBe(true);
    expect(withFlag('TRUE', () => internals.findProductsUsesCatalogRowTrust())).toBe(true);
    expect(withFlag('1', () => internals.findProductsUsesCatalogRowTrust())).toBe(true);
    expect(withFlag('yes', () => internals.findProductsUsesCatalogRowTrust())).toBe(true);
    expect(withFlag('on', () => internals.findProductsUsesCatalogRowTrust())).toBe(true);
  });

  test('SQL builder returns the legacy IPS join when flag is off', () => {
    const sql = withFlag(undefined, () => internals.buildExternalSeedServingEligibleJoinSql());
    expect(sql).toMatch(/INNER\s+JOIN\s+index_pipeline_state\s+ips/i);
    expect(sql).toMatch(/ips\.serving_eligible\s*=\s*TRUE/i);
    expect(sql).not.toMatch(/catalog_row_trust/i);
  });

  test('SQL builder returns the trust join when flag is on', () => {
    const sql = withFlag('true', () => internals.buildExternalSeedServingEligibleJoinSql());
    expect(sql).toMatch(/INNER\s+JOIN\s+catalog_row_trust\s+crt/i);
    expect(sql).toMatch(/crt\.subject_type\s*=\s*'product'/i);
    expect(sql).toMatch(/crt\.subject_key\s*=\s*cp\.product_key/i);
    expect(sql).toMatch(/crt\.serving_decision\s*=\s*'public'/i);
    expect(sql).not.toMatch(/index_pipeline_state/i);
    expect(sql).not.toMatch(/ips\.serving_eligible/i);
  });
});
