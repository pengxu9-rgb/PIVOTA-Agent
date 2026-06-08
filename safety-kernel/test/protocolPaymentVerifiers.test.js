// Crypto verifier tests — mint REAL signed grants + AP2 SD-JWT mandates with jose and verify them, then run
// them end-to-end through the unified binding verifier. Proves: pinned-JWKS signature verification, disclosure
// integrity (a forged disclosure is rejected), and fail-closed on tamper/untrusted issuer/expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { createSignedGrantVerifier, createAp2MandateVerifier } from '../src/protocol/protocolPaymentVerifiers.js';
import { createPaymentAuthorizationVerifier } from '../src/protocol/paymentAuthorizationVerifier.js';

const ISS = 'https://psp.example';
const AUD = 'pivota-merchant';
const BOUND = { order_id: 'o1', user_ref: 'usr_x', amount: 113, currency: 'USD', ctx: { acp_session_id: 'sess_1' } };

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey); jwk.alg = 'ES256'; jwk.use = 'sig'; jwk.kid = 'k1';
  return { privateKey, jwks: { keys: [jwk] } };
}
const issuers = (jwks) => [{ iss: ISS, aud: AUD, jwks, algs: ['ES256'] }];

async function signGrant(privateKey, claims, { exp = '1h', jti = 'g1', sub } = {}) {
  let s = new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(ISS).setAudience(AUD).setIssuedAt().setExpirationTime(exp).setJti(jti);
  if (sub) s = s.setSubject(sub);
  return s.sign(privateKey);
}

function disclosure(name, value) {
  const d = Buffer.from(JSON.stringify([randomBytes(16).toString('base64url'), name, value])).toString('base64url');
  return { d, digest: createHash('sha256').update(d).digest('base64url') };
}

