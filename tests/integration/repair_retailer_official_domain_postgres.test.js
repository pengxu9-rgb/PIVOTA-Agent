'use strict';

// scripts/repairRetailerOfficialDomain.cjs against real PostgreSQL: the listing and override tables come from
// the real migration (036), and the script's own SQL runs -- the affected-row scan, the sibling brand-domain
// re-derivation, the active-override load, the serving-impact join and the UPDATE. Only the trust refresh is a
// stub (it needs the whole catalog schema); its INPUT (exactly the refs written) is what is asserted.
//
// Dedicated disposable DB only, same opt-in as the other *_postgres suites.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { run } = require('../../scripts/repairRetailerOfficialDomain.cjs');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const ULTA = 'https://www.ulta.com/p/niacinamide-pimprod2007111';

suite('repairRetailerOfficialDomain (PostgreSQL)', () => {
  let db; let schema;

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
  const payload = (pid, extra = {}) => ({ product_id: pid, title: 'Niacinamide 10% + Zinc 1% Serum', brand: 'The Ordinary', canonical_url: ULTA, ...extra });

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `rrod_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    const ddl = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'db', 'migrations', '036_pdp_identity_graph.sql'), 'utf8');
    for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
    await db.query('CREATE TABLE catalog_products (product_key text PRIMARY KEY, merchant_id text, source_product_id text, source_system text)');
    await db.query('CREATE TABLE external_product_seeds (external_product_id text, attached_product_key text, seed_kind text)');
    await db.query('CREATE TABLE catalog_row_trust (product_key text PRIMARY KEY, serving_decision text)');

    // A: demotion that CHANGES serving (live read + trust public today)
    await listing('external_seed:pa', { live_read_enabled: true, source_payload: payload('pa') });
    await db.query("INSERT INTO catalog_products VALUES ('ka','external_seed','pa','x'); INSERT INTO catalog_row_trust VALUES ('ka','public')");
    // B: demotion that changes nothing (not live, already shadow)
    await listing('external_seed:pb', { source_payload: payload('pb') });
    await db.query("INSERT INTO catalog_products VALUES ('kb','external_seed','pb','x'); INSERT INTO catalog_row_trust VALUES ('kb','shadow')");
    // C: would be promoted by the rebuild (GTIN), but an active force_review_required override holds it
    await listing('external_seed:pc', { identity_status: 'review_required', review_required: true, source_payload: payload('pc', { gtin: '00769915190311' }) });
    await db.query("INSERT INTO pdp_identity_override (id, source_listing_ref, action_type, payload) VALUES ('o1','external_seed:pc','force_review_required','{\"reason_codes\":[\"manual_hold\"]}')");
    // D: would be promoted by the rebuild, no override -> HELD
    await listing('external_seed:pd', { identity_status: 'review_required', review_required: true, review_reason_codes: ['conflicting_gtin'],
      source_payload: payload('pd', { gtin: '00769915190328' }) });
    // siblings that make theordinary.com the brand's dominant non-retailer domain
    for (const s of ['s1', 's2', 's3']) {
      await listing(`merch_to:${s}`, { merchant_id: 'merch_to', official_domain: 'theordinary.com', official_url: null,
        strong_identity: { official_domain: 'theordinary.com' }, source_payload: payload(s) });
    }
  });

  afterAll(async () => {
    if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
  });

  test('dry run: reports the serving impact and writes nothing', async () => {
    const before = (await db.query('SELECT source_listing_ref, identity_status, official_domain FROM pdp_identity_listing ORDER BY 1')).rows;
    const lines = [];
    const out = await run({ client: db, apply: false, log: (l) => lines.push(l), refreshTrust: jest.fn() });
    expect(out.report.demotions).toBe(2);
    expect(out.report.demotions_changing_serving).toBe(1);
    expect(out.report.demotion_table).toEqual(expect.arrayContaining([
      expect.objectContaining({ brand: 'the ordinary', live_read: true, serving_changes: 1, trust_public: 1 }),
      expect.objectContaining({ brand: 'the ordinary', live_read: false, serving_changes: 0 }),
    ]));
    expect(out.report.promotions).toEqual([
      expect.objectContaining({ ref: 'external_seed:pd', kind: 'hold', previous_review_reason_codes: ['conflicting_gtin'] }),
    ]);
    expect(lines.some((l) => /the ordinary -> theordinary\.com \(3 siblings\)/.test(l))).toBe(true);
    expect((await db.query('SELECT source_listing_ref, identity_status, official_domain FROM pdp_identity_listing ORDER BY 1')).rows).toEqual(before);
  });

  test('--apply: fixes A/B/C, holds D, honours the override, refreshes trust for exactly what it wrote', async () => {
    const refreshTrust = jest.fn(async (_c, refs) => refs.length);
    const out = await run({ client: db, apply: true, trustRefresh: true, log: () => {}, refreshTrust });
    expect(out.touched.sort()).toEqual(['external_seed:pa', 'external_seed:pb', 'external_seed:pc']);
    expect(refreshTrust).toHaveBeenCalledTimes(1);
    expect(refreshTrust.mock.calls[0][1].sort()).toEqual(['external_seed:pa', 'external_seed:pb', 'external_seed:pc']);

    const rows = Object.fromEntries((await db.query(`SELECT source_listing_ref, identity_status, review_required, matched_by_rule,
      official_domain, official_url, live_read_enabled, sellable_item_group_id, review_reason_codes FROM pdp_identity_listing`)).rows
      .map((r) => [r.source_listing_ref, r]));
    expect(rows['external_seed:pa']).toEqual(expect.objectContaining({ identity_status: 'review_required', matched_by_rule: 'singleton_source_ref',
      official_domain: 'theordinary.com', official_url: null, live_read_enabled: true, sellable_item_group_id: 'g_external_seed:pa' }));
    expect(rows['external_seed:pc']).toEqual(expect.objectContaining({ identity_status: 'review_required', review_required: true }));
    expect(rows['external_seed:pc'].review_reason_codes).toContain('manual_hold');
    // D untouched: still carries the retailer domain until someone allows the promotion
    expect(rows['external_seed:pd']).toEqual(expect.objectContaining({ identity_status: 'review_required', official_domain: 'ulta.com' }));
  });
});
