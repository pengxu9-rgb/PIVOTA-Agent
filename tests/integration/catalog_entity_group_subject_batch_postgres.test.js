const { Client } = require('pg');

// A relationship-graph card whose public id is a pg_ group renders through the signature
// get_pdp_v2 resolves for that group (resolveProductGroupSubjectSignatureId). The similar rail
// judges a dozen such cards at once through resolveProductGroupSubjectSignatureIds, a batched
// copy of that statement. This executes BOTH on PostgreSQL over groups built to separate every
// ranking step (primary flag, lifecycle, mint time, update time, product_key, the 100-member
// cap) and the gates (active source, signed member), and requires the batch to answer exactly
// what the single-group resolver answers for every group.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const sig = (n) => `sig_${String(n).padStart(32, '0')}`;

suite('pg_ subject signature batch on PostgreSQL', () => {
  let db;
  let schema;
  let priorEnv;

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `entity_group_subject_batch_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE catalog_products(product_key text PRIMARY KEY, merchant_id text, platform text, source_product_id text,
        title text, description text, brand text, category text, product_type text, category_path text, canonical_url text,
        image_url text, product_payload jsonb, pdp_lifecycle_stage text, sync_status text, pivota_signature_id text, pivota_canonical_url text,
        pivota_signature_minted_at timestamptz, content_key text, updated_at timestamptz, source_domain text);
      CREATE UNIQUE INDEX ON catalog_products(pivota_signature_id) WHERE pivota_signature_id IS NOT NULL;
      CREATE INDEX ON catalog_products(content_key) WHERE content_key IS NOT NULL;
      CREATE TABLE catalog_merchants(merchant_id text PRIMARY KEY, merchant_name text, status text);
      CREATE TABLE product_group_members(merchant_id text, platform text, platform_product_id text, product_group_id text,
        is_primary boolean, PRIMARY KEY (merchant_id, platform, platform_product_id));
      CREATE INDEX ON product_group_members(product_group_id);
      CREATE TABLE merchant_stores(merchant_id text, status text, domain text, platform text);
      CREATE TABLE catalog_skus(sku_key text PRIMARY KEY, product_key text);
      CREATE TABLE catalog_offers(offer_id text PRIMARY KEY, sku_key text);
    `);
    await db.query(`
      INSERT INTO catalog_merchants VALUES
        ('merch_obs_a', 'Seller A', 'observed'),
        ('merch_obs_b', 'Seller B', 'observed'),
        ('merch_suspended', 'Seller S', 'suspended')
    `);
    let n = 0;
    const product = async ({ key, merchant = 'merch_obs_a', content = null, signed = true, stage = 'published', minted = null, updated = '2026-01-01', group = null, primary = false }) => {
      n += 1;
      const source = `src_${key}`;
      await db.query(
        `INSERT INTO catalog_products(product_key, merchant_id, platform, source_product_id, title, brand, category_path,
           canonical_url, product_payload, pdp_lifecycle_stage, pivota_signature_id, pivota_signature_minted_at, content_key, updated_at)
         VALUES ($1, $2, 'external_seed', $3, $1, 'Brand', 'beauty/skincare', 'https://x.example/' || $1, '{}'::jsonb,
           $4, $5, $6::timestamptz, $7, $8::timestamptz)`,
        [key, merchant, source, stage, signed ? sig(n) : null, minted, content, updated],
      );
      if (group) {
        await db.query('INSERT INTO product_group_members VALUES ($1, $2, $3, $4, $5)', [merchant, 'external_seed', source, group, primary]);
      }
    };
    // pg_primary: the primary member wins over a better-staged non-primary and a content sibling.
    await product({ key: 'p1', group: 'pg_primary', primary: true, stage: 'candidate', content: 'ck_p' });
    await product({ key: 'p2', group: 'pg_primary', stage: 'published', minted: '2025-01-01' });
    await product({ key: 'p3', content: 'ck_p', stage: 'published', merchant: 'merch_obs_b' });
    // pg_stage: no primary; validated beats candidate even though the candidate was minted first.
    await product({ key: 's1', group: 'pg_stage', stage: 'candidate', minted: '2025-01-01' });
    await product({ key: 's2', group: 'pg_stage', stage: 'validated', minted: '2026-01-01' });
    // pg_minted: same stage; the earlier mint wins; an unminted row loses to both.
    await product({ key: 'm1', group: 'pg_minted', minted: '2026-03-01' });
    await product({ key: 'm2', group: 'pg_minted', minted: '2026-02-01' });
    await product({ key: 'm3', group: 'pg_minted' });
    // pg_inactive_primary: the primary member's merchant is suspended -> the other member renders.
    await product({ key: 'i1', group: 'pg_inactive_primary', primary: true, merchant: 'merch_suspended' });
    await product({ key: 'i2', group: 'pg_inactive_primary', stage: 'draft' });
    // pg_unsigned: its only member has no signature -> no subject signature.
    await product({ key: 'u1', group: 'pg_unsigned', signed: false });
    // pg_suspended: its only member is gated out -> no target, no subject signature.
    await product({ key: 'x1', group: 'pg_suspended', merchant: 'merch_suspended' });
    // pg_foreign_primary: the target's content sibling is the primary of ANOTHER group -> it is a
    // member here too and, being primary, is the subject.
    await product({ key: 'f1', group: 'pg_foreign_primary', content: 'ck_f', minted: '2025-01-01' });
    await product({ key: 'f2', group: 'pg_other', primary: true, content: 'ck_f', stage: 'draft' });
    // pg_target_gate: the primary member is gated out; had it been the target, its content sibling t3
    // (published, outside the group) would join and win. The gated target pick keeps t3 out.
    await product({ key: 't1', group: 'pg_target_gate', primary: true, merchant: 'merch_suspended', content: 'ck_t' });
    await product({ key: 't2', group: 'pg_target_gate', stage: 'draft' });
    await product({ key: 't3', content: 'ck_t', merchant: 'merch_obs_b' });
    // pg_target_rank: the target is the primary r1, so r2's content sibling r3 (another group's primary,
    // published) never joins; a target pick that chose r2 would make r3 the subject.
    await product({ key: 'r1', group: 'pg_target_rank', primary: true, stage: 'draft', content: 'ck_r1', updated: '2025-01-01' });
    await product({ key: 'r2', group: 'pg_target_rank', content: 'ck_r2', updated: '2026-06-01' });
    await product({ key: 'r3', group: 'pg_rx', primary: true, content: 'ck_r2', merchant: 'merch_obs_b' });
    // pg_unsigned_primary: the primary member is unsigned; only signed members are candidates, so the
    // signed draft renders (an unsigned primary in the candidate set would leave no subject signature).
    await product({ key: 'v1', group: 'pg_unsigned_primary', primary: true, signed: false });
    await product({ key: 'v2', group: 'pg_unsigned_primary', stage: 'draft' });
    // pg_two_primaries: two primary members (q2 is another group's primary, joined by content_key). The
    // subject is the FIRST primary in the statement's member order: the published q1, although the
    // draft q2 was updated later.
    await product({ key: 'q1', group: 'pg_two_primaries', primary: true, content: 'ck_q', updated: '2025-01-01' });
    await product({ key: 'q2', group: 'pg_qx', primary: true, content: 'ck_q', stage: 'draft', merchant: 'merch_obs_b', updated: '2026-06-01' });
    // pg_full_tie: two primaries (z2 is another group's primary, joined by content_key) tied on stage,
    // mint and update time; product_key breaks the tie, so z1 is the subject although z2 was written first.
    await product({ key: 'z2', group: 'pg_zx', primary: true, content: 'ck_z', merchant: 'merch_obs_b' });
    await product({ key: 'z1', group: 'pg_full_tie', primary: true, content: 'ck_z' });
    // pg_wide: 103 tied members; updated_at descends as product_key ascends, so the SQL cap keeps the
    // 100 newest and drops w000..w002, which the JS comparator (product_key) would otherwise pick.
    for (let i = 0; i < 103; i += 1) {
      const key = `w${String(i).padStart(3, '0')}`;
      await product({ key, group: 'pg_wide', updated: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString() });
    }
  });

  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  beforeEach(() => {
    priorEnv = { ...process.env };
    process.env.DATABASE_URL = url;
    jest.resetModules();
  });
  afterEach(() => {
    process.env = priorEnv;
  });

  const groups = [
    'pg_primary',
    'pg_stage',
    'pg_minted',
    'pg_inactive_primary',
    'pg_unsigned',
    'pg_suspended',
    'pg_foreign_primary',
    'pg_target_gate',
    'pg_target_rank',
    'pg_unsigned_primary',
    'pg_two_primaries',
    'pg_full_tie',
    'pg_wide',
    'pg_missing',
  ];
  const sigOf = async (key) => (await db.query('SELECT pivota_signature_id FROM catalog_products WHERE product_key = $1', [key])).rows[0].pivota_signature_id;

  test('the batch answers exactly what the single-group resolver answers, in one statement', async () => {
    const resolution = require('../../src/services/catalogEntityResolution');
    const batchCalls = [];
    const batch = await resolution.resolveProductGroupSubjectSignatureIds({
      productGroupIds: [...groups, 'pg_primary', 'sig_not_a_group', ''],
      queryFn: async (sql, params) => {
        batchCalls.push(sql);
        return db.query(sql, params);
      },
    });
    expect(batchCalls).toHaveLength(1);
    expect(Array.from(batch.keys()).sort()).toEqual([...groups].sort());
    for (const groupId of groups) {
      const single = await resolution.resolveProductGroupSubjectSignatureId({
        productGroupId: groupId,
        queryFn: (sql, params) => db.query(sql, params),
      });
      expect([groupId, batch.get(groupId)]).toEqual([groupId, single]);
    }
  });

  test('each ranking step and gate picks the member get_pdp_v2 renders', async () => {
    const { resolveProductGroupSubjectSignatureIds } = require('../../src/services/catalogEntityResolution');
    const batch = await resolveProductGroupSubjectSignatureIds({
      productGroupIds: groups,
      queryFn: (sql, params) => db.query(sql, params),
    });
    expect(batch.get('pg_primary')).toBe(await sigOf('p1'));
    expect(batch.get('pg_stage')).toBe(await sigOf('s2'));
    expect(batch.get('pg_minted')).toBe(await sigOf('m2'));
    expect(batch.get('pg_inactive_primary')).toBe(await sigOf('i2'));
    expect(batch.get('pg_unsigned')).toBeNull();
    expect(batch.get('pg_suspended')).toBeNull();
    expect(batch.get('pg_foreign_primary')).toBe(await sigOf('f2'));
    expect(batch.get('pg_target_gate')).toBe(await sigOf('t2'));
    expect(batch.get('pg_target_rank')).toBe(await sigOf('r1'));
    expect(batch.get('pg_unsigned_primary')).toBe(await sigOf('v2'));
    expect(batch.get('pg_two_primaries')).toBe(await sigOf('q1'));
    expect(batch.get('pg_full_tie')).toBe(await sigOf('z1'));
    expect(batch.get('pg_wide')).toBe(await sigOf('w003'));
    expect(batch.get('pg_missing')).toBeNull();
  });

  test('no pg_ ids issues no statement', async () => {
    const { resolveProductGroupSubjectSignatureIds } = require('../../src/services/catalogEntityResolution');
    const queryFn = jest.fn();
    const batch = await resolveProductGroupSubjectSignatureIds({ productGroupIds: ['sig_x', 'pg:shopify:1'], queryFn });
    expect(queryFn).not.toHaveBeenCalled();
    expect(batch.size).toBe(0);
  });
});
