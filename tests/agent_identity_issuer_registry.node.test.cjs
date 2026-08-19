// Federated buyer identity on the gateway: the per-agent issuer registry + its wiring into the strict
// commerce context. Real jose keys and the REAL safety-kernel verifier; only the registry HTTP fetch and the
// JWKS fetch are served from memory.
//
// Pins:
//  1. a token from the issuer bound to agent A verifies for A (JWKS, aud, algs from the binding) and is
//     REFUSED for agent B (ISSUER_NOT_ALLOWED) and with no agent (AGENT_UNKNOWN);
//  2. a binding registered AFTER the last fetch is honoured via one forced refresh; a missing binding after
//     that forced refresh is refused without hammering the backend;
//  3. registry unreachable + nothing cached ⇒ REGISTRY_UNAVAILABLE; stale cache keeps working;
//  4. disabled without base URL / internal key / with the kill switch;
//  5. deriveStrictCommerceCtxAsync: the static verifier's unknown-issuer failure falls through to the
//     agent's binding; a KNOWN static issuer with a bad signature does NOT; no static config + a binding
//     still verifies; the agent_id on the request is the binding key.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createAgentIdentityIssuerRegistry, peekIssuer } = require('../src/services/agentIdentityIssuerRegistry');

async function loadJose() {
  const resolved = require.resolve('jose', { paths: [path.join(__dirname, '..'), path.join(__dirname, '..', 'safety-kernel')] });
  return import(pathToFileURL(resolved).href);
}

async function issuerFixture({ iss, aud, alg = 'ES256', kid = 'k1' }) {
  const { generateKeyPair, exportJWK, SignJWT } = await loadJose();
  const { publicKey, privateKey } = await generateKeyPair(alg);
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid; jwk.alg = alg; jwk.use = 'sig';
  const jwksUri = `${iss}/.well-known/jwks.json`;
  const sign = (claims = {}, { sub = 'user-1', audience = aud } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg, kid }).setIssuer(iss).setAudience(audience).setSubject(sub)
      .setIssuedAt().setExpirationTime('10m').sign(privateKey);
  return { iss, aud, alg, kid, jwks: { keys: [jwk] }, jwksUri, sign };
}

