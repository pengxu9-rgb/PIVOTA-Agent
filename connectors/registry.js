import { ConnectorError, MerchantConnector, notSupported } from './MerchantConnector.js';
import { ShopifyConnector } from './shopify/ShopifyConnector.js';

const factories = new Map([
  ['shopify', (merchant, options) => new ShopifyConnector({ merchant, ...merchant.config, ...options })],
  ['custom', (merchant, options) => new CustomRestConnector({ merchant, ...merchant.config, ...options })],
]);

export function registerConnectorFactory(kind, factory) {
  if (!kind || typeof factory !== 'function') {
    throw new ConnectorError('BAD_REQUEST', 'registerConnectorFactory requires kind and factory');
  }
  factories.set(String(kind).toLowerCase(), factory);
}

export function getConnector(merchant, options = {}) {
  if (!merchant) throw new ConnectorError('BAD_REQUEST', 'merchant is required');
  const kind = String(
    merchant.connector || merchant.connector_type || merchant.provider || merchant.type || merchant.platform || 'custom',
  ).toLowerCase();
  const factory = factories.get(kind);
  if (!factory) {
    throw new ConnectorError('CONNECTOR_NOT_FOUND', `No merchant connector registered for ${kind}`, { kind });
  }
  return factory(merchant, options);
}

export class CustomRestConnector extends MerchantConnector {
  constructor(config = {}) {
    const merchant = config.merchant || {};
    const nested = merchant.config || {};
    super({
      merchant_id: config.merchant_id || merchant.merchant_id || merchant.id,
      merchant_of_record:
        config.merchant_of_record || merchant.merchant_of_record || nested.merchant_of_record || merchant.name,
      provider: 'custom',
    });
    this.baseUrl = config.baseUrl || config.base_url || nested.baseUrl || nested.base_url;
    this.fetchImpl = config.fetchImpl || merchant.fetchImpl || globalThis.fetch;
  }

  async syncCatalog() {
    throw notSupported('syncCatalog', 'Custom REST connector stub requires merchant-specific catalog mapping');
  }

  async getProduct() {
    throw notSupported('getProduct', 'Custom REST connector stub requires merchant-specific product mapping');
  }

  async previewQuote() {
    throw notSupported(
      'previewQuote',
      'Custom REST connector stub cannot lock prices until merchant-specific live quote mapping is implemented',
    );
  }

  async createOrder() {
    throw notSupported('createOrder', 'Custom REST connector stub requires merchant-specific order mapping');
  }

  async createCheckout() {
    throw notSupported('createCheckout', 'Custom REST connector stub requires merchant-specific checkout mapping');
  }

  async getOrderStatus() {
    throw notSupported('getOrderStatus', 'Custom REST connector stub requires merchant-specific status mapping');
  }

  async refund() {
    throw notSupported('refund', 'Custom REST connector stub requires merchant-specific refund mapping');
  }

  async requestReturn() {
    throw notSupported('requestReturn', 'Custom REST connector stub requires merchant-specific return mapping');
  }

  async requestExchange() {
    throw notSupported('requestExchange', 'Custom REST connector stub requires merchant-specific exchange mapping');
  }

  async requestSupport() {
    throw notSupported('requestSupport', 'Custom REST connector stub requires merchant-specific support mapping');
  }

  verifyWebhook() {
    return false;
  }

  parseWebhook(rawBody) {
    const payload = JSON.parse(Buffer.from(rawBody ?? '', 'utf8').toString('utf8'));
    return {
      provider: 'custom',
      merchant_id: this.merchant_id,
      event_type: payload.type || payload.event || 'custom.webhook',
      event_id: payload.id || payload.event_id,
      order_id: payload.order_id,
      status: payload.status,
      payload,
    };
  }
}

export { ShopifyConnector };
