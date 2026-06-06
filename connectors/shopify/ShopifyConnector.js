import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConnectorError, MerchantConnector, notSupported } from '../MerchantConnector.js';

const DEFAULT_API_VERSION = '2025-01';
const SHOP_PAY_HANDLER = Object.freeze({
  id: 'shop_pay',
  type: 'dev.shopify.shop_pay',
  label: 'Shop Pay',
});

export class ShopifyConnector extends MerchantConnector {
  /**
   * @param {object} config
   * @param {object} [config.merchant] Optional merchant registry object.
   * @param {string} [config.merchant_id]
   * @param {string} [config.merchant_of_record]
   * @param {string} config.shopDomain my-shop.myshopify.com or full shop URL.
   * @param {string} [config.adminAccessToken] Shopify Admin API token.
   * @param {string} [config.storefrontAccessToken] Shopify Storefront API token.
   * @param {string} [config.webhookSecret] Shopify webhook signing secret.
   * @param {string} [config.apiVersion]
   * @param {Function} [config.fetchImpl] Injectable fetch for offline tests.
   */
  constructor(config = {}) {
    const merchant = config.merchant || {};
    const nested = merchant.config || {};
    const merchant_id = config.merchant_id || merchant.merchant_id || merchant.id;
    const merchant_of_record =
      config.merchant_of_record ||
      merchant.merchant_of_record ||
      nested.merchant_of_record ||
      merchant.legal_name ||
      merchant.name ||
      merchant_id;

    super({ merchant_id, merchant_of_record, provider: 'shopify' });

    this.shopDomain = normalizeShopDomain(
      config.shopDomain || config.shop_domain || nested.shopDomain || nested.shop_domain || merchant.shopDomain,
    );
    this.adminAccessToken = config.adminAccessToken || config.admin_access_token || nested.adminAccessToken;
    this.storefrontAccessToken =
      config.storefrontAccessToken || config.storefront_access_token || nested.storefrontAccessToken;
    this.webhookSecret = config.webhookSecret || config.webhook_secret || nested.webhookSecret;
    this.apiVersion = config.apiVersion || config.api_version || nested.apiVersion || DEFAULT_API_VERSION;
    this.fetchImpl = config.fetchImpl || merchant.fetchImpl || globalThis.fetch;
    this.paymentHandler = config.paymentHandler || nested.paymentHandler || SHOP_PAY_HANDLER;
  }