// A Checkout Mandate carries checkout_hash by default (the binding is mandatory); pass checkoutHash:null to omit.
const VCT = 'urn:ap2:checkout-mandate';
async function signMandate(privateKey, { plain = {}, disclosed = {}, exp = '1h', jti = 'm1', sub, checkoutHash = 'ch_1', vct = VCT } = {}) {
  const base = { ...(vct === null ? {} : { vct }), ...(checkoutHash === null ? {} : { checkout_hash: checkoutHash }) };
  const fullPlain = { ...base, ...plain };
  const ds = Object.entries(disclosed).map(([k, v]) => ({ name: k, ...disclosure(k, v) }));
  let s = new SignJWT({ ...fullPlain, _sd: ds.map((x) => x.digest), _sd_alg: 'sha-256' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(ISS).setAudience(AUD).setIssuedAt().setExpirationTime(exp).setJti(jti);
  if (sub) s = s.setSubject(sub);
  const issuerJwt = await s.sign(privateKey);
  return { sdjwt: `${issuerJwt}~${ds.map((x) => x.d).join('~')}~`, disclosures: ds };
}

// merchant-side checkout-hash verifier stub: proves checkout_hash against the merchant's own Checkout JWT and
// yields the authoritative session id. The session binding comes from HERE, not the mandate's self-assertion.
const VCH = async () => ({ checkout_session_id: 'sess_1' });
const ap2 = (jwks, verifyCheckoutHash = VCH) => createAp2MandateVerifier({ issuers: issuers(jwks), verifyCheckoutHash });

// --- signed grant (ACP delegated token / UCP handler) ----------------------------------------------------

test('signed grant: a valid allowance JWT verifies to its claims', async () => {
  const { privateKey, jwks } = await keys();
  const verify = createSignedGrantVerifier({ issuers: issuers(jwks) });
  const token = await signGrant(privateKey, { allowance: { max_amount: 200, currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1' } });
  const claims = await verify({ method: 'acp_delegated_token', token });
  assert.equal(claims.max_amount, 200);
  assert.equal(claims.currency, 'USD');
  assert.equal(claims.merchant_id, 'merch_A');
  assert.equal(claims.checkout_session_id, 'sess_1');
  assert.equal(claims.id, 'g1');
  assert.ok(claims.expires_at > Date.now());
});

test('signed grant: explicit signed user_ref supports separate identity and payment issuers', async () => {
  const { privateKey, jwks } = await keys();
  const verify = createPaymentAuthorizationVerifier({
    merchantId: 'merch_A',
    methods: { acp_delegated_token: createSignedGrantVerifier({ issuers: issuers(jwks) }) },
  });
  const token = await signGrant(privateKey, {
    allowance: {
      max_amount: 200,
      currency: 'USD',
      merchant_id: 'merch_A',
      checkout_session_id: 'sess_1',
      user_ref: 'usr_x',
    },
  });
  const att = await verify({ method: 'acp_delegated_token', token }, BOUND);
  assert.equal(att.user_ref, 'usr_x');

  const direct = createSignedGrantVerifier({ issuers: issuers(jwks) });
  const conflicting = await signGrant(privateKey, {
    allowance: {
      max_amount: 200,
      currency: 'USD',
      merchant_id: 'merch_A',
      checkout_session_id: 'sess_1',
      user_ref: 'usr_x',
    },
  }, { sub: 'different-buyer' });
  await assert.rejects(
    direct({ method: 'acp_delegated_token', token: conflicting }),
    (e) => e.detail?.reason === 'grant_user_ref_mismatch',
  );
});

test('signed grant: tampered token / untrusted issuer / missing token fail closed', async () => {
  const { privateKey, jwks } = await keys();
  const other = await keys();
  const verify = createSignedGrantVerifier({ issuers: issuers(jwks) });
  const token = await signGrant(privateKey, { allowance: { max_amount: 200, currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1' } });
  // tamper a char in the signature
  const bad = token.slice(0, -3) + (token.slice(-3) === 'AAA' ? 'BBB' : 'AAA');
  await assert.rejects(verify({ method: 'acp_delegated_token', token: bad }), (e) => e.detail?.reason === 'credential_signature_invalid');
  // signed by a DIFFERENT key (issuer string matches but key isn't the pinned one) → signature invalid
  const forged = await signGrant(other.privateKey, { allowance: { max_amount: 200, currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1' } });
  await assert.rejects(verify({ method: 'acp_delegated_token', token: forged }), (e) => e.detail?.reason === 'credential_signature_invalid');
  await assert.rejects(verify({ method: 'acp_delegated_token' }), (e) => e.detail?.reason === 'grant_token_missing');
});

test('signed grant: expired token fails closed (jose exp)', async () => {
  const { privateKey, jwks } = await keys();
  const verify = createSignedGrantVerifier({ issuers: issuers(jwks) });
  const token = await signGrant(privateKey, { allowance: { max_amount: 200, currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1' } }, { exp: '-5m' });
  await assert.rejects(verify({ method: 'acp_delegated_token', token }), (e) => e.detail?.reason === 'credential_signature_invalid');
});

// --- AP2 Checkout Mandate (SD-JWT) -----------------------------------------------------------------------

test('AP2 mandate: disclosures reconstruct claims; session comes from the VERIFIED checkout-hash, not the mandate', async () => {
  const { privateKey, jwks } = await keys();
  const verify = ap2(jwks, async () => ({ checkout_session_id: 'sess_VERIFIED' }));
  const { sdjwt } = await signMandate(privateKey, {
    plain: { merchant_id: 'merch_A', checkout_session_id: 'sess_SELF_ASSERTED' }, // self-asserted — must be IGNORED
    disclosed: { amount: 113, currency: 'USD' },
    sub: 'buyer-123',
  });
  const claims = await verify({ method: 'ap2_mandate', mandate: sdjwt });
  assert.equal(claims.amount, 113);
  assert.equal(claims.currency, 'USD');
  assert.equal(claims.merchant_id, 'merch_A');
  assert.equal(claims.checkout_session_id, 'sess_VERIFIED', 'session must come from the merchant Checkout JWT, not the mandate self-assertion');
  assert.ok(claims.user_ref?.startsWith('usr_'));
});

test('AP2 mandate: a FORGED disclosure (digest not in _sd) is rejected', async () => {
  const { privateKey, jwks } = await keys();
  const verify = ap2(jwks);
  const { sdjwt } = await signMandate(privateKey, { plain: { merchant_id: 'merch_A' }, disclosed: { amount: 113 } });
  const forged = disclosure('currency', 'EUR').d; // never committed to _sd
  const tampered = sdjwt.slice(0, -1) + forged + '~';
  await assert.rejects(verify({ method: 'ap2_mandate', mandate: tampered }), (e) => e.detail?.reason === 'disclosure_not_in_sd');
});

test('AP2 mandate: tampered issuer JWT fails the signature', async () => {
  const { privateKey, jwks } = await keys();
  const verify = ap2(jwks);
  const { sdjwt } = await signMandate(privateKey, { plain: { merchant_id: 'merch_A' }, disclosed: { amount: 113 } });
  const [jwt, ...rest] = sdjwt.split('~');
  const badJwt = jwt.slice(0, -3) + (jwt.slice(-3) === 'AAA' ? 'BBB' : 'AAA');
  await assert.rejects(verify({ method: 'ap2_mandate', mandate: [badJwt, ...rest].join('~') }), (e) => e.detail?.reason === 'credential_signature_invalid');
});

test('AP2 mandate: checkout-hash binding is MANDATORY (P0)', async () => {
  const { jwks } = await keys();
  // construction without verifyCheckoutHash is refused
  assert.throws(() => createAp2MandateVerifier({ issuers: issuers(jwks) }), /verifyCheckoutHash/);
  // a mandate with no checkout_hash fails closed
  const { privateKey } = await keys();
  const k = await keys();
  const verify = ap2(k.jwks);
  const { sdjwt } = await signMandate(k.privateKey, { plain: { merchant_id: 'merch_A' }, disclosed: { amount: 113, currency: 'USD' }, checkoutHash: null });
  await assert.rejects(verify({ method: 'ap2_mandate', mandate: sdjwt }), (e) => e.detail?.reason === 'mandate_no_checkout_hash');
});

test('AP2 mandate: a plain compact JWT (no SD-JWT structure) is rejected (method confusion, P1)', async () => {
  const { privateKey, jwks } = await keys();
  const verify = ap2(jwks);
  const plainJwt = await signGrant(privateKey, { allowance: { max_amount: 200, currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1' } });
  await assert.rejects(verify({ method: 'ap2_mandate', mandate: plainJwt }), (e) => e.detail?.reason === 'not_sd_jwt');
});

test('AP2 mandate: a disclosure cannot OVERRIDE a protected plain claim (P1)', async () => {
  const { privateKey, jwks } = await keys();
  const verify = ap2(jwks);
  // issuer (mis)commits both a plain merchant_id and a disclosed merchant_id → ambiguous → fail closed
  const { sdjwt } = await signMandate(privateKey, { plain: { merchant_id: 'merch_A' }, disclosed: { merchant_id: 'merch_EVIL', amount: 113, currency: 'USD' } });
  await assert.rejects(verify({ method: 'ap2_mandate', mandate: sdjwt }), (e) => e.detail?.reason === 'disclosure_overrides_claim');
});

// --- end to end through the unified verifier --------------------------------------------------------------

test('E2E: unified verifier with real grant + mandate crypto → attestation; binding still enforced', async () => {
  const { privateKey, jwks } = await keys();
  const verify = createPaymentAuthorizationVerifier({
    merchantId: 'merch_A',
    methods: {
      acp_delegated_token: createSignedGrantVerifier({ issuers: issuers(jwks) }),
      ap2_mandate: ap2(jwks, async () => ({ checkout_session_id: 'sess_1' })),
    },
  });
  // ACP allowance covering 113
  const grant = await signGrant(privateKey, { allowance: { max_amount: 500, currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1' } });
  const a1 = await verify({ method: 'acp_delegated_token', token: grant }, BOUND);
  assert.deepEqual(a1, { ok: true, method: 'acp_delegated_token', amount: 113, currency: 'USD', user_ref: 'usr_x', authorization_id: 'g1' });

  // AP2 exact mandate for 113
  const { sdjwt } = await signMandate(privateKey, { plain: { merchant_id: 'merch_A', checkout_session_id: 'sess_1' }, disclosed: { amount: 113, currency: 'USD' } });
  const a2 = await verify({ method: 'ap2_mandate', mandate: sdjwt }, BOUND);
  assert.equal(a2.ok, true);
  assert.equal(a2.method, 'ap2_mandate');

  // a grant for a DIFFERENT session is rejected by the binding even though the signature is valid
  const wrongSession = await signGrant(privateKey, { allowance: { max_amount: 500, currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_OTHER' } });
  await assert.rejects(verify({ method: 'acp_delegated_token', token: wrongSession }, BOUND), (e) => e.detail?.reason === 'session_mismatch');

  // an allowance that doesn't cover the amount is rejected
  const tooSmall = await signGrant(privateKey, { allowance: { max_amount: 100, currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1' } });
  await assert.rejects(verify({ method: 'acp_delegated_token', token: tooSmall }, BOUND), (e) => e.detail?.reason === 'amount_exceeds_allowance');
});

test('P0 prototype pollution: a polluted Object.prototype._sd cannot forge AP2 disclosures', async () => {
  const { privateKey, jwks } = await keys();
  const verify = ap2(jwks);
  // a real disclosure for a HUGE amount; commit its digest only on Object.prototype (NOT in the signed _sd)
  const forged = disclosure('amount', 999999);
  // mandate signed with NO own _sd-committed amount; amount must therefore be absent → binding fails
  const { sdjwt } = await signMandate(privateKey, { plain: { merchant_id: 'merch_A' }, disclosed: { currency: 'USD' } });
  const malicious = sdjwt.slice(0, -1) + forged.d + '~';
  Object.prototype._sd = [forged.digest]; // eslint-disable-line no-extend-native
  try {
    await assert.rejects(verify({ method: 'ap2_mandate', mandate: malicious }), (e) => e.detail?.reason === 'disclosure_not_in_sd');
  } finally {
    delete Object.prototype._sd;
  }
});

test('P0 prototype pollution: a polluted Object.prototype.allowance cannot synthesize a grant allowance', async () => {
  const { privateKey, jwks } = await keys();
  const verify = createSignedGrantVerifier({ issuers: issuers(jwks) });
  // a signed token with NO own allowance / max_amount claims
  const token = await signGrant(privateKey, { currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1' });
  Object.prototype.allowance = { max_amount: 999999, currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1' }; // eslint-disable-line no-extend-native
  try {
    const claims = await verify({ method: 'acp_delegated_token', token });
    assert.equal(claims.max_amount, undefined, 'inherited allowance must NOT be read');
  } finally {
    delete Object.prototype.allowance;
  }
});

test('P0 prototype pollution: inherited iss/aud cannot satisfy required registered claims (1a)', async () => {
  const { privateKey, jwks } = await keys();
  const verify = createSignedGrantVerifier({ issuers: issuers(jwks) });
  const allowance = { max_amount: 200, currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1' };
  // (a) token with NO own iss (valid signature, own exp+allowance) — peek must not select a key set via inherited iss
  const noIss = await new SignJWT({ allowance }).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuedAt().setExpirationTime('1h').setJti('g1').sign(privateKey);
  // (b) token with own iss but NO own aud
  const noAud = await new SignJWT({ allowance }).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(ISS).setIssuedAt().setExpirationTime('1h').setJti('g1').sign(privateKey);
  Object.prototype.iss = ISS; Object.prototype.aud = AUD; // eslint-disable-line no-extend-native
  try {
    await assert.rejects(verify({ method: 'acp_delegated_token', token: noIss }), (e) => e.code === 'CONFIRMATION_INVALID');
    await assert.rejects(verify({ method: 'acp_delegated_token', token: noAud }), (e) => e.code === 'CONFIRMATION_INVALID');
  } finally {
    delete Object.prototype.iss; delete Object.prototype.aud;
  }
});

test('method markers: a grant carrying SD-JWT VC markers is rejected; a mandate without vct is rejected', async () => {
  const { privateKey, jwks } = await keys();
  const grant = createSignedGrantVerifier({ issuers: issuers(jwks) });
  // a JWT that looks like a mandate (vct/_sd) must not pass as a grant
  const mandateish = await signGrant(privateKey, { vct: VCT, _sd: ['x'], allowance: { max_amount: 200, currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1' } });
  await assert.rejects(grant({ method: 'acp_delegated_token', token: mandateish }), (e) => e.detail?.reason === 'not_a_grant');
  // a mandate without vct is rejected
  const m = ap2(jwks);
  const { sdjwt } = await signMandate(privateKey, { plain: { merchant_id: 'merch_A' }, disclosed: { amount: 113, currency: 'USD' }, vct: null });
  await assert.rejects(m({ method: 'ap2_mandate', mandate: sdjwt }), (e) => e.detail?.reason === 'mandate_no_vct');
  // expectedVct mismatch is rejected
  const strict = createAp2MandateVerifier({ issuers: issuers(jwks), verifyCheckoutHash: VCH, expectedVct: 'urn:ap2:OTHER' });
  const { sdjwt: ok } = await signMandate(privateKey, { plain: { merchant_id: 'merch_A' }, disclosed: { amount: 113, currency: 'USD' } });
  await assert.rejects(strict({ method: 'ap2_mandate', mandate: ok }), (e) => e.detail?.reason === 'unexpected_vct');
});

test('signed grant: a present-but-non-object `allowance` fails closed (no top-level fallback)', async () => {
  const { privateKey, jwks } = await keys();
  const verify = createSignedGrantVerifier({ issuers: issuers(jwks) });
  // allowance present as a string, with a tempting top-level max_amount — must NOT fall through to top-level
  const token = await signGrant(privateKey, { allowance: 'not-an-object', max_amount: 999, currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1' });
  await assert.rejects(verify({ method: 'acp_delegated_token', token }), (e) => e.detail?.reason === 'grant_allowance_malformed');
});

test('config: bad issuer / non-https jwksUri / weak alg are rejected at construction', () => {
  assert.throws(() => createSignedGrantVerifier({ issuers: [] }), /at least one/);
  assert.throws(() => createSignedGrantVerifier({ issuers: [{ iss: ISS, aud: AUD, jwksUri: 'http://insecure/jwks' }] }), /https/);
  assert.throws(() => createSignedGrantVerifier({ issuers: [{ iss: ISS, aud: AUD, jwks: { keys: [] }, algs: ['HS256'] }] }), /asymmetric/);
});
