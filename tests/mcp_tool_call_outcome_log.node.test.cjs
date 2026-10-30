'use strict';

// The `mcp tools/call complete` line says WHAT THE DOOR ANSWERED, on every MCP door, through the real routes.
//
// Every tools/call answers HTTP 200 — a failing tool rides inside the JSON-RPC body — so the line is the only
// place a tool failure, a zero-result search or a cache hit can be counted. These cases drive each door end to
// end (the public read tier at /public/mcp and on its branded host, the commerce /mcp door with an OAuth
// connector, an introspected api key and the configured first-party service key, and the UCP-dialect door),
// and read the line the real logger was handed. Only the network edges are stubbed: the loopback search hop
// (`find_products_multi` -> this process's own invoke route) and api-key introspection.

const test = require('node:test');
const assert = require('node:assert/strict');
const nock = require('nock');
const supertest = require('supertest');

const ORIGINAL_ENV = { ...process.env };
const PORT = '3997';
const LOOPBACK = `http://127.0.0.1:${PORT}`;
const ISS = 'https://as.pivota.test';
const RESOURCE = 'https://agent.test.example/mcp';
const INTROSPECT_BASE = 'https://auth.tool-outcome.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const AGENT_KEY = `ak_live_${'e'.repeat(64)}`;
// The configured service key must still have the external key shape; only its value marks it first-party.
const SERVICE_KEY = `ak_live_${'f'.repeat(64)}`;
const PUBLIC_HOST = 'mcp.public-tier.test';

process.env.NODE_ENV = 'test';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.PORT = PORT;
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
delete process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED;
process.env.PIVOTA_API_BASE = 'http://backend.tool-outcome.test';
process.env.PIVOTA_API_KEY = SERVICE_KEY;
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.MCP_OAUTH_ENABLED = '1';
process.env.MCP_OAUTH_RESOURCE = RESOURCE;
process.env.MCP_OAUTH_AUTHORIZATION_SERVERS = ISS;
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
process.env.AGENT_AUTH_INTROSPECT_TIMEOUT_MS = '1200';
// The real auth path: the test bypass would resolve every caller to one fake identity and the tier would be
// meaningless.
process.env.INVOKE_AUTH_BYPASS_IN_TEST = '0';
process.env.PUBLIC_READ_MCP_ENABLED = '1';
process.env.PUBLIC_READ_MCP_HOSTS = PUBLIC_HOST;
process.env.PUBLIC_READ_MCP_RPM = '6000';
process.env.PUBLIC_READ_CACHE_ENABLED = '1';
process.env.COMMERCE_READ_CACHE_ENABLED = '1';
process.env.SELF_INVOKE_TIMEOUT_MS = '6000';
delete process.env.AGENT_CHECKOUT_UPSTREAM_TIMEOUT_MS;
delete process.env.MCP_OAUTH_ISSUERS_JSON;
delete process.env.DATABASE_URL;
for (const prefix of ['COMMERCE_MCP', 'PUBLIC_READ_MCP']) {
  for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`${prefix}_HEARTBEAT_${suffix}`];
}

const app = require('../src/server');
const logger = require('../src/logger');

const captured = [];
const realInfo = logger.info.bind(logger);
logger.info = (obj, msg, ...rest) => {
  if (msg === 'mcp tools/call complete') {
    captured.push(obj);
    return undefined;
  }
  return realInfo(obj, msg, ...rest);
};

test.after(() => {
  logger.info = realInfo;
  nock.cleanAll();
  nock.enableNetConnect();
  process.env = { ...ORIGINAL_ENV };
});

let seq = 0;
function uniqueQuery(label) {
  seq += 1;
  return `tool-outcome-${label}-${process.pid}-${seq}`;
}

const SEARCH_METADATA = {
  primary_lane: 'beauty_discovery_mainline',
  query_source: 'agent_products_search',
  route_health: { fallback_triggered: false },
};

function row(id, extra = {}) {
  return { product_id: id, title: `Row ${id}`, brand: 'Brand', price: 10, currency: 'USD', ...extra };
}

/**
 * Answer the loopback search hop for ONE query with `reply` (an envelope, or a function returning
 * [status, body]). `delayMs` holds the response back to exercise the upstream deadline.
 */
