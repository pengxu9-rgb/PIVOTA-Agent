'use strict';

// The per-caller MCP door limiter (src/guardrails/mcpCallerLimits.js) as a unit: who a caller is, which
// bucket it draws from, the order the checks run in, observe vs enforce, the refusal's JSON-RPC shape, and
// the cross-instance accounting through a shared store. Time and the DB pool census are injected, so every
// case is deterministic.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ANON_TIER_KEY,
  RPC_CODE_CALLER_LIMITED,
  RPC_CODE_SERVER_BUSY,
  WINDOW_MS,
  createCallerLimiter,
  createMemoryCallerLimitStore,
  limitRejectionResponse,
  resolveDoorCaller,
} = require('../src/guardrails/mcpCallerLimits');
const { readCallerLimitsConfig } = require('../src/guardrails/mcpCallerLimitsConfig');

const LB = '192.0.2.10';
const T0 = 1_800_000_000_000; // a window boundary (divisible by 60 000)

function baseEnv(extra = {}) {
  return {
    MCP_CALLER_LIMITS_MODE: 'enforce',
    MCP_CALLER_LIMITS_ANON_RPM: '0',
    MCP_CALLER_LIMITS_ANON_CONCURRENCY: '0',
    MCP_CALLER_LIMITS_PARTNER_RPM: '0',
    MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '0',
    MCP_CALLER_LIMITS_ANON_TIER_RPM: '0',
    MCP_CALLER_LIMITS_ANON_TIER_CONCURRENCY_PER_INSTANCE: '0',
    MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING: '0',
    MCP_CALLER_LIMITS_SHED_PARTNER_POOL_WAITING: '0',
    ...extra,
  };
}

