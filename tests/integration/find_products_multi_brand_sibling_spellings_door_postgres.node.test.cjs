'use strict';

// The brand-family invariant through the REAL /mcp door (search_catalog -> the gateway's own
// invoke route over loopback -> the canonical statement on PostgreSQL), for
// GATEWAY_CATALOG_BRAND_SIBLING_SPELLINGS. On node:test, not Jest, because the door imports the
// mcp-server ES module. The route-level suite and the fixture's description are in
// find_products_multi_brand_sibling_spellings_postgres.test.js and
// tests/_support/brandSiblingSpellingsFixture.cjs.
//
//   for every product a generic query returns,
//   "<its brand as a buyer types it> <the same query>" returns that product too.
//
// Flag off this breaks for exactly the products that sit under a sibling spelling (pinned count);
// flag on it holds. Dedicated disposable DB only: skipped without the explicit test URL.

const test = require('node:test');
const assert = require('node:assert/strict');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const FLAG = 'GATEWAY_CATALOG_BRAND_SIBLING_SPELLINGS';

test('the brand-family invariant through the real /mcp door, flag off (pinned gap) and on', { skip: !url && 'needs CANONICAL_MAINLINE_TEST_DATABASE_URL', timeout: 180000 }, async () => {
  const priorEnv = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: url, PIVOTA_API_BASE: 'http://upstream-disabled.test', PIVOTA_API_KEY: 'test', API_MODE: 'REAL',
    INDEX_ELIGIBLE_RECALL: 'false', PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true', SEARCH_QUALITY_CONTRACT_V1_ENABLED: 'true',
    SEARCH_QUALITY_CONTRACT_V1_MODE: 'enforce', PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: 'false',
    CANONICAL_CATALOG_RECALL_DOC_MATCH: 'off', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'off',
    AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
    GATEWAY_DYNAMIC_BRAND_DETECT: '1', GATEWAY_CATALOG_BEAUTY_BRAND_CONTRACT: '1',
    // The commerce /mcp door is mounted behind the strict-checkout switch (test-only values, as in
    // tests/commerce_ucp_search_shared_cache.node.test.cjs).
    AGENT_CHECKOUT_STRICT: '1', AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT: '1',
    CONFIRMATION_SECRET: 'strict-confirmation-secret-0123456789', PAYMENT_WEBHOOK_SECRET: 'strict-webhook-secret-0123456789',
    COMMERCE_READ_CACHE_ENABLED: '1', SELF_INVOKE_TIMEOUT_MS: '20000',
    // About a hundred searches in a second or two from one loopback caller: more than the invoke
    // route's per-caller bucket (120, refilled 2/s) is sized for, and not what this file measures.
    GATEWAY_RATE_LIMIT_ENABLED: 'false',
  });
  delete process.env.PUBLIC_READ_MCP_ENABLED;
  delete process.env[FLAG];
  for (const prefix of ['COMMERCE_MCP', 'PUBLIC_READ_MCP']) {
    for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`${prefix}_HEARTBEAT_${suffix}`];
  }

  const { Client } = require('pg');
  const supertest = require('supertest');
  const fixture = require('../_support/brandSiblingSpellingsFixture.cjs');
  const db = new Client({ connectionString: url });
  await db.connect();
  let schema = null;
  let server = null;
  try {
    // src/db, replaced before anything loads it: the canonical statement and the dictionary's
    // own statement run on the fixture, and no other lane has data.
    const state = { sqlCalls: [], coldDictionary: false };
    const dbPath = require.resolve('../../src/db');
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: fixture.fixtureDbQuery(db, state) } };
    const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
    const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');
    schema = await fixture.createFixture(db, { fetchCanonicalChainRows, buildSearchQualityContract });

    const app = require('../../src/server');
    await require('../../src/findProductsMulti/brandDictionaryCache').refresh();
    server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    process.env.SELF_INVOKE_BASE = `http://127.0.0.1:${server.address().port}`;

    // The door caches search_catalog answers per process, keyed on the call's params; a page size
    // of its own gives each phase its own entries.
    const doorSearch = (pageSize) => async (query) => {
      const res = await supertest(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'search_catalog', arguments: { query, market: 'US', page_size: pageSize } } });
      assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
      assert.notEqual(res.body.result?.isError, true, JSON.stringify(res.body.result).slice(0, 300));
      const body = res.body.result.structuredContent ?? JSON.parse(res.body.result.content[0].text);
      return (body.products || []).map((product) => {
        const id = fixture.idOfSig[product.product_id] || fixture.idOfSig[product.id];
        assert.ok(id, `a product this fixture does not hold: ${JSON.stringify(product).slice(0, 200)}`);
        return id;
      }).sort();
    };

    // FLAG OFF. The known gap, pinned: 10 of the fixture's 39 products cannot be found by their
    // brand + category through the door.
    const off = await fixture.invariantBreaks(doorSearch(50));
    assert.deepEqual(off, fixture.UNDER_A_SIBLING_SPELLING);
    assert.equal(off.length, 10);
    assert.deepEqual(await doorSearch(50)('Zentora sunscreen'), []);
    assert.deepEqual(await doorSearch(50)('Zentora serum'), ['zentora__serum']);

    // THE FLIP, IN A LIVE PROCESS. The flag is read per call, so the route is on at once. What the
    // door already holds is another matter (it caches search_catalog answers for
    // COMMERCE_READ_CACHE_TTL_MS, 5 minutes fresh, then serves them stale up to
    // COMMERCE_READ_CACHE_STALE_MS, 15; nothing here invalidates an entry, it ages out):
    process.env[FLAG] = 'on';
    //  * a page that was PARTIAL before the flip (the retailer's serum, without the store's) was
    //    a success, so it was stored, and a repeat of the same call still gets it;
    let statements = state.sqlCalls.length;
    assert.deepEqual(await doorSearch(50)('Zentora serum'), ['zentora__serum'], 'the pre-flip partial page is served from the door cache');
    assert.equal(state.sqlCalls.length, statements, 'a cached page runs no statement');
    //  * the EMPTY brand page was answered success:false by this lane, which the door does not
    //    store, so the same call is answered afresh and finds the store's row.
    statements = state.sqlCalls.length;
    assert.deepEqual(await doorSearch(50)('Zentora sunscreen'), ['zentora_usa__sunscreen']);
    assert.equal(state.sqlCalls.length, statements + 1);

    // FLAG ON, on entries of its own: the invariant holds, and precision with it.
    assert.deepEqual(await fixture.invariantBreaks(doorSearch(49)), []);
    assert.deepEqual(await doorSearch(49)('Zentora serum'), ['zentora__serum', 'zentora_usa__serum']);
    assert.deepEqual(await doorSearch(49)('Zentora Labs sunscreen'), ['zentora_labs__sunscreen']);
    assert.deepEqual(await doorSearch(49)('Noble serum'), ['noble__serum']);
    assert.deepEqual(await doorSearch(49)('Noble Pegasus serum'), ['noble_pegasus__serum']);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (schema) await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
    process.env = priorEnv;
  }
});
