'use strict';

// A caller-limit slot is released on EVERY way a tool dispatch can end, on BOTH MCP doors.
//
// The doors (handlePublicReadMcp / runPublicReadMcpDispatch and serveCommerceMcpJsonRpc in src/server.js) hold
// one in-flight slot per admitted tools/call and release it in a finally around the dispatch. A dispatch ends
// in one of four ways, and only the first is covered by the route suites:
//
//   buffered answer      the adapter answered before the heartbeat delay; the door writes the response itself;
//   heartbeat-committed  the call outlived the heartbeat delay, so 200 and leading whitespace were already on
//                        the wire and heartbeat.finish() writes the body (the door returns without touching res);
//   throw, committed     something in the dispatch threw after the heartbeat committed: heartbeat.fail() writes
//                        a JSON-RPC internal error into the open 200;
//   throw, buffered      something threw before any commit: the door answers 503 mcp_unavailable.
//
// A release placed anywhere but a finally (for example after the buffered write only) leaks the slot on the
// other three, and with a concurrency cap of 1 a leaked slot refuses every later call from that caller with
// 429 until the process restarts. So each case here runs in ENFORCE mode with the caller's concurrency at 1,
// ends one call the way it names, and then requires the NEXT call from the same caller to be admitted, and the
// limiter to hold nothing for it.
//
// The throw is injected at the one seam both write paths share: the JSON serialization of the adapter's
// answer (Express's res.json on the buffered path, the heartbeat's JSON.stringify on the committed one),
// failing exactly once for the one response id under test. Every case asserts the injection fired, so a case
// cannot pass by never reaching its path. That seam sits AFTER the adapter answered; a throw BEFORE any answer
// (the adapter failing to build) is covered by tests/mcp_caller_limits_slot_release_build_failure.node.test.cjs.
//
// Mode off is pinned at the end: with every limit at its tightest, nothing is counted, refused, logged or
// forwarded, and the completion lines are the ones the doors wrote before the limits existed.
//
// Only network edges are stubbed (introspection, the backend and the loopback search hop, via nock on .invalid
// hosts); real network is disabled except loopback.

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const INTROSPECT_BASE = 'https://auth.caller-limits-release.invalid';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const BACKEND_BASE = 'http://backend.caller-limits-release.invalid';
const SELF_BASE = 'http://self.caller-limits-release.invalid';
const LB = '192.0.2.10';
const KEY_PARTNER = `ak_live_${'d'.repeat(64)}`;
const PARTNER_AGENT = 'agent_release_partner';

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
process.env.PUBLIC_READ_MCP_ENABLED = '1';
process.env.PUBLIC_READ_MCP_HOSTS = 'mcp.caller-limits-release.invalid';
// The pre-existing per-instance public valve stays out of the way: these cases are about the caller limits.
process.env.PUBLIC_READ_MCP_RPM = '60000';
process.env.PUBLIC_READ_MCP_BURST = '10000';
delete process.env.PUBLIC_READ_CACHE_ENABLED;
delete process.env.MCP_OAUTH_ENABLED;
delete process.env.DATABASE_URL;
delete process.env.GATEWAY_RATE_LIMIT_ENABLED;
for (const prefix of ['COMMERCE_MCP', 'PUBLIC_READ_MCP']) {
  for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`${prefix}_HEARTBEAT_${suffix}`];
}

const app = require('../src/server');
const logger = require('../src/logger');
const limits = require('../src/guardrails/mcpCallerLimits');
const { LOOPBACK_CALLER_HEADER } = require('../src/guardrails/loopbackCallerAssertion');

const lines = [];
const warnings = [];
const realInfo = logger.info.bind(logger);
const realWarn = logger.warn.bind(logger);
logger.info = (obj, msg, ...rest) => {
  if (msg === 'mcp tools/call complete') {
    lines.push(obj);
    return undefined;
  }
  return realInfo(obj, msg, ...rest);
};
logger.warn = (obj, msg, ...rest) => {
  if (msg === 'mcp caller limit') {
    warnings.push(obj);
    return undefined;
  }
  return realWarn(obj, msg, ...rest);
};

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
  warnings.length = 0;
}