function clock(start = T0) {
  const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

function capturingLog() {
  const lines = [];
  return { lines, warn: (obj, msg) => lines.push({ obj, msg }) };
}

function anonReq(ip, extraXff = '') {
  return { headers: { 'x-forwarded-for': `${extraXff}${ip}, ${LB}` }, socket: { remoteAddress: '169.254.1.1' } };
}

function apiKeyReq(agentId, extra = {}) {
  return {
    headers: { 'x-forwarded-for': `203.0.113.5, ${LB}` },
    invokeAuth: {
      auth_mode: 'api_key', agent_id: agentId, key_fingerprint: `fp_${agentId}`, introspect_auth_source: 'api_keys',
      auth_degraded: false, ...extra,
    },
  };
}

function caller(req, env) {
  return resolveDoorCaller(req, { config: readCallerLimitsConfig(env) });
}

// ---------------- identity ----------------

test('identity: a verified api-key agent is a partner keyed on its agent, not on its key or address', () => {
  const env = baseEnv();
  const a = caller(apiKeyReq('agent_x'), env);
  assert.equal(a.tier, 'partner');
  assert.equal(a.id, 'agent:agent_x');
  assert.equal(a.agent_id, 'agent_x');
  // Same agent, another key and another address: same bucket.
  const b = caller({ ...apiKeyReq('agent_x', { key_fingerprint: 'fp_other' }), headers: { 'x-forwarded-for': `198.51.100.7, ${LB}` } }, env);
  assert.equal(b.key, a.key);
  assert.notEqual(caller(apiKeyReq('agent_y'), env).key, a.key);
});

test('identity: a key with no agent keys on its fingerprint; a degraded verdict never merges partners', () => {
  const env = baseEnv();
  assert.equal(caller(apiKeyReq(null), env).id, 'key:fp_null');
  const degradedA = caller(apiKeyReq('agent_emergency_fallback', { auth_degraded: true, key_fingerprint: 'fp_a', introspect_auth_source: 'emergency_fallback' }), env);
  const degradedB = caller(apiKeyReq('agent_emergency_fallback', { auth_degraded: true, key_fingerprint: 'fp_b', introspect_auth_source: 'emergency_fallback' }), env);
  assert.equal(degradedA.tier, 'partner');
  assert.notEqual(degradedA.key, degradedB.key, 'two keys during an introspection outage keep two buckets');
});

test('identity: an MCP OAuth client is a partner keyed on its client id; no client id falls back to the address', () => {
  const env = baseEnv();
  const oauth = (cid, ip) => ({
    headers: { 'x-forwarded-for': `${ip}, ${LB}` },
    invokeAuth: { auth_mode: 'mcp_oauth', oauth_client_id: cid, oauth_issuer: 'https://as.example.test' },
  });
  const c1 = caller(oauth('client_1', '203.0.113.1'), env);
  assert.equal(c1.tier, 'partner');
  assert.equal(c1.id, 'oauth:client_1');
  assert.equal(c1.oauth_client_id, 'client_1');
  assert.equal(caller(oauth('client_1', '203.0.113.2'), env).key, c1.key);
  const anon = caller(oauth(null, '203.0.113.3'), env);
  assert.equal(anon.tier, 'anonymous');
  assert.equal(anon.key, caller(anonReq('203.0.113.3'), env).key);
});

test('identity: anonymous keys on the edge-attested address; a forged left-most X-Forwarded-For does not move it', () => {
  const env = baseEnv();
  const plain = caller(anonReq('203.0.113.9'), env);
  const forged = caller(anonReq('203.0.113.9', '10.0.0.1, 10.0.0.2, '), env);
  assert.equal(plain.tier, 'anonymous');
  assert.equal(forged.key, plain.key);
  assert.notEqual(caller(anonReq('203.0.113.10'), env).key, plain.key);
  // The key is a hash: the address itself never becomes a log field or a stored key.
  assert.ok(!plain.key.includes('203.0.113.9'));
  // Headers that look like credentials choose nothing.
  const withJunk = caller({ ...anonReq('203.0.113.9'), headers: { ...anonReq('203.0.113.9').headers, 'x-agent-api-key': 'ak_junk', authorization: 'Bearer junk' } }, env);
  assert.equal(withJunk.key, plain.key);
});

test('identity: first-party = a listed agent or this platform\'s own service key; the invoke bypass list is not it', () => {
  assert.equal(caller(apiKeyReq('agent_ui'), baseEnv({ MCP_CALLER_LIMITS_FIRST_PARTY_AGENT_IDS: 'x, agent_ui' })).tier, 'first_party');
  // Lifting a partner's invoke ceiling must not also exempt it from its door limits.
  assert.equal(caller(apiKeyReq('agent_ui'), baseEnv({ GATEWAY_RATE_LIMIT_BYPASS_AGENT_IDS: 'agent_ui' })).tier, 'partner');
  assert.equal(caller(apiKeyReq('agent_svc', { introspect_auth_source: 'configured_service_key' }), baseEnv()).tier, 'first_party');
  assert.equal(caller(apiKeyReq('agent_ui'), baseEnv()).tier, 'partner');
  // A degraded verdict is never first-party, even if it names a listed agent.
  assert.equal(
    caller(apiKeyReq('agent_ui', { auth_degraded: true }), baseEnv({ MCP_CALLER_LIMITS_FIRST_PARTY_AGENT_IDS: 'agent_ui' })).tier,
    'partner',
  );
});

// ---------------- per-caller buckets ----------------

test('rate: each caller has its own per-minute budget', () => {
  const c = clock();
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_RPM: '3' });
  const lim = createCallerLimiter({ env, now: c.now });
  const a = caller(anonReq('203.0.113.1'), env);
  const b = caller(anonReq('203.0.113.2'), env);
  for (let i = 0; i < 3; i += 1) assert.equal(lim.admit(a).allowed, true);
  const refused = lim.admit(a);
  assert.equal(refused.allowed, false);
  assert.equal(refused.violation.reason, 'rate');
  assert.equal(refused.violation.status, 429);
  assert.ok(refused.violation.retryAfterSec >= 1);
  assert.equal(lim.admit(b).allowed, true, 'another caller is untouched');
});

