const { Client } = require('pg');
const request = require('supertest');
const nock = require('nock');

// The creator human-apparel lane's seed statements (queryCreatorHumanApparelExternalSeedRows),
// on real PostgreSQL through the real invoke route. Peng 2026-09-26: a seed with no currency is never
// served -- buildExternalSeedProduct stamps 'USD' on it, so after recall it reads as a US price and
// the invoke door's servingCurrencyGuard cannot tell. Only the seed SQL can refuse it. And the guard
// itself keeps an SGD seed off a US buyer's page, which this lane never scoped by currency.

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('creator apparel lane seed currency, real PostgreSQL', () => {
  let db;
  let schema;
  let priorEnv;
  let seedCalls;

  const seedRow = async (id, currency) => {
    const title = `Black Linen Button Shirt ${id}`;
    await db.query(
      `INSERT INTO external_product_seeds(id, external_product_id, market, tool, destination_url, canonical_url, domain,
         title, image_url, price_amount, price_currency, availability, seed_data, updated_at, created_at, status, attached_product_key)
       VALUES ($1, $1, 'US', 'creator_agents', $2, $2, 'brand.example', $3, $4, 18, $5, 'in stock', $6, now(), now(), 'active', NULL)`,
      [id, `https://brand.example/products/${id}`, title, `https://cdn.example.com/${id}.jpg`, currency,
        JSON.stringify({
          brand: 'Test Apparel',
          category: 'Shirts',
          product_type: 'Shirt',
          vertical: 'human_apparel',
          description: 'A black linen button shirt.',
        })],
    );
  };

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `apparel_seed_currency_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`CREATE TABLE external_product_seeds(id text PRIMARY KEY, external_product_id text, market text, tool text,
      destination_url text, canonical_url text, domain text, title text, image_url text, price_amount numeric,
      price_currency text, availability text, seed_data jsonb, updated_at timestamptz, created_at timestamptz,
      status text, attached_product_key text)`);
    await seedRow('app_usd', 'USD');
    await seedRow('app_sgd', 'SGD');
    await seedRow('app_null', null);
    await seedRow('app_blank', ' ');
  }, 60000);

  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  beforeEach(() => {
    priorEnv = { ...process.env };
    seedCalls = [];
    jest.resetModules();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => String(host || '').includes('127.0.0.1'));
    Object.assign(process.env, {
      PIVOTA_API_BASE: 'http://pivota.test', PIVOTA_API_KEY: 'test_key', API_MODE: 'REAL',
      DATABASE_URL: url, AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false', GATEWAY_RATE_LIMIT_ENABLED: 'false',
    });
    delete process.env.INDEX_ELIGIBLE_RECALL;
    delete process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET;
    jest.doMock('../../src/db', () => ({
      query: async (sql, params) => {
        const text = String(sql || '');
        // Only the apparel lane's own statements run on PostgreSQL; every other lane is empty.
        if (text.includes('FROM external_product_seeds') && text.includes('attached_product_key IS NULL') && !text.includes('ingredient_tokens')) {
          const result = await db.query(text, params);
          seedCalls.push({ sql: text, returned: result.rows.map((r) => r.id) });
          return result;
        }
        return { rows: [] };
      },
    }));
  });
  afterEach(() => {
    process.env = priorEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test('the lane\'s SQL refuses a seed with no currency; the door keeps SGD off a US page', async () => {
    const app = require('../../src/server');
    const resp = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'find_products_multi',
      payload: { search: { query: 'black linen button shirt', page: 1, limit: 20 } },
      metadata: { source: 'creator-agent-ui', creator_id: 'creator_test' },
    });
    // The apparel lane answered, not another one that happens to read seeds.
    expect(resp.body.metadata?.query_source).toBe('agent_products_creator_external_seed_direct');
    expect(resp.status).toBe(200);
    // The control: the lane really ran its statements on PostgreSQL and reached this fixture.
    expect(seedCalls.length).toBeGreaterThan(0);
    const returned = [...new Set(seedCalls.flatMap((c) => c.returned))].sort();
    expect(returned).toEqual(['app_sgd', 'app_usd']);
    const served = (resp.body.products || []).map((p) => String(p.external_seed_id || p.external_product_id || p.product_id));
    expect(served).toContain('app_usd');
    expect(served.filter((id) => ['app_sgd', 'app_null', 'app_blank'].includes(id))).toEqual([]);
    expect([...new Set((resp.body.products || []).map((p) => p.currency))]).toEqual(['USD']);
  });
});
