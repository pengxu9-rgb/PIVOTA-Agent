'use strict';

const { createPublicNetworkFetch } = require('./ucpBuyerAgentClient');
const { currencyExponent } = require('./merchantVariantSource');

const CART_PATH = '/wp-json/wc/store/v1/cart';
const ADDRESS_FIELDS = [
  'first_name', 'last_name', 'company', 'address_1', 'address_2', 'city', 'state', 'postcode', 'country', 'phone',
];

function fail(code, stage, http) {
  throw Object.assign(new Error(code), { code, stage, http });
}

function pinnedOrigin(value) {
  if (typeof value === 'string' && /^https:\/\/[^/?#@\s\\]+\/?$/.test(value)) {
    try {
      return new URL(value).origin;
    } catch {
      // The configured origin is invalid.
    }
  }
  return fail('woo_preview_expected_https_origin');
}

function readItem({ sku, variationId, quantity, currency } = {}) {
  const id = typeof variationId === 'number' || typeof variationId === 'string' ? String(variationId) : '';
  const digits = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currencyExponent(currency) : null;
  if (typeof sku !== 'string' || !sku.trim() || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) ||
      !Number.isSafeInteger(quantity) || quantity < 1 || digits === null) {
    fail('woo_preview_invalid_item');
  }
  return { sku, variationId: id, quantity, currency, digits };
}

function readAddress(value, billing = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.country !== 'string' || !/^[A-Z]{2}$/.test(value.country)) {
    fail('woo_preview_invalid_address');
  }
  const fields = billing ? [...ADDRESS_FIELDS, 'email'] : ADDRESS_FIELDS;
  const entries = fields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]);
  if (entries.some(([, field]) => typeof field !== 'string')) fail('woo_preview_invalid_address');
  return Object.fromEntries(entries);
}

function isCartToken(value) {
  return typeof value === 'string' && /^[\x21-\x2b\x2d-\x7e]{1,8192}$/.test(value);
}

function exactLine(cart, item, stage, lineKey) {
  const line = Array.isArray(cart?.items) && cart.items.length === 1 ? cart.items[0] : null;
  if (line?.type !== 'variation' || String(line.id) !== item.variationId || line.sku !== item.sku ||
      line.quantity !== item.quantity || typeof line.key !== 'string' || !line.key ||
      (lineKey !== undefined && line.key !== lineKey)) {
    fail('woo_preview_exact_line_required', stage);
  }
  if (line.prices?.currency_code !== item.currency || line.prices.currency_minor_unit !== item.digits) {
    fail('woo_preview_currency_mismatch', stage);
  }
  return line;
}

function minorUnits(value, stage) {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    fail('woo_preview_invalid_money', stage);
  }
  return Number(value);
}

function readQuote(cart, item, stage, lineKey) {
  const line = exactLine(cart, item, stage, lineKey);
  const { totals, shipping_rates: packages } = cart;
  if (totals?.currency_code !== item.currency || totals.currency_minor_unit !== item.digits) {
    fail('woo_preview_currency_mismatch', stage);
  }
  if (cart.needs_shipping !== true || cart.has_calculated_shipping !== true ||
      !Array.isArray(packages) || packages.length === 0) {
    fail('woo_preview_shipping_unavailable', stage);
  }

  let selectedShipping = 0n;
  for (const delivery of packages) {
    const selected = Array.isArray(delivery?.shipping_rates)
      ? delivery.shipping_rates.filter((rate) => rate?.selected === true)
      : [];
    if (selected.length !== 1) fail('woo_preview_shipping_unavailable', stage);
    const [rate] = selected;
    if (rate.currency_code !== item.currency || rate.currency_minor_unit !== item.digits) {
      fail('woo_preview_currency_mismatch', stage);
    }
    selectedShipping += BigInt(minorUnits(rate.price, stage));
  }

  const subtotalMinor = minorUnits(totals.total_items, stage);
  const shippingMinor = minorUnits(totals.total_shipping, stage);
  const taxMinor = minorUnits(totals.total_tax, stage);
  const discountMinor = minorUnits(totals.total_discount, stage);
  const totalMinor = minorUnits(totals.total_price, stage);
  if (minorUnits(totals.total_fees, stage) !== 0 || minorUnits(totals.total_fees_tax, stage) !== 0 ||
      subtotalMinor !== minorUnits(line.totals?.line_subtotal, stage) || BigInt(shippingMinor) !== selectedShipping ||
      BigInt(subtotalMinor) + selectedShipping + BigInt(taxMinor) - BigInt(discountMinor) !== BigInt(totalMinor)) {
    fail('woo_preview_inconsistent_totals', stage);
  }
  return {
    sku: item.sku, variationId: item.variationId, quantity: item.quantity, currency: item.currency,
    subtotalMinor, shippingMinor, taxMinor, discountMinor, totalMinor,
  };
}

