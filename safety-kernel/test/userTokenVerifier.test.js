// Per-user token verifier — security tests. Uses jose to mint real signed JWTs against test keypairs, so
// the verifier's signature/JWKS/alg/claim checks are exercised for real (no real IdP needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createUserTokenVerifier, deriveUserRefFromClaims, UserTokenError } from '../src/identity/userTokenVerifier.js';
import { deriveUserRef } from '../../mcp-server/auth/userRef.js';

const ISS = 'https://idp.example.com/';
const AUD = 'pivota-gateway';

async function makeIssuer({ iss = ISS, aud = AUD, alg = 'RS256', kid = 'k1' } = {}) {
  const { publicKey, privateKey } = await generateKeyPair(alg);
  const jwk = await exportJWK(publicKey);
  jwk.alg = alg; jwk.kid = kid; jwk.use = 'sig';
  return { iss, aud, jwks: { keys: [jwk] }, privateKey, alg, kid };
}

async function sign(issuer, { sub = 'user-123', aud = issuer.aud, iss = issuer.iss, exp = '1h', iat, alg = issuer.alg, kid = issuer.kid, key, extra = {} } = {}) {
  let b = new SignJWT({ ...extra }).setProtectedHeader({ alg, kid });
  if (sub !== null) b = b.setSubject(sub);
  if (aud !== null) b = b.setAudience(aud);
  if (iss !== null) b = b.setIssuer(iss);
  b = b.setIssuedAt(iat); // undefined → now
  if (exp !== null) b = b.setExpirationTime(exp);
  return b.sign(key || issuer.privateKey);
}

async function expectReject(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof UserTokenError, `expected UserTokenError, got ${e?.name}: ${e?.message}`);
    if (code) assert.equal(e.code, code, `expected code ${code}, got ${e.code}`);
    return true;
  });
}

test('valid token → user_ref + claims; user_ref matches the MCP-path deriveUserRef exactly', async () => {
  const iss = await makeIssuer();
  const verify = createUserTokenVerifier({ issuers: [{ iss: iss.iss, aud: iss.aud, jwks: iss.jwks, algs: ['RS256'] }] });
  const token = await sign(iss, { sub: 'user-abc' });
  const { user_ref, claims } = await verify(token);
  assert.equal(claims.sub, 'user-abc');
  assert.equal(user_ref, deriveUserRefFromClaims(ISS, 'user-abc'));
  assert.equal(user_ref, deriveUserRef({ iss: ISS, sub: 'user-abc' }), 'must match mcp-server deriveUserRef');
  assert.match(user_ref, /^usr_[A-Za-z0-9_-]{32}$/);
});

test('rejects a wrong audience', async () => {
  const iss = await makeIssuer();
  const verify = createUserTokenVerifier({ issuers: [{ iss: iss.iss, aud: iss.aud, jwks: iss.jwks }] });
  await expectReject(verify(await sign(iss, { aud: 'some-other-service' })), 'TOKEN_VERIFY_FAILED');
});

test('rejects an untrusted issuer (not in the registry)', async () => {
  const trusted = await makeIssuer({ iss: 'https://trusted/' });
  const rogue = await makeIssuer({ iss: 'https://evil/' });
  const verify = createUserTokenVerifier({ issuers: [{ iss: trusted.iss, aud: trusted.aud, jwks: trusted.jwks }] });
  await expectReject(verify(await sign(rogue)), 'ISSUER_NOT_ALLOWED');
});

test('rejects an issuer-spoof: claims a trusted iss but signed with a different key', async () => {
  const trusted = await makeIssuer({ iss: 'https://trusted/' });
  const rogue = await makeIssuer({ iss: 'https://trusted/' }); // same iss string, different keypair
  const verify = createUserTokenVerifier({ issuers: [{ iss: trusted.iss, aud: trusted.aud, jwks: trusted.jwks }] });
  // token claims the trusted iss but is signed by the rogue key (not in trusted's JWKS) → signature fails
  await expectReject(verify(await sign(rogue, { iss: 'https://trusted/' })), 'TOKEN_VERIFY_FAILED');
});

test('rejects an expired token', async () => {
  const iss = await makeIssuer();
  const verify = createUserTokenVerifier({ issuers: [{ iss: iss.iss, aud: iss.aud, jwks: iss.jwks }] });
  const past = Math.floor(Date.now() / 1000) - 7200;
  await expectReject(verify(await sign(iss, { iat: past, exp: past + 60 })), 'TOKEN_VERIFY_FAILED');
});

test('rejects a token older than maxTokenAge even if exp is still valid', async () => {
  const iss = await makeIssuer();
  const verify = createUserTokenVerifier({ issuers: [{ iss: iss.iss, aud: iss.aud, jwks: iss.jwks }], maxTokenAge: '1h' });
  const old = Math.floor(Date.now() / 1000) - 7200; // 2h ago
  await expectReject(verify(await sign(iss, { iat: old, exp: '4h' })), 'TOKEN_VERIFY_FAILED');
});

test('rejects an algorithm outside the per-issuer allowlist (alg confusion)', async () => {
  const iss = await makeIssuer({ alg: 'ES256' });
  // token is ES256, but the issuer is configured to only accept RS256
  const verify = createUserTokenVerifier({ issuers: [{ iss: iss.iss, aud: iss.aud, jwks: iss.jwks, algs: ['RS256'] }] });
  await expectReject(verify(await sign(iss)), 'TOKEN_VERIFY_FAILED');
});

