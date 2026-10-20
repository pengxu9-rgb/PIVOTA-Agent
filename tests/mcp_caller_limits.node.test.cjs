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
    MCP_CALLER_LIMITS_OAUTH_UNREGISTERED_TIER_RPM: '0',
    MCP_CALLER_LIMITS_OAUTH_UNREGISTERED_TIER_CONCURRENCY_PER_INSTANCE: '0',
    // 1 = no per-instance split before the first sync; the split has its own cases below.
    MCP_CALLER_LIMITS_EXPECTED_INSTANCES: '1',
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

test('identity: an MCP OAuth client is a partner keyed on issuer AND client id; no client id falls back to the address', () => {
  const env = baseEnv();
  const oauth = (cid, ip, iss = 'https://as.example.test') => ({
    headers: { 'x-forwarded-for': `${ip}, ${LB}` },
    invokeAuth: { auth_mode: 'mcp_oauth', oauth_client_id: cid, oauth_issuer: iss },
  });
  const c1 = caller(oauth('client_1', '203.0.113.1'), env);
  assert.equal(c1.tier, 'partner');
  assert.equal(c1.id, 'oauth:https://as.example.test#client_1');
  assert.equal(c1.oauth_client_id, 'client_1');
  assert.equal(caller(oauth('client_1', '203.0.113.2'), env).key, c1.key);
  assert.notEqual(
    caller(oauth('client_1', '203.0.113.1', 'https://other-as.example.test'), env).key,
    c1.key,
    'the same client id from another issuer is another client',
  );
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
    MCP_CALLER_LIMITS_OVERRIDES_JSON: JSON.stringify({ 'agent:agent_big': { rpm: 5 }, 'oauth:https://as.example.test#client_small': { rpm: 1 } }),
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
    assert.equal(obj.caller_key, undefined, 'an anonymous counter key is never logged');
    assert.equal(obj.caller_tag, a.log_tag);
    assert.notEqual(obj.caller_tag, a.key.split(':')[1], 'the log tag is not the counter key');
    assert.equal(obj.limit_split, false, 'limit_split is always present, so observe can count it by tier');
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
  c.advance(5 * 60 * 1000); // far past any ordinary backoff step
  lim.admit(a).release();
  assert.equal(await lim.syncNow(), false);
  assert.equal(calls, 1, 'a missing table pauses syncing for minutes, not one backoff step');
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

// ---------------- review round 2 ----------------

const {
  OAUTH_UNREG_TIER_KEY,
  anonymousIdForIp,
  invokeContextLimitCaller,
  isClientGone,
  logMcpCallerLimitsBootStatus,
  logNetworkForIp,
} = require('../src/guardrails/mcpCallerLimits');

test('burst split: before a key has a fresh shared count, an instance allows only limit / expected instances', async () => {
  const c = clock(T0 + 1000);
  const store = createMemoryCallerLimitStore({ now: c.now });
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_RPM: '8', MCP_CALLER_LIMITS_EXPECTED_INSTANCES: '4' });
  const lim = createCallerLimiter({ env, now: c.now, store, autoSync: false, instanceId: 'i1', log: capturingLog() });
  const a = caller(anonReq('203.0.113.1'), env);
  assert.equal(lim.admit(a).allowed, true);
  assert.equal(lim.admit(a).allowed, true);
  const r = lim.admit(a);
  assert.equal(r.allowed, false, '8 / 4 = 2 before any sync');
  assert.equal(r.violation.limit, 2);
  assert.equal(r.violation.limit_split, true);
  assert.equal(await lim.syncNow(), true);
  let more = 0;
  while (lim.admit(a).allowed && more < 20) more += 1;
  assert.equal(more, 6, 'once the key is in a fresh snapshot the full global budget applies');
  // A key that was NOT in that sync has no shared count yet, fresh snapshot or not.
  const fresh = caller(anonReq('203.0.113.3'), env);
  assert.equal(lim.admit(fresh).allowed, true);
  assert.equal(lim.admit(fresh).allowed, true);
  assert.equal(lim.admit(fresh).allowed, false);
  // The snapshot goes stale (store down): back to the per-instance share.
  c.advance(7000);
  const b = caller(anonReq('203.0.113.2'), env);
  assert.equal(lim.admit(b).allowed, true);
  assert.equal(lim.admit(b).allowed, true);
  assert.equal(lim.admit(b).allowed, false);
  // Concurrency is split the same way, never below 1.
  const env2 = baseEnv({ MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '3', MCP_CALLER_LIMITS_EXPECTED_INSTANCES: '4' });
  const lim2 = createCallerLimiter({ env: env2, now: c.now, store, autoSync: false, instanceId: 'i2' });
  const p = caller(apiKeyReq('agent_p'), env2);
  assert.equal(lim2.admit(p).allowed, true);
  assert.equal(lim2.admit(p).violation.reason, 'concurrency');
});

