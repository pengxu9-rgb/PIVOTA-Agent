'use strict';

/*
 * Caller authentication for the Aurora BFF surface — Phase 1 step 1.
 *
 * The whole point of this commit is that it changes NOTHING for any caller yet. That is the hardest
 * thing to test convincingly, because "nothing happened" is also what a guard that was never wired
 * up looks like. Three response shapes make the difference observable:
 *
 *   reached Aurora  -> 400 carrying the Aurora envelope (version/request_id/trace_id/assistant_text)
 *   refused by AUTH -> 401 {"error":"UNAUTHORIZED"}          (this file's guard)
 *   refused by HOST -> 404 {"error":"NOT_FOUND"}             (PR #2034's guard)
 *
 * So the observe-mode tests assert the FIRST shape for requests carrying no credential — proving the
 * middleware ran and deliberately allowed them — while the enforce-mode tests assert the second for
 * the identical request. If the middleware were absent, the enforce tests fail; if it were wired but
 * refusing, the observe tests fail. Neither can pass by accident.
 *
 * Status is asserted BEFORE the envelope everywhere: the degraded-mode 503 also carries request_id,
 * so an assertion that only checked for the envelope would accept a process in which Aurora never
 * loaded at all.
 *
 * THE LOG LINE IS ASSERTED, not just the status codes. In observe mode — the shipped default — the
 * log is the ONLY thing this middleware produces; `if (auth.allow) return next();` is the whole rest
 * of it. Review found five mutants that survived a status-only suite: `would_refuse` hardcoded false
 * (which would report a clean rollout signal for a surface where no caller has the header), the log
 * line deleted entirely, `key_valid` inverted, `reason` redacted, and the KEY VALUE itself written
 * into the log. All five are green against status assertions alone. So the deliverable gets its own
 * tests.
 *
 * Every test carries an explicit timeout. node:test defaults to Infinity, so a middleware that
 * forgets to call next() burns the CI job's wall clock instead of failing — measured at 600s+ before
 * an external bound killed it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');

const { decideAuroraSurfaceAuth, auroraAuthMode, isSelfAuthenticatedPath } = require('../src/services/auroraSurfaceAuth');
const logger = require('../src/logger');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.PUBLIC_READ_MCP_HOSTS = 'mcp.pivota.cc';
process.env.PUBLIC_READ_MCP_ENABLED = '1';
delete process.env.AURORA_SURFACE_DENIED_HOSTS;
delete process.env.AURORA_SURFACE_AUTH_MODE;
delete process.env.AURORA_SURFACE_INTERNAL_KEY;

const app = require('../src/server');

const KEY = 'Aurora-Surface-Key-AbCdEf0123456789';
const ANCHOR = 'mcp.pivota.cc';
const SERVING = 'pivota-agent-production.up.railway.app';

function setEnv({ mode, key }) {
  if (mode === null) delete process.env.AURORA_SURFACE_AUTH_MODE;
  else if (mode !== undefined) process.env.AURORA_SURFACE_AUTH_MODE = mode;
  if (key === null) delete process.env.AURORA_SURFACE_INTERNAL_KEY;
  else if (key !== undefined) process.env.AURORA_SURFACE_INTERNAL_KEY = key;
}
function resetEnv() {
  delete process.env.AURORA_SURFACE_AUTH_MODE;
  delete process.env.AURORA_SURFACE_INTERNAL_KEY;
}

/** The request got past both guards and into the Aurora handler. */
function assertReachedAurora(resp, label = '') {
  assert.equal(resp.status, 400, `${label}: expected the Aurora handler's own 400`);
  assert.ok(resp.body.request_id, `${label}: expected the Aurora envelope (request_id)`);
  assert.notEqual(resp.body.error, 'UNAUTHORIZED', `${label}: auth refused this`);
  assert.notEqual(resp.body.error, 'NOT_FOUND', `${label}: the host guard refused this`);
}

