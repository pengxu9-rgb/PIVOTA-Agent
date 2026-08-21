'use strict';

// The invoke-auth verdict cache's stale-if-error contract — what may be replayed during an
// introspection outage, for how long, and what must still refuse.
//
// WHY THIS FILE EXISTS. On 2026-08-21 a backend DB-pool saturation made /agent/internal/auth/introspect
// time out, and the commerce door answered 503 to a VALID partner key for several minutes: the fresh
// cache window had lapsed and the expired entry was deleted on read, so there was nothing to fall back
// on. The fix retains positive verdicts past the fresh window and replays them ONLY while introspection
// itself is unavailable. Every rule that keeps that from becoming a hole is asserted here:
//   - a negative verdict is NEVER outage-servable, and its total lifetime is clamped to seconds;
//   - the outage window is measured from the introspection that MINTED the verdict, and replaying a
//     verdict does not extend it — a revoked key mid-outage dies when that window does;
//   - a live `valid: false` overwrites the positive entry at once — the cache never resurrects a key
//     the backend just revoked;
//   - outage-serving is scoped to AUTH_INTROSPECT_UNAVAILABLE alone — a backend that REFUSES our
//     internal key (REJECTED) must not be papered over by a cached verdict;
//   - the replayed verdict carries the introspected identity (agent_id / auth_source / is_active), so
//     a cached deactivated agent still 403s;
//   - the instant refusals (missing key, malformed key) never touch introspection or the cache.
// Route tests prove the door's observable outcomes; the TTL boundaries and the no-life-extension rule
// need a deterministic clock, so the cache functions are driven directly via _debug with explicit nowMs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };

const INTROSPECT_BASE = 'https://auth.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
// Introspection config present => shouldBypassInvokeAuthForTest() is OFF and the real auth path runs.
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
process.env.AGENT_AUTH_INTROSPECT_TIMEOUT_MS = '800';
// Minimum fresh window so route tests can lapse it with a ~1.2s sleep instead of a minute.
process.env.AGENT_AUTH_CACHE_POSITIVE_TTL_MS = '1000';
// Deliberately DEMAND five minutes: the snapshot test below proves the clamp refuses it.
process.env.AGENT_AUTH_CACHE_NEGATIVE_TTL_MS = '300000';
process.env.AGENT_AUTH_CACHE_STALE_IF_ERROR_TTL_MS = '60000';
process.env.AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED = 'false';
// Set (not deleted — dotenv at server.js:6 refills deleted vars) to a value no test key equals, so
// the configured-service-key fast path can never capture a test request.
process.env.PIVOTA_API_KEY = 'test-token';

const app = require('../src/server');
const {
  invokeAuthCache,
  getCachedInvokeAuthResult,
  putCachedInvokeAuthResult,
  getOutageServableInvokeAuthResult,
  agentAuthCacheTtlSnapshot,
  shouldPreferInternalInvokeUpstreamAuth,
  INVOKE_AUTH_CONTEXT,
} = app._debug;

test.after(() => {
  nock.cleanAll();
  process.env = { ...ORIGINAL_ENV };
});

test.beforeEach(() => {
  nock.cleanAll();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const key = (ch) => `ak_live_${String(ch).repeat(64)}`;
const cacheHashOf = (apiKey) => createHash('sha256').update(String(apiKey).trim()).digest('hex');

const introspectOk = (apiKey, overrides = {}) =>
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH, (body) => body?.api_key === apiKey)
    .matchHeader('X-Internal-Key', 'internal_test_key')
    .reply(200, {
      valid: true,
      agent_id: 'agent_partner_1',
      is_active: true,
      auth_source: 'api_keys',
      ...overrides,
    });

// A REAL timeout, not a synthesized error: the reply outlives axios's 800ms budget, so axios itself
// aborts with ECONNABORTED — the same shape the incident produced. (Also sidesteps nock 14's
// replyWithError, which rejects a plain {code, message} object.)
const introspectTimeout = () =>
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH)
    .matchHeader('X-Internal-Key', 'internal_test_key')
    .delay(2_000)
    .reply(200, { valid: true, agent_id: 'agent_never_arrives', is_active: true });