test('burst split does not apply without a shared store (per-instance mode is an explicit choice)', () => {
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_RPM: '8', MCP_CALLER_LIMITS_EXPECTED_INSTANCES: '4' });
  const lim = createCallerLimiter({ env, now: clock().now });
  const a = caller(anonReq('203.0.113.1'), env);
  let n = 0;
  while (lim.admit(a).allowed && n < 20) n += 1;
  assert.equal(n, 8);
});

test('max age: a slot past it is flagged and logged ONCE as a zombie but stays counted until its finally runs (1 s age, 3 s work)', () => {
  const c = clock();
  const log = capturingLog();
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_CONCURRENCY: '1', MCP_CALLER_LIMITS_INFLIGHT_MAX_AGE_MS: '1000' });
  const lim = createCallerLimiter({ env, now: c.now, log });
  const a = caller(anonReq('203.0.113.1'), env);
  const slow = lim.admit(a); // 3 s of work starts
  let concurrent = 1;
  let peak = 1;
  for (let ms = 250; ms <= 3000; ms += 250) {
    c.advance(250);
    const r = lim.admit(a);
    if (r.allowed) {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      r.release();
      concurrent -= 1;
    }
  }
  assert.equal(peak, 1, 'flagging a slot never lets a second request run beside the 3 s one');
  const flagged = log.lines.filter((l) => l.obj.event === 'mcp_caller_limit_reaped');
  assert.equal(flagged.length, 1, 'flagged once, not on every check');
  assert.equal(flagged[0].obj.zombie, true);
  assert.ok(flagged[0].obj.age_ms > 1000);
  assert.equal(lim.inspect(a.key).zombies, 1);
  slow.release(); // the work's finally
  assert.equal(lim.inspect(a.key).zombies, 0);
  assert.equal(lim.admit(a).allowed, true, 'released by its own finally, the slot is free');
});

test('max age defaults to twice the request timeout (300 s), so no legitimate request is ever flagged', () => {
  assert.equal(readCallerLimitsConfig({}).inflightMaxAgeMs, 600_000);
});

test('sync backoff: 2 s, 4, 8, 16, 32, then capped at 60 s; a success resets it', async () => {
  const c = clock(T0 + 1000);
  let up = false;
  const shared = createMemoryCallerLimitStore({ now: c.now });
  const store = { kind: 'memory', sync: (args) => (up ? shared.sync(args) : Promise.reject(Object.assign(new Error('timeout'), { code: '57014' }))) };
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_RPM: '100', MCP_CALLER_LIMITS_SYNC_MS: '2000' });
  const lim = createCallerLimiter({ env, now: c.now, store, autoSync: false, log: capturingLog() });
  const delays = [];
  for (let i = 0; i < 7; i += 1) {
    lim.admit(caller(anonReq('203.0.113.1'), env)).release(); // keep the key active across window rolls
    assert.equal(await lim.syncNow(), false);
    const { nextAt, failures } = lim.inspect('x').sync;
    assert.equal(failures, i + 1);
    delays.push(nextAt - c.t);
    // Asking early is refused without touching the store.
    assert.equal(await lim.syncNow(), false);
    assert.equal(lim.inspect('x').sync.failures, i + 1);
    c.t = nextAt;
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  up = true;
  assert.equal(await lim.syncNow(), true);
  assert.deepEqual(lim.inspect('x').sync, { failures: 0, nextAt: 0 });
});

