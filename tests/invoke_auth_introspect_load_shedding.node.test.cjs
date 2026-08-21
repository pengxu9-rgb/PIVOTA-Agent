'use strict';

// The invoke-auth introspection load-shedding contract: the PER-KEY fail-fast cooldown and the
// single-flight coalescer, plus the refusals neither may weaken.
//
// WHY THIS FILE EXISTS. #2055 made a verified partner key survive a backend introspection outage by
// replaying a cached verdict — but every request still dialled first and paid the FULL introspect
// timeout (10s in prod) before reaching a verdict already sitting in a Map, and N concurrent
// requests for one key each opened their own connection to ask a question with one answer. axios
// shares ONE 128-socket agent per origin with every other backend call, so above ~13 rps of that
// traffic the socket budget for the entire gateway→backend lane is consumed by doomed dials.
//
// WHY THE COOLDOWN IS PER-KEY — the load-bearing design decision here. The dial this shed suppresses
// is ALSO the dial that enforces revocation: a successful `valid: false` overwrites the cached
// positive and collapses its stale horizon. A first version of this change used ONE GLOBAL window,
// and review found two ways that weakens auth: one key's failure suppressed every other key's
// revoking dial, and because introspection is dialled PRE-authentication on unthrottled routes, an
// attacker could open the window on demand with a flood of random well-formed keys and then ride
// their own recently-revoked key for the full 120s stale cap with no revoking dial possible.
// Keying the window on the caller's own key closes both. The tests marked SECURITY hold that line;
// they fail against the global design.
//
// Dial counts are the assertion of record: a coalesced request and a duplicated one both return the
// same status, so status alone proves nothing here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };

const INTROSPECT_BASE = 'https://auth.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const COOLDOWN_MS = 1_000;

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
process.env.AGENT_AUTH_INTROSPECT_TIMEOUT_MS = '800';
process.env.AGENT_AUTH_CACHE_POSITIVE_TTL_MS = '1000';
process.env.AGENT_AUTH_CACHE_NEGATIVE_TTL_MS = '1000';
process.env.AGENT_AUTH_CACHE_STALE_IF_ERROR_TTL_MS = '60000';
process.env.AGENT_AUTH_INTROSPECT_COOLDOWN_MS = String(COOLDOWN_MS);
process.env.AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED = 'false';
// Set (not deleted — dotenv at server.js:6 refills a deleted var) to a value no test key equals.
process.env.PIVOTA_API_KEY = 'test-token';

const app = require('../src/server');
const {
  invokeAuthCache,
  invokeAuthIntrospectInflight,
  invokeAuthIntrospectCooldown,
  isInvokeAuthIntrospectCooldownActive,
  openInvokeAuthIntrospectCooldown,
  clearInvokeAuthIntrospectCooldown,
  agentAuthCacheTtlSnapshot,
  introspectInvokeApiKey,
  runBoundedInvokeAuthIntrospectFlight,
} = app._debug;

test.after(() => {
  nock.cleanAll();
  process.env = { ...ORIGINAL_ENV };
});

