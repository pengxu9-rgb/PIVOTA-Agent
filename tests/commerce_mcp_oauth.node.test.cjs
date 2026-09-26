const { test } = require('node:test');
const assert = require('node:assert/strict');
const glue = require('../src/commerceMcpOAuth.js');

const RESOURCE = 'https://agent.test.example/mcp';
const ISS = 'https://auth.test.example';

function reqWith(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: lower, get: (h) => lower[String(h).toLowerCase()] };
}

function setBaseEnv() {
  process.env.MCP_OAUTH_ENABLED = '1';
  process.env.MCP_OAUTH_RESOURCE = RESOURCE;
  process.env.MCP_OAUTH_AUTHORIZATION_SERVERS = ISS;
  delete process.env.MCP_OAUTH_ISSUERS_JSON;
  delete process.env.IDENTITY_ISSUERS_JSON;
}

async function makeToken({ aud = RESOURCE, sub = 'user-xyz', scope } = {}) {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const pub = await exportJWK(publicKey);
  pub.kid = 'k1';
  pub.alg = 'ES256';
  const issuers = JSON.stringify([{ iss: ISS, jwks: { keys: [pub] }, algs: ['ES256'] }]);
  let jwt = new SignJWT(scope ? { scope } : {})
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISS).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime('10m');
  const token = await jwt.sign(privateKey);
  return { token, issuers };
}

test('disabled → mode disabled', async () => {
  delete process.env.MCP_OAUTH_ENABLED;
  glue.__resetVerifierCache();
  const r = await glue.resolveMcpOAuthIdentity(reqWith({}));
  assert.equal(r.mode, 'disabled');
});

test('api key present → mode apikey (falls back to existing channel)', async () => {
  setBaseEnv();
  glue.__resetVerifierCache();
  const ak = 'ak_live_' + 'a'.repeat(64);
  const r1 = await glue.resolveMcpOAuthIdentity(reqWith({ Authorization: `Bearer ${ak}` }));
  assert.equal(r1.mode, 'apikey');
  const r2 = await glue.resolveMcpOAuthIdentity(reqWith({ 'X-Agent-Api-Key': 'whatever' }));
  assert.equal(r2.mode, 'apikey');
});

test('no token → 401 challenge with resource_metadata', async () => {
  setBaseEnv();
  glue.__resetVerifierCache();
  const r = await glue.resolveMcpOAuthIdentity(reqWith({ host: 'agent.test.example' }));
  assert.equal(r.mode, 'challenge');
  assert.equal(r.status, 401);
  assert.match(r.wwwAuthenticate, /^Bearer /);
  assert.match(r.wwwAuthenticate, /resource_metadata=/);
});

test('valid OAuth token → mode oauth with user_ref', async () => {
  setBaseEnv();
  const { token, issuers } = await makeToken({ sub: 'user-xyz' });
  process.env.MCP_OAUTH_ISSUERS_JSON = issuers;
  glue.__resetVerifierCache();
  const r = await glue.resolveMcpOAuthIdentity(reqWith({ Authorization: `Bearer ${token}` }));
  assert.equal(r.mode, 'oauth');
  assert.match(r.user_ref, /^usr_/);
  assert.equal(r.claims.sub, 'user-xyz');
});

test('token for a different resource (aud) → 401 challenge', async () => {
  setBaseEnv();
  const { token, issuers } = await makeToken({ aud: 'https://elsewhere.example/mcp' });
  process.env.MCP_OAUTH_ISSUERS_JSON = issuers;
  glue.__resetVerifierCache();
  const r = await glue.resolveMcpOAuthIdentity(reqWith({ Authorization: `Bearer ${token}` }));
  assert.equal(r.mode, 'challenge');
  assert.equal(r.status, 401);
});

test('discovery route returns metadata when enabled', async () => {
  setBaseEnv();
  const routes = {};
  const app = { get: (p, h) => { routes[p] = h; } };
  glue.registerMcpOAuthDiscoveryRoutes(app, {});
  assert.ok(routes['/.well-known/oauth-protected-resource']);
  let status, body, headers = {};
  const res = {
    status(s) { status = s; return this; },
    json(b) { body = b; return this; },
    setHeader(k, v) { headers[k] = v; },
  };
  await routes['/.well-known/oauth-protected-resource'](reqWith({ host: 'agent.test.example' }), res);
  assert.equal(status, 200);
  assert.equal(body.resource, RESOURCE);
  assert.deepEqual(body.authorization_servers, [ISS]);
});

