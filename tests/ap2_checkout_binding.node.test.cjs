'use strict';

// AP2 checkout binding — the TCB function the mandate verifier has demanded since it shipped.
//
// The load-bearing tests here are the END-TO-END ones: a real ES256 SD-JWT Checkout Mandate,
// built with jose against a pinned local JWKS, run through the REAL createAp2MandateVerifier
// with the REAL verifyCheckoutHash — including the attack this binding exists to stop: a valid
// mandate replayed against a DIFFERENT checkout session.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');

const SECRET = 's'.repeat(40);
const b64uJson = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sha256b64u = (s) => createHash('sha256').update(s, 'utf8').digest('base64url');
const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

async function loadService(opts = {}) {
  const { Ap2CheckoutBindingService } = await import('../safety-kernel/src/protocol/ap2CheckoutBinding.js');
  return new Ap2CheckoutBindingService({ secret: SECRET, ...opts });
}

async function expectReason(promise, reason) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, 'CONFIRMATION_INVALID', `code was ${err.code}: ${err.message}`);
    assert.equal(err.detail?.reason, reason);
    return true;
  });
}

// --- service units ---------------------------------------------------------------------------

test('a weak secret refuses to construct', async () => {
  const { Ap2CheckoutBindingService } = await import('../safety-kernel/src/protocol/ap2CheckoutBinding.js');
  assert.throws(() => new Ap2CheckoutBindingService({ secret: 'short' }), /32/);
});

test('mint -> verify roundtrip, base64url and hex digests both accepted', async () => {
  const svc = await loadService();
  const jwt = svc.mintCheckoutJwt({ checkout_session_id: 'cs_123' });
  const verify = svc.createCheckoutHashVerifier();
  assert.deepEqual(await verify(sha256b64u(jwt), jwt), { checkout_session_id: 'cs_123' });
  assert.deepEqual(await verify(sha256hex(jwt), jwt), { checkout_session_id: 'cs_123' });
});

test('the quote expiry CAPS the JWT lifetime — a binding never outlives its quote', async () => {
  const svc = await loadService({ now: () => 1_000_000 });
  const jwt = svc.mintCheckoutJwt({
    checkout_session_id: 'cs_1',
    expires_at: new Date(1_000_000 + 120_000).toISOString(), // 2 min out; ttl default is 15 min
  });
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  assert.equal(payload.exp, Math.floor((1_000_000 + 120_000) / 1000));
});

test('one tampered payload byte is a bad signature, before any claim is read', async () => {
  const svc = await loadService();
  const jwt = svc.mintCheckoutJwt({ checkout_session_id: 'cs_1' });
  const [h, p, sig] = jwt.split('.');
  const forged = `${h}.${p.slice(0, -2)}AA.${sig}`;
  await expectReason(svc.createCheckoutHashVerifier()(sha256b64u(forged), forged), 'checkout_jwt_bad_signature');
});

// The sibling test above tampers a byte, so the signature would fail under ANY ordering — it
// cannot, on its own, prove the HMAC check runs BEFORE the claims. This one can: it hands the
// verifier a payload that every claim check would independently reject (expired AND carrying no
// checkout_session_id), signed with the WRONG secret. A verifier that parsed claims first would
// deny 'checkout_jwt_expired' or 'checkout_jwt_no_session'. Denying 'checkout_jwt_bad_signature'
// is only possible if the signature is verified before a single claim is read — pinning the
// deny-before-parse ordering at lines (a)->JSON.parse in ap2CheckoutBinding.js.
test('a claim-invalid payload with a wrong signature denies on the SIGNATURE, not the claim', async () => {
  const svc = await loadService();
  const signingInput = `${b64uJson({ alg: 'HS256', typ: 'pivota-ap2-checkout+jwt' })}.${b64uJson({
    exp: Math.floor(Date.now() / 1000) - 10_000, // long expired, well past tolerance; and no session id
  })}`;
  // a real forgery: signed with a DIFFERENT secret, not merely a mangled segment
  const wrongSig = createHmac('sha256', 'w'.repeat(40)).update(signingInput).digest('base64url');
  const impostor = `${signingInput}.${wrongSig}`;
  await expectReason(svc.createCheckoutHashVerifier()(sha256b64u(impostor), impostor), 'checkout_jwt_bad_signature');
});

test('a token signed with the RIGHT secret but the WRONG typ is refused — no cross-instrument replay', async () => {
  const svc = await loadService();
  const signingInput = `${b64uJson({ alg: 'HS256', typ: 'confirmation+jwt' })}.${b64uJson({
    checkout_session_id: 'cs_1', exp: Math.floor(Date.now() / 1000) + 600,
  })}`;
  const sig = createHmac('sha256', SECRET).update(signingInput).digest('base64url');
  const impostor = `${signingInput}.${sig}`;
  await expectReason(svc.createCheckoutHashVerifier()(sha256b64u(impostor), impostor), 'checkout_jwt_wrong_typ');
});