const invoke = (apiKey) =>
  supertest(app).post('/agent/shop/v1/invoke').set('X-Agent-API-Key', apiKey).send({});

// ---- 1. the door, over the wire --------------------------------------------------------------------

test('a cold cache stays honest: outage with no prior verdict is still 503', async () => {
  const scope = introspectTimeout();
  const res = await invoke(key('1'));
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'AUTH_INTROSPECT_UNAVAILABLE');
  assert.equal(scope.isDone(), true);
});

test('a verified key keeps working through an introspection timeout after the fresh window lapses', async () => {
  const partnerKey = key('2');

  const warm = introspectOk(partnerKey);
  const warmRes = await invoke(partnerKey);
  // 400 INVALID_REQUEST means auth PASSED and the empty body was rejected downstream.
  assert.equal(warmRes.status, 400);
  assert.equal(warmRes.body.error, 'INVALID_REQUEST');
  assert.equal(warm.isDone(), true);

  // Lapse the 1s fresh window so the next request MUST attempt live introspection.
  await sleep(1200);

  const outage = introspectTimeout();
  const outageRes = await invoke(partnerKey);
  assert.equal(outageRes.status, 400);
  assert.equal(outageRes.body.error, 'INVALID_REQUEST');
  // The introspection attempt really happened — this was the stale-if-error path, not a fresh hit.
  assert.equal(outage.isDone(), true);
});

test('the same failure with a 5xx upstream (the incident shape) is also served from the cached verdict', async () => {
  const partnerKey = key('3');

  introspectOk(partnerKey);
  assert.equal((await invoke(partnerKey)).status, 400);

  await sleep(1200);

  const outage = nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH)
    .matchHeader('X-Internal-Key', 'internal_test_key')
    .reply(503, { error: 'UPSTREAM_DOWN' });
  const res = await invoke(partnerKey);
  assert.equal(res.status, 400);
  assert.equal(outage.isDone(), true);
});

test('a live revocation wins instantly over the cached positive verdict, and sticks through a following outage', async () => {
  const partnerKey = key('4');

  introspectOk(partnerKey);
  assert.equal((await invoke(partnerKey)).status, 400);

  await sleep(1200);

  // Backend is UP and says the key is revoked: 401, no rescue from the still-warm positive entry.
  const revoked = nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH)
    .matchHeader('X-Internal-Key', 'internal_test_key')
    .reply(200, { valid: false, agent_id: null, is_active: false, auth_source: 'api_keys' });
  const revokedRes = await invoke(partnerKey);
  assert.equal(revokedRes.status, 401);
  assert.equal(revoked.isDone(), true);

  // The negative verdict overwrote the positive entry: an immediate outage must refuse too — served
  // as a cached refusal (401), never resurrected from the older positive verdict (400 here = hole).
  const afterRes = await invoke(partnerKey);
  assert.equal(afterRes.status, 401);
});

test('REJECTED introspection (backend refuses OUR internal key) is never papered over by a cached verdict', async () => {
  const partnerKey = key('5');

  introspectOk(partnerKey);
  assert.equal((await invoke(partnerKey)).status, 400);

  await sleep(1200);

  const rejected = nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH)
    .matchHeader('X-Internal-Key', 'internal_test_key')
    .reply(401, { error: 'BAD_INTERNAL_KEY' });
  const res = await invoke(partnerKey);
  assert.equal(res.status, 503);
  assert.equal(rejected.isDone(), true);
});

