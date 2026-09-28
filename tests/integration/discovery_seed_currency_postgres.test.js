const { Client } = require('pg');

// Peng 2026-09-26: a seed with no currency is never served. The discovery feed's card formatter
// stamps 'USD' on such a row (formatDiscoveryResponseProduct: `raw.currency || 'USD'`), so after
// recall it reads as a US price and the invoke door's servingCurrencyGuard cannot tell. Only the
// SQL can, so both places the feed's seed statements share are pinned here on real PostgreSQL:
//   - buildDiscoveryAttachedSeedServingExistsSql, the row scope of the recall / browse / exact-title
//     / beauty-interest statements;
//   - the brand-scoped by-id fetch (fetchBrandScopedExternalSeedCandidates), whose index-driven id
//     probes are deliberately left untouched.
// The shared predicate reads the currency the card shows (column -> seed_data.price_currency ->
// snapshot), so a row priced only in its payload is kept there. The by-id fetch must not detoast
// seed_data in its `picked` CTE, so it reads the column alone (#2389's rule) and refuses that row
// too. WHICH currency is the guard's call.

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('discovery seed statements refuse a currency-less seed, real PostgreSQL', () => {
  let db;
  let schema;
  let priorEnv;

  const seedRow = async ({ id, priceCurrency = 'USD', seedData = {} }) => {
    const key = `pk_${id}`;
    await db.query(
      `INSERT INTO catalog_products(product_key, content_key, pivota_signature_id, pivota_canonical_url, canonical_url, title)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [key, `ck_${id}`, `sig_${id}`, `https://agent.pivota.cc/products/sig_${id}`, `Laneige ${id}`],
    );
    await db.query("INSERT INTO catalog_row_trust(subject_type, subject_key, serving_decision) VALUES ('product', $1, 'public')", [key]);
    await db.query(
      `INSERT INTO external_product_seeds(id, external_product_id, market, tool, destination_url, canonical_url,
         domain, title, image_url, price_amount, price_currency, availability, seed_data, updated_at, created_at,
         status, attached_product_key)
       VALUES ($1, $1, 'US', 'creator_agents', $2, $2, 'laneige.com', $3, 'https://img.example/x.jpg', 20, $4, 'in_stock',
         $5, now(), now(), 'active', $6)`,
      [id, `https://laneige.com/${id}`, `Laneige ${id}`, priceCurrency, JSON.stringify({ brand: 'Laneige', ...seedData }), key],
    );
  };

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `discovery_seed_currency_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE external_product_seeds(id text PRIMARY KEY, external_product_id text, market text, tool text,
        destination_url text, canonical_url text, domain text, title text, image_url text,
        price_amount numeric, price_currency text, availability text, seed_data jsonb,
        updated_at timestamptz, created_at timestamptz, status text, attached_product_key text);
      CREATE TABLE catalog_products(product_key text PRIMARY KEY, content_key text, pivota_signature_id text,
        pivota_canonical_url text, canonical_url text, title text);
      CREATE TABLE catalog_row_trust(subject_type text, subject_key text, serving_decision text);
    `);
    await seedRow({ id: 'usd' });
    await seedRow({ id: 'sgd', priceCurrency: 'SGD' });
    await seedRow({ id: 'null', priceCurrency: null });
    await seedRow({ id: 'blank', priceCurrency: '  ' });
    await seedRow({ id: 'payload', priceCurrency: null, seedData: { price_currency: 'USD' } });
    await seedRow({ id: 'snapshot', priceCurrency: '', seedData: { snapshot: { price_currency: 'usd' } } });
    await seedRow({ id: 'blank_everywhere', priceCurrency: ' ', seedData: { price_currency: '', snapshot: { price_currency: ' ' } } });
  }, 60000);

  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  beforeEach(() => {
    priorEnv = { ...process.env };
    process.env.DATABASE_URL = url;
    delete process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET;
    jest.resetModules();
    jest.doMock('../../src/db', () => ({
      query: async (sql, params) => db.query(sql, params),
      withClient: async (fn) => fn({ query: async (sql, params) => db.query(sql, params) }),
    }));
  });
  afterEach(() => {
    process.env = priorEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
  });

  const KEPT = ['payload', 'sgd', 'snapshot', 'usd'];

  test('the shared serving predicate keeps a row with a currency anywhere, and refuses one with none', async () => {
    const { _internals } = require('../../src/services/discoveryFeed');
    for (const alias of ['external_product_seeds', 'eps']) {
      const res = await db.query(
        `SELECT ${alias}.id FROM external_product_seeds ${alias === 'eps' ? 'eps' : ''}
         WHERE ${_internals.buildDiscoveryAttachedSeedServingExistsSql(alias)} ORDER BY 1`,
      );
      expect({ alias, ids: res.rows.map((r) => r.id) }).toEqual({ alias, ids: KEPT });
    }
  });

  test('the brand-scoped lane serves no currency-less seed, judged on the column', async () => {
    const { _internals } = require('../../src/services/discoveryFeed');
    const products = await _internals.fetchBrandScopedExternalSeedCandidates({ brandAliases: ['laneige'], limit: 24 });
    const ids = products.map((p) => String(p.external_seed_id || p.external_product_id || p.source_product_id || p.product_id)).sort();
    // The control: the lane really did reach this brand's rows.
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toEqual(['sgd', 'usd']);
  });
});
