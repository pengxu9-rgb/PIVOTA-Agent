const { EXTERNAL_SEED_MERCHANT_ID } = require('./pdpConfig');

function inferMerchantIdFromProductId(productId) {
  const normalizedProductId = String(productId || '').trim();
  if (!normalizedProductId) return '';
  if (/^ext_/i.test(normalizedProductId)) return EXTERNAL_SEED_MERCHANT_ID;
  return '';
}

module.exports = {
  inferMerchantIdFromProductId,
};
