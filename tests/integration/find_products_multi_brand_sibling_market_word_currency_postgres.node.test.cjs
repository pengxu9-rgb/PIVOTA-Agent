'use strict';

// GATEWAY_CATALOG_BRAND_SIBLING_SPELLINGS and the currency rule, on the route and the three MCP
// doors over PostgreSQL. A brand family here is a set of market storefronts, each priced in its own
// currency ("Solvane" and "Solvane US" in USD, "Solvane JP" in JPY, "Solvane UK" in GBP, "Solvane
// Global" in SGD). Binding more spellings must never put a price in front of a buyer in a currency
// that is not their market's, and must never change the price of a row the flag-off answer served.
//
// Every answer is walked whole with tests/_support/answerCurrencies.cjs against the gateway's own
// market -> currency source (resolveServingCurrency). Markets: US, SG, GB, JP, DE (no currency) and
// none. Dedicated disposable DB only: skipped without the explicit test URL.

const test = require('node:test');
const assert = require('node:assert/strict');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const FLAG = 'GATEWAY_CATALOG_BRAND_SIBLING_SPELLINGS';
const MARKETS = ['US', 'SG', 'GB', 'JP', 'DE', null];
const QUERIES = ['Solvane serum', 'Solvane US serum', 'Solvane JP serum', 'Solvane UK serum', 'Solvane Global serum', 'Solvane', 'Solvane JP', 'serum'];
// Sized from the PR gate's own logs: this test took 9.2 s on the CI runner in the one run there
// is, a fast one (the sibling door suite took 2.7 s in it and up to 4.7 s in others), so about
// 16 s on a slow runner; this is a little under four times that.
const TEST_TIMEOUT_MS = 60000;