test.beforeEach(() => {
  nock.cleanAll();
  clearInvokeAuthIntrospectCooldown(); // no argument = clear every key
  invokeAuthIntrospectInflight.clear();
  invokeAuthCache.clear();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const key = (ch) => `ak_live_${String(ch).repeat(64)}`;
const cacheHashOf = (apiKey) => createHash('sha256').update(String(apiKey).trim()).digest('hex');
const invoke = (apiKey) =>
  supertest(app).post('/agent/shop/v1/invoke').set('X-Agent-API-Key', apiKey).send({});

// `dials` counts what the wire actually saw — the only honest measure of coalescing and shedding.
function countingIntrospect({ replyFn, times = 50 }) {
  const state = { dials: 0, keys: [] };
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH)
    .times(times)
    .reply(function reply(uri, body) {
      state.dials += 1;
      state.keys.push(body?.api_key);
      return replyFn(body, state.dials);
    });
  return state;
}

const okFor = (agentId) => [
  200,
  { valid: true, agent_id: agentId, is_active: true, auth_source: 'api_keys' },
];
const REVOKED = [200, { valid: false, agent_id: null, is_active: false, auth_source: 'api_keys' }];

// Warm a real positive verdict for `k`, then lapse its fresh window so the next request must dial.
async function warmThenLapse(k, agentId = 'agent_warm') {
  const warm = countingIntrospect({ replyFn: () => okFor(agentId) });
  assert.equal((await invoke(k)).status, 400, 'warm-up must authenticate');
  assert.equal(warm.dials, 1);
  await sleep(1200);
  nock.cleanAll();
}

// ---- 1. single flight ------------------------------------------------------------------------------

test('concurrent requests for ONE key share a single introspection dial', async () => {
  const partnerKey = key('1');
  const state = countingIntrospect({ replyFn: () => okFor('agent_one') });

  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => invoke(partnerKey)));

  for (const res of results) assert.equal(res.status, 400, 'every coalesced caller must be served');
  assert.equal(state.dials, 1, `expected 1 dial, got ${state.dials}`);
});

test('two DIFFERENT keys in flight together never share a verdict', async () => {
  // Keying the flight map on anything coarser than the full key hash would coalesce these two and
  // hand one caller the other's identity, with both requests returning a perfectly normal status.
  const keyA = key('2');
  const keyB = key('3');
  const state = countingIntrospect({
    replyFn: (body) => (body?.api_key === keyA ? okFor('agent_alpha') : okFor('agent_beta')),
  });

  const [resA, resB] = await Promise.all([invoke(keyA), invoke(keyB)]);
  assert.equal(resA.status, 400);
  assert.equal(resB.status, 400);
  assert.equal(state.dials, 2, 'distinct keys must NOT be coalesced');
  assert.equal(invokeAuthCache.get(cacheHashOf(keyA)).result.agent_id, 'agent_alpha');
  assert.equal(invokeAuthCache.get(cacheHashOf(keyB)).result.agent_id, 'agent_beta');
});

test('the in-flight entry is evicted after success AND after failure', async () => {
  countingIntrospect({ replyFn: () => okFor('agent_ok') });
  await invoke(key('4'));
  assert.equal(invokeAuthIntrospectInflight.size, 0, 'a settled success must not stay in the map');

  nock.cleanAll();
  countingIntrospect({ replyFn: () => [503, { error: 'UPSTREAM_DOWN' }] });
  await invoke(key('5'));
  // A rejected flight left in the map would hand every later request for this key the same dead
  // promise for the life of the process — the failure mode this repo already paid for once.
  assert.equal(invokeAuthIntrospectInflight.size, 0, 'a settled failure must not stay in the map');
});

test('a request joins an in-flight dial for its own key even while that key is shed', async () => {
  // The join must sit ABOVE the shed gate. Riding a dial already in the air costs nothing at the
  // wire, and that dial is the authoritative answer for this key — possibly the valid:false that
  // revokes it. Shedding ahead of the join would refuse a request the process is about to answer.
  const partnerKey = key('6');
  openInvokeAuthIntrospectCooldown(partnerKey); // key is shed…
  const state = countingIntrospect({ replyFn: () => okFor('agent_join') });
  // …but a flight already exists, seeded directly so there is no race to lose.
  const seeded = runBoundedInvokeAuthIntrospectFlight(partnerKey);
  invokeAuthIntrospectInflight.set(cacheHashOf(partnerKey), seeded);

  const verdict = await introspectInvokeApiKey(partnerKey);
  assert.equal(verdict.valid, true);
  assert.equal(verdict.agent_id, 'agent_join');
  assert.equal(state.dials, 1, 'the join adds no dial of its own');
  await seeded;
});

// ---- 2. the per-key shed ---------------------------------------------------------------------------

