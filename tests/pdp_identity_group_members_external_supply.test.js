'use strict';

// Fix Plan F / ADR-009: the sellable-item-group member serving path
// (fetchApprovedLiveIdentityGroupMembersForOffers) used to pin seller-name and
// merchant-join resolution to the legacy merchant_id='external_seed' bucket.
// Under ADR-009 external seeds mirror under per-brand observed sellers
// (merch_obs_…, catalog_merchants.status='observed'), so a served merch_obs_ row
// must (a) resolve its real seller name, (b) NOT drop its group siblings, and
// (c) never surface the placeholder "External Seed" name for the legacy lump.
//
// Project lesson (COALESCE bug that passed 35 SQL-shape assertions): assert
// member-surfacing BEHAVIOR — including NULL merchant status/name — not just the
// SQL string. The SQL-shape block below is only a regression guard that the
// removed legacy pins do not silently return; the behavioral blocks are the
// primary coverage.

const ORIGINAL_ENV = process.env;

const LEGACY_ROW = {
  merchant_id: 'external_seed',
  product_id: 'ext_legacy_lump',
  source_listing_ref: 'ref_legacy',
  source_kind: 'external_seed',
  source_tier: 'brand',
  // The CASE in the query yields NULL for the legacy anonymous lump — the
  // "External Seed" placeholder catalog_merchants name must be suppressed.
  merchant_name: null,
  source_payload: {},
  variant_axes: {},
};

const MERCH_OBS_ROW = {
  merchant_id: 'merch_obs_022b65d47a58b87a',
  product_id: 'mojawa_us_8846819885298',
  source_listing_ref: 'ref_mojawa_obs',
  source_kind: 'external_seed',
  source_tier: 'brand',
  // The CASE resolves the observed seller's real catalog_merchants.merchant_name.
  merchant_name: 'Mojawa',
  source_payload: {},
  variant_axes: {},
};

const CONNECTED_ROW = {
  merchant_id: 'merch_9678f6352da21473',
  product_id: 'mojawa_us_url_audit',
  source_listing_ref: 'ref_mojawa_connected',
  source_kind: 'shopify',
  source_tier: 'brand',
  merchant_name: 'Mojawa (Pivota pilot)',
  source_payload: {},
  variant_axes: {},
};

function makeQueryFn(rows) {
  return jest.fn(async () => ({ rows }));
}

