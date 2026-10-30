'use strict';

// A caller-limit slot is released when the MCP dispatch throws BEFORE the adapter answers, on both doors.
//
// tests/mcp_caller_limits_slot_release.node.test.cjs ends a dispatch every way the adapter's ANSWER can end
// it. The adapter itself never throws (it maps every fault to a JSON-RPC error), so the one way a dispatch
// throws before an answer exists is the adapter failing to build: the commerce kernel refuses to start
// without a durable store when strict checkout is on (buildCommerceKernelDb), the build's rejected promise is
// cached, and every tools/call on both doors then throws inside the door's try and answers 503
// mcp_unavailable. A release placed after the adapter returns (rather than in the finally) never runs there,
// and with a concurrency cap of 1 the caller would be refused with 429 from its second call on.
//
// Its own file because the failed build is cached for the life of the process. NODE_ENV is 'test' while the
// server loads (so nothing at boot differs from the other route suites) and is switched off 'test' only for
// the lazy kernel build, which is what makes the in-memory store unavailable.
//
// Only network edges are stubbed (introspection and the backend, via nock on .invalid hosts); real network is
// disabled except loopback.

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const INTROSPECT_BASE = 'https://auth.caller-limits-build.invalid';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const BACKEND_BASE = 'http://backend.caller-limits-build.invalid';
const SELF_BASE = 'http://self.caller-limits-build.invalid';
const LB = '192.0.2.10';
const KEY_PARTNER = `ak_live_${'c'.repeat(64)}`;
const PARTNER_AGENT = 'agent_build_partner';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.AGENT_CHECKOUT_STRICT = '1';
delete process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT;
delete process.env.JEST_WORKER_ID;
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
process.env.PUBLIC_READ_MCP_HOSTS = 'mcp.caller-limits-build.invalid';
process.env.PUBLIC_READ_MCP_RPM = '60000';
process.env.PUBLIC_READ_MCP_BURST = '10000';
delete process.env.MCP_OAUTH_ENABLED;
delete process.env.DATABASE_URL;
delete process.env.GATEWAY_RATE_LIMIT_ENABLED;
for (const prefix of ['COMMERCE_MCP', 'PUBLIC_READ_MCP']) {
  for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`${prefix}_HEARTBEAT_${suffix}`];
}

const app = require('../src/server');
const logger = require('../src/logger');
const limits = require('../src/guardrails/mcpCallerLimits');

const lines = [];
const failures = [];
const realInfo = logger.info.bind(logger);
const realError = logger.error.bind(logger);
const realWarn = logger.warn.bind(logger);
logger.info = (obj, msg, ...rest) => {
  if (msg === 'mcp tools/call complete') {
    lines.push(obj);
    return undefined;
  }
  return realInfo(obj, msg, ...rest);
};
logger.error = (obj, msg, ...rest) => {
  if (msg === 'Public read MCP route failed' || msg === 'Strict checkout remote MCP route failed') {
    failures.push({ msg, err: obj && obj.err });
    return undefined;
  }
  return realError(obj, msg, ...rest);
};
logger.warn = (obj, msg, ...rest) => (msg === 'mcp caller limit' ? undefined : realWarn(obj, msg, ...rest));

test.before(() => {
  nock.disableNetConnect();
  nock.enableNetConnect(/^(127\.0\.0\.1|\[::1\])(:\d+)?$/);
  nock(INTROSPECT_BASE)
    .persist()
    .post(INTROSPECT_PATH, (body) => body?.api_key === KEY_PARTNER)
    .reply(200, { valid: true, is_active: true, auth_source: 'api_keys', agent_id: PARTNER_AGENT });
  nock(BACKEND_BASE).persist().post(/.*/).reply(200, { status: 'success', offers: [] });
  nock(BACKEND_BASE).persist().get(/.*/).reply(200, { status: 'success', products: [], total: 0 });
  // Off 'test' from here on: the kernel's lazy build now finds no durable store and refuses to start.
  process.env.NODE_ENV = 'development';
});

test.after(() => {
  logger.info = realInfo;
  logger.error = realError;
  logger.warn = realWarn;
  limits.resetProcessCallerLimiterForTest();
  nock.cleanAll();
  nock.enableNetConnect();
  process.env = { ...ORIGINAL_ENV };
});

function setLimits(env) {
  for (const k of Object.keys(process.env)) if (k.startsWith('MCP_CALLER_LIMITS_')) delete process.env[k];
  Object.assign(process.env, {
    MCP_CALLER_LIMITS_MODE: 'enforce',
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
  limits.resetProcessCallerLimiterForTest({});
}

const searchCall = (id) => ({
  jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search_catalog', arguments: { query: `build failure ${id}` } },
});

const DOORS = {
  public_mcp: {
    ip: '203.0.113.151',
    limitsEnv: { MCP_CALLER_LIMITS_ANON_CONCURRENCY: '1' },
    send(body) {
      return supertest(app).post('/public/mcp').set('X-Forwarded-For', `${this.ip}, ${LB}`).send(body);
    },
    callerKey() {
      return limits.resolveDoorCaller({ headers: { 'x-forwarded-for': `${this.ip}, ${LB}` } }).key;
    },
  },
  mcp: {
    ip: '203.0.113.152',
    limitsEnv: { MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '1' },
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

function slotsOf(door) {
  const state = limits.getProcessCallerLimiter().inspect(DOORS[door].callerKey());
  return { inflight: state.local ? state.local.inflight : 0, held: state.held };
}

for (const door of Object.keys(DOORS)) {
  test(`${door}: a dispatch that throws before the adapter answers releases its slot; the next call is admitted`, async () => {
    setLimits(DOORS[door].limitsEnv);
    for (const id of [1, 2, 3]) {
      const failuresBefore = failures.length;
      const linesBefore = lines.length;
      const res = await DOORS[door].send(searchCall(id));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(res.status, 503, `call ${id}: admitted, then the dispatch threw (got ${res.status} ${JSON.stringify(res.body)})`);
      assert.deepEqual(res.body, { error: 'mcp_unavailable' }, `call ${id} is the door's own 503, not a caller-limit refusal`);
      assert.equal(failures.length, failuresBefore + 1, `call ${id}: the door caught a throw`);
      assert.match(String(failures[failures.length - 1].err), /durable commerce state/, 'the kernel build is what threw');
      const mine = lines.slice(linesBefore);
      assert.equal(mine.length, 1);
      assert.equal(mine[0].outcome, 'internal_error');
      assert.deepEqual(slotsOf(door), { inflight: 0, held: 0 }, `call ${id}: the slot was released`);
    }
  });
}
