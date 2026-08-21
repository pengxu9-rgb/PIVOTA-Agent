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
// mid-test, and unit-era prunes (at T0-relative times) can never collect route-era entries.
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

test('the outage-served verdict carries the introspected identity, degraded markers, and its age', () => {
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
  assert.equal(v.auth_degraded, true);
  assert.equal(v.auth_degraded_reason, 'introspect_unavailable_cached_verdict');
  assert.equal(v.verdict_age_ms, 59_999);
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