test('rate: the sliding window lets a caller back in as the previous minute decays', () => {
  const c = clock();
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_RPM: '4' });
  const lim = createCallerLimiter({ env, now: c.now });
  const a = caller(anonReq('203.0.113.1'), env);
  for (let i = 0; i < 4; i += 1) assert.equal(lim.admit(a).allowed, true);
  c.advance(WINDOW_MS + 1000); // 1 s into the next window: previous window still weighs ~0.98
  const r = lim.admit(a);
  assert.equal(r.allowed, false);
  // 4 * (1 - f) + 1 <= 4 needs f >= 0.25, i.e. 15 s into the window; we are 1 s in.
  assert.equal(r.violation.retryAfterSec, 14);
  c.advance(15_000);
  assert.equal(lim.admit(a).allowed, true);
});

test('per-key override raises (or lowers) one caller without touching its tier', () => {
  const env = baseEnv({
    MCP_CALLER_LIMITS_PARTNER_RPM: '2',
    MCP_CALLER_LIMITS_OVERRIDES_JSON: JSON.stringify({ 'agent:agent_big': { rpm: 5 }, 'oauth:client_small': { rpm: 1 } }),
  });
  const c = clock();
  const lim = createCallerLimiter({ env, now: c.now });
  const big = caller(apiKeyReq('agent_big'), env);
  const plain = caller(apiKeyReq('agent_plain'), env);
  let admitted = 0;
  while (lim.admit(big).allowed && admitted < 50) admitted += 1;
  assert.equal(admitted, 5);
  admitted = 0;
  while (lim.admit(plain).allowed && admitted < 50) admitted += 1;
  assert.equal(admitted, 2);
});

test('a malformed overrides value is ignored as a whole and reported', () => {
  const cfg = readCallerLimitsConfig(baseEnv({ MCP_CALLER_LIMITS_OVERRIDES_JSON: '{not json' }));
  assert.equal(cfg.overrides.size, 0);
  assert.ok(cfg.overridesError);
});

// ---------------- concurrency ----------------

test('concurrency: a caller may hold N requests in flight; release frees a slot exactly once', () => {
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_CONCURRENCY: '2' });
  const lim = createCallerLimiter({ env, now: clock().now });
  const a = caller(anonReq('203.0.113.1'), env);
  const h1 = lim.admit(a);
  const h2 = lim.admit(a);
  const h3 = lim.admit(a);
  assert.equal(h1.allowed && h2.allowed, true);
  assert.equal(h3.allowed, false);
  assert.equal(h3.violation.reason, 'concurrency');
  assert.equal(h3.violation.status, 429);
  h1.release();
  h1.release(); // idempotent: a second release must not free a slot the caller still holds
  assert.equal(lim.admit(a).allowed, true);
  assert.equal(lim.admit(a).allowed, false);
});

test('tier concurrency: all anonymous callers together are capped per instance; partners are not', () => {
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_TIER_CONCURRENCY_PER_INSTANCE: '3' });
  const lim = createCallerLimiter({ env, now: clock().now });
  for (let i = 0; i < 3; i += 1) assert.equal(lim.admit(caller(anonReq(`203.0.113.${i + 1}`), env)).allowed, true);
  const r = lim.admit(caller(anonReq('203.0.113.50'), env));
  assert.equal(r.allowed, false);
  assert.equal(r.violation.reason, 'tier_concurrency');
  assert.equal(r.violation.status, 503);
  assert.equal(lim.admit(caller(apiKeyReq('agent_p'), env)).allowed, true);
});

// ---------------- observe vs enforce vs off ----------------

