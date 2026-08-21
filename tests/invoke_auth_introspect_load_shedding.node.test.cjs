'use strict';

// The invoke-auth introspection load-shedding contract: the fail-fast cooldown and the single-flight
// coalescer, plus the refusals neither may weaken.
//
// WHY THIS FILE EXISTS. #2055 made a verified partner key survive a backend introspection outage by
// replaying a cached verdict — but every request still dialled first and paid the FULL introspect
// timeout (10s in prod) before reaching a verdict already sitting in a Map, and N concurrent
// requests for one key each opened their own connection to ask a question with one answer. axios
// shares ONE 128-socket agent per origin with every other backend call, so above ~13 rps of that
// traffic the socket budget for the entire gateway→backend lane is consumed by dials we already
// know will fail. This suite pins the two mechanisms that fix it, and — more importantly — the
// things they must NOT do:
//   - the cooldown NEVER licenses more than the outage already did: a cold cache still 503s, an
//     invalid key still 401s, and REJECTED (backend up, refusing OUR internal key) must never open
//     the cooldown, because the synthetic error it throws is AUTH_INTROSPECT_UNAVAILABLE and that
//     code is what licenses verdict replay;
//   - single flight is keyed on the FULL sha256 of the key, so two DIFFERENT keys in flight at the
//     same instant can never be handed each other's identity;
//   - a warm fresh-cache hit is untouched by either gate;
//   - the in-flight entry is always evicted, including when the dial fails.
// Dial counts are the assertion of record: a coalesced request and a duplicated one both return the
// same status, so status alone proves nothing here.

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
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
process.env.AGENT_AUTH_INTROSPECT_TIMEOUT_MS = '800';
process.env.AGENT_AUTH_CACHE_POSITIVE_TTL_MS = '1000';
process.env.AGENT_AUTH_CACHE_NEGATIVE_TTL_MS = '1000';
process.env.AGENT_AUTH_CACHE_STALE_IF_ERROR_TTL_MS = '60000';
process.env.AGENT_AUTH_INTROSPECT_COOLDOWN_MS = '2000';
process.env.AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED = 'false';
// Set (not deleted — dotenv at server.js:6 refills a deleted var) to a value no test key equals.
process.env.PIVOTA_API_KEY = 'test-token';

const app = require('../src/server');
const {
  invokeAuthCache,
  invokeAuthIntrospectInflight,
  isInvokeAuthIntrospectCooldownActive,
  openInvokeAuthIntrospectCooldown,
  clearInvokeAuthIntrospectCooldown,
  agentAuthCacheTtlSnapshot,
  introspectInvokeApiKey,
} = app._debug;

test.after(() => {
  nock.cleanAll();
  process.env = { ...ORIGINAL_ENV };
});

// The cooldown is process-global by design, so every test starts from a closed one and an empty
// cache — otherwise a passing test could simply be inheriting a previous test's shed.
test.beforeEach(() => {
  nock.cleanAll();
  clearInvokeAuthIntrospectCooldown();
  invokeAuthIntrospectInflight.clear();
  invokeAuthCache.clear();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const key = (ch) => `ak_live_${String(ch).repeat(64)}`;
const cacheHashOf = (apiKey) => createHash('sha256').update(String(apiKey).trim()).digest('hex');
const invoke = (apiKey) =>
  supertest(app).post('/agent/shop/v1/invoke').set('X-Agent-API-Key', apiKey).send({});

// A counting interceptor: `dials` is the number of times the wire was actually touched, which is the
// only honest measure of coalescing and shedding.
function countingIntrospect({ replyFn, times = 50 }) {
  const state = { dials: 0 };
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH)
    .times(times)
    .reply(function reply(uri, body) {
      state.dials += 1;
      return replyFn(body, state.dials);
    });
  return state;
}

const okFor = (agentId) => [200, { valid: true, agent_id: agentId, is_active: true, auth_source: 'api_keys' }];

// ---- 1. single flight ------------------------------------------------------------------------------

test('concurrent requests for ONE key share a single introspection dial', async () => {
  const partnerKey = key('1');
  const state = countingIntrospect({ replyFn: () => okFor('agent_one') });

  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => invoke(partnerKey)));

  // Every caller is authenticated (400 = auth passed, empty body refused downstream)…
  for (const res of results) assert.equal(res.status, 400, 'every coalesced caller must be served');
  // …from ONE dial. Six here is the pre-fix behaviour.
  assert.equal(state.dials, 1, `expected 1 dial, got ${state.dials}`);
});

