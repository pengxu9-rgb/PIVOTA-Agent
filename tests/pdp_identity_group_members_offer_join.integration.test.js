'use strict';

// EXECUTED-SQL integration test for buildGroupMemberCatalogOfferLateralJoinSql
// and its two injectable call sites, run against a REAL Postgres.
//
// Why a real DB and not pg-mem: the fix is 3-valued-logic- and ordering-heavy
// SQL (UNION ALL of two lanes, a correlated serving_eligible EXISTS, a
// multi-term ORDER BY, LIMIT 1). pg-mem cannot resolve correlated LATERAL
// references to the outer identity row, so it cannot execute this shape at all.
// The sibling suite (pdp_identity_group_members_external_supply) proves SQL
// STRING shape + JS row mapping; this suite proves the SELECTION SEMANTICS the
// ultrareview flagged as un-covered — most importantly finding #1: a live but
// NOT-serving-eligible minted row must NOT shadow the live+eligible mirror row
// that admitted the member.
//
// Runs only when PIVOTA_TEST_PG_DSN is set (else the whole suite is skipped);
// it creates an isolated schema, loads fixtures, drives the real exported
// functions with an injected queryFn, and drops the schema on teardown. It
// never touches a production database.

const PG_DSN = process.env.PIVOTA_TEST_PG_DSN;
const SCHEMA = `mintjoin_it_${process.pid}`;
const describeMaybe = PG_DSN ? describe : describe.skip;

const ORIGINAL_ENV = process.env;

const DDL = `
  CREATE TABLE pdp_identity_listing (
    source_listing_ref text, merchant_id text, product_id text, source_kind text,
    source_tier text, source_payload jsonb DEFAULT '{}', variant_axes jsonb DEFAULT '{}',
    sellable_item_group_id text, product_line_id text, review_family_id text,
    match_basis text, identity_status text, identity_confidence numeric,
    live_read_enabled boolean, review_required boolean,
    updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now()
  );
  CREATE TABLE catalog_products (
    merchant_id text, source_product_id text, product_key text, content_key text,
    platform text, source_system text, source_ref text, source_domain text,
    sync_status text, title text, brand text, canonical_url text, image_url text,
    updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE catalog_merchants (merchant_id text, merchant_name text, status text);
  CREATE TABLE external_product_seeds (external_product_id text, status text, attached_product_key text);
  CREATE TABLE index_pipeline_state (content_key text, serving_eligible boolean);
  CREATE TABLE catalog_skus (sku_key text, product_key text);
  CREATE TABLE catalog_offers (
    offer_id text, sku_key text, currency text, merchant_effective_price numeric,
    estimated_best_price numeric, list_price numeric, source_system text,
    source_ref text, availability text, updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE catalog_source_quarantine (
    quarantine_id text, match_type text, match_value text, state text, reason text,
    expires_at timestamptz, created_by text, created_at timestamptz DEFAULT now(),
    revoked_at timestamptz, revoked_by text, metadata jsonb
  );
`;

