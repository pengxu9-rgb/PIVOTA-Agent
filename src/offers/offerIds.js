const OFFER_ID_PREFIX = 'of:v1:';

function buildProductGroupId(input) {
  const platform = String(input?.platform || '').trim();
  const platformProductId = String(
    input?.platform_product_id || input?.platformProductId || '',
  ).trim();
  if (platform && platformProductId) return `pg:${platform}:${platformProductId}`;

  const merchantId = String(input?.merchant_id || input?.merchantId || '').trim();
  const productId = String(input?.product_id || input?.productId || '').trim();
  if (merchantId && productId) return `pg:${merchantId}:${productId}`;

  if (productId) return `pg:pid:${productId}`;
  return null;
}

function buildOfferId(input) {
  const merchantId = String(input?.merchant_id || input?.merchantId || '').trim();
  const productGroupId = String(
    input?.product_group_id || input?.productGroupId || '',
  ).trim();
  if (!merchantId || !productGroupId) return null;

  const fulfillmentType = String(
    input?.fulfillment_type || input?.fulfillmentType || 'merchant',
  ).trim() || 'merchant';
  const tier = String(input?.tier || 'default').trim() || 'default';

  // NOTE: product_group_id can contain ":"; offer ids must remain parseable for merchant_id.
  // The format guarantees merchant_id is always the first segment after the prefix.
  return `${OFFER_ID_PREFIX}${merchantId}:${productGroupId}:${fulfillmentType}:${tier}`;
}

function extractMerchantIdFromOfferId(offerId) {
  const raw = String(offerId || '').trim();
  if (!raw) return null;
  if (!raw.startsWith(OFFER_ID_PREFIX)) return null;
  const rest = raw.slice(OFFER_ID_PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx <= 0) return null;
  const merchantId = rest.slice(0, idx).trim();
  return merchantId || null;
}

function parseOfferId(offerId) {
  const raw = String(offerId || '').trim();
  if (!raw) return null;
  if (!raw.startsWith(OFFER_ID_PREFIX)) return null;
  const rest = raw.slice(OFFER_ID_PREFIX.length);
  const parts = rest.split(':');
  // Format:
  // of:v1:{merchant_id}:{product_group_id}:{fulfillment_type}:{tier}
  // NOTE: product_group_id itself can contain ":".
  if (parts.length < 4) return null;
  const merchantId = String(parts[0] || '').trim();
  const tier = String(parts[parts.length - 1] || '').trim();
  const fulfillmentType = String(parts[parts.length - 2] || '').trim();
  const productGroupId = parts.slice(1, parts.length - 2).join(':').trim();
  if (!merchantId || !productGroupId || !fulfillmentType || !tier) return null;
  return {
    merchant_id: merchantId,
    product_group_id: productGroupId,
    fulfillment_type: fulfillmentType,
    tier,
  };
}

module.exports = {
  buildProductGroupId,
  buildOfferId,
  extractMerchantIdFromOfferId,
  parseOfferId,
};