test('observe admits everything and logs a WARN would_reject; enforce refuses and logs reject; off does neither', () => {
  for (const mode of ['observe', 'enforce', 'off']) {
    const log = capturingLog();
    const env = baseEnv({ MCP_CALLER_LIMITS_MODE: mode, MCP_CALLER_LIMITS_ANON_RPM: '1' });
    const lim = createCallerLimiter({ env, now: clock().now, log });
    const a = caller(anonReq('203.0.113.1'), env);
    assert.equal(lim.admit(a, { door: 'public_mcp' }).allowed, true);
    const second = lim.admit(a, { door: 'public_mcp' });
    if (mode === 'enforce') {
      assert.equal(second.allowed, false);
    } else {
      assert.equal(second.allowed, true, `${mode} must not refuse`);
    }
    if (mode === 'off') {
      assert.equal(log.lines.length, 0);
      assert.equal(second.violation, null);
      continue;
    }
    assert.equal(log.lines.length, 1);
    const { obj, msg } = log.lines[0];
    assert.equal(msg, 'mcp caller limit');
    assert.equal(obj.event, 'mcp_caller_limit');
    assert.equal(obj.action, mode === 'enforce' ? 'reject' : 'would_reject');
    assert.equal(obj.reason, 'rate');
    assert.equal(obj.door, 'public_mcp');
    assert.equal(obj.tier, 'anonymous');
    assert.equal(obj.caller_key, a.key);
    assert.equal(obj.limit, 1);
    assert.ok(!JSON.stringify(obj).includes('203.0.113.1'), 'no client address in the log line');
  }
});

test('first-party is never counted, limited or logged', () => {
  const log = capturingLog();
  const env = baseEnv({ MCP_CALLER_LIMITS_FIRST_PARTY_AGENT_IDS: 'agent_ui', MCP_CALLER_LIMITS_PARTNER_RPM: '1', MCP_CALLER_LIMITS_SHED_PARTNER_POOL_WAITING: '1' });
  const lim = createCallerLimiter({ env, now: clock().now, log, poolStats: () => ({ waiting: 99 }) });
  const fp = caller(apiKeyReq('agent_ui'), env);
  for (let i = 0; i < 20; i += 1) assert.equal(lim.admit(fp).allowed, true);
  assert.equal(log.lines.length, 0);
});

// ---------------- load shedding ----------------

test('shedding: a saturated pool sheds anonymous first; partners keep being served unless configured to shed', () => {
  let waiting = 0;
  const env = baseEnv({ MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING: '2' });
  const lim = createCallerLimiter({ env, now: clock().now, poolStats: () => ({ waiting }) });
  const anon = caller(anonReq('203.0.113.1'), env);
  const partner = caller(apiKeyReq('agent_p'), env);
  assert.equal(lim.admit(anon).allowed, true);
  waiting = 2;
  const shed = lim.admit(anon);
  assert.equal(shed.allowed, false);
  assert.equal(shed.violation.reason, 'shed');
  assert.equal(shed.violation.status, 503);
  assert.equal(shed.violation.observed, 2);
  assert.equal(lim.admit(partner).allowed, true, 'partners are not shed at the anonymous threshold');

  const env2 = baseEnv({ MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING: '2', MCP_CALLER_LIMITS_SHED_PARTNER_POOL_WAITING: '6' });
  const lim2 = createCallerLimiter({ env: env2, now: clock().now, poolStats: () => ({ waiting }) });
  waiting = 4;
  assert.equal(lim2.admit(anon).allowed, false);
  assert.equal(lim2.admit(partner).allowed, true, 'between the two thresholds only anonymous is shed');
  waiting = 6;
  assert.equal(lim2.admit(partner).violation.reason, 'shed');
});

test('shedding: an unreadable pool census never sheds', () => {
  const env = baseEnv({ MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING: '1' });
  for (const poolStats of [() => null, () => { throw new Error('boom'); }, () => ({ waiting: 'x' })]) {
    const lim = createCallerLimiter({ env, now: clock().now, poolStats });
    assert.equal(lim.admit(caller(anonReq('203.0.113.1'), env)).allowed, true);
  }
});