/** Prepare and reread an anonymous WooCommerce quote on one configured merchant origin. */
function createWooCheckoutPreviewAdapter({ merchantOrigin, fetchMerchant = createPublicNetworkFetch(), timeoutMs = 10000 } = {}) {
  const origin = pinnedOrigin(merchantOrigin);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) {
    fail('woo_preview_invalid_timeout');
  }

  async function requestCart(stage, suffix, { token, data, status = 200 } = {}) {
    const url = `${origin}${CART_PATH}${suffix}`;
    const headers = { accept: 'application/json', 'cache-control': 'no-store' };
    if (token) headers['cart-token'] = token;
    if (data) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetchMerchant(url, {
        method: data ? 'POST' : 'GET', headers, body: data ? JSON.stringify(data) : undefined,
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
      return fail(timedOut ? 'woo_preview_timeout' : 'woo_preview_network_failure', stage);
    }
    const http = response.status;
    if (response.redirected || (http >= 300 && http < 400)) {
      fail('woo_preview_redirect', stage, http);
    }
    if (http === 401 || http === 403) fail('woo_preview_access_denied', stage, http);
    if (http === 429) fail('woo_preview_rate_limited', stage, http);
    if (http !== status) fail('woo_preview_unexpected_status', stage, http);
    if (response.headers.get('user-id') !== '0') fail('woo_preview_anonymous_cart_required', stage, http);
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') fail('woo_preview_unexpected_content_type', stage, http);
    try {
      return { cart: await response.json(), cartToken: response.headers.get('cart-token') };
    } catch {
      return fail('woo_preview_invalid_json', stage, http);
    }
  }

  async function prepare(input) {
    const item = readItem(input);
    const shippingAddress = readAddress(input.shippingAddress);
    const billingAddress = readAddress(input.billingAddress, true);
    const empty = await requestCart('init', '');
    const token = empty.cartToken;
    if (!isCartToken(token) || !Array.isArray(empty.cart?.items) || empty.cart.items.length !== 0) {
      fail('woo_preview_new_cart_required', 'init');
    }
    const added = await requestCart('add_item', '/add-item', {
      token, data: { id: Number(item.variationId), quantity: item.quantity }, status: 201,
    });
    const line = exactLine(added.cart, item, 'add_item');
    const addressed = await requestCart('update_customer', '/update-customer', {
      token, data: { shipping_address: shippingAddress, billing_address: billingAddress },
    });
    if (addressed.cart?.shipping_address?.country !== shippingAddress.country ||
        addressed.cart?.billing_address?.country !== billingAddress.country) {
      fail('woo_preview_destination_mismatch', 'update_customer');
    }
    return {
      session: { origin, cartToken: token, lineKey: line.key },
      quote: readQuote(addressed.cart, item, 'update_customer', line.key),
    };
  }

  async function resume({ session, item: input } = {}) {
    const item = readItem(input);
    if (session?.origin !== origin || !isCartToken(session.cartToken) ||
        typeof session.lineKey !== 'string' || !session.lineKey) {
      fail('woo_preview_invalid_session', 'resume');
    }
    const { cart } = await requestCart('resume', '', { token: session.cartToken });
    return { quote: readQuote(cart, item, 'resume', session.lineKey) };
  }

  return { prepare, resume };
}

module.exports = { createWooCheckoutPreviewAdapter };
