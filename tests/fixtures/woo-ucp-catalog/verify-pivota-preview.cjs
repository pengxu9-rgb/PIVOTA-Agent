'use strict';

const assert = require('node:assert/strict');
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
const buyer = { user_ref: 'fixture_buyer', acp_session_id: 'fixture_checkout' };

async function fetchJson(path, options) {
  const response = await fetch(`${loopback}${path}`, {
    ...options, redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, path);
  return response.json();
}

async function main() {
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
  let now = Date.parse('2026-11-24T00:00:00Z');
  const ttlMs = 60_000;
  const preview = await createCheckoutPreview({ merchantId: 'woo_fixture', adapter, ttlMs, now: () => now });
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
  const originalApproval = { checkoutReference, approvedQuoteReference: prepared.quoteReference };
  const original = await preview.resume(originalApproval, buyer);
  assert.equal(original.quoteReference, prepared.quoteReference);
  assert.deepEqual(original.quote, prepared.quote);
  assert.equal(original.requiresFreshApproval, false);
  assert.equal((await preview.resume({ checkoutReference }, buyer)).requiresFreshApproval, true);

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
  const replay = await preview.resume(originalApproval, buyer);
  assert.equal(replay.quoteReference, changed.quoteReference);
  assert.equal(replay.requiresFreshApproval, true);
  const requoted = await preview.resume({ checkoutReference, approvedQuoteReference: changed.quoteReference }, buyer);
  assert.equal(requoted.requiresFreshApproval, false);
  assert.ok(!JSON.stringify({ changed, replay, requoted }).includes(cartToken));

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
    buyerMismatchRefused: true, sessionMismatchRefused: true, expiredRefused: true,
    merchantTokenRedacted: true, orderId: draft.order_id, paymentResult: draft.payment_result,
    previewStoreApiCalls: routeCalls.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.code || error.name, error.name === 'AssertionError' ? error.message : 'checkout preview verification failed');
  process.exitCode = 1;
});