test('the sync never takes the last free connection: skipped while the pool has no idle connection at max', async () => {
  const c = clock(T0 + 1000);
  let calls = 0;
  const store = { kind: 'memory', async sync() { calls += 1; return []; } };
  let stats = { waiting: 0, idle: 0, total: 12, max: 12 };
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_RPM: '5' });
  const lim = createCallerLimiter({ env, now: c.now, store, autoSync: false, poolStats: () => stats });
  lim.admit(caller(anonReq('203.0.113.1'), env));
  assert.equal(await lim.syncNow(), false);
  stats = { waiting: 0, idle: 1, total: 12, max: 12 };
  assert.equal(await lim.syncNow(), true);
  assert.equal(calls, 1);
});

test('unregistered OAuth clients share one aggregate budget; a client with an override is exempt', () => {
  const env = baseEnv({
    MCP_CALLER_LIMITS_OAUTH_UNREGISTERED_TIER_CONCURRENCY_PER_INSTANCE: '2',
    MCP_CALLER_LIMITS_OVERRIDES_JSON: JSON.stringify({ 'oauth:https://as.example.test#known': { rpm: 100 } }),
  });
  const lim = createCallerLimiter({ env, now: clock().now });
  const oauth = (cid) => caller({
    headers: { 'x-forwarded-for': `203.0.113.1, ${LB}` },
    invokeAuth: { auth_mode: 'mcp_oauth', oauth_client_id: cid, oauth_issuer: 'https://as.example.test' },
  }, env);
  assert.equal(lim.admit(oauth('minted_1')).allowed, true);
  assert.equal(lim.admit(oauth('minted_2')).allowed, true);
  const third = lim.admit(oauth('minted_3'));
  assert.equal(third.allowed, false, 'a freshly minted client id buys no new capacity');
  assert.equal(third.violation.reason, 'tier_concurrency');
  assert.equal(lim.admit(oauth('known')).allowed, true, 'an overridden client is outside the aggregate');
  assert.equal(lim.inspect(OAUTH_UNREG_TIER_KEY).local.inflight, 2);
  // API-key partners (issued by the platform, not mintable) are outside it too.
  assert.equal(lim.admit(caller(apiKeyReq('agent_p'), env)).allowed, true);
});

test('partners shed too, at a higher default threshold than anonymous', () => {
  const cfg = readCallerLimitsConfig({});
  assert.ok(cfg.shed.partnerPoolWaiting > cfg.shed.anonymousPoolWaiting);
  assert.ok(cfg.shed.anonymousPoolWaiting > 0);
});

test('IPv6 keys on the /64; logs carry IPv4 /24 or IPv6 /48 only', () => {
  assert.equal(anonymousIdForIp('2001:db8:1:2:aaaa::1'), 'ip:2001:db8:1:2::/64');
  assert.equal(anonymousIdForIp('2001:db8:1:2:ffff:ffff:ffff:ffff'), 'ip:2001:db8:1:2::/64');
  assert.equal(anonymousIdForIp('2001:db8:1:3::1'), 'ip:2001:db8:1:3::/64');
  assert.equal(anonymousIdForIp('203.0.113.7'), 'ip:203.0.113.7');
  assert.equal(anonymousIdForIp(null), 'ip:unknown');
  assert.equal(logNetworkForIp('203.0.113.7'), '203.0.113.0/24');
  assert.equal(logNetworkForIp('2001:db8:1:2:aaaa::1'), '2001:db8:1::/48');
  assert.equal(logNetworkForIp('::ffff:0:203.0.113.7'), '0:0:0::/48');
  const env = baseEnv();
  const a = caller(anonReq('2001:db8:1:2:aaaa::1'), env);
  const b = caller(anonReq('2001:db8:1:2:bbbb::9'), env);
  assert.equal(a.key, b.key, 'rotating inside one /64 buys no new bucket');
  assert.notEqual(caller(anonReq('2001:db8:1:3::1'), env).key, a.key);
});

