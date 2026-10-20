'use strict';

// The per-caller MCP limits through the real server: the public door and the authenticated /mcp door, the
// JSON-RPC refusal on the wire, observe vs enforce, shedding order, a partner untouched by an anonymous
// flood from its own address, the loopback caller header a tool call carries back into this process, and
// the invoke limiter keying on it — including a forged one from outside, which must buy nothing.
//
// Only network edges are stubbed: introspection, the Python backend, and the loopback target (pointed at a
// nock host via SELF_INVOKE_BASE so the header the gateway sends can be read off the wire).

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const INTROSPECT_BASE = 'https://auth.caller-limits.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const BACKEND_BASE = 'http://backend.caller-limits.test';
const SELF_BASE = 'http://self.caller-limits.test';
const LB = '192.0.2.10';
const KEY_PARTNER = `ak_live_${'e'.repeat(64)}`;
const KEY_SERVICE = `ak_live_${'f'.repeat(64)}`;
const KEY_SERVICE_2 = `ak_live_${'9'.repeat(64)}`;

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
process.env.PUBLIC_READ_MCP_HOSTS = 'mcp.example.test';
// Keep the pre-existing per-instance public valve out of the way: these cases are about the new limits.
process.env.PUBLIC_READ_MCP_RPM = '60000';
process.env.PUBLIC_READ_MCP_BURST = '10000';
process.env.GATEWAY_RATE_LIMIT_ENABLED = 'true';
process.env.GATEWAY_RATE_LIMIT_CAPACITY = '10';
process.env.GATEWAY_RATE_LIMIT_REFILL_PER_SEC = '0.1';
delete process.env.GATEWAY_RATE_LIMIT_TRUSTED_PROXY_HOPS;
delete process.env.GATEWAY_RATE_LIMIT_BYPASS_AGENT_IDS;
delete process.env.MCP_OAUTH_ENABLED;
delete process.env.DATABASE_URL;

const app = require('../src/server');
const logger = require('../src/logger');
const limits = require('../src/guardrails/mcpCallerLimits');
const { LOOPBACK_CALLER_HEADER, signLoopbackCaller, verifyLoopbackCaller } = require('../src/guardrails/loopbackCallerAssertion');

const warnings = [];
const realWarn = logger.warn.bind(logger);
logger.warn = (obj, msg, ...rest) => {
  if (msg === 'mcp caller limit') {
    warnings.push(obj);
    return undefined;
  }
  return realWarn(obj, msg, ...rest);
};

const AGENTS = { [KEY_PARTNER]: 'agent_partner', [KEY_SERVICE]: 'agent_svc', [KEY_SERVICE_2]: 'agent_svc_2' };

test.before(() => {
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  nock(INTROSPECT_BASE)
    .persist()
    .post(INTROSPECT_PATH, (body) => Boolean(AGENTS[body?.api_key]))
    .reply(200, (_uri, body) => ({ valid: true, is_active: true, auth_source: 'api_keys', agent_id: AGENTS[body.api_key] }));
  nock(BACKEND_BASE).persist().post(/.*/).reply(200, { status: 'success', offers: [], order: { order_id: 'ord_1', status: 'paid' } });
  nock(BACKEND_BASE).persist().get(/.*/).reply(200, { status: 'success', products: [], total: 0 });
});

test.after(() => {
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
    ...env,
  });
  limits.resetProcessCallerLimiterForTest(limiterOpts || {});
  warnings.length = 0;
}

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
}

// A cheap tools/call: an unknown tool answers at once without touching any upstream, but it is still the
// method the limiter counts.
const CHEAP_CALL = (id) => rpc('tools/call', { name: 'no_such_tool', arguments: {} }, id);

function publicCall(ip, body, target = app) {
  return supertest(target).post('/public/mcp').set('X-Forwarded-For', `${ip}, ${LB}`).send(body);
}

function partnerCall(ip, body, key = KEY_PARTNER, target = app) {
  return supertest(target)
    .post('/mcp')
    .set('X-Agent-API-Key', key)
    .set('Accept', 'application/json, text/event-stream')
    .set('X-Forwarded-For', `${ip}, ${LB}`)
    .send(body);
}

async function statuses(n, send) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(await send(i));
  return out;
}

