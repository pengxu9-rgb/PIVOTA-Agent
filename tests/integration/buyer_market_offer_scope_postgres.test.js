jest.mock('../../src/db', () => ({ query: jest.fn() }));
const { Client } = require('pg');
const db = require('../../src/db');
const axios = require('axios');
const { buildDiscoveryProfile, _internals: i } = require('../../src/services/discoveryFeed');
const scope = require('../../src/services/buyerMarketOfferScope');

// BUYER_MARKET_OFFER_SCOPE on real PostgreSQL: the strict-public canonical reader (history primary),
// the agent_pdp_view brand reader with and without pivota-backend migration 263's market_prices
// column, and the PDP group-member re-pick. Three products of one brand:
//   both  -- a USD offer (US) and its SGD sibling (SG), what shopify_markets writes
//   usd   -- USD only
//   sgd   -- SGD only
// Contract: flag off = today; flag on + a US (or silent) buyer = today, byte for byte; flag on + an
// SG buyer = the SGD offers and SGD prices, and never a USD-only product priced as SGD.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('buyer-market offer scope on owned loopback PostgreSQL', () => {
  let client;
  let originalEnv;
  const schema = `buyer_market_offer_scope_${process.pid}`;
  const sig = (n) => `sig_${String(n).padStart(32, '0')}`;
  const PRODUCTS = [
    { n: 0, key: 'both', currency: 'USD', offers: [['US', 'USD', 45], ['SG', 'SGD', 61]] },
    { n: 1, key: 'usd', currency: 'USD', offers: [['US', 'USD', 30]] },
    { n: 2, key: 'sgd', currency: 'SGD', offers: [['SG', 'SGD', 58]] },
  ];
  const offerJson = (key, [market, currency, price]) => ({ merchant_id: 'merch_obs_local', market, currency, price, availability: 'in_stock', url: `https://exemplar.example.com/products/${key}` });
  const marketPricesOf = (product) => Object.fromEntries(product.offers.map((offer) => {
    const [market, currency, price] = offer;
    return [market, { currency, price_min: price, price_max: price, offer_count: 1, offers: [offerJson(product.key, offer)] }];
  }));
  const historyPayload = (extra = {}) => ({
    surface: 'home_hot_deals', limit: 6,
    context: { auth_state: 'authenticated', locale: 'en-US', recent_queries: [], recent_views: [{ merchant_id: 'external_seed', product_id: sig(0), title: 'Exemplar both', brand: 'Exemplar' }] },
    ...extra,
  });

  // The app sends each statement on its own pooled connection; this suite runs inside one
  // transaction (rolled back at the end), so a statement that fails -- the missing-column case --
  // is fenced by a savepoint instead of aborting the transaction.
  const run = async (sql, params) => {
    await client.query('SAVEPOINT stmt');
    try {
      const result = await client.query(sql, params);
      await client.query('RELEASE SAVEPOINT stmt');
      return result;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT stmt');
      throw err;
    }
  };

  beforeAll(async () => {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw Error('Owned loopback DB required');
    if (!((parsed.pathname === '/gateway_test' && (parsed.port || '5432') === '5432') ||
          (parsed.pathname === '/gateway_money_main_57625_test' && parsed.port === '55447'))) throw Error('Explicit CI or owned database required');
    originalEnv = { ...process.env };
    process.env.DATABASE_URL = url;
    process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';
    process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET = 'US';
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, public;
      CREATE TABLE agent_pdp_view(content_key text PRIMARY KEY,pivota_signature_id text,brand text,title text,description text,image_url text,image_urls jsonb,currency text,price_min numeric,price_max numeric,offer_count int,offers jsonb,category_path text,refreshed_at timestamptz,market_prices jsonb);
      CREATE TABLE catalog_products(product_key text PRIMARY KEY,content_key text,pivota_signature_id text,merchant_id text,platform text,source_product_id text,brand text,canonical_url text,sync_status text,suppression_reason text,updated_at timestamptz,category_path text,source_system text,source_domain text);
      CREATE TABLE catalog_row_trust(subject_type text,subject_key text,serving_decision text);
      CREATE TABLE catalog_offers(offer_id text,product_key text,merchant_id text,market text,currency text,availability text,merchant_effective_price numeric,estimated_best_price numeric,list_price numeric,suppressed_at timestamptz,suppression_reason text,sku_key text,source_system text,source_domain text,source_ref text,offer_type text,is_first_party boolean,offer_mode text,catalog_track text,truth_tier text,readiness_tier text,offer_payload jsonb,updated_at timestamptz);
      CREATE TABLE external_product_seeds(id text,attached_product_key text,destination_url text,status text,updated_at timestamptz);
      CREATE TABLE catalog_merchants(merchant_id text PRIMARY KEY,merchant_name text,source_system text,status text,indexable boolean,source_ref text,metadata_json jsonb);
      CREATE TABLE catalog_skus(sku_key text PRIMARY KEY,product_key text,merchant_id text,suppressed_at timestamptz,suppression_reason text,currency text);`);
    db.query.mockImplementation(run);
    jest.spyOn(axios, 'get').mockImplementation(() => { throw Error('Any HTTP provider call is forbidden'); });
  });

  afterAll(async () => {
    try { await client?.query('ROLLBACK'); } finally { await client?.end(); process.env = originalEnv; jest.restoreAllMocks(); }
  });

  beforeEach(async () => {
    delete process.env[scope.FLAG];
    scope.resetMarketPricesColumnState();
    await run('ALTER TABLE agent_pdp_view ADD COLUMN IF NOT EXISTS market_prices jsonb');
    await run('TRUNCATE agent_pdp_view,catalog_products,catalog_row_trust,external_product_seeds,catalog_offers,catalog_merchants,catalog_skus');
    for (const product of PRODUCTS) {
      const prices = product.offers.filter((offer) => offer[1] === product.currency).map((offer) => offer[2]);
      await run(`INSERT INTO agent_pdp_view VALUES($1,$2,'Exemplar',$3,'A cream.','https://cdn.example.com/x.jpg','[]',$4,$5,$5,$6,$7,'beauty/skincare/moisturizer','2026-10-03T00:00:00Z',$8)`,
        [product.key, sig(product.n), `Exemplar ${product.key}`, product.currency, Math.min(...prices), product.offers.length,
          JSON.stringify(product.offers.map((offer) => offerJson(product.key, offer))), JSON.stringify(marketPricesOf(product))]);
      await run(`INSERT INTO catalog_products(product_key,content_key,pivota_signature_id,merchant_id,platform,source_product_id,brand,canonical_url,sync_status,updated_at,category_path) VALUES($1,$1,$2,'merch_obs_local','external_seed',$3,'Exemplar',$4,'live',NOW(),'beauty/skincare/moisturizer')`,
        [product.key, sig(product.n), `ext_${product.key}`, `https://exemplar.example.com/products/${product.key}`]);
      await run("INSERT INTO catalog_row_trust VALUES('product',$1,'public')", [product.key]);
      await run(`INSERT INTO external_product_seeds VALUES($1,$2,$3,'active',NOW())`, [`seed_${product.key}`, product.key, `https://exemplar.example.com/products/${product.key}`]);
      for (const [index, [market, currency, price]] of product.offers.entries()) {
        await run(`INSERT INTO catalog_skus(sku_key,product_key,merchant_id) VALUES($1,$2,'merch_obs_local') ON CONFLICT DO NOTHING`, [`sku_${product.key}`, product.key]);
        await run(`INSERT INTO catalog_offers(offer_id,product_key,sku_key,merchant_id,market,currency,availability,merchant_effective_price,updated_at) VALUES($1,$2,$3,'merch_obs_local',$4,$5,'in_stock',$6,NOW() + ($7 || ' minutes')::interval)`,
          [`offer_${product.key}_${index}`, product.key, `sku_${product.key}`, market, currency, price, String(index)]);
      }
    }
    db.query.mockClear();
  });

  const loadHistory = (payload) => {
    const request = i.normalizeDiscoveryRequest(payload);
    return i.loadCanonicalHistoryPrimary({ request, profile: buildDiscoveryProfile(request.context), limit: 48 });
  };
  const priced = (products) => products.map((p) => [p.title, p.currency, p.price, (p.offers || []).map((o) => o.currency)]).sort();
  const sqlSent = () => db.query.mock.calls.map(([sql]) => String(sql));

  describe('strict-public canonical reader (history primary)', () => {
    test('flag off: an SG buyer is served exactly what a silent buyer is (today)', async () => {
      const silent = await loadHistory(historyPayload());
      const silentSql = sqlSent();
      db.query.mockClear();
      const sg = await loadHistory(historyPayload({ buyer_market: 'SG' }));
      expect(priced(sg.products)).toEqual(priced(silent.products));
      expect(sqlSent()).toEqual(silentSql);
      expect(priced(silent.products)).toEqual([
        ['Exemplar both', 'USD', 45, ['USD']],
        ['Exemplar usd', 'USD', 30, ['USD']],
      ]);
    });

    test('flag on: US and silent buyers are byte-identical to flag off', async () => {
      const baseline = await loadHistory(historyPayload());
      const baselineSql = sqlSent();
      process.env[scope.FLAG] = 'on';
      for (const extra of [{}, { buyer_market: 'US' }]) {
        db.query.mockClear();
        const flagged = await loadHistory(historyPayload(extra));
        expect(flagged.products).toEqual(baseline.products);
        expect(sqlSent()).toEqual(baselineSql);
      }
    });

    test('flag on: an SG buyer gets the SGD own offers and prices, and no USD-only product', async () => {
      process.env[scope.FLAG] = 'on';
      const sg = await loadHistory(historyPayload({ buyer_market: 'SG' }));
      expect(sg.recallSummary[0].status).toBe(200);
      expect(priced(sg.products)).toEqual([
        ['Exemplar both', 'SGD', 61, ['SGD']],
        ['Exemplar sgd', 'SGD', 58, ['SGD']],
      ]);
      expect(sqlSent().some((sql) => sql.includes("co.market = 'SG' AND co.currency = 'SGD'"))).toBe(true);
      expect(axios.get).not.toHaveBeenCalled();
    });

    test('flag on: an SG buyer whose viewed product has no SGD offer gets the same cut-off a US buyer gets for no USD offer', async () => {
      process.env[scope.FLAG] = 'on';
      const viewUsd = historyPayload({ buyer_market: 'SG' });
      viewUsd.context.recent_views[0] = { ...viewUsd.context.recent_views[0], product_id: sig(1), title: 'Exemplar usd' };
      const sg = await loadHistory(viewUsd);
      expect(sg.products).toEqual([]);
      expect(sg.recallSummary[0].eligibility_reason).toBe('canonical_history_item_unavailable');
      process.env[scope.FLAG] = '';
      const viewSgd = historyPayload();
      viewSgd.context.recent_views[0] = { ...viewSgd.context.recent_views[0], product_id: sig(2), title: 'Exemplar sgd' };
      expect((await loadHistory(viewSgd)).recallSummary[0].eligibility_reason).toBe('canonical_history_item_unavailable');
    });
  });

  describe('agent_pdp_view brand reader (market_prices)', () => {
    const fetchBrand = (marketScope) => i.fetchBrandScopedCanonicalCandidates({ brandAliases: ['Exemplar'], limit: 24, marketScope });
    const SG = { market: 'SG', currency: 'SGD' };

    test('no scope: the legacy columns, and the column is never named', async () => {
      const products = await fetchBrand(null);
      expect(priced(products)).toEqual([
        ['Exemplar both', 'USD', 45, ['USD', 'SGD']],
        ['Exemplar sgd', 'SGD', 58, ['SGD']],
        ['Exemplar usd', 'USD', 30, ['USD']],
      ]);
      expect(sqlSent().some((sql) => sql.includes('market_prices'))).toBe(false);
    });

    test('SG scope: the SG summary prices the mixed product; a USD-only one keeps its USD row for the door to drop', async () => {
      const products = await fetchBrand(SG);
      expect(priced(products)).toEqual([
        ['Exemplar both', 'SGD', 61, ['SGD']],
        ['Exemplar sgd', 'SGD', 58, ['SGD']],
        ['Exemplar usd', 'USD', 30, ['USD']],
      ]);
      // Same page, same order as the unscoped reader: only prices and offers move.
      expect(products.map((p) => p.product_id)).toEqual((await fetchBrand(null)).map((p) => p.product_id));
    });

    test('a NULL summary (not backfilled) serves the legacy row', async () => {
      await run('UPDATE agent_pdp_view SET market_prices = NULL');
      expect(priced(await fetchBrand(SG))).toEqual(priced(await fetchBrand(null)));
    });

    test('the column absent (migration 263 not applied): legacy rows, one failed statement, then never named again', async () => {
      const legacy = await fetchBrand(null);
      await run('ALTER TABLE agent_pdp_view DROP COLUMN market_prices');
      db.query.mockClear();
      expect(priced(await fetchBrand(SG))).toEqual(priced(legacy));
      expect(sqlSent().filter((sql) => sql.includes('apv.market_prices'))).toHaveLength(1);
      expect(scope.isMarketPricesColumnKnownMissing()).toBe(true);
      db.query.mockClear();
      expect(priced(await fetchBrand(SG))).toEqual(priced(legacy));
      expect(sqlSent().some((sql) => sql.includes('market_prices'))).toBe(false);
    });
  });

  describe('PDP group member re-pick', () => {
    const { _debug } = require('../../src/server');
    const member = (key, currency, price) => ({
      merchant_id: 'merch_obs_local', product_id: `ext_${key}`,
      source_payload: { price: { amount: price, currency }, price_amount: price, currency, catalog_offer_v1: { offer_id: `offer_${key}_0`, sku_key: `sku_${key}` } },
    });

    test('flag off, or the member already in the buyer currency: untouched, no statement', async () => {
      const members = [member('both', 'USD', 45), member('usd', 'USD', 30)];
      const queryFn = jest.fn(run);
      expect(await _debug.rescopeGroupMemberOffersToCurrency(members, 'SGD', { queryFn })).toBe(members);
      process.env[scope.FLAG] = 'on';
      expect(await _debug.rescopeGroupMemberOffersToCurrency(members, 'USD', { queryFn })).toBe(members);
      expect(queryFn).not.toHaveBeenCalled();
      // ...and the same members for an SG buyer do send the one batched read.
      await _debug.rescopeGroupMemberOffersToCurrency(members, 'SGD', { queryFn });
      expect(queryFn).toHaveBeenCalledTimes(1);
    });

    test('flag on, SG buyer: the member\'s own SGD offer replaces its USD pick; a member with none keeps its pick', async () => {
      process.env[scope.FLAG] = 'on';
      const out = await _debug.rescopeGroupMemberOffersToCurrency([member('both', 'USD', 45), member('usd', 'USD', 30)], 'SGD', { queryFn: run });
      expect(out[0].source_payload).toMatchObject({ currency: 'SGD', price_amount: 61, price: { amount: 61, currency: 'SGD' }, catalog_offer_v1: { offer_id: 'offer_both_1', sku_key: 'sku_both' } });
      expect(out[1].source_payload.currency).toBe('USD');
    });

    test('flag on, US buyer: a member whose LATERAL pick was the newer SGD sibling gets its USD offer back', async () => {
      process.env[scope.FLAG] = 'on';
      const [out] = await _debug.rescopeGroupMemberOffersToCurrency([member('both', 'SGD', 61)], 'USD', { queryFn: run });
      expect(out.source_payload).toMatchObject({ currency: 'USD', price_amount: 45, catalog_offer_v1: { offer_id: 'offer_both_0' } });
    });
  });
});