test('cidr overrides: every address in the range gets the limit in its OWN bucket; exact ip: wins; longest prefix wins', () => {
  const env = baseEnv({
    MCP_CALLER_LIMITS_ANON_RPM: '2',
    MCP_CALLER_LIMITS_OVERRIDES_JSON: JSON.stringify({
      'cidr:198.51.100.0/24': { rpm: 5 },
      'cidr:198.51.100.128/25': { rpm: 7 },
      'ip:198.51.100.9': { rpm: 1 },
      'cidr:2001:db8:5::/48': { rpm: 4 },
    }),
  });
  const lim = createCallerLimiter({ env, now: clock().now });
  const budget = (ip) => {
    const c = caller(anonReq(ip), env);
    let n = 0;
    while (lim.admit(c).allowed && n < 50) n += 1;
    return n;
  };
  assert.equal(budget('198.51.100.1'), 5);
  assert.equal(budget('198.51.100.2'), 5, 'a second address in the range has its own bucket');
  assert.equal(budget('198.51.100.200'), 7, 'the /25 is more specific than the /24');
  assert.equal(budget('198.51.100.9'), 1, 'an exact ip: override wins over any cidr');
  assert.equal(budget('203.0.113.1'), 2, 'outside every range: the tier default');
  assert.equal(budget('2001:db8:5:1::1'), 4);
  const bad = readCallerLimitsConfig(baseEnv({ MCP_CALLER_LIMITS_OVERRIDES_JSON: JSON.stringify({ 'cidr:198.51.100.0/33': { rpm: 1 } }) }));
  assert.ok(bad.overridesError);
  assert.equal(bad.cidrOverrides.length, 0);
});

test('an unknown client address is its own strict class, not a shared loophole at the anonymous budget', () => {
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_RPM: '30', MCP_CALLER_LIMITS_UNKNOWN_IP_RPM: '2' });
  const lim = createCallerLimiter({ env, now: clock().now });
  const unknown = caller({ headers: {}, socket: {} }, env);
  assert.equal(unknown.unknown_ip, true);
  assert.equal(unknown.id, 'ip:unknown');
  let n = 0;
  for (let r = lim.admit(unknown); r.allowed && n < 50; r = lim.admit(unknown)) {
    n += 1;
    r.release();
  }
  assert.equal(n, 2);
  assert.equal(readCallerLimitsConfig({}).unknownIp.concurrency, 1);
});

test('a client address never reaches a log line or the invoke context, IPv4 or IPv6', () => {
  const log = capturingLog();
  const env = baseEnv({
    MCP_CALLER_LIMITS_MODE: 'observe',
    MCP_CALLER_LIMITS_ANON_RPM: '1',
    MCP_CALLER_LIMITS_INFLIGHT_MAX_AGE_MS: '1',
    MCP_CALLER_LIMITS_OVERRIDES_JSON: JSON.stringify({ 'ip:203.0.113.77': { rpm: 1 } }),
  });
  const c = clock();
  const lim = createCallerLimiter({ env, now: c.now, log });
  const ips = ['203.0.113.77', '2001:db8:9:8:7:6:5:4'];
  for (const ip of ips) {
    const who = caller(anonReq(ip), env);
    lim.admit(who, { door: 'public_mcp' });
    lim.admit(who, { door: 'public_mcp' });
    c.advance(2000);
    lim.admit(who, { door: 'public_mcp' }); // reaps the earlier slots, logging them
    const ctx = invokeContextLimitCaller({ mcpLimitCaller: { ...who, call_id: 'c1' } });
    assert.deepEqual(Object.keys(ctx).sort(), ['agent_id', 'call_id', 'key', 'tier']);
    assert.ok(!JSON.stringify(ctx).includes(ip));
  }
  const all = JSON.stringify(log.lines);
  assert.ok(log.lines.some((l) => l.obj.event === 'mcp_caller_limit'));
  assert.ok(log.lines.some((l) => l.obj.event === 'mcp_caller_limit_reaped'));
  for (const ip of ips) assert.ok(!all.includes(ip), `${ip} must never be logged`);
  assert.ok(!all.includes('2001:db8:9:8'), 'not even the /64 a v6 caller is keyed on');
  assert.ok(all.includes('203.0.113.0/24'));
  assert.ok(all.includes('2001:db8:9::/48'));
});

test('client-gone detection: a closed socket or ended response, never req.destroyed (true on every read body)', () => {
  assert.equal(isClientGone({ destroyed: true, socket: { destroyed: false } }, { destroyed: false, writableEnded: false }), false);
  assert.equal(isClientGone({ socket: { destroyed: true } }, {}), true);
  assert.equal(isClientGone({ socket: {} }, { destroyed: true }), true);
  assert.equal(isClientGone({ socket: {} }, { writableEnded: true }), true);
});

