'use strict';

// MCP framing + response reading for the readiness eval, against hand-made recorded responses
// (tests/agent_readiness_eval/fixtures — invented products, no real catalog data).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classifyHttp, parseSseJsonRpc, McpClient, sanitizeErrorMessage } = require('../../scripts/agent-readiness-eval/lib/mcpClient.cjs');
const R = require('../../scripts/agent-readiness-eval/lib/responses.cjs');

const FX = path.join(__dirname, 'fixtures');
const raw = (name) => fs.readFileSync(path.join(FX, name), 'utf8');
const json = (name) => JSON.parse(raw(name));
const rec = (body) => ({ outcome: 'ok', rpc: body });

test('classifyHttp: JSON body -> ok with the JSON-RPC message attached', () => {
  const r = classifyHttp({}, 200, raw('commerce_search_red_lipstick.json'), 'application/json', 3, false);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.rpc.id, 3);
});

test('classifyHttp: heartbeat-padded body (leading newlines) still parses', () => {
  const r = classifyHttp({}, 200, raw('heartbeat_padded_search.txt'), 'application/json', 11, false);
  assert.equal(r.outcome, 'ok');
});

test('classifyHttp: SSE framing is read, and the message answering our id is chosen', () => {
  const r = classifyHttp({}, 200, raw('sse_tools_list.txt'), 'text/event-stream', 2, false);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.rpc.result.tools[0].name, 'search_catalog');
  const multi = 'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n\n';
  assert.deepEqual(parseSseJsonRpc(multi, 1).result, { a: 1 });
});

test('classifyHttp: HTTP and JSON-RPC failure classes', () => {
  assert.equal(classifyHttp({}, 429, '', '', 1, false).outcome, 'rate_limited');
  assert.equal(classifyHttp({}, 401, '{"error":"UNAUTHORIZED"}', 'application/json', 1, false).outcome, 'auth_error');
  assert.equal(classifyHttp({}, 403, '', '', 1, false).outcome, 'auth_error');
  assert.equal(classifyHttp({}, 503, '{"error":"mcp_unavailable"}', 'application/json', 1, false).outcome, 'http_error');
  assert.equal(classifyHttp({}, 404, '', '', 1, false).outcome, 'http_error');
  assert.equal(classifyHttp({}, 200, 'not json', 'text/plain', 1, false).outcome, 'parse_error');
  assert.equal(classifyHttp({}, 200, '{"id":1,"result":{}}', 'application/json', 1, false).outcome, 'parse_error', 'jsonrpc:2.0 is required');
  const e = classifyHttp({}, 200, raw('jsonrpc_error_method.json'), 'application/json', 9, false);
  assert.equal(e.outcome, 'jsonrpc_error');
  assert.match(e.error, /-32601/);
  assert.equal(classifyHttp({}, 200, '{"jsonrpc":"2.0","id":99,"result":{}}', 'application/json', 1, false).outcome, 'parse_error', 'id mismatch');
  // notifications/initialized answers 202 with no body
  assert.equal(classifyHttp({}, 202, '', '', undefined, true).outcome, 'ok');
});

test('McpClient sends partner-shaped JSON-RPC: initialize, then notifications/initialized, then calls with negotiated headers', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, headers: init.headers, body });
    const reply = (status, obj, headers = {}) => ({
      status,
      headers: new Map(Object.entries({ 'content-type': 'application/json', ...headers })),
      text: async () => (obj == null ? '' : JSON.stringify(obj)),
    });
    if (body.method === 'initialize') return reply(200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'stub', version: '0' }, capabilities: { tools: {} } } }, { 'mcp-session-id': 'sess-1' });
    if (body.method === 'notifications/initialized') return reply(202, null);
    return reply(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{}' }] } });
  };
  const client = new McpClient({ endpoint: 'http://127.0.0.1:1/mcp', auth: 'api_key', apiKey: `ak_live_${'a'.repeat(64)}`, fetchImpl: fakeFetch, extraHeaders: { 'x-pivota-synthetic-traffic': 'readiness-eval' } });
  const init = await client.initialize();
  assert.equal(init.outcome, 'ok');
  assert.equal(init.initialized_notification.outcome, 'ok');
  const call = await client.callTool('search_catalog', { query: 'red lipstick' });
  assert.equal(call.outcome, 'ok');
  assert.deepEqual(seen.map((s) => s.body.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(seen[0].body.params.protocolVersion, '2025-06-18');
  assert.ok(seen[0].body.params.clientInfo.name);
  assert.equal('id' in seen[1].body, false, 'a notification carries no id');
  assert.deepEqual(seen[2].body.params, { name: 'search_catalog', arguments: { query: 'red lipstick' } });
  assert.equal(seen[2].headers['mcp-protocol-version'], '2025-06-18');
  assert.equal(seen[2].headers['mcp-session-id'], 'sess-1');
  assert.match(seen[2].headers.accept, /application\/json/);
  assert.match(seen[2].headers.accept, /text\/event-stream/);
  assert.ok(seen[2].headers['x-agent-api-key'].startsWith('ak_live_'));
  assert.equal(seen[2].headers['x-pivota-synthetic-traffic'], 'readiness-eval');
});