test('two DIFFERENT keys in flight together never share a verdict', async () => {
  // THE security assertion of this file. Keying the flight map on anything coarser than the full
  // key hash — a truncated fingerprint, a constant, the route — would coalesce these two and hand
  // one caller the other's identity, with both requests returning a perfectly normal status.
  const keyA = key('2');
  const keyB = key('3');
  const seen = [];
  const state = countingIntrospect({
    replyFn: (body) => {
      seen.push(body?.api_key);
      return body?.api_key === keyA ? okFor('agent_alpha') : okFor('agent_beta');
    },
  });

  const [resA, resB] = await Promise.all([invoke(keyA), invoke(keyB)]);
  assert.equal(resA.status, 400);
  assert.equal(resB.status, 400);

  // Each key was asked about on its own, so neither can be carrying the other's agent_id.
  assert.equal(state.dials, 2, 'distinct keys must NOT be coalesced');
  assert.ok(seen.includes(keyA) && seen.includes(keyB), 'both keys must reach the backend');

  // And the cache proves the identities did not cross.
  assert.equal(invokeAuthCache.get(cacheHashOf(keyA)).result.agent_id, 'agent_alpha');
  assert.equal(invokeAuthCache.get(cacheHashOf(keyB)).result.agent_id, 'agent_beta');
});

test('the in-flight entry is evicted after success AND after failure', async () => {
  const okKey = key('4');
  countingIntrospect({ replyFn: () => okFor('agent_ok') });
  await invoke(okKey);
  assert.equal(invokeAuthIntrospectInflight.size, 0, 'a settled success must not stay in the map');

  nock.cleanAll();
  clearInvokeAuthIntrospectCooldown();
  const failKey = key('5');
  countingIntrospect({ replyFn: () => [503, { error: 'UPSTREAM_DOWN' }] });
  await invoke(failKey);
  // A rejected flight that stayed in the map would hand every later request for this key the same
  // dead promise for the life of the process — the failure mode this repo already paid for once.
  assert.equal(invokeAuthIntrospectInflight.size, 0, 'a settled failure must not stay in the map');
});

// ---- 2. the fail-fast cooldown ---------------------------------------------------------------------

test('after an outage the door stops dialling and serves the cached verdict without touching the wire', async () => {
  const partnerKey = key('6');

  // Warm a real verdict.
  const warm = countingIntrospect({ replyFn: () => okFor('agent_warm') });
  assert.equal((await invoke(partnerKey)).status, 400);
  assert.equal(warm.dials, 1);

  await sleep(1200); // lapse the fresh window so the next request must attempt a dial
  nock.cleanAll();

  // One failing dial opens the cooldown…
  const outage = countingIntrospect({ replyFn: () => [503, { error: 'UPSTREAM_DOWN' }] });
  assert.equal((await invoke(partnerKey)).status, 400, 'served from the stale verdict');
  assert.equal(outage.dials, 1);
  assert.equal(isInvokeAuthIntrospectCooldownActive(), true, 'the outage must open the cooldown');

  // …and the next requests are served WITHOUT touching the wire at all. Pre-fix each of these cost
  // a full introspect timeout and a socket from the shared pool.
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await invoke(partnerKey)).status, 400);
  }
  assert.equal(outage.dials, 1, `expected no further dials, got ${outage.dials}`);
});

test('a cold cache still 503s while the cooldown is open — shedding never invents an identity', async () => {
  // The cooldown makes the refusal FASTER, never softer. A key with no cached verdict has nothing
  // to replay, so it must still be refused.
  openInvokeAuthIntrospectCooldown();
  const state = countingIntrospect({ replyFn: () => okFor('agent_never') });

  const res = await invoke(key('7'));
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'AUTH_INTROSPECT_UNAVAILABLE');
  assert.equal(state.dials, 0, 'the cooldown must skip the dial');
});

test('an invalid key still 401s instantly while the cooldown is open', async () => {
  openInvokeAuthIntrospectCooldown();
  const state = countingIntrospect({ replyFn: () => okFor('agent_never') });

  const malformed = await invoke('invalid_key');
  assert.equal(malformed.status, 401);
  const missing = await supertest(app).post('/agent/shop/v1/invoke').send({});
  assert.equal(missing.status, 401);
  assert.equal(state.dials, 0);
});

test('a warm fresh-cache hit is served even with the cooldown open — the gate sits BELOW the cache', async () => {
  const partnerKey = key('8');
  const state = countingIntrospect({ replyFn: () => okFor('agent_fresh') });
  assert.equal((await invoke(partnerKey)).status, 400);
  assert.equal(state.dials, 1);

  // Cooldown open, but the entry is still INSIDE its fresh window: this must be a normal serve, not
  // a degraded replay, and must not dial.
  openInvokeAuthIntrospectCooldown();
  assert.equal((await invoke(partnerKey)).status, 400);
  assert.equal(state.dials, 1);
});

