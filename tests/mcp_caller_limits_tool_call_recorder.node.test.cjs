'use strict';

// The per-caller limit refusal on the COMMERCE MCP door, with the tools/call outcome recorder wired in.
//
// Both land in the same few lines of serveCommerceMcpJsonRpc: the recorder (src/observability/mcpToolCallOutcome.js)
// wraps the adapter request and reports what the door answered, and the caller-limit admission
// (src/guardrails/mcpCallerLimits.js) must refuse BEFORE the edge heartbeat exists and release its slot in a
// finally. These cases pin the combination through the real route:
//
//   * a refusal keeps its own status (429 for the caller's budget, 503 for shedding) and Retry-After;
//   * no heartbeat is even constructed for a refused request, so none can commit a 200 over the refusal;
//   * an admitted call's slot is released when its dispatch ends (the in-flight count returns to zero);
//   * the recorder logs the refusal exactly once, as #2472's contract classifies a status written before
//     dispatch: 4xx -> outcome 'refused' (client), 5xx -> outcome 'internal_error' (server), error_code HTTP_<status>;
//   * an admitted call still reaches the recorder through the adapter's observer (UNKNOWN_TOOL, not the
//     UNEXPECTED_ERROR the recorder falls back to when nothing was observed).
//
// Why the heartbeat factory is spied on rather than only read off the wire: admission is synchronous, so a
// heartbeat constructed before it would have its commit timer armed but never reach the timer phase before
// the refusal is written (see tests/commerce_mcp_heartbeat_gate.node.test.cjs for the same limit of a
// route-level test). The wire assertions below are therefore a regression lock; the construction count is
// the proof.
//
// Only network edges are stubbed (introspection, the backend, and the loopback search hop, all via nock on
// .invalid hosts); real network is disabled except loopback.

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const INTROSPECT_BASE = 'https://auth.caller-limits-recorder.invalid';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const BACKEND_BASE = 'http://backend.caller-limits-recorder.invalid';
const SELF_BASE = 'http://self.caller-limits-recorder.invalid';
const LB = '192.0.2.10';
const KEY_PARTNER = `ak_live_${'e'.repeat(64)}`;
const PARTNER_AGENT = 'agent_recorder_partner';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.PIVOTA_API_KEY = 'gateway-service-key';
process.env.PIVOTA_API_BASE = BACKEND_BASE;
process.env.SELF_INVOKE_BASE = SELF_BASE;
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
process.env.AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED = 'false';
process.env.INVOKE_AUTH_BYPASS_IN_TEST = '0';
delete process.env.PUBLIC_READ_MCP_ENABLED;
delete process.env.MCP_OAUTH_ENABLED;
delete process.env.DATABASE_URL;
delete process.env.GATEWAY_RATE_LIMIT_ENABLED;
for (const prefix of ['COMMERCE_MCP', 'PUBLIC_READ_MCP']) {
  for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`${prefix}_HEARTBEAT_${suffix}`];
}

// Spy on the heartbeat factory BEFORE the server is loaded: server.js destructures it at require time.
const heartbeatModule = require('../src/services/publicReadMcpHeartbeat');
const realCreateHeartbeat = heartbeatModule.createMcpResponseHeartbeat;
const heartbeats = [];
heartbeatModule.createMcpResponseHeartbeat = (res, opts) => {
  const heartbeat = realCreateHeartbeat(res, opts);
  heartbeats.push({ enabled: opts ? opts.enabled !== false : true, heartbeat });
  return heartbeat;
};

const app = require('../src/server');
const logger = require('../src/logger');
const limits = require('../src/guardrails/mcpCallerLimits');

const lines = [];
const realInfo = logger.info.bind(logger);
logger.info = (obj, msg, ...rest) => {
  if (msg === 'mcp tools/call complete') {
    lines.push(obj);
    return undefined;
  }
  return realInfo(obj, msg, ...rest);
};
const realWarn = logger.warn.bind(logger);
logger.warn = (obj, msg, ...rest) => (msg === 'mcp caller limit' ? undefined : realWarn(obj, msg, ...rest));

function stubEdges() {
  nock.cleanAll();
  nock(INTROSPECT_BASE)
    .persist()
    .post(INTROSPECT_PATH, (body) => body?.api_key === KEY_PARTNER)
    .reply(200, { valid: true, is_active: true, auth_source: 'api_keys', agent_id: PARTNER_AGENT });
  nock(BACKEND_BASE).persist().post(/.*/).reply(200, { status: 'success', offers: [] });
  nock(BACKEND_BASE).persist().get(/.*/).reply(200, { status: 'success', products: [], total: 0 });
}

