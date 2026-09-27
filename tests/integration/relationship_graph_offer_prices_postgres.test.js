const { Client } = require('pg');

// get_alternatives pairs a stored bare amount with its listing's currency by reading the offers each edge ref
// resolves to (productRelationshipGraph.listCatalogOfferPricesForRefs). Prod 2026-09-27: every serving edge
// held currency-less amounts, and seed catalog rows keep price only on catalog_offers. This runs the REAL
// statement against PostgreSQL and pins what each ref form resolves to: a sig, a source id, a bare product
// key, a source id whose colon is part of the id, a product group through its members, mixed case, and a ref
// that matches nothing — plus the offers that must never name a currency (suppressed, currency-less).
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('relationship graph offer prices on PostgreSQL', () => {
  let db;
  let schema;

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `rg_offer_prices_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE catalog_products(product_key text PRIMARY KEY, merchant_id text, platform text, source_product_id varchar,
        canonical_url text, pivota_signature_id text, pivota_canonical_url text);
      CREATE TABLE product_group_members(merchant_id text, platform text, platform_product_id text, product_group_id text,
        is_primary boolean, PRIMARY KEY (merchant_id, platform, platform_product_id));
      CREATE TABLE catalog_offers(offer_id text PRIMARY KEY, product_key text, currency varchar(8),
        list_price numeric(12,2), merchant_effective_price numeric(12,2), estimated_best_price numeric(12,2),
        suppressed_at timestamptz);
      CREATE INDEX ON catalog_offers(product_key);
    `);
    const product = (key, source, sig = null, merchant = 'merch_a') => db.query(
      `INSERT INTO catalog_products(product_key, merchant_id, platform, source_product_id, pivota_signature_id)
       VALUES ($1, $2, 'external_seed', $3, $4)`,
      [key, merchant, source, sig],
    );
    await product('P1', 'src_p1', 'sig_a');
    await product('P2', 'ext_b');
    await product('pk_c', 'src_c');
    await product('P4', 'retailer:xyz');
    await product('P5', 'src_p5', null, 'merch_us');
    await product('P6', 'src_p6', null, 'merch_sg');
    await db.query(`
      INSERT INTO product_group_members VALUES
        ('merch_us', 'external_seed', 'src_p5', 'pg_grp', true),
        ('merch_sg', 'external_seed', 'src_p6', 'pg_grp', false)
    `);
    const offer = (id, key, currency, list, effective = null, best = null, suppressed = null) => db.query(
      'INSERT INTO catalog_offers VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, key, currency, list, effective, best, suppressed],
    );
    await offer('o1', 'P1', 'USD', 11.99, 11.99, 11.99);
    await offer('o1_suppressed', 'P1', 'EUR', 11.99, null, null, '2026-09-01');
    await offer('o1_no_currency', 'P1', null, 11.99);
    await offer('o2', 'P2', 'USD', 20);
    await offer('o3', 'pk_c', 'JPY', 1650);
    await offer('o4', 'P4', 'USD', 9.5);
    await offer('o5', 'P5', 'USD', 20);
    await offer('o6', 'P6', 'SGD', 20);
  });

  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  const read = async (refs) => {
    const { listCatalogOfferPricesForRefs } = require('../../src/auroraBff/productRelationshipGraph');
    const calls = [];
    const out = await listCatalogOfferPricesForRefs(refs, {
      queryFn: async (sql, params) => {
        calls.push(sql);
        return db.query(sql, params);
      },
    });
    expect(calls).toHaveLength(1);
    return out;
  };

  const sorted = (list) => (list || []).slice().sort((a, b) => a.currency.localeCompare(b.currency));

  test('each ref form resolves to its own listing’s live offers', async () => {
    const out = await read([
      'product:sig_a',
      'product:ext_b',
      'pk_c',
      'product:retailer:xyz',
      'product:pg_grp',
      'product:nomatch',
    ]);
    expect(out.get('product:sig_a')).toEqual([{ currency: 'USD', amounts: [11.99, 11.99, 11.99] }]);
    expect(out.get('product:ext_b')).toEqual([{ currency: 'USD', amounts: [20] }]);
    expect(out.get('pk_c')).toEqual([{ currency: 'JPY', amounts: [1650] }]);
    expect(out.get('product:retailer:xyz')).toEqual([{ currency: 'USD', amounts: [9.5] }]);
    expect(sorted(out.get('product:pg_grp'))).toEqual([
      { currency: 'SGD', amounts: [20] },
      { currency: 'USD', amounts: [20] },
    ]);
    expect(out.has('product:nomatch')).toBe(false);
  });

  test('a mixed-case ref reads the same offers, keyed by its lowercased form', async () => {
    const out = await read(['PRODUCT:SIG_A']);
    expect(out.get('product:sig_a')).toEqual([{ currency: 'USD', amounts: [11.99, 11.99, 11.99] }]);
  });

  test('end to end: the group’s same-number USD and SGD offers name no single currency; the sig names USD', async () => {
    const { pairCurrencyFromOfferPrices } = require('../../src/agentSignals/intelligenceReads');
    const out = await read(['product:sig_a', 'product:pg_grp', 'pk_c']);
    expect(pairCurrencyFromOfferPrices(11.99, out.get('product:sig_a'))).toBe('USD');
    expect(pairCurrencyFromOfferPrices(20, out.get('product:pg_grp'))).toBeNull();
    expect(pairCurrencyFromOfferPrices(1650, out.get('pk_c'))).toBe('JPY');
    expect(pairCurrencyFromOfferPrices(11.99, out.get('pk_c'))).toBeNull();
  });
});
