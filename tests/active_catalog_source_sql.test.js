'use strict';

const {
  activeCatalogProductSourceWhere,
  EXTERNAL_SEED_MERCHANT_ID,
} = require('../src/services/activeCatalogSourceSql');

describe('activeCatalogProductSourceWhere', () => {
  test('admits ADR-009 observed sellers alongside active merchants', () => {
    // Regression: merch_obs_ observed sellers (catalog_merchants.status =
    // "observed") were excluded from the citable/category recall lane, so
    // enriched external seeds never surfaced despite index_eligible = true.
    const sql = activeCatalogProductSourceWhere('p', 'm');
    expect(sql).toContain("lower(coalesce(m.status, 'active')) IN ('active', 'observed')");
  });

  test('still admits the legacy external_seed merchant bucket', () => {
    const sql = activeCatalogProductSourceWhere('p', 'm');
    expect(sql).toContain(`p.merchant_id = '${EXTERNAL_SEED_MERCHANT_ID}'`);
  });

  test('does not broaden to other inactive statuses (e.g. deleted/rejected)', () => {
    const sql = activeCatalogProductSourceWhere('p', 'm');
    expect(sql).not.toMatch(/'deleted'|'rejected'|'suspended'/);
  });

  test('injects the provided aliases (and rejects unsafe ones)', () => {
    const sql = activeCatalogProductSourceWhere('cp', 'cm');
    expect(sql).toContain("cp.merchant_id = 'external_seed'");
    expect(sql).toContain("lower(coalesce(cm.status, 'active'))");
    // unsafe alias falls back to the default
    const unsafe = activeCatalogProductSourceWhere('p; DROP TABLE x;--', 'm');
    expect(unsafe).toContain("cp.merchant_id = 'external_seed'");
  });
});
