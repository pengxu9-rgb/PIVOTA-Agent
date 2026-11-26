'use strict';

// scripts/probe-cafe24-store-ucp.cjs — offline. Every request goes to an injected fake; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');

const probe = require('../scripts/probe-cafe24-store-ucp.cjs');

const STORE = 'examplemall';
const PROFILE_HOST = `${STORE}.cafe24.com`;
const API_HOST = `${STORE}.cafe24api.com`;
const ENDPOINT = `https://${API_HOST}/api/ucp/mcp`;
const ENV = { UCP_AGENT_PROFILE_URL: 'https://agent.example.org/.well-known/ucp-agent' };
const SECRET_TITLE = 'UNIQUE-TITLE-MARKER';
const SECRET_URL = 'https://examplemall.cafe24.com/product/unique-url-marker';
const SECRET_AMOUNT = 98765;

function sink() {
  let text = '';
  return { write: (s) => { text += s; }, text: () => text };
}

function reportOf(out) {
  const line = out.text().split('\n').find((l) => l.startsWith('CAFE24_STORE_UCP_PROBE {'));
  assert.ok(line, out.text());
  assert.ok(out.text().includes('CAFE24_STORE_UCP_PROBE_DONE'));
  return JSON.parse(line.slice('CAFE24_STORE_UCP_PROBE '.length));
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function profile({ mcp = ENDPOINT, handlers = {} } = {}) {
  return {
    ucp: {
      version: '2026-08-25',
      services: {
        'dev.ucp.shopping': [
          { version: '2026-08-25', transport: 'rest', endpoint: `https://${API_HOST}/api/ucp` },
          { version: '2026-08-25', transport: 'mcp', endpoint: mcp },
          { version: '2026-08-25', transport: 'embedded' },
        ],
      },
      capabilities: {
        'dev.ucp.shopping.checkout': [{ version: '2026-08-25' }],
        'dev.ucp.shopping.cart': [{ version: '2026-08-25' }],
        'dev.ucp.shopping.order': [{ version: '2026-08-25' }],
        'dev.ucp.shopping.catalog.search': [{ version: '2026-08-25' }],
        'dev.ucp.shopping.catalog.lookup': [{ version: '2026-08-25' }],
      },
      payment_handlers: handlers,
    },
    signing_keys: [{ kid: 'k1' }, { kid: 'k2' }],
  };
}

const TOOLS = ['search_catalog', 'lookup_catalog', 'get_product', 'create_checkout', 'complete_checkout'];

function product() {
  return {
    id: '12345',
    title: SECRET_TITLE,
    url: SECRET_URL,
    variants: [{ id: '12345-A', title: SECRET_TITLE, price: { amount: SECRET_AMOUNT, currency: 'KRW' } }],
  };
}

function toolResult(id, payload) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } };
}

/**
 * A fake store. `routes` overrides an answer by key: 'profile', 'tools/list', 'search_catalog', 'lookup_catalog'.
 * Records every request it receives (url, method, headers, parsed body).
 */
function fakeStore(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = null; }
    calls.push({ url: String(url), host: u.hostname, method: init.method || 'GET', headers: { ...(init.headers || {}) }, body });
    if (u.hostname === PROFILE_HOST && u.pathname === '/.well-known/ucp') {
      return routes.profile ? routes.profile() : json(200, profile());
    }
    if (u.hostname === API_HOST && body) {
      const key = body.method === 'tools/call' ? body.params.name : body.method;
      if (routes[key]) return routes[key](body);
      if (key === 'tools/list') return json(200, { jsonrpc: '2.0', id: body.id, result: { tools: TOOLS.map((name) => ({ name })) } });
      if (key === 'search_catalog' || key === 'lookup_catalog') return json(200, toolResult(body.id, { products: [product()] }));
    }
    return json(404, { error: 'not found' });
  };
  return { fetchImpl, calls };
}

function assertNoSecretsIn(text) {
  assert.ok(!text.includes(SECRET_TITLE), 'a product title reached the output');
  assert.ok(!text.includes('unique-url-marker'), 'a product URL reached the output');
  assert.ok(!text.includes(String(SECRET_AMOUNT)), 'a price amount reached the output');
  assert.ok(!text.includes('12345'), 'a product id reached the output');
}

function assertAnonymous(calls) {
  for (const c of calls) {
    const names = Object.keys(c.headers).map((h) => h.toLowerCase());
    for (const banned of ['authorization', 'signature', 'signature-input']) {
      assert.ok(!names.includes(banned), `${banned} header sent to ${c.host}`);
    }
  }
}