function searchUpstream(query, reply, { delayMs = 0 } = {}) {
  const state = { attempts: 0 };
  let scope = nock(LOOPBACK).post('/agent/shop/v1/invoke', (body) => {
    if (!body || body.operation !== 'find_products_multi') return false;
    return JSON.stringify(body).includes(query);
  });
  if (delayMs > 0) scope = scope.delay(delayMs);
  scope.times(5).reply(() => {
    state.attempts += 1;
    return typeof reply === 'function' ? reply() : [200, reply];
  });
  return state;
}

function introspectAs(agentId) {
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH, (body) => body && body.api_key === AGENT_KEY)
    .matchHeader('X-Internal-Key', 'internal_test_key')
    .reply(200, { valid: true, agent_id: agentId, is_active: true, auth_source: 'api_keys' });
}

async function oauthToken(clientId) {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const pub = await exportJWK(publicKey);
  pub.kid = 'as-1';
  pub.alg = 'RS256';
  process.env.MCP_OAUTH_ISSUERS_JSON = JSON.stringify([{ iss: ISS, jwks: { keys: [pub] }, algs: ['RS256'] }]);
  require('../src/commerceMcpOAuth.js').__resetVerifierCache();
  return new SignJWT({ scope: 'pivota.checkout', token_type: 'access', client_id: clientId })
    .setProtectedHeader({ alg: 'RS256', kid: 'as-1' })
    .setIssuer(ISS).setAudience(RESOURCE).setSubject('buyer-1').setIssuedAt().setExpirationTime('10m')
    .sign(privateKey);
}

const rpcCall = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const AGENT_META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' } };

// Each door as a function (toolName, args) -> supertest request. The UCP door spells search arguments its own way.
const DOORS = {
  public_mcp: {
    door: 'public_mcp', tier: 'public',
    send: (body) => supertest(app).post('/public/mcp').send(body),
    searchArgs: (query) => ({ query }),
  },
  public_branded_host: {
    door: 'public_mcp', tier: 'public',
    send: (body) => supertest(app).post('/mcp').set('Host', PUBLIC_HOST).send(body),
    searchArgs: (query) => ({ query }),
  },
  mcp_api_key: {
    door: 'mcp', tier: 'authenticated', authMode: 'api_key',
    send: (body) => {
      introspectAs('agent_tool_outcome');
      return supertest(app).post('/mcp').set('X-Agent-API-Key', AGENT_KEY).set('X-Forwarded-For', '203.0.113.9').send(body);
    },
    searchArgs: (query) => ({ query }),
  },
  mcp_first_party: {
    door: 'mcp', tier: 'first_party', authMode: 'api_key',
    send: (body) => supertest(app).post('/mcp').set('X-Agent-API-Key', SERVICE_KEY).set('X-Forwarded-For', '203.0.113.9').send(body),
    searchArgs: (query) => ({ query }),
  },
  mcp_oauth: {
    door: 'mcp', tier: 'authenticated', authMode: 'mcp_oauth',
    send: async (body) => {
      const token = await oauthToken('mcpc_tool_outcome');
      return supertest(app).post('/mcp').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', '203.0.113.9').send(body);
    },
    searchArgs: (query) => ({ query }),
  },
  ucp_mcp: {
    door: 'ucp_mcp', tier: 'authenticated', authMode: 'api_key',
    send: (body) => {
      introspectAs('agent_tool_outcome');
      return supertest(app).post('/ucp/mcp').set('X-Agent-API-Key', AGENT_KEY).set('X-Forwarded-For', '203.0.113.9').send(body);
    },
    searchArgs: (query) => ({ meta: AGENT_META, catalog: { query } }),
  },
};

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** Send one tools/call over `doorKey` and return [the JSON-RPC body, the ONE completion line it produced]. */
async function call(doorKey, body) {
  captured.length = 0;
  const res = await DOORS[doorKey].send(body);
  await settle();
  assert.equal(captured.length, 1, `${doorKey}: expected one completion line, got ${captured.length} (HTTP ${res.status})`);
  return [res, captured[0]];
}

function assertDoorFields(doorKey, line, tool) {
  const d = DOORS[doorKey];
  assert.equal(line.door, d.door, `${doorKey}: door`);
  assert.equal(line.tool, tool, `${doorKey}: tool`);
  assert.equal(line.tier, d.tier, `${doorKey}: tier`);
  assert.equal(typeof line.latency_ms, 'number', `${doorKey}: latency_ms`);
  assert.equal(typeof line.degraded, 'boolean', `${doorKey}: degraded is always a boolean`);
  if (d.authMode) assert.equal(line.caller_auth_mode, d.authMode, `${doorKey}: caller_auth_mode`);
}

