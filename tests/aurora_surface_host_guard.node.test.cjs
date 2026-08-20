'use strict';

/*
 * The Aurora BFF surface must not be reachable on the branded public hosts.
 *
 * Phase 0 of the anonymous-LLM work. The Aurora surface is mounted on the bare app and gated only by
 * requireAuroraUid() — a non-empty `X-Aurora-UID`, a client-invented device string sitting in the
 * CORS allow-list, not a credential. Nine /v1 routes reach an LLM. Measured on prod 2026-08-20:
 * `POST /v1/chat` with `{}` and no credential answered 400 carrying a full Aurora envelope on
 * mcp.pivota.cc and gateway.pivota.cc.
 *
 * HOW THESE TESTS KNOW THE AURORA HANDLER WAS NOT REACHED, rather than just reading a status code:
 * the Aurora handler's own refusal is a 400 carrying `version` / `request_id` / `trace_id` /
 * `assistant_text` — that envelope IS the signature that exposed this in production, and the guard
 * cannot produce it (it answers a flat `{error:'NOT_FOUND'}`). Express's own unmatched-route 404 is
 * text/html, so `resp.body` is `{}` and cannot satisfy the helper either. The positive control at
 * the end asserts the envelope directly.
 *
 * ASSERT THE STATUS BEFORE THE ENVELOPE, always. When auroraRoutesReady is false the degraded
 * handler answers 503 with a body that ALSO carries request_id/trace_id. The 400 assertions below
 * are what keep that from satisfying a control that is supposed to prove an LLM lane was reached.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');

const {
  decideAuroraSurfaceAccess,
  isAuroraSurfacePath,
  auroraDeniedHosts,
} = require('../src/services/auroraSurfaceHostGuard');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.PUBLIC_READ_MCP_HOSTS = 'mcp.pivota.cc';
process.env.PUBLIC_READ_MCP_ENABLED = '1';
delete process.env.AURORA_SURFACE_DENIED_HOSTS;

const app = require('../src/server');

const ANCHOR = 'mcp.pivota.cc';
const PARTNER = 'gateway.pivota.cc';
const SERVING = 'pivota-agent-production.up.railway.app';

/** The guard refused: a flat error body, and none of the Aurora envelope. */
function assertRefusedBeforeAurora(resp, label = '') {
  assert.equal(resp.status, 404, `${label} status`);
  assert.equal(resp.body.error, 'NOT_FOUND', `${label} body.error`);
  assert.equal(resp.body.request_id, undefined, `${label}: an Aurora envelope means the handler ran`);
  assert.equal(resp.body.assistant_text, undefined, `${label}: assistant_text means the handler ran`);
}

// ---- the decision function -------------------------------------------------------------------

test('the surface is matched by prefix, so a route added tomorrow is covered', () => {
  for (const p of ['/v1', '/v1/chat', '/v1/anything/invented/later', '/v2/x', '/V1/Chat', '/v1/chat/', '/metrics']) {
    assert.equal(isAuroraSurfacePath(p), true, p);
  }
  for (const p of ['/mcp', '/.well-known/ucp', '/healthz', '/v10/x', '/agent/shop/v1/invoke', '/ui/chat']) {
    assert.equal(isAuroraSurfacePath(p), false, p);
  }
});

test('non-Aurora paths are never touched by this guard', () => {
  const d = decideAuroraSurfaceAccess({ path: '/mcp', host: ANCHOR, isPublicReadHost: true });
  assert.equal(d.allow, true);
  assert.equal(d.reason, 'not_aurora_surface');
});

test('nothing beyond the public-read names is denied by default', () => {
  // Deliberately empty. gateway.pivota.cc was the default in the first version of this fix and had
  // to be removed: pivota-agent-ui #308 merged 42 minutes after the traffic window closed and points
  // /v1/analysis/skin and /v1/photos/upload at that host. Extra hosts are opted in, never assumed.
  assert.deepEqual(auroraDeniedHosts({}), []);
  assert.deepEqual(auroraDeniedHosts({ AURORA_SURFACE_DENIED_HOSTS: '' }), []);
  assert.deepEqual(auroraDeniedHosts({ AURORA_SURFACE_DENIED_HOSTS: 'a.example, B.EXAMPLE:443 , c.example. ' }), [
    'a.example',
    'b.example',
    'c.example',
  ]);
});

// ---- the positional invariant ----------------------------------------------------------------

test('the guard is registered BEFORE every Aurora-surface route layer', async () => {
  // The bug the first version of this fix shipped with. The guard sat immediately before
  // mountAuroraBffRoutes, but mountUiEventRoutes (/v1/events), mountExternalOfferRoutes
  // (/v1/offers/external/*) and mountRecommendationRoutes (/v1/recommendations/*) register EARLIER,
  // so Express matched and terminated in those layers and the guard never ran — five /v1 routes
  // served anonymously on the anchor while the suite was green. A behavioural test only pins the
  // routes it happens to name; this pins the ordering itself, for every route that exists.
  const stack = app._router.stack;
  const guardIndex = stack.findIndex((l) => l.handle && l.handle.name === 'auroraSurfaceHostGuardMiddleware');
  assert.ok(guardIndex >= 0, 'guard middleware not found in the router stack');

  const offenders = stack
    .map((layer, index) => ({ layer, index }))
    .filter(({ layer, index }) => index < guardIndex && layer.route && isAuroraSurfacePath(layer.route.path))
    .map(({ layer }) => layer.route.path);

  assert.deepEqual(offenders, [], `these Aurora-surface routes are registered before the guard: ${offenders}`);
});