test('boot status names whether loopback tool calls can carry the caller', () => {
  const lines = [];
  const log = { info: (o) => lines.push(['info', o]), warn: (o) => lines.push(['warn', o]) };
  const ok = logMcpCallerLimitsBootStatus({ selfInvokeBase: 'http://127.0.0.1:8080', log, env: { MCP_CALLER_LIMITS_MODE: 'observe' } });
  assert.equal(ok.loopback_assertion_active, true);
  const bad = logMcpCallerLimitsBootStatus({ selfInvokeBase: 'https://gateway.example.test', log, env: { MCP_CALLER_LIMITS_MODE: 'enforce' } });
  assert.equal(bad.loopback_assertion_active, false);
  assert.deepEqual(lines.map((l) => l[0]), ['info', 'warn']);
  const off = logMcpCallerLimitsBootStatus({ selfInvokeBase: 'http://127.0.0.1:8080', log, env: {} });
  assert.equal(off.loopback_assertion_active, false);
});

// ---------------- review round 3: the daily salt ----------------

const crypto = require('crypto');
const { createSaltProvider, utcDay, admitMcpCallerLimit, resetProcessCallerLimiterForTest } = require('../src/guardrails/mcpCallerLimits');

function unsaltedKey(id) {
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);
}

test('salted keys: neither the counter key nor the log tag is recoverable by hashing candidate addresses', async () => {
  const c = clock();
  const store = createMemoryCallerLimitStore({ now: c.now });
  const salts = createSaltProvider({ store, now: c.now });
  await salts.ready();
  const env = baseEnv({ MCP_CALLER_LIMITS_MODE: 'observe', MCP_CALLER_LIMITS_ANON_RPM: '1' });
  const target = caller(anonReq('203.0.113.77'), env);
  const salted = resolveDoorCaller(anonReq('203.0.113.77'), { config: readCallerLimitsConfig(env), salts });
  // Brute force the logged /24 the way an attacker would: the unsalted key of every address in it.
  const candidates = new Set();
  for (let i = 0; i < 256; i += 1) {
    const id = `ip:203.0.113.${i}`;
    candidates.add(unsaltedKey(id));
    candidates.add(unsaltedKey(`anonymous:${id}`));
  }
  const keyHex = salted.key.split(':')[1];
  assert.ok(!candidates.has(keyHex), 'the counter key is not an unsalted hash of any address');
  assert.ok(!candidates.has(salted.log_tag), 'nor is the log tag');
  assert.notEqual(keyHex, salted.log_tag, 'the log tag is not the counter key');
  assert.equal(salted.salt_source, 'shared');
  // And neither the log line nor the shared counters carry an unsalted hash.
  const log = capturingLog();
  const lim = createCallerLimiter({ env, now: c.now, store, autoSync: false, log });
  lim.admit(salted, { door: 'public_mcp' });
  lim.admit(salted, { door: 'public_mcp' });
  await lim.syncNow();
  const everything = JSON.stringify(log.lines) + JSON.stringify([...store.rows.values()]);
  assert.ok(!everything.includes(unsaltedKey('ip:203.0.113.77')));
  assert.ok(!everything.includes('203.0.113.77'));
  assert.ok(JSON.stringify([...store.rows.values()]).includes(keyHex), 'the counters carry the salted key');
  assert.ok(!JSON.stringify(log.lines).includes(keyHex), 'the log never carries the counter key');
  assert.ok(target.key !== salted.key || target.salt_source === 'shared');
});

