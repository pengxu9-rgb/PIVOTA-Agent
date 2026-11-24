'use strict';

const assert = require('node:assert/strict');

const origin = 'http://127.0.0.1:9463';
const store = `${origin}/wp-json/wc/store/v1`;
const catalog = `${origin}/wp-json/wc/ucp/v1`;
const syntheticAddress = {
  first_name: 'Fixture', last_name: 'Buyer', address_1: '100 Example Street',
  city: 'Palo Alto', state: 'CA', postcode: '94301', country: 'US',
};

function request(url, options) {
  assert.equal(new URL(url).origin, origin);
  return fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
}

async function json(url, { method = 'GET', token, cookie, data, status = 200 } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers['cart-token'] = token;
  if (cookie) headers.cookie = cookie;
  if (data) headers['content-type'] = 'application/json';
  const response = await request(url, { method, headers, body: data ? JSON.stringify(data) : undefined });
  assert.equal(response.status, status, `${method} ${new URL(url).pathname} HTTP status`);
  assert.match(response.headers.get('content-type'), /^application\/json\b/i);
  return { status, headers: response.headers, body: await response.json() };
}

function checkLine(cart, variantId) {
  assert.equal(cart.items.length, 1, 'one cart line');
  const [line] = cart.items;
  assert.equal(line.type, 'variation');
  assert.equal(line.id, variantId);
  assert.equal(line.sku, 'UCP-FIX-BLUE');
  assert.equal(line.quantity, 1);
  assert.equal(line.prices.price, '1234');
  assert.equal(line.prices.currency_code, 'USD');
  assert.ok(typeof line.key === 'string' && line.key.length, 'cart line key exists');
  return line;
}

function checkTotals(cart, shippingAmount) {
  const { totals } = cart;
  assert.equal(totals.currency_code, 'USD');
  assert.equal(totals.currency_minor_unit, 2);
  assert.equal(totals.total_items, '1234');
  assert.equal(totals.total_shipping, String(shippingAmount));
  assert.equal(totals.total_tax, '0');
  assert.equal(totals.total_discount, '0');
  assert.equal(totals.total_fees, '0');
  assert.equal(totals.total_price, String(1234 + shippingAmount));
  return { subtotal: 1234, shipping: shippingAmount, tax: 0, discounts: 0, total: 1234 + shippingAmount, currency: 'USD' };
}

async function checkStoreApi(variantId, shippingAmount) {
  const noToken = await json(`${store}/checkout`, { status: 401 });
  assert.equal(noToken.body.code, 'woocommerce_rest_missing_nonce');

  const empty = await json(`${store}/cart`);
  assert.equal(empty.body.items.length, 0);
  assert.equal(empty.headers.get('user-id'), '0');
  const cartToken = empty.headers.get('cart-token');
  assert.ok(cartToken, 'an anonymous cart token was issued');

  const added = await json(`${store}/cart/add-item`, {
    method: 'POST', token: cartToken, data: { id: variantId, quantity: 1 }, status: 201,
  });
  const line = checkLine(added.body, variantId);
  const separate = await json(`${store}/cart`);
  assert.equal(separate.body.items.length, 0, 'independent anonymous session is empty');

  const addressed = await json(`${store}/cart/update-customer`, {
    method: 'POST', token: cartToken,
    data: { shipping_address: syntheticAddress, billing_address: { ...syntheticAddress, email: 'fixture@example.com' } },
  });
  const totalsMinor = checkTotals(addressed.body, shippingAmount);
  assert.ok(checkLine(addressed.body, variantId).key === line.key, 'same line after address');

  const checkout = await json(`${store}/checkout`, { token: cartToken });
  assert.equal(checkout.headers.get('user-id'), '0');
  assert.equal(checkout.body.customer_id, 0);
  assert.equal(checkout.body.status, 'checkout-draft');
  assert.equal(checkout.body.order_id, 0);
  assert.equal(checkout.body.payment_result, null);
  assert.equal(checkout.body.shipping_address.country, 'US');
  const checkoutCart = checkout.body.__experimentalCart;
  assert.ok(checkLine(checkoutCart, variantId).key === line.key, 'same line at checkout');
  assert.equal(checkoutCart.totals.currency_code, totalsMinor.currency);
  assert.equal(checkoutCart.totals.total_price, String(totalsMinor.total));
  const reopened = await json(`${store}/cart`, { token: cartToken });
  assert.ok(checkLine(reopened.body, variantId).key === line.key, 'same line on reopening the cart');
  checkTotals(reopened.body, shippingAmount);

  return {
    status: 'pass', authentication: 'anonymous with Store API Cart-Token', missingToken: { http: noToken.status, code: noToken.body.code },
    cart: { initial: empty.status, addItem: added.status, address: addressed.status, reopened: reopened.status },
    exactVariation: { variantId, sku: line.sku, quantity: 1, sameLineThroughCheckout: true },
    independentSessionEmpty: true, totalsMinor,
    checkout: {
      http: checkout.status, status: checkout.body.status, orderId: checkout.body.order_id, paymentResult: checkout.body.payment_result,
      snapshotTotalMinor: totalsMinor.total, snapshotShippingBreakdownPresent: checkoutCart.totals.total_shipping !== null,
    },
  };
}