test('full read: profile, tools/list, search, lookup; the report holds shapes and counts only', async () => {
  const store = fakeStore();
  const out = sink();
  const code = await probe.main(['--store', STORE, '--query', 'cushion foundation', '--country', 'kr'],
    { env: ENV, stdout: out, fetchImpl: store.fetchImpl });
  assert.equal(code, 0, out.text());
  const r = reportOf(out);
  assert.equal(r.verdict, 'RAN');
  assert.equal(r.stopped_at, 'done');
  assert.equal(r.country, 'KR');
  assert.equal(r.steps.profile.reason, 'ok');
  assert.equal(r.steps.profile.mcp_endpoint, 'pinned');
  assert.deepEqual(r.steps.profile.versions, ['2026-08-25']);
  assert.equal(r.steps.profile.version_overlap, false);
  assert.equal(r.steps.profile.payment_handler_count, 0);
  assert.equal(r.steps.profile.signing_key_count, 2);
  assert.equal(r.steps.profile.advertises.checkout, true);
  assert.equal(r.steps.profile.advertises.catalog_search, true);
  assert.deepEqual(r.steps.profile.services.map((s) => s.transport), ['rest', 'mcp', 'embedded']);
  assert.deepEqual(r.steps.profile.services.map((s) => s.endpoint_on_api_host), [true, true, null]);
  assert.equal(r.steps.tools_list.reason, 'ok');
  assert.deepEqual(r.steps.tools_list.tools, TOOLS);
  assert.equal(r.steps.search.reason, 'ok');
  assert.equal(r.steps.search.products, 1);
  assert.equal(r.steps.search.first_product_id_shape, 'numeric');
  assert.equal(r.steps.search.first_variant_id_shape, 'other');
  assert.deepEqual(r.steps.search.currencies, ['KRW']);
  assert.equal(r.steps.search.priced, true);
  assert.equal(r.steps.lookup.reason, 'ok');
  assert.equal(r.tier.tier, 'anonymous');
  assert.equal(r.tier.signs_requests, false);
  // Exactly the four allowed requests, in order, and nothing else.
  assert.deepEqual(store.calls.map((c) => [c.method, c.host, c.body ? c.body.method : null, c.body && c.body.params ? (c.body.params.name ?? null) : null]),
    [['GET', PROFILE_HOST, null, null], ['POST', API_HOST, 'tools/list', null],
      ['POST', API_HOST, 'tools/call', 'search_catalog'], ['POST', API_HOST, 'tools/call', 'lookup_catalog']]);
  assert.deepEqual(r.trace.map((t) => t.status), [200, 200, 200, 200]);
  // The search asked for one result in the buyer's market; the lookup asked for the id the search returned.
  assert.deepEqual(store.calls[2].body.params.arguments.catalog,
    { query: 'cushion foundation', context: { address_country: 'KR' }, pagination: { limit: 1 } });
  assert.deepEqual(store.calls[3].body.params.arguments.catalog.ids, ['12345']);
  // Our agent profile rides on every MCP request.
  for (const c of store.calls.slice(1)) assert.equal(c.body.params.arguments.meta['ucp-agent'].profile, ENV.UCP_AGENT_PROFILE_URL);
  assertNoSecretsIn(out.text());
  assertAnonymous(store.calls);
});

test('no --query: stops after tools/list, two requests', async () => {
  const store = fakeStore();
  const out = sink();
  const code = await probe.main(['--store', `${STORE}.cafe24.com`], { env: ENV, stdout: out, fetchImpl: store.fetchImpl });
  assert.equal(code, 0);
  const r = reportOf(out);
  assert.equal(r.stopped_at, 'no_query');
  assert.equal(store.calls.length, 2);
  assert.equal(r.steps.search, undefined);
});

test('an MCP endpoint off the store API host is never contacted', async () => {
  for (const mcp of ['https://elsewhere.example.com/api/ucp/mcp', `https://${API_HOST}/other/mcp`, `https://${STORE}2.cafe24api.com/api/ucp/mcp`]) {
    const store = fakeStore({ profile: () => json(200, profile({ mcp })) });
    const out = sink();
    await probe.main(['--store', STORE, '--query', 'toner'], { env: ENV, stdout: out, fetchImpl: store.fetchImpl });
    const r = reportOf(out);
    assert.equal(r.stopped_at, 'profile', mcp);
    assert.equal(r.steps.profile.mcp_endpoint, 'not_pinned');
    assert.equal(store.calls.length, 1, mcp);
  }
});