test('after its own dial fails, a key stops dialling and is served from its cached verdict', async () => {
  const partnerKey = key('7');
  await warmThenLapse(partnerKey);

  const outage = countingIntrospect({ replyFn: () => [503, { error: 'UPSTREAM_DOWN' }] });
  assert.equal((await invoke(partnerKey)).status, 400, 'served from the stale verdict');
  assert.equal(outage.dials, 1);
  assert.equal(isInvokeAuthIntrospectCooldownActive(partnerKey), true);

  for (let i = 0; i < 5; i += 1) assert.equal((await invoke(partnerKey)).status, 400);
  assert.equal(outage.dials, 1, `expected no further dials, got ${outage.dials}`);
});

test('SECURITY: one key being shed never sheds another key', async () => {
  // The global design failed exactly here. Key A's outage must not stop key B from dialling —
  // B's dial may be the one that revokes B.
  const keyA = key('8');
  const keyB = key('9');
  await warmThenLapse(keyB, 'agent_b');

  const failA = countingIntrospect({ replyFn: () => [503, {}], times: 1 });
  await invoke(keyA);
  assert.equal(failA.dials, 1);
  assert.equal(isInvokeAuthIntrospectCooldownActive(keyA), true, 'A is shed');
  assert.equal(isInvokeAuthIntrospectCooldownActive(keyB), false, 'B must NOT be shed by A');

  const dialB = countingIntrospect({ replyFn: () => okFor('agent_b') });
  assert.equal((await invoke(keyB)).status, 400);
  assert.equal(dialB.dials, 1, 'B must still reach the wire while A is shed');
});

test('SECURITY: flooding other keys cannot stop a revoked key from being revoked', async () => {
  // The attack the global design allowed: introspection is dialled pre-auth on unthrottled routes,
  // so a flood of random well-formed keys could open the window, and the attacker's own recently
  // revoked key would then ride its stale positive for the full cap with no revoking dial possible.
  const revokedKey = key('a');
  await warmThenLapse(revokedKey, 'agent_soon_revoked');

  // The flood: many distinct random keys, every dial failing.
  const flood = countingIntrospect({ replyFn: () => [503, {}], times: 30 });
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => invoke(`ak_live_${String(i).padStart(64, 'b')}`)),
  );
  assert.ok(flood.dials >= 1, 'the flood really did fail dials');

  // The attacker's own key must still reach the backend, and the backend revokes it.
  nock.cleanAll();
  const revokeDial = countingIntrospect({ replyFn: () => REVOKED });
  const res = await invoke(revokedKey);
  assert.equal(revokeDial.dials, 1, 'the revoking dial must not be suppressed by other keys');
  assert.equal(res.status, 401, 'a revoked key must be refused, not replayed');
  // And the negative overwrote the positive, so it stays refused.
  assert.equal(invokeAuthCache.get(cacheHashOf(revokedKey)).result.valid, false);
});

test('a cold cache still 503s while that key is shed — shedding never invents an identity', async () => {
  const coldKey = key('c');
  openInvokeAuthIntrospectCooldown(coldKey);
  const state = countingIntrospect({ replyFn: () => okFor('agent_never') });

  const res = await invoke(coldKey);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'AUTH_INTROSPECT_UNAVAILABLE');
  assert.equal(state.dials, 0, 'the shed must skip the dial');
});

test('an invalid key still 401s instantly while its own cooldown is open', async () => {
  openInvokeAuthIntrospectCooldown('invalid_key');
  const state = countingIntrospect({ replyFn: () => okFor('agent_never') });

  assert.equal((await invoke('invalid_key')).status, 401);
  assert.equal((await supertest(app).post('/agent/shop/v1/invoke').send({})).status, 401);
  assert.equal(state.dials, 0);
});

