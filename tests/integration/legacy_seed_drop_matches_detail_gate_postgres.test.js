const { Client } = require('pg');

// FIX_PLAN D-06, second delta review P2-N1: search drops a legacy `<slug>:<hex>` row only when no lane can open
// it, and the lane that opens it is the gated seed read (legacySeedIdServability.LEGACY_SEED_DETAIL_MATCH_CLAUSE).
// So the two statements must agree, on the REAL database:
//   - every id the drop keeps is one the detail read serves, for at least one buyer market;
//   - every id the detail read refuses for every market (quarantined, attached, seed_data-only, seed-id-only,
//     inactive, currency-less, or no seed at all) is dropped.
// Both statements run as the gateway runs them: the drop through confirmNoOpenableLegacySeeds, the detail through
// server.js fetchExternalSeedProductDetailFromDb with the route's gate. All hosts and names are placeholders.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MARKETS = ['US', 'GB', 'JP', 'FR', 'AU', 'SE', 'KR', 'HK', 'SG', 'CA'];

// id -> [why, expected to open for some market]
const CASES = {
  'shop-a:00000000000000a1': ['USD seed', true],
  'shop-s:00000000000000a2': ['SGD seed filed under US', true],
  'shop-j:00000000000000a3': ['JPY seed', true],
  'shop-q:00000000000000a4': ['quarantined source domain (other case)', false],
  'shop-t:00000000000000a5': ['attached to a catalog product', false],
  'shop-r:00000000000000a6': ['only in seed_data.product_id of another seed', false],
  'shop-e:00000000000000a7': ['only in seed_data.external_product_id of another seed', false],
  'shop-p:00000000000000a8': ['only in the snapshot product_id of another seed', false],
  'shop-i:00000000000000a9': ['inactive', false],
  'shop-b:00000000000000aa': ['blank currency', false],
  'shop-m:00000000000000ab': ['column and page read disagree', false],
  'shop-x:00000000000000ac': ['a currency no market is served in', false],
  'shop-z:00000000000000ad': ['no seed at all', false],
  'shop-v:00000000000000ae': ['quarantine revoked', true],
  'shop-w:00000000000000af': ['one inactive and one active row', true],
  'shop-y:00000000000000b0': ["only as another seed's own id", false],
};