test('discovery route 404 when disabled', async () => {
  delete process.env.MCP_OAUTH_ENABLED;
  const routes = {};
  glue.registerMcpOAuthDiscoveryRoutes({ get: (p, h) => { routes[p] = h; } }, {});
  let status;
  await routes['/.well-known/oauth-protected-resource'](reqWith({}), {
    status(s) { status = s; return this; }, json() { return this; }, setHeader() {},
  });
  assert.equal(status, 404);
});

function captureRes() {
  const out = { status: undefined, body: undefined };
  return {
    out,
    res: {
      status(s) { out.status = s; return this; },
      json(b) { out.body = b; return this; },
      setHeader() {},
    },
  };
}

test('discovery route 404 on suppressed (public read tier) hosts, 200 elsewhere', async () => {
  setBaseEnv();
  const routes = {};
  glue.registerMcpOAuthDiscoveryRoutes({ get: (p, h) => { routes[p] = h; } }, {
    suppressForRequest: (req) => req.get('host') === 'public.test.example',
  });

  // the public host must NOT be described as OAuth-protected — its /mcp is anonymous
  const a = captureRes();
  await routes['/.well-known/oauth-protected-resource'](reqWith({ host: 'public.test.example' }), a.res);
  assert.equal(a.out.status, 404);

  // the path-suffixed variant is the same surface and must suppress identically
  const b = captureRes();
  await routes['/.well-known/oauth-protected-resource/mcp'](reqWith({ host: 'public.test.example' }), b.res);
  assert.equal(b.out.status, 404);

  // any other host keeps serving the real metadata
  const c = captureRes();
  await routes['/.well-known/oauth-protected-resource'](reqWith({ host: 'agent.test.example' }), c.res);
  assert.equal(c.out.status, 200);
  assert.equal(c.out.body.resource, RESOURCE);
});

test('discovery route ignores a non-function suppressForRequest', async () => {
  setBaseEnv();
  const routes = {};
  glue.registerMcpOAuthDiscoveryRoutes({ get: (p, h) => { routes[p] = h; } }, {
    suppressForRequest: 'not-a-function',
  });
  const a = captureRes();
  await routes['/.well-known/oauth-protected-resource'](reqWith({ host: 'public.test.example' }), a.res);
  assert.equal(a.out.status, 200);
});

// ---------------------------------------------------------------------------------------------------
// RFC 9728 §3.3: the document a challenge points at must declare the identifier of the door that
// issued the challenge.
//
// THE DEFECT THIS CLOSES, observed live on 2026-08-13 after /ucp/mcp was lit: POST /ucp/mcp answered
//   401 WWW-Authenticate: Bearer … resource_metadata="https://commerce.mcp.pivota.cc/.well-known/oauth-protected-resource"
// and that document declared `resource: "https://commerce.mcp.pivota.cc/mcp"` — the NATIVE door. A
// client following the challenge from /ucp/mcp was told the resource it had reached was /mcp. A strict
// client that checks the two agree has no identifier to request a token for; a lenient one mints for
// /mcp and works only because this server happened to accept that audience everywhere.
//
// Both doors are now their own resource, each with its own metadata document, and the UCP door still
// accepts the native audience so the clients that were minting for it before this fix keep working.

const UCP_RESOURCE = 'https://agent.test.example/ucp/mcp';
const FOREIGN_RESOURCE = 'https://someone-else.example/mcp';
const METADATA_ROOT = '/.well-known/oauth-protected-resource';

function reqAt(path, headers = {}) {
  const r = reqWith(headers);
  r.path = path;
  return r;
}

/** Mount the real discovery routes and return { path -> handler }. */
function mountRoutes() {
  const routes = {};
  glue.registerMcpOAuthDiscoveryRoutes({ get: (p, h) => { routes[p] = h; } }, {});
  return routes;
}

async function fetchMetadata(routes, path, headers) {
  const { out, res } = captureRes();
  const handler = routes[path];
  assert.ok(handler, `no metadata route mounted at ${path}`);
  await handler(reqAt(path, headers), res);
  return out;
}

test('door identity: each door resolves to its own resource identifier', () => {
  setBaseEnv();
  assert.equal(glue.resourceFor(reqAt('/mcp')), RESOURCE);
  assert.equal(glue.resourceFor(reqAt('/ucp/mcp')), UCP_RESOURCE);
  // Express serves these spellings too, so they must not fall back to the native identifier.
  assert.equal(glue.resourceFor(reqAt('/ucp/mcp/')), UCP_RESOURCE);
  assert.equal(glue.resourceFor(reqAt('/UCP/MCP')), UCP_RESOURCE);
});

