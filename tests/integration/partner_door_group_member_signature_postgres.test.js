const { Client } = require('pg');

// PARTNER_DOOR_ONE_PRODUCT_ID: a group id -> the product get_pdp_v2's own group lookup elects, on PostgreSQL.
//
// The REAL lookup (pdpIdentityGraph.resolveLivePdpIdentityGroupForPdp, with its active-seed filter) and the
// door's two statements run over the partner-door fixture (tests/_support/partnerDoorFixture.cjs): a minted
// external-seed product, a mirror row, a connected-merchant row, and ONE product listed by two sellers. For
// every group id the answer must be the fixture's literal table, and the fixture's JS stand-ins (what the
// chained /mcp door test runs instead of a database) must give that same answer. Then the gates: listing
// status, an inactive seed, an inactive merchant, the minted-only attached arm, and the order refs are tried in.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const fixture = require('../_support/partnerDoorFixture.cjs');

const { IDS, rows, GROUP_PRODUCT } = fixture;
const ORIGINAL_ENV = process.env;

suite('partner door: group id -> product id on PostgreSQL', () => {
  let db;
  let schema;
  let partnerDoor;

  beforeAll(async () => {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('a loopback test database is required');
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `partner_door_group_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE catalog_products(product_key text PRIMARY KEY, merchant_id text, platform text, source_system text,
        source_product_id text, title text, description text, brand text, category text, product_type text,
        category_path text, canonical_url text, image_url text, product_payload jsonb, pdp_lifecycle_stage text,
        sync_status text, pivota_signature_id text, pivota_canonical_url text, pivota_signature_minted_at timestamptz,
        content_key text, updated_at timestamptz, source_domain text);
      CREATE TABLE catalog_merchants(merchant_id text PRIMARY KEY, merchant_name text, status text);
      CREATE TABLE merchant_stores(merchant_id text, status text, domain text, platform text);
      CREATE TABLE product_group_members(merchant_id text, platform text, platform_product_id text, product_group_id text, is_primary boolean);
      CREATE TABLE catalog_skus(sku_key text PRIMARY KEY, product_key text);
      CREATE TABLE catalog_offers(offer_id text PRIMARY KEY, sku_key text);
      CREATE TABLE index_pipeline_state(content_key text PRIMARY KEY, serving_eligible boolean);
      CREATE TABLE external_product_seeds(external_product_id text, attached_product_key text, status text);
      CREATE TABLE pdp_identity_listing(source_listing_ref text PRIMARY KEY, merchant_id text, product_id text,
        source_kind text, source_tier text, sellable_item_group_id text, product_line_id text, review_family_id text,
        identity_status text, identity_confidence numeric, live_read_enabled boolean, review_required boolean,
        brand_norm text, match_basis jsonb, review_reason_codes jsonb, strong_identity jsonb, soft_identity jsonb,
        variant_axes jsonb, source_payload jsonb, review_summary jsonb, created_at timestamptz, updated_at timestamptz);
    `);
    for (const m of rows.catalog_merchants) await db.query('INSERT INTO catalog_merchants VALUES ($1, $1, $2)', [m.merchant_id, m.status]);
    for (const p of rows.catalog_products) {
      await db.query(
        `INSERT INTO catalog_products(product_key, merchant_id, platform, source_system, source_product_id, title, sync_status,
           pivota_signature_id, content_key, updated_at)
         VALUES ($1, $2, $3, $4, $5, $1, 'live', $6, 'ck_' || md5($1), '2026-01-01')`,
        [p.product_key, p.merchant_id, p.platform, p.source_system, p.source_product_id, p.pivota_signature_id],
      );
      await db.query("INSERT INTO index_pipeline_state VALUES ('ck_' || md5($1), true)", [p.product_key]);
    }
    for (const s of rows.external_product_seeds) {
      await db.query('INSERT INTO external_product_seeds VALUES ($1, $2, $3)', [s.external_product_id, s.attached_product_key, s.status]);
    }
    let n = 0;
    for (const l of rows.pdp_identity_listing) {
      n += 1;
      await db.query(
        `INSERT INTO pdp_identity_listing(source_listing_ref, merchant_id, product_id, source_kind, source_tier,
           sellable_item_group_id, identity_status, identity_confidence, live_read_enabled, review_required,
           source_payload, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'approved', $7, $8, false, $9::jsonb, $10::timestamptz, $10::timestamptz)`,
        [`${l.merchant_id}:${l.product_id}`, l.merchant_id, l.product_id, l.source_kind, l.source_tier, l.sellable_item_group_id,
          l.confidence, l.live, JSON.stringify({ title: `Listing ${n}`, brand: 'Brand' }), `2026-01-${String(n).padStart(2, '0')}`],
      );
    }
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, DATABASE_URL: url, PDP_IDENTITY_GRAPH_ENABLED: 'true' };
    partnerDoor = require('../../src/services/partnerDoorOneProductId');
  });

  afterAll(async () => {
    process.env = ORIGINAL_ENV;
    try {
      await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await db?.end();
    }
  });

  const queryFn = (sql, params) => db.query(sql, params);
  const resolve = (groupId) => partnerDoor.resolveGroupIdToProductId({ groupId, queryFn });
  const answerFor = (signature) => (signature ? { status: 'resolved', productId: signature } : { status: 'none' });
  // The same question, answered by the fixture's JS stand-ins instead of the database.
  const resolveWithStandIns = async (groupId) => {
    partnerDoor.usePartnerDoorQueryForTest(fixture.fixtureQuery);
    partnerDoor.usePartnerDoorGroupLookupForTest(fixture.groupLookup);
    try {
      return await partnerDoor.resolveGroupIdToProductId({ groupId });
    } finally {
      partnerDoor.usePartnerDoorQueryForTest(null);
      partnerDoor.usePartnerDoorGroupLookupForTest(null);
    }
  };
  const inTransaction = async (fn) => {
    await db.query('BEGIN');
    try {
      await fn();
    } finally {
      await db.query('ROLLBACK');
    }
  };

  test.each(Object.entries(GROUP_PRODUCT))('group %s: the real lookup and the stand-ins both answer the fixture table', async (groupId, signature) => {
    expect(await resolve(groupId)).toEqual(answerFor(signature));
    expect(await resolveWithStandIns(groupId)).toEqual(answerFor(signature));
  });

  test('one product listed by two sellers resolves to the canonical (brand) member, as get_pdp_v2 serves it', async () => {
    const { resolveLivePdpIdentityGroupForPdp } = require('../../src/services/pdpIdentityGraph');
    const real = await resolveLivePdpIdentityGroupForPdp({ productGroupId: IDS.GROUP_SHARED, queryFn });
    const standIn = await fixture.groupLookup({ productGroupId: IDS.GROUP_SHARED });
    expect(real.canonical_product_ref).toEqual({ merchant_id: IDS.SELLER_SHARED_BRAND, product_id: IDS.SEED_SHARED_BRAND });
    expect(standIn.canonical_product_ref).toEqual(real.canonical_product_ref);
    expect(real.group_members.map((m) => m.merchant_id).sort()).toEqual([IDS.SELLER_CONNECTED, IDS.SELLER_SHARED_BRAND].sort());
    expect(await resolve(IDS.GROUP_SHARED)).toEqual({ status: 'resolved', productId: IDS.SIG_SHARED_BRAND });
  });

  test('the lookup\'s active-seed filter applies: an inactive brand seed leaves the retailer\'s listing to answer', async () => {
    await inTransaction(async () => {
      await db.query("UPDATE external_product_seeds SET status = 'inactive' WHERE external_product_id = $1", [IDS.SEED_SHARED_BRAND]);
      expect(await resolve(IDS.GROUP_SHARED)).toEqual({ status: 'resolved', productId: IDS.SIG_SHARED_RETAILER });
    });
    await inTransaction(async () => {
      await db.query("UPDATE external_product_seeds SET status = 'inactive' WHERE external_product_id = $1", [IDS.SEED_MIRROR]);
      expect(await resolve(IDS.GROUP_MIRROR)).toEqual({ status: 'none' });
    });
  });

  test('a canonical member with no signed row falls to the next member', async () => {
    await inTransaction(async () => {
      await db.query('UPDATE catalog_products SET pivota_signature_id = NULL WHERE pivota_signature_id = $1', [IDS.SIG_SHARED_BRAND]);
      expect(await resolve(IDS.GROUP_SHARED)).toEqual({ status: 'resolved', productId: IDS.SIG_SHARED_RETAILER });
    });
  });

  test('the minted row is reached through its attached seed, not its slug', async () => {
    await inTransaction(async () => {
      await db.query('UPDATE external_product_seeds SET attached_product_key = NULL WHERE external_product_id = $1', [IDS.SEED_MINTED]);
      expect(await resolve(IDS.GROUP_MINTED)).toEqual({ status: 'none' });
    });
  });

  test.each([
    ["identity_status = 'candidate'"],
    ['review_required = true'],
    ['live_read_enabled = false'],
  ])('a listing with %s resolves nothing', async (change) => {
    await inTransaction(async () => {
      await db.query(`UPDATE pdp_identity_listing SET ${change} WHERE sellable_item_group_id = $1`, [IDS.GROUP_CONNECTED]);
      expect(await resolve(IDS.GROUP_CONNECTED)).toEqual({ status: 'none' });
    });
  });

  test('a member whose merchant is not active is not a product the group resolves to', async () => {
    await inTransaction(async () => {
      await db.query("UPDATE catalog_merchants SET status = 'suspended' WHERE merchant_id = $1", [IDS.SELLER_CONNECTED]);
      expect(await resolve(IDS.GROUP_CONNECTED)).toEqual({ status: 'none' });
    });
  });

  // The ref -> signature statement on its own.
  const refSignature = async (refs) => {
    const res = await db.query(partnerDoor.LISTING_REF_SIGNATURE_SQL, [refs.map((r) => r[0]), refs.map((r) => r[1])]);
    return res.rows.map((r) => r.pivota_signature_id);
  };

  test('ref -> signature: each fixture ref answers what the stand-in answers', async () => {
    for (const l of rows.pdp_identity_listing) {
      const expected = fixture.refSignature(l.merchant_id, l.product_id);
      expect(await refSignature([[l.merchant_id, l.product_id]])).toEqual(expected ? [expected] : []);
    }
  });

  test('ref -> signature: the attached-seed arm reaches MINTED rows only', async () => {
    await inTransaction(async () => {
      // A seed attached by product key to a row that is not a minted canonical: its listing ref is not that row.
      await db.query("INSERT INTO external_product_seeds VALUES ('brand-q:00000000000000aa', 'prod::shop-a::9002', 'active')");
      expect(await refSignature([[IDS.SELLER_OTHER_OBSERVED, 'brand-q:00000000000000aa']])).toEqual([]);
      await db.query("UPDATE catalog_products SET source_system = 'catalog_enrichment_agent_v1' WHERE product_key = 'prod::shop-a::9002'");
      expect(await refSignature([[IDS.SELLER_OTHER_OBSERVED, 'brand-q:00000000000000aa']])).toEqual([IDS.SIG_SHARED_RETAILER]);
    });
  });

  test('ref -> signature: refs are tried in the order given; within a ref the row keyed on its own ids wins', async () => {
    const brand = [IDS.SELLER_SHARED_BRAND, IDS.SEED_SHARED_BRAND];
    const retailer = [IDS.SELLER_CONNECTED, IDS.SOURCE_SHARED_RETAILER];
    expect(await refSignature([brand, retailer])).toEqual([IDS.SIG_SHARED_BRAND]);
    expect(await refSignature([retailer, brand])).toEqual([IDS.SIG_SHARED_RETAILER]);
    expect(await refSignature([[IDS.SELLER_CONNECTED, '9003'], retailer])).toEqual([IDS.SIG_SHARED_RETAILER]);
    await inTransaction(async () => {
      // The mirror seed is ALSO attached to the minted row: the mirror row (the ref's own ids) still answers.
      await db.query('UPDATE external_product_seeds SET attached_product_key = $1 WHERE external_product_id = $2', ['ext:brand-x-calm-serum::00000001', IDS.SEED_MIRROR]);
      expect(await refSignature([[IDS.SELLER_MIRROR, IDS.SEED_MIRROR]])).toEqual([IDS.SIG_MIRROR]);
    });
  });

  test('a statement that fails is "unavailable", never "none", whichever statement it is', async () => {
    const failing = async () => { throw new Error('down'); };
    expect(await partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MINTED, queryFn: failing })).toEqual({ status: 'unavailable' });
    const failSecond = async (sql, params) => {
      if (String(sql).includes('partner_door_listing_ref_signature')) throw new Error('down');
      return db.query(sql, params);
    };
    expect(await partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MINTED, queryFn: failSecond })).toEqual({ status: 'unavailable' });
  });

  test.each([
    [IDS.SIG_MINTED], [IDS.SIG_MIRROR], [IDS.SIG_CONNECTED], [IDS.SIG_FALLBACK], [IDS.SIG_NOT_SERVABLE],
  ])('sellers of %s: the statement answers what the fixture lookup answers', async (signature) => {
    const sellers = await partnerDoor.listSignatureSellerIds({ productId: signature, queryFn });
    expect([...sellers].sort()).toEqual(fixture.signatureSellers(signature));
  });

  test('the connected merchant\'s signature -> platform id translation agrees with the stand-in', async () => {
    const { resolveMerchantScopedSourceProductId } = require('../../src/services/catalogEntityResolution');
    for (const [merchantId, signature, expected] of [
      [IDS.SELLER_CONNECTED, IDS.SIG_CONNECTED, IDS.SOURCE_CONNECTED],
      [IDS.SELLER_OTHER_CONNECTED, IDS.SIG_CONNECTED, null],
      [IDS.SELLER_CONNECTED, IDS.SIG_MINTED, null],
    ]) {
      expect(await resolveMerchantScopedSourceProductId({ productId: signature, merchantId, queryFn })).toBe(expected);
      expect(await resolveMerchantScopedSourceProductId({ productId: signature, merchantId, queryFn: fixture.fixtureQuery })).toBe(expected);
    }
  });
});