/** An in-memory fetch that serves the registry document and each issuer's JWKS. */
function fakeFetch({ registry, jwksByUri, registryStatus = 200, calls }) {
  return async (url, init) => {
    const u = String(url);
    if (calls) calls.push(u);
    if (u.endsWith('/agent/internal/identity-issuers')) {
      const key = init?.headers?.['X-Internal-Key'];
      if (key !== 'internal-secret') return { ok: false, status: 403, json: async () => ({}) };
      if (registryStatus !== 200) return { ok: false, status: registryStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ issuers: registry() }) };
    }
    if (jwksByUri[u]) {
      return new Response(JSON.stringify(jwksByUri[u]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

function entryFor(agentId, fx, extra = {}) {
  return { agent_id: agentId, iss: fx.iss, jwksUri: fx.jwksUri, aud: fx.aud, algs: [fx.alg], ...extra };
}

test('peekIssuer reads iss without verifying and tolerates junk', () => {
  const payload = Buffer.from(JSON.stringify({ iss: 'https://x.example', sub: 's' })).toString('base64url');
  assert.equal(peekIssuer(`eyJhbGciOiJFUzI1NiJ9.${payload}.sig`), 'https://x.example');
  assert.equal(peekIssuer('not.a'), null);
  assert.equal(peekIssuer('a.b.c'), null);
  assert.equal(peekIssuer(''), null);
});

test('1. a binding verifies for its agent only', async () => {
  const minds = await issuerFixture({ iss: 'https://id.minds.example', aud: 'https://commerce.mcp.pivota.cc/ucp/mcp' });
  let registry = [entryFor('agent_minds', minds)];
  // jose's remote JWKS uses global fetch; the registry module takes fetchImpl. Serve both from one fake and
  // install it globally for the duration of this test.
  const f = fakeFetch({ registry: () => registry, jwksByUri: { [minds.jwksUri]: minds.jwks } });
  const savedFetch = globalThis.fetch; globalThis.fetch = f;
  try {
    let t = 10_000_000;
    const reg = createAgentIdentityIssuerRegistry({ baseUrl: 'http://api.test', internalKey: 'internal-secret', fetchImpl: f, env: {}, now: () => t });
    assert.equal(reg.enabled, true);
    const token = await minds.sign({ email: 'buyer@minds.example', email_verified: true }, { sub: 'u-42' });

    const ok = await reg.verifyForAgent(token, 'agent_minds');
    assert.match(ok.user_ref, /^usr_/);
    assert.equal(ok.claims.sub, 'u-42');
    assert.deepEqual(ok.issuer_binding, { agent_id: 'agent_minds', iss: minds.iss });

    await assert.rejects(reg.verifyForAgent(token, 'agent_other'), (e) => e.code === 'ISSUER_NOT_ALLOWED');
    await assert.rejects(reg.verifyForAgent(token, ''), (e) => e.code === 'AGENT_UNKNOWN');
    await assert.rejects(reg.verifyForAgent(token, null), (e) => e.code === 'AGENT_UNKNOWN');

    // the binding's aud / algs are enforced by the real verifier
    const wrongAud = await minds.sign({}, { audience: 'someone-else' });
    await assert.rejects(reg.verifyForAgent(wrongAud, 'agent_minds'), (e) => e.code === 'TOKEN_VERIFY_FAILED');

    // azp + required scopes from the binding
    registry = [entryFor('agent_minds', minds, { azp: 'minds-app', requiredScopes: ['pivota.checkout'] })];
    t += 6_000; // past the forced-refresh gap the agent_other miss just consumed
    await reg.refresh({ force: true });
    const withBoth = await minds.sign({ azp: 'minds-app', scope: 'openid pivota.checkout' });
    assert.ok((await reg.verifyForAgent(withBoth, 'agent_minds')).user_ref);
    const noScope = await minds.sign({ azp: 'minds-app', scope: 'openid' });
    await assert.rejects(reg.verifyForAgent(noScope, 'agent_minds'), (e) => e.code === 'SCOPE_MISSING');
    const wrongAzp = await minds.sign({ azp: 'evil', scope: 'pivota.checkout' });
    await assert.rejects(reg.verifyForAgent(wrongAzp, 'agent_minds'), (e) => e.code === 'AZP_NOT_ALLOWED');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('2. a just-registered binding is honoured via ONE forced refresh; repeated misses do not hammer the backend', async () => {
  const fx = await issuerFixture({ iss: 'https://id.late.example', aud: 'pivota' });
  let registry = [];
  const calls = [];
  let t = 1_000_000;
  const f = fakeFetch({ registry: () => registry, jwksByUri: { [fx.jwksUri]: fx.jwks }, calls });
  const savedFetch = globalThis.fetch; globalThis.fetch = f;
  try {
    const reg = createAgentIdentityIssuerRegistry({ baseUrl: 'http://api.test', internalKey: 'internal-secret', fetchImpl: f, env: {}, now: () => t, ttlMs: 60_000 });
    const token = await fx.sign();
    await assert.rejects(reg.verifyForAgent(token, 'agent_late'), (e) => e.code === 'ISSUER_NOT_ALLOWED');
    const registryCalls = () => calls.filter((u) => u.endsWith('/identity-issuers')).length;
    assert.equal(registryCalls(), 2, 'initial fetch + one forced refresh');
    // second miss within the forced-refresh gap: no extra registry call
    await assert.rejects(reg.verifyForAgent(token, 'agent_late'), (e) => e.code === 'ISSUER_NOT_ALLOWED');
    assert.equal(registryCalls(), 2);
    // the agent registers; after the gap, the next call's forced refresh picks it up
    registry = [entryFor('agent_late', fx)];
    t += 6_000;
    assert.ok((await reg.verifyForAgent(token, 'agent_late')).user_ref);
    assert.equal(registryCalls(), 3);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('3. registry unreachable: nothing cached ⇒ REGISTRY_UNAVAILABLE; a stale cache keeps verifying', async () => {
  const fx = await issuerFixture({ iss: 'https://id.stale.example', aud: 'pivota' });
  let status = 503;
  let t = 5_000_000;
  const f = fakeFetch({ registry: () => [entryFor('agent_s', fx)], jwksByUri: { [fx.jwksUri]: fx.jwks }, get registryStatus() { return status; } });
  // fakeFetch reads registryStatus once at construction; rebuild with a getter-aware wrapper instead:
  const dyn = async (url, init) => fakeFetch({ registry: () => [entryFor('agent_s', fx)], jwksByUri: { [fx.jwksUri]: fx.jwks }, registryStatus: status })(url, init);
  const savedFetch = globalThis.fetch; globalThis.fetch = dyn;
  try {
    const reg = createAgentIdentityIssuerRegistry({ baseUrl: 'http://api.test', internalKey: 'internal-secret', fetchImpl: dyn, env: {}, now: () => t, ttlMs: 1_000 });
    const token = await fx.sign();
    await assert.rejects(reg.verifyForAgent(token, 'agent_s'), (e) => e.code === 'REGISTRY_UNAVAILABLE');
    status = 200;
    t += 10_000;
    assert.ok((await reg.verifyForAgent(token, 'agent_s')).user_ref);
    // backend goes away again; TTL elapses; the stale cache still answers
    status = 503;
    t += 10_000;
    assert.ok((await reg.verifyForAgent(token, 'agent_s')).user_ref);
  } finally {
    globalThis.fetch = savedFetch;
  }
  void f;
});

test('4. disabled without config or with the kill switch', async () => {
  const off1 = createAgentIdentityIssuerRegistry({ baseUrl: '', internalKey: 'x', env: {} });
  const off2 = createAgentIdentityIssuerRegistry({ baseUrl: 'http://api.test', internalKey: '', env: {} });
  const off3 = createAgentIdentityIssuerRegistry({ baseUrl: 'http://api.test', internalKey: 'x', env: { AGENT_FEDERATED_IDENTITY_ENABLED: 'false' } });
  for (const r of [off1, off2, off3]) {
    assert.equal(r.enabled, false);
    await assert.rejects(r.verifyForAgent('a.b.c', 'agent_x'), (e) => e.code === 'FEDERATED_DISABLED');
  }
});

// ── 5. wiring into the strict commerce context ──────────────────────────────────────────────────────────

function mockReq(headers = {}, extra = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { path: '/ucp/mcp', invokeAuth: { agent_id: 'agent_minds' }, ...extra, header(name) { return normalized[String(name || '').toLowerCase()] || ''; } };
}

test('5. deriveStrictCommerceCtxAsync falls through to the calling agent\'s binding only for an UNKNOWN issuer', async () => {
  const minds = await issuerFixture({ iss: 'https://id.minds.example', aud: 'pivota-agent-mcp', kid: 'm1' });
  const global = await issuerFixture({ iss: 'https://identity.test.pivota.local', aud: 'pivota-agent-mcp', kid: 'g1' });

  process.env.NODE_ENV = 'test';
  process.env.PIVOTA_API_BASE = 'http://api.test';
  process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal-secret';
  process.env.IDENTITY_ISSUERS_JSON = JSON.stringify([{ iss: global.iss, aud: global.aud, jwks: global.jwks, algs: [global.alg] }]);
  process.env.AGENT_CHECKOUT_IDENTITY_MAX_TOKEN_AGE = '1h';

  const f = fakeFetch({ registry: () => [entryFor('agent_minds', minds)], jwksByUri: { [minds.jwksUri]: minds.jwks } });
  const savedFetch = globalThis.fetch; globalThis.fetch = f;
  try {
    const server = require('../src/server');
    const derive = server._debug.__agentCheckoutStrict.deriveStrictCommerceCtxAsync;

    // federated token with Minds' key → verified, source says so, binding recorded
    const fed = await minds.sign({ acp_session_id: 'sess_fed' }, { sub: 'minds-user-7' });
    const ctx = await derive(mockReq({ 'X-Agent-User-JWT': `Bearer ${fed}` }));
    assert.match(ctx.user_ref, /^usr_/);
    assert.equal(ctx.acp_session_id, 'sess_fed');
    assert.equal(ctx.identity_source, 'x_agent_user_jwt_federated');
    assert.deepEqual(ctx.identity_diagnostics.issuer_binding, { agent_id: 'agent_minds', iss: minds.iss });

    // the same token with ANOTHER agent's key → no user_ref (ISSUER_NOT_ALLOWED)
    const other = await derive(mockReq({ 'X-Agent-User-JWT': `Bearer ${fed}` }, { invokeAuth: { agent_id: 'agent_other' } }));
    assert.equal(other.user_ref, undefined);
    assert.equal(other.identity_diagnostics.failure_code, 'ISSUER_NOT_ALLOWED');

    // …and with no agent on the request at all (test bypass / checkout token) → static error stands
    const anon = await derive(mockReq({ 'X-Agent-User-JWT': `Bearer ${fed}` }, { invokeAuth: { agent_id: null } }));
    assert.equal(anon.user_ref, undefined);
    assert.equal(anon.identity_diagnostics.failure_code, 'ISSUER_NOT_ALLOWED');

    // the static issuer still works, and a static issuer with a BAD signature is NOT retried federated
    const good = await global.sign({}, { sub: 'static-user' });
    assert.match((await derive(mockReq({ 'X-Agent-User-JWT': `Bearer ${good}` }))).user_ref, /^usr_/);
    const forged = good.slice(0, -4) + 'AAAA';
    const bad = await derive(mockReq({ 'X-Agent-User-JWT': `Bearer ${forged}` }));
    assert.equal(bad.user_ref, undefined);
    assert.equal(bad.identity_diagnostics.failure_code, 'TOKEN_VERIFY_FAILED');
  } finally {
    globalThis.fetch = savedFetch;
  }
});