function isToolError(res) {
  return res.body && res.body.result && res.body.result.isError === true;
}

for (const doorKey of Object.keys(DOORS)) {
  test(`${doorKey}: a successful search logs ok, the row count the caller received, the lane and a cache miss`, async () => {
    const query = uniqueQuery(`ok-${doorKey}`);
    const upstream = searchUpstream(query, {
      status: 'success', success: true, total: 3, metadata: SEARCH_METADATA,
      products: [row('sig_aaa1'), row('sig_aaa2'), row('sig_aaa3')],
    });
    const [res, line] = await call(doorKey, rpcCall('search_catalog', DOORS[doorKey].searchArgs(query)));
    assert.equal(res.status, 200);
    assert.equal(isToolError(res), false, JSON.stringify(res.body).slice(0, 300));
    assert.equal(upstream.attempts, 1);
    assertDoorFields(doorKey, line, 'search_catalog');
    assert.equal(line.status, 200);
    assert.equal(line.outcome, 'ok');
    assert.equal(line.is_error, false);
    assert.equal(line.error_code, null);
    assert.equal(line.error_class, null);
    assert.equal(line.result_count, 3);
    assert.equal(line.cache_hit, false);
    assert.equal(line.lane, 'beauty_discovery_mainline');
    assert.equal(line.lane_source, 'agent_products_search');
    assert.equal(line.degraded, false);
    assert.ok(!JSON.stringify(line).includes(query), 'the query never reaches the line');
  });

  test(`${doorKey}: a repeat of the same search is a cache hit and still reports its lane and count`, async () => {
    const query = uniqueQuery(`hit-${doorKey}`);
    const upstream = searchUpstream(query, {
      status: 'success', success: true, total: 2, metadata: SEARCH_METADATA,
      products: [row('sig_bbb1'), row('sig_bbb2')],
    });
    await call(doorKey, rpcCall('search_catalog', DOORS[doorKey].searchArgs(query)));
    const [res, line] = await call(doorKey, rpcCall('search_catalog', DOORS[doorKey].searchArgs(query), 2));
    assert.equal(isToolError(res), false);
    assert.equal(upstream.attempts, 1, 'the repeat never reached the upstream');
    assertDoorFields(doorKey, line, 'search_catalog');
    assert.equal(line.cache_hit, true);
    assert.equal(line.outcome, 'ok');
    assert.equal(line.result_count, 2);
    assert.equal(line.lane, 'beauty_discovery_mainline');
  });

  test(`${doorKey}: a zero-result search logs result_count 0 and is not an error`, async () => {
    const query = uniqueQuery(`zero-${doorKey}`);
    searchUpstream(query, { status: 'success', success: true, total: 0, products: [], metadata: SEARCH_METADATA });
    const [res, line] = await call(doorKey, rpcCall('search_catalog', DOORS[doorKey].searchArgs(query)));
    assert.equal(isToolError(res), false);
    assertDoorFields(doorKey, line, 'search_catalog');
    assert.equal(line.outcome, 'ok');
    assert.equal(line.is_error, false);
    assert.equal(line.result_count, 0);
  });

  test(`${doorKey}: a failed upstream envelope that still carries rows logs BOTH ok and its rows, marked degraded`, async () => {
    const query = uniqueQuery(`failed-with-hits-${doorKey}`);
    searchUpstream(query, {
      status: 'failed', success: false, total: 0,
      products: [row('sig_ccc1'), row('sig_ccc2')],
    });
    const [res, line] = await call(doorKey, rpcCall('search_catalog', DOORS[doorKey].searchArgs(query)));
    assert.equal(isToolError(res), false);
    assertDoorFields(doorKey, line, 'search_catalog');
    assert.equal(line.outcome, 'ok');
    assert.equal(line.is_error, false);
    assert.equal(line.result_count, 2, 'rows inside a failed envelope are counted, not discarded');
    assert.equal(line.upstream_degraded, true);
    assert.equal(line.upstream_status, 'failed');
    assert.equal(line.degraded, true);
  });

  test(`${doorKey}: an upstream failure logs a tool error with the code the caller saw`, async () => {
    const query = uniqueQuery(`err-${doorKey}`);
    searchUpstream(query, () => [500, { status: 'error', error: { code: 'INTERNAL', message: 'boom' } }]);
    const [res, line] = await call(doorKey, rpcCall('search_catalog', DOORS[doorKey].searchArgs(query)));
    assert.equal(res.status, 200, 'a tool error still answers HTTP 200 — which is why this line exists');
    assert.equal(isToolError(res), true);
    const wireCode = JSON.parse(res.body.result.content[0].text).error.code;
    assertDoorFields(doorKey, line, 'search_catalog');
    assert.equal(line.outcome, 'tool_error');
    assert.equal(line.is_error, true);
    assert.equal(line.error_code, wireCode);
    assert.equal(line.error_class, 'server', 'an upstream failure is ours, not the caller\'s');
    assert.equal(line.cache_hit, false);
    assert.equal(line.upstream_timeout, undefined);
  });

  test(`${doorKey}: an upstream timeout logs a tool error flagged upstream_timeout`, async () => {
    const query = uniqueQuery(`timeout-${doorKey}`);
    searchUpstream(query, { status: 'success', success: true, products: [row('sig_ddd1')] }, { delayMs: 800 });
    process.env.AGENT_CHECKOUT_UPSTREAM_TIMEOUT_MS = '150';
    let res;
    let line;
    try {
      [res, line] = await call(doorKey, rpcCall('search_catalog', DOORS[doorKey].searchArgs(query)));
    } finally {
      delete process.env.AGENT_CHECKOUT_UPSTREAM_TIMEOUT_MS;
    }
    assert.equal(isToolError(res), true, JSON.stringify(res.body).slice(0, 300));
    assertDoorFields(doorKey, line, 'search_catalog');
    assert.equal(line.outcome, 'tool_error');
    assert.equal(line.is_error, true);
    assert.equal(line.error_code, JSON.parse(res.body.result.content[0].text).error.code);
    assert.equal(line.error_class, 'server');
    assert.equal(line.upstream_timeout, true);
    assert.equal(line.degraded, true);
    // The caller is never told about the flag: it is log-only.
    assert.ok(!res.body.result.content[0].text.includes('upstream_timeout'));
  });

  test(`${doorKey}: an unknown tool logs UNKNOWN_TOOL, a client error, under the tool label 'other'`, async () => {
    const [res, line] = await call(doorKey, rpcCall('no_such_tool', {}));
    assert.equal(isToolError(res), true);
    assertDoorFields(doorKey, line, 'other');
    assert.ok(!JSON.stringify(line).includes('no_such_tool'), 'a caller-invented tool name never reaches the line');
    assert.equal(line.outcome, 'tool_error');
    assert.equal(line.error_code, 'UNKNOWN_TOOL');
    assert.equal(line.error_class, 'client');
    assert.equal(line.result_count, undefined);
    assert.equal(line.cache_hit, undefined);
  });
}

