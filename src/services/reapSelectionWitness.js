'use strict';

// Selection data recorded before dispatch. This is never eligibility/proof authority.
const FIELDS = Object.freeze(['product_key', 'variant_id', 'variant_key', 'merchant_domain', 'market', 'currency', 'unit_price_minor', 'quantity', 'item_source']);
function readSelectionWitness(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== FIELDS.length || !FIELDS.every(k => Object.prototype.hasOwnProperty.call(value, k))) return null;
  const text = (k, max) => typeof value[k] === 'string' && value[k].length > 0 && value[k].length <= max
    && value[k] === value[k].trim() && !/[\x00-\x1f\x7f]/.test(value[k]);
  if (!text('product_key', 1024) || !text('variant_key', 1024)
    || typeof value.variant_id !== 'string' || !/^[1-9][0-9]{0,24}$/.test(value.variant_id)
    || !text('merchant_domain', 255) || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(value.merchant_domain)
    || typeof value.market !== 'string' || !/^[A-Z]{2}$/.test(value.market)
    || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)
    || !Number.isSafeInteger(value.unit_price_minor) || value.unit_price_minor <= 0
    || !Number.isSafeInteger(value.quantity) || value.quantity < 1 || value.quantity > 10
    || !Number.isSafeInteger(value.unit_price_minor * value.quantity) || value.item_source !== 'cart_link') return null;
  return Object.fromEntries(FIELDS.map(k => [k, value[k]]));
}
function sameSelection(a, b) {
  const left = readSelectionWitness(a), right = readSelectionWitness(b);
  return Boolean(left && right && FIELDS.every(k => left[k] === right[k]));
}
module.exports = { FIELDS, readSelectionWitness, sameSelection };
