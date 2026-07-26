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

// #1799 rendering-side follow-up (pre-merge finding 6): a Path-C minted
// canonical's identity row carries the attached SEED's external_product_id as
// product_id, while the minted catalog row's source_product_id is a name slug.
// The old `cp_offer ON cp_offer.source_product_id = pil.product_id` join could
// therefore reach only the seed's MIRROR row (possibly stale/retired), so
// minted group members admitted by the minted-aware seed-identity predicate
// rendered with a NULL offer/price or a retired mirror row's offer. The join
// must route minted rows through their attached seed.
describe('group-member catalog offer join — Path-C minted canonical lane', () => {
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

  const MINTED_ROW = {
    merchant_id: 'merch_obs_9cd1c95a6a1b22aa',
    product_id: 'seed_missha_16821',
    source_listing_ref: 'merch_obs_9cd1c95a6a1b22aa:seed_missha_16821',
    source_kind: 'external_seed',
    source_tier: 'brand',
    merchant_name: 'Missha',
    source_payload: {},
    variant_axes: {},
    // Fields the fixed join resolves from the minted canonical, not the mirror.
    catalog_title: 'MISSHA Time Revolution Essence',
    catalog_brand: 'Missha',
    catalog_canonical_url: 'https://example.com/missha-essence',
    catalog_image_url: 'https://example.com/missha-essence.jpg',
    catalog_offer_id: 'offer_minted_1',
    catalog_sku_key: 'sku_minted_1',
    catalog_offer_currency: 'USD',
    catalog_offer_price: '32.00',
    catalog_offer_source_system: 'catalog_enrichment_agent_v1',
    catalog_offer_source_ref: 'enrich_ref_1',
  };

  describe('shared lateral join builder (single source of truth for all 3 sites)', () => {
    test('routes minted rows through the attached seed, gated on an active seed', () => {
      const sql = app._debug.buildGroupMemberCatalogOfferLateralJoinSql('pil');
      expect(sql).toContain('cp.product_key = eps.attached_product_key');
      expect(sql).toContain("cp.source_system = 'catalog_enrichment_agent_v1'");
      expect(sql).toContain('eps.external_product_id = pil.product_id');
      expect(sql).toContain("eps.status = 'active'");
      // Both lanes stay merchant-scoped (prod-verified: minted rows share
      // pil.merchant_id = cp.merchant_id — see #1799).
      expect(sql.match(/cp\.merchant_id = pil\.merchant_id/g)).toHaveLength(2);
    });

    test('binds each lane rank to the correct UNION branch (rank 0 = minted-via-seed, rank 1 = direct)', () => {
      const sql = app._debug.buildGroupMemberCatalogOfferLateralJoinSql('pil');
      // Rank must be bound to the branch, not merely present somewhere: the
      // MINTED branch (via external_product_seeds) is rank 0 (preferred), the
      // DIRECT branch (catalog_products by source_product_id) is rank 1. An
      // ultrareview mutation showed that unbound toContain lets a marker swap
      // pass — assert the marker sits on its own branch's FROM clause.
      expect(sql).toMatch(
        /SELECT cp\.\*, 1 AS offer_join_lane\s+FROM catalog_products cp\s+WHERE cp\.merchant_id = pil\.merchant_id\s+AND cp\.source_product_id = pil\.product_id/,
      );
      expect(sql).toMatch(
        /SELECT cp\.\*, 0 AS offer_join_lane\s+FROM external_product_seeds eps\s+JOIN catalog_products cp/,
      );
    });

    test('ORDER BY sequence is exactly: serving-eligible, live, lane, updated_at, product_key', () => {
      const sql = app._debug.buildGroupMemberCatalogOfferLateralJoinSql('pil');
      // Pin the FULL term order by index (an ultrareview mutation showed that a
      // lone liveIdx < laneIdx check lets updated_at be hoisted above lane,
      // silently reintroducing the stale-row bug). Each term must strictly
      // precede the next.
      const eligibleIdx = sql.indexOf('ips_pick.serving_eligible = TRUE');
      const liveIdx = sql.indexOf("CASE WHEN cp_pick.sync_status = 'live' THEN 0 ELSE 1 END");
      const laneIdx = sql.indexOf('cp_pick.offer_join_lane ASC');
      const updatedIdx = sql.indexOf('cp_pick.updated_at DESC NULLS LAST');
      const productKeyIdx = sql.indexOf('cp_pick.product_key ASC');
      // The serving_eligible EXISTS also appears — ensure the index we grabbed
      // is the one inside the ORDER BY (after the FROM/UNION block).
      const orderByIdx = sql.indexOf('ORDER BY');
      expect(orderByIdx).toBeGreaterThan(-1);
      for (const idx of [eligibleIdx, liveIdx, laneIdx, updatedIdx, productKeyIdx]) {
        expect(idx).toBeGreaterThan(orderByIdx);
      }
      // Strict monotonic ordering of every rank term.
      expect(eligibleIdx).toBeLessThan(liveIdx);
      expect(liveIdx).toBeLessThan(laneIdx);
      expect(laneIdx).toBeLessThan(updatedIdx);
      expect(updatedIdx).toBeLessThan(productKeyIdx);
    });

    test('ranks serving-eligibility via a correlated EXISTS (semi-join, no fan-out) and caps at one row', () => {
      const sql = app._debug.buildGroupMemberCatalogOfferLateralJoinSql('pil');
      // serving_eligible must be a correlated EXISTS on cp_pick.content_key —
      // NOT a LEFT JOIN that could fan cp_pick out on a multi-row content_key.
      expect(sql).toMatch(
        /EXISTS\s*\(\s*SELECT 1 FROM index_pipeline_state ips_pick\s+WHERE ips_pick\.content_key = cp_pick\.content_key\s+AND ips_pick\.serving_eligible = TRUE\s*\)/,
      );
      // At most one catalog row per member — the lateral never fans out.
      expect(sql).toContain('LIMIT 1');
    });

    test('applies the provided identity-row alias', () => {
      const sql = app._debug.buildGroupMemberCatalogOfferLateralJoinSql('rm');
      expect(sql).toContain('eps.external_product_id = rm.product_id');
      expect(sql).toContain('cp.merchant_id = rm.merchant_id');
      expect(sql).toContain('cp.source_product_id = rm.product_id');
    });
  });

  describe('emitted SQL at the call sites', () => {
    test('fetchApprovedLiveIdentityGroupMembersForOffers resolves offers through the minted lane', async () => {
      const queryFn = makeQueryFn([]);
      await app._debug.fetchApprovedLiveIdentityGroupMembersForOffers({
        sellableItemGroupId: 'sig_x',
        excludeMerchantId: 'merch_canonical',
        excludeProductId: 'prod_canonical',
        queryFn,
      });
      const sql = String(queryFn.mock.calls[0][0]);
      expect(sql).toContain('cp.product_key = eps.attached_product_key');
      expect(sql).toContain('cp_pick.offer_join_lane');
      // The mirror-only join must not survive as the sole offer path.
      expect(sql).not.toMatch(
        /LEFT JOIN catalog_products cp_offer\s+ON cp_offer\.merchant_id = pil\.merchant_id\s+AND cp_offer\.source_product_id = pil\.product_id/,
      );
    });

    test('filterGroupMembersByCatalogSourceQuarantine judges minted members by their canonical row', async () => {
      process.env.DATABASE_URL = 'postgres://unit-test-not-connected';
      const queryFn = jest.fn(async () => ({
        rows: [{ members: [{ merchant_id: 'merch_obs_9cd1c95a6a1b22aa', product_id: 'seed_missha_16821' }] }],
      }));
      const { members } = await app._debug.filterGroupMembersByCatalogSourceQuarantine(
        [{ merchant_id: 'merch_obs_9cd1c95a6a1b22aa', product_id: 'seed_missha_16821' }],
        { queryFn },
      );
      const sql = String(queryFn.mock.calls[0][0]);
      expect(sql).toContain('cp.product_key = eps.attached_product_key');
      expect(sql).toContain('eps.external_product_id = rm.product_id');
      expect(members).toHaveLength(1);
    });

    test('filterGroupMembersByCatalogSourceQuarantine fails open when the row carries no survivor column', async () => {
      // A row that is not this query's answer (no `members` column) must not be
      // read as "zero survivors" — that empties the group and drops the whole
      // offers module. Only an explicit list, including an empty one, is
      // authoritative.
      process.env.DATABASE_URL = 'postgres://unit-test-not-connected';
      const requested = [
        { merchant_id: 'external_seed', product_id: 'ext_a' },
        { merchant_id: 'merch_b', product_id: 'prod_b' },
      ];
      for (const row of [{}, { members: null }, { members: 'not-json' }, { members: '{"a":1}' }]) {
        // eslint-disable-next-line no-await-in-loop
        const { members, filteredCount } = await app._debug.filterGroupMembersByCatalogSourceQuarantine(
          requested,
          { queryFn: jest.fn(async () => ({ rows: [row] })) },
        );
        expect(members).toHaveLength(2);
        expect(filteredCount).toBe(0);
      }
      // An explicit empty list still means every member is quarantined.
      const quarantinedAll = await app._debug.filterGroupMembersByCatalogSourceQuarantine(
        requested,
        { queryFn: jest.fn(async () => ({ rows: [{ members: [] }] })) },
      );
      expect(quarantinedAll.members).toHaveLength(0);
      expect(quarantinedAll.filteredCount).toBe(2);
    });

    test('no raw mirror-only cp_offer join shape survives anywhere in server.js (covers the inline signature-resolver sibling)', () => {
      const fs = require('fs');
      const source = fs.readFileSync(require.resolve('../src/server'), 'utf8');
      // The exact pre-fix join shape (finding 6) must not reappear in ANY of
      // the three sibling queries — including the inline group-members query in
      // resolveCatalogProductRefFromPivotaSignatureInner, which cannot be
      // driven directly from a unit test.
      expect(source).not.toMatch(
        /LEFT JOIN catalog_products cp_offer\s+ON cp_offer\.merchant_id = (pil|rm)\.merchant_id\s+AND cp_offer\.source_product_id = \1\.product_id/,
      );
      // All three sites route through the shared builder.
      expect(source.match(/\$\{buildGroupMemberCatalogOfferLateralJoinSql\('(?:pil|rm)'\)\}/g)).toHaveLength(3);
    });
  });

  describe('member surfacing behavior for minted-backed rows', () => {
    test('a minted member surfaces with its canonical offer price + catalog_offer_v1 provenance', async () => {
      const queryFn = makeQueryFn([MINTED_ROW]);
      const members = await app._debug.fetchApprovedLiveIdentityGroupMembersForOffers({
        sellableItemGroupId: 'sig_minted',
        excludeMerchantId: 'merch_canonical',
        excludeProductId: 'prod_canonical',
        queryFn,
      });
      expect(members).toHaveLength(1);
      const member = members[0];
      expect(member.merchant_id).toBe('merch_obs_9cd1c95a6a1b22aa');
      expect(member.merchant_name).toBe('Missha');
      expect(member.source_payload.price).toEqual({ amount: 32, currency: 'USD' });
      expect(member.source_payload.catalog_offer_v1).toMatchObject({
        offer_id: 'offer_minted_1',
        source_system: 'catalog_enrichment_agent_v1',
      });
      expect(member.source_payload.title).toBe('MISSHA Time Revolution Essence');
    });

    test('a minted member whose offer row is still NULL surfaces without a fabricated price', async () => {
      const noOfferRow = {
        ...MINTED_ROW,
        catalog_offer_id: null,
        catalog_sku_key: null,
        catalog_offer_currency: null,
        catalog_offer_price: null,
        catalog_offer_source_system: null,
        catalog_offer_source_ref: null,
      };
      const queryFn = makeQueryFn([noOfferRow]);
      const members = await app._debug.fetchApprovedLiveIdentityGroupMembersForOffers({
        sellableItemGroupId: 'sig_minted_no_offer',
        excludeMerchantId: 'merch_canonical',
        excludeProductId: 'prod_canonical',
        queryFn,
      });
      expect(members).toHaveLength(1);
      expect(members[0].source_payload.price).toBeUndefined();
      expect(members[0].source_payload.catalog_offer_v1).toBeUndefined();
      // Catalog identity fields still render from the canonical row.
      expect(members[0].source_payload.title).toBe('MISSHA Time Revolution Essence');
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