/** The auth guard refused it — distinct from the host guard's 404. */
function assertRefusedByAuth(resp, label = '') {
  assert.equal(resp.status, 401, `${label} status`);
  assert.equal(resp.body.error, 'UNAUTHORIZED', `${label} body.error`);
  assert.equal(resp.body.request_id, undefined, `${label}: an Aurora envelope means the handler ran`);
}

const T = { timeout: 20_000 };

/** Capture the aurora_surface_auth lines a block of work emits. */
async function captureAuthLogs(fn) {
  const lines = [];
  const original = logger.info;
  logger.info = function capture(obj, ...rest) {
    if (obj && typeof obj === 'object' && obj.event === 'aurora_surface_auth') lines.push(obj);
    return original.call(this, obj, ...rest);
  };
  try {
    await fn();
  } finally {
    logger.info = original;
  }
  return lines;
}

// ---- mode resolution -------------------------------------------------------------------------

test('anything that is not exactly "enforce" resolves to observe', T, () => {
  for (const raw of [undefined, '', '   ', 'observe', 'enfroce', 'ENFORCED', 'true', '1', 'off']) {
    assert.equal(auroraAuthMode({ AURORA_SURFACE_AUTH_MODE: raw }), 'observe', JSON.stringify(raw));
  }
  // A typo must never be read as enforce: guessing wrong there is a total consumer outage.
  for (const raw of ['enforce', 'ENFORCE', ' Enforce ']) {
    assert.equal(auroraAuthMode({ AURORA_SURFACE_AUTH_MODE: raw }), 'enforce', JSON.stringify(raw));
  }
});

// ---- the decision function -------------------------------------------------------------------

test('observe never refuses, whatever the key state', T, () => {
  for (const env of [
    {},
    { AURORA_SURFACE_INTERNAL_KEY: KEY },
    { AURORA_SURFACE_INTERNAL_KEY: KEY, AURORA_SURFACE_AUTH_MODE: 'observe' },
  ]) {
    for (const headers of [{}, { 'x-internal-key': 'wrong' }, { 'x-internal-key': KEY }]) {
      assert.equal(decideAuroraSurfaceAuth({ headers, env }).allow, true, JSON.stringify([env, headers]));
    }
  }
});

test('wouldRefuse is the measurement signal, and it is accurate in observe mode', T, () => {
  // This field is what gates the flip. If it were wrong, the rollout would be flown on a bad instrument.
  const cases = [
    [{}, {}, 'key_not_configured', true],
    [{ AURORA_SURFACE_INTERNAL_KEY: KEY }, {}, 'missing_key', true],
    [{ AURORA_SURFACE_INTERNAL_KEY: KEY }, { 'x-internal-key': 'wrong' }, 'bad_key', true],
    [{ AURORA_SURFACE_INTERNAL_KEY: KEY }, { 'x-internal-key': KEY }, 'ok', false],
  ];
  for (const [env, headers, reason, wouldRefuse] of cases) {
    const d = decideAuroraSurfaceAuth({ headers, env });
    assert.equal(d.allow, true, 'observe must still allow');
    assert.equal(d.reason, reason);
    assert.equal(d.wouldRefuse, wouldRefuse, reason);
  }
});

test('enforce refuses a missing, wrong, and same-length near-miss key', T, () => {
  const env = { AURORA_SURFACE_INTERNAL_KEY: KEY, AURORA_SURFACE_AUTH_MODE: 'enforce' };
  for (const headers of [{}, { 'x-internal-key': 'wrong' }, { 'x-internal-key': `${KEY.slice(0, -1)}X` }]) {
    const d = decideAuroraSurfaceAuth({ headers, env });
    assert.equal(d.allow, false, JSON.stringify(headers));
    assert.equal(d.status, 401);
  }
  // ...and a case-differing key is NOT a match.
  assert.equal(decideAuroraSurfaceAuth({ headers: { 'x-internal-key': KEY.toLowerCase() }, env }).allow, false);
});