test('an unexpected CODELESS throw fails closed — it is not an outage, even with a warm verdict', async () => {
  const partnerKey = key('8');

  introspectOk(partnerKey);
  assert.equal((await invoke(partnerKey)).status, 400);
  await sleep(1200);

  // Everything inside the middleware's try — the cache read, the response parse, the cache write —
  // can throw WITHOUT a `code`. Simulate one by making the cache Map throw exactly once, on the read
  // that introspectInvokeApiKey does first. `code` is undefined, so the door must REFUSE (503) and
  // must not treat it as an introspection outage; the warm verdict is still there, and a 400 here
  // would mean an unrelated TypeError had just authenticated a caller from cache.
  const realGet = invokeAuthCache.get;
  let thrown = false;
  invokeAuthCache.get = function patchedGet(...args) {
    if (!thrown) {
      thrown = true;
      throw new Error('simulated codeless failure inside the introspection try scope');
    }
    return realGet.apply(this, args);
  };
  try {
    const res = await invoke(partnerKey);
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'AUTH_INTROSPECT_UNAVAILABLE');
    assert.equal(thrown, true, 'the patched read must actually have been exercised');
  } finally {
    invokeAuthCache.get = realGet;
  }
});

test('a cached verdict for a deactivated agent still 403s during an outage', async () => {
  const partnerKey = key('6');

  introspectOk(partnerKey, { is_active: false });
  const first = await invoke(partnerKey);
  assert.equal(first.status, 403);
  assert.equal(first.body.error, 'FORBIDDEN');

  await sleep(1200);

  introspectTimeout();
  const res = await invoke(partnerKey);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'FORBIDDEN');
});

test('malformed and missing keys refuse instantly without touching introspection or the cache', async () => {
  // Reply 200 valid so that if the format gate ever routed this key to introspection, the response
  // would flip to 400 and the scope would be consumed — both assertions below would fail.
  const scope = nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH)
    .reply(200, { valid: true, agent_id: 'agent_never', is_active: true, auth_source: 'api_keys' });

  const malformed = await invoke('invalid_key');
  assert.equal(malformed.status, 401);
  assert.equal(malformed.body.error, 'UNAUTHORIZED');

  const missing = await supertest(app).post('/agent/shop/v1/invoke').send({});
  assert.equal(missing.status, 401);

  assert.equal(scope.isDone(), false);
  assert.equal(invokeAuthCache.has(cacheHashOf('invalid_key')), false);
});

// ---- 2. the TTL rules, on a deterministic clock ----------------------------------------------------

// Far-future base so route-era prunes (which run at real Date.now()) can never collect these entries
// mid-test. The converse is NOT true and must not be claimed: a unit-era write calls
// pruneInvokeAuthCache(T0), which collects every route-era entry. That is harmless only because
// node:test runs these top-level tests in declaration order and the route block above has already
// finished — so keep the route tests above this line.
const T0 = 4_000_000_000_000;
const POSITIVE = { valid: true, agent_id: 'agent_x', is_active: true, auth_source: 'api_keys' };

test('config clamps: the negative TTL refuses to exceed 10s no matter what env demands', () => {
  const snap = agentAuthCacheTtlSnapshot();
  assert.equal(snap.positive_ttl_ms, 1_000);
  // Env demanded 300000 above; anything past 10s here is the clamp regressed.
  assert.equal(snap.negative_ttl_ms, 10_000);
  assert.equal(snap.stale_if_error_ttl_ms, 60_000);
});

test('a positive verdict is direct-served only inside the fresh window, but survives it for the outage path', () => {
  const k = 'unit-key-fresh-boundary';
  putCachedInvokeAuthResult(k, POSITIVE, T0);

  const fresh = getCachedInvokeAuthResult(k, T0 + 999);
  assert.equal(fresh?.valid, true);
  assert.equal(fresh?.agent_id, 'agent_x');
  assert.equal(fresh?.cache_hit, true);

  // At the boundary the direct serve stops…
  assert.equal(getCachedInvokeAuthResult(k, T0 + 1_000), null);
  // …but the entry was retained: the outage path can still see it.
  const stale = getOutageServableInvokeAuthResult(k, T0 + 1_000);
  assert.equal(stale?.valid, true);
});