// Fixtures. Each scenario = one external-seed group member + its catalog rows.
// Members are returned by fetchApprovedLiveIdentityGroupMembersForOffers when we
// exclude a non-matching canonical, so no separate canonical row is needed.
function fixtureSql() {
  return `
    -- merchants
    INSERT INTO catalog_merchants VALUES
      ('merch_obs_A', 'Brand A', 'observed'),
      ('merch_obs_B', 'Brand B', 'observed'),
      ('merch_obs_C', 'Brand C', 'observed');

    -- identity rows (all approved / live-read / not review-required)
    INSERT INTO pdp_identity_listing
      (source_listing_ref, merchant_id, product_id, source_kind, source_tier,
       sellable_item_group_id, identity_status, identity_confidence, live_read_enabled, review_required)
    VALUES
      ('merch_obs_A:seed_A', 'merch_obs_A', 'seed_A', 'external_seed', 'brand', 'sig_A', 'approved', 0.95, TRUE, FALSE),
      ('merch_obs_B:seed_B', 'merch_obs_B', 'seed_B', 'external_seed', 'brand', 'sig_B', 'approved', 0.95, TRUE, FALSE),
      ('merch_obs_C:seed_C', 'merch_obs_C', 'seed_C', 'external_seed', 'brand', 'sig_C', 'approved', 0.95, TRUE, FALSE);

    INSERT INTO external_product_seeds VALUES
      ('seed_A', 'active', 'pk_A_minted'),
      ('seed_B', 'active', 'pk_B_minted'),
      ('seed_C', 'active', 'pk_C_minted');

    -- Scenario A (finding #1): mirror live+ELIGIBLE, minted live+NOT-eligible.
    -- Admission is satisfied by the mirror arm; the pick MUST be the mirror.
    INSERT INTO catalog_products
      (merchant_id, source_product_id, product_key, content_key, platform, source_system,
       source_ref, source_domain, sync_status, title, brand, canonical_url, image_url, updated_at)
    VALUES
      ('merch_obs_A', 'slug_A', 'pk_A_minted', 'ck_A_minted', 'external_seed', 'catalog_enrichment_agent_v1',
       'enrich_A', 'branda.com', 'live', 'A MINTED (withheld)', 'Brand A', 'https://branda.com/minted', 'https://img/a-minted.jpg',
       now()),
      ('merch_obs_A', 'seed_A', 'pk_A_mirror', 'ck_A_mirror', 'external_seed', 'external_product_seeds_mirror_v1',
       'mirror_A', 'branda.com', 'live', 'A MIRROR (eligible)', 'Brand A', 'https://branda.com/mirror', 'https://img/a-mirror.jpg',
       now() - interval '1 day'),

    -- Scenario B (verified base case): minted live+eligible, mirror newer but RETIRED.
      ('merch_obs_B', 'slug_B', 'pk_B_minted', 'ck_B_minted', 'external_seed', 'catalog_enrichment_agent_v1',
       'enrich_B', 'brandb.com', 'live', 'B MINTED (eligible)', 'Brand B', 'https://brandb.com/minted', 'https://img/b-minted.jpg',
       now() - interval '2 days'),
      ('merch_obs_B', 'seed_B', 'pk_B_mirror', 'ck_B_mirror', 'external_seed', 'external_product_seeds_mirror_v1',
       'mirror_B', 'brandb.com', 'retired', 'B MIRROR (retired)', 'Brand B', 'https://brandb.com/mirror', 'https://img/b-mirror.jpg',
       now()),

    -- Scenario C (both live+eligible): minted preferred via the lane tiebreak.
      ('merch_obs_C', 'slug_C', 'pk_C_minted', 'ck_C_minted', 'external_seed', 'catalog_enrichment_agent_v1',
       'enrich_C', 'brandc.com', 'live', 'C MINTED (eligible)', 'Brand C', 'https://brandc.com/minted', 'https://img/c-minted.jpg',
       now() - interval '1 day'),
      ('merch_obs_C', 'seed_C', 'pk_C_mirror', 'ck_C_mirror', 'external_seed', 'external_product_seeds_mirror_v1',
       'mirror_C', 'brandc.com', 'live', 'C MIRROR (eligible)', 'Brand C', 'https://brandc.com/mirror', 'https://img/c-mirror.jpg',
       now());

    INSERT INTO index_pipeline_state VALUES
      ('ck_A_mirror', TRUE),   -- A: only the mirror is serving-eligible
      ('ck_A_minted', FALSE),
      ('ck_B_minted', TRUE),   -- B: only the minted is eligible (mirror retired)
      ('ck_C_minted', TRUE),   -- C: both eligible
      ('ck_C_mirror', TRUE);

    INSERT INTO catalog_skus VALUES
      ('sku_A_minted', 'pk_A_minted'), ('sku_A_mirror', 'pk_A_mirror'),
      ('sku_B_minted', 'pk_B_minted'), ('sku_B_mirror', 'pk_B_mirror'),
      ('sku_C_minted', 'pk_C_minted'), ('sku_C_mirror', 'pk_C_mirror');

    -- Distinct prices per row so the picked product_key is identifiable.
    INSERT INTO catalog_offers
      (offer_id, sku_key, currency, merchant_effective_price, source_system, source_ref, availability)
    VALUES
      ('off_A_minted', 'sku_A_minted', 'USD', 99, 'catalog_enrichment_agent_v1', 'enrich_A', 'in_stock'),
      ('off_A_mirror', 'sku_A_mirror', 'USD', 15, 'external_product_seeds_mirror_v1', 'mirror_A', 'in_stock'),
      ('off_B_minted', 'sku_B_minted', 'USD', 32, 'catalog_enrichment_agent_v1', 'enrich_B', 'in_stock'),
      ('off_B_mirror', 'sku_B_mirror', 'USD', 88, 'external_product_seeds_mirror_v1', 'mirror_B', 'in_stock'),
      ('off_C_minted', 'sku_C_minted', 'USD', 40, 'catalog_enrichment_agent_v1', 'enrich_C', 'in_stock'),
      ('off_C_mirror', 'sku_C_mirror', 'USD', 41, 'external_product_seeds_mirror_v1', 'mirror_C', 'in_stock');
  `;
}

