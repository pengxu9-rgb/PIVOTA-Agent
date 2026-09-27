'use strict';

// scripts/repairRetailerOfficialDomain.cjs against real PostgreSQL: the listing and override tables come from
// the real migration (036), and the script's own SQL runs -- the affected-row scan, the sibling brand-domain
// re-derivation, the active-override load, the serving prediction (catalogRowTrustUpserter's own join run through
// catalogTrustPolicy.deriveTrust) and the UPDATE. The trust refresh is the REAL one, so the test pins the
// contract the 2026-09-27 apply broke: what the dry run predicts is what the refresh then writes.
//
// Dedicated disposable DB only, same opt-in as the other *_postgres suites.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { run } = require('../../scripts/repairRetailerOfficialDomain.cjs');
const { upsertCatalogRowTrustForSourceListingRefs } = require('../../src/services/catalogRowTrustUpserter');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const ULTA = 'https://www.ulta.com/p/niacinamide-pimprod2007111';

suite('repairRetailerOfficialDomain (PostgreSQL)', () => {
  let db; let schema;
  const REFS = ['external_seed:pa', 'external_seed:pb', 'external_seed:pc', 'external_seed:pd', 'external_seed:pe'];

  async function listing(ref, extra) {
    const row = {
      merchant_id: 'external_seed', product_id: ref.split(':')[1], source_kind: 'external_seed', source_tier: 'merchant',
      live_read_enabled: false, sellable_item_group_id: `g_${ref}`, product_line_id: `l_${ref}`, review_family_id: `f_${ref}`,
      identity_status: 'approved', identity_confidence: 0.74, matched_by_rule: 'official_url_route',
      match_basis: [`official_url:${ULTA}`], strong_identity: { official_domain: 'ulta.com' }, soft_identity: {},
      source_payload: {}, official_url: ULTA, official_domain: 'ulta.com', brand_norm: 'the ordinary',
      review_required: false, review_reason_codes: [], ...extra,
    };
    await db.query(`INSERT INTO pdp_identity_listing (source_listing_ref, merchant_id, product_id, source_kind, source_tier,
        live_read_enabled, sellable_item_group_id, product_line_id, review_family_id, identity_status, identity_confidence,
        matched_by_rule, match_basis, strong_identity, soft_identity, source_payload, official_url, official_domain, brand_norm,
        review_required, review_reason_codes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17,$18,$19,$20,$21::jsonb)`,
    [ref, row.merchant_id, row.product_id, row.source_kind, row.source_tier, row.live_read_enabled, row.sellable_item_group_id,
      row.product_line_id, row.review_family_id, row.identity_status, row.identity_confidence, row.matched_by_rule,
      JSON.stringify(row.match_basis), JSON.stringify(row.strong_identity), JSON.stringify(row.soft_identity),
      JSON.stringify(row.source_payload), row.official_url, row.official_domain, row.brand_norm, row.review_required,
      JSON.stringify(row.review_reason_codes)]);
  }
  // A servable mirror catalog row for a listing: seed active (retailer-sourced, 'cross'), index-eligible, priced.
  async function catalogRow(pid) {
    await db.query(`INSERT INTO catalog_products (product_key, content_key, merchant_id, platform, source_system, source_product_id,
      source_domain, pivota_signature_id) VALUES ($1, $2, 'external_seed', 'external_seed', 'external_product_seeds_mirror_v1', $3, 'ulta.com', $4)`,
    [`k_${pid}`, `ck_${pid}`, pid, `sig_${pid}`]);
    await db.query(`INSERT INTO external_product_seeds (id, external_product_id, status, domain, updated_at, created_at, seed_kind)
      VALUES ($1, $2, 'active', 'ulta.com', now(), now(), 'cross')`, [`s_${pid}`, pid]);
    await db.query('INSERT INTO index_pipeline_state (content_key, serving_eligible) VALUES ($1, true)', [`ck_${pid}`]);
    await db.query('INSERT INTO catalog_offers (product_key, merchant_effective_price, list_price) VALUES ($1, 10, 10)', [`k_${pid}`]);
  }
  const payload = (pid, extra = {}) => ({ product_id: pid, title: 'Niacinamide 10% + Zinc 1% Serum', brand: 'The Ordinary', canonical_url: ULTA, ...extra });
  const trustOf = async () => Object.fromEntries((await db.query(
    'SELECT product_key, serving_decision FROM catalog_row_trust ORDER BY 1')).rows.map((r) => [r.product_key, r.serving_decision]));

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `rrod_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    const ddl = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'db', 'migrations', '036_pdp_identity_graph.sql'), 'utf8');
    for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
    // Every table catalogRowTrustUpserter's PRODUCT_JOIN_SQL reads, with the columns it reads (backend-owned tables).
    await db.query(`CREATE TABLE catalog_products (product_key text PRIMARY KEY, content_key text, merchant_id text, platform text,
      source_system text, source_ref text, source_product_id text, source_domain text, sync_status text, suppression_reason text,
      last_seen_in_sync_at timestamptz, pivota_signature_id text)`);
    await db.query(`CREATE TABLE index_pipeline_state (content_key text PRIMARY KEY, serving_eligible boolean, index_eligible boolean,
      pipeline_stage text, blocker_code text, content_quality_score numeric, quality_scored_at timestamptz, last_extracted_at timestamptz)`);
    await db.query(`CREATE TABLE external_product_seeds (id text, external_product_id text, status text, domain text,
      attached_product_key text, updated_at timestamptz, created_at timestamptz, seed_kind text)`);
    await db.query(`CREATE TABLE merchant_stores (store_id text, merchant_id text, platform text, domain text, status text,
      last_sync timestamptz, is_primary boolean, created_at timestamptz)`);
    await db.query('CREATE TABLE catalog_offers (product_key text, suppressed_at timestamptz, merchant_effective_price numeric, list_price numeric)');
    await db.query('CREATE TABLE content_canonical_election (content_key text, canonical_sig_id text)');
    await db.query('CREATE TABLE catalog_source_quarantine (quarantine_id text, match_type text, match_value text, state text, expires_at timestamptz)');
    // pivota-backend migration 136, trimmed to the columns and checks the upsert writes.
    await db.query(`CREATE TABLE catalog_row_trust (subject_type text NOT NULL, subject_key text NOT NULL, product_key text,
      source_listing_ref text, content_key text, source_id text, source_domain text, source_lifecycle_state text NOT NULL,
      source_last_checked_at timestamptz, identity_status text NOT NULL, identity_confidence numeric(4,3),
      matched_product_key text, matched_content_key text, matched_sellable_item_group_id text, freshness_state text NOT NULL,
      last_verified_at timestamptz, verification_source text,
      serving_decision text NOT NULL CHECK (serving_decision IN ('public','shadow','blocked')),
      serving_reason_codes text[] NOT NULL DEFAULT '{}', manual_override_id text, policy_version text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (subject_type, subject_key))`);

    // A: live + public today, no override -> the demotion shadows it
    await listing('external_seed:pa', { live_read_enabled: true, source_payload: payload('pa') });
    // B: not live -> already shadow (IDENTITY_LIVE_READ_DISABLED); the demotion changes nothing
    await listing('external_seed:pb', { source_payload: payload('pb') });
    // C: would be promoted by the rebuild (GTIN), but an active force_review_required override holds it
    await listing('external_seed:pc', { identity_status: 'review_required', review_required: true, source_payload: payload('pc', { gtin: '00769915190311' }) });
    await db.query("INSERT INTO pdp_identity_override (id, source_listing_ref, action_type, payload) VALUES ('o1','external_seed:pc','force_review_required','{\"reason_codes\":[\"manual_hold\"]}')");
    // D: would be promoted by the rebuild, no override -> HELD
    await listing('external_seed:pd', { identity_status: 'review_required', review_required: true, review_reason_codes: ['conflicting_gtin'],
      source_payload: payload('pd', { gtin: '00769915190328' }) });
    // E: live + public, with an active force_exact_group override. Since trust policy c1.v0.9 the override only groups,
    // so the demotion shadows E like A (until c1.v0.9 it kept E public -- the 2026-09-27 miss)
    await listing('external_seed:pe', { live_read_enabled: true, source_payload: payload('pe') });
    await db.query("INSERT INTO pdp_identity_override (id, source_listing_ref, action_type, payload) VALUES ('o2','external_seed:pe','force_exact_group','{\"target_sellable_item_group_id\":\"g_x\"}')");
    for (const pid of ['pa', 'pb', 'pc', 'pd', 'pe']) await catalogRow(pid);
    // siblings that make theordinary.com the brand's dominant non-retailer domain
    for (const s of ['s1', 's2', 's3']) {
      await listing(`merch_to:${s}`, { merchant_id: 'merch_to', official_domain: 'theordinary.com', official_url: null,
        strong_identity: { official_domain: 'theordinary.com' }, source_payload: payload(s) });
    }
    // stored trust = what the real refresh computes today
    await upsertCatalogRowTrustForSourceListingRefs(db, REFS);
  });

  afterAll(async () => {
    if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
  });

  test('fixture: stored trust before the repair', async () => {
    expect(await trustOf()).toEqual({ k_pa: 'public', k_pb: 'shadow', k_pc: 'shadow', k_pd: 'shadow', k_pe: 'public' });
  });

  test('dry run: predicts serving with the trust policy and writes nothing', async () => {
    const before = (await db.query('SELECT source_listing_ref, identity_status, official_domain FROM pdp_identity_listing ORDER BY 1')).rows;
    const trustBefore = await trustOf();
    const lines = [];
    const out = await run({ client: db, apply: false, log: (l) => lines.push(l), refreshTrust: jest.fn() });
    expect(out.report.demotions).toBe(3); // pa, pb, pe
    expect(out.report.demotions_changing_serving).toBe(2); // pa and pe: force_exact_group no longer holds pe public
    expect(out.report.demotion_table).toEqual(expect.arrayContaining([
      expect.objectContaining({ brand: 'the ordinary', live_read: true, demoted: 2, serving_changes: 2, public_now: 2, stays_public_by_override: 0 }),
      expect.objectContaining({ brand: 'the ordinary', live_read: false, demoted: 1, serving_changes: 0, public_now: 0 }),
    ]));
    expect(out.report.stale_trust).toEqual([]);
    expect(out.report.promotions).toEqual([
      expect.objectContaining({ ref: 'external_seed:pd', kind: 'hold', previous_review_reason_codes: ['conflicting_gtin'] }),
    ]);
    expect(lines.some((l) => /the ordinary -> theordinary\.com \(3 siblings\)/.test(l))).toBe(true);
    expect((await db.query('SELECT source_listing_ref, identity_status, official_domain FROM pdp_identity_listing ORDER BY 1')).rows).toEqual(before);
    expect(await trustOf()).toEqual(trustBefore);
  });

  test('--apply with the REAL trust refresh: what the dry run predicted is what trust now says, row for row', async () => {
    const dry = await run({ client: db, apply: false, log: () => {}, refreshTrust: jest.fn() });
    const predicted = {};
    for (const list of dry.predictions.values()) for (const x of list) predicted[x.product_key] = x.after;
    expect(Object.keys(predicted).sort()).toEqual(['k_pa', 'k_pb', 'k_pc', 'k_pe']); // pd is held, never predicted

    const applied = await run({ client: db, apply: true, trustRefresh: true, log: () => {}, refreshTrust: upsertCatalogRowTrustForSourceListingRefs });
    expect(applied.touched.sort()).toEqual(['external_seed:pa', 'external_seed:pb', 'external_seed:pc', 'external_seed:pe']);
    const after = await trustOf();
    for (const [key, decision] of Object.entries(predicted)) expect([key, after[key]]).toEqual([key, decision]);
    // pa and pe demoted and shadowed (pe's force_exact_group only groups since c1.v0.9), as predicted
    expect(after).toEqual({ k_pa: 'shadow', k_pb: 'shadow', k_pc: 'shadow', k_pd: 'shadow', k_pe: 'shadow' });

    const rows = Object.fromEntries((await db.query(`SELECT source_listing_ref, identity_status, review_required, matched_by_rule,
      official_domain, official_url, live_read_enabled, sellable_item_group_id, review_reason_codes FROM pdp_identity_listing`)).rows
      .map((r) => [r.source_listing_ref, r]));
    expect(rows['external_seed:pa']).toEqual(expect.objectContaining({ identity_status: 'review_required', matched_by_rule: 'singleton_source_ref',
      official_domain: 'theordinary.com', official_url: null, live_read_enabled: true, sellable_item_group_id: 'g_external_seed:pa' }));
    expect(rows['external_seed:pe'].identity_status).toBe('review_required');
    expect(rows['external_seed:pc']).toEqual(expect.objectContaining({ identity_status: 'review_required', review_required: true }));
    expect(rows['external_seed:pc'].review_reason_codes).toContain('manual_hold');
    // D untouched: still carries the retailer domain until someone allows the promotion
    expect(rows['external_seed:pd']).toEqual(expect.objectContaining({ identity_status: 'review_required', official_domain: 'ulta.com' }));
  });
});