test('the shed gate sits BELOW the fresh-cache read, not above it', async () => {
  // Driven directly: over the wire both orderings return 400, because with the gate hoisted the
  // request throws UNAVAILABLE and the stale-replay path rescues it — a degraded serve plus a warn
  // line, for a key that needed neither.
  const partnerKey = key('d');
  const state = countingIntrospect({ replyFn: () => okFor('agent_below') });
  assert.equal((await invoke(partnerKey)).status, 400);
  assert.equal(state.dials, 1);

  openInvokeAuthIntrospectCooldown(partnerKey);
  const verdict = await introspectInvokeApiKey(partnerKey);
  assert.equal(verdict.valid, true);
  assert.equal(verdict.agent_id, 'agent_below');
  assert.equal(verdict.cache_hit, true, 'a fresh entry must be served as a fresh hit');
  assert.equal(verdict.auth_replayed, undefined, 'and NOT as a degraded outage replay');
  assert.equal(state.dials, 1);
});

// ---- 3. the cooldown's own clock -------------------------------------------------------------------

test('the cooldown lapses on the REAL clock and the next request re-probes', async () => {
  // Every earlier version of this test expired the window by calling clear() — which meant nothing
  // ever verified that the window expires at all. A cooldown that LATCHES is the worst failure this
  // feature can have (introspection stops for the life of the process, and the clear-on-success is
  // unreachable because an open window returns before the dial), and it passed the whole suite.
  const partnerKey = key('e');
  const openedUntil = openInvokeAuthIntrospectCooldown(partnerKey);
  assert.ok(openedUntil > Date.now(), 'open() must return a future horizon');
  assert.equal(isInvokeAuthIntrospectCooldownActive(partnerKey), true);

  await sleep(COOLDOWN_MS + 250); // no manual clear: the clock does the work

  assert.equal(
    isInvokeAuthIntrospectCooldownActive(partnerKey),
    false,
    'the window must expire on its own',
  );
  const state = countingIntrospect({ replyFn: () => okFor('agent_reprobe') });
  assert.equal((await invoke(partnerKey)).status, 400);
  assert.equal(state.dials, 1, 'a lapsed window must allow a real re-probe');
});

test('the window is the CONFIGURED length, not an arbitrary one', () => {
  const k = key('f');
  const before = Date.now();
  const untilMs = openInvokeAuthIntrospectCooldown(k);
  // Pins the horizon to the configured value; a mutant that ignores the config and picks its own
  // window (e.g. an hour) passes every behavioural test in this file but fails here.
  assert.ok(
    untilMs - before >= COOLDOWN_MS - 50 && untilMs - before <= COOLDOWN_MS + 250,
    `expected ~${COOLDOWN_MS}ms window, got ${untilMs - before}ms`,
  );
  assert.equal(isInvokeAuthIntrospectCooldownActive(k, before + COOLDOWN_MS - 1), true);
  assert.equal(isInvokeAuthIntrospectCooldownActive(k, untilMs), false, 'horizon is exclusive');
});

// ---- 4. what must NOT shed -------------------------------------------------------------------------

test('REJECTED (backend up, refusing OUR internal key) never opens the cooldown', async () => {
  // The cooldown throws a synthetic AUTH_INTROSPECT_UNAVAILABLE, and that code is exactly what
  // licenses verdict replay. Opening it on a backend 401 would convert "our internal credential is
  // misconfigured" into a replay licence for every warm key in the process.
  const partnerKey = key('0');
  await warmThenLapse(partnerKey, 'agent_rejected_case');

  const rejected = countingIntrospect({ replyFn: () => [401, { error: 'BAD_INTERNAL_KEY' }] });
  assert.equal((await invoke(partnerKey)).status, 503, 'REJECTED is a refusal, never a replay');
  assert.equal(rejected.dials, 1);
  assert.equal(isInvokeAuthIntrospectCooldownActive(partnerKey), false);

  // Proof it did not start shedding: the next request dials again.
  await invoke(partnerKey);
  assert.equal(rejected.dials, 2, 'without a cooldown the door keeps asking');
});