test('enforce with no key CONFIGURED fails closed, never open', T, () => {
  // The misconfiguration case. src/recommendations/routes.js:342 gets this wrong in the other
  // direction — it returns true (open) whenever NODE_ENV is not exactly production.
  const d = decideAuroraSurfaceAuth({
    headers: { 'x-internal-key': KEY },
    env: { AURORA_SURFACE_AUTH_MODE: 'enforce' },
  });
  assert.equal(d.allow, false);
  assert.equal(d.reason, 'key_not_configured');
});

test('the matching key is accepted however the header name is cased', T, () => {
  const env = { AURORA_SURFACE_INTERNAL_KEY: KEY, AURORA_SURFACE_AUTH_MODE: 'enforce' };
  for (const name of ['x-internal-key', 'X-Internal-Key', 'X-INTERNAL-KEY']) {
    assert.equal(decideAuroraSurfaceAuth({ headers: { [name]: KEY }, env }).allow, true, name);
  }
});

// ---- observe mode on the live surface: this must change NOTHING ------------------------------

test('OBSERVE (the shipped default): an anonymous request still reaches Aurora', T, async () => {
  // The single most important assertion in this file. This commit deploys alone, ahead of every
  // consumer, so a caller with no credential must behave exactly as it did before.
  resetEnv();
  const resp = await supertest(app).post('/v1/chat').set('Host', SERVING).send({});
  assertReachedAurora(resp, 'anonymous under observe');
});

test('OBSERVE: a wrong key is still allowed through', T, async () => {
  setEnv({ mode: null, key: KEY });
  try {
    const resp = await supertest(app)
      .post('/v1/chat')
      .set('Host', SERVING)
      .set('X-Internal-Key', 'not-the-key')
      .send({});
    assertReachedAurora(resp, 'bad key under observe');
  } finally {
    resetEnv();
  }
});

test('OBSERVE: the sibling LLM routes are equally untouched', T, async () => {
  // `notEqual(401)` alone was too weak — under a simulated Aurora load failure these returned 503 and
  // the test still passed, so it could not tell "untouched" from "broken by something unrelated".
  // Assert the positive shape instead.
  // These do not share one status (measured: 200 / 501 / 200), so the discriminator is the Aurora
  // ENVELOPE plus an explicit exclusion of 503 — the degraded-mode body also carries request_id, and
  // without that exclusion this test would pass against a process where Aurora never loaded.
  resetEnv();
  for (const p of ['/v1/analysis/skin', '/v1/photos/upload', '/v1/product/parse']) {
    const resp = await supertest(app).post(p).set('Host', SERVING).set('X-Aurora-UID', 'd').send({});
    assert.ok(resp.body.request_id, `${p}: expected the Aurora envelope`);
    assert.ok(![401, 404, 503].includes(resp.status), `${p}: got ${resp.status}, not a reached-Aurora status`);
  }
});

// ---- enforce mode: implemented and pinned now, not at the flip -------------------------------

test('ENFORCE: an anonymous request is refused before Aurora', T, async () => {
  setEnv({ mode: 'enforce', key: KEY });
  try {
    const resp = await supertest(app).post('/v1/chat').set('Host', SERVING).send({});
    assertRefusedByAuth(resp, 'anonymous under enforce');
  } finally {
    resetEnv();
  }
});

test('ENFORCE: a wrong key is refused, the right key gets through', T, async () => {
  setEnv({ mode: 'enforce', key: KEY });
  try {
    const bad = await supertest(app)
      .post('/v1/chat')
      .set('Host', SERVING)
      .set('X-Internal-Key', 'not-the-key')
      .send({});
    assertRefusedByAuth(bad, 'bad key under enforce');

    const good = await supertest(app)
      .post('/v1/chat')
      .set('Host', SERVING)
      .set('X-Internal-Key', KEY)
      .send({});
    assertReachedAurora(good, 'correct key under enforce');
  } finally {
    resetEnv();
  }
});

test('ENFORCE with no key configured refuses everything', T, async () => {
  setEnv({ mode: 'enforce', key: null });
  try {
    const resp = await supertest(app)
      .post('/v1/chat')
      .set('Host', SERVING)
      .set('X-Internal-Key', KEY)
      .send({});
    assertRefusedByAuth(resp, 'enforce with unconfigured key');
  } finally {
    resetEnv();
  }
});

