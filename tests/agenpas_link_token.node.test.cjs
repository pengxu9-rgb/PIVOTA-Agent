'use strict';

// AgenPas link tokens (src/agenpas/linkToken.js) and the link minter (src/agenpas/link.js): sign, verify, expiry,
// tamper, scope, and the minter's every refusal. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { mintLinkToken, verifyLinkToken, REASON, MAX_LIFETIME_SECONDS } = require('../src/agenpas/linkToken');
const { mintAgenpasUrl, createAgenpasLinkMinter } = require('../src/agenpas/link');

const SECRET = 'test-secret-for-agenpas-links-0123456789';
const OTHER_SECRET = 'another-secret-for-agenpas-links-987654321';
const PID = 'ap_0123456789abcdef01234567';
const OTHER_PID = 'ap_fedcba9876543210fedcba98';
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const CLAIMS = Object.freeze({ purchaseId: PID, agentId: 'agent_fixture_1', userRef: 'usr_fixtureFixtureFixture' });

function mint(over = {}) {
  return mintLinkToken({ ...CLAIMS, secret: SECRET, now: T0, ...over });
}

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function resign(payload, secret = SECRET) {
  const part = b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(`agenpas-link:v1.${part}`).digest('base64url');
  return `v1.${part}.${sig}`;
}

test('a minted token verifies for its purchase and carries its claims', () => {
  const token = mint();
  assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const out = verifyLinkToken(token, { purchaseId: PID, secret: SECRET, now: T0 + 1000 });
  assert.equal(out.ok, true);
  assert.equal(out.claims.purchaseId, PID);
  assert.equal(out.claims.agentId, CLAIMS.agentId);
  assert.equal(out.claims.userRef, CLAIMS.userRef);
  assert.equal(out.claims.exp - out.claims.iat, MAX_LIFETIME_SECONDS);
});

test('two mints differ (nonce), both verify', () => {
  const a = mint();
  const b = mint();
  assert.notEqual(a, b);
  for (const t of [a, b]) assert.equal(verifyLinkToken(t, { purchaseId: PID, secret: SECRET, now: T0 }).ok, true);
});

test('expiry: valid until exp, refused at and after exp; the ttl is capped at 30 minutes', () => {
  const token = mint({ ttlSeconds: 600 });
  assert.equal(verifyLinkToken(token, { purchaseId: PID, secret: SECRET, now: T0 + 599_000 }).ok, true);
  assert.deepEqual(verifyLinkToken(token, { purchaseId: PID, secret: SECRET, now: T0 + 600_000 }), { ok: false, reason: REASON.expired });
  const long = mint({ ttlSeconds: 24 * 3600 });
  const claims = verifyLinkToken(long, { purchaseId: PID, secret: SECRET, now: T0 }).claims;
  assert.equal(claims.exp - claims.iat, MAX_LIFETIME_SECONDS);
});

test('a token signed with a lifetime over 30 minutes is refused even with a valid signature', () => {
  const iat = Math.floor(T0 / 1000);
  const token = resign({ v: 1, p: PID, a: CLAIMS.agentId, u: CLAIMS.userRef, iat, exp: iat + MAX_LIFETIME_SECONDS + 1, n: 'x' });
  assert.deepEqual(verifyLinkToken(token, { purchaseId: PID, secret: SECRET, now: T0 }), { ok: false, reason: REASON.lifetimeTooLong });
});

test('a token issued in the future (beyond skew) is refused', () => {
  const token = mint({ now: T0 + 5 * 60_000 });
  assert.deepEqual(verifyLinkToken(token, { purchaseId: PID, secret: SECRET, now: T0 }), { ok: false, reason: REASON.notYetValid });
});

test('scope: a token for one purchase never opens another', () => {
  assert.deepEqual(verifyLinkToken(mint(), { purchaseId: OTHER_PID, secret: SECRET, now: T0 }), { ok: false, reason: REASON.wrongPurchase });
});

test('tamper: any change to the payload or signature, or another secret, is refused', () => {
  const token = mint();
  const [v, payload, sig] = token.split('.');
  // Payload swapped for another purchase, signature kept.
  const forged = `${v}.${b64({ ...JSON.parse(Buffer.from(payload, 'base64url')), p: OTHER_PID })}.${sig}`;
  assert.equal(verifyLinkToken(forged, { purchaseId: OTHER_PID, secret: SECRET, now: T0 }).reason, REASON.badSignature);
  // One character of the signature flipped.
  const flipped = `${v}.${payload}.${sig.slice(0, -2)}${sig.slice(-2, -1) === 'A' ? 'B' : 'A'}${sig.slice(-1)}`;
  assert.equal(verifyLinkToken(flipped, { purchaseId: PID, secret: SECRET, now: T0 }).reason, REASON.badSignature);
  // Truncated signature (length differs: refused before the constant-time compare).
  assert.equal(verifyLinkToken(`${v}.${payload}.${sig.slice(0, 10)}`, { purchaseId: PID, secret: SECRET, now: T0 }).reason, REASON.badSignature);
  // Another secret.
  assert.equal(verifyLinkToken(token, { purchaseId: PID, secret: OTHER_SECRET, now: T0 }).reason, REASON.badSignature);
  // Expiry pushed out and re-encoded without the secret.
  const iat = Math.floor(T0 / 1000);
  const extended = `v1.${b64({ v: 1, p: PID, a: CLAIMS.agentId, u: CLAIMS.userRef, iat, exp: iat + 60 * 60 * 24, n: 'x' })}.${sig}`;
  assert.equal(verifyLinkToken(extended, { purchaseId: PID, secret: SECRET, now: T0 }).reason, REASON.badSignature);
});

