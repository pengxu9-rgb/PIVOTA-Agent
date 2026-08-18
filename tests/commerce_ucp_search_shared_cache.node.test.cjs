'use strict';

// The UCP door and the /mcp door share ONE commerce read cache — asserted on the wire, not in prose.
//
// THE DEFECT THIS PINS (review of #2016). getCommerceUcpMcpAdapter built a SECOND createCommerceToolSurface
// with `cache:false`, on the premise that "the /mcp surface already owns the shared commerce read cache; a
// second instance would be a second cache". The cache is PER SURFACE INSTANCE (built inside the factory), so
// the premise was false and the UCP door simply had no cache. It was moot while the dialect exposed no
// cacheable tool; the day `search_catalog` joined it (#2016), every UCP search would have paid the cold
// cost — 21.2s measured on prod for an identical repeat, against ~100ms cached — on the exact lane the
// real-time buyer-agent requirement lives on. The fix projects the /mcp door's own surface instance
// (`ucpDialectSurface(await getCommerceToolSurface())`), so this file drives BOTH doors and counts what
// reaches the search upstream:
//   - a repeat over /ucp/mcp is served from cache (kills `cache:false` on the UCP door);
//   - the SAME query over /mcp is ALSO served from that cache (kills "two surfaces, two caches");
//   - a DIFFERENT query misses (the cache is keyed, not swallowing everything).
//
// HARNESS. Unscoped `search_catalog` -> canonicalExecutor `find_products_multi` -> the gateway's OWN invoke
// pipeline over LOOPBACK (`selfInvokeBase()/agent/shop/v1/invoke`, see invokeCommerceKernelRawUpstream), so
// nock on the loopback origin is the upstream counter — the same interception
// tests/commerce_search_self_invoke_budget.node.test.cjs relies on. NODE_ENV=test is the per-request
// invoke-auth bypass (no introspection config set), the same one the commerce heartbeat suite uses; the
// door's OAuth challenge is out of scope here and is pinned by tests/commerce_ucp_mcp_door.node.test.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const nock = require('nock');
const supertest = require('supertest');

const ORIGINAL_ENV = { ...process.env };

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.PORT = '3998';
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.PIVOTA_API_BASE = 'http://127.0.0.1:3998';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
// The cache under test. Default is ON; set explicitly so an ambient COMMERCE_READ_CACHE_ENABLED=0 on a
// developer machine cannot turn every assertion below into a failure unrelated to the wiring.
process.env.COMMERCE_READ_CACHE_ENABLED = '1';
// Keep /mcp on the COMMERCE lane: with the public tier enabled its host dispatch would capture the /mcp
// requests below and this file would be measuring the wrong cache.
delete process.env.PUBLIC_READ_MCP_ENABLED;
// Loopback hops carry their own timeout budget; a generous one keeps a slow CI box out of the assertion.
process.env.SELF_INVOKE_TIMEOUT_MS = '6000';
for (const prefix of ['COMMERCE_MCP', 'PUBLIC_READ_MCP']) {
  for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) {
    delete process.env[`${prefix}_HEARTBEAT_${suffix}`];
  }
}

const app = require('../src/server');

const LOOPBACK = 'http://127.0.0.1:3998';
const AGENT_META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' } };

const SEARCH_RESULT = {
  status: 'success',
  success: true,
  products: [{ product_id: 'sig_probe', title: 'probe', price: 10, currency: 'USD' }],
  total: 1,
};

/** Intercept the loopback search invoke and count every hit. Only the search operation is answered. */
function interceptSearchUpstream() {
  const state = { attempts: 0, operations: [] };
  state.scope = nock(LOOPBACK)
    .persist()
    .post('/agent/shop/v1/invoke', (body) => {
      const op = body && body.operation;
      state.operations.push(op);
      return op === 'find_products_multi';
    })
    .reply(() => {
      state.attempts += 1;
      return [200, SEARCH_RESULT];
    });
  return state;
}

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const ucpSearch = (query, id) => rpc('tools/call', { name: 'search_catalog', arguments: { meta: AGENT_META, catalog: { query } } }, id);
const mcpSearch = (query, id) => rpc('tools/call', { name: 'search_catalog', arguments: { query } }, id);

async function post(path, body) {
  const resp = await supertest(app).post(path).send(body).expect(200);
  assert.equal(resp.body.jsonrpc, '2.0');
  assert.ok(resp.body.result, `${path}: expected a JSON-RPC result, got ${JSON.stringify(resp.body).slice(0, 300)}`);
  assert.notEqual(resp.body.result.isError, true, `${path}: tool answered isError: ${JSON.stringify(resp.body.result).slice(0, 300)}`);
  return resp.body.result;
}

test.after(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  process.env = { ...ORIGINAL_ENV };
});

test('the UCP door and the /mcp door answer an identical search from ONE shared cache', async () => {
  const upstream = interceptSearchUpstream();
  try {
    // A query no other test in this process could have warmed.
    const query = `shared-cache-probe-${process.pid}-a`;

    // 1) cold over the UCP door: exactly one upstream hit.
    await post('/ucp/mcp', ucpSearch(query, 1));
    assert.equal(upstream.attempts, 1, 'the first UCP search must reach the search upstream once');

    // 2) repeat over the UCP door: served from cache. This is the line `cache:false` on the UCP door fails.
    await post('/ucp/mcp', ucpSearch(query, 2));
    assert.equal(upstream.attempts, 1, 'an identical UCP repeat must be served from the commerce read cache');

    // 3) the SAME query over the NATIVE door: also from cache. This is the line "two surfaces, two caches"
    //    fails — the argument adapter maps the UCP shape to the same allowlisted params, so the key matches.
    await post('/mcp', mcpSearch(query, 3));
    assert.equal(upstream.attempts, 1, 'the /mcp door must read the entry the UCP door populated (one cache)');

    // 4) …and the other direction, on a fresh key: /mcp populates, /ucp/mcp reads.
    const query2 = `shared-cache-probe-${process.pid}-b`;
    await post('/mcp', mcpSearch(query2, 4));
    assert.equal(upstream.attempts, 2, 'a DIFFERENT query must miss (the cache is keyed, not swallowing everything)');
    await post('/ucp/mcp', ucpSearch(query2, 5));
    assert.equal(upstream.attempts, 2, 'the UCP door must read the entry the /mcp door populated');

    // Every hit that reached the upstream was the unscoped multi-merchant lane — never the merchant-scoped
    // per-store `find_products` (the UCP shape names no merchant, so nothing can flip it).
    assert.deepEqual([...new Set(upstream.operations)], ['find_products_multi']);
  } finally {
    nock.cleanAll();
  }
});