test('salted keys: two instances converge on the same daily salt, so their counters line up', async () => {
  const c = clock();
  const store = createMemoryCallerLimitStore({ now: c.now });
  const s1 = createSaltProvider({ store, now: c.now });
  const s2 = createSaltProvider({ store, now: c.now });
  // Before either has fetched, each is on its own per-process salt: different keys, never unsalted.
  const env = baseEnv();
  const cfg = readCallerLimitsConfig(env);
  const before1 = resolveDoorCaller(anonReq('203.0.113.5'), { config: cfg, salts: s1 });
  assert.equal(before1.salt_source, 'local');
  assert.notEqual(before1.key.split(':')[1], unsaltedKey('ip:203.0.113.5'));
  assert.equal(await s1.ready(), true);
  assert.equal(await s2.ready(), true);
  const k1 = resolveDoorCaller(anonReq('203.0.113.5'), { config: cfg, salts: s1 });
  const k2 = resolveDoorCaller(anonReq('203.0.113.5'), { config: cfg, salts: s2 });
  assert.equal(k1.key, k2.key);
  assert.equal(k1.log_tag, k2.log_tag);
  assert.equal(store.salts.size, 1);
});

test('salted keys: the salt rotates at the UTC day boundary and days older than two are deleted', async () => {
  const c = clock(Date.UTC(2026, 0, 10, 23, 59, 59));
  const store = createMemoryCallerLimitStore({ now: c.now });
  const salts = createSaltProvider({ store, now: c.now });
  const cfg = readCallerLimitsConfig(baseEnv());
  await salts.ready();
  const day1 = resolveDoorCaller(anonReq('203.0.113.5'), { config: cfg, salts });
  c.advance(2000); // past midnight
  await salts.ready();
  const day2 = resolveDoorCaller(anonReq('203.0.113.5'), { config: cfg, salts });
  assert.notEqual(day2.key, day1.key, 'a new day, a new salt, a new key (anonymous buckets reset)');
  assert.equal(day2.salt_source, 'shared');
  assert.deepEqual([...store.salts.keys()].sort(), ['2026-01-10', '2026-01-11']);
  c.advance(2 * 24 * 3600 * 1000);
  await salts.ready();
  assert.deepEqual([...store.salts.keys()].sort(), ['2026-01-11', '2026-01-13'], 'days more than two back are deleted');
  assert.equal(utcDay(Date.UTC(2026, 0, 13, 0, 0, 0)), '2026-01-13');
});

test('salted keys: with the database down the salt is a per-process random one (never unsalted) and is retried', async () => {
  const c = clock();
  let calls = 0;
  const down = { kind: 'postgres', async getOrCreateSalt() { calls += 1; throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); } };
  const log = capturingLog();
  const salts = createSaltProvider({ store: down, now: c.now, log, retryMs: 30_000 });
  const cfg = readCallerLimitsConfig(baseEnv());
  assert.equal(await salts.ready(), false);
  const who = resolveDoorCaller(anonReq('203.0.113.5'), { config: cfg, salts });
  assert.equal(who.salt_source, 'local');
  assert.notEqual(who.key.split(':')[1], unsaltedKey('ip:203.0.113.5'));
  assert.equal(resolveDoorCaller(anonReq('203.0.113.5'), { config: cfg, salts }).key, who.key, 'stable within the process and day');
  assert.equal(calls, 1);
  c.advance(10_000);
  salts.current();
  assert.equal(calls, 1, 'not retried before retryMs');
  c.advance(25_000);
  await salts.ready();
  assert.equal(calls, 2);
  const line = log.lines.find((l) => l.obj.event === 'mcp_caller_limit_salt');
  assert.ok(line);
  assert.deepEqual(Object.keys(line.obj).sort(), ['err', 'event', 'retry_in_ms']);
});

test('slow success: a sync that takes more than half its budget is used, but backs off like a failure', async () => {
  const c = clock(T0 + 1000);
  const shared = createMemoryCallerLimitStore({ now: c.now });
  let slowMs = 1000;
  const store = { kind: 'memory', async sync(args) { c.advance(slowMs); return shared.sync(args); } };
  const env = baseEnv({ MCP_CALLER_LIMITS_ANON_RPM: '100', MCP_CALLER_LIMITS_SYNC_TIMEOUT_MS: '1500', MCP_CALLER_LIMITS_SYNC_MS: '2000' });
  const lim = createCallerLimiter({ env, now: c.now, store, autoSync: false, log: capturingLog() });
  lim.admit(caller(anonReq('203.0.113.1'), env)).release();
  assert.equal(await lim.syncNow(), true, 'the snapshot is still used');
  assert.equal(lim.inspect('x').sync.failures, 1);
  assert.equal(lim.inspect('x').sync.nextAt - c.t, 2000);
  c.t = lim.inspect('x').sync.nextAt;
  slowMs = 100;
  assert.equal(await lim.syncNow(), true);
  assert.deepEqual(lim.inspect('x').sync, { failures: 0, nextAt: 0 });
});