test('a heavy anonymous caller cannot starve an authenticated one (simulated burst against a saturating pool)', () => {
  const env = baseEnv({
    MCP_CALLER_LIMITS_ANON_RPM: '30',
    MCP_CALLER_LIMITS_ANON_CONCURRENCY: '2',
    MCP_CALLER_LIMITS_ANON_TIER_CONCURRENCY_PER_INSTANCE: '4',
    MCP_CALLER_LIMITS_PARTNER_RPM: '300',
    MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '8',
    MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING: '2',
  });
  const c = clock();
  // The pool's waiters track how much slow work is in flight: each admitted request holds a connection.
  let inflight = 0;
  const POOL = 6;
  const lim = createCallerLimiter({ env, now: c.now, poolStats: () => ({ waiting: Math.max(0, inflight - POOL) }) });
  const partner = caller(apiKeyReq('agent_partner'), env);
  const held = [];
  let anonAdmitted = 0;
  let partnerAdmitted = 0;
  let partnerTried = 0;
  // 2 s of a flood: 50 anonymous attempts per 100 ms from 20 rotating addresses, plus one partner call per
  // 100 ms that holds a slot for 300 ms. Anonymous requests never finish (the worst case: a slow query).
  for (let tick = 0; tick < 20; tick += 1) {
    for (let i = 0; i < 50; i += 1) {
      const h = lim.admit(caller(anonReq(`198.51.100.${(i % 20) + 1}`), env));
      if (h.allowed) {
        anonAdmitted += 1;
        inflight += 1;
        held.push(h);
      }
    }
    partnerTried += 1;
    const p = lim.admit(partner);
    if (p.allowed) {
      partnerAdmitted += 1;
      inflight += 1;
      held.push({ release: p.release, partnerUntil: tick + 3 });
    }
    for (const h of held) {
      if (h.partnerUntil === tick) {
        h.release();
        inflight -= 1;
      }
    }
    c.advance(100);
  }
  assert.equal(partnerAdmitted, partnerTried, 'every partner call was served');
  assert.ok(anonAdmitted <= 4, `anonymous in flight is capped by the per-instance tier cap (admitted ${anonAdmitted})`);
});

// ---------------- the refusal ----------------

test('refusal: a JSON-RPC error with a stable code, the request id, Retry-After, and never a result', () => {
  const rate = limitRejectionResponse({ reason: 'rate', status: 429, retryAfterSec: 7.2 }, { rpcId: 42, tier: 'anonymous' });
  assert.equal(rate.status, 429);
  assert.equal(rate.headers['Retry-After'], '8');
  assert.equal(rate.body.jsonrpc, '2.0');
  assert.equal(rate.body.id, 42);
  assert.equal(rate.body.result, undefined);
  assert.equal(rate.body.error.code, RPC_CODE_CALLER_LIMITED);
  assert.match(rate.body.error.message, /Rate limit exceeded.*8 seconds/);
  assert.deepEqual(rate.body.error.data, { reason: 'rate', retry_after_s: 8, tier: 'anonymous' });

  const conc = limitRejectionResponse({ reason: 'concurrency', status: 429, retryAfterSec: 2 }, { rpcId: 'abc' });
  assert.equal(conc.body.error.code, RPC_CODE_CALLER_LIMITED);
  assert.match(conc.body.error.message, /concurrent/);

  for (const reason of ['shed', 'tier_concurrency', 'tier_rate']) {
    const busy = limitRejectionResponse({ reason, status: 503, retryAfterSec: 5 }, {});
    assert.equal(busy.status, 503);
    assert.equal(busy.body.id, null);
    assert.equal(busy.body.error.code, RPC_CODE_SERVER_BUSY);
    assert.equal(busy.headers['Retry-After'], '5');
  }
});

// ---------------- global across instances ----------------

