jest.mock('../../src/db', () => ({
  query: jest.fn()
}));
const {
  Client
} = require('pg');
const db = require('../../src/db');
const axios = require('axios');
const {
  getDiscoveryFeed,
  buildDiscoveryProfile,
  _internals: i
} = require('../../src/services/discoveryFeed');
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('canonical explicit exact brand on explicitly selected owned loopback PostgreSQL', () => {
  let client, originalEnv;
  const schema = `discovery_brand_query_${process.pid}`;
  const sig = 'sig_3d1b5a5627cbb101f388e5a90c80b4e5';
  const payload = {
    surface: 'browse_products',
    response_detail: 'card',
    page: 1,
    limit: 24,
    sort: 'popular',
    query: {
      text: 'Judydoll'
    },
    context: {
      auth_state: 'anonymous',
      locale: 'en-US',
      recent_views: [],
      recent_queries: []
    }
  };
  beforeAll(async () => {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw Error('Owned loopback DB required');
    if (!(parsed.pathname === '/gateway_test' && (parsed.port || '5432') === '5432' || parsed.pathname === '/gateway_money_main_57625_test' && parsed.port === '55447')) throw Error('Explicit CI or owned database required');
    originalEnv = {
      ...process.env
    };
    process.env.DATABASE_URL = url;
    process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';
    process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET = 'US';
    client = new Client({
      connectionString: url
    });
    await client.connect();
    await client.query(`BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, public;
      CREATE TABLE agent_pdp_view(content_key text PRIMARY KEY,pivota_signature_id text,brand text,title text,description text,image_url text,image_urls jsonb,currency text,price_min numeric,price_max numeric,offer_count int,offers jsonb,category_path text,refreshed_at timestamptz);
      CREATE TABLE catalog_products(product_key text PRIMARY KEY,content_key text,pivota_signature_id text,merchant_id text,platform text,source_product_id text,brand text,canonical_url text,sync_status text,suppression_reason text,updated_at timestamptz);
      CREATE UNIQUE INDEX own_cp_signature_unique ON catalog_products(pivota_signature_id) WHERE pivota_signature_id IS NOT NULL;
      CREATE TABLE catalog_row_trust(subject_type text,subject_key text,serving_decision text);
      CREATE TABLE catalog_offers(offer_id text,product_key text,merchant_id text,market text,currency text,availability text,merchant_effective_price numeric,list_price numeric,suppressed_at timestamptz,suppression_reason text);
      CREATE TABLE external_product_seeds(id text,attached_product_key text,destination_url text,status text,updated_at timestamptz);
      ALTER TABLE catalog_products ADD COLUMN source_system text, ADD COLUMN source_domain text;
      ALTER TABLE catalog_offers ADD COLUMN sku_key text, ADD COLUMN source_system text, ADD COLUMN source_domain text, ADD COLUMN source_ref text, ADD COLUMN offer_type text, ADD COLUMN is_first_party boolean, ADD COLUMN offer_mode text, ADD COLUMN catalog_track text, ADD COLUMN truth_tier text, ADD COLUMN readiness_tier text, ADD COLUMN offer_payload jsonb;
      CREATE TABLE catalog_merchants(merchant_id text PRIMARY KEY,merchant_name text,source_system text,status text,indexable boolean,source_ref text,metadata_json jsonb);
      CREATE TABLE catalog_skus(sku_key text PRIMARY KEY,product_key text,merchant_id text,suppressed_at timestamptz,suppression_reason text,currency text);`);
    db.query.mockImplementation((sql, params) => client.query(sql, params));
    jest.spyOn(axios, 'get').mockImplementation(() => {
      throw Error('Any HTTP provider call is forbidden');
    });
  });
  afterAll(async () => {
    try {
      await client?.query('ROLLBACK');
    } finally {
      await client?.end();
      process.env = originalEnv;
      jest.restoreAllMocks();
    }
  });
  beforeEach(async () => {
    await client.query('TRUNCATE agent_pdp_view,catalog_products,catalog_row_trust,external_product_seeds,catalog_offers,catalog_merchants,catalog_skus');
    db.query.mockClear();
    for (let n = 0; n < 3; n++) {
      const id = n ? 'sig_' + String(n).padStart(32, '0') : sig,
        key = `local_${n}`;
      await client.query(`INSERT INTO agent_pdp_view VALUES($1,$2,'Judydoll',$3,'Makeup color','https://synthetic.invalid/image.png','[]','USD',45,45,1,$4,'beauty/makeup','2026-10-03T00:00:00Z')`, [key, id, ['Dual-Ended Contour Stick', 'Silky Matte Lip Ink', 'Sheer Tinted Highlighter'][n], JSON.stringify([{
        market: 'US',
        currency: 'USD',
        price: 45,
        availability: 'in_stock'
      }])]);
      await client.query(`INSERT INTO catalog_products(product_key,content_key,pivota_signature_id,merchant_id,platform,source_product_id,brand,canonical_url,sync_status,suppression_reason,updated_at) VALUES($1,$1,$2,'merch_obs_local','external_seed',$3,'Judydoll','https://judydoll.com/products/local-synthetic/' || $3,'live',NULL,NOW())`, [key, id, 'ext_local_' + n]);
      await client.query("INSERT INTO catalog_row_trust VALUES('product',$1,'public')", [key]);
      await client.query("INSERT INTO catalog_offers(offer_id,product_key,merchant_id,market,currency,availability,merchant_effective_price,list_price,suppressed_at,suppression_reason) VALUES($1,$2,'merch_obs_local','US','USD','in_stock',45,NULL,NULL,NULL)", ['offer_' + n, key]);
      await client.query(`INSERT INTO external_product_seeds VALUES($1,$2,'https://judydoll.com/products/local-synthetic/' || $1,'active',NOW())`, ['synthetic_seed_' + n, key]);
    }
  });
  async function load(text = 'Judydoll') {
    const request = i.normalizeDiscoveryRequest({
      ...payload,
      query: {
        text
      }
    });
    return i.loadCanonicalBrandQueryPrimary({
      request,
      profile: buildDiscoveryProfile(request.context)
    });
  }
  test('real public canonical exactbrand returns own USD offer; cold query has zero SDK', async () => {
    const r = await load();
    expect(r.products).toHaveLength(3);
    expect(r.products.every(p => p.price === 45 && p.currency === 'USD')).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
  });
  test.each(['judydoll', '  JUDYDOLL  '])('case and outer-space exactbrand actualSQL %s', async text => {
    expect((await load(text)).products).toHaveLength(3);
  });
  test.each(['notJudydoll', 'Judydoll lipstick', 'Judydoll%', 'Judydoll / Jurlique', 'unknown brand'])('unknown/free-text SQL cannot borrow brand match %s', async text => {
    expect(await load(text)).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });
  test('own public source identity cannot borrow another coidentified brand', async () => {
    await client.query("INSERT INTO catalog_products(product_key,content_key,pivota_signature_id,merchant_id,platform,source_product_id,brand,canonical_url,sync_status,suppression_reason,updated_at) VALUES('foreign-public','local_0',$1,'foreign-public','shopify','foreign-source','ForeignBrand',NULL,'live',NULL,NOW()+INTERVAL '1 day')", ['sig_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee']);
    await client.query("INSERT INTO catalog_row_trust VALUES('product','foreign-public','public');INSERT INTO catalog_offers(offer_id,product_key,merchant_id,market,currency,availability,merchant_effective_price,list_price,suppressed_at,suppression_reason) VALUES('foreign-offer','foreign-public','foreign-public','US','USD','in_stock',1,NULL,NULL,NULL)");
    const r = await load();
    expect(r.products).toHaveLength(3);
    expect(r.products.every(p => p.merchant_id === 'external_seed')).toBe(true);
    expect(r.products.find(p => p.product_id === sig).price).toBe(45);
  });
  test('private/nonlive/suppressed source cannot admit exact brand', async () => {
    await client.query("UPDATE catalog_row_trust SET serving_decision='private'");
    expect(await load()).toBeNull();
  });
  test.each(["UPDATE catalog_offers SET merchant_id='foreign'", "UPDATE catalog_offers SET market='GB'", "UPDATE catalog_offers SET currency='GBP'", "UPDATE catalog_offers SET availability='out_of_stock'", "UPDATE catalog_offers SET suppressed_at=NOW()"])('knownbrand with no valid own offers remains selected empty, not SDK: %s', async sql => {
    await client.query(sql);
    const r = await load();
    expect(r.products).toEqual([]);
    expect(r.recallSummary[0].status).toBe(200);
    expect(axios.get).not.toHaveBeenCalled();
  });
  test('cold published HTTP request selects same realSQL source and does not call REST SDK', async () => {
    db.query.mockImplementation((sql, params) => sql.includes('canonical_exact_brand_admission') || sql.includes('WITH brand_match') ? client.query(sql, params) : Promise.resolve({
      rows: []
    }));
    const app = require('../../src/server');
    const request = require('supertest');
    const response = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'get_discovery_feed',
      payload,
      metadata: {
        entry: 'plp',
        scope: {
          catalog: 'global',
          region: 'US',
          language: 'en-US'
        },
        ui_source: 'shopping-agent-ui',
        source: 'shopping_agent',
        market: 'US'
      }
    }).expect(200);
    expect(response.body.products).toHaveLength(3);
    expect(response.body.metadata.primary_path_used).toBe('canonical_sig_explicit_brand');
    expect(response.body.metadata.fallback_triggered).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });
});