test.before(() => {
  nock.disableNetConnect();
  nock.enableNetConnect(/^(127\.0\.0\.1|\[::1\])(:\d+)?$/);
  stubEdges();
});

test.after(() => {
  heartbeatModule.createMcpResponseHeartbeat = realCreateHeartbeat;
  logger.info = realInfo;
  logger.warn = realWarn;
  limits.resetProcessCallerLimiterForTest();
  nock.cleanAll();
  nock.enableNetConnect();
  process.env = { ...ORIGINAL_ENV };
});

function setLimits(env, limiterOpts = null) {
  for (const k of Object.keys(process.env)) if (k.startsWith('MCP_CALLER_LIMITS_')) delete process.env[k];
  Object.assign(process.env, {
    MCP_CALLER_LIMITS_STORE: 'local',
    MCP_CALLER_LIMITS_ANON_RPM: '0',
    MCP_CALLER_LIMITS_ANON_CONCURRENCY: '0',
    MCP_CALLER_LIMITS_PARTNER_RPM: '0',
    MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '0',
    MCP_CALLER_LIMITS_ANON_TIER_CONCURRENCY_PER_INSTANCE: '0',
    MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING: '0',
    MCP_CALLER_LIMITS_SHED_PARTNER_POOL_WAITING: '0',
    ...env,
  });
  limits.resetProcessCallerLimiterForTest(limiterOpts || {});
}

