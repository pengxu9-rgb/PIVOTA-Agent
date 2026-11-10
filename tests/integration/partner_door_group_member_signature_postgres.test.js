const { Client } = require('pg');

// PARTNER_DOOR_ONE_PRODUCT_ID: the two statements src/services/partnerDoorOneProductId sends, executed on
// PostgreSQL over the partner-door fixture (tests/_support/partnerDoorFixture.cjs): a minted external-seed
// product (slug source_product_id, seed attached by product key, an approved live listing in a group), a mirror
// row and a connected-merchant row. For every group id and signature in the fixture the real statement must
// answer what the fixture's JS lookup answers, which is what the chained /mcp door test stands in for the
// database with. Then the gates the JS lookup does not model: a listing that is not approved, one under review,
// and a member whose merchant is not active.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const { IDS, rows, groupSignatures, signatureSellers } = require('../_support/partnerDoorFixture.cjs');

suite('partner door: group id -> product id on PostgreSQL', () => {
  let db;
  let schema;
  let priorDatabaseUrl;
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
        source_product_id text, pivota_signature_id text, source_domain text);
      CREATE TABLE catalog_merchants(merchant_id text PRIMARY KEY, status text);
      CREATE TABLE merchant_stores(merchant_id text, status text, domain text, platform text);
      CREATE TABLE external_product_seeds(external_product_id text, attached_product_key text, status text);
      CREATE TABLE pdp_identity_listing(merchant_id text, product_id text, sellable_item_group_id text,
        identity_status text, live_read_enabled boolean, review_required boolean);
    `);
    for (const m of rows.catalog_merchants) await db.query('INSERT INTO catalog_merchants VALUES ($1, $2)', [m.merchant_id, m.status]);
    for (const p of rows.catalog_products) {
      await db.query('INSERT INTO catalog_products VALUES ($1, $2, $3, $4, $5, $6, NULL)',
        [p.product_key, p.merchant_id, p.platform, p.source_system, p.source_product_id, p.pivota_signature_id]);
    }
    for (const s of rows.external_product_seeds) {
      await db.query('INSERT INTO external_product_seeds VALUES ($1, $2, $3)', [s.external_product_id, s.attached_product_key, s.status]);
    }
    for (const l of rows.pdp_identity_listing) {
      await db.query("INSERT INTO pdp_identity_listing VALUES ($1, $2, $3, 'approved', $4, false)",
        [l.merchant_id, l.product_id, l.sellable_item_group_id, l.live]);
    }
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    partnerDoor = require('../../src/services/partnerDoorOneProductId');
  });

  afterAll(async () => {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    try {
      await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await db?.end();
    }
  });

  const queryFn = (sql, params) => db.query(sql, params);
  const expectedFor = (groupId) => {
    const sigs = groupSignatures(groupId);
    if (sigs.length === 1) return { status: 'resolved', productId: sigs[0] };
    return sigs.length > 1 ? { status: 'several', count: sigs.length } : { status: 'none' };
  };

  test.each([
    ['minted', IDS.GROUP_MINTED, { status: 'resolved', productId: IDS.SIG_MINTED }],
    ['mirror', IDS.GROUP_MIRROR, { status: 'resolved', productId: IDS.SIG_MIRROR }],
    ['connected', IDS.GROUP_CONNECTED, { status: 'resolved', productId: IDS.SIG_CONNECTED }],
    ['several', IDS.GROUP_SEVERAL, { status: 'several', count: 2 }],
    ['not live', IDS.GROUP_NOT_LIVE, { status: 'none' }],
    ['unknown', IDS.GROUP_UNKNOWN, { status: 'none' }],
  ])('%s group: the statement answers what the fixture lookup answers', async (_name, groupId, literal) => {
    const answer = await partnerDoor.resolveGroupIdToProductId({ groupId, queryFn });
    expect(answer).toEqual(literal);
    expect(answer).toEqual(expectedFor(groupId));
  });

  test('the minted row is reached through its attached seed, not its slug', async () => {
    await db.query('BEGIN');
    try {
      await db.query('UPDATE external_product_seeds SET attached_product_key = NULL WHERE external_product_id = $1', [IDS.SEED_MINTED]);
      expect(await partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MINTED, queryFn })).toEqual({ status: 'none' });
    } finally {
      await db.query('ROLLBACK');
    }
  });

  test.each([
    ["identity_status = 'candidate'"],
    ['review_required = true'],
    ['live_read_enabled = false'],
  ])('a listing with %s resolves nothing', async (change) => {
    await db.query('BEGIN');
    try {
      await db.query(`UPDATE pdp_identity_listing SET ${change} WHERE sellable_item_group_id = $1`, [IDS.GROUP_MIRROR]);
      expect(await partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MIRROR, queryFn })).toEqual({ status: 'none' });
    } finally {
      await db.query('ROLLBACK');
    }
  });

  test('a member whose merchant is not active is not a product the group resolves to', async () => {
    await db.query('BEGIN');
    try {
      await db.query("UPDATE catalog_merchants SET status = 'suspended' WHERE merchant_id = $1", [IDS.SELLER_CONNECTED]);
      expect(await partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_CONNECTED, queryFn })).toEqual({ status: 'none' });
    } finally {
      await db.query('ROLLBACK');
    }
  });

  test('a statement that fails is "unavailable", never "none"', async () => {
    const answer = await partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MINTED, queryFn: async () => { throw new Error('down'); } });
    expect(answer).toEqual({ status: 'unavailable' });
  });

  test.each([
    [IDS.SIG_MINTED], [IDS.SIG_MIRROR], [IDS.SIG_CONNECTED], [IDS.SIG_NOT_SERVABLE],
  ])('sellers of %s: the statement answers what the fixture lookup answers', async (signature) => {
    const sellers = await partnerDoor.listSignatureSellerIds({ productId: signature, queryFn });
    expect([...sellers].sort()).toEqual(signatureSellers(signature));
  });
});