const rpcCall = (name, args, id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
// Answers at once without an upstream, but it is still the method the limiter counts.
const cheapCall = (id) => rpcCall('no_such_tool', {}, id);
let seq = 0;
const slowSearch = (id) => {
  seq += 1;
  return rpcCall('search_catalog', { query: `slot release probe ${process.pid} ${seq}` }, id);
};

function rawParser(res, cb) {
  let raw = '';
  res.on('data', (chunk) => { raw += chunk; });
  res.on('end', () => cb(null, raw));
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// The two doors, each as: how to send one tools/call from ONE caller, and how to read that caller's slots.
const DOORS = {
  public_mcp: {
    ip: '203.0.113.141',
    limitsEnv: { MCP_CALLER_LIMITS_ANON_CONCURRENCY: '1' },
    heartbeatPrefix: 'PUBLIC_READ_MCP',
    send(body) {
      return supertest(app).post('/public/mcp').set('X-Forwarded-For', `${this.ip}, ${LB}`).send(body);
    },
    callerKey() {
      return limits.resolveDoorCaller({ headers: { 'x-forwarded-for': `${this.ip}, ${LB}` } }).key;
    },
  },
  mcp: {
    ip: '203.0.113.142',
    limitsEnv: { MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '1' },
    heartbeatPrefix: 'COMMERCE_MCP',
    send(body) {
      return supertest(app)
        .post('/mcp')
        .set('X-Agent-API-Key', KEY_PARTNER)
        .set('Accept', 'application/json, text/event-stream')
        .set('X-Forwarded-For', `${this.ip}, ${LB}`)
        .send(body);
    },
    callerKey() {
      return limits.resolveDoorCaller({
        invokeAuth: { auth_mode: 'api_key', agent_id: PARTNER_AGENT, introspect_auth_source: 'api_keys' },
      }).key;
    },
  },
};

async function call(door, body) {
  const linesBefore = lines.length;
  const res = await DOORS[door].send(body).buffer(true).parse(rawParser);
  await settle();
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch (_) {
    json = null;
  }
  return { status: res.status, raw: res.body, json, lines: lines.slice(linesBefore) };
}

function slotsOf(door) {
  const state = limits.getProcessCallerLimiter().inspect(DOORS[door].callerKey());
  return { inflight: state.local ? state.local.inflight : 0, held: state.held };
}

// Every heartbeat commits as early as it can, and the loopback search hop answers well after that.
async function withCommittingHeartbeat(door, fn) {
  const prefix = DOORS[door].heartbeatPrefix;
  process.env[`${prefix}_HEARTBEAT_DELAY_MS`] = '1';
  process.env[`${prefix}_HEARTBEAT_INTERVAL_MS`] = '20';
  nock(SELF_BASE).post('/agent/shop/v1/invoke').delay(250).reply(200, { status: 'success', products: [], total: 0 });
  try {
    return await fn();
  } finally {
    delete process.env[`${prefix}_HEARTBEAT_DELAY_MS`];
    delete process.env[`${prefix}_HEARTBEAT_INTERVAL_MS`];
    stubEdges();
  }
}

// The door's write of the adapter's answer throws, once, for response `id` only.
async function withAnswerSerializationFailingOnce(id, fn) {
  const realStringify = JSON.stringify;
  const state = { thrown: false };
  JSON.stringify = function failingOnce(value, ...rest) {
    if (
      !state.thrown
      && value !== null
      && typeof value === 'object'
      && value.jsonrpc === '2.0'
      && value.id === id
      && Object.prototype.hasOwnProperty.call(value, 'result')
    ) {
      state.thrown = true;
      throw new Error('injected serialization failure');
    }
    return realStringify.call(this, value, ...rest);
  };
  try {
    const out = await fn();
    return { ...out, injected: state.thrown };
  } finally {
    JSON.stringify = realStringify;
  }
}

// The caller's NEXT call must be admitted, and nothing may be held for it.
async function assertSlotFreed(door, label) {
  assert.deepEqual(slotsOf(door), { inflight: 0, held: 0 }, `${label}: the slot was released`);
  const next = await call(door, cheapCall(900));
  assert.equal(next.status, 200, `${label}: the caller's next call is admitted (got ${next.status}: ${next.raw})`);
  assert.equal(next.json?.result?.isError, true, 'the next call reached the adapter (UNKNOWN_TOOL)');
  assert.equal(warnings.filter((w) => w.action === 'reject').length, 0, `${label}: nothing was refused`);
  assert.deepEqual(slotsOf(door), { inflight: 0, held: 0 });
}

for (const door of Object.keys(DOORS)) {
  test(`${door}: a call the heartbeat commits releases its slot; the caller's next call is admitted`, async () => {
    setLimits({ MCP_CALLER_LIMITS_MODE: 'enforce', ...DOORS[door].limitsEnv });
    const slow = await withCommittingHeartbeat(door, () => call(door, slowSearch(11)));
    assert.equal(slow.status, 200);
    assert.match(slow.raw, /^\s+\{/, 'the heartbeat committed: leading whitespace before the body');
    assert.equal(slow.json.id, 11);
    assert.ok(slow.json.result, 'the committed body is the adapter\'s answer');
    assert.equal(slow.lines.length, 1);
    assert.equal(slow.lines[0].heartbeat_committed, true);
    await assertSlotFreed(door, 'heartbeat-committed');
  });

  test(`${door}: a dispatch that throws after the heartbeat committed releases its slot`, async () => {
    setLimits({ MCP_CALLER_LIMITS_MODE: 'enforce', ...DOORS[door].limitsEnv });
    const failed = await withCommittingHeartbeat(door, () =>
      withAnswerSerializationFailingOnce(21, () => call(door, slowSearch(21))));
    assert.equal(failed.injected, true, 'the injected throw fired');
    assert.equal(failed.status, 200, 'the wire was already committed');
    assert.match(failed.raw, /^\s+\{/);
    assert.equal(failed.json.id, 21);
    assert.equal(failed.json.error.code, -32603, 'the door wrote the internal error into the committed stream');
    assert.equal(failed.lines.length, 1);
    assert.equal(failed.lines[0].outcome, 'internal_error');
    await assertSlotFreed(door, 'throw after commit');
  });

  test(`${door}: a dispatch that throws before any commit answers 503 and releases its slot`, async () => {
    setLimits({ MCP_CALLER_LIMITS_MODE: 'enforce', ...DOORS[door].limitsEnv });
    const failed = await withAnswerSerializationFailingOnce(31, () => call(door, cheapCall(31)));
    assert.equal(failed.injected, true, 'the injected throw fired');
    assert.equal(failed.status, 503);
    assert.deepEqual(failed.json, { error: 'mcp_unavailable' });
    assert.equal(failed.lines.length, 1);
    assert.equal(failed.lines[0].outcome, 'internal_error');
    await assertSlotFreed(door, 'throw before commit');
  });
}

// ---- mode off: identical to the doors before the limits existed ----

test('mode off: every limit at its tightest, on both doors, changes nothing', async () => {
  setLimits(
    {
      MCP_CALLER_LIMITS_MODE: 'off',
      MCP_CALLER_LIMITS_ANON_RPM: '1',
      MCP_CALLER_LIMITS_ANON_CONCURRENCY: '1',
      MCP_CALLER_LIMITS_PARTNER_RPM: '1',
      MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '1',
      MCP_CALLER_LIMITS_ANON_TIER_CONCURRENCY_PER_INSTANCE: '1',
      MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING: '1',
      MCP_CALLER_LIMITS_SHED_PARTNER_POOL_WAITING: '1',
    },
    { poolStats: () => ({ waiting: 99 }) },
  );
  const loopbackHeaders = [];
  for (const door of Object.keys(DOORS)) {
    nock(SELF_BASE)
      .post('/agent/shop/v1/invoke')
      .delay(200)
      .reply(function reply() {
        loopbackHeaders.push(this.req.headers[LOOPBACK_CALLER_HEADER.toLowerCase()]);
        return [200, { status: 'success', products: [], total: 0 }];
      });
    // A slow call in flight, a second one beside it, and a third after: all past a cap of 1 / 1 rpm / shed.
    const slowPending = call(door, slowSearch(41));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const beside = await call(door, cheapCall(42));
    const slow = await slowPending;
    const after = await call(door, cheapCall(43));
    // The slow call's window also saw the call beside it finish; each line is told apart by its tool.
    const own = (r, tool) => r.lines.filter((l) => l.tool === tool);
    for (const [label, r, tool] of [['slow', slow, 'search_catalog'], ['beside', beside, 'other'], ['after', after, 'other']]) {
      assert.equal(r.status, 200, `${door} ${label}: served`);
      assert.equal(r.json.error, undefined, `${door} ${label}: never a JSON-RPC refusal`);
      const mine = own(r, tool);
      assert.equal(mine.length, 1, `${door} ${label}: logged once`);
      assert.ok(['ok', 'tool_error'].includes(mine[0].outcome), `${door} ${label}: ${mine[0].outcome}`);
      assert.equal(mine[0].status, 200);
      if (tool === 'other') assert.equal(mine[0].error_code, 'UNKNOWN_TOOL');
    }
    const state = limits.getProcessCallerLimiter().inspect(DOORS[door].callerKey());
    assert.equal(state.local, null, `${door}: nothing was counted for the caller`);
    assert.equal(state.held, 0);
    stubEdges();
  }
  assert.equal(warnings.length, 0, 'no caller-limit line is written');
  assert.equal(loopbackHeaders.length, 2, 'both slow searches made their loopback hop');
  assert.deepEqual(loopbackHeaders, [undefined, undefined], 'no loopback caller header is sent');
});
