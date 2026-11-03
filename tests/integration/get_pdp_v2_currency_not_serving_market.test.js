const request = require('supertest');
const { CANONICAL_ENTITY_GROUP_SQL_TAG } = require('../../src/services/catalogEntityResolutionSqlTag');

jest.setTimeout(60000);

// get_pdp_v2 never serves a price in another currency than the buyer's (src/services/servingCurrencyGuard.js
// offMarketCurrencies; src/server.js after the own-money projection). The own-money gate covers only minted
// enrichment listings and serves only US/USD; a mirror seed (and the identity-graph group page) carries the
// listing's own currency, so an SG store's SGD price reached a US page as is. The page still renders: only the
// off-market money is withheld (metadata.serving_currency_guard names it), never converted.


jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn() })),
}));

const ORIGINAL_ENV = process.env;
const SEED_ID = 'ext_curguard_probe_1';
const OBS_MERCHANT = 'merch_obs_curguard01';
const SIG_ID = 'sig_curguard0000000000000000000001';
const CONTENT_KEY = 'ck_curguard00000000000000000000001';

function loadServer() {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    PIVOTA_API_BASE: 'http://127.0.0.1:9',
    PIVOTA_API_KEY: 'test-token',
    PDP_IDENTITY_GRAPH_ENABLED: 'true',
  };
  const db = require('../../src/db');
  db.query.mockReset();
  const app = require('../../src/server');
  return { app, db };
}

const norm = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();
const isCanonicalGroupQuery = (sql) => norm(sql).includes(CANONICAL_ENTITY_GROUP_SQL_TAG) && norm(sql).includes('FROM catalog_products cp');
const isBareSigQuery = (sql) => norm(sql).includes('SELECT merchant_id, platform, source_product_id, product_key FROM catalog_products WHERE pivota_signature_id = $1');
const isExactSigQuery = (sql) => norm(sql).includes('cp.pivota_signature_id = $1');
const isSeedDetailQuery = (sql) => String(sql || '').includes('FROM external_product_seeds') && String(sql || '').includes('destination_url');

function seedRow(currency, amount) {
  return {
    id: 'eps_curguard_1',
    external_product_id: SEED_ID,
    status: 'active',
    market: 'US',
    canonical_url: 'https://store.example.test/products/serum',
    destination_url: 'https://store.example.test/products/serum',
    domain: 'store.example.test',
    title: 'Probe Serum',
    image_url: 'https://cdn.example.test/serum.png',
    price_amount: String(amount),
    price_currency: currency,
    availability: 'In Stock',
    seed_data: { brand: 'Probe Labs', description: 'a serum' },
  };
}

function exactSigRow() {
  return {
    merchant_id: OBS_MERCHANT,
    platform: 'external_seed',
    source_product_id: SEED_ID,
    product_key: `prod::${OBS_MERCHANT}::external_seed::${SEED_ID}`,
    source_system: 'external_product_seeds_mirror_v1',
    pivota_signature_id: SIG_ID,
    content_key: CONTENT_KEY,
    catalog_title: 'Probe Serum',
    catalog_brand: 'Probe Labs',
    signature_serving_eligible: true,
    external_seed_id: 'eps_curguard_1',
    external_seed_external_product_id: SEED_ID,
    external_seed_status: 'active',
    external_seed_route_lane: 0,
  };
}

function install(db, seed) {
  db.query.mockImplementation(async (sql) => {
    if (isCanonicalGroupQuery(sql) || isBareSigQuery(sql)) return { rows: [] };
    if (isExactSigQuery(sql)) return { rows: [exactSigRow()] };
    if (isSeedDetailQuery(sql)) return { rows: [seed] };
    return { rows: [] };
  });
}

async function pdp(app, { market, include = ['product_overview'] } = {}) {
  return request(app)
    .post('/agent/shop/v1/invoke')
    .send({ operation: 'get_pdp_v2', payload: { product_ref: { product_id: SIG_ID }, include }, ...(market ? { metadata: { market } } : {}) });
}