test('enforce: an anonymous caller past its budget gets a JSON-RPC error with 429 and Retry-After', async () => {
  setLimits({ MCP_CALLER_LIMITS_MODE: 'enforce', MCP_CALLER_LIMITS_ANON_RPM: '3' });
  const ip = '203.0.113.21';
  const res = await statuses(5, (i) => publicCall(ip, CHEAP_CALL(100 + i)));
  assert.deepEqual(res.map((r) => r.status), [200, 200, 200, 429, 429]);
  const refused = res[3];
  assert.ok(Number(refused.headers['retry-after']) >= 1);
  assert.equal(refused.body.jsonrpc, '2.0');
  assert.equal(refused.body.id, 103);
  assert.equal(refused.body.result, undefined, 'never a result on a refusal');
  assert.equal(refused.body.error.code, limits.RPC_CODE_CALLER_LIMITED);
  assert.equal(refused.body.error.data.reason, 'rate');
  assert.equal(refused.body.error.data.tier, 'anonymous');
  // Only tools/call counts: discovery methods still answer.
  const list = await publicCall(ip, rpc('tools/list', undefined, 7));
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.result.tools));
  // Another client behind the same load balancer has its own budget.
  assert.equal((await publicCall('203.0.113.22', CHEAP_CALL(1))).status, 200);
  const rejectLines = warnings.filter((w) => w.action === 'reject');
  assert.equal(rejectLines.length, 2);
  assert.equal(rejectLines[0].door, 'public_mcp');
});

test('observe: the same flood is served in full and every would-be refusal is a WARN line', async () => {
  setLimits({ MCP_CALLER_LIMITS_MODE: 'observe', MCP_CALLER_LIMITS_ANON_RPM: '3' });
  const res = await statuses(6, (i) => publicCall('203.0.113.31', CHEAP_CALL(i)));
  assert.ok(res.every((r) => r.status === 200));
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((w) => w.action === 'would_reject' && w.mode === 'observe' && w.reason === 'rate'));
});

test('off: nothing is counted or logged', async () => {
  setLimits({ MCP_CALLER_LIMITS_MODE: 'off', MCP_CALLER_LIMITS_ANON_RPM: '1' });
  const res = await statuses(4, (i) => publicCall('203.0.113.41', CHEAP_CALL(i)));
  assert.ok(res.every((r) => r.status === 200));
  assert.equal(warnings.length, 0);
});

test('a partner keeps its own budget on /mcp while an anonymous caller at the SAME address is refused', async () => {
  setLimits({ MCP_CALLER_LIMITS_MODE: 'enforce', MCP_CALLER_LIMITS_ANON_RPM: '2', MCP_CALLER_LIMITS_PARTNER_RPM: '3' });
  const ip = '203.0.113.51';
  const anon = await statuses(4, (i) => publicCall(ip, CHEAP_CALL(i)));
  assert.deepEqual(anon.map((r) => r.status), [200, 200, 429, 429]);
  const partner = await statuses(4, (i) => partnerCall(ip, CHEAP_CALL(i)));
  assert.deepEqual(partner.map((r) => r.status), [200, 200, 200, 429]);
  assert.equal(partner[3].body.error.data.tier, 'partner');
  const partnerLine = warnings.find((w) => w.tier === 'partner');
  assert.equal(partnerLine.door, 'mcp');
  assert.equal(partnerLine.caller_agent_id, 'agent_partner');
});

test('shedding: with the DB pool saturated, anonymous gets a fast 503; the partner is still served', async () => {
  setLimits(
    { MCP_CALLER_LIMITS_MODE: 'enforce', MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING: '2', MCP_CALLER_LIMITS_SHED_RETRY_AFTER_S: '7' },
    { poolStats: () => ({ waiting: 5 }) },
  );
  const anon = await publicCall('203.0.113.61', CHEAP_CALL(9));
  assert.equal(anon.status, 503);
  assert.equal(anon.headers['retry-after'], '7');
  assert.equal(anon.body.error.code, limits.RPC_CODE_SERVER_BUSY);
  assert.equal(anon.body.error.data.reason, 'shed');
  assert.equal(anon.body.id, 9);
  const partner = await partnerCall('203.0.113.61', CHEAP_CALL(10));
  assert.equal(partner.status, 200);
});