test('McpClient: bearer auth header; timeout and transport failures are classified, never thrown', async () => {
  let headers;
  const client = new McpClient({ endpoint: 'http://127.0.0.1:1/mcp', auth: 'bearer', bearerToken: 'tok', timeoutMs: 30, fetchImpl: (url, init) => {
    headers = init.headers;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  } });
  const r = await client.callTool('search_catalog', {});
  assert.equal(headers.authorization, 'Bearer tok');
  assert.equal(r.outcome, 'timeout');
  const c2 = new McpClient({ endpoint: 'http://127.0.0.1:1/mcp', fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  const r2 = await c2.callTool('search_catalog', {});
  assert.equal(r2.outcome, 'transport_error');
  assert.equal(r2.error, 'ECONNREFUSED');
  assert.equal(sanitizeErrorMessage(new Error(`bad key ak_live_${'b'.repeat(64)}`)), 'bad key ak_<redacted>');
});

test('toolPayload reads the commerce door (content text) and the public door (structuredContent)', () => {
  const c = R.toolPayload(rec(json('commerce_search_red_lipstick.json')));
  assert.equal(c.isError, false);
  assert.equal(c.value.products.length, 3);
  const p = R.toolPayload(rec(json('public_search_niacinamide.json')));
  assert.equal(p.value.products[0].product_id, 'sig_fx_101');
});

test('toolPayload: an isError result yields its code, message and retriable flag', () => {
  const t = R.toolPayload(rec(json('tool_error_unavailable.json')));
  assert.equal(t.isError, true);
  assert.equal(t.errorCode, 'MERCHANT_UNAVAILABLE');
  assert.equal(t.retriable, true);
  const bare = R.toolPayload(rec({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'oops' }] } }));
  assert.equal(bare.errorCode, 'UNSPECIFIED_TOOL_ERROR');
});

test('readSearch normalizes both doors onto one product shape', () => {
  const c = R.readSearch(R.toolPayload(rec(json('commerce_search_red_lipstick.json'))));
  assert.equal(c.products[0].id, 'sig_fx_001');
  assert.equal(c.products[0].price.amount, 18);
  assert.equal(c.products[0].price.currency, 'USD');
  assert.equal(c.products[0].link, 'https://agent.fixture.example/products/sig_fx_001', 'pivota_url is the link a partner cites');
  assert.deepEqual(c.products[0].variants, ['Classic Red', 'Brick']);
  assert.equal(c.empty_class, null);
  const p = R.readSearch(R.toolPayload(rec(json('public_search_niacinamide.json'))));
  assert.equal(p.products[0].price.currency, 'SGD');
  assert.deepEqual(p.products[0].actives, ['Niacinamide', 'Zinc PCA']);
  assert.equal(p.products[1].price, null, 'a withheld price is absent, not zero');
});

test('empty-class parsing: public empty_reason, commerce strict_empty_reason, and unspecified', () => {
  assert.equal(R.readSearch(R.toolPayload(rec(json('public_search_empty_filtered.json')))).empty_class, 'filtered_out');
  assert.equal(R.readSearch(R.toolPayload(rec(json('commerce_search_strict_empty.json')))).empty_class, 'no_candidates');
  assert.equal(R.emptyClassOf({ products: [], empty_class: 'off_vertical' }, 0), 'off_vertical');
  assert.equal(R.emptyClassOf({ products: [] }, 0), 'unspecified');
  assert.equal(R.emptyClassOf({ products: [{}] }, 1), null);
  const padded = classifyHttp({}, 200, raw('heartbeat_padded_search.txt'), 'application/json', 11, false);
  assert.equal(R.readSearch(R.toolPayload(padded)).empty_class, 'no_match');
});

test('a "failed" envelope that still carries hits is reported as BOTH degraded and having hits', () => {
  const s = R.readSearch(R.toolPayload(rec(json('commerce_search_failed_with_hits.json'))));
  assert.equal(s.degraded, true);
  assert.equal(s.products.length, 1);
  assert.equal(s.failed_with_hits, true);
});

test('readOffers: offers, best offer, stated market currency', () => {
  const o = R.readOffers(R.toolPayload(rec(json('commerce_get_offers_sg.json'))));
  assert.equal(o.offers.length, 2);
  assert.equal(o.best_offer.price.currency, 'SGD');
  assert.equal(o.market_currency, 'SGD');
  assert.equal(o.offers[1].in_stock, null);
  assert.equal(R.linkProblem(o.offers[1].link), 'placeholder_segment');
});

test('linkProblem: syntax only', () => {
  assert.equal(R.linkProblem('https://agent.fixture.example/products/sig_1'), null);
  assert.equal(R.linkProblem(''), 'missing');
  assert.equal(R.linkProblem('/products/sig_1'), 'unparseable');
  assert.equal(R.linkProblem('javascript:alert(1)'), 'bad_scheme');
  assert.equal(R.linkProblem('https://localhost/x'), 'bad_host');
  assert.equal(R.linkProblem('https://a.example/products/null'), 'placeholder_segment');
  assert.equal(R.linkProblem('https://a.example/p q'), 'whitespace');
});

test('readPrice: lenient read, invalid currency flagged', () => {
  assert.deepEqual(R.readPrice({ price: { amount: 10, currency: 'usd' } }), { amount: 10, currency: 'USD', currencyValid: true });
  assert.deepEqual(R.readPrice({ price: '12.5', currency: '$' }), { amount: 12.5, currency: '$', currencyValid: false });
  assert.deepEqual(R.readPrice({ price_amount: 3, price_currency: 'SGD' }), { amount: 3, currency: 'SGD', currencyValid: true });
  assert.equal(R.readPrice({ title: 'x' }), null);
  assert.equal(R.currencyForMarket('sg'), 'SGD');
  assert.equal(R.currencyForMarket(null), null);
});