suite('the legacy seed drop and the gated detail read agree on PostgreSQL', () => {
  let db;
  let schema;
  let app;
  let servability;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `legacy_seed_gate_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE external_product_seeds (
        id text PRIMARY KEY, external_product_id text, destination_url text, canonical_url text, domain text,
        title text, image_url text, price_amount numeric, price_currency text, availability text,
        attached_product_key text, seed_data jsonb, updated_at timestamptz, created_at timestamptz,
        status text, market text);
      CREATE TABLE catalog_source_quarantine (
        quarantine_id text, match_type text, match_value text, state text, expires_at timestamptz);
      CREATE TABLE catalog_products (product_key text PRIMARY KEY);
    `);
    await db.query(`INSERT INTO catalog_source_quarantine VALUES
      ('q1', 'domain', 'Shop-Q.example', 'active', NULL),
      ('q2', 'domain', 'shop-v.example', 'revoked', NULL)`);
    const seed = (id, ext, domain, cur, over = {}) => [
      id, ext, `https://${domain}/products/item`, null, domain, `Placeholder ${id}`, null, 20, cur, 'in_stock',
      over.attached || null, JSON.stringify(over.seedData || { title: `Placeholder ${id}` }), over.status || 'active',
    ];
    const rows = [
      seed('s1', 'shop-a:00000000000000a1', 'shop-a.example', 'USD'),
      seed('s2', 'shop-s:00000000000000a2', 'shop-s.example', 'SGD', { seedData: { title: 'S', snapshot: { price_currency: 'SGD' } } }),
      seed('s3', 'shop-j:00000000000000a3', 'shop-j.example', 'JPY'),
      seed('s4', 'shop-q:00000000000000a4', 'shop-q.example', 'USD'),
      seed('s5', 'shop-t:00000000000000a5', 'shop-t.example', 'USD', { attached: 'pk_attached_1' }),
      seed('s6', 'ext_rekeyed_placeholder_6', 'shop-r.example', 'USD', { seedData: { product_id: 'shop-r:00000000000000a6' } }),
      seed('s7', 'ext_rekeyed_placeholder_7', 'shop-e.example', 'USD', { seedData: { external_product_id: 'shop-e:00000000000000a7' } }),
      seed('s8', 'ext_rekeyed_placeholder_8', 'shop-p.example', 'USD', { seedData: { snapshot: { product_id: 'shop-p:00000000000000a8' } } }),
      seed('s9', 'shop-i:00000000000000a9', 'shop-i.example', 'USD', { status: 'inactive' }),
      seed('s10', 'shop-b:00000000000000aa', 'shop-b.example', null),
      seed('s11', 'shop-m:00000000000000ab', 'shop-m.example', 'USD', { seedData: { snapshot: { price_currency: 'GBP' } } }),
      seed('s12', 'shop-x:00000000000000ac', 'shop-x.example', 'MYR'),
      seed('s14', 'shop-v:00000000000000ae', 'shop-v.example', 'USD'),
      seed('s15', 'shop-w:00000000000000af', 'shop-w.example', 'USD', { status: 'inactive' }),
      seed('s16', 'shop-w:00000000000000af', 'shop-w.example', 'USD'),
      // a seed whose own id is a legacy-shaped string: the seed-id branch of the old, wider match
      seed('shop-y:00000000000000b0', 'ext_rekeyed_placeholder_17', 'shop-y.example', 'USD'),
    ];
    for (const r of rows) {
      await db.query(
        `INSERT INTO external_product_seeds (id, external_product_id, destination_url, canonical_url, domain, title,
           image_url, price_amount, price_currency, availability, attached_product_key, seed_data, status,
           updated_at, created_at, market)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13, now(), now(), 'US')`,
        r,
      );
    }

    const parsed = new URL(url);
    parsed.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = parsed.toString();
    jest.resetModules();
    app = require('../../src/server');
    servability = require('../../src/services/legacySeedIdServability');
  });

  afterAll(async () => {
    try {
      await require('../../src/db').closePool();
    } catch (_) {
      // the pool may never have opened
    }
    if (db) {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    }
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  it('every id the drop keeps opens for some market, and every id that opens for none is dropped', async () => {
    const ids = Object.keys(CASES);
    const dead = await servability.confirmNoOpenableLegacySeeds(ids, {
      queryFn: (sql, params) => db.query(sql, params),
    });
    const fetchDetail = app._debug.fetchExternalSeedProductDetailFromDb;
    const report = [];
    for (const id of ids) {
      const servedIn = [];
      for (const market of MARKETS) {
        const gate = servability.legacySeedDetailGate(market);
        const detail = await fetchDetail({ productId: id, legacySeedGate: gate });
        if (detail && detail.product && servability.isLegacySeedDetailServable(detail.product, gate)) servedIn.push(market);
      }
      report.push({ id, why: CASES[id][0], dropped: dead.get(id), servedIn });
    }
    for (const r of report) {
      expect({ id: r.id, why: r.why, dropped: r.dropped }).toEqual({ id: r.id, why: r.why, dropped: r.servedIn.length === 0 });
      expect({ id: r.id, why: r.why, opens: r.servedIn.length > 0 }).toEqual({ id: r.id, why: r.why, opens: CASES[r.id][1] });
    }
    expect(report.find((r) => r.id === 'shop-s:00000000000000a2').servedIn).toEqual(['SG']);
    expect(report.find((r) => r.id === 'shop-a:00000000000000a1').servedIn).toEqual(['US']);
  });

  it('the old, wider match would have kept the rows the route refuses (what P2-N1 fixed)', async () => {
    const { __internal } = require('../../src/services/signatureSeedNotActive');
    const wider = [];
    for (const id of ['shop-q:00000000000000a4', 'shop-t:00000000000000a5', 'shop-r:00000000000000a6', 'shop-y:00000000000000b0']) {
      const res = await db.query(__internal.ACTIVE_SEED_MATCH_SQL, [id]);
      if (__internal.ACTIVE_SEED_MATCH_BRANCHES.some(([name]) => res.rows[0][name] === true)) wider.push(id);
    }
    expect(wider).toHaveLength(4);
  });
});
