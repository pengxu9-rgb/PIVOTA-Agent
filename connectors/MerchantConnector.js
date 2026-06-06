/**
 * MerchantConnector is the abstract contract between Pivota's safety kernel
 * and any merchant-specific commerce rail.
 *
 * Implementations must not log secrets, fabricate prices, or satisfy
 * previewQuote from a cache. Catalog sync can be stale; quote/order/payment
 * paths must use the live merchant rail.
 */

export class ConnectorError extends Error {
  /**
   * @param {string} code Stable machine-readable code, for example NOT_SUPPORTED.
   * @param {string} message Human-readable message safe to surface in logs or adapters.
   * @param {object} [details] Non-sensitive structured details.
   */
  constructor(code, message, details = undefined) {
    super(message || code);
    this.name = 'ConnectorError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function notSupported(operation, message = `${operation} is not supported by this merchant connector`) {
  return new ConnectorError('NOT_SUPPORTED', message, { operation });
}

function notImplemented(method) {
  return new ConnectorError('NOT_IMPLEMENTED', `${method} must be implemented by a merchant connector`, {
    method,
  });
}

export class MerchantConnector {
  /**
   * @param {object} [config]
   * @param {string} [config.merchant_id] Pivota merchant id this connector instance serves.
   * @param {string} [config.merchant_of_record] Legal merchant of record to lock on quotes/orders/refunds.
   * @param {string} [config.provider] Connector provider id, for example "shopify".
   */
  constructor({ merchant_id, merchant_of_record, provider = 'abstract' } = {}) {
    this.merchant_id = merchant_id;
    this.merchant_of_record = merchant_of_record || merchant_id;
    this.provider = provider;
  }

  /**
   * Sync catalog data for cache/search.
   *
   * This method may read from merchant catalog APIs and return data that Pivota
   * indexes for discovery. Results must be provenance-tagged because they are
   * not authoritative for checkout prices.
   *
   * @param {object} input
   * @param {string|Date} [input.since] Optional lower bound for changed products.
   * @returns {Promise<Array<object>>} Normalized product records with provenance.
   */
  async syncCatalog({ since } = {}) {
    void since;
    throw notImplemented('syncCatalog');
  }

  /**
   * Fetch a product directly from the merchant.
   *
   * @param {object} input
   * @param {string} input.merchant_id Pivota merchant id.
   * @param {string} input.product_id Merchant product id or provider GID.
   * @returns {Promise<object|null>} Normalized product detail or null if not found.
   */
  async getProduct({ merchant_id, product_id }) {
    void merchant_id;
    void product_id;
    throw notImplemented('getProduct');
  }

  /**
   * Preview and lock a live quote.
   *
   * INV-5: this is the authoritative price lock. Implementations must call the
   * live merchant rail, never Pivota's catalog cache, and return subtotal, tax,
   * shipping, total, currency, merchant_of_record, and line_items suitable for
   * the SafetyKernel QuoteRegistry snapshot.
   *
   * @param {object} input
   * @param {string} input.merchant_id Pivota merchant id.
   * @param {Array<{product_id?:string, sku_id?:string, variant_id?:string, quantity:number}>} input.items
   * @param {object} input.shipping_address Normalized customer shipping address.
   * @param {string[]} [input.discount_codes] Merchant discount codes to apply.
   * @returns {Promise<{locked_totals:{subtotal:string,tax:string,shipping:string,total:string},currency:string,merchant_of_record:string,line_items:Array<object>,quoteRef:object}>}
   */
  async previewQuote({ merchant_id, items, shipping_address, discount_codes } = {}) {
    void merchant_id;
    void items;
    void shipping_address;
    void discount_codes;
    throw notImplemented('previewQuote');
  }

  /**
   * Create a merchant order from a locked quote reference.
   *
   * The connector must propagate merchant_of_record from the quote/connector and
   * must not recalculate prices from model-provided input.
   *
   * @param {object} input
   * @param {object} input.quoteRef Opaque reference returned by previewQuote.
   * @param {object} input.shipping_address Normalized customer shipping address.
   * @returns {Promise<{order_id:string,merchant_order_id?:string,merchant_of_record:string}>}
   */
  async createOrder({ quoteRef, shipping_address } = {}) {
    void quoteRef;
    void shipping_address;
    throw notImplemented('createOrder');
  }

  /**
   * Create or hand off a hosted checkout session when a connector supports it.
   *
   * Implementations that do not explicitly support hosted checkout must throw
   * ConnectorError with code NOT_SUPPORTED so adapters do not infer availability
   * from a quote checkout URL.
   *
   * @param {object} input
   * @param {object} input.quoteRef Opaque reference returned by previewQuote.
   * @param {string} [input.return_url] Optional return URL for hosted checkout.
   * @returns {Promise<{checkout_id?:string,checkout_url:string,status:string}>}
   */
  async createCheckout({ quoteRef, return_url } = {}) {
    void quoteRef;
    void return_url;
    throw notImplemented('createCheckout');
  }

  /**
   * Read merchant order status.
   *
   * @param {object} input
   * @param {string} input.order_id Merchant order id.
   * @returns {Promise<{order_id:string,status:string,tracking?:string,carrier?:string,eta?:string}>}
   */
  async getOrderStatus({ order_id }) {
    void order_id;
    throw notImplemented('getOrderStatus');
  }

  /**
   * Request a refund.
   *
   * Return/exchange flows are intentionally not part of this required contract.
   * If an implementation does not support a requested after-sales action it must
   * throw ConnectorError with code NOT_SUPPORTED so adapters do not promise it.
   *
   * @param {object} input
   * @param {string} input.order_id Merchant order id.
   * @param {string} input.reason User-visible refund reason.
   * @param {{amount:number,currency?:string}|number} [input.amount] Optional partial amount.
   * @returns {Promise<{refund_id:string,order_id:string,status:string,amount?:string,currency?:string,merchant_of_record:string}>}
   */
  async refund({ order_id, reason, amount } = {}) {
    void order_id;
    void reason;
    void amount;
    throw notImplemented('refund');
  }

  async requestReturn(input = {}) {
    void input;
    throw notImplemented('requestReturn');
  }

  async requestExchange(input = {}) {
    void input;
    throw notImplemented('requestExchange');
  }

  async requestSupport(input = {}) {
    void input;
    throw notImplemented('requestSupport');
  }

  /**
   * Verify a webhook signature over the exact raw request body.
   *
   * @param {Headers|Record<string,string|string[]>} headers Incoming headers.
   * @param {string|Buffer|Uint8Array} rawBody Exact raw request body bytes.
   * @returns {boolean} true when the HMAC/signature is valid.
   */
  verifyWebhook(headers, rawBody) {
    void headers;
    void rawBody;
    throw notImplemented('verifyWebhook');
  }

  /**
   * Parse a merchant webhook body into a normalized event.
   *
   * @param {string|Buffer|Uint8Array} rawBody Exact raw request body bytes.
   * @returns {{provider:string,merchant_id?:string,event_type:string,event_id?:string,order_id?:string,status?:string,payload?:object}}
   */
  parseWebhook(rawBody) {
    void rawBody;
    throw notImplemented('parseWebhook');
  }
}
