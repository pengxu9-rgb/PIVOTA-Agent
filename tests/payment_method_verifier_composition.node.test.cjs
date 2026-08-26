'use strict';

// buildPaymentMethodVerifiers — the composition src/server.js hands to the issuer registry.
//
// WHY THIS FILE EXISTS. This logic lived as an inline callback in src/server.js, and
// payment_grant_issuer_registry.node.test.cjs injects a FAKE build callback — so the real
// composition never ran in CI. Under that blind spot, `createSignedGrantVerifier({ issuers })`
// was called unconditionally on a list that is already the signed_grant SLICE. Once ap2-only
// rows became live trust (they used to be dropped as inert), a config whose only trusted issuer
// declares methods:['ap2_mandate'] reached that line with [], buildIssuerRegistry hard-threw
// 'verifier requires at least one configured issuer', and the throw landed BEFORE the AP2 flag
// was read — refusing EVERY payment on EVERY method until the row was removed.
//
// The invariant these tests pin: a method with no usable issuer is ABSENT from the map. Never a
// throw, never a null entry. Absence is the kernel's clean per-method refusal; a throw is a
// money-path outage that takes the sibling methods with it.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Lazy single-flight ESM import. A `test()` that assigns a module-level binding does NOT
// sequence before its siblings — node:test starts them all — so the first version of this file
// failed with "not a function" on every case after the loader.
let modPromise;
const load = () => (modPromise ||= import('../safety-kernel/src/protocol/protocolPaymentVerifiers.js'));

const SG = { iss: 'https://antom.example/payments', jwksUri: 'https://antom.example/jwks', aud: 'aud', algs: ['ES256'] };
const AP2 = { iss: 'https://wallet.example/ap2', jwksUri: 'https://wallet.example/jwks', aud: 'aud', algs: ['ES256'] };
// Stand-in for the real binding service: the builder only ever calls this one factory.
const binding = () => ({ createCheckoutHashVerifier: () => () => true });

test('ap2-only trust does NOT throw, and does not silently arm signed_grant methods', async () => {
  const { buildPaymentMethodVerifiers } = await load();
  let methods;
  assert.doesNotThrow(() => {
    methods = buildPaymentMethodVerifiers({
      signedGrantIssuers: [], ap2MandateIssuers: [AP2], ap2Binding: binding(),
    });
  }, 'an ap2-only issuer set must not take the whole verifier build down');
  assert.deepEqual(Object.keys(methods).sort(), ['ap2_mandate']);
  // ABSENT, not present-and-null: paymentAuthorizationVerifier refuses an unwired method
  // cleanly, but a null entry would be called.
  assert.ok(!('acp_delegated_token' in methods));
  assert.ok(!('ucp_handler' in methods));
});

test('no issuers at all is still a build, not a throw', async () => {
  const { buildPaymentMethodVerifiers } = await load();
  let methods;
  assert.doesNotThrow(() => { methods = buildPaymentMethodVerifiers({}); });
  assert.deepEqual(Object.keys(methods), []);
});

test('signed_grant issuers arm both grant-backed methods with ONE shared verifier', async () => {
  const { buildPaymentMethodVerifiers } = await load();
  const methods = buildPaymentMethodVerifiers({ signedGrantIssuers: [SG] });
  assert.deepEqual(Object.keys(methods).sort(), ['acp_delegated_token', 'ucp_handler']);
  assert.equal(methods.acp_delegated_token, methods.ucp_handler);
});

test('AP2 needs BOTH the binding service and an explicitly ap2-trusted issuer', async () => {
  const { buildPaymentMethodVerifiers } = await load();
  // Flag off (no binding) — even with ap2 issuers present.
  assert.ok(!('ap2_mandate' in buildPaymentMethodVerifiers({
    signedGrantIssuers: [SG], ap2MandateIssuers: [AP2], ap2Binding: null,
  })));
  // Binding present but no issuer explicitly trusted for ap2_mandate: signed_grant trust must
  // NEVER be promoted into mandate-minting authority.
  assert.ok(!('ap2_mandate' in buildPaymentMethodVerifiers({
    signedGrantIssuers: [SG], ap2MandateIssuers: [], ap2Binding: binding(),
  })));
  // Both present.
  assert.ok('ap2_mandate' in buildPaymentMethodVerifiers({
    signedGrantIssuers: [SG], ap2MandateIssuers: [AP2], ap2Binding: binding(),
  }));
});

test('a mixed set arms every method', async () => {
  const { buildPaymentMethodVerifiers } = await load();
  const methods = buildPaymentMethodVerifiers({
    signedGrantIssuers: [SG], ap2MandateIssuers: [AP2], ap2Binding: binding(),
  });
  assert.deepEqual(Object.keys(methods).sort(), ['acp_delegated_token', 'ap2_mandate', 'ucp_handler']);
});