  async syncCatalog({ since } = {}) {
    this.#assertShopDomain();
    const sinceQuery = since ? `updated_at:>=${new Date(since).toISOString()}` : undefined;
    const json = await this.#fetchAdminGraphql({
      query: `query PivotaCatalog($first: Int!, $query: String) {
        products(first: $first, query: $query) {
          nodes {
            id
            title
            handle
            vendor
            productType
            updatedAt
            variants(first: 50) {
              nodes {
                id
                title
                sku
                price
                inventoryQuantity
              }
            }
          }
        }
      }`,
      variables: { first: 100, query: sinceQuery },
    });

    const products = json.data?.products?.nodes || [];
    const syncedAt = new Date().toISOString();
    return products.map((product) => normalizeCatalogProduct(product, this, syncedAt));
  }

  async getProduct({ merchant_id, product_id }) {
    this.#assertMerchant(merchant_id);
    this.#assertShopDomain();
    if (!product_id) throw new ConnectorError('BAD_REQUEST', 'product_id is required');

    const id = shopifyRestId(product_id);
    const json = await this.#fetchAdminRest(`/products/${encodeURIComponent(id)}.json`, { method: 'GET' });
    if (!json.product) return null;
    return normalizeRestProduct(json.product, this, new Date().toISOString());
  }

  async previewQuote({ merchant_id, items, shipping_address, discount_codes = [] } = {}) {
    this.#assertMerchant(merchant_id);
    this.#assertShopDomain();
    if (!Array.isArray(items) || items.length === 0) {
      throw new ConnectorError('BAD_REQUEST', 'previewQuote requires at least one item');
    }

    const input = {
      lines: items.map((item) => ({
        merchandiseId: toShopifyVariantGid(item.sku_id || item.variant_id || item.product_id),
        quantity: item.quantity || 1,
      })),
      discountCodes: discount_codes,
    };

    const deliveryAddress = toShopifyDeliveryAddress(shipping_address);
    if (deliveryAddress) {
      input.buyerIdentity = { deliveryAddressPreferences: [deliveryAddress] };
    }

    const json = await this.#fetchStorefrontGraphql({
      query: `mutation PivotaPreviewCart($input: CartInput!) {
        cartCreate(input: $input) {
          cart {
            id
            checkoutUrl
            cost {
              subtotalAmount { amount currencyCode }
              totalTaxAmount { amount currencyCode }
              totalAmount { amount currencyCode }
            }
            deliveryGroups(first: 5) {
              nodes {
                selectedDeliveryOption {
                  title
                  estimatedCost { amount currencyCode }
                }
                deliveryOptions {
                  title
                  estimatedCost { amount currencyCode }
                }
              }
            }
            lines(first: 100) {
              nodes {
                id
                quantity
                merchandise {
                  ... on ProductVariant {
                    id
                    sku
                    title
                    product {
                      id
                      title
                    }
                  }
                }
                cost {
                  subtotalAmount { amount currencyCode }
                  totalAmount { amount currencyCode }
                }
              }
            }
          }
          userErrors {
            field
            message
            code
          }
        }
      }`,
      variables: { input },
    });

    const payload = json.data?.cartCreate;
    if (payload?.userErrors?.length) {
      throw new ConnectorError('LIVE_QUOTE_REJECTED', 'Shopify rejected the live quote request', {
        userErrors: payload.userErrors,
      });
    }

    const cart = payload?.cart;
    if (!cart) throw new ConnectorError('LIVE_QUOTE_INCOMPLETE', 'Shopify did not return a cart quote');

    const cost = cart.cost || {};
    const subtotal = requireMoney(cost.subtotalAmount, 'subtotal');
    const tax = requireMoney(cost.totalTaxAmount, 'tax');
    const shippingOption = selectShippingOption(cart.deliveryGroups);
    const shipping = requireMoney(shippingOption?.estimatedCost, 'shipping');
    const total = requireMoney(cost.totalAmount, 'total');
    const currency =
      cost.totalAmount?.currencyCode ||
      cost.subtotalAmount?.currencyCode ||
      shippingOption?.estimatedCost?.currencyCode;

    if (!currency) throw new ConnectorError('LIVE_QUOTE_INCOMPLETE', 'Shopify quote is missing currency');

    const line_items = normalizeCartLines(cart.lines?.nodes || [], currency);
    const locked_totals = normalizeLockedTotalsForBoundary({ subtotal, tax, shipping, total });
    const quoted_at = new Date().toISOString();
    const quoteRef = {
      provider: 'shopify',
      merchant_id: this.merchant_id,
      merchant_of_record: this.merchant_of_record,
      shop_domain: this.shopDomain,
      cart_id: cart.id,
      checkout_url: cart.checkoutUrl,
      payment_handler_id: this.paymentHandler.id,
      payment_handler_type: this.paymentHandler.type,
      live: true,
      quoted_at,
      currency,
      locked_totals,
      line_items,
    };

    return {
      merchant_id: this.merchant_id,
      locked_totals,
      currency,
      merchant_of_record: this.merchant_of_record,
      line_items,
      quoteRef,
      payment_handlers: [this.paymentHandler],
    };
  }

  async createOrder({ quoteRef, shipping_address } = {}) {
    this.#assertShopDomain();
    if (!quoteRef) throw new ConnectorError('QUOTE_REQUIRED', 'createOrder requires quoteRef from previewQuote');

    const { lineItems, lockedLineSubtotal } = lockedDraftLineItems(quoteRef);
    if (!lineItems.length || lineItems.some((item) => !item.variant_id)) {
      throw new ConnectorError('QUOTE_INVALID', 'quoteRef does not contain Shopify variant line items');
    }

    const draftOrderInput = {
      line_items: lineItems,
      shipping_address: toShopifyRestAddress(shipping_address),
      note: 'Pivota locked quote',
      note_attributes: [
        { name: 'pivota_provider', value: 'shopify' },
        { name: 'pivota_cart_id', value: quoteRef.cart_id || '' },
        { name: 'pivota_payment_handler', value: quoteRef.payment_handler_id || SHOP_PAY_HANDLER.id },
      ],
    };
    const shippingLine = lockedShippingLine(quoteRef.locked_totals);
    if (shippingLine) draftOrderInput.shipping_line = shippingLine;
    const orderDiscount = lockedOrderDiscount(lockedLineSubtotal, quoteRef.locked_totals);
    if (orderDiscount) draftOrderInput.applied_discount = orderDiscount;

    const body = {
      draft_order: draftOrderInput,
    };

    const json = await this.#fetchAdminRest('/draft_orders.json', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const draftOrder = json.draft_order || json.order;
    if (!draftOrder?.id) throw new ConnectorError('ORDER_CREATE_FAILED', 'Shopify did not return an order id');
    assertDraftTotalMatchesLocked(draftOrder, quoteRef);

    const realOrderId = realOrderIdFromDraft(draftOrder);

    return {
      draft_order_id: String(draftOrder.id),
      order_id: realOrderId ? String(realOrderId) : null,
      merchant_order_id: String(draftOrder.name || realOrderId || draftOrder.id),
      merchant_of_record: quoteRef.merchant_of_record || this.merchant_of_record,
      status: draftOrder.status || 'created',
      checkout_url: quoteRef.checkout_url,
      payment_handler_id: quoteRef.payment_handler_id || SHOP_PAY_HANDLER.id,
      currency: quoteRef.currency,
      locked_totals: normalizeLockedTotalsForBoundary(quoteRef.locked_totals),
    };
  }

  async createCheckout() {
    throw notSupported(
      'createCheckout',
      'Shopify connector does not create a separate custom checkout session; use previewQuote checkout_url or createOrder',
    );
  }

  async getOrderStatus({ order_id, draft_order_id } = {}) {
    this.#assertShopDomain();
    const completedOrderId = completedOrderIdOrThrow({ order_id, draft_order_id }, 'get order status');

    const json = await this.#fetchAdminRest(`/orders/${encodeURIComponent(shopifyRestId(completedOrderId))}.json`, {
      method: 'GET',
    });
    const order = json.order;
    if (!order) throw new ConnectorError('ORDER_NOT_FOUND', 'Shopify order was not found', { order_id: completedOrderId });

    const fulfillment = (order.fulfillments || []).find((entry) => entry.tracking_number) || order.fulfillments?.[0];
    return {
      order_id: String(order.id || completedOrderId),
      status: normalizeOrderStatus(order),
      tracking: fulfillment?.tracking_number,
      carrier: fulfillment?.tracking_company,
      eta: order.estimated_delivery_at || order.processed_at || undefined,
      merchant_of_record: this.merchant_of_record,
    };
  }

  async refund({ order_id, draft_order_id, reason, amount, orderContext } = {}) {
    this.#assertShopDomain();
    const completedOrderId = completedOrderIdOrThrow({ order_id, draft_order_id }, 'refund');

    const refundBody = {
      refund: {
        note: reason || 'Refund requested via Pivota',
      },
    };

    // X-P1-5: refund amount/currency must come from the LOCKED order, never blindly from the caller.
    // `orderContext` is the authoritative record the kernel/connector holds for this order:
    //   { amount: <order total>, currency: <order currency>, refunded_amount?: <already refunded> }
    // Rules:
    //   - currency is FORCED to the order currency (a caller currency is ignored).
    //   - a caller `amount` is treated as a partial-refund request and CAPPED at the refundable
    //     balance; a non-finite/negative amount is rejected.
    //   - with no caller amount, refund the full refundable balance.
    const refundTx = resolveRefundTransaction(amount, orderContext);
    if (refundTx) {
      refundBody.refund.transactions = [
        { kind: 'refund', gateway: 'manual', amount: refundTx.amount, currency: refundTx.currency },
      ];
    }
    const normalizedAmount = refundTx; // keep downstream return-shape behavior

    const json = await this.#fetchAdminRest(`/orders/${encodeURIComponent(shopifyRestId(completedOrderId))}/refunds.json`, {
      method: 'POST',
      body: JSON.stringify(refundBody),
    });

    const refund = json.refund;
    if (!refund?.id) throw new ConnectorError('REFUND_FAILED', 'Shopify did not return a refund id');
    const tx = refund.transactions?.[0];

    return {
      refund_id: String(refund.id),
      order_id: String(completedOrderId),
      status: refund.status || tx?.status || 'submitted',
      amount: tx?.amount !== undefined ? formatOptionalMoney(tx.amount) : normalizedAmount?.amount,
      currency: tx?.currency || normalizedAmount?.currency,
      merchant_of_record: this.merchant_of_record,
    };
  }

  async requestReturn() {
    throw notSupported('requestReturn', 'Shopify return requests are not supported by this connector');
  }

  async requestExchange() {
    throw notSupported('requestExchange', 'Shopify exchange requests are not supported by this connector');
  }

  async requestSupport() {
    throw notSupported('requestSupport', 'Shopify support requests are not supported by this connector');
  }

  verifyWebhook(headers, rawBody) {
    if (!this.webhookSecret) return false;
    const provided = getHeader(headers, 'x-shopify-hmac-sha256');
    if (!provided) return false;

    const bodyBuffer = toBuffer(rawBody);
    const expected = createHmac('sha256', this.webhookSecret).update(bodyBuffer).digest('base64');
    const providedBuffer = Buffer.from(String(provided), 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
  }

  parseWebhook(rawBody) {
    const payload = JSON.parse(toBuffer(rawBody).toString('utf8'));
    const fulfillment = (payload.fulfillments || []).find((entry) => entry.tracking_number) || payload.fulfillment;
    const orderId = payload.admin_graphql_api_id || payload.order_id || payload.id;

    return {
      provider: 'shopify',
      merchant_id: this.merchant_id,
      event_type: inferWebhookType(payload),
      event_id: payload.webhook_id || payload.id || payload.admin_graphql_api_id,
      order_id: orderId !== undefined ? String(orderId) : undefined,
      status: normalizeOrderStatus(payload),
      tracking: fulfillment?.tracking_number,
      carrier: fulfillment?.tracking_company,
      payload,
    };
  }

  #assertMerchant(merchant_id) {
    if (merchant_id && this.merchant_id && merchant_id !== this.merchant_id) {
      throw new ConnectorError('MERCHANT_MISMATCH', 'Connector was called with a different merchant_id', {
        expected: this.merchant_id,
        received: merchant_id,
      });
    }
  }

  #assertShopDomain() {
    if (!this.shopDomain) throw new ConnectorError('CONFIG_ERROR', 'Shopify shopDomain is required');
    if (typeof this.fetchImpl !== 'function') throw new ConnectorError('CONFIG_ERROR', 'fetchImpl is required');
  }

  async #fetchStorefrontGraphql(payload) {
    const headers = { 'content-type': 'application/json' };
    if (this.storefrontAccessToken) headers['x-shopify-storefront-access-token'] = this.storefrontAccessToken;
    return this.#fetchJson(`https://${this.shopDomain}/api/${this.apiVersion}/graphql.json`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  }

  async #fetchAdminGraphql(payload) {
    return this.#fetchJson(`https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`, {
      method: 'POST',
      headers: this.#adminHeaders(),
      body: JSON.stringify(payload),
    });
  }

  async #fetchAdminRest(path, init) {
    return this.#fetchJson(`https://${this.shopDomain}/admin/api/${this.apiVersion}${path}`, {
      ...init,
      headers: { ...this.#adminHeaders(), ...(init?.headers || {}) },
    });
  }

  #adminHeaders() {
    const headers = { 'content-type': 'application/json' };
    if (this.adminAccessToken) headers['x-shopify-access-token'] = this.adminAccessToken;
    return headers;
  }

  async #fetchJson(url, init) {
    const response = await this.fetchImpl(url, init);
    const json = await readJson(response);
    if (!response?.ok) {
      throw new ConnectorError('MERCHANT_UNAVAILABLE', 'Shopify request failed', {
        status: response?.status,
        errors: publicShopifyErrors(json),
      });
    }
    if (json?.errors?.length) {
      throw new ConnectorError('MERCHANT_UNAVAILABLE', 'Shopify GraphQL returned errors', {
        errors: publicShopifyErrors(json),
      });
    }
    return json;
  }
}

