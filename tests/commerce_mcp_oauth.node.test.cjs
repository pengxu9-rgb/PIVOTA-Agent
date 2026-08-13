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