describe('fetchApprovedLiveIdentityGroupMembersForOffers — ADR-009 external-supply members', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();
    jest.dontMock('../src/db');
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test' };
    app = require('../src/server');
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // ---- Regression guard: the legacy merchant_id pins must be gone ----
  describe('emitted SQL (regression guard only)', () => {
    test('drops the legacy merchant_id<>external_seed seller-name / join pins', async () => {
      const queryFn = makeQueryFn([]);
      await app._debug.fetchApprovedLiveIdentityGroupMembersForOffers({
        sellableItemGroupId: 'sig_x',
        excludeMerchantId: 'merch_canonical',
        excludeProductId: 'prod_canonical',
        queryFn,
      });
      const sql = String(queryFn.mock.calls[0][0]);
      // The exact legacy pin shape that #1770 flagged must not reappear.
      expect(sql).not.toContain("pil.merchant_id <> 'external_seed'");
      // Seller-name + join now gate on the legacy-lump predicate only.
      expect(sql).toContain("pil.merchant_id = 'external_seed'");
    });

    test('member EXISTS correlates the mirror by platform, not the legacy merchant bucket', async () => {
      const queryFn = makeQueryFn([]);
      await app._debug.fetchApprovedLiveIdentityGroupMembersForOffers({
        sellableItemGroupId: 'sig_x',
        excludeMerchantId: 'merch_canonical',
        excludeProductId: 'prod_canonical',
        queryFn,
      });
      const sql = String(queryFn.mock.calls[0][0]);
      expect(sql).not.toContain("cp_active.merchant_id = 'external_seed'");
      expect(sql).toContain("cp.platform = 'external_seed'");
      expect(sql).toContain("cp.source_system = 'external_product_seeds_mirror_v1'");
      expect(sql).toContain('ips.serving_eligible = TRUE');
    });
  });

  // ---- Primary coverage: member-surfacing behavior ----
  describe('member surfacing behavior', () => {
    test('(a) legacy external_seed row surfaces WITHOUT a seller name (anonymous lump)', async () => {
      const queryFn = makeQueryFn([LEGACY_ROW]);
      const members = await app._debug.fetchApprovedLiveIdentityGroupMembersForOffers({
        sellableItemGroupId: 'sig_legacy',
        excludeMerchantId: 'merch_canonical',
        excludeProductId: 'prod_canonical',
        queryFn,
      });
      expect(members).toHaveLength(1);
      expect(members[0].merchant_id).toBe('external_seed');
      expect(members[0].product_id).toBe('ext_legacy_lump');
      // No placeholder "External Seed" name leaks through.
      expect(members[0].merchant_name).toBeUndefined();
    });

    test('(b) merch_obs_ row surfaces WITH its observed-seller name', async () => {
      const queryFn = makeQueryFn([MERCH_OBS_ROW]);
      const members = await app._debug.fetchApprovedLiveIdentityGroupMembersForOffers({
        sellableItemGroupId: 'sig_6a94afeeb1544a7486817dcb',
        excludeMerchantId: 'merch_canonical',
        excludeProductId: 'prod_canonical',
        queryFn,
      });
      expect(members).toHaveLength(1);
      expect(members[0].merchant_id).toBe('merch_obs_022b65d47a58b87a');
      expect(members[0].merchant_name).toBe('Mojawa');
    });

    test('(c) MIXED group (Mojawa shape) surfaces BOTH lanes; neither drops the other', async () => {
      // The exact Mojawa shape: a connected url_audit lane member and a
      // merch_obs_ external-seed lane member sharing one content_key/group.
      const queryFn = makeQueryFn([CONNECTED_ROW, MERCH_OBS_ROW]);
      const members = await app._debug.fetchApprovedLiveIdentityGroupMembersForOffers({
        sellableItemGroupId: 'sig_mixed_mojawa',
        excludeMerchantId: 'merch_canonical',
        excludeProductId: 'prod_canonical',
        queryFn,
      });
      expect(members).toHaveLength(2);
      const byMerchant = Object.fromEntries(members.map((m) => [m.merchant_id, m]));
      expect(byMerchant['merch_9678f6352da21473'].merchant_name).toBe('Mojawa (Pivota pilot)');
      expect(byMerchant['merch_obs_022b65d47a58b87a'].merchant_name).toBe('Mojawa');
    });
  });

  // ---- NULL / 3-valued-logic behavior (the COALESCE-bug lesson) ----
  describe('NULL / 3-valued behavior', () => {
    test('merch_obs_ member with a NULL seller name still surfaces (not dropped)', async () => {
      // Observed-seller catalog_merchants row missing/NULL merchant_name: the
      // member must still appear (it is servable supply); only the name is absent.
      const namelessObs = { ...MERCH_OBS_ROW, merchant_name: null };
      const queryFn = makeQueryFn([namelessObs]);
      const members = await app._debug.fetchApprovedLiveIdentityGroupMembersForOffers({
        sellableItemGroupId: 'sig_nameless',
        excludeMerchantId: 'merch_canonical',
        excludeProductId: 'prod_canonical',
        queryFn,
      });
      expect(members).toHaveLength(1);
      expect(members[0].merchant_id).toBe('merch_obs_022b65d47a58b87a');
      expect(members[0].merchant_name).toBeUndefined();
    });

    test('mixed group with one NULL-name member keeps the named sibling intact', async () => {
      const namelessObs = { ...MERCH_OBS_ROW, merchant_name: null };
      const queryFn = makeQueryFn([CONNECTED_ROW, namelessObs]);
      const members = await app._debug.fetchApprovedLiveIdentityGroupMembersForOffers({
        sellableItemGroupId: 'sig_mixed_partial_null',
        excludeMerchantId: 'merch_canonical',
        excludeProductId: 'prod_canonical',
        queryFn,
      });
      expect(members).toHaveLength(2);
      const byMerchant = Object.fromEntries(members.map((m) => [m.merchant_id, m]));
      expect(byMerchant['merch_9678f6352da21473'].merchant_name).toBe('Mojawa (Pivota pilot)');
      expect(byMerchant['merch_obs_022b65d47a58b87a'].merchant_name).toBeUndefined();
    });

    test('rows missing merchant_id/product_id are dropped without dropping valid siblings', async () => {
      const brokenRow = { ...MERCH_OBS_ROW, merchant_id: null };
      const queryFn = makeQueryFn([brokenRow, CONNECTED_ROW]);
      const members = await app._debug.fetchApprovedLiveIdentityGroupMembersForOffers({
        sellableItemGroupId: 'sig_broken',
        excludeMerchantId: 'merch_canonical',
        excludeProductId: 'prod_canonical',
        queryFn,
      });
      expect(members).toHaveLength(1);
      expect(members[0].merchant_id).toBe('merch_9678f6352da21473');
    });
  });
});

describe('buildLegacyExternalSeedLumpPredicate — ADR-009 seller-name gate', () => {
  const {
    buildLegacyExternalSeedLumpPredicate,
    buildActiveExternalSeedIdentityPredicate,
  } = require('../src/services/pdpIdentityGraph');

  test('gates ONLY the legacy anonymous external_seed bucket', () => {
    const sql = buildLegacyExternalSeedLumpPredicate('pil');
    expect(sql).toBe("pil.merchant_id = 'external_seed'");
    // Must NOT reference merch_obs_ / observed — those resolve real names.
    expect(sql).not.toContain('merch_obs_');
  });

  test('applies the provided table alias', () => {
    expect(buildLegacyExternalSeedLumpPredicate('cm')).toBe("cm.merchant_id = 'external_seed'");
  });

  test('is exported for reuse (not just under _internals)', () => {
    expect(typeof buildLegacyExternalSeedLumpPredicate).toBe('function');
    expect(typeof buildActiveExternalSeedIdentityPredicate).toBe('function');
  });
});
