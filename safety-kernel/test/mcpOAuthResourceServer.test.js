import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import {
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
  createMcpAccessTokenVerifier,
  McpOAuthError,
} from '../src/identity/mcpOAuthResourceServer.js';
import { deriveUserRefFromClaims } from '../src/identity/userTokenVerifier.js';

const RESOURCE = 'https://pivota-agent-production.up.railway.app/mcp';
const ISS = 'https://auth.pivota.example';

async function makeIssuer() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const pub = await exportJWK(publicKey);
  pub.kid = 'k1';
  pub.alg = 'ES256';
  return {
    privateKey,
    issuerConfig: { iss: ISS, jwks: { keys: [pub] }, algs: ['ES256'] },
  };
}

async function mint(privateKey, claims = {}, { aud = RESOURCE, exp = '10m', iat = true } = {}) {
  let jwt = new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISS)
    .setAudience(aud)
    .setSubject(claims.sub || 'user-123');
  if (iat) jwt = jwt.setIssuedAt();
  if (exp) jwt = jwt.setExpirationTime(exp);
  return jwt.sign(privateKey);
}

test('protected resource metadata: valid shape', () => {
  const doc = buildProtectedResourceMetadata({
    resource: RESOURCE,
    authorizationServers: [ISS],
    scopesSupported: ['pivota.checkout'],
    resourceName: 'Pivota Commerce',
  });
  assert.equal(doc.resource, RESOURCE);
  assert.deepEqual(doc.authorization_servers, [ISS]);
  assert.deepEqual(doc.bearer_methods_supported, ['header']);
  assert.deepEqual(doc.scopes_supported, ['pivota.checkout']);
  assert.equal(doc.resource_name, 'Pivota Commerce');
});

test('protected resource metadata: requires resource + AS, enforces https', () => {
  assert.throws(() => buildProtectedResourceMetadata({ authorizationServers: [ISS] }), McpOAuthError);
  assert.throws(() => buildProtectedResourceMetadata({ resource: RESOURCE, authorizationServers: [] }), McpOAuthError);
  assert.throws(
    () => buildProtectedResourceMetadata({ resource: 'http://insecure.example/mcp', authorizationServers: [ISS] }),
    McpOAuthError,
  );
});

test('www-authenticate: carries resource_metadata + error, resists header injection', () => {
  const h = buildWwwAuthenticate({
    resourceMetadataUrl: 'https://x.example/.well-known/oauth-protected-resource',
    error: 'invalid_token',
    errorDescription: 'expired',
  });
  assert.match(h, /^Bearer /);
  assert.match(h, /error="invalid_token"/);
  assert.match(h, /resource_metadata="https:\/\/x\.example\/\.well-known\/oauth-protected-resource"/);

  const injected = buildWwwAuthenticate({ resourceMetadataUrl: 'https://x\r\nSet-Cookie: a=b"evil' });
  assert.ok(!/[\r\n]/.test(injected));
  assert.ok(!injected.includes('a=b"evil'.slice(-5) + '"'));
});

test('access token: valid token → user_ref + claims + scopes (parity)', async () => {
  const { privateKey, issuerConfig } = await makeIssuer();
  const verify = createMcpAccessTokenVerifier({ issuers: [issuerConfig], resource: RESOURCE });
  const token = await mint(privateKey, { sub: 'user-abc', scope: 'pivota.checkout openid' });
  const res = await verify(token);
  assert.equal(res.user_ref, deriveUserRefFromClaims(ISS, 'user-abc'));
  assert.equal(res.claims.aud, RESOURCE);
  assert.deepEqual(res.scopes, ['pivota.checkout', 'openid']);
});

test('access token: wrong audience (different resource) is rejected', async () => {
  const { privateKey, issuerConfig } = await makeIssuer();
  const verify = createMcpAccessTokenVerifier({ issuers: [issuerConfig], resource: RESOURCE });
  const token = await mint(privateKey, { sub: 'u' }, { aud: 'https://some-other-resource.example/mcp' });
  await assert.rejects(() => verify(token), (e) => e instanceof McpOAuthError && e.code === 'INVALID_TOKEN');
});

test('access token: untrusted issuer is rejected', async () => {
  const a = await makeIssuer();
  const b = await makeIssuer(); // different keypair, token signed by b but verifier trusts a
  const verify = createMcpAccessTokenVerifier({ issuers: [a.issuerConfig], resource: RESOURCE });
  // forge: sign with b's key but claim a's iss → key set mismatch → reject
  const token = await new SignJWT({ sub: 'u' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISS).setAudience(RESOURCE).setSubject('u').setIssuedAt().setExpirationTime('10m')
    .sign(b.privateKey);
  await assert.rejects(() => verify(token), McpOAuthError);
});

test('access token: expired is rejected', async () => {
  const { privateKey, issuerConfig } = await makeIssuer();
  const verify = createMcpAccessTokenVerifier({ issuers: [issuerConfig], resource: RESOURCE });
  const token = await new SignJWT({ sub: 'u' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISS).setAudience(RESOURCE).setSubject('u')
    .setIssuedAt(Math.floor(Date.now() / 1000) - 4000)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(privateKey);
  await assert.rejects(() => verify(token), McpOAuthError);
});

test('access token: missing sub is rejected', async () => {
  const { privateKey, issuerConfig } = await makeIssuer();
  const verify = createMcpAccessTokenVerifier({ issuers: [issuerConfig], resource: RESOURCE });
  // sign without subject
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISS).setAudience(RESOURCE).setIssuedAt().setExpirationTime('10m')
    .sign(privateKey);
  await assert.rejects(() => verify(token), McpOAuthError);
});

test('access token: required scope enforced (insufficient_scope)', async () => {
  const { privateKey, issuerConfig } = await makeIssuer();
  const verify = createMcpAccessTokenVerifier({
    issuers: [{ ...issuerConfig, requiredScopes: ['pivota.checkout'] }],
    resource: RESOURCE,
  });
  const ok = await verify(await mint(privateKey, { sub: 'u', scope: 'pivota.checkout' }));
  assert.ok(ok.user_ref);
  const underScoped = await mint(privateKey, { sub: 'u', scope: 'openid' });
  await assert.rejects(
    () => verify(underScoped),
    (e) => e instanceof McpOAuthError && e.code === 'INSUFFICIENT_SCOPE' && e.status === 403,
  );
});

test('access token: symmetric alg config is rejected (no HS*/none)', () => {
  assert.throws(
    () => createMcpAccessTokenVerifier({ issuers: [{ iss: ISS, jwks: { keys: [] }, algs: ['HS256'] }], resource: RESOURCE }),
    McpOAuthError,
  );
});