test('malformed tokens are refused without throwing', () => {
  for (const bad of [undefined, null, '', 'v1', 'v1..', 'v2.a.b', 'v1.a.b.c', 'v1.@@.##', 'x'.repeat(5000), 42, {}]) {
    const out = verifyLinkToken(bad, { purchaseId: PID, secret: SECRET, now: T0 });
    assert.equal(out.ok, false);
    assert.ok([REASON.malformed, REASON.badSignature].includes(out.reason), `${String(bad).slice(0, 20)} -> ${out.reason}`);
  }
  // A correctly signed payload that is not the token's shape.
  assert.equal(verifyLinkToken(resign({ v: 1, p: PID }), { purchaseId: PID, secret: SECRET, now: T0 }).reason, REASON.malformed);
  assert.equal(verifyLinkToken(resign([1, 2]), { purchaseId: PID, secret: SECRET, now: T0 }).reason, REASON.malformed);
});

test('no secret: verify refuses and mint throws', () => {
  assert.deepEqual(verifyLinkToken(mint(), { purchaseId: PID, secret: '', now: T0 }), { ok: false, reason: REASON.noSecret });
  assert.throws(() => mintLinkToken({ ...CLAIMS, secret: '' }));
  assert.throws(() => mintLinkToken({ ...CLAIMS, purchaseId: 'ord_1', secret: SECRET }));
});

test('the payload names only the purchase, the agent and the pseudonymous user ref', () => {
  const payload = JSON.parse(Buffer.from(mint().split('.')[1], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload).sort(), ['a', 'exp', 'iat', 'n', 'p', 'u', 'v']);
});

// ---- the minter ------------------------------------------------------------------------------------------------

const ENV_ON = Object.freeze({
  AGENPAS_ENABLED: '1',
  AGENPAS_LINK_SECRET: SECRET,
  AGENPAS_PUBLIC_BASE_URL: 'https://agenpas.example',
});

test('mintAgenpasUrl: on with everything configured, a link to the page whose token verifies', () => {
  const url = mintAgenpasUrl({ ...CLAIMS, env: ENV_ON, now: T0 });
  const u = new URL(url);
  assert.equal(u.origin, 'https://agenpas.example');
  assert.equal(u.pathname, `/agenpas/p/${PID}`);
  assert.equal(verifyLinkToken(u.searchParams.get('t'), { purchaseId: PID, secret: SECRET, now: T0 }).ok, true);
});

test('mintAgenpasUrl: null whenever anything is missing (flag off is the default)', () => {
  const cases = [
    [{}, CLAIMS],
    [{ ...ENV_ON, AGENPAS_ENABLED: '' }, CLAIMS],
    [{ ...ENV_ON, AGENPAS_ENABLED: '0' }, CLAIMS],
    [{ ...ENV_ON, AGENPAS_LINK_SECRET: '' }, CLAIMS],
    [{ ...ENV_ON, AGENPAS_LINK_SECRET: 'short' }, CLAIMS],
    [{ ...ENV_ON, AGENPAS_PUBLIC_BASE_URL: '' }, CLAIMS],
    [{ ...ENV_ON, AGENPAS_PUBLIC_BASE_URL: 'http://agenpas.example' }, CLAIMS],
    [{ ...ENV_ON, AGENPAS_PUBLIC_BASE_URL: 'https://agenpas.example/sub' }, CLAIMS],
    [ENV_ON, { ...CLAIMS, purchaseId: 'not-an-id' }],
    [ENV_ON, { ...CLAIMS, agentId: undefined }],
    [ENV_ON, { ...CLAIMS, userRef: '' }],
  ];
  for (const [env, claims] of cases) assert.equal(mintAgenpasUrl({ ...claims, env, now: T0 }), null, JSON.stringify(env));
});

test('createAgenpasLinkMinter reads the env it was given (or process.env) per call', () => {
  assert.equal(createAgenpasLinkMinter({ env: {} }).mint(CLAIMS), null);
  assert.match(createAgenpasLinkMinter({ env: ENV_ON }).mint(CLAIMS), /^https:\/\/agenpas\.example\/agenpas\/p\/ap_/);
});