test('sibling spellings keep the currency rule on the route and the three doors, flag on', { skip: !url && 'needs CANONICAL_MAINLINE_TEST_DATABASE_URL', timeout: TEST_TIMEOUT_MS }, async () => {
  const priorEnv = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: url, PIVOTA_API_BASE: 'http://upstream-disabled.test', PIVOTA_API_KEY: 'test', API_MODE: 'REAL',
    INDEX_ELIGIBLE_RECALL: 'false', PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true', SEARCH_QUALITY_CONTRACT_V1_ENABLED: 'true',
    SEARCH_QUALITY_CONTRACT_V1_MODE: 'enforce', PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: 'false',
    CANONICAL_CATALOG_RECALL_DOC_MATCH: 'off', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'off',
    AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
    GATEWAY_DYNAMIC_BRAND_DETECT: '1', GATEWAY_CATALOG_BEAUTY_BRAND_CONTRACT: '1',
    // The doors (test-only values, as in tests/commerce_ucp_search_shared_cache.node.test.cjs). No door
    // cache: the same call is made with the flag off and on in one process.
    AGENT_CHECKOUT_STRICT: '1', AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT: '1', AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED: '1',
    CONFIRMATION_SECRET: 'strict-confirmation-secret-0123456789', PAYMENT_WEBHOOK_SECRET: 'strict-webhook-secret-0123456789',
    PUBLIC_READ_MCP_ENABLED: '1', COMMERCE_READ_CACHE_ENABLED: '0', PUBLIC_READ_CACHE_ENABLED: '0',
    SELF_INVOKE_TIMEOUT_MS: '20000', GATEWAY_RATE_LIMIT_ENABLED: 'false', PUBLIC_READ_MCP_RPM: '100000', PUBLIC_READ_MCP_BURST: '100000',
  });
  delete process.env[FLAG];
  for (const prefix of ['COMMERCE_MCP', 'PUBLIC_READ_MCP']) {
    for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`${prefix}_HEARTBEAT_${suffix}`];
  }

  const { Client } = require('pg');
  const supertest = require('supertest');
  const fixture = require('../_support/brandSiblingSpellingsFixture.cjs');
  const { answerCurrencyProblems, collectAnswerCurrencies } = require('../_support/answerCurrencies.cjs');
  const db = new Client({ connectionString: url });
  await db.connect();
  let schema = null;
  let server = null;
  try {
    const state = { sqlCalls: [], coldDictionary: false };
    const dbPath = require.resolve('../../src/db');
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: fixture.fixtureDbQuery(db, state) } };
    const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
    const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');
    const { resolveServingCurrency } = require('../../src/services/buyerMarket');
    schema = await fixture.createFixture(db, { fetchCanonicalChainRows, buildSearchQualityContract });
    await fixture.insertItems(db, fixture.STOREFRONT_ITEMS);

    const app = require('../../src/server');
    await require('../../src/findProductsMulti/brandDictionaryCache').refresh();
    // One listener bound to 127.0.0.1 by name, for every call and the doors' own loopback hop.
    server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    process.env.SELF_INVOKE_BASE = origin;

    const rpc = (args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_catalog', arguments: args } });
    const DOORS = {
      route: (query, market) => supertest(origin).post('/agent/shop/v1/invoke').send({ operation: 'find_products_multi',
        payload: { search: { query, domain: 'beauty', ...(market ? { market } : {}), page: 1, limit: 50 } },
        metadata: { source: 'public_api', ...(market ? { market } : {}) } }),
      mcp: (query, market) => supertest(origin).post('/mcp').send(rpc({ query, ...(market ? { market } : {}), page_size: 50 })),
      ucp: (query, market) => supertest(origin).post('/ucp/mcp').send(rpc({ meta: { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' } },
        catalog: { query, ...(market ? { context: { address_country: market } } : {}) } })),
      public: (query, market) => supertest(origin).post('/public/mcp').set('X-Forwarded-For', '10.7.7.7, 203.0.113.91')
        .send(rpc({ query, ...(market ? { market } : {}) })),
    };
    // The rows an answer serves, wherever the door puts them, each with the prices it states.
    const rowsOf = (body) => {
      const rows = new Map();
      const visit = (node) => {
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (!node || typeof node !== 'object') {
          if (typeof node === 'string' && /^\s*[{[]/.test(node)) { try { visit(JSON.parse(node)); } catch (_) { /* text */ } }
          return;
        }
        if (Array.isArray(node.products)) {
          for (const product of node.products) {
            const id = product && (product.product_key || product.product_id || product.id);
            if (!id) continue;
            const found = collectAnswerCurrencies(product);
            rows.set(String(id), JSON.stringify([found.money.map((m) => [m.path, m.value, m.currency]), found.priceCurrencies.map((c) => [c.path, c.value])]));
          }
        }
        Object.values(node).forEach(visit);
      };
      visit(body);
      return rows;
    };

    const run = async (flag) => {
      if (flag) process.env[FLAG] = flag; else delete process.env[FLAG];
      const out = {};
      for (const [door, call] of Object.entries(DOORS)) {
        for (const market of MARKETS) {
          for (const query of QUERIES) {
            const res = await call(query, market);
            assert.equal(res.status, 200, `${door} ${market} ${query}: ${JSON.stringify(res.body).slice(0, 200)}`);
            out[`${door} | ${market || 'none'} | ${query}`] = { body: res.body, rows: rowsOf(res.body), currency: resolveServingCurrency(market || undefined) };
          }
        }
      }
      return out;
    };
    const off = await run(null);
    const on = await run('on');

    const problems = [];
    const repriced = [];
    let widened = 0;
    const servedCurrencies = {};
    for (const [key, answer] of Object.entries(on)) {
      for (const problem of answerCurrencyProblems(answer.body, answer.currency)) problems.push(`${key}: ${problem}`);
      for (const [id, price] of answer.rows) {
        if (off[key].rows.has(id) && off[key].rows.get(id) !== price) repriced.push(`${key}: ${id}`);
      }
      // nothing the flag-off answer served is lost
      for (const id of off[key].rows.keys()) assert.ok(answer.rows.has(id), `${key}: row ${id} was served with the flag off and is gone`);
      if (answer.rows.size > off[key].rows.size) widened += 1;
      const market = key.split(' | ')[1];
      for (const c of collectAnswerCurrencies(answer.body).priceCurrencies) (servedCurrencies[market] ||= new Set()).add(String(c.value).toUpperCase());
    }
    assert.deepEqual(problems, [], 'a price in a currency that is not the market\'s, flag on');
    assert.deepEqual(repriced, [], 'a row whose price differs from the flag-off answer');
    // the flag-off answers keep the rule too, so the comparison is against a clean baseline
    for (const [key, answer] of Object.entries(off)) assert.deepEqual(answerCurrencyProblems(answer.body, answer.currency), [], `flag off: ${key}`);
    // not vacuous: the flag widened answers, and each priced market was served its own currency only
    assert.ok(widened > 0, 'the flag widened no answer: the fixture is not exercising it');
    assert.deepEqual(Object.fromEntries(Object.entries(servedCurrencies).map(([m, set]) => [m, [...set].sort()])),
      { US: ['USD'], SG: ['SGD'], GB: ['GBP'], JP: ['JPY'], none: ['USD'] });
    // the owner's rule, where currency makes it visible: a US buyer naming the JP storefront gets the bare
    // (USD) row, not the US storefront's
    const ids = (key) => [...on[key].rows.keys()].sort();
    const item = (brand) => fixture.STOREFRONT_ITEMS.find((i) => i.brand === brand && i.kind === 'serum').id;
    assert.deepEqual(ids('route | US | Solvane JP serum'), [item('Solvane')]);
    assert.deepEqual(ids('route | US | Solvane serum'), [item('Solvane'), item('Solvane US')].sort());
    assert.deepEqual(ids('route | JP | Solvane serum'), [item('Solvane JP')]);
    assert.deepEqual(ids('route | JP | Solvane US serum'), []);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (schema) await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
    process.env = priorEnv;
  }
});
