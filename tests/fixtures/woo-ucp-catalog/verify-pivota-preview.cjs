'use strict';

const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { createCheckoutPreview } = require('../../../src/services/checkoutPreview');
const { createWooCheckoutPreviewAdapter } = require('../../../src/services/wooCheckoutPreviewAdapter');

const loopback = 'http://127.0.0.1:9463';
const configuredStore = 'https://woo-fixture.example';
const storeApi = '/wp-json/wc/store/v1';
const allowedRequests = new Set([
  `GET ${storeApi}/cart`, `POST ${storeApi}/cart/add-item`, `POST ${storeApi}/cart/update-customer`,
]);
const shippingAddress = {
  first_name: 'Fixture', last_name: 'Buyer', address_1: '100 Example Street',
  city: 'Palo Alto', state: 'CA', postcode: '94301', country: 'US',
};
const issuer = 'https://fixture-wallet.example';
const audience = 'pivota-checkout-preview';
const subject = 'fixture-buyer';

async function fetchJson(path, options) {
  const response = await fetch(`${loopback}${path}`, {
    ...options, redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, path);
  return response.json();
}

async function main() {
  const requireKernel = createRequire(require.resolve('../../../safety-kernel/package.json'));
  const { exportJWK, generateKeyPair, SignJWT } = requireKernel('jose');
  const { deriveUserRefFromClaims } = await import('../../../safety-kernel/src/identity/userTokenVerifier.js');
  const buyer = { user_ref: deriveUserRefFromClaims(issuer, subject), acp_session_id: 'fixture_checkout' };
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture', alg: 'ES256', use: 'sig' };

  async function signApproval(preview, { buyerSubject = subject, amount = preview.quote.totalMinor,
    expiresAt = Date.parse(preview.expiresAt) } = {}) {
    const signature = new SignJWT({
      vct: 'urn:ap2:checkout-mandate', amount, currency: preview.quote.currency, merchant_id: preview.merchantId,
      checkout_hash: createHash('sha256').update(preview.checkoutJwt).digest('base64url'),
    }).setProtectedHeader({ alg: 'ES256', kid: 'fixture' }).setIssuer(issuer).setAudience(audience)
      .setIssuedAt().setExpirationTime(Math.floor(expiresAt / 1000)).setJti(randomUUID());
    if (buyerSubject) signature.setSubject(buyerSubject);
    const jwt = await signature.sign(privateKey);
    return { method: 'ap2_mandate', mandate: `${jwt}~`, checkout_jwt: preview.checkoutJwt };
  }

  const product = await fetchJson('/ucp-fixture.json');
  const config = await fetchJson('/ucp-checkout-fixture.json');
  const routeCalls = [];
  let cartToken;
  const adapter = createWooCheckoutPreviewAdapter({
    merchantOrigin: configuredStore,
    fetchMerchant(url, options) {
      const target = new URL(url);
      const route = `${options.method} ${target.pathname}`;
      assert.equal(target.origin, configuredStore);
      assert.equal(target.search, '');
      assert.ok(allowedRequests.has(route), 'preview transport accepts cart operations only');
      routeCalls.push(route);
      cartToken = new Headers(options.headers).get('cart-token') ?? cartToken;
      return fetch(`${loopback}${target.pathname}`, { ...options, redirect: 'manual' });
    },
  });
  let now = Date.now();
  const ttlMs = 60_000;
  const preview = await createCheckoutPreview({
    merchantId: 'woo_fixture', adapter, ttlMs, now: () => now,
    ap2Approval: { bindingSecret: randomBytes(32).toString('hex'),
      issuers: [{ iss: issuer, aud: audience, jwks: { keys: [jwk] }, algs: ['ES256'] }] },
  });
  const prepared = await preview.prepare({
    sku: 'UCP-FIX-BLUE', variationId: product.blue_id, quantity: 1, currency: 'USD',
    shippingAddress, billingAddress: { ...shippingAddress, email: 'fixture@example.test' },
  }, buyer);
  assert.equal(prepared.merchantId, 'woo_fixture');
  assert.deepEqual(prepared.quote, {
    sku: 'UCP-FIX-BLUE', variationId: product.blue_id, quantity: 1, currency: 'USD',
    subtotalMinor: 1234, shippingMinor: 500, taxMinor: 0, discountMinor: 0, totalMinor: 1734,
  });
  assert.equal(Date.parse(prepared.expiresAt), now + ttlMs);

  const checkoutReference = prepared.checkoutReference;
  const originalApproval = { checkoutReference, authorization: await signApproval(prepared) };
  const original = await preview.resume(originalApproval, buyer);
  assert.equal(original.quoteReference, prepared.quoteReference);
  assert.deepEqual(original.quote, prepared.quote);
  assert.equal(original.requiresFreshApproval, false);
  const unsigned = await preview.resume({ checkoutReference, approvedQuoteReference: prepared.quoteReference }, buyer);
  assert.equal(unsigned.requiresFreshApproval, true);

  assert.ok(cartToken);
  assert.ok(!JSON.stringify({ prepared, original }).includes(cartToken));
  const couponResponse = await fetchJson(`${storeApi}/cart/apply-coupon`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'cart-token': cartToken },
    body: JSON.stringify({ code: config.discountCode }),
  });
  assert.equal(couponResponse.totals.total_price, '1634');

  const changed = await preview.resume(originalApproval, buyer);
  assert.equal(changed.checkoutReference, checkoutReference);
  assert.notEqual(changed.quoteReference, prepared.quoteReference);
  assert.equal(changed.expiresAt, prepared.expiresAt);
  assert.equal(changed.quote.discountMinor, 100);
  assert.equal(changed.quote.totalMinor, 1634);
  assert.equal(changed.requiresFreshApproval, true);
  const replay = await preview.resume({ checkoutReference }, buyer);
  assert.equal(replay.quoteReference, changed.quoteReference);
  assert.equal(replay.requiresFreshApproval, true);

  async function expectInvalid(authorization, reason) {
    await assert.rejects(preview.resume({ checkoutReference, authorization }, buyer),
      (error) => error.code === 'CONFIRMATION_INVALID' && error.detail?.reason === reason);
  }

  await expectInvalid(originalApproval.authorization, 'amount_mismatch');
  await expectInvalid({ ...originalApproval.authorization, checkout_jwt: changed.checkoutJwt }, 'checkout_hash_mismatch');
  const revisedApproval = await signApproval(changed);
  const requoted = await preview.resume({ checkoutReference, authorization: revisedApproval }, buyer);
  assert.equal(requoted.requiresFreshApproval, false);
  await expectInvalid(await signApproval(changed, { buyerSubject: 'other-buyer' }), 'buyer_mismatch');
  await expectInvalid(await signApproval(changed, { buyerSubject: null }), 'approval_buyer_missing');
  await expectInvalid(await signApproval(changed, { expiresAt: now - 10_000 }), 'credential_signature_invalid');
  const [header, payload, signature] = revisedApproval.mandate.split('.');
  const tampered = `${header}.${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
  await expectInvalid({ ...revisedApproval, mandate: tampered }, 'credential_signature_invalid');
  assert.ok(!JSON.stringify({ changed, replay, requoted }).includes(cartToken));

  await fetchJson(`${storeApi}/cart/remove-coupon`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'cart-token': cartToken },
    body: JSON.stringify({ code: config.discountCode }),
  });
  const reverted = await preview.resume({ checkoutReference }, buyer);
  assert.equal(reverted.quote.totalMinor, prepared.quote.totalMinor);
  assert.notEqual(reverted.quoteReference, prepared.quoteReference);
  await expectInvalid(originalApproval.authorization, 'session_mismatch');

  const callsBeforeRefusals = routeCalls.length;
  await assert.rejects(preview.resume(originalApproval, { ...buyer, user_ref: 'another_buyer' }), { code: 'QUOTE_NOT_FOUND' });
  await assert.rejects(preview.resume(originalApproval, { ...buyer, acp_session_id: 'another_checkout' }), { code: 'QUOTE_NOT_FOUND' });
  now += ttlMs;
  await assert.rejects(preview.resume(originalApproval, buyer), { code: 'QUOTE_EXPIRED' });
  assert.equal(routeCalls.length, callsBeforeRefusals);

  const draft = await fetchJson(`${storeApi}/checkout`, { headers: { 'cart-token': cartToken } });
  assert.equal(draft.order_id, 0);
  assert.equal(draft.payment_result, null);
  console.log(JSON.stringify({
    environment: 'Pivota-owned checkout preview with the WooCommerce runner fixture',
    status: 'pass', quote: prepared.quote, requote: changed.quote, expiresInSeconds: ttlMs / 1000,
    sameCheckoutReference: true, previousQuoteRequiresFreshApproval: true,
    signedOriginalAccepted: true, signedRequoteAccepted: true, unsignedQuoteReferenceRejected: true,
    staleAmountRefused: true, checkoutJwtSubstitutionRefused: true, equalAmountOldQuoteRefused: true,
    wrongBuyerApprovalRefused: true, missingBuyerApprovalRefused: true,
    expiredApprovalRefused: true, tamperedApprovalRefused: true,
    buyerMismatchRefused: true, sessionMismatchRefused: true, expiredRefused: true,
    merchantTokenRedacted: true, orderId: draft.order_id, paymentResult: draft.payment_result,
    previewStoreApiCalls: routeCalls.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.code || error.name, error.name === 'AssertionError' ? error.message : 'checkout preview verification failed');
  process.exitCode = 1;
});