test('expiry is enforced with tolerance', async () => {
  let clock = 1_000_000;
  const svc = await loadService({ now: () => clock, ttlMs: 60_000 });
  const jwt = svc.mintCheckoutJwt({ checkout_session_id: 'cs_1' });
  const verify = svc.createCheckoutHashVerifier();
  clock += 60_000 + 30_000; // past exp, inside the 60s tolerance
  await verify(sha256b64u(jwt), jwt);
  clock += 60_000; // past tolerance
  await expectReason(verify(sha256b64u(jwt), jwt), 'checkout_jwt_expired');
});

test('a hash of a DIFFERENT string, or an undecodable hash, is a mismatch', async () => {
  const svc = await loadService();
  const jwt = svc.mintCheckoutJwt({ checkout_session_id: 'cs_1' });
  const other = svc.mintCheckoutJwt({ checkout_session_id: 'cs_2' });
  const verify = svc.createCheckoutHashVerifier();
  await expectReason(verify(sha256b64u(other), jwt), 'checkout_hash_mismatch');
  await expectReason(verify('zz-not-a-digest', jwt), 'checkout_hash_mismatch');
});

test('a valid-but-sessionless JWT resolves no session', async () => {
  const svc = await loadService();
  const signingInput = `${b64uJson({ alg: 'HS256', typ: 'pivota-ap2-checkout+jwt' })}.${b64uJson({
    exp: Math.floor(Date.now() / 1000) + 600,
  })}`;
  const sig = createHmac('sha256', SECRET).update(signingInput).digest('base64url');
  const jwt = `${signingInput}.${sig}`;
  await expectReason(svc.createCheckoutHashVerifier()(sha256b64u(jwt), jwt), 'checkout_jwt_no_session');
});

// --- END TO END with the real mandate verifier ----------------------------------------------