function normalizeShopDomain(value) {
  if (!value) return undefined;
  return String(value).replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function normalizeCatalogProduct(product, connector, syncedAt) {
  return {
    merchant_id: connector.merchant_id,
    product_id: product.id,
    title: product.title,
    handle: product.handle,
    brand: product.vendor,
    category: product.productType,
    updated_at: product.updatedAt,
    variants: (product.variants?.nodes || []).map((variant) => ({
      sku_id: variant.id,
      sku: variant.sku,
      title: variant.title,
      price: variant.price !== undefined ? Number(variant.price) : undefined,
      inventory_quantity: variant.inventoryQuantity,
    })),
    provenance: {
      provider: 'shopify',
      merchant_id: connector.merchant_id,
      source: 'shopify_admin_graphql',
      synced_at: syncedAt,
    },
  };
}

function normalizeRestProduct(product, connector, syncedAt) {
  return {
    merchant_id: connector.merchant_id,
    product_id: String(product.admin_graphql_api_id || product.id),
    title: product.title,
    handle: product.handle,
    brand: product.vendor,
    category: product.product_type,
    updated_at: product.updated_at,
    variants: (product.variants || []).map((variant) => ({
      sku_id: String(variant.admin_graphql_api_id || variant.id),
      sku: variant.sku,
      title: variant.title,
      price: variant.price !== undefined ? Number(variant.price) : undefined,
      inventory_quantity: variant.inventory_quantity,
    })),
    provenance: {
      provider: 'shopify',
      merchant_id: connector.merchant_id,
      source: 'shopify_admin_rest',
      synced_at: syncedAt,
    },
  };
}

function normalizeCartLines(lines, currency) {
  return lines.map((line) => {
    const merchandise = line.merchandise || {};
    const subtotal = moneyAmount(line.cost?.subtotalAmount);
    const total = moneyAmount(line.cost?.totalAmount);
    return {
      product_id: merchandise.product?.id,
      sku_id: merchandise.id,
      sku: merchandise.sku,
      title: [merchandise.product?.title, merchandise.title].filter(Boolean).join(' - '),
      quantity: line.quantity,
      unit_price: line.quantity ? formatOptionalMoney((total ?? subtotal ?? 0) / line.quantity) : undefined,
      line_subtotal: formatOptionalMoney(subtotal),
      line_total: formatOptionalMoney(total),
      currency: line.cost?.totalAmount?.currencyCode || line.cost?.subtotalAmount?.currencyCode || currency,
    };
  });
}

function lockedDraftLineItems(quoteRef) {
  const lineItems = [];
  let lockedLineSubtotal = 0;

  for (const item of quoteRef.line_items || []) {
    const quantity = normalizeQuantity(item.quantity);
    const lockedLineTotal = lockedLineTotalForItem(item, quantity);
    const baseLineTotal = baseLineTotalForItem(item, quantity, lockedLineTotal);
    if (lockedLineTotal === undefined || baseLineTotal === undefined) {
      throw new ConnectorError('QUOTE_INVALID', 'quoteRef line items must include locked prices');
    }

    const draftLineItem = {
      variant_id: shopifyRestId(item.sku_id || item.variant_id),
      quantity,
      price: formatMoney(baseLineTotal / quantity),
    };

    const lineDiscount = roundMoney(baseLineTotal - lockedLineTotal);
    if (lineDiscount > 0) {
      draftLineItem.applied_discount = lockedDiscount('Pivota locked quote line discount', lineDiscount);
    }

    lineItems.push(draftLineItem);
    lockedLineSubtotal = roundMoney(lockedLineSubtotal + lockedLineTotal);
  }

  return { lineItems, lockedLineSubtotal };
}

function lockedLineTotalForItem(item, quantity) {
  const lineTotal = normalizeMoney(item.line_total);
  if (lineTotal !== undefined) return lineTotal;

  const lineSubtotal = normalizeMoney(item.line_subtotal);
  if (lineSubtotal !== undefined) return lineSubtotal;

  const unitPrice = normalizeMoney(item.unit_price ?? item.price);
  if (unitPrice !== undefined) return roundMoney(unitPrice * quantity);

  return undefined;
}

function baseLineTotalForItem(item, quantity, fallback) {
  const lineSubtotal = normalizeMoney(item.line_subtotal);
  if (lineSubtotal !== undefined) return lineSubtotal;

  const unitPrice = normalizeMoney(item.unit_price ?? item.price);
  if (unitPrice !== undefined) return roundMoney(unitPrice * quantity);

  return fallback;
}

function lockedShippingLine(lockedTotals) {
  const shipping = normalizeMoney(lockedTotals?.shipping);
  if (shipping === undefined) return undefined;
  return {
    title: 'Pivota locked shipping',
    price: formatMoney(shipping),
  };
}

function lockedOrderDiscount(lockedLineSubtotal, lockedTotals) {
  const lockedSubtotal = normalizeMoney(lockedTotals?.subtotal);
  if (lockedSubtotal === undefined) return undefined;

  const discount = roundMoney(lockedLineSubtotal - lockedSubtotal);
  if (discount <= 0) return undefined;
  return lockedDiscount('Pivota locked quote subtotal adjustment', discount);
}

function lockedDiscount(title, amount) {
  const value = formatMoney(amount);
  return {
    title,
    description: title,
    value_type: 'fixed_amount',
    value,
    amount: value,
  };
}

function assertDraftTotalMatchesLocked(draftOrder, quoteRef) {
  const expectedTotal = normalizeMoney(quoteRef.locked_totals?.total);
  if (expectedTotal === undefined) {
    throw new ConnectorError('QUOTE_INVALID', 'quoteRef.locked_totals.total is required for price lock verification');
  }

  const actualTotal = draftOrderTotal(draftOrder);
  if (actualTotal === undefined || moneyCents(actualTotal) !== moneyCents(expectedTotal)) {
    throw new ConnectorError('PRICE_LOCK_VIOLATION', 'Shopify draft total does not match the locked quote total', {
      draft_order_id: draftOrder.id !== undefined ? String(draftOrder.id) : undefined,
      expected_total: expectedTotal,
      actual_total: actualTotal,
    });
  }
}

function draftOrderTotal(draftOrder) {
  return firstMoney(
    draftOrder.total_price,
    draftOrder.totalPrice,
    draftOrder.total,
    draftOrder.total_price_set?.shop_money?.amount,
  );
}

/**
 * X-P1-5: derive the authoritative refund transaction from the LOCKED order, capping any
 * caller-requested partial amount and forcing the order currency. Returns { amount, currency } or
 * null (Shopify will refund the full order if no transactions are given — only acceptable when we
 * have no order context, which the kernel path should never allow for a real order).
 *
 * @param {number|{amount:number,currency?:string}|undefined} requested  caller's partial-refund ask
 * @param {{amount?:number, currency?:string, refunded_amount?:number}|undefined} orderContext
 */
function resolveRefundTransaction(requested, orderContext) {
  // Codex P0-1 fix: FAIL CLOSED. A refund must be bounded by the authoritative locked order. Without
  // a valid orderContext we cannot cap the amount or force the currency, so we refuse rather than let
  // Shopify perform an unbounded full refund. orderContext is required for every refund.
  const orderTotal = normalizeMoney(orderContext?.amount);
  if (!orderContext || orderTotal === undefined || orderTotal < 0) {
    throw new ConnectorError('REFUND_CONTEXT_REQUIRED', 'refund requires the authoritative locked order context (amount, currency)');
  }
  const currency = orderContext.currency; // FORCED to order currency; caller currency ignored
  // Codex P2: a negative/non-finite refunded_amount must not inflate the cap. Clamp to [0, orderTotal].
  const rawRefunded = normalizeMoney(orderContext.refunded_amount) ?? 0;
  const alreadyRefunded = Math.min(orderTotal, Math.max(0, rawRefunded));
  const refundable = roundMoney(Math.max(0, orderTotal - alreadyRefunded));
  if (refundable <= 0) {
    throw new ConnectorError('REFUND_NOT_ALLOWED', 'Order has no refundable balance');
  }

  // Codex P2: distinguish "no ask" (full refundable balance) from "ask provided but unparseable"
  // (a hard error — must NOT silently become a full refund).
  if (requested === undefined || requested === null) {
    return { amount: formatMoney(refundable), currency };
  }
  const ask = extractRequestedAmount(requested);
  if (ask === undefined || !Number.isFinite(ask) || ask <= 0) {
    throw new ConnectorError('BAD_REQUEST', 'Refund amount must be a positive number');
  }
  // Cap a partial request at the refundable balance — never refund more than is owed.
  return { amount: formatMoney(Math.min(ask, refundable)), currency };
}

// Returns a parsed number, or undefined ONLY when the input has no amount field/value at all.
function extractRequestedAmount(requested) {
  if (typeof requested === 'number') return requested;
  if (typeof requested === 'string') return Number(requested);
  if (typeof requested === 'object' && requested !== null && 'amount' in requested) {
    return typeof requested.amount === 'number' ? requested.amount : Number(requested.amount);
  }
  return undefined; // an object/value with no amount at all → caller will treat as malformed
}

function realOrderIdFromDraft(draftOrder) {
  return firstPresent(
    draftOrder.order_id,
    draftOrder.completed_order_id,
    draftOrder.order?.id,
    draftOrder.order?.admin_graphql_api_id,
  );
}

function completedOrderIdOrThrow({ order_id, draft_order_id } = {}, operation) {
  if (hasPresentValue(order_id)) return order_id;
  if (hasPresentValue(draft_order_id)) {
    throw new ConnectorError('ORDER_NOT_COMPLETED', `Shopify draft order must be completed before ${operation}`, {
      draft_order_id: String(draft_order_id),
    });
  }
  throw new ConnectorError('BAD_REQUEST', 'order_id is required');
}

function toShopifyVariantGid(id) {
  if (!id) throw new ConnectorError('BAD_REQUEST', 'Each quote item requires sku_id, variant_id, or product_id');
  const value = String(id);
  if (value.startsWith('gid://shopify/ProductVariant/')) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/ProductVariant/${value}`;
  return value;
}

function shopifyRestId(id) {
  if (!id) return undefined;
  const value = String(id);
  const match = value.match(/\/([^/]+)$/);
  return match ? match[1] : value;
}

function toShopifyDeliveryAddress(address) {
  if (!address) return undefined;
  return pruneUndefined({
    deliveryAddress: {
      address1: address.address_line1 || address.address1,
      address2: address.address_line2 || address.address2,
      city: address.city,
      province: address.province || address.state || address.region,
      country: address.country,
      zip: address.postal_code || address.zip,
      phone: address.phone,
      firstName: address.first_name || splitName(address.recipient_name).firstName,
      lastName: address.last_name || splitName(address.recipient_name).lastName,
    },
  });
}

function toShopifyRestAddress(address) {
  if (!address) return undefined;
  const name = splitName(address.recipient_name);
  return pruneUndefined({
    first_name: address.first_name || name.firstName,
    last_name: address.last_name || name.lastName,
    address1: address.address_line1 || address.address1,
    address2: address.address_line2 || address.address2,
    city: address.city,
    province: address.province || address.state || address.region,
    country: address.country,
    zip: address.postal_code || address.zip,
    phone: address.phone,
  });
}

function splitName(name) {
  if (!name) return {};
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) };
}

function pruneUndefined(input) {
  if (Array.isArray(input)) return input.map(pruneUndefined);
  if (!input || typeof input !== 'object') return input;
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => [key, pruneUndefined(value)]),
  );
}

function selectShippingOption(deliveryGroups) {
  const groups = deliveryGroups?.nodes || [];
  for (const group of groups) {
    if (group.selectedDeliveryOption?.estimatedCost) return group.selectedDeliveryOption;
    const option = (group.deliveryOptions || []).find((entry) => entry.estimatedCost);
    if (option) return option;
  }
  return undefined;
}

function moneyAmount(value) {
  if (!value || value.amount === undefined || value.amount === null) return undefined;
  return normalizeMoney(value.amount);
}

function normalizeMoney(value) {
  if (value === undefined || value === null) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? roundMoney(numeric) : undefined;
}

function requireMoney(value, label) {
  const numeric = moneyAmount(value);
  if (numeric === undefined) {
    throw new ConnectorError('LIVE_QUOTE_INCOMPLETE', `Shopify live quote is missing ${label}`);
  }
  return numeric;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function formatMoney(value) {
  return roundMoney(value).toFixed(2);
}

function formatOptionalMoney(value) {
  const normalized = normalizeMoney(value);
  return normalized === undefined ? undefined : formatMoney(normalized);
}

function normalizeLockedTotalsForBoundary(lockedTotals = {}) {
  return {
    subtotal: formatOptionalMoney(lockedTotals.subtotal),
    tax: formatOptionalMoney(lockedTotals.tax),
    shipping: formatOptionalMoney(lockedTotals.shipping),
    total: formatOptionalMoney(lockedTotals.total),
  };
}

function moneyCents(value) {
  return Math.round(Number(value) * 100);
}

function firstMoney(...values) {
  for (const value of values) {
    const normalized = normalizeMoney(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function firstPresent(...values) {
  return values.find(hasPresentValue);
}

function hasPresentValue(value) {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

function normalizeQuantity(value) {
  const quantity = value === undefined || value === null ? 1 : Number(value);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new ConnectorError('QUOTE_INVALID', 'quoteRef line items must include a positive integer quantity');
  }
  return quantity;
}

export function normalizeAmount(amount) {
  if (amount === undefined || amount === null) return undefined;
  const isObjectAmount = typeof amount === 'object' && !Array.isArray(amount);
  const rawAmount = isObjectAmount ? amount.amount : amount;
  const currency = isObjectAmount ? amount.currency : undefined;
  if (rawAmount === undefined || rawAmount === null) return undefined;
  if (typeof rawAmount !== 'number' && typeof rawAmount !== 'string') return undefined;
  if (typeof rawAmount === 'string' && rawAmount.trim().length === 0) return undefined;

  const numeric = Number(rawAmount);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return { amount: formatMoney(numeric), currency };
}

function normalizeOrderStatus(order) {
  if (!order) return 'unknown';
  if (order.cancelled_at || order.cancel_reason) return 'cancelled';
  if (order.fulfillment_status === 'fulfilled') return 'shipped';
  if (order.fulfillment_status === 'partial') return 'partially_shipped';
  if (order.financial_status === 'refunded') return 'refunded';
  if (order.financial_status === 'paid') return 'processing';
  if (order.status) return String(order.status);
  return 'pending';
}

function inferWebhookType(payload) {
  if (payload.refunds?.length) return 'refund.updated';
  if (payload.fulfillments?.length || payload.fulfillment) return 'order.fulfillment_updated';
  if (payload.financial_status || payload.fulfillment_status) return 'order.updated';
  return 'shopify.webhook';
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function toBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody);
  return Buffer.from(rawBody ?? '', 'utf8');
}

async function readJson(response) {
  if (!response || typeof response.json !== 'function') return {};
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function publicShopifyErrors(json) {
  if (!json) return undefined;
  if (Array.isArray(json.errors)) {
    return json.errors.map((error) => ({
      message: error.message,
      field: error.field,
      code: error.code,
    }));
  }
  if (json.errors && typeof json.errors === 'object') return json.errors;
  return undefined;
}