async function checkCheckoutLink(variantId, checkoutUrl) {
  const expected = new URL(checkoutUrl);
  assert.equal(expected.origin, origin);
  const link = new URL('/checkout-link/', origin);
  link.searchParams.set('products', `${variantId}:1`);
  const redirect = await request(link.href);
  assert.equal(redirect.status, 302, 'WooCommerce checkout-link redirects');
  assert.ok(redirect.headers.get('location'), 'checkout link has a redirect');
  const follow = new URL(redirect.headers.get('location'), origin);
  assert.ok(follow.origin === origin && follow.pathname === expected.pathname, 'same-origin checkout redirect');
  assert.ok(follow.searchParams.has('session'), 'guest link has an opaque session parameter');

  // Use the returned link without the initiating cookies, as a delegated browser would.
  const page = await request(follow.href);
  assert.equal(page.status, 200, 'checkout page opens in a fresh client');
  assert.match(page.headers.get('content-type'), /^text\/html\b/i);
  const html = await page.text();
  assert.ok(/(?:wp-block-woocommerce-checkout|wc-block-checkout|woocommerce-checkout)/.test(html), 'checkout markup');

  const cookie = page.headers.getSetCookie().find((value) => /^wp_woocommerce_session_[^=]+=/.test(value))?.split(';')[0];
  assert.ok(cookie, 'fresh client received its WooCommerce session cookie');
  const cart = await json(`${store}/cart`, { cookie });
  checkLine(cart.body, variantId);

  return {
    status: 'pass', initialHttp: redirect.status, sameOriginCheckoutPath: follow.pathname, guestLinkSessionPresent: true,
    checkoutPageHttp: page.status, freshBrowserCartHttp: cart.status,
    importedVariation: { variantId, sku: 'UCP-FIX-BLUE', quantity: 1 },
  };
}

async function main() {
  const { body: product } = await json(`${origin}/ucp-fixture.json`);
  const { body: config } = await json(`${origin}/ucp-checkout-fixture.json`);
  assert.equal(product.woocommerce, '11.3.1');
  assert.equal(product.wordpress, '7.1.5');
  assert.equal(config.guestEnabled, true);
  assert.equal(config.registrationRequired, false);
  const variantId = Number(product.blue_id);
  assert.ok(Number.isSafeInteger(variantId) && variantId > 0);

  const namespace = await json(catalog);
  const ucpCheckoutAdvertised = Object.keys(namespace.body.routes ?? {}).some((route) => /checkout/.test(route));
  assert.equal(ucpCheckoutAdvertised, false);

  console.log(JSON.stringify({
    environment: 'disposable loopback WooCommerce fixture',
    versions: { wordpress: product.wordpress, woocommerce: product.woocommerce, php: product.php },
    guestPolicy: { enabled: config.guestEnabled, registrationRequired: config.registrationRequired },
    ucpCheckoutAdvertised,
    storeApi: await checkStoreApi(variantId, config.shippingAmount),
    shareableLink: await checkCheckoutLink(variantId, config.checkoutUrl),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