test('a /v1 route mounted by ANOTHER module is refused on the anchor', async () => {
  // The five that escaped. /v1/events is the sharp one: anonymous ingest that fans out to PostHog
  // and writes a budget-preference signal against a CALLER-SUPPLIED aurora_uid.
  for (const p of [
    '/v1/events',
    '/v1/offers/external/resolve',
    '/v1/offers/external/batchResolve',
    '/v1/recommendations/feed',
    '/v1/recommendations/roles/normalize',
  ]) {
    const resp = await supertest(app).post(p).set('Host', ANCHOR).send({});
    assertRefusedBeforeAurora(resp, `${p} on anchor`);
  }
});

// ---- the live surface ------------------------------------------------------------------------

test('POST /v1/chat on the identity anchor never reaches Aurora', async () => {
  const resp = await supertest(app).post('/v1/chat').set('Host', ANCHOR).send({});
  assertRefusedBeforeAurora(resp, '/v1/chat on anchor');
});

test('a well-formed X-Aurora-UID cannot buy access to the anchor', async () => {
  // The uid is the ONLY thing the real handler asks for, so a test that omits it would pass even if
  // the guard were gone — the handler would answer 400 either way.
  const resp = await supertest(app)
    .post('/v1/chat')
    .set('Host', ANCHOR)
    .set('X-Aurora-UID', 'device-abc-123')
    .send({ messages: [{ role: 'user', content: 'hi' }] });
  assertRefusedBeforeAurora(resp, '/v1/chat on anchor with uid');
});

test('the refusal is not scoped to POST, not to /v1, and not to a lowercase Host', async () => {
  // Three independent narrowings of the guard that the host-focused tests could not see: a POST-only
  // guard, a /v1-only guard, and a guard that compares an un-lowercased Host all passed the whole
  // suite before this existed. /v2/chat and /v2/chat/stream are real LLM routes in auroraBff/index.js.
  const get = await supertest(app).get('/v1/auth/me').set('Host', ANCHOR).set('X-Aurora-UID', 'd');
  assertRefusedBeforeAurora(get, 'GET /v1/auth/me on anchor');

  const v2 = await supertest(app).post('/v2/chat').set('Host', ANCHOR).set('X-Aurora-UID', 'd').send({});
  assertRefusedBeforeAurora(v2, 'POST /v2/chat on anchor');

  const upper = await supertest(app).post('/v1/chat').set('Host', ANCHOR.toUpperCase()).send({});
  assertRefusedBeforeAurora(upper, 'uppercase anchor Host');
});

test('a trailing-dot Host is the same host', async () => {
  // `mcp.pivota.cc.` is a valid absolute-FQDN spelling and every scanner tries it. The Railway edge
  // refuses to route it today, so this is latent — but the GCP migration replaces that edge, and an
  // unstripped dot slips both the public-read predicate and the denied-host list.
  const resp = await supertest(app).post('/v1/chat').set('Host', `${ANCHOR}.`).send({});
  assertRefusedBeforeAurora(resp, 'trailing-dot anchor');
});

test('a query string does not change the decision', async () => {
  const resp = await supertest(app).post('/v1/chat?utm=x&a=b').set('Host', ANCHOR).send({});
  assertRefusedBeforeAurora(resp, '/v1/chat with a query string');
});

test('the Prometheus dump is not served on the anchor', async () => {
  // mountAuroraBffRoutes registers GET /metrics outside the version prefix. Full operational
  // telemetry does not belong on the UCP identity anchor; the consumer reaches it over the
  // railway.app name, which is untouched.
  const resp = await supertest(app).get('/metrics').set('Host', ANCHOR);
  assertRefusedBeforeAurora(resp, '/metrics on anchor');
});

test('every LLM-bearing sibling route is refused on the anchor too', async () => {
  for (const p of [
    '/v1/product/parse',
    '/v1/product/analyze',
    '/v1/dupe/suggest',
    '/v1/dupe/compare',
    '/v1/analysis/skin',
    '/v1/reco/generate',
    '/v1/reco/alternatives',
    '/v1/routine/simulate',
    '/v1/photos/upload',
    '/v1/diagnosis/start',
  ]) {
    const resp = await supertest(app).post(p).set('Host', ANCHOR).set('X-Aurora-UID', 'd').send({});
    assertRefusedBeforeAurora(resp, p);
  }
});

test('a /v1 path that does not exist yet is refused on the anchor', async () => {
  const resp = await supertest(app)
    .post('/v1/some/route/invented/after/this/fix')
    .set('Host', ANCHOR)
    .send({});
  assertRefusedBeforeAurora(resp, 'unknown /v1 path');
});