test('ENFORCE covers a /v1 path that does not exist yet', T, async () => {
  // Pins that this guard reuses isAuroraSurfacePath rather than re-deriving the surface. If the two
  // guards ever disagreed about what "the Aurora surface" is, a route could be host-refused on the
  // anchor but never auth-checked anywhere else.
  setEnv({ mode: 'enforce', key: KEY });
  try {
    const resp = await supertest(app)
      .post('/v1/invented/after/this/fix')
      .set('Host', SERVING)
      .send({});
    assertRefusedByAuth(resp, 'unknown /v1 path under enforce');
  } finally {
    resetEnv();
  }
});

// ---- the log line: the only thing observe mode produces --------------------------------------

test('observe emits exactly one accurate line per request, and never the key', T, async () => {
  setEnv({ mode: null, key: KEY });
  try {
    const anon = await captureAuthLogs(() =>
      supertest(app).post('/v1/chat').set('Host', SERVING).send({}));
    assert.equal(anon.length, 1, 'expected exactly one aurora_surface_auth line');
    assert.equal(anon[0].mode, 'observe');
    assert.equal(anon[0].path, '/v1/chat');
    assert.equal(anon[0].method, 'POST');
    assert.equal(anon[0].has_key, false);
    assert.equal(anon[0].key_valid, false);
    assert.equal(anon[0].key_configured, true);
    assert.equal(anon[0].would_refuse, true, 'the instrument the flip is gated on');
    assert.equal(anon[0].reason, 'missing_key');

    const good = await captureAuthLogs(() =>
      supertest(app).post('/v1/chat').set('Host', SERVING).set('X-Internal-Key', KEY).send({}));
    assert.equal(good.length, 1);
    assert.equal(good[0].has_key, true);
    assert.equal(good[0].key_valid, true);
    assert.equal(good[0].would_refuse, false, 'a credentialed caller must read as ready-to-flip');
    assert.equal(good[0].reason, 'ok');

    // The credential must never reach the log, however the line is shaped.
    for (const line of [...anon, ...good]) {
      assert.ok(!JSON.stringify(line).includes(KEY), 'the key value was written to the log');
    }
  } finally {
    resetEnv();
  }
});

test('a hostile Host header cannot blow up the log line', T, async () => {
  // Host is caller-controlled free text up to Node's header cap; describeCaller truncates ua/origin
  // for the same reason. A 7KB Host produced a 7.3KB line against a 355-byte norm.
  setEnv({ mode: null, key: KEY });
  try {
    const lines = await captureAuthLogs(() =>
      supertest(app).post('/v1/chat').set('Host', `${'a'.repeat(4000)}.example`).send({}));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].host.length <= 120, `host not truncated: ${lines[0].host.length}`);
  } finally {
    resetEnv();
  }
});

// ---- coverage of the whole surface, not just POST /v1 ----------------------------------------

test('enforce covers every METHOD, not just POST', T, async () => {
  // Every original live test used POST, so a guard scoped to POST passed the entire suite.
  setEnv({ mode: 'enforce', key: KEY });
  try {
    const t = supertest(app);
    for (const [verb, call] of [['GET', () => t.get('/v1/auth/me')], ['PUT', () => t.put('/v1/chat')],
                                ['DELETE', () => t.delete('/v1/chat')], ['PATCH', () => t.patch('/v1/chat')]]) {
      const resp = await call().set('Host', SERVING);
      assert.equal(resp.status, 401, `${verb} must be refused under enforce`);
    }
  } finally {
    resetEnv();
  }
});

test('enforce covers /v2, which carries real LLM routes', T, async () => {
  // /v2/chat and /v2/chat/stream are LLM routes in auroraBff/index.js. The /v2 arms of
  // isAuroraSurfacePath were pinned only by a unit test; nothing drove them over HTTP, so a guard
  // narrowed to /v1 left them anonymous and passed.
  setEnv({ mode: 'enforce', key: KEY });
  try {
    for (const p of ['/v2/chat', '/v2/chat/stream']) {
      const resp = await supertest(app).post(p).set('Host', SERVING).send({});
      assertRefusedByAuth(resp, p);
    }
  } finally {
    resetEnv();
  }
});