test('public tier: result_count is what the caller received AFTER the sourcing filter, not what the lane returned', async () => {
  const query = uniqueQuery('public-filtered');
  searchUpstream(query, {
    status: 'success', success: true, total: 3, metadata: SEARCH_METADATA,
    products: [row('sig_eee1'), row('sig_eee2', { offer_type: 'retailer' }), row('sig_eee3', { offer_type: 'retailer' })],
  });
  const [res, line] = await call('public_mcp', rpcCall('search_catalog', { query }));
  assert.equal(res.body.result.structuredContent.products.length, 1);
  assert.equal(line.result_count, 1);
});

test('a malformed tools/call logs a JSON-RPC error by name', async () => {
  const [res, line] = await call('public_mcp', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: '   ' } });
  assert.equal(res.body.error.code, -32602);
  assert.equal(line.outcome, 'rpc_error');
  assert.equal(line.is_error, true);
  assert.equal(line.error_code, 'JSONRPC_INVALID_PARAMS');
  assert.equal(line.error_class, 'client');
  assert.equal(line.tool, 'other', 'a blank name is not a tool');
});

test('a commerce tools/call without credentials is logged as refused, unauthenticated', async () => {
  captured.length = 0;
  const res = await supertest(app).post('/mcp').send(rpcCall('search_catalog', { query: 'x' }));
  await settle();
  assert.equal(res.status, 401);
  assert.equal(captured.length, 1);
  const [line] = captured;
  assert.equal(line.door, 'mcp');
  assert.equal(line.tier, 'unauthenticated');
  assert.equal(line.outcome, 'refused');
  assert.equal(line.is_error, true);
  assert.equal(line.error_code, 'HTTP_401');
  assert.equal(line.error_class, 'client');
  assert.equal(line.tool, 'search_catalog', 'a refused call keeps a tool name the gateway advertises');
});