test('the UCP audience follows the CONFIGURED origin, not the Host header', () => {
  setBaseEnv();
  // This service answers on the branded host and on its Railway domain. If the identifier tracked
  // Host, a token minted via one hostname would fail at the other.
  const viaOtherHost = glue.resourceFor(reqAt('/ucp/mcp', { host: 'pivota-agent-production.up.railway.app' }));
  assert.equal(viaOtherHost, UCP_RESOURCE);
});

test('CHALLENGE → METADATA is self-consistent for BOTH doors (the actual defect)', async () => {
  setBaseEnv();
  glue.__resetVerifierCache();
  const routes = mountRoutes();

  for (const [doorPath, expectedResource] of [['/mcp', RESOURCE], ['/ucp/mcp', UCP_RESOURCE]]) {
    const challenge = await glue.resolveMcpOAuthIdentity(reqAt(doorPath, { host: 'agent.test.example' }));
    assert.equal(challenge.mode, 'challenge');
    const url = /resource_metadata="([^"]+)"/.exec(challenge.wwwAuthenticate)?.[1];
    assert.ok(url, `${doorPath} challenge carries no resource_metadata`);

    // Follow it exactly as a client would: fetch that URL and read `resource`.
    const doc = await fetchMetadata(routes, new URL(url).pathname, { host: 'agent.test.example' });
    assert.equal(doc.status, 200, `${url} did not serve metadata`);
    assert.equal(
      doc.body.resource,
      expectedResource,
      `${doorPath} pointed at a document describing ${doc.body.resource}`,
    );
    // ...and the identifier is exactly the door the client called.
    assert.equal(new URL(doc.body.resource).pathname, doorPath);
  }
});

test('the bare root metadata path keeps describing the NATIVE door (native clients discovered it)', async () => {
  setBaseEnv();
  const doc = await fetchMetadata(mountRoutes(), METADATA_ROOT, { host: 'agent.test.example' });
  assert.equal(doc.status, 200);
  assert.equal(doc.body.resource, RESOURCE);
});

test('a token minted for the UCP door is accepted THERE', async () => {
  setBaseEnv();
  const { token, issuers } = await makeToken({ aud: UCP_RESOURCE });
  process.env.MCP_OAUTH_ISSUERS_JSON = issuers;
  glue.__resetVerifierCache();
  const r = await glue.resolveMcpOAuthIdentity(reqAt('/ucp/mcp', { Authorization: `Bearer ${token}` }));
  assert.equal(r.mode, 'oauth', `expected oauth, got ${r.mode}: ${r.body?.message || ''}`);
  assert.ok(r.user_ref);
});

test('a token minted for the NATIVE resource still works at the UCP door (no flag day)', async () => {
  setBaseEnv();
  const { token, issuers } = await makeToken({ aud: RESOURCE });
  process.env.MCP_OAUTH_ISSUERS_JSON = issuers;
  glue.__resetVerifierCache();
  const r = await glue.resolveMcpOAuthIdentity(reqAt('/ucp/mcp', { Authorization: `Bearer ${token}` }));
  assert.equal(r.mode, 'oauth', 'the UCP door must not break clients that minted before it had an identifier');
});

test('the NATIVE door does NOT widen: a UCP-audience token is refused there', async () => {
  setBaseEnv();
  const { token, issuers } = await makeToken({ aud: UCP_RESOURCE });
  process.env.MCP_OAUTH_ISSUERS_JSON = issuers;
  glue.__resetVerifierCache();
  const r = await glue.resolveMcpOAuthIdentity(reqAt('/mcp', { Authorization: `Bearer ${token}` }));
  assert.equal(r.mode, 'challenge');
  assert.equal(r.status, 401);
});

test('a token for a FOREIGN resource is refused at both doors (RFC 8707 still holds)', async () => {
  setBaseEnv();
  const { token, issuers } = await makeToken({ aud: FOREIGN_RESOURCE });
  process.env.MCP_OAUTH_ISSUERS_JSON = issuers;
  for (const doorPath of ['/mcp', '/ucp/mcp']) {
    glue.__resetVerifierCache();
    const r = await glue.resolveMcpOAuthIdentity(reqAt(doorPath, { Authorization: `Bearer ${token}` }));
    assert.equal(r.mode, 'challenge', `${doorPath} accepted a token for ${FOREIGN_RESOURCE}`);
    assert.equal(r.status, 401);
  }
});