const rpcCall = (name, args, id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

function rawParser(res, cb) {
  let raw = '';
  res.on('data', (chunk) => { raw += chunk; });
  res.on('end', () => cb(null, raw));
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** One commerce /mcp tools/call. Returns the response (raw body + parsed JSON), its heartbeats and its completion lines. */
async function commerceCall(body, ip) {
  const heartbeatsBefore = heartbeats.length;
  const linesBefore = lines.length;
  const res = await supertest(app)
    .post('/mcp')
    .set('X-Agent-API-Key', KEY_PARTNER)
    .set('Accept', 'application/json, text/event-stream')
    .set('X-Forwarded-For', `${ip}, ${LB}`)
    .send(body)
    .buffer(true)
    .parse(rawParser);
  await settle();
  return {
    status: res.status,
    headers: res.headers,
    raw: res.body,
    json: JSON.parse(res.body),
    heartbeats: heartbeats.slice(heartbeatsBefore),
    lines: lines.slice(linesBefore),
  };
}

function partnerSlots() {
  const who = limits.resolveDoorCaller({
    invokeAuth: { auth_mode: 'api_key', agent_id: PARTNER_AGENT, introspect_auth_source: 'api_keys' },
  });
  const state = limits.getProcessCallerLimiter().inspect(who.key);
  return { inflight: state.local ? state.local.inflight : 0, held: state.held };
}

// Arms every heartbeat to commit as early as it can, so a heartbeat that existed for a refused request
// would have had every chance to turn it into a 200.
async function withEagerHeartbeat(fn) {
  process.env.COMMERCE_MCP_HEARTBEAT_DELAY_MS = '1';
  process.env.COMMERCE_MCP_HEARTBEAT_INTERVAL_MS = '5';
  try {
    return await fn();
  } finally {
    delete process.env.COMMERCE_MCP_HEARTBEAT_DELAY_MS;
    delete process.env.COMMERCE_MCP_HEARTBEAT_INTERVAL_MS;
  }
}

function assertRefusalOnTheWire(r, { status, rpcCode, reason, id }) {
  assert.equal(r.status, status, `the refusal keeps its own status (got ${r.status})`);
  assert.ok(Number(r.headers['retry-after']) >= 1, 'Retry-After survives');
  assert.doesNotMatch(r.raw, /^\s/, 'no heartbeat whitespace was committed ahead of the refusal');
  assert.equal(r.json.jsonrpc, '2.0');
  assert.equal(r.json.id, id);
  assert.equal(r.json.result, undefined, 'never a result on a refusal');
  assert.equal(r.json.error.code, rpcCode);
  assert.equal(r.json.error.data.reason, reason);
  assert.equal(r.json.error.data.tier, 'partner');
  assert.equal(r.heartbeats.length, 0, 'no heartbeat is constructed for a refused request');
}

function assertOneRefusalLine(r, { status, outcome, errorClass }) {
  assert.equal(r.lines.length, 1, `the refusal is logged exactly once (got ${r.lines.length})`);
  const [line] = r.lines;
  assert.equal(line.door, 'mcp');
  assert.equal(line.tier, 'authenticated');
  assert.equal(line.tool, 'search_catalog', 'a refused call keeps a tool name the gateway advertises');
  assert.equal(line.status, status);
  assert.equal(line.outcome, outcome);
  assert.equal(line.is_error, true);
  assert.equal(line.error_code, `HTTP_${status}`);
  assert.equal(line.error_class, errorClass);
  assert.equal(line.heartbeat_committed, undefined, 'nothing was streamed');
}

test('commerce /mcp: a caller over its budget gets 429 past the recorder; admitted calls release their slot', async () => {
  setLimits({
    MCP_CALLER_LIMITS_MODE: 'enforce',
    MCP_CALLER_LIMITS_PARTNER_RPM: '2',
    MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '1',
  });
  const ip = '203.0.113.121';

  // Two admitted calls. With a concurrency cap of 1, the second is admitted only if the first released its slot.
  for (const id of [1, 2]) {
    const r = await commerceCall(rpcCall('no_such_tool', {}, id), ip);
    assert.equal(r.status, 200, `admitted call ${id}`);
    assert.equal(r.json.result.isError, true);
    assert.equal(r.lines.length, 1);
    // The adapter's observer reached the recorder: without it the recorder could only say UNEXPECTED_ERROR.
    assert.equal(r.lines[0].outcome, 'tool_error');
    assert.equal(r.lines[0].error_code, 'UNKNOWN_TOOL');
    assert.equal(r.lines[0].error_class, 'client');
    assert.equal(r.heartbeats.length, 1, 'an admitted tools/call gets its one heartbeat');
    assert.equal(r.heartbeats[0].heartbeat.committed(), false);
    assert.deepEqual(partnerSlots(), { inflight: 0, held: 0 }, `call ${id}'s slot was released`);
  }

  const refused = await withEagerHeartbeat(() => commerceCall(rpcCall('search_catalog', { query: 'over budget' }, 3), ip));
  assertRefusalOnTheWire(refused, { status: 429, rpcCode: limits.RPC_CODE_CALLER_LIMITED, reason: 'rate', id: 3 });
  assertOneRefusalLine(refused, { status: 429, outcome: 'refused', errorClass: 'client' });
  assert.deepEqual(partnerSlots(), { inflight: 0, held: 0 }, 'a refusal holds nothing');
});

test('commerce /mcp: a concurrency 429 while a slow call is in flight; that call\'s slot frees when it finishes', async () => {
  nock(SELF_BASE).post('/agent/shop/v1/invoke').delay(400).reply(200, { status: 'success', products: [], total: 0 });
  try {
    setLimits({ MCP_CALLER_LIMITS_MODE: 'enforce', MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '1' });
    const ip = '203.0.113.122';
    const slow = commerceCall(rpcCall('search_catalog', { query: 'slow in flight' }, 1), ip);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(partnerSlots().inflight, 1, 'the slow call holds its slot');

    const refused = await withEagerHeartbeat(() => commerceCall(rpcCall('search_catalog', { query: 'second' }, 2), ip));
    assertRefusalOnTheWire(refused, { status: 429, rpcCode: limits.RPC_CODE_CALLER_LIMITED, reason: 'concurrency', id: 2 });
    assertOneRefusalLine(refused, { status: 429, outcome: 'refused', errorClass: 'client' });

    const done = await slow;
    assert.equal(done.status, 200);
    assert.equal(done.lines.filter((l) => l.status === 200).length, 1, 'the slow call is logged once, as itself');
    assert.deepEqual(partnerSlots(), { inflight: 0, held: 0 }, 'released when the dispatch finished');
    const after = await commerceCall(rpcCall('no_such_tool', {}, 3), ip);
    assert.equal(after.status, 200, 'the caller is admitted again');
  } finally {
    stubEdges();
  }
});

test('commerce /mcp: shedding answers 503 past the recorder, with no heartbeat, logged once as a server-side refusal', async () => {
  setLimits(
    {
      MCP_CALLER_LIMITS_MODE: 'enforce',
      MCP_CALLER_LIMITS_SHED_PARTNER_POOL_WAITING: '2',
      MCP_CALLER_LIMITS_SHED_RETRY_AFTER_S: '7',
    },
    { poolStats: () => ({ waiting: 5 }) },
  );
  const refused = await withEagerHeartbeat(() => commerceCall(rpcCall('search_catalog', { query: 'shed' }, 9), '203.0.113.123'));
  assertRefusalOnTheWire(refused, { status: 503, rpcCode: limits.RPC_CODE_SERVER_BUSY, reason: 'shed', id: 9 });
  assert.equal(refused.headers['retry-after'], '7');
  // #2472's recorder classifies any 5xx written before dispatch as internal_error / server.
  assertOneRefusalLine(refused, { status: 503, outcome: 'internal_error', errorClass: 'server' });
  assert.deepEqual(partnerSlots(), { inflight: 0, held: 0 });
});