test('observe never refuses or drops a client that is already gone; enforce does not dispatch for it', () => {
  const prior = { ...process.env };
  try {
    Object.assign(process.env, baseEnv({ MCP_CALLER_LIMITS_STORE: 'local' }));
    resetProcessCallerLimiterForTest({ env: process.env });
    const gone = () => ({
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } },
      headers: { 'x-forwarded-for': `203.0.113.200, ${LB}` },
      socket: { destroyed: true, remoteAddress: '169.254.1.1' },
    });
    process.env.MCP_CALLER_LIMITS_MODE = 'observe';
    const observed = admitMcpCallerLimit(gone(), { destroyed: true });
    assert.equal(observed.gone, undefined);
    assert.equal(observed.refusal, undefined);
    assert.equal(typeof observed.release, 'function');
    process.env.MCP_CALLER_LIMITS_MODE = 'enforce';
    assert.equal(admitMcpCallerLimit(gone(), { destroyed: true }).gone, true);
  } finally {
    resetProcessCallerLimiterForTest();
    process.env = prior;
  }
});

test('the store never waits long for a connection, and gives one straight back if the pool has waiters', async () => {
  const { createPostgresCallerLimitStore } = require('../src/guardrails/mcpCallerLimits');
  const released = [];
  const fakeClient = (name) => ({
    query: async () => ({ rows: [] }),
    release: (broken) => released.push([name, Boolean(broken)]),
  });
  // 1. connect() is slow: the store gives up at the acquire timeout and returns the late connection.
  let resolveLate;
  const slowPool = { waitingCount: 0, connect: () => new Promise((r) => { resolveLate = r; }) };
  const slowStore = createPostgresCallerLimitStore({ db: { getPool: () => slowPool }, acquireTimeoutMs: 20 });
  const started = Date.now();
  await assert.rejects(
    slowStore.sync({ instanceId: 'i', rows: [], sinceMs: 0, freshSec: 6, timeoutMs: 1500 }),
    (err) => err.code === 'SYNC_ACQUIRE_TIMEOUT',
  );
  assert.ok(Date.now() - started < 500);
  resolveLate(fakeClient('late'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(released, [['late', false]], 'the late connection goes straight back to the pool');
  // 2. connected, but the pool now has waiters: hand it back without running anything.
  released.length = 0;
  const queries = [];
  const busyPool = {
    waitingCount: 2,
    connect: async () => ({ query: async (q) => { queries.push(q); return { rows: [] }; }, release: (b) => released.push(['busy', Boolean(b)]) }),
  };
  const busyStore = createPostgresCallerLimitStore({ db: { getPool: () => busyPool }, acquireTimeoutMs: 20 });
  await assert.rejects(
    busyStore.sync({ instanceId: 'i', rows: [], sinceMs: 0, freshSec: 6, timeoutMs: 1500 }),
    (err) => err.code === 'SYNC_POOL_BUSY',
  );
  assert.deepEqual(queries, []);
  assert.deepEqual(released, [['busy', false]]);
  // 3. the normal path: one transaction, statement_timeout first, released healthy.
  released.length = 0;
  queries.length = 0;
  const okPool = {
    waitingCount: 0,
    connect: async () => ({ query: async (q) => { queries.push(String(q).trim().split(/\s+/).slice(0, 3).join(' ')); return { rows: [] }; }, release: (b) => released.push(['ok', Boolean(b)]) }),
  };
  const okStore = createPostgresCallerLimitStore({ db: { getPool: () => okPool }, acquireTimeoutMs: 20 });
  await okStore.sync({ instanceId: 'i', rows: [], sinceMs: 0, freshSec: 6, timeoutMs: 1500 });
  assert.deepEqual(queries.slice(0, 2), ['BEGIN', "SET LOCAL statement_timeout"]);
  assert.equal(queries[queries.length - 1], 'COMMIT');
  assert.deepEqual(released, [['ok', false]]);
});