test('profile 404 or redirect: stops at profile, one request', async () => {
  for (const status of [404, 301]) {
    const store = fakeStore({ profile: () => new Response('', { status, headers: { location: 'https://elsewhere.example.com/' } }) });
    const out = sink();
    await probe.main(['--store', STORE, '--query', 'toner'], { env: ENV, stdout: out, fetchImpl: store.fetchImpl });
    const r = reportOf(out);
    assert.equal(r.stopped_at, 'profile');
    assert.equal(r.steps.profile.reason, 'discovery_failed');
    assert.equal(r.steps.profile.http_status, status);
    assert.equal(store.calls.length, 1);
  }
});

test('tools/list refusals are classified, and the probe stops there', async () => {
  const cases = [
    [() => new Response('Bad Request: No valid session ID provided', { status: 400 }), 'mcp_session_required'],
    [(b) => json(200, { jsonrpc: '2.0', id: b.id, error: { code: -32001, message: 'profile_unreachable' } }), 'profile_refused'],
    [() => json(403, {}), 'http_403'],
    [() => json(400, {}), 'http_4xx'],
  ];
  for (const [answer, reason] of cases) {
    const store = fakeStore({ 'tools/list': answer });
    const out = sink();
    await probe.main(['--store', STORE, '--query', 'toner'], { env: ENV, stdout: out, fetchImpl: store.fetchImpl });
    const r = reportOf(out);
    assert.equal(r.steps.tools_list.reason, reason);
    assert.equal(r.stopped_at, 'tools_list');
    assert.equal(store.calls.length, 2);
  }
});

test('search tool error: no lookup is sent', async () => {
  const store = fakeStore({
    search_catalog: (b) => json(200, { jsonrpc: '2.0', id: b.id, result: { isError: true, content: [{ type: 'text', text: SECRET_TITLE }] } }),
  });
  const out = sink();
  await probe.main(['--store', STORE, '--query', 'toner'], { env: ENV, stdout: out, fetchImpl: store.fetchImpl });
  const r = reportOf(out);
  assert.equal(r.steps.search.reason, 'tool_error');
  assert.equal(r.steps.lookup, undefined);
  assert.equal(store.calls.length, 3);
  assertNoSecretsIn(out.text());
});

test('search_catalog not listed: not called', async () => {
  const store = fakeStore({ 'tools/list': (b) => json(200, { jsonrpc: '2.0', id: b.id, result: { tools: [{ name: 'create_checkout' }] } }) });
  const out = sink();
  await probe.main(['--store', STORE, '--query', 'toner'], { env: ENV, stdout: out, fetchImpl: store.fetchImpl });
  const r = reportOf(out);
  assert.equal(r.steps.search.reason, 'tool_not_listed');
  assert.equal(store.calls.length, 2);
});

test('the transport refuses everything but the read calls, before anything is sent', async () => {
  const sent = [];
  const base = async (url) => { sent.push(url); return json(200, {}); };
  const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });
  const refusals = [
    [`https://elsewhere.example.com/.well-known/ucp`, { method: 'GET' }, 'host_not_store'],
    [`https://${STORE}2.cafe24.com/.well-known/ucp`, { method: 'GET' }, 'host_not_store'],
    [`http://${PROFILE_HOST}/.well-known/ucp`, { method: 'GET' }, 'not_plain_https'],
    [`https://${PROFILE_HOST}:8443/.well-known/ucp`, { method: 'GET' }, 'not_plain_https'],
    [`https://${PROFILE_HOST}/.well-known/ucp`, { method: 'POST' }, 'profile_host_path'],
    [`https://${PROFILE_HOST}/products`, { method: 'GET' }, 'profile_host_path'],
    [ENDPOINT, { method: 'GET' }, 'api_host_method'],
    [ENDPOINT, { method: 'POST', body: 'not json' }, 'body_not_json'],
    [ENDPOINT, post({ jsonrpc: '2.0', method: 'initialize' }), 'rpc_method'],
    [ENDPOINT, post({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'create_checkout' } }), 'tool_not_read_only'],
    [ENDPOINT, post({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'complete_checkout' } }), 'tool_not_read_only'],
    [ENDPOINT, post({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'create_cart' } }), 'tool_not_read_only'],
    [ENDPOINT, post({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_order' } }), 'tool_not_read_only'],
  ];
  for (const [url, init, why] of refusals) {
    const trace = [];
    const f = probe.guardedFetch({ baseFetch: base, store: STORE, trace });
    await assert.rejects(f(url, init), (e) => e.code === 'PROBE_REFUSED' && e.message.endsWith(why), `${url} ${why}`);
    assert.equal(trace[0].refused, why);
  }
  assert.equal(sent.length, 0);
});