test('the outage-served verdict carries the introspected identity, replay markers, and its age', () => {
  const k = 'unit-key-identity';
  putCachedInvokeAuthResult(
    k,
    { valid: true, agent_id: 'agent_tier_gold', is_active: true, auth_source: 'api_keys' },
    T0,
  );

  const v = getOutageServableInvokeAuthResult(k, T0 + 59_999);
  assert.equal(v.valid, true);
  assert.equal(v.agent_id, 'agent_tier_gold');
  assert.equal(v.is_active, true);
  assert.equal(v.auth_source, 'api_keys');
  assert.equal(v.cache_hit, true);
  assert.equal(v.auth_replayed, true);
  assert.equal(v.auth_replayed_reason, 'introspect_unavailable_cached_verdict');
  assert.equal(v.verdict_age_ms, 59_999);
});

test('verdict_age_ms reports an age, never the raw epoch, when minted_at_ms is absent', () => {
  // The field must be DELETED, not set to 0: `?? nowMs` and `|| 0` produce the identical answer for
  // a 0, so a test that writes 0 asserts nothing and lets the epoch bug back in. (This test was
  // written that way first; the mutant that restores `|| 0` survived it and exposed the hole.)
  const k = 'unit-key-epoch-guard';
  putCachedInvokeAuthResult(k, POSITIVE, T0);
  delete invokeAuthCache.get(cacheHashOf(k)).minted_at_ms;
  assert.equal(getOutageServableInvokeAuthResult(k, T0 + 5).verdict_age_ms, 0);
});

test('the outage window is a hard stop measured from mint, and serving does not extend it', () => {
  const k = 'unit-key-hard-stop';
  putCachedInvokeAuthResult(k, POSITIVE, T0);

  // A mid-window serve…
  assert.equal(getOutageServableInvokeAuthResult(k, T0 + 30_000)?.valid, true);
  // …must not push the horizon: at mint + stale TTL the verdict is dead and the entry gone.
  assert.equal(getOutageServableInvokeAuthResult(k, T0 + 60_000), null);
  assert.equal(invokeAuthCache.has(cacheHashOf(k)), false);
});

test('a deactivated agent in the cached verdict stays deactivated when outage-served', () => {
  const k = 'unit-key-inactive';
  putCachedInvokeAuthResult(k, { ...POSITIVE, is_active: false }, T0);
  const v = getOutageServableInvokeAuthResult(k, T0 + 1);
  // Served (valid), but with is_active preserved so the middleware's 403 check still fires.
  assert.equal(v?.valid, true);
  assert.equal(v?.is_active, false);
});

test('a negative verdict is NEVER outage-servable and its entry dies at the clamped fresh horizon', () => {
  const k = 'unit-key-negative';
  putCachedInvokeAuthResult(k, { valid: false, agent_id: null, is_active: false }, T0);

  // Not servable one millisecond in, nor anywhere inside its own fresh window.
  assert.equal(getOutageServableInvokeAuthResult(k, T0 + 1), null);
  assert.equal(getOutageServableInvokeAuthResult(k, T0 + 9_999), null);

  // Inside the window it IS direct-served — as a fast refusal.
  assert.equal(getCachedInvokeAuthResult(k, T0 + 9_999)?.valid, false);

  // Negatives get NO stale window: at the clamped 10s horizon the ENTRY is gone from the map, not
  // merely masked by the valid-check — a retained negative entry is the mutant this line exists for.
  assert.equal(getCachedInvokeAuthResult(k, T0 + 10_000), null);
  assert.equal(invokeAuthCache.has(cacheHashOf(k)), false);
});

test('a fresh negative verdict overwrites the positive entry: revocation is never resurrected', () => {
  const k = 'unit-key-rotation';
  putCachedInvokeAuthResult(k, POSITIVE, T0);
  assert.equal(getOutageServableInvokeAuthResult(k, T0 + 100)?.valid, true);

  // Live introspection observed the revocation…
  putCachedInvokeAuthResult(k, { valid: false, agent_id: null, is_active: false }, T0 + 500);
  // …and from that instant the outage path has nothing to serve.
  assert.equal(getOutageServableInvokeAuthResult(k, T0 + 600), null);
});

// ---- 3. the replay must not become a credential swap -----------------------------------------------