test('a refused call keeps a commerce-only and a UCP-only tool name: each door\'s surface registers its names', async () => {
  for (const [path, name] of [['/mcp', 'get_offers'], ['/ucp/mcp', 'create_checkout']]) {
    captured.length = 0;
    const res = await supertest(app).post(path).send(rpcCall(name, {}));
    await settle();
    assert.equal(res.status, 401, path);
    assert.equal(captured.length, 1, path);
    assert.equal(captured[0].tool, name, path);
  }
});

for (const [doorKey, knob] of [['public_mcp', 'PUBLIC_READ_MCP'], ['mcp_first_party', 'COMMERCE_MCP']]) {
  test(`${doorKey}: a call that outlives the heartbeat delay is logged heartbeat_committed, and still ok`, async () => {
    const query = uniqueQuery(`heartbeat-${doorKey}`);
    searchUpstream(query, { status: 'success', success: true, products: [row('sig_ggg1')], metadata: SEARCH_METADATA },
      { delayMs: 150 });
    process.env[`${knob}_HEARTBEAT_DELAY_MS`] = '1';
    process.env[`${knob}_HEARTBEAT_INTERVAL_MS`] = '20';
    let res;
    let line;
    try {
      [res, line] = await call(doorKey, rpcCall('search_catalog', DOORS[doorKey].searchArgs(query)));
    } finally {
      delete process.env[`${knob}_HEARTBEAT_DELAY_MS`];
      delete process.env[`${knob}_HEARTBEAT_INTERVAL_MS`];
    }
    assert.equal(res.status, 200);
    assert.equal(line.heartbeat_committed, true);
    assert.equal(line.outcome, 'ok');
    assert.equal(line.result_count, 1);
  });
}

test('a refused call naming a tool no surface advertises is labelled other', async () => {
  captured.length = 0;
  const res = await supertest(app).post('/mcp').send(rpcCall('invented tool name; drop table', { query: 'x' }));
  await settle();
  assert.equal(res.status, 401);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].tool, 'other');
  assert.ok(!JSON.stringify(captured[0]).includes('invented'));
});

test('a money op refused by its kill-switch is logged as the OPERATION_NOT_ALLOWED tool error it answered', async () => {
  const [res, line] = await call('mcp_first_party', rpcCall('complete_checkout_session', { checkout_session_id: 'cs_1' }));
  assert.equal(isToolError(res), true);
  assert.equal(line.tool, 'complete_checkout_session');
  assert.equal(line.outcome, 'tool_error');
  assert.equal(line.error_code, 'OPERATION_NOT_ALLOWED');
  assert.equal(line.error_class, 'client', 'a policy refusal is not an outage');
});

// The door's own catch: the adapter answered but the door could not write it. Injected at the one seam a
// real route offers, Express's JSON serializer, failing exactly once so the door's 503 still goes out.
async function withJsonWriteFailingOnce(fn) {
  let thrown = false;
  app.set('json replacer', (key, value) => {
    if (!thrown && key === '' && value && value.jsonrpc === '2.0') {
      thrown = true;
      throw new Error('injected serialization failure');
    }
    return value;
  });
  try {
    return await fn();
  } finally {
    app.set('json replacer', undefined);
  }
}

for (const doorKey of ['public_mcp', 'mcp_first_party']) {
  test(`${doorKey}: a door that cannot write the adapter's answer logs internal_error, a server error`, async () => {
    const query = uniqueQuery(`internal-${doorKey}`);
    searchUpstream(query, { status: 'success', success: true, products: [row('sig_fff1')], metadata: SEARCH_METADATA });
    const [res, line] = await withJsonWriteFailingOnce(() =>
      call(doorKey, rpcCall('search_catalog', DOORS[doorKey].searchArgs(query))));
    assert.equal(res.status, 503);
    assert.equal(line.outcome, 'internal_error');
    assert.equal(line.is_error, true);
    assert.equal(line.error_code, 'INTERNAL_ERROR');
    assert.equal(line.error_class, 'server');
    assert.equal(line.tool, 'search_catalog');
  });
}

test('a non-tools/call method logs no completion line', async () => {
  captured.length = 0;
  await supertest(app).post('/public/mcp').send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  await settle();
  assert.equal(captured.length, 0);
});