test('rejects a token missing sub (requiredClaims)', async () => {
  const iss = await makeIssuer();
  const verify = createUserTokenVerifier({ issuers: [{ iss: iss.iss, aud: iss.aud, jwks: iss.jwks }] });
  await expectReject(verify(await sign(iss, { sub: null })), 'TOKEN_VERIFY_FAILED');
});

test('rejects malformed / missing tokens', async () => {
  const iss = await makeIssuer();
  const verify = createUserTokenVerifier({ issuers: [{ iss: iss.iss, aud: iss.aud, jwks: iss.jwks }] });
  await expectReject(verify('not-a-jwt'), 'TOKEN_MALFORMED');
  await expectReject(verify(''), 'TOKEN_MISSING');
  await expectReject(verify(undefined), 'TOKEN_MISSING');
});

test('multi-issuer: each token verifies only against its own issuer key set', async () => {
  const a = await makeIssuer({ iss: 'https://a/', kid: 'a1' });
  const b = await makeIssuer({ iss: 'https://b/', kid: 'b1' });
  const verify = createUserTokenVerifier({ issuers: [
    { iss: a.iss, aud: a.aud, jwks: a.jwks },
    { iss: b.iss, aud: b.aud, jwks: b.jwks },
  ] });
  assert.equal((await verify(await sign(a, { sub: 'ua' }))).claims.iss, 'https://a/');
  assert.equal((await verify(await sign(b, { sub: 'ub' }))).claims.iss, 'https://b/');
  // a token claiming issuer A but signed by B's key fails
  await expectReject(verify(await sign(b, { iss: 'https://a/' })), 'TOKEN_VERIFY_FAILED');
});

test('Codex P1: a non-https jwksUri is rejected at config (no key-swap over http)', () => {
  assert.throws(() => createUserTokenVerifier({ issuers: [{ iss: 'https://i/', aud: 'a', jwksUri: 'http://insecure/jwks' }] }), (e) => e.code === 'BAD_ISSUER_CONFIG');
});

test('Codex P2: falsy maxTokenAge and out-of-range clock tolerance are rejected', async () => {
  const iss = await makeIssuer();
  const base = { issuers: [{ iss: iss.iss, aud: iss.aud, jwks: iss.jwks }] };
  assert.throws(() => createUserTokenVerifier({ ...base, maxTokenAge: 0 }), (e) => e.code === 'BAD_CONFIG');
  assert.throws(() => createUserTokenVerifier({ ...base, maxTokenAge: '' }), (e) => e.code === 'BAD_CONFIG');
  assert.throws(() => createUserTokenVerifier({ ...base, clockToleranceSeconds: 9999 }), (e) => e.code === 'BAD_CONFIG');
});

test('Codex P2/P3: iss-with-delimiter, empty/blank aud array, and empty algs are rejected', () => {
  assert.throws(() => createUserTokenVerifier({ issuers: [{ iss: 'https://a|b/', aud: 'x', jwks: { keys: [] } }] }), (e) => e.code === 'BAD_ISSUER_CONFIG');
  assert.throws(() => createUserTokenVerifier({ issuers: [{ iss: 'https://a/', aud: [], jwks: { keys: [] } }] }), (e) => e.code === 'BAD_ISSUER_CONFIG');
  assert.throws(() => createUserTokenVerifier({ issuers: [{ iss: 'https://a/', aud: [''], jwks: { keys: [] } }] }), (e) => e.code === 'BAD_ISSUER_CONFIG');
  assert.throws(() => createUserTokenVerifier({ issuers: [{ iss: 'https://a/', aud: 'x', jwks: { keys: [] }, algs: [] }] }), (e) => e.code === 'BAD_ALG_CONFIG');
});

test('Codex P2: azp + required scope are enforced when configured', async () => {
  const iss = await makeIssuer();
  const verify = createUserTokenVerifier({ issuers: [{ iss: iss.iss, aud: iss.aud, jwks: iss.jwks, azp: 'client-approved', requiredScopes: ['shop'] }] });
  await expectReject(verify(await sign(iss, { extra: { scope: 'shop' } })), 'AZP_NOT_ALLOWED');            // no azp
  await expectReject(verify(await sign(iss, { extra: { azp: 'client-evil', scope: 'shop' } })), 'AZP_NOT_ALLOWED'); // wrong azp
  await expectReject(verify(await sign(iss, { extra: { azp: 'client-approved' } })), 'SCOPE_MISSING');     // missing scope
  const ok = await verify(await sign(iss, { extra: { azp: 'client-approved', scope: 'profile shop' } }));  // both ok
  assert.match(ok.user_ref, /^usr_/);
});

test('config validation fails closed', () => {
  assert.throws(() => createUserTokenVerifier({ issuers: [] }), (e) => e.code === 'NO_ISSUERS');
  assert.throws(() => createUserTokenVerifier({ issuers: [{ iss: 'x', aud: 'a', jwks: { keys: [] }, algs: ['none'] }] }), (e) => e.code === 'BAD_ALG_CONFIG');
  assert.throws(() => createUserTokenVerifier({ issuers: [{ iss: 'x', aud: 'a', jwks: { keys: [] }, algs: ['HS256'] }] }), (e) => e.code === 'BAD_ALG_CONFIG');
  assert.throws(() => createUserTokenVerifier({ issuers: [{ iss: 'x', aud: 'a' }] }), (e) => e.code === 'BAD_ISSUER_CONFIG');
  assert.throws(() => createUserTokenVerifier({ issuers: [{ iss: 'x', jwks: { keys: [] } }] }), (e) => e.code === 'BAD_ISSUER_CONFIG');
});