async function buildMandateHarness() {
  const jose = require('jose');
  const svc = await loadService();
  const { createAp2MandateVerifier } = await import('../safety-kernel/src/protocol/protocolPaymentVerifiers.js');
  const { privateKey, publicKey } = await jose.generateKeyPair('ES256');
  const pubJwk = await jose.exportJWK(publicKey);

  async function mintMandate({ checkoutHash, vct = 'PaymentMandate', disclose = true }) {
    // checkout_hash rides as a DISCLOSURE so the digest-integrity path is exercised too.
    const disclosure = Buffer.from(JSON.stringify(['salt1', 'checkout_hash', checkoutHash])).toString('base64url');
    const digest = createHash('sha256').update(disclosure).digest('base64url');
    const issuerJwt = await new jose.SignJWT({
      vct,
      amount: 2317,
      currency: 'USD',
      merchant_id: 'merch_1',
      ...(disclose ? { _sd: [digest], _sd_alg: 'sha-256' } : { checkout_hash: checkoutHash }),
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('https://antom.example/payments')
      .setAudience('pivota-agent-mcp')
      .setSubject('user_ap2_1')
      .setExpirationTime('10m')
      .setJti('mandate_1')
      .sign(privateKey);
    return disclose ? `${issuerJwt}~${disclosure}~` : `${issuerJwt}~`;
  }

  const verifier = createAp2MandateVerifier({
    issuers: [{ iss: 'https://antom.example/payments', aud: 'pivota-agent-mcp', algs: ['ES256'], jwks: { keys: [pubJwk] } }],
    verifyCheckoutHash: svc.createCheckoutHashVerifier(),
    expectedVct: 'PaymentMandate',
  });
  return { svc, mintMandate, verifier };
}

test('E2E: a real SD-JWT mandate bound to a real Checkout JWT verifies, with the session from OUR jwt', async () => {
  const { svc, mintMandate, verifier } = await buildMandateHarness();
  const checkoutJwt = svc.mintCheckoutJwt({ checkout_session_id: 'cs_e2e_1' });
  const mandate = await mintMandate({ checkoutHash: sha256b64u(checkoutJwt) });
  const attestation = await verifier({ mandate, checkout_jwt: checkoutJwt });
  assert.equal(attestation.checkout_session_id, 'cs_e2e_1'); // from OUR verified JWT
  assert.equal(attestation.amount, 2317);
  assert.equal(attestation.currency, 'USD');
  assert.equal(attestation.merchant_id, 'merch_1');
  // user_ref is the kernel's OPAQUE derivation over (iss, sub) — assert it exists and is
  // stable across verifications, not its internal format.
  assert.match(attestation.user_ref, /^usr_/);
  const again = await verifier({ mandate, checkout_jwt: checkoutJwt });
  assert.equal(again.user_ref, attestation.user_ref);
});

test('E2E: the attack this exists for — a valid mandate replayed against a DIFFERENT session is refused', async () => {
  const { svc, mintMandate, verifier } = await buildMandateHarness();
  const authorizedJwt = svc.mintCheckoutJwt({ checkout_session_id: 'cs_paid_for' });
  const victimJwt = svc.mintCheckoutJwt({ checkout_session_id: 'cs_victim' });
  const mandate = await mintMandate({ checkoutHash: sha256b64u(authorizedJwt) });
  // present the victim session's jwt with a mandate that committed to the other one
  await expectReason(verifier({ mandate, checkout_jwt: victimJwt }), 'checkout_hash_mismatch');
});

test('E2E: a forged checkout_jwt (right shape, wrong secret) is refused before the hash is even checked', async () => {
  const { mintMandate, verifier } = await buildMandateHarness();
  const { Ap2CheckoutBindingService } = await import('../safety-kernel/src/protocol/ap2CheckoutBinding.js');
  const attacker = new Ap2CheckoutBindingService({ secret: 'x'.repeat(40) });
  const forgedJwt = attacker.mintCheckoutJwt({ checkout_session_id: 'cs_victim' });
  const mandate = await mintMandate({ checkoutHash: sha256b64u(forgedJwt) });
  await expectReason(verifier({ mandate, checkout_jwt: forgedJwt }), 'checkout_jwt_bad_signature');
});

test('E2E: plain-claim checkout_hash (no disclosure) also verifies — both SD-JWT shapes covered', async () => {
  const { svc, mintMandate, verifier } = await buildMandateHarness();
  const checkoutJwt = svc.mintCheckoutJwt({ checkout_session_id: 'cs_plain' });
  const mandate = await mintMandate({ checkoutHash: sha256b64u(checkoutJwt), disclose: false });
  const attestation = await verifier({ mandate, checkout_jwt: checkoutJwt });
  assert.equal(attestation.checkout_session_id, 'cs_plain');
});

// --- executor attach -------------------------------------------------------------------------

test('the executor attaches ap2_checkout_jwt to created sessions, and its absence is non-fatal', async () => {
  const { createCanonicalExecutor } = await import('../safety-kernel/src/protocol/canonicalExecutor.js');
  const quote = {
    quote_id: 'cs_exec_1', currency: 'USD', merchant_of_record: 'merch_1',
    locked_totals: { total: 2317 }, line_items: [], expires_at: new Date(Date.now() + 600_000).toISOString(),
  };
  // resolveForOrder too: get_checkout_session is the SECOND mint site, and a wallet that re-reads
  // its session must be handed the same binding it was issued.
  const kernel = { previewQuote: async () => quote, quotes: { resolveForOrder: async () => quote } };
  // The ACP door: protocol:'acp' is what marks it, and it is the ONLY door that forwards
  // acp_session_id as authorization_checkout_session_id.
  const ctx = { user_ref: 'u1', acp_session_id: 'acp_1', protocol: 'acp' };

  const withMint = createCanonicalExecutor({
    kernel,
    mintAp2CheckoutJwt: ({ checkout_session_id }) => `jwt-for-${checkout_session_id}`,
  });
  // BINDS TO THE ACP SESSION ID on the ACP door, because that is the id the ACP adapter forwards
  // as authorization_checkout_session_id — which is what complete_checkout_session verifies
  // against. This assertion previously expected 'jwt-for-cs_exec_1' (the KERNEL quote id) while
  // handing in an ACP ctx, so it encoded the defect: an ACP wallet never learns the quote id, and
  // every ACP AP2 completion failed session_mismatch.
  const session = await withMint.execute('create_checkout_session', { quote: {}, idempotency_key: 'idem_1' }, ctx);
  assert.equal(session.ap2_checkout_jwt, 'jwt-for-acp_1');

  // ...but the NATIVE door binds to the kernel quote id, and this is the case that makes the rule
  // subtle enough to be worth pinning. ctx.acp_session_id is present on EVERY door (the executor
  // requires it for any op with requiresUserRef), yet only the ACP adapter forwards it as
  // authorization_checkout_session_id. Keying the mint on the field's presence rather than on
  // ctx.protocol would silently break the door that already works.
  const nativeCtx = { user_ref: 'u1', acp_session_id: 'mcp_conn_1' };
  const nativeSession = await withMint.execute(
    'create_checkout_session', { quote: {}, idempotency_key: 'idem_1b' }, nativeCtx,
  );
  assert.equal(nativeSession.ap2_checkout_jwt, 'jwt-for-cs_exec_1');

  // get_checkout_session must agree with create on the same door, or a wallet that re-reads the
  // session hashes a different binding than the one it was issued.
  const reread = await withMint.execute('get_checkout_session', { session_id: 'cs_exec_1' }, ctx);
  assert.equal(reread.ap2_checkout_jwt, 'jwt-for-acp_1');

  const mintless = createCanonicalExecutor({ kernel });
  const bare = await mintless.execute('create_checkout_session', { quote: {}, idempotency_key: 'idem_2' }, ctx);
  assert.equal('ap2_checkout_jwt' in bare, false);

  const throwing = createCanonicalExecutor({
    kernel,
    mintAp2CheckoutJwt: () => { throw new Error('mint blew up'); },
  });
  const survived = await throwing.execute('create_checkout_session', { quote: {}, idempotency_key: 'idem_3' }, ctx);
  assert.equal(survived.session_id, 'cs_exec_1'); // session unharmed
  assert.equal('ap2_checkout_jwt' in survived, false); // AP2 fails closed, nothing else does
});

// The binding JWT has to actually REACH the wallet. It is the one payment-adjacent string that
// must survive verbatim, and it very nearly did not: LOOSE_SECRET_RE in the shared result
// sanitizer matches any compact JWS, so a real minted token (header `eyJhbGciOiJIUzI1NiIs...`)
// was rewritten to [REDACTED_SECRET] on the way out. Every AP2 completion then failed
// checkout_hash_mismatch on a token the wallet could never have seen. The pre-existing tests
// missed it because they mint the literal 'jwt-for-cs_exec_1', which is not JWS-shaped and never
// passes through a door.
test('the minted binding JWT survives the result sanitizer on BOTH doors', async () => {
  const { sanitizeResult } = await import('../safety-kernel/src/protocol/resultSanitizer.js');
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const realJwt = `${b64u({ alg: 'HS256', typ: 'pivota-ap2-checkout+jwt' })}.${b64u({ checkout_session_id: 'acp_1', exp: 1 })}.c2lnbmF0dXJl`;

  // handoffAllowed:false is the ACP session-body path; true is the checkout/order path.
  for (const handoffAllowed of [false, true]) {
    const out = sanitizeResult({ ap2_checkout_jwt: realJwt }, { handoffAllowed });
    assert.equal(out.ap2_checkout_jwt, realJwt, `redacted with handoffAllowed=${handoffAllowed}`);
  }

  // The preserve is gated on key AND shape, so the key cannot be used to smuggle a credential.
  assert.equal(
    sanitizeResult({ ap2_checkout_jwt: 'sk_live_ABCDEFGHIJKLMNOP' }, {}).ap2_checkout_jwt,
    '[REDACTED_SECRET]',
  );
  // And a JWS under any OTHER key is still scrubbed — the exemption is this key only.
  assert.equal(sanitizeResult({ some_other_token_ish: realJwt }, {}).some_other_token_ish, '[REDACTED_SECRET]');
});

// FIX D + FIX B, through the REAL ACP door rather than a simulation of it.
//
// toAcpSession builds an ALLOWLISTED response — fields not named there are dropped — and
// ap2_checkout_jwt was not among them, so the ACP door returned no binding material at all even
// with the flag on. The response then passes through sanitizeResult({handoffAllowed:false}),
// which is the stricter of the two modes. Both had to change for this door to work, and neither
// was covered: the executor tests stop at the executor, and no ACP test asked for the field.
test('the ACP door returns the binding JWT: allowlisted through AND unscrubbed', async () => {
  const { createAcpRestAdapter } = await import('../safety-kernel/src/protocol/acpRestAdapter.js');
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  // A REAL compact JWS. The literal 'jwt-for-…' placeholder the executor tests use is not
  // JWS-shaped, so it would sail past the sanitizer and prove nothing about this path.
  const realJwt = `${b64u({ alg: 'HS256', typ: 'pivota-ap2-checkout+jwt' })}.${b64u({ checkout_session_id: 'acp_sess_1', exp: 1 })}.c2lnbmF0dXJl`;

  const adapter = createAcpRestAdapter({
    executor: {
      execute: async (op) => {
        assert.equal(op, 'get_checkout_session');
        return {
          session_id: 'cs_kernel_1', currency: 'USD', merchant_of_record: 'merch_1',
          line_items: [], totals: { total: 2317 }, expires_at: new Date(Date.now() + 600_000).toISOString(),
          ap2_checkout_jwt: realJwt,
        };
      },
    },
    sessionStore: {
      get: async () => ({ quote_id: 'cs_kernel_1', order_id: null, user_ref: 'u1' }),
      set: async () => {}, putIfAbsent: async () => true,
    },
    resolveUserRef: () => 'u1',
    authenticate: async () => {},
    signingSecret: 'test_secret',
  });

  const res = await adapter.getCheckoutSession({ headers: {}, body: {}, params: { checkout_session_id: 'acp_sess_1' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ap2_checkout_jwt, realJwt,
    'the ACP session body must carry the binding JWT verbatim — allowlisted AND unredacted');
});
