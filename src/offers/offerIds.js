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

module.exports = {
  buildProductGroupId,
  buildOfferId,
  extractMerchantIdFromOfferId,
};

