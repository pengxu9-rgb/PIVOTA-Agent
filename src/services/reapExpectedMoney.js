"use strict";
// Original buyer price constraint, never catalog price authority. Omission is
// meaningful for immutable legacy recovery: do not infer it from a selection.
function readExpectedMoney(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const unit = value.expected_unit_price_minor, currency = value.expected_currency;
  const hasUnit = Object.prototype.hasOwnProperty.call(value, 'expected_unit_price_minor');
  const hasCurrency = Object.prototype.hasOwnProperty.call(value, 'expected_currency');
  if (!hasUnit && !hasCurrency) return undefined;
  if (!hasUnit || !hasCurrency || !Number.isSafeInteger(unit) || unit < 1
    || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  return { expected_unit_price_minor: unit, expected_currency: currency };
}
module.exports = { readExpectedMoney };
