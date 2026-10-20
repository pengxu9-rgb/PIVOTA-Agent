// CRAWL_FRESH round 4 on real PostgreSQL: the row's price-read date, executed.
//
// The pinned-string tests (tests/catalog_trust_crawl_fresh.node.test.cjs) prove
// this repo emits the backend's statement; this file proves what that statement
// DECIDES, through the upserter's own crawlFreshByKey (probe, savepoint, binds,
// age test) on a client inside a transaction:
//   * the CLASS is every live offer (unsuppressed, priced) -- any link (round 5:
//     canonicalPdpOwnMoney serves an offer's price whatever its destination),
//     any source, market, currency or affiliate status;
//   * ONE class offer without a valid read (not the drain's, not a served
//     market+currency pair, affiliate, future-dated, undeclared, employee edit)
//     makes the row not fresh;
//   * an offer outside the class (suppressed, unpriced) neither dates nor
//     blocks the row.
// Twin of pivota-backend tests/test_crawl_fresh_trust_postgres.py (round 4).

const { Client } = require('pg');
const upserter = require('../../src/services/catalogRowTrustUpserter');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('CRAWL_FRESH row price-read date on real PostgreSQL', () => {
  let client;
  const schema = `crawl_fresh_${process.pid}`;
  const PK = 'ext:retailer:0123456789abcdef0123456789abcdef';
  const NOW = new Date('2026-10-20T12:00:00Z');
  const DAY = 24 * 60 * 60 * 1000;
  const row = { product_key: PK, source_system: 'catalog_enrichment_agent_v1' };
  const saved = {};

  beforeAll(async () => {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !/_test$/.test(parsed.pathname)) {
      throw Error('a loopback *_test database is required');
    }
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema};
      CREATE TABLE catalog_offers(offer_id text PRIMARY KEY, sku_key text, product_key text, source_system text,
        market text NOT NULL DEFAULT 'US', currency text, availability text,
        merchant_effective_price numeric, estimated_best_price numeric, list_price numeric, source_ref text, offer_payload jsonb,
        suppressed_at timestamptz, price_checked_at timestamptz);`);
    for (const k of ['CATALOG_TRUST_CRAWL_FRESH_ENABLED', 'CATALOG_TRUST_CRAWL_FRESH_DAYS']) saved[k] = process.env[k];
    process.env.CATALOG_TRUST_CRAWL_FRESH_ENABLED = '1';
    process.env.CATALOG_TRUST_CRAWL_FRESH_DAYS = '7';
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { await client?.query('ROLLBACK'); } finally { await client?.end(); }
  });
  beforeEach(async () => {
    await client.query('TRUNCATE catalog_offers');
  });

  let seq = 0;
  // A valid drain read: US/USD, declared US, read a day ago, in stock, https link.
  async function offer(overrides = {}) {
    const o = {
      offer_id: `o${(seq += 1)}`,
      sku_key: `${PK}::v${seq}`,
      product_key: PK,
      source_system: 'catalog_enrichment_agent_v1',
      market: 'US',
      currency: 'USD',
      availability: 'in_stock',
      merchant_effective_price: null,
      estimated_best_price: null,
      list_price: 20,
      source_ref: 'https://shop.example.com/products/serum',
      offer_payload: { destination_url: 'https://shop.example.com/products/serum', declared_market: 'US' },
      suppressed_at: null,
      price_checked_at: new Date(NOW.getTime() - DAY),
      ...overrides,
    };
    await client.query(
      `INSERT INTO catalog_offers(offer_id, sku_key, product_key, source_system, market, currency, availability,
         merchant_effective_price, estimated_best_price, list_price, source_ref, offer_payload, suppressed_at,
         price_checked_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [o.offer_id, o.sku_key, o.product_key, o.source_system, o.market, o.currency, o.availability,
        o.merchant_effective_price, o.estimated_best_price, o.list_price, o.source_ref, o.offer_payload,
        o.suppressed_at, o.price_checked_at],
    );
  }
  const fresh = async () => {
    const out = await upserter.crawlFreshByKey(client, [row], NOW);
    expect(out).not.toBeNull();
    return out[PK];
  };

  test('one valid drain read in a served pair is fresh', async () => {
    await offer();
    expect(await fresh()).toBe(true);
  });

  test('SG/SGD declared SG is a valid read too', async () => {
    await offer({ market: 'SG', currency: 'SGD', offer_payload: { declared_market: 'SG' } });
    expect(await fresh()).toBe(true);
  });

  test('no live offer at all is not fresh', async () => {
    expect(await fresh()).toBe(false);
  });

  // ---- one never-valid LIVE offer beside a valid one: the row is not fresh ----
  const NEVER_VALID = [
    ['an (AU, AUD) offer', { market: 'AU', currency: 'AUD', offer_payload: { declared_market: 'AU' } }],
    ['a (US, SGD) offer', { market: 'US', currency: 'SGD' }],
    ['an (SG, USD) offer', { market: 'SG', currency: 'USD', offer_payload: { declared_market: 'SG' } }],
    ['a shopify_markets_* offer', { source_system: 'shopify_markets_v1' }],
    ['a variant_identity_backfill_v1 offer', { source_system: 'variant_identity_backfill_v1' }],
    ['an affiliate-feed offer', {
      offer_payload: { declared_market: 'US', validated_at: 'affiliate_feed:network' },
    }],
    ['a future-dated offer', { price_checked_at: new Date(NOW.getTime() + 60 * 1000) }],
    ['an undeclared offer', { offer_payload: { destination_url: 'https://shop.example.com/p' } }],
    ['an employee-edited offer', { offer_payload: { declared_market: 'US', price_read_source: 'employee_edit' } }],
    ['an unread offer', { price_checked_at: null }],
    ['a stale out-of-stock offer', { availability: 'sold_out', price_checked_at: new Date(NOW.getTime() - 30 * DAY) }],
  ];
  for (const [name, overrides] of NEVER_VALID) {
    test(`${name} beside a valid read makes the row not fresh`, async () => {
      await offer();
      await offer(overrides);
      expect(await fresh()).toBe(false);
    });
  }

  // ---- outside the class: neither dates nor blocks ----
  const OUTSIDE = [
    ['a suppressed offer', { suppressed_at: new Date(NOW.getTime() - DAY) }],
    ['an unpriced offer', { list_price: null, merchant_effective_price: null }],
    ['a zero-priced offer', { list_price: 0 }],
  ];
  for (const [name, overrides] of OUTSIDE) {
    test(`${name} (otherwise never valid) stays outside the class`, async () => {
      await offer();
      // never valid if it WERE in the class: an AU offer
      await offer({ market: 'AU', currency: 'AUD', ...overrides });
      expect(await fresh()).toBe(true);
    });
  }

  // ---- round 6: an estimated_best_price-only offer is priced for the class ----
  for (const [name, prices] of [
    ['ebp only, list NULL', { merchant_effective_price: null, list_price: null, estimated_best_price: 18 }],
    ['ebp only, list 0', { merchant_effective_price: null, list_price: 0, estimated_best_price: 18 }],
  ]) {
    test(`${name}: without a valid read it BLOCKS the row`, async () => {
      await offer();
      await offer({ market: 'AU', currency: 'AUD', offer_payload: { declared_market: 'AU' }, ...prices });
      expect(await fresh()).toBe(false);
    });
    test(`${name}: with a valid read it dates the row`, async () => {
      await offer({ ...prices });
      expect(await fresh()).toBe(true);
    });
  }

  test('an offer with no price at all (mep, ebp and list all NULL or 0) stays outside the class', async () => {
    await offer();
    await offer({ market: 'AU', currency: 'AUD', merchant_effective_price: 0, estimated_best_price: null, list_price: 0 });
    expect(await fresh()).toBe(true);
  });

  // ---- round 5: the link does not decide class membership ----
  const ANY_LINK = [
    ['an ftp link', { source_ref: 'ftp://shop.example.com/x', destination_url: 'ftp://shop.example.com/x' }],
    ['a bare-path link', { source_ref: '/products/serum', destination_url: '/products/serum' }],
    ['an empty destination_url over an https source_ref', {
      source_ref: 'https://shop.example.com/products/serum', destination_url: '',
    }],
    ['a link containing a space', {
      source_ref: 'https://shop.example.com/products/a b', destination_url: '  https://shop.example.com/products/a b  ',
    }],
    ['no link at all', { source_ref: null, destination_url: null }],
  ];
  for (const [name, { source_ref, destination_url }] of ANY_LINK) {
    const payload = (declared) => (destination_url === null
      ? { declared_market: declared }
      : { destination_url, declared_market: declared });
    test(`${name}: an offer without a valid read BLOCKS the row`, async () => {
      await offer();
      await offer({ market: 'AU', currency: 'AUD', source_ref, offer_payload: payload('AU') });
      expect(await fresh()).toBe(false);
    });
    test(`${name}: an offer WITH a valid read dates the row`, async () => {
      await offer({ source_ref, offer_payload: payload('US') });
      expect(await fresh()).toBe(true);
    });
  }

  test('the date is the OLDEST valid read: one stale valid offer makes the row stale', async () => {
    await offer();
    await offer({ price_checked_at: new Date(NOW.getTime() - 8 * DAY) });
    expect(await fresh()).toBe(false);
  });

  test('every class offer out of stock is not fresh; one in stock is enough', async () => {
    await offer({ availability: 'out_of_stock' });
    expect(await fresh()).toBe(false);
    await offer({ availability: 'in_stock' });
    expect(await fresh()).toBe(true);
  });

  test('the caller transaction survives the reads', async () => {
    await offer();
    await upserter.crawlFreshByKey(client, [row], NOW);
    const r = await client.query('SELECT count(*)::int AS n FROM catalog_offers');
    expect(r.rows[0].n).toBe(1);
  });
});