test('a tool\'s loopback call carries the door\'s caller, signed; first-party and limits-off carry none', async () => {
  const seen = [];
  nock(SELF_BASE)
    .persist()
    .post('/agent/shop/v1/invoke')
    .reply(function reply() {
      seen.push(this.req.headers[LOOPBACK_CALLER_HEADER.toLowerCase()] || null);
      return [200, { status: 'success', products: [], total: 0 }];
    });
  try {
    setLimits({ MCP_CALLER_LIMITS_MODE: 'observe' });
    const search = (n) => rpc('tools/call', { name: 'search_catalog', arguments: { query: `loopback probe ${n}` } }, n);

    await publicCall('203.0.113.71', search(1));
    await partnerCall('203.0.113.72', search(2));
    setLimits({ MCP_CALLER_LIMITS_MODE: 'observe', MCP_CALLER_LIMITS_FIRST_PARTY_AGENT_IDS: 'agent_partner' });
    await partnerCall('203.0.113.72', search(3));
    setLimits({ MCP_CALLER_LIMITS_MODE: 'off' });
    await publicCall('203.0.113.71', search(4));

    assert.equal(seen.length, 4, `each search loops back once (saw ${seen.length})`);
    const asLoopback = (value) => verifyLoopbackCaller({ headers: { [LOOPBACK_CALLER_HEADER.toLowerCase()]: value }, socket: { remoteAddress: '127.0.0.1' } });
    const anonCaller = limits.resolveDoorCaller({ headers: { 'x-forwarded-for': `203.0.113.71, ${LB}` } });
    assert.deepEqual(asLoopback(seen[0]), { tier: 'anonymous', key: anonCaller.key, agent_id: null });
    const partnerAsserted = asLoopback(seen[1]);
    assert.equal(partnerAsserted.tier, 'partner');
    assert.equal(partnerAsserted.agent_id, 'agent_partner');
    assert.equal(seen[2], null, 'first-party keeps its old invoke keying');
    assert.equal(seen[3], null, 'nothing is sent with limits off');
  } finally {
    nock.cleanAll();
    nock(INTROSPECT_BASE)
      .persist()
      .post(INTROSPECT_PATH, (body) => Boolean(AGENTS[body?.api_key]))
      .reply(200, (_uri, body) => ({ valid: true, is_active: true, auth_source: 'api_keys', agent_id: AGENTS[body.api_key] }));
    nock(BACKEND_BASE).persist().post(/.*/).reply(200, { status: 'success', offers: [], order: { order_id: 'ord_1', status: 'paid' } });
    nock(BACKEND_BASE).persist().get(/.*/).reply(200, { status: 'success', products: [], total: 0 });
  }
});

// ---- the invoke limiter on a loopback call ----

function loopbackInvoke(key, headers = {}) {
  let r = supertest(app).post('/agent/shop/v1/invoke').set('X-Agent-API-Key', key);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send({ operation: 'get_order_status', payload: { status: { order_id: 'ord_1' } } });
}

async function admittedBefore429(max, send) {
  for (let i = 0; i < max; i += 1) {
    const res = await send(i);
    if (res.status === 429) return i;
  }
  return null;
}

test('enforce: the invoke limiter keys a loopback call on the asserted caller, not on the shared key', async () => {
  setLimits({ MCP_CALLER_LIMITS_MODE: 'enforce' });
  const signed = (key) => ({ [LOOPBACK_CALLER_HEADER]: signLoopbackCaller({ tier: 'anonymous', key }) });
  // get_order_status uses the base limits: capacity 10 per bucket.
  assert.equal(await admittedBefore429(30, () => loopbackInvoke(KEY_SERVICE, signed('anonymous:caller_one'))), 10);
  assert.equal(
    await admittedBefore429(30, () => loopbackInvoke(KEY_SERVICE, signed('anonymous:caller_two'))),
    10,
    'a second MCP caller is not starved by the first, though both arrive on the same service key',
  );
  assert.equal(
    await admittedBefore429(30, () => loopbackInvoke(KEY_SERVICE)),
    10,
    'the service key\'s own users keep their own full bucket',
  );
});

test('a forged loopback header buys nothing: wrong signature, or a valid one arriving from outside', async () => {
  setLimits({ MCP_CALLER_LIMITS_MODE: 'enforce' });
  assert.equal(await admittedBefore429(30, () => loopbackInvoke(KEY_SERVICE_2)), 10);
  const valid = signLoopbackCaller({ tier: 'partner', key: 'partner:fresh_bucket' });
  const [v, payload, sig] = valid.split('.');
  const forged = `${v}.${payload}.${sig.slice(0, -4)}AAAA`;
  // The key's bucket is spent; a header that verified would have opened a fresh one.
  assert.equal((await loopbackInvoke(KEY_SERVICE_2, { [LOOPBACK_CALLER_HEADER]: forged })).status, 429);
  assert.equal(
    (await loopbackInvoke(KEY_SERVICE_2, { [LOOPBACK_CALLER_HEADER]: valid, 'X-Forwarded-For': `203.0.113.81, ${LB}` })).status,
    429,
    'a request routed in from outside cannot use even a genuine value',
  );
  // The genuine value over loopback does open the asserted bucket (the control for the two cases above).
  assert.equal((await loopbackInvoke(KEY_SERVICE_2, { [LOOPBACK_CALLER_HEADER]: valid })).status, 200);
});