test('global: two instances sharing a store enforce ONE per-caller budget, not one each', async () => {
  const c = clock(T0 + 5000);
  const store = createMemoryCallerLimitStore({ now: c.now });
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_RPM: '10' });
  const i1 = createCallerLimiter({ env, now: c.now, store, autoSync: false, instanceId: 'i1' });
  const i2 = createCallerLimiter({ env, now: c.now, store, autoSync: false, instanceId: 'i2' });
  const a = caller(anonReq('203.0.113.1'), env);
  for (let i = 0; i < 6; i += 1) assert.equal(i1.admit(a).allowed, true);
  // Before a sync, instance 2 knows nothing of instance 1's six.
  assert.equal(await i1.syncNow(), true);
  assert.equal(i2.admit(a).allowed, true); // 1 on i2
  assert.equal(await i2.syncNow(), true); // i2 learns i1's 6
  let admittedOn2 = 0;
  while (i2.admit(a).allowed && admittedOn2 < 50) admittedOn2 += 1;
  assert.equal(admittedOn2, 3, '6 on i1 + 1 + 3 on i2 = the budget of 10');
  // Instance 1 learns instance 2's share at the next round in which both have synced: the approximation
  // window is one sync interval.
  assert.equal(await i2.syncNow(), true);
  assert.equal(await i1.syncNow(), true);
  assert.equal(i1.admit(a).allowed, false, 'and instance 1 now sees instance 2\'s share too');
  // Without the store, each instance would have admitted 10.
  const solo1 = createCallerLimiter({ env, now: c.now, instanceId: 's1' });
  const solo2 = createCallerLimiter({ env, now: c.now, instanceId: 's2' });
  let solo = 0;
  for (let i = 0; i < 30; i += 1) if (solo1.admit(a).allowed) solo += 1;
  for (let i = 0; i < 30; i += 1) if (solo2.admit(a).allowed) solo += 1;
  assert.equal(solo, 20);
});

test('global: in-flight requests on other instances count against a caller\'s concurrency, and go stale', async () => {
  const c = clock(T0 + 5000);
  const store = createMemoryCallerLimitStore({ now: c.now });
  const env = baseEnv({ MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '3', MCP_CALLER_LIMITS_SYNC_MS: '2000' });
  const i1 = createCallerLimiter({ env, now: c.now, store, autoSync: false, instanceId: 'i1' });
  const i2 = createCallerLimiter({ env, now: c.now, store, autoSync: false, instanceId: 'i2' });
  const p = caller(apiKeyReq('agent_p'), env);
  const held = [i1.admit(p), i1.admit(p)];
  await i1.syncNow();
  assert.equal(i2.admit(p).allowed, true);
  await i2.syncNow();
  const r = i2.admit(p);
  assert.equal(r.allowed, false);
  assert.equal(r.violation.reason, 'concurrency');
  assert.equal(r.violation.observed, 3);
  held.forEach((h) => h.release());
  await i1.syncNow();
  await i2.syncNow();
  assert.equal(i2.admit(p).allowed, true, 'released on instance 1 frees the slot on instance 2');
  // A gauge older than 3 sync intervals is not trusted: a dead instance cannot hold slots forever.
  const i3 = createCallerLimiter({ env, now: c.now, store, autoSync: false, instanceId: 'i3' });
  i3.admit(p);
  i3.admit(p);
  await i3.syncNow();
  c.advance(7000);
  await i2.syncNow();
  assert.equal(i2.inspect(p.key).others.inflight, 0);
});

test('global: the anonymous tier budget is shared across instances too', async () => {
  const c = clock(T0 + 1000);
  const store = createMemoryCallerLimitStore({ now: c.now });
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_TIER_RPM: '5' });
  const i1 = createCallerLimiter({ env, now: c.now, store, autoSync: false, instanceId: 'i1' });
  const i2 = createCallerLimiter({ env, now: c.now, store, autoSync: false, instanceId: 'i2' });
  for (let i = 0; i < 4; i += 1) assert.equal(i1.admit(caller(anonReq(`203.0.113.${i + 1}`), env)).allowed, true);
  await i1.syncNow();
  i2.admit(caller(anonReq('203.0.113.99'), env));
  await i2.syncNow();
  const r = i2.admit(caller(anonReq('203.0.113.100'), env));
  assert.equal(r.allowed, false);
  assert.equal(r.violation.reason, 'tier_rate');
  assert.equal(i2.inspect(ANON_TIER_KEY).others.cur, 4);
});