const canonical = (res) => res.body?.modules?.find((m) => m.type === 'canonical')?.data?.pdp_payload || {};
const guardOf = (res) => res.body?.metadata?.serving_currency_guard;

// A fresh server per request: the PDP keeps per-process product caches, and a second request for the same
// sig would be answered from the first one's.
async function servedPage(currency, market) {
  const { app, db } = loadServer();
  install(db, seedRow(currency, 16));
  return pdp(app, { market });
}

describe('get_pdp_v2: money in another currency than the buyer market is withheld, never served', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test('an SGD mirror seed on a page with no market (US, USD): rendered, its SGD money withheld and named', async () => {
    const res = await servedPage('SGD');
    expect(res.status).toBe(200);
    const payload = canonical(res);
    expect(payload.product?.title).toBe('Probe Serum');
    expect(payload.product?.price).toBeUndefined();
    for (const v of payload.product?.variants || []) expect(v.price).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(/"SGD"/);
    expect(guardOf(res)).toEqual({ withheld_currencies: ['SGD'] });
    expect((payload.actions || []).map((a) => a.action_type)).not.toContain('add_to_cart');
    // Not an own-money gap: that path is for minted listings and says something else.
    expect(res.body?.metadata?.current_own_offer_reason_code).toBeUndefined();
  });

  test('the same seed for an SG buyer (market SG, SGD): priced in SGD, nothing withheld', async () => {
    const res = await servedPage('SGD', 'SG');
    expect(res.status).toBe(200);
    expect(canonical(res).product?.price?.current).toEqual({ amount: 16, currency: 'SGD' });
    expect(guardOf(res)).toBeUndefined();
  });

  test('CONTROL: a USD seed with no market keeps its USD price', async () => {
    const res = await servedPage('USD');
    expect(canonical(res).product?.price?.current).toEqual({ amount: 16, currency: 'USD' });
    expect(guardOf(res)).toBeUndefined();
  });

  test('a USD seed for an SG buyer is withheld: the rule is the buyer currency, not USD', async () => {
    const res = await servedPage('USD', 'SG');
    expect(res.status).toBe(200);
    expect(canonical(res).product?.price).toBeUndefined();
    expect(guardOf(res)).toEqual({ withheld_currencies: ['USD'] });
  });

  test('a JPY seed (an acquisition market) on a US page is withheld', async () => {
    const res = await servedPage('JPY');
    expect(canonical(res).product?.price).toBeUndefined();
    expect(guardOf(res)).toEqual({ withheld_currencies: ['JPY'] });
  });

  test('an unkeyable market (several markets) judges nothing: the page is as before', async () => {
    const res = await servedPage('SGD', 'US,SG');
    expect(res.status).toBe(200);
    expect(guardOf(res)).toBeUndefined();
  });
});

// get_product (MCP) reaches get_pdp_v2 through the unscoped detail hop (server.js get_product_detail), which now
// forwards the agent's market as payload.market (src/services/pdpDetailHop.js, unit-tested). get_pdp_v2 reads it.
describe('get_pdp_v2 reads the market the get_product hop forwards (payload.market)', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  async function hopShaped(market) {
    const { app, db } = loadServer();
    install(db, seedRow('SGD', 16));
    const { unscopedDetailPdpRequest } = require('../../src/services/pdpDetailHop');
    return request(app).post('/agent/shop/v1/invoke').send(unscopedDetailPdpRequest(SIG_ID, market ? { market } : {}));
  }

  test('market SG: the SGD price is served', async () => {
    const res = await hopShaped('SG');
    expect(res.status).toBe(200);
    expect(canonical(res).product?.price?.current).toEqual({ amount: 16, currency: 'SGD' });
  });

  test('no market: the SGD price is withheld', async () => {
    const res = await hopShaped(null);
    expect(res.status).toBe(200);
    expect(canonical(res).product?.price).toBeUndefined();
    expect(guardOf(res)).toEqual({ withheld_currencies: ['SGD'] });
  });
});