test('observe: the invoke limiter keeps its old keying even for a genuine loopback header', async () => {
  setLimits({ MCP_CALLER_LIMITS_MODE: 'observe' });
  const KEY = `ak_live_${'8'.repeat(64)}`;
  AGENTS[KEY] = 'agent_svc_3';
  assert.equal(await admittedBefore429(30, () => loopbackInvoke(KEY)), 10);
  const valid = signLoopbackCaller({ tier: 'anonymous', key: 'anonymous:observe_bucket' });
  assert.equal((await loopbackInvoke(KEY, { [LOOPBACK_CALLER_HEADER]: valid })).status, 429);
});

test('concurrency at the door: a request while the caller\'s slow one is in flight is refused; the slot frees on finish', async () => {
  nock(SELF_BASE).post('/agent/shop/v1/invoke').delay(400).reply(200, { status: 'success', products: [], total: 0 });
  try {
    setLimits({ MCP_CALLER_LIMITS_MODE: 'enforce', MCP_CALLER_LIMITS_ANON_CONCURRENCY: '1' });
    const ip = '203.0.113.91';
    const slow = publicCall(ip, rpc('tools/call', { name: 'search_catalog', arguments: { query: 'concurrency probe slow' } }, 1));
    const slowDone = new Promise((resolve, reject) => slow.end((err, res) => (err ? reject(err) : resolve(res))));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await publicCall(ip, CHEAP_CALL(2));
    assert.equal(second.status, 429);
    assert.equal(second.body.error.data.reason, 'concurrency');
    assert.equal((await publicCall('203.0.113.92', CHEAP_CALL(3))).status, 200, 'another caller is unaffected');
    assert.equal((await slowDone).status, 200);
    // Released on finish: sequential calls from the same caller are never refused by the concurrency cap.
    const after = await statuses(3, (i) => publicCall(ip, CHEAP_CALL(10 + i)));
    assert.deepEqual(after.map((r) => r.status), [200, 200, 200]);
  } finally {
    nock.cleanAll();
    nock(INTROSPECT_BASE)
      .persist()
      .post(INTROSPECT_PATH, (body) => Boolean(AGENTS[body?.api_key]))
      .reply(200, (_uri, body) => ({ valid: true, is_active: true, auth_source: 'api_keys', agent_id: AGENTS[body.api_key] }));
    nock(BACKEND_BASE).persist().post(/.*/).reply(200, { status: 'success', offers: [], order: { order_id: 'ord_1', status: 'paid' } });
    nock(BACKEND_BASE).persist().get(/.*/).reply(200, { status: 'success', products: [], total: 0 });
  }
});

test('enforce: the invoke bypass list applies to a loopback call by the agent the door verified, never to anonymous', async () => {
  setLimits({ MCP_CALLER_LIMITS_MODE: 'enforce' });
  process.env.GATEWAY_RATE_LIMIT_BYPASS_AGENT_IDS = 'agent_lifted';
  try {
    const KEY = `ak_live_${'7'.repeat(64)}`;
    AGENTS[KEY] = 'agent_svc_4';
    const partner = { [LOOPBACK_CALLER_HEADER]: signLoopbackCaller({ tier: 'partner', key: 'partner:lifted', agentId: 'agent_lifted' }) };
    assert.equal(await admittedBefore429(25, () => loopbackInvoke(KEY, partner)), null, 'a lifted partner is not invoke-limited');
    const anon = { [LOOPBACK_CALLER_HEADER]: signLoopbackCaller({ tier: 'anonymous', key: 'anonymous:not_lifted' }) };
    assert.equal(await admittedBefore429(25, () => loopbackInvoke(KEY, anon)), 10);
  } finally {
    delete process.env.GATEWAY_RATE_LIMIT_BYPASS_AGENT_IDS;
  }
});

// ---- review round 2: in-flight is the dispatch, not the response ----