// ---- paths this guard must NOT authenticate ---------------------------------------------------

test('self-authenticated paths are excluded, in both modes', T, async () => {
  // /v1/recommendations/* already authenticates with the SAME header against a DIFFERENT secret, and
  // /metrics is a Prometheus dump whose host exposure #2034 already handles. Guarding either would
  // make would_refuse unreachable (recommendations) or 401 the scrape everywhere (metrics).
  for (const p of ['/metrics', '/v1/recommendations', '/v1/recommendations/feed', '/METRICS/']) {
    assert.equal(isSelfAuthenticatedPath(p), true, p);
  }
  for (const p of ['/v1/chat', '/v2/chat', '/v1/recommendationsX/y']) {
    assert.equal(isSelfAuthenticatedPath(p), false, p);
  }

  setEnv({ mode: 'enforce', key: KEY });
  try {
    // Under ENFORCE with no credential these must NOT be 401'd by this guard. /metrics is served on
    // the serving host; recommendations answers 401 from its OWN guard, which is a different thing —
    // assert the body distinguishes them.
    const metrics = await supertest(app).get('/metrics').set('Host', SERVING);
    assert.notEqual(metrics.status, 401, '/metrics must not be auth-guarded here');

    const lines = await captureAuthLogs(() =>
      supertest(app).post('/v1/recommendations/feed').set('Host', SERVING).send({}));
    assert.equal(lines.length, 0, 'an excluded path must emit no aurora_surface_auth line');
  } finally {
    resetEnv();
  }
});

// ---- interaction with the host guard, and with everything else -------------------------------

test('the host guard still wins on the anchor, even with a valid key', T, async () => {
  // Ordering: the anchor serves no Aurora surface at all, and a credential must not buy it back.
  setEnv({ mode: 'enforce', key: KEY });
  try {
    const resp = await supertest(app)
      .post('/v1/chat')
      .set('Host', ANCHOR)
      .set('X-Internal-Key', KEY)
      .send({});
    assert.equal(resp.status, 404, 'expected the host guard 404, not the auth 401');
    assert.equal(resp.body.error, 'NOT_FOUND');
  } finally {
    resetEnv();
  }
});

test('the anchor answers 404, never 401, to an anonymous request under enforce', T, async () => {
  // Registering this guard BEFORE the host guard passes every other test in this file, because the
  // ordering test above sends a VALID key — auth allows it, and the host guard produces the 404
  // anyway. Only an anonymous request separates them, and the difference matters: on the UCP
  // identity anchor a 401 would advertise that an Aurora surface exists here and merely needs a
  // credential. It does not exist here. That is the same 404-not-401 choice as uiChatAccessGuard.
  setEnv({ mode: 'enforce', key: KEY });
  try {
    for (const headers of [{}, { 'X-Internal-Key': 'wrong' }]) {
      const req = supertest(app).post('/v1/chat').set('Host', ANCHOR);
      for (const [k, v] of Object.entries(headers)) req.set(k, v);
      const resp = await req.send({});
      assert.equal(resp.status, 404, `anchor must 404, not 401 (${JSON.stringify(headers)})`);
      assert.equal(resp.body.error, 'NOT_FOUND');
    }
  } finally {
    resetEnv();
  }
});

test('non-Aurora paths are untouched, even in enforce mode with no key', T, async () => {
  // A guard that over-reached here would take down the read tier the anchor exists for, and no /v1
  // assertion above would notice.
  setEnv({ mode: 'enforce', key: null });
  try {
    const mcp = await supertest(app)
      .post('/mcp')
      .set('Host', ANCHOR)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(200);
    assert.deepEqual(
      mcp.body.result.tools.map((t) => t.name).sort(),
      ['get_alternatives', 'get_intel', 'get_product', 'search_catalog'],
    );
    await supertest(app).get('/healthz').set('Host', SERVING).expect(200);
  } finally {
    resetEnv();
  }
});