test('store failure: limits fall back to per-instance accounting, warn once, and a missing table pauses syncing', async () => {
  const c = clock(T0 + 1000);
  const log = capturingLog();
  let calls = 0;
  const failing = {
    kind: 'postgres',
    async sync() {
      calls += 1;
      const err = new Error('relation "gateway_caller_limit_counters" does not exist');
      err.code = '42P01';
      throw err;
    },
  };
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_RPM: '2' });
  const lim = createCallerLimiter({ env, now: c.now, store: failing, autoSync: false, log });
  const a = caller(anonReq('203.0.113.1'), env);
  assert.equal(lim.admit(a).allowed, true);
  assert.equal(await lim.syncNow(), false);
  assert.equal(await lim.syncNow(), false);
  assert.equal(calls, 1, 'a missing table is not retried every tick');
  assert.equal(log.lines.filter((l) => l.obj.event === 'mcp_caller_limit_store').length, 1);
  assert.equal(lim.admit(a).allowed, true);
  assert.equal(lim.admit(a).allowed, false, 'still limited, per instance');
});

test('the sync never queues behind real work: no sync while the pool has waiters', async () => {
  const c = clock(T0 + 1000);
  let calls = 0;
  const store = { kind: 'memory', async sync() { calls += 1; return []; } };
  let waiting = 1;
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_RPM: '5' });
  const lim = createCallerLimiter({ env, now: c.now, store, autoSync: false, poolStats: () => ({ waiting }) });
  lim.admit(caller(anonReq('203.0.113.1'), env));
  assert.equal(await lim.syncNow(), false);
  assert.equal(calls, 0);
  waiting = 0;
  assert.equal(await lim.syncNow(), true);
  assert.equal(calls, 1);
});

test('the sync sends only active keys, busiest first, capped', async () => {
  const c = clock(T0 + 1000);
  let sent = null;
  const store = { kind: 'memory', async sync({ rows }) { sent = rows; return []; } };
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_RPM: '100', MCP_CALLER_LIMITS_MAX_SYNC_KEYS: '2' });
  const lim = createCallerLimiter({ env, now: c.now, store, autoSync: false });
  const busy = caller(anonReq('203.0.113.1'), env);
  for (let i = 0; i < 5; i += 1) lim.admit(busy).release();
  lim.admit(caller(anonReq('203.0.113.2'), env)).release();
  lim.admit(caller(anonReq('203.0.113.3'), env)).release();
  await lim.syncNow();
  const keys = sent.map((r) => r.key);
  assert.equal(new Set(keys).size, 2);
  assert.ok(keys.includes(ANON_TIER_KEY), 'the tier total is the busiest key');
  assert.ok(keys.includes(busy.key));
  assert.ok(sent.every((r) => r.windowMs % WINDOW_MS === 0));
});

test('a snapshot this instance stopped refreshing is not trusted for in-flight counts (the store went away)', async () => {
  const c = clock(T0 + 5000);
  const shared = createMemoryCallerLimitStore({ now: c.now });
  let up = true;
  const flaky = {
    kind: 'memory',
    sync: (args) => (up ? shared.sync(args) : Promise.reject(new Error('store down'))),
  };
  const env = baseEnv({ MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '2', MCP_CALLER_LIMITS_SYNC_MS: '2000' });
  const i1 = createCallerLimiter({ env, now: c.now, store: shared, autoSync: false, instanceId: 'i1' });
  const i2 = createCallerLimiter({ env, now: c.now, store: flaky, autoSync: false, instanceId: 'i2' });
  const p = caller(apiKeyReq('agent_p'), env);
  i1.admit(p);
  i1.admit(p);
  await i1.syncNow();
  i2.admit(p).release();
  assert.equal(await i2.syncNow(), true);
  assert.equal(i2.admit(p).allowed, false, 'two in flight elsewhere, as of a fresh snapshot');
  up = false;
  c.advance(7000);
  assert.equal(await i2.syncNow(), false);
  assert.equal(i2.inspect(p.key).others.inflight, 0, 'a 7 s old gauge (3 intervals = 6 s) is dropped');
  assert.equal(i2.admit(p).allowed, true, 'and the caller is limited per instance until the store returns');
});
