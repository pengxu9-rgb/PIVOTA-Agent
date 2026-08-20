'use strict';

/*
 * The Aurora BFF surface must not be reachable on the branded public hosts.
 *
 * Phase 0 of the anonymous-LLM work. The Aurora surface is mounted on the bare app and gated only by
 * requireAuroraUid() — a non-empty `X-Aurora-UID`, which is a client-invented device string sitting
 * in the CORS allow-list, not a credential. Nine /v1 routes reach an LLM. Measured on prod
 * 2026-08-20: `POST /v1/chat` with `{}` and no credential answered 400 carrying a full Aurora
 * envelope on mcp.pivota.cc and gateway.pivota.cc.
 *
 * HOW THESE TESTS KNOW THE AURORA HANDLER WAS NOT REACHED, rather than just reading a status code:
 * the Aurora handler's own refusal is a 400 carrying `version` / `request_id` / `trace_id` /
 * `assistant_text` — that envelope IS the signature that exposed this in production, and it cannot
 * be produced by the guard, which answers a flat `{error:'NOT_FOUND'}`. So "reached Aurora" has its
 * own observable shape. The positive control at the end asserts that shape directly; without it a
 * mutant that 404'd everything would satisfy every refusal assertion in the file.
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

// ---- the decision function -----------------------------------------------------------------

test('the surface is matched by prefix, so a route added tomorrow is covered', () => {
  for (const p of ['/v1', '/v1/chat', '/v1/anything/invented/later', '/v2/x', '/V1/Chat', '/v1/chat/']) {
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

test('the denied set defaults to the partner host and is env-driven', () => {
  assert.deepEqual(auroraDeniedHosts({}), ['gateway.pivota.cc']);
  assert.deepEqual(auroraDeniedHosts({ AURORA_SURFACE_DENIED_HOSTS: 'a.example, B.EXAMPLE:443 ' }), [
    'a.example',
    'b.example',
  ]);
  // An explicitly empty value means "deny nothing extra", not "fall back to the default".
  assert.deepEqual(auroraDeniedHosts({ AURORA_SURFACE_DENIED_HOSTS: '' }), []);
});

// ---- the live surface ----------------------------------------------------------------------

test('POST /v1/chat on the identity anchor never reaches Aurora', async () => {
  const resp = await supertest(app).post('/v1/chat').set('Host', ANCHOR).send({});
  assertRefusedBeforeAurora(resp, '/v1/chat on anchor');
});

test('a well-formed X-Aurora-UID cannot buy access to the anchor', async () => {
  // The uid is the ONLY thing the real handler asks for, so a test that omits it would pass even if
  // the guard were gone — the handler would answer 400 either way. Supplying it is what makes this
  // assertion about the guard rather than about requireAuroraUid.
  const resp = await supertest(app)
    .post('/v1/chat')
    .set('Host', ANCHOR)
    .set('X-Aurora-UID', 'device-abc-123')
    .send({ messages: [{ role: 'user', content: 'hi' }] });
  assertRefusedBeforeAurora(resp, '/v1/chat on anchor with uid');
});

test('the partner host is refused by default, with no env set', async () => {
  const resp = await supertest(app)
    .post('/v1/chat')
    .set('Host', PARTNER)
    .set('X-Aurora-UID', 'device-abc-123')
    .send({ messages: [{ role: 'user', content: 'hi' }] });
  assertRefusedBeforeAurora(resp, '/v1/chat on partner host');
});

test('every LLM-bearing sibling route is refused on the anchor too', async () => {
  // /ui/chat taught this: fixing the one route that was reported leaves the rest of the surface open.
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
  // Pins prefix-not-enumeration: whoever adds the tenth LLM route gets this behaviour for free.
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

test('a Host carrying a port is still the anchor, and still the partner host', async () => {
  for (const h of [`${ANCHOR}:443`, `${PARTNER}:443`]) {
    const resp = await supertest(app).post('/v1/chat').set('Host', h).send({});
    assertRefusedBeforeAurora(resp, h);
  }
});

test('darkening the read tier does not re-open the Aurora surface on the anchor', async () => {
  // Same non-conjunct as uiChatAccessGuard: the anchor resolves to this service whether or not the
  // read tier is switched on, so the refusal must key on the Host alone.
  process.env.PUBLIC_READ_MCP_ENABLED = '0';
  try {
    const resp = await supertest(app).post('/v1/chat').set('Host', ANCHOR).send({});
    assertRefusedBeforeAurora(resp, 'anchor with read tier dark');
  } finally {
    process.env.PUBLIC_READ_MCP_ENABLED = '1';
  }
});

test('the denied host set really comes from the env, not from a hardcoded name', async () => {
  process.env.AURORA_SURFACE_DENIED_HOSTS = 'some-other.example';
  try {
    const denied = await supertest(app).post('/v1/chat').set('Host', 'some-other.example').send({});
    assertRefusedBeforeAurora(denied, 'newly denied host');

    // ...and the default name, no longer listed, must fall through to Aurora.
    const allowed = await supertest(app).post('/v1/chat').set('Host', PARTNER).send({});
    assert.equal(allowed.status, 400, 'a host outside the denied set must reach Aurora');
    assert.ok(allowed.body.request_id, 'expected the Aurora envelope');
  } finally {
    delete process.env.AURORA_SURFACE_DENIED_HOSTS;
  }
});

test('the public-read host set is read from PUBLIC_READ_MCP_HOSTS, not hardcoded', async () => {
  // publicReadMcpHosts() DEFAULTS to 'mcp.pivota.cc', and this file sets the env to that same value,
  // so every assertion above is equally satisfied by a call site that hardcoded the literal — a
  // mutant doing exactly that passed the whole suite. Point the env somewhere else so the anchor
  // name loses its privilege and a different name gains it.
  process.env.PUBLIC_READ_MCP_HOSTS = 'read-tier.example';
  try {
    const nowAnchor = await supertest(app).post('/v1/chat').set('Host', 'read-tier.example').send({});
    assertRefusedBeforeAurora(nowAnchor, 'newly configured read-tier host');

    // mcp.pivota.cc is no longer a public-read host and is not in the denied list either, so it must
    // fall through to Aurora. If it still 404s, the name is baked in somewhere.
    const noLongerAnchor = await supertest(app).post('/v1/chat').set('Host', ANCHOR).send({});
    assert.equal(noLongerAnchor.status, 400, 'the old anchor name must lose its privilege with the env');
    assert.ok(noLongerAnchor.body.request_id, 'expected the Aurora envelope');
  } finally {
    process.env.PUBLIC_READ_MCP_HOSTS = ANCHOR;
  }
});

// ---- what must NOT change ------------------------------------------------------------------

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

// ---- positive control ----------------------------------------------------------------------

test('on the serving host the request DOES reach Aurora', async () => {
  // 400 MISSING_AURORA_UID carrying the Aurora envelope — the exact response measured on prod that
  // proved the surface was anonymous. It is the observable difference between "the guard refused
  // this" and "the guard let it through", and it is what makes every refusal above meaningful.
  const resp = await supertest(app).post('/v1/chat').set('Host', SERVING).send({});
  assert.equal(resp.status, 400);
  assert.ok(resp.body.request_id, 'expected an Aurora envelope (request_id)');
  assert.ok(resp.body.trace_id, 'expected an Aurora envelope (trace_id)');
  assert.notEqual(resp.body.error, 'NOT_FOUND');
});