function restoreNocks() {
  nock.cleanAll();
  nock(INTROSPECT_BASE)
    .persist()
    .post(INTROSPECT_PATH, (body) => Boolean(AGENTS[body?.api_key]))
    .reply(200, (_uri, body) => ({ valid: true, is_active: true, auth_source: 'api_keys', agent_id: AGENTS[body.api_key] }));
  nock(BACKEND_BASE).persist().post(/.*/).reply(200, { status: 'success', offers: [], order: { order_id: 'ord_1', status: 'paid' } });
  nock(BACKEND_BASE).persist().get(/.*/).reply(200, { status: 'success', products: [], total: 0 });
}

// Sends `test`, and destroys the client side of it after `ms`. Resolves when the client gave up.
function sendThenAbort(req, ms) {
  return new Promise((resolve) => {
    req.on('error', () => resolve());
    req.end(() => resolve());
    setTimeout(() => {
      try {
        req.abort();
      } catch (_) {
        // already done
      }
      resolve();
    }, ms);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An aborted supertest request never reaches the callback that closes supertest's own ephemeral server, so
// the abort cases run against one server this file closes itself (connections included).
async function withServer(fn) {
  const http = require('http');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(server);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

test('a client that disconnects BEFORE admission (slow auth) is never admitted, so no slot leaks', async () => {
  const KEY = `ak_live_${'6'.repeat(64)}`;
  AGENTS[KEY] = 'agent_slow_auth';
  nock.cleanAll();
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH, (body) => body?.api_key === KEY)
    .times(2)
    .delay(300)
    .reply(200, { valid: false });
  nock(INTROSPECT_BASE)
    .persist()
    .post(INTROSPECT_PATH, (body) => Boolean(AGENTS[body?.api_key]))
    .reply(200, (_uri, body) => ({ valid: true, is_active: true, auth_source: 'api_keys', agent_id: AGENTS[body.api_key] }));
  nock(BACKEND_BASE).persist().post(/.*/).reply(200, { status: 'success', offers: [] });
  try {
    setLimits({ MCP_CALLER_LIMITS_MODE: 'enforce', MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '1' });
    // The first two introspections are slow (and say invalid), so the two aborted requests are refused at
    // auth; replace them with ones that WOULD authenticate once the slow window has passed.
    nock.cleanAll();
    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH, (body) => body?.api_key === KEY)
      .times(2)
      .delay(300)
      .reply(200, { valid: true, is_active: true, auth_source: 'api_keys', agent_id: 'agent_slow_auth' });
    nock(BACKEND_BASE).persist().post(/.*/).reply(200, { status: 'success', offers: [] });
    let loopbacks = 0;
    nock(SELF_BASE).persist().post('/agent/shop/v1/invoke').reply(() => {
      loopbacks += 1;
      return [200, { status: 'success', products: [], total: 0 }];
    });
    const search = (n) => rpc('tools/call', { name: 'search_catalog', arguments: { query: `gone before admission ${n}` } }, n);
    await withServer(async (server) => {
      await sendThenAbort(partnerCall('203.0.113.101', search(1), KEY, server), 50);
      await sendThenAbort(partnerCall('203.0.113.101', search(2), KEY, server), 50);
      await sleep(500); // both handlers finish their slow auth and reach admission with the client gone
    });
    assert.equal(loopbacks, 0, 'no tool work is dispatched for a client that already left');
    const who = limits.resolveDoorCaller({
      invokeAuth: { auth_mode: 'api_key', agent_id: 'agent_slow_auth', introspect_auth_source: 'api_keys' },
    });
    const state = limits.getProcessCallerLimiter().inspect(who.key);
    assert.equal(state.local ? state.local.inflight : 0, 0, 'nothing is held for clients that left');
    assert.equal(state.held, 0);
    restoreNocks();
    const after = await statuses(2, (i) => partnerCall('203.0.113.101', CHEAP_CALL(10 + i), KEY));
    assert.deepEqual(after.map((r) => r.status), [200, 200], 'later good requests are not refused');
  } finally {
    restoreNocks();
  }
});

test('a client that disconnects MID-dispatch keeps its slot until the work finishes, then frees it', async () => {
  nock(SELF_BASE).post('/agent/shop/v1/invoke').delay(500).reply(200, { status: 'success', products: [], total: 0 });
  try {
    setLimits({ MCP_CALLER_LIMITS_MODE: 'enforce', MCP_CALLER_LIMITS_ANON_CONCURRENCY: '1' });
    const ip = '203.0.113.102';
    await withServer(async (server) => {
      await sendThenAbort(
        publicCall(ip, rpc('tools/call', { name: 'search_catalog', arguments: { query: 'abort mid dispatch' } }, 1), server),
        100,
      );
      await sleep(50);
      const during = await publicCall(ip, CHEAP_CALL(2));
      assert.equal(during.status, 429, 'the abandoned search is still running, so the slot is still held');
      assert.equal(during.body.error.data.reason, 'concurrency');
      await sleep(600);
    });
    assert.equal((await publicCall(ip, CHEAP_CALL(3))).status, 200, 'released when the dispatch finished');
    const who = limits.resolveDoorCaller({ headers: { 'x-forwarded-for': `${ip}, ${LB}` } });
    assert.equal(limits.getProcessCallerLimiter().inspect(who.key).local.inflight, 0);
  } finally {
    restoreNocks();
  }
});

test('enforce: fan-out sub-calls are keyed on their ONE tool call, not on the caller', async () => {
  setLimits({ MCP_CALLER_LIMITS_MODE: 'enforce' });
  const KEY = `ak_live_${'5'.repeat(64)}`;
  AGENTS[KEY] = 'agent_svc_5';
  const sub = (callId) => ({
    [LOOPBACK_CALLER_HEADER]: signLoopbackCaller({ tier: 'partner', key: 'partner:fanout_caller', callId }),
  });
  assert.equal(await admittedBefore429(25, () => loopbackInvoke(KEY, sub('call-a'))), 10);
  assert.equal(await admittedBefore429(25, () => loopbackInvoke(KEY, sub('call-b'))), 10, 'a new tool call, a new bucket');
  assert.equal(
    await admittedBefore429(25, () => loopbackInvoke(KEY, { [LOOPBACK_CALLER_HEADER]: signLoopbackCaller({ tier: 'partner', key: 'partner:fanout_caller' }) })),
    10,
    'the caller\'s own (non-fan-out) bucket was untouched by its fan-out',
  );
});

test('no client address appears in ANY log line the gateway writes for these doors (IPv4 and IPv6)', async () => {
  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  const written = [];
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const saved = {};
  for (const level of levels) {
    saved[level] = logger[level];
    logger[level] = function capture(obj, msg, ...rest) {
      written.push(JSON.stringify([obj, msg]));
      return saved[level].call(this, obj, msg, ...rest);
    };
  }
  process.stdout.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return realStdout(chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return realStderr(chunk, ...rest);
  };
  const v4 = '198.51.100.123';
  const v6 = '2001:db8:77:66:55:44:33:22';
  try {
    for (const mode of ['observe', 'enforce']) {
      setLimits({ MCP_CALLER_LIMITS_MODE: mode, MCP_CALLER_LIMITS_ANON_RPM: '1', MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING: '0' });
      for (const ip of [v4, v6]) {
        await statuses(3, (i) => publicCall(ip, CHEAP_CALL(i)));
        await publicCall(ip, rpc('tools/list', undefined, 9));
      }
    }
  } finally {
    for (const level of levels) logger[level] = saved[level];
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
  }
  const all = written.join('\n');
  assert.ok(all.includes('mcp caller limit'), 'the refusal lines were captured');
  for (const needle of [v4, v6, '2001:db8:77:66']) {
    assert.ok(!all.includes(needle), `${needle} must never be logged`);
  }
  assert.ok(all.includes('198.51.100.0/24'));
  assert.ok(all.includes('2001:db8:77::/48'));
});

test('recommend_products price checks are marked fan-out: keyed on the one tool call, not the caller', () => {
  const prior = process.env.MCP_CALLER_LIMITS_MODE;
  process.env.MCP_CALLER_LIMITS_MODE = 'enforce';
  try {
    const ctx = { limit_caller: { tier: 'partner', key: 'partner:abc', agent_id: 'agent_partner', call_id: 'call-77' } };
    const headers = app._debug.recommendPriceVerifyLoopbackHeaders(ctx);
    const asserted = verifyLoopbackCaller({
      headers: { [LOOPBACK_CALLER_HEADER.toLowerCase()]: headers[LOOPBACK_CALLER_HEADER] },
      socket: { remoteAddress: '127.0.0.1' },
    });
    assert.equal(asserted.call_id, 'call-77');
    assert.equal(asserted.key, 'partner:abc');
  } finally {
    if (prior === undefined) delete process.env.MCP_CALLER_LIMITS_MODE;
    else process.env.MCP_CALLER_LIMITS_MODE = prior;
  }
});
