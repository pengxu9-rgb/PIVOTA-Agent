const { Client } = require('pg');
const {
  readCanonicalOwnMoney, projectCanonicalProductMoney, currentOwnMoneyReasonCode, withholdCanonicalProductMoney,
} = require('../../src/services/canonicalPdpOwnMoney');
const { buildPdpPayload } = require('../../src/pdpBuilder');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('current canonical PDP own listing money on real PostgreSQL', () => {
  let client;
  const schema = `pdp_current_money_${process.pid}`;
  const ref = { product_key: 'prod::external_seed::ext_owned', merchant_id: 'merch_obs_owned', product_id: 'ext_owned' };
  const listing = 'https://jurlique.com/products/owned-synthetic';
  const product = { product_id: 'ext_owned', platform: 'external_seed', price: 45,
    variants: [{ variant_id: '111', title: '50 mL', options: [{ name: 'Size', value: '50 mL' }],
      price: 45, currency: 'USD', in_stock: true, source_quality_status: 'captured' }] };
  const read = () => readCanonicalOwnMoney({ ref, query: (sql, args) => client.query(sql, args) });

  beforeAll(async () => {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
        !(parsed.pathname === '/gateway_test' && (parsed.port || '5432') === '5432' ||
          parsed.pathname === '/gateway_money_main_57625_test' && parsed.port === '55447')) throw Error('Explicit owned or CI loopback DB required');
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema};
      CREATE TABLE catalog_products(product_key text PRIMARY KEY, merchant_id text, platform text, source_system text,
        sync_status text, suppression_reason text, brand text, source_domain text, canonical_url text);
      CREATE TABLE catalog_row_trust(subject_type text,subject_key text,serving_decision text);
      CREATE TABLE catalog_skus(sku_key text PRIMARY KEY,product_key text,merchant_id text,currency text,
        source_variant_id text,suppressed_at timestamptz,suppression_reason text);
      CREATE TABLE catalog_merchants(merchant_id text PRIMARY KEY,source_system text,status text,indexable boolean,
        source_ref text,metadata_json jsonb);
      CREATE TABLE catalog_offers(offer_id text PRIMARY KEY,sku_key text,product_key text,merchant_id text,currency text,
        market text,availability text,merchant_effective_price numeric,list_price numeric,source_system text,
        source_domain text,source_ref text,offer_type text,is_first_party boolean,offer_mode text,catalog_track text,
        truth_tier text,readiness_tier text,offer_payload jsonb,suppressed_at timestamptz,suppression_reason text);`);
  });
  afterAll(async () => {
    try { await client?.query('ROLLBACK'); } finally { await client?.end(); }
  });
  beforeEach(async () => {
    await client.query('TRUNCATE catalog_products,catalog_row_trust,catalog_skus,catalog_merchants,catalog_offers');
    await client.query(`INSERT INTO catalog_products VALUES($1,$2,'external_seed','catalog_enrichment_agent_v1',
      'live',NULL,'Jurlique','jurlique.com',$3)`, [ref.product_key, ref.merchant_id, listing]);
    await client.query("INSERT INTO catalog_row_trust VALUES('product',$1,'public')", [ref.product_key]);
    await client.query("INSERT INTO catalog_skus VALUES('owned-sku',$1,$2,'USD','111',NULL,NULL)", [ref.product_key, ref.merchant_id]);
    await client.query(`INSERT INTO catalog_merchants VALUES('agent_seed::jurlique','catalog_enrichment_agent_v1',
      'active',true,'jurlique.com','{"domain":"jurlique.com"}')`);
    await client.query(`INSERT INTO catalog_offers VALUES('own-offer','owned-sku',$1,'agent_seed::jurlique','USD','US',
      'in_stock',49,49,'catalog_enrichment_agent_v1','jurlique.com',$2,'brand_direct',true,'external_referral',
      'external_referral','primary','referral_only',$3,NULL,NULL)`,
    [ref.product_key, listing, { destination_url: listing, canonical_url: listing }]);
  });

  test('native source45 becomes current own49 across canonical and visible numeric selector', async () => {
    const current = projectCanonicalProductMoney(product, await read());
    const payload = buildPdpPayload({ product: current });
    expect(payload.product.price.current).toEqual({ amount: 49, currency: 'USD' });
    expect(payload.product.variants[0]).toMatchObject({ variant_id: '111', source_quality_status: 'captured' });
    expect(payload.modules.find(m => m.type === 'variant_selector').data.variants[0].price.current.amount).toBe(49);
  });
  test.each(['gid://shopify/ProductVariant/111', 'ext_owned:111'])('stored %s preserves exact canonical SKU ownership', async id => {
    await client.query('UPDATE catalog_skus SET source_variant_id=$1', [id]);
    expect(projectCanonicalProductMoney(product, await read()).price.amount).toBe(49);
  });
  test('wrong external namespace never maps by numeric suffix', async () => {
    await client.query("UPDATE catalog_skus SET source_variant_id='ext_foreign:111'");
    expect(() => projectCanonicalProductMoney(product, new Map())).toThrow();
    const money = await read();
    expect(() => projectCanonicalProductMoney(product, money)).toThrow();
  });
  test.each([
    "UPDATE catalog_offers SET merchant_id='agent_seed::foreign'",
    "UPDATE catalog_offers SET source_ref='https://foreign.invalid/wrong'",
    "UPDATE catalog_offers SET market='GB'",
    "UPDATE catalog_offers SET currency='GBP'",
    "UPDATE catalog_offers SET availability='out_of_stock'",
    "UPDATE catalog_offers SET suppression_reason='blocked'",
    "UPDATE catalog_offers SET merchant_effective_price=0,list_price=0",
    "UPDATE catalog_products SET sync_status='pending'",
    "UPDATE catalog_row_trust SET serving_decision='private'",
    "UPDATE catalog_skus SET merchant_id='foreign'",
    "UPDATE catalog_skus SET product_key='foreign'",
    "UPDATE catalog_skus SET suppression_reason='blocked'",
    "UPDATE catalog_merchants SET status='inactive'",
    "UPDATE catalog_merchants SET source_ref='foreign.invalid'",
    "UPDATE catalog_merchants SET source_system='untrusted'",
    "UPDATE catalog_merchants SET metadata_json='{}'",
  ])('unadmitted current listing refuses without source45 substitution: %s', async sql => {
    await client.query(sql);
    await expect(read()).rejects.toMatchObject({ code: 'CURRENT_OWN_OFFER_UNAVAILABLE' });
  });
  test('an out-of-stock own listing is a gap: the page renders it unpriced and not purchasable, never at source45', async () => {
    await client.query("UPDATE catalog_offers SET availability='out_of_stock'");
    const gap = await read().catch(error => error);
    expect(currentOwnMoneyReasonCode(gap)).toBe('CURRENT_OWN_OFFER_UNAVAILABLE');
    const payload = buildPdpPayload({ product: withholdCanonicalProductMoney(product) });
    expect(payload.product).not.toHaveProperty('price');
    expect(payload.product.variants[0]).toMatchObject({ variant_id: '111', current_own_offer_status: 'unavailable',
      availability: { in_stock: false }, source_quality_status: 'captured' });
    expect(payload.product.variants[0]).not.toHaveProperty('price');
    expect(JSON.stringify(payload)).not.toMatch(/"amount":45[,}]/);
  });
  test('only eligible US/USD current offers participate; rejected currency shadow never supplies money', async () => {
    await client.query(`INSERT INTO catalog_offers SELECT (jsonb_populate_record(NULL::catalog_offers,
      to_jsonb(co)||'{"offer_id":"foreign-currency","currency":"GBP","merchant_effective_price":1}'::jsonb)).*
      FROM catalog_offers co`);
    expect(projectCanonicalProductMoney(product, await read()).price.amount).toBe(49);
  });
  // 2026-10-06: Tower 28 and Native listings store their own host as www.<host> while their brand
  // merchant row keeps the bare host. The same store either way; only the merchant-row comparison folds.
  const wwwListing = 'https://www.jurlique.com/products/owned-synthetic';
  async function moveListingToWww() {
    await client.query("UPDATE catalog_products SET source_domain='www.jurlique.com', canonical_url=$1", [wwwListing]);
    await client.query(`UPDATE catalog_offers SET source_domain='www.jurlique.com', source_ref=$1,
      offer_payload=$2`, [wwwListing, { destination_url: wwwListing, canonical_url: wwwListing }]);
  }
  test('a listing stored as www.<host> still matches its bare-host brand merchant row', async () => {
    await moveListingToWww();
    expect(projectCanonicalProductMoney(product, await read()).price.amount).toBe(49);
  });
  test('folding www. never lets a merchant row for another host vouch for the listing', async () => {
    await moveListingToWww();
    await client.query(`UPDATE catalog_merchants SET source_ref='notjurlique.com',
      metadata_json='{"domain":"notjurlique.com"}'`);
    await expect(read()).rejects.toMatchObject({ code: 'CURRENT_OWN_OFFER_UNAVAILABLE' });
  });
  test('two eligible own rows disagreeing49/59 refuse rather than choosing the cheaper value', async () => {
    await client.query(`INSERT INTO catalog_offers SELECT (jsonb_populate_record(NULL::catalog_offers,
      to_jsonb(co)||'{"offer_id":"conflict","merchant_effective_price":59}'::jsonb)).* FROM catalog_offers co`);
    await expect(read()).rejects.toMatchObject({ code: 'CURRENT_OWN_OFFER_UNAVAILABLE' });
  });
});