test('MCP_OAUTH_RESOURCE_METADATA_URL overrides the NATIVE door only', async () => {
  setBaseEnv();
  process.env.MCP_OAUTH_RESOURCE_METADATA_URL = 'https://agent.test.example/custom-metadata';
  try {
    assert.equal(glue.resourceMetadataUrlFor(reqAt('/mcp')), 'https://agent.test.example/custom-metadata');
    // Honouring a single-valued override on /ucp/mcp would point it back at a document describing
    // /mcp — the exact mismatch this change removes.
    assert.equal(
      glue.resourceMetadataUrlFor(reqAt('/ucp/mcp')),
      `https://agent.test.example${METADATA_ROOT}/ucp/mcp`,
    );
  } finally {
    delete process.env.MCP_OAUTH_RESOURCE_METADATA_URL;
  }
});

// The claim "the two doors never share a verifier" was a COMMENT with nothing behind it. Adversarial
// review showed a constant cache key passes every other test in this file while the real app hands a
// UCP-audience token a 200 at /mcp — because every other test calls __resetVerifierCache() first and so
// never exercises the one thing the cache exists for: a warm process serving both doors in turn.
// These two tests deliberately do NOT reset between doors.
test('a WARM UCP verifier is not reused at the native door (no cache borrow)', async () => {
  setBaseEnv();
  const { token, issuers } = await makeToken({ aud: UCP_RESOURCE });
  process.env.MCP_OAUTH_ISSUERS_JSON = issuers;
  glue.__resetVerifierCache();

  // Warm /ucp/mcp first, exactly as a live process would be warmed by real traffic.
  const warm = await glue.resolveMcpOAuthIdentity(reqAt('/ucp/mcp', { Authorization: `Bearer ${token}` }));
  assert.equal(warm.mode, 'oauth', 'precondition: the UCP door accepts its own audience');

  // ...then the SAME token at the native door, with no reset in between.
  const native = await glue.resolveMcpOAuthIdentity(reqAt('/mcp', { Authorization: `Bearer ${token}` }));
  assert.equal(native.mode, 'challenge', 'the native door served the UCP door’s cached verifier');
  assert.equal(native.status, 401);
});

test('an unset MCP_OAUTH_RESOURCE yields NO identifier — the Host header can never become one', async () => {
  // THE VULNERABILITY THIS REMOVES. nativeResource() used to end
  //     return host ? `https://${host}/mcp` : undefined;
  // so with MCP_OAUTH_RESOURCE unset the token audience was derived from the caller's own Host header.
  // The audience IS the protection in RFC 8707 — "this token was minted for ME" — so a caller who
  // chose the Host chose the audience, and a token they minted from their own authorization server
  // verified here. Measured live on a charge-capable door before removal.
  setBaseEnv();
  delete process.env.MCP_OAUTH_RESOURCE;

  const evil = 'evil.attacker.example';
  const { token, issuers } = await makeToken({ aud: `https://${evil}/mcp` });
  process.env.MCP_OAUTH_ISSUERS_JSON = issuers;

  // No identifier at all, on either door — not a Host-derived one.
  assert.equal(glue.resourceFor(reqAt('/mcp', { host: evil })), undefined);
  assert.equal(glue.resourceFor(reqAt('/ucp/mcp', { host: evil })), undefined);
  assert.deepEqual(glue.acceptedResourcesFor(reqAt('/mcp', { host: evil })), []);

  // ...so the attacker-minted token is refused at both doors instead of authenticating.
  for (const doorPath of ['/mcp', '/ucp/mcp']) {
    glue.__resetVerifierCache();
    const r = await glue.resolveMcpOAuthIdentity(reqAt(doorPath, { host: evil, Authorization: `Bearer ${token}` }));
    assert.equal(r.mode, 'challenge', `${doorPath} accepted an audience derived from the Host header`);
    assert.equal(r.status, 401);
  }
});

test('with no configured resource the challenge advertises nothing, and metadata 404s', async () => {
  // Fail closed rather than pointing the caller at a URL assembled from their own header.
  setBaseEnv();
  delete process.env.MCP_OAUTH_RESOURCE;
  glue.__resetVerifierCache();

  assert.equal(glue.resourceMetadataUrlFor(reqAt('/mcp', { host: 'evil.attacker.example' })), undefined);
  const r = await glue.resolveMcpOAuthIdentity(reqAt('/ucp/mcp', { host: 'evil.attacker.example' }));
  assert.equal(r.mode, 'challenge');
  assert.equal(/resource_metadata=/.test(r.wwwAuthenticate), false, 'advertised a Host-derived metadata URL');

  const routes = mountRoutes();
  for (const path of [METADATA_ROOT, `${METADATA_ROOT}/mcp`, `${METADATA_ROOT}/ucp/mcp`]) {
    const doc = await fetchMetadata(routes, path, { host: 'evil.attacker.example' });
    assert.equal(doc.status, 404, `${path} published a document for an unconfigured resource`);
  }
});