test("a soft backend error does NOT clear that key's own cooldown", async () => {
  // 200 {valid:false, auth_source:'error'} is the backend reporting that IT failed — the same
  // illness as a hung socket, which is why it is not cached either. Clearing the shed on it made
  // mixed-mode saturation (some hangs, some soft errors) re-arm the dial storm on every soft error.
  //
  // The cooldown must be open for THE SAME KEY that receives the soft error, or the assertion is
  // vacuous under per-key semantics — a first version opened it for a different key, where the
  // per-key clear could not have touched it either way, and the mutant survived. Driven through the
  // network path directly because an open shed would otherwise refuse the request before it dials.
  const softKey = key('2');
  openInvokeAuthIntrospectCooldown(softKey);
  countingIntrospect({ replyFn: () => [200, { valid: false, auth_source: 'error' }] });

  const result = await runBoundedInvokeAuthIntrospectFlight(softKey);
  assert.equal(result.valid, false);
  assert.equal(result.auth_source, 'error');
  assert.equal(
    isInvokeAuthIntrospectCooldownActive(softKey),
    true,
    'a soft error is not evidence the backend is healthy, so the shed must stand',
  );
  // And it is still not cached, so no positive was overwritten either.
  assert.equal(invokeAuthCache.has(cacheHashOf(softKey)), false);
});

test('a network failure (not just a 5xx) opens that key\'s cooldown', async () => {
  // The 2026-08-21 outage did not answer 503 — it hung until axios aborted. That throw comes from a
  // different branch than the status check, so without its own assertion the most incident-relevant
  // trigger is the one nothing covers.
  const partnerKey = key('6');
  await warmThenLapse(partnerKey, 'agent_timeout_case');

  // Outlives the 800ms axios budget, so axios aborts: a real timeout, not a synthesized error.
  // Only this interceptor is registered — nock matches in registration order, and a counting one
  // added first would answer instantly and erase the timeout under test.
  nock(INTROSPECT_BASE).post(INTROSPECT_PATH).delay(2_000).reply(...okFor('never_arrives'));

  assert.equal((await invoke(partnerKey)).status, 400, 'served from the stale verdict');
  assert.equal(
    isInvokeAuthIntrospectCooldownActive(partnerKey),
    true,
    'a timeout is an outage and must shed this key',
  );
});

test("a genuine verdict clears that key's own cooldown", async () => {
  const partnerKey = key('3');
  openInvokeAuthIntrospectCooldown(partnerKey);
  assert.equal(isInvokeAuthIntrospectCooldownActive(partnerKey), true);
  // Seed a verdict through the network path directly — an open shed would refuse a route request.
  countingIntrospect({ replyFn: () => okFor('agent_recovered') });
  await runBoundedInvokeAuthIntrospectFlight(partnerKey);
  assert.equal(
    isInvokeAuthIntrospectCooldownActive(partnerKey),
    false,
    'a real verdict is evidence the backend is alive',
  );
});

// ---- 5. the settlement guarantee -------------------------------------------------------------------

test('a dial that never settles is bounded, aborted, and translated to UNAVAILABLE', async () => {
  // The STAGE_TIMEOUT branch is unreachable over the wire — the budget is always axios's timeout
  // plus a second, so axios wins unless its socket timer never started (the queued-socket case no
  // HTTP mock can stage). Deleting the branch passed every earlier test, and a raw STAGE_TIMEOUT
  // escaping fails the strict UNAVAILABLE check upstream, so every warm key would 503 in exactly
  // the incident shape this exists for.
  const partnerKey = key('4');
  let receivedSignal = null;
  const neverSettles = (_apiKey, signal) => {
    receivedSignal = signal;
    return new Promise(() => {});
  };

  const started = Date.now();
  await assert.rejects(
    () => runBoundedInvokeAuthIntrospectFlight(partnerKey, neverSettles),
    (err) => {
      assert.equal(err.code, 'AUTH_INTROSPECT_UNAVAILABLE', 'must be translated, not raw');
      assert.match(err.message, /flight budget/);
      return true;
    },
  );
  assert.ok(Date.now() - started >= 800, 'it must actually wait out the budget');
  // Aborting is what stops an orphan landing later and re-minting a stale verdict with a fresh TTL.
  assert.ok(receivedSignal, 'the dial must be given an abort signal');
  assert.equal(receivedSignal.aborted, true, 'the abandoned dial must be aborted, not just raced');
  assert.equal(isInvokeAuthIntrospectCooldownActive(partnerKey), true, 'and it sheds that key');
});