test('the transport stops at the request cap', async () => {
  const sent = [];
  const trace = [];
  const f = probe.guardedFetch({ baseFetch: async (u) => { sent.push(u); return json(200, {}); }, store: STORE, trace });
  for (let i = 0; i < probe.MAX_REQUESTS; i += 1) await f(`https://${PROFILE_HOST}/.well-known/ucp`, { method: 'GET' });
  await assert.rejects(f(`https://${PROFILE_HOST}/.well-known/ucp`, { method: 'GET' }), /request_cap/);
  assert.equal(sent.length, probe.MAX_REQUESTS);
});

test('input refusals exit 2 and send nothing', async () => {
  const cases = [
    [[], ENV],
    [['--store', 'evil.example.com'], ENV],
    [['--store', 'a.b'], ENV],
    [['--store', '-bad'], ENV],
    [['--store', STORE, '--query', 'toner; drop'], ENV],
    [['--store', STORE, '--query', 'x'.repeat(61)], ENV],
    [['--store', STORE, '--country', 'KOR'], ENV],
    [['--store', STORE, '--store', 'other'], ENV],
    [['--store', STORE, '--extra'], ENV],
    [['--store', STORE], {}],
    [['--store', STORE], { UCP_AGENT_PROFILE_URL: 'http://agent.example.org/.well-known/ucp-agent' }],
  ];
  for (const [argv, env] of cases) {
    const store = fakeStore();
    const out = sink();
    const code = await probe.main(argv, { env, stdout: out, fetchImpl: store.fetchImpl });
    assert.equal(code, 2, JSON.stringify(argv));
    assert.equal(reportOf(out).verdict, 'INPUT_REFUSED');
    assert.equal(store.calls.length, 0);
  }
});

test('a signing key or credential in the environment never reaches the store', async () => {
  const { privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const saved = { ...process.env };
  process.env.UCP_AGENT_SIGNING_PRIVATE_KEY = privateKey.export({ format: 'pem', type: 'pkcs8' });
  process.env.UCP_AGENT_SIGNING_KEY_ID = 'probe-test-kid';
  process.env.UCP_AGENT_CREDENTIAL = 'credential-marker';
  try {
    const store = fakeStore();
    const out = sink();
    await probe.main(['--store', STORE, '--query', 'toner'], { env: ENV, stdout: out, fetchImpl: store.fetchImpl });
    const r = reportOf(out);
    assert.equal(r.tier.tier, 'anonymous');
    assertAnonymous(store.calls);
    assert.ok(!JSON.stringify(store.calls).includes('credential-marker'));
    assert.ok(!out.text().includes('credential-marker'));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('a client that reports any tier but anonymous is refused before any request', async () => {
  const { createUcpBuyerAgentClient } = require('../src/services/ucpBuyerAgentClient');
  const reports = [
    { tier: 'signed' }, { signs_requests: true }, { has_credential: true }, { has_client_credentials: true },
  ];
  for (const override of reports) {
    const store = fakeStore();
    const createClient = (opts) => {
      const real = createUcpBuyerAgentClient(opts);
      return { ...real, describeTier: () => ({ ...real.describeTier(), ...override }) };
    };
    const out = sink();
    const code = await probe.main(['--store', STORE, '--query', 'toner'], { env: ENV, stdout: out, fetchImpl: store.fetchImpl, createClient });
    assert.equal(code, 0);
    const r = reportOf(out);
    assert.equal(r.stopped_at, 'tier', JSON.stringify(override));
    assert.equal(r.steps.tier.reason, 'credential_tier_refused');
    assert.equal(store.calls.length, 0);
  }
});

test('profile summary: handler names, unsafe names, version overlap', () => {
  const s = probe.summarizeProfile(profile({ handlers: { 'com.example.tokens': [{}], 'bad name<script>': [{}] } }), API_HOST);
  assert.equal(s.payment_handler_count, 2);
  assert.deepEqual(s.payment_handlers, ['com.example.tokens', 'other']);
  const both = probe.summarizeProfile({ ucp: { version: '2026-08-25', supported_versions: ['2026-04-08'] } }, API_HOST);
  assert.equal(both.version_overlap, true);
  const none = probe.summarizeProfile({ ucp: {} }, API_HOST);
  assert.equal(none.version_overlap, null);
});

test('id shapes', () => {
  assert.equal(probe.idShape('gid://cafe24/Product/123'), 'gid');
  assert.equal(probe.idShape('123'), 'numeric');
  assert.equal(probe.idShape('P000ABC'), 'other');
  assert.equal(probe.idShape(''), 'none');
});