test('the spellings Express also routes are refused', async () => {
  for (const p of ['/V1/Chat', '/v1/chat/', '/V1/CHAT/']) {
    const resp = await supertest(app).post(p).set('Host', ANCHOR).send({});
    assertRefusedBeforeAurora(resp, p);
  }
});

test('a Host carrying a port is still the anchor', async () => {
  const resp = await supertest(app).post('/v1/chat').set('Host', `${ANCHOR}:443`).send({});
  assertRefusedBeforeAurora(resp, `${ANCHOR}:443`);
});

test('darkening the read tier does not re-open the Aurora surface on the anchor', async () => {
  // The anchor resolves to this service whether or not the read tier is switched on, so the refusal
  // must key on the Host alone and never on `&& isPublicReadMcpEnabled()`.
  process.env.PUBLIC_READ_MCP_ENABLED = '0';
  try {
    const resp = await supertest(app).post('/v1/chat').set('Host', ANCHOR).send({});
    assertRefusedBeforeAurora(resp, 'anchor with read tier dark');
  } finally {
    process.env.PUBLIC_READ_MCP_ENABLED = '1';
  }
});

test('the public-read host set is read from PUBLIC_READ_MCP_HOSTS, not hardcoded', async () => {
  // publicReadMcpHosts() DEFAULTS to 'mcp.pivota.cc' and this file sets the env to the same value,
  // so every assertion above is equally satisfied by a call site that hardcoded the literal — a
  // mutant doing exactly that passed the whole suite once already.
  process.env.PUBLIC_READ_MCP_HOSTS = 'read-tier.example';
  try {
    const nowAnchor = await supertest(app).post('/v1/chat').set('Host', 'read-tier.example').send({});
    assertRefusedBeforeAurora(nowAnchor, 'newly configured read-tier host');

    const noLongerAnchor = await supertest(app).post('/v1/chat').set('Host', ANCHOR).send({});
    assert.equal(noLongerAnchor.status, 400, 'the old anchor name must lose its privilege with the env');
    assert.ok(noLongerAnchor.body.request_id, 'expected the Aurora envelope');
  } finally {
    process.env.PUBLIC_READ_MCP_HOSTS = ANCHOR;
  }
});

// ---- what must NOT change --------------------------------------------------------------------

test('gateway.pivota.cc still serves the Aurora surface by default', async () => {
  // The regression this fix nearly shipped. pivota-agent-ui #308 (merged 2026-08-20T14:41:59Z) points
  // /v1/analysis/skin and /v1/photos/upload at this host, and pivota-backend-gcp's env.prod.yaml
  // points /v1/recommendations/* there too. Denying it by default would 404 all of them.
  for (const p of ['/v1/analysis/skin', '/v1/photos/upload', '/v1/chat']) {
    const resp = await supertest(app).post(p).set('Host', PARTNER).set('X-Aurora-UID', 'd').send({});
    assert.notEqual(resp.status, 404, `${p} on ${PARTNER} must not be refused by default`);
  }
});

test('an operator can opt a host in, and it takes effect without a restart', async () => {
  process.env.AURORA_SURFACE_DENIED_HOSTS = `${PARTNER}, other.example`;
  try {
    for (const h of [PARTNER, 'other.example', PARTNER.toUpperCase(), `${PARTNER}:443`, `${PARTNER}.`]) {
      const resp = await supertest(app).post('/v1/chat').set('Host', h).send({});
      assertRefusedBeforeAurora(resp, `opted-in ${h}`);
    }
  } finally {
    delete process.env.AURORA_SURFACE_DENIED_HOSTS;
  }
  // ...and removing it restores service on the very next request.
  const restored = await supertest(app).post('/v1/chat').set('Host', PARTNER).send({});
  assert.equal(restored.status, 400, 'removing the host must restore it without a restart');
  assert.ok(restored.body.request_id);
});

test('the anchor still serves the public read tier it exists for', async () => {
  // The whole point of mcp.pivota.cc. A guard that took this out would be a worse bug than the one
  // it fixes, and no /v1 assertion above would notice.
  const resp = await supertest(app)
    .post('/mcp')
    .set('Host', ANCHOR)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    .expect(200);
  assert.deepEqual(
    resp.body.result.tools.map((t) => t.name).sort(),
    ['get_alternatives', 'get_intel', 'get_product', 'search_catalog'],
  );
});

// ---- positive control ------------------------------------------------------------------------

test('on the serving host the request DOES reach Aurora', async () => {
  // 400 MISSING_AURORA_UID carrying the Aurora envelope — the exact response measured on prod that
  // proved the surface was anonymous. Status asserted FIRST: the degraded-mode 503 also carries
  // request_id, so an assertion that only checked the envelope would accept a process in which
  // Aurora failed to load at all.
  const resp = await supertest(app).post('/v1/chat').set('Host', SERVING).send({});
  assert.equal(resp.status, 400);
  assert.ok(resp.body.request_id, 'expected an Aurora envelope (request_id)');
  assert.ok(resp.body.trace_id, 'expected an Aurora envelope (trace_id)');
  assert.notEqual(resp.body.error, 'NOT_FOUND');
});