test('a dial that succeeds AFTER the cooldown opened closes it — positive evidence ends the shed', async () => {
  // The only state in which closing-on-success is observable, and therefore the only honest way to
  // test it. Once the cooldown is open no NEW dial starts, so a success can only arrive from a dial
  // that was already in flight when some other key's dial failed. That success is direct evidence
  // the backend is alive, and it must end the shed immediately rather than making every caller wait
  // out a window we now know is wrong.
  // (An earlier version of this test cleared the cooldown by hand before dialling, which made the
  // final assertion true no matter what the code did — the mutant that deleted the close survived
  // it.)
  const slowKey = key('9');
  const failingKey = key('d');

  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH, (body) => body?.api_key === slowKey)
    .delay(300)
    .reply(...okFor('agent_recovered'));
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH, (body) => body?.api_key === failingKey)
    .reply(503, { error: 'UPSTREAM_DOWN' });

  // `.then()` is what actually FIRES a supertest request — building it does not. Without this the
  // "slow" dial would not start until awaited, i.e. after the cooldown had already opened, and it
  // would be shed rather than landing: the test would then be staging the opposite scenario.
  const slowPending = invoke(slowKey).then((res) => res);
  await sleep(60); // let the slow dial genuinely leave before anything fails

  // Now open the cooldown underneath the in-flight healthy dial.
  const failed = await invoke(failingKey);
  assert.equal(failed.status, 503, 'cold cache + outage is still a refusal');
  assert.equal(isInvokeAuthIntrospectCooldownActive(), true, 'the failure must open the cooldown');

  assert.equal((await slowPending).status, 400, 'the in-flight healthy dial still lands');
  assert.equal(
    isInvokeAuthIntrospectCooldownActive(),
    false,
    'a success proves the backend is alive and must close the cooldown',
  );
});

test('a network TIMEOUT opens the cooldown, not just a 5xx — the incident shape was a timeout', async () => {
  // The 2026-08-21 outage did not answer 503; it hung until axios aborted. That path throws from a
  // different branch than the status check, so it needs its own assertion or the most
  // incident-relevant trigger is the one nothing covers.
  const partnerKey = key('e');
  const warm = countingIntrospect({ replyFn: () => okFor('agent_timeout_case') });
  assert.equal((await invoke(partnerKey)).status, 400);
  assert.equal(warm.dials, 1);
  await sleep(1200);
  nock.cleanAll();

  // Outlives the 800ms axios budget, so axios aborts: a real timeout, not a synthesized error.
  // Register ONLY this interceptor — nock matches in registration order, so a counting interceptor
  // added first would answer instantly and there would be no timeout to observe at all.
  nock(INTROSPECT_BASE).post(INTROSPECT_PATH).delay(2_000).reply(...okFor('never_arrives'));

  assert.equal((await invoke(partnerKey)).status, 400, 'served from the stale verdict');
  assert.equal(
    isInvokeAuthIntrospectCooldownActive(),
    true,
    'a timeout is an outage and must open the cooldown',
  );
});

test('the cooldown gate sits BELOW the fresh-cache read, not above it', async () => {
  // Driven directly, because over the wire both orderings return 400: with the gate hoisted the
  // request throws UNAVAILABLE and is then rescued by the stale-replay path, which looks identical
  // in a status code but is a degraded serve plus a warn line for a key that needed neither.
  const partnerKey = key('f');
  const state = countingIntrospect({ replyFn: () => okFor('agent_below') });
  assert.equal((await invoke(partnerKey)).status, 400);
  assert.equal(state.dials, 1);

  openInvokeAuthIntrospectCooldown();
  const verdict = await introspectInvokeApiKey(partnerKey);
  assert.equal(verdict.valid, true);
  assert.equal(verdict.agent_id, 'agent_below');
  assert.equal(verdict.cache_hit, true, 'a fresh entry must be served as a fresh hit');
  assert.equal(verdict.auth_replayed, undefined, 'and NOT as a degraded outage replay');
  assert.equal(state.dials, 1);
});

test('the cooldown lapses on its own clock and the next request re-probes', async () => {
  const partnerKey = key('a');
  const warm = countingIntrospect({ replyFn: () => okFor('agent_probe') });
  assert.equal((await invoke(partnerKey)).status, 400);
  await sleep(1200);
  nock.cleanAll();

  const outage = countingIntrospect({ replyFn: () => [503, {}] });
  await invoke(partnerKey);
  assert.equal(outage.dials, 1);
  await invoke(partnerKey);
  assert.equal(outage.dials, 1, 'still inside the cooldown');

  // Expire it by hand rather than sleeping 2s: the point is the horizon, not the wall clock.
  clearInvokeAuthIntrospectCooldown();
  await invoke(partnerKey);
  assert.equal(outage.dials, 2, 'a lapsed cooldown must allow exactly one re-probe');
  assert.equal(warm.dials, 1);
});