describeMaybe('group-member offer join — executed SQL against real Postgres', () => {
  let client;
  let app;
  const fetchMember = async (groupId) => {
    const members = await app._debug.fetchApprovedLiveIdentityGroupMembersForOffers({
      sellableItemGroupId: groupId,
      excludeMerchantId: 'merch_never',
      excludeProductId: 'prod_never',
      queryFn: (sql, params) => client.query(sql, params),
    });
    return members;
  };

  beforeAll(async () => {
    const { Client } = require('pg');
    client = new Client({ connectionString: PG_DSN });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query(DDL);
    await client.query(fixtureSql());
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test', DATABASE_URL: PG_DSN };
    jest.resetModules();
    jest.dontMock('../src/db');
    app = require('../src/server');
  });

  afterAll(async () => {
    process.env = ORIGINAL_ENV;
    if (client) {
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      } finally {
        await client.end();
      }
    }
  });

  test('finding #1: a live-but-NOT-serving-eligible minted row does not shadow the eligible mirror', async () => {
    const members = await fetchMember('sig_A');
    expect(members).toHaveLength(1);
    const m = members[0];
    expect(m.merchant_id).toBe('merch_obs_A');
    // The eligible mirror row wins — NOT the withheld minted row.
    expect(m.source_payload.title).toBe('A MIRROR (eligible)');
    expect(m.source_payload.canonical_url).toBe('https://branda.com/mirror');
    expect(m.source_payload.price).toEqual({ amount: 15, currency: 'USD' });
    expect(m.source_payload.catalog_offer_v1.source_ref).toBe('mirror_A');
  });

  test('verified base case: live+eligible minted beats a newer-but-retired mirror', async () => {
    const members = await fetchMember('sig_B');
    expect(members).toHaveLength(1);
    const m = members[0];
    expect(m.source_payload.title).toBe('B MINTED (eligible)');
    expect(m.source_payload.price).toEqual({ amount: 32, currency: 'USD' });
    expect(m.source_payload.catalog_offer_v1.source_system).toBe('catalog_enrichment_agent_v1');
  });

  test('both lanes live+eligible: the minted canonical is preferred via the lane tiebreak', async () => {
    const members = await fetchMember('sig_C');
    expect(members).toHaveLength(1);
    const m = members[0];
    expect(m.source_payload.title).toBe('C MINTED (eligible)');
    expect(m.source_payload.price).toEqual({ amount: 40, currency: 'USD' });
  });

  test('quarantine filter drops a member whose PICKED (minted) row source is quarantined', async () => {
    // sig_C's picked row is the minted canonical (enrich_C). Quarantine it.
    await client.query(
      `INSERT INTO catalog_source_quarantine (quarantine_id, match_type, match_value, state, reason)
       VALUES ('q_C', 'source_system_ref', 'catalog_enrichment_agent_v1:enrich_C', 'active', 'test')`,
    );
    try {
      const { members, filteredCount } = await app._debug.filterGroupMembersByCatalogSourceQuarantine(
        [{ merchant_id: 'merch_obs_C', product_id: 'seed_C' }],
        { queryFn: (sql, params) => client.query(sql, params) },
      );
      expect(filteredCount).toBe(1);
      expect(members).toHaveLength(0);
    } finally {
      await client.query(`DELETE FROM catalog_source_quarantine WHERE quarantine_id = 'q_C'`);
    }
  });

  test('mutation guard: with the eligibility rank present, the pipeline-withheld row is never served', async () => {
    // Re-assert finding #1 by the offer provenance, which is the money-path
    // field most likely to regress silently under an ORDER BY edit.
    const members = await fetchMember('sig_A');
    expect(members[0].source_payload.catalog_offer_v1.source_system).toBe(
      'external_product_seeds_mirror_v1',
    );
  });
});