// THE assertion this feature most needs and the one a route-status test cannot make. `auth_degraded`
// is not a label: shouldPreferInternalInvokeUpstreamAuth reads it, and a true value makes
// buildInvokeUpstreamAuthHeaders send PIVOTA_API_KEY — the gateway's own service credential —
// upstream INSTEAD of the caller's key, at every site passing preferInternalFallback (PDP
// revalidation, product-detail/variant/product-group resolve, the recommend_products price check).
// Marking a replayed verdict degraded would therefore strip per-agent scoping, quota and audit
// attribution from every partner request for the length of an outage, while every status code in
// this file stayed green.
test('a replayed verdict never flips the upstream credential to the gateway service key', () => {
  const replayed = {
    key_fingerprint: 'ffff', auth_source: 'x-agent-api-key', auth_mode: 'api_key',
    agent_id: 'agent_partner_1', api_key: key('2'),
    auth_degraded: false, auth_degraded_reason: null,
    auth_replayed: true, auth_replayed_reason: 'introspect_unavailable_cached_verdict',
  };
  INVOKE_AUTH_CONTEXT.run(replayed, () => {
    // preferInternalFallback is what the eight PDP/product call sites pass.
    assert.equal(shouldPreferInternalInvokeUpstreamAuth(true), false);
  });

  // The contrast that proves the assertion above has teeth: the EMERGENCY fallback — which cannot
  // identify its caller — is exactly the case that SHOULD swap in the service credential.
  INVOKE_AUTH_CONTEXT.run({ ...replayed, auth_degraded: true }, () => {
    assert.equal(shouldPreferInternalInvokeUpstreamAuth(true), true);
  });
});

test('the outage verdict carries a replay marker and NOT the degraded actuator', () => {
  const k = 'unit-key-marker';
  putCachedInvokeAuthResult(k, POSITIVE, T0);
  const v = getOutageServableInvokeAuthResult(k, T0 + 1);
  assert.equal(v.auth_replayed, true);
  assert.equal(v.auth_replayed_reason, 'introspect_unavailable_cached_verdict');
  assert.equal(v.auth_degraded, undefined);
  assert.equal(v.auth_degraded_reason, undefined);
});

// ---- 4. the backend's own failures must not poison the cache ---------------------------------------

test('a soft backend error (200 valid:false auth_source:error) never overwrites the positive entry', async () => {
  const partnerKey = key('7');

  introspectOk(partnerKey);
  assert.equal((await invoke(partnerKey)).status, 400);

  await sleep(1200);

  // The saturated backend answers, but reports ITS OWN failure rather than a verdict about the key.
  const soft = nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH)
    .matchHeader('X-Internal-Key', 'internal_test_key')
    .reply(200, { valid: false, agent_id: null, is_active: false, auth_source: 'error' });
  const softRes = await invoke(partnerKey);
  // This request itself is still refused — the refusal path is untouched.
  assert.equal(softRes.status, 401);
  assert.equal(soft.isDone(), true);

  // …but the good verdict must SURVIVE it. Caching that error as a negative would delete the replay
  // window, so the next request — a real timeout — would 503 a valid partner key: the incident this
  // whole feature exists to prevent, reproduced by a softer flavour of the same backend illness.
  introspectTimeout();
  const outageRes = await invoke(partnerKey);
  assert.equal(outageRes.status, 400);
});

test('a genuine revocation (valid:false, real auth_source) DOES overwrite — the fix above is scoped', () => {
  const k = 'unit-key-real-revocation';
  putCachedInvokeAuthResult(k, POSITIVE, T0);
  putCachedInvokeAuthResult(
    k,
    { valid: false, agent_id: null, is_active: false, auth_source: 'api_keys' },
    T0 + 100,
  );
  assert.equal(getOutageServableInvokeAuthResult(k, T0 + 200), null);
});

// ---- 5. the kill switch ----------------------------------------------------------------------------

