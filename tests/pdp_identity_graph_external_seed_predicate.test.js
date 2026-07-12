'use strict';

// ADR-009: buildActiveExternalSeedIdentityPredicate must correlate the
// external-seed mirror row by platform + source_system + source_product_id,
// NOT the legacy merchant_id='external_seed' bucket. External seeds now mirror
// under per-brand observed sellers (merch_obs_…), so keying on the legacy
// merchant excluded every served merch_obs_ seed from its own identity listing.
// This shared helper feeds ~7 serving/PDP identity queries and was missed by
// the #1772 inline fix in server.js.

const { _internals } = require('../src/services/pdpIdentityGraph');

const { buildActiveExternalSeedIdentityPredicate } = _internals;

describe('buildActiveExternalSeedIdentityPredicate', () => {
  test('does NOT gate the mirror join on the legacy merchant_id bucket', () => {
    const sql = buildActiveExternalSeedIdentityPredicate('pil');
    expect(sql).not.toContain("cp.merchant_id = 'external_seed'");
  });

  test('correlates the mirror row by platform + source_system + source_product_id', () => {
    const sql = buildActiveExternalSeedIdentityPredicate('pil');
    expect(sql).toContain("cp.platform = 'external_seed'");
    expect(sql).toContain("cp.source_system = 'external_product_seeds_mirror_v1'");
    expect(sql).toContain('cp.source_product_id = eps.external_product_id');
    expect(sql).toContain("cp.sync_status = 'live'");
  });

  test('preserves the serving gates (short-circuit + serving_eligible + active seed)', () => {
    const sql = buildActiveExternalSeedIdentityPredicate('pil');
    expect(sql).toContain("pil.source_kind <> 'external_seed'");
    expect(sql).toContain('ips.serving_eligible = TRUE');
    expect(sql).toContain("eps.status = 'active'");
    expect(sql).toContain('eps.external_product_id = pil.product_id');
  });

  test('applies the provided table alias', () => {
    const sql = buildActiveExternalSeedIdentityPredicate('custom_alias');
    expect(sql).toContain("custom_alias.source_kind <> 'external_seed'");
    expect(sql).toContain('eps.external_product_id = custom_alias.product_id');
  });
});