// ---- 6. configuration ------------------------------------------------------------------------------

test('the cooldown snapshot reflects the configured window', () => {
  const snap = agentAuthCacheTtlSnapshot();
  assert.equal(snap.introspect_cooldown_ms, COOLDOWN_MS);
  assert.equal(snap.introspect_cooldown_disabled, false);
});

test('AGENT_AUTH_INTROSPECT_COOLDOWN_MS=0 disables shedding instead of meaning "use the default"', () => {
  // parsePositiveInt returns its FALLBACK for a 0, so a bare `=0` would otherwise arm the default.
  // Asserted in a SUBPROCESS because the constant binds at module load.
  //
  // The earlier version asserted `isActive()` right after `open()` — which reads false with the
  // guards DELETED too, since open() would set until=nowMs and isActive() computes nowMs > nowMs.
  // A sentinel both implementations answer identically proves nothing; assert instead that open()
  // returns 0 and that no horizon was ever recorded.
  const script = `
    process.env.NODE_ENV = 'test';
    process.env.AGENT_AUTH_INTROSPECT_URL = ${JSON.stringify(`${INTROSPECT_BASE}${INTROSPECT_PATH}`)};
    process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
    process.env.AGENT_AUTH_INTROSPECT_COOLDOWN_MS = '0';
    const d = require(${JSON.stringify(require.resolve('../src/server'))})._debug;
    const k = 'ak_live_' + 'e'.repeat(64);
    const returned = d.openInvokeAuthIntrospectCooldown(k);
    process.stdout.write('<<SNAP' + JSON.stringify({
      snap: d.agentAuthCacheTtlSnapshot(),
      open_returned: returned,
      horizon_recorded: d.invokeAuthIntrospectCooldown.size,
      active_a_ms_before_now: d.isInvokeAuthIntrospectCooldownActive(k, Date.now() - 1),
    }) + 'SNAP>>');
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: require('path').join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 60_000,
  });
  // The booted server logs its own JSON to stdout, so fence the payload rather than parsing it all.
  const fenced = out.match(/<<SNAP([\s\S]*?)SNAP>>/);
  assert.ok(fenced, `child produced no payload; stdout was:\n${out.slice(0, 400)}`);
  const parsed = JSON.parse(fenced[1]);
  assert.equal(parsed.snap.introspect_cooldown_disabled, true);
  assert.equal(parsed.snap.introspect_cooldown_ms, 0);
  assert.equal(parsed.open_returned, 0, 'a disabled switch must refuse to open');
  assert.equal(parsed.horizon_recorded, 0, 'and must record no horizon at all');
  assert.equal(parsed.active_a_ms_before_now, false);
});

test('the per-key cooldown map is bounded and self-pruning', () => {
  // It is keyed by the same hashes as the verdict cache and must not become an unbounded sink for a
  // flood of one-shot keys.
  const past = Date.now() - 10_000;
  invokeAuthIntrospectCooldown.set('expired-a', past);
  invokeAuthIntrospectCooldown.set('expired-b', past);
  const live = key('5');
  openInvokeAuthIntrospectCooldown(live); // triggers the prune
  assert.equal(invokeAuthIntrospectCooldown.has('expired-a'), false);
  assert.equal(invokeAuthIntrospectCooldown.has('expired-b'), false);
  assert.equal(invokeAuthIntrospectCooldown.has(cacheHashOf(live)), true);
});