// The TTL constants bind at module load, so an in-process test cannot change them — it would assert
// against the values THIS process already froze. Drive a real child process per env value instead.
function ttlSnapshotUnderEnv(staleEnvValue) {
  const script = `
    process.env.NODE_ENV = 'test';
    process.env.AGENT_AUTH_INTROSPECT_URL = ${JSON.stringify(`${INTROSPECT_BASE}${INTROSPECT_PATH}`)};
    process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
    process.env.AGENT_AUTH_CACHE_POSITIVE_TTL_MS = '1000';
    ${
      staleEnvValue === undefined
        ? "delete process.env.AGENT_AUTH_CACHE_STALE_IF_ERROR_TTL_MS;"
        : `process.env.AGENT_AUTH_CACHE_STALE_IF_ERROR_TTL_MS = ${JSON.stringify(staleEnvValue)};`
    }
    const app = require(${JSON.stringify(require.resolve('../src/server'))});
    const snap = app._debug.agentAuthCacheTtlSnapshot();
    const put = app._debug.putCachedInvokeAuthResult;
    const outage = app._debug.getOutageServableInvokeAuthResult;
    // ONE KEY PER PROBE, deliberately. getOutageServableInvokeAuthResult DELETES an entry it finds
    // past the stale horizon, so a single shared key would let the first probe (at 2000) evict the
    // entry and leave the second probe (at 1500) reading an empty cache — an assertion that cannot
    // fail. That is exactly how this test first passed against a mutant that removed the guard.
    const verdict = { valid: true, agent_id: 'a', is_active: true };
    put('probe-past-fresh', verdict, 1000);
    put('probe-inside-fresh', verdict, 1000);
    process.stdout.write('<<SNAP' + JSON.stringify({
      snap,
      // Positive TTL is 1000 here, so each entry's FRESH horizon is 2000.
      replayable: outage('probe-past-fresh', 2000) !== null,
      // …and this probes INSIDE that window, on its own untouched entry. A disabled switch must
      // refuse here too: the collapsed stale horizon does not cover this instant, so only the
      // reader's own guard does. Without this the guard is unkillable and therefore untested.
      replayable_inside_fresh_window: outage('probe-inside-fresh', 1500) !== null,
    }) + 'SNAP>>');
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: require('path').join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 60_000,
  });
  // The booted server logs its own JSON lines to stdout, so fence the payload rather than parsing
  // the whole stream — an unfenced JSON.parse fails on the first pino line and reads as a real bug.
  const fenced = out.match(/<<SNAP([\s\S]*?)SNAP>>/);
  assert.ok(fenced, `child produced no snapshot payload; stdout was:\n${out.slice(0, 400)}`);
  return JSON.parse(fenced[1]);
}

test('AGENT_AUTH_CACHE_STALE_IF_ERROR_TTL_MS=0 disables replay instead of meaning "use the default"', () => {
  // parsePositiveInt returns its FALLBACK for any non-positive input, so a bare `=0` would otherwise
  // arm the full 120s window — the exact opposite of what an operator typing 0 mid-incident wants.
  const off = ttlSnapshotUnderEnv('0');
  assert.equal(off.snap.stale_if_error_disabled, true);
  assert.equal(off.snap.stale_if_error_ttl_ms, 0);
  assert.equal(off.replayable, false, 'a disabled window must leave nothing replayable');
  assert.equal(
    off.replayable_inside_fresh_window,
    false,
    'a disabled switch must refuse at EVERY instant, not only past the fresh horizon',
  );

  for (const word of ['off', 'false', 'no', 'disabled']) {
    assert.equal(ttlSnapshotUnderEnv(word).snap.stale_if_error_ttl_ms, 0, `"${word}" must disable`);
  }
});

test('an unset or normal stale TTL leaves replay armed — the kill switch is not always-on', () => {
  const unset = ttlSnapshotUnderEnv(undefined);
  assert.equal(unset.snap.stale_if_error_disabled, false);
  assert.equal(unset.snap.stale_if_error_ttl_ms, 120_000);
  assert.equal(unset.replayable, true);
  assert.equal(unset.replayable_inside_fresh_window, true);

  const set = ttlSnapshotUnderEnv('30000');
  assert.equal(set.snap.stale_if_error_ttl_ms, 30_000);
  assert.equal(set.replayable, true);
});