// ---- 3. what must NOT open the cooldown -------------------------------------------------------------

test('REJECTED (backend up, refusing OUR internal key) never opens the cooldown', async () => {
  // This is the one that would be a security bug rather than a performance one. The cooldown throws
  // a synthetic AUTH_INTROSPECT_UNAVAILABLE, and that code is exactly what licenses verdict replay.
  // Opening it on a 401 from the backend would convert "our internal credential is misconfigured"
  // into "replay everyone's cached verdicts", which is a config error escalating into an auth
  // bypass for every warm key in the process.
  const partnerKey = key('b');
  const warm = countingIntrospect({ replyFn: () => okFor('agent_rejected_case') });
  assert.equal((await invoke(partnerKey)).status, 400);
  await sleep(1200);
  nock.cleanAll();

  const rejected = countingIntrospect({ replyFn: () => [401, { error: 'BAD_INTERNAL_KEY' }] });
  const res = await invoke(partnerKey);
  assert.equal(res.status, 503, 'REJECTED is still a refusal, never a replay');
  assert.equal(rejected.dials, 1);
  assert.equal(
    isInvokeAuthIntrospectCooldownActive(),
    false,
    'a REJECTED response must NOT open the cooldown',
  );

  // Proof the door did not start replaying: the warm verdict is still there, and the next request
  // dials again rather than being served from it.
  assert.ok(invokeAuthCache.get(cacheHashOf(partnerKey)), 'the positive entry should still exist');
  await invoke(partnerKey);
  assert.equal(rejected.dials, 2, 'without a cooldown the door keeps asking');
  assert.equal(warm.dials, 1);
});

test('a plain invalid-key verdict does not open the cooldown', async () => {
  // valid:false from a healthy backend is an answer, not an outage.
  countingIntrospect({ replyFn: () => [200, { valid: false, agent_id: null, is_active: false, auth_source: 'api_keys' }] });
  const res = await invoke(key('c'));
  assert.equal(res.status, 401);
  assert.equal(isInvokeAuthIntrospectCooldownActive(), false);
});

// ---- 4. configuration ------------------------------------------------------------------------------

test('the cooldown snapshot reflects the configured window', () => {
  const snap = agentAuthCacheTtlSnapshot();
  assert.equal(snap.introspect_cooldown_ms, 2_000);
  assert.equal(snap.introspect_cooldown_disabled, false);
});

test('AGENT_AUTH_INTROSPECT_COOLDOWN_MS=0 disables shedding instead of meaning "use the default"', () => {
  // Same trap as the stale-if-error switch: parsePositiveInt returns its FALLBACK for a 0, so a bare
  // `=0` would silently arm the 2s window. Asserted in a SUBPROCESS because the constant binds at
  // module load and this process already froze it.
  const { execFileSync } = require('child_process');
  const script = `
    process.env.NODE_ENV = 'test';
    process.env.AGENT_AUTH_INTROSPECT_URL = ${JSON.stringify(`${INTROSPECT_BASE}${INTROSPECT_PATH}`)};
    process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
    process.env.AGENT_AUTH_INTROSPECT_COOLDOWN_MS = '0';
    const app = require(${JSON.stringify(require.resolve('../src/server'))});
    const d = app._debug;
    d.openInvokeAuthIntrospectCooldown();
    process.stdout.write('<<SNAP' + JSON.stringify({
      snap: d.agentAuthCacheTtlSnapshot(),
      // A disabled switch must refuse to open at all, not merely expire quickly.
      active_after_open: d.isInvokeAuthIntrospectCooldownActive(),
    }) + 'SNAP>>');
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: require('path').join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 60_000,
  });
  // The booted server logs its own JSON lines to stdout, so fence the payload rather than parsing
  // the whole stream.
  const fenced = out.match(/<<SNAP([\s\S]*?)SNAP>>/);
  assert.ok(fenced, `child produced no payload; stdout was:\n${out.slice(0, 400)}`);
  const parsed = JSON.parse(fenced[1]);
  assert.equal(parsed.snap.introspect_cooldown_disabled, true);
  assert.equal(parsed.snap.introspect_cooldown_ms, 0);
  assert.equal(parsed.active_after_open, false, 'a disabled cooldown must never read as active');
});
