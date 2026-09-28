const {
  EXTERNAL_SEED_MERCHANT_ID,
  activeCatalogProductSourceWhere,
  activeProductsCacheSourceWhere,
} = require('../../src/services/activeCatalogSourceSql');

// Normalizes whitespace so assertions read against the SQL's shape, not its indentation.
function flat(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

describe('activeCatalogProductSourceWhere', () => {
  // ADR-009 re-keys external-seed rows off the `external_seed` sentinel onto
  // `merch_obs_*` sellers, which `ensure_observed_seller` mints with
  // status='observed'. A re-keyed row stops matching the sentinel branch and falls
  // to the merchant-status branch, so narrowing this gate back to 'active'-only
  // would silently drop the entire re-keyed corpus out of serving.
  it('admits observed sellers alongside active ones', () => {
    const sql = flat(activeCatalogProductSourceWhere('cp', 'cm'));
    expect(sql).toContain("lower(coalesce(cm.status, 'active')) IN ('active', 'observed')");
    expect(sql).not.toContain("lower(coalesce(cm.status, 'active')) = 'active'");
  });

  it('still admits the legacy sentinel bucket on its own branch', () => {
    const sql = flat(activeCatalogProductSourceWhere('cp', 'cm'));
    expect(sql).toContain(`cp.merchant_id = '${EXTERNAL_SEED_MERCHANT_ID}'`);
  });

  // The sentinel branch admits on merchant_id ALONE, so the test/demo exclusion has
  // to wrap the whole OR rather than sit inside it as another branch — otherwise a
  // rig keeps serving straight through the sentinel. Both serving lanes carry it.
  it('excludes test/demo rigs OUTSIDE the OR, in both lanes', () => {
    const catalog = flat(activeCatalogProductSourceWhere('cp', 'cm'));
    const cache = flat(activeProductsCacheSourceWhere('pc'));

    expect(catalog).toMatch(/^\(\s*\(\s*cp\.merchant_id NOT IN \(/);
    expect(cache).toMatch(/^\(\s*\(\s*pc\.merchant_id NOT IN \(/);

    // The retired founder test rig must stay excluded by id in both lanes.
    expect(catalog).toContain("'merch_efbc46b4619cfbdf'");
    expect(cache).toContain("'merch_efbc46b4619cfbdf'");

    // catalog_products carries source_domain, so the demo storefront-prefix leg is
    // active there — a re-connected demo store under a new merchant_id stays excluded.
    expect(catalog).toContain("coalesce(cp.source_domain, '') NOT LIKE 'pivota-review-demo%'");
  });

  it('honors caller-supplied aliases and never interpolates a non-identifier', () => {
    const sql = flat(activeCatalogProductSourceWhere('prod', 'merch'));
    expect(sql).toContain("lower(coalesce(merch.status, 'active')) IN ('active', 'observed')");
    expect(sql).toContain(`prod.merchant_id = '${EXTERNAL_SEED_MERCHANT_ID}'`);

    const injected = flat(activeCatalogProductSourceWhere("cp; DROP TABLE catalog_products--", 'cm'));
    expect(injected).not.toContain('DROP TABLE');
    expect(injected).toContain(`cp.merchant_id = '${EXTERNAL_SEED_MERCHANT_ID}'`);
  });
});
