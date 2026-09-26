'use strict';

// Reading a price out of raw text, in one place.
//
// Two lanes read the same catalog and crawl rows and used to parse them differently. The reco prompt
// resolved a string price through toPositiveNumberOrNull + inferCurrencyFromPriceText (routes.js); the
// chat card ran Number() over it and took the currency from a sibling field. So one row produced two
// answers: after #2074 taught the prompt about decimal commas, '1,299' reached the model as 1299 while
// the card -- Number('1,299') is NaN -- said "Price unavailable" for the very same product, and '$12.30'
// was a price to one surface and nothing to the other.
//
// AMOUNT AND CURRENCY MUST MOVE TOGETHER. Sharing only the number parser is worse than sharing
// neither: the card would start reading '£88' as 88 and then label it with the row's fallback
// currency, printing "$88" for a British price -- the exact relabel #2065, #2069 and #2076 each closed
// somewhere else. A price written as text carries its currency IN the text, and whoever reads the
// number has to read the currency too.
//
// Parsing lives here; POLICY stays with each caller. toPositiveNumberOrNull keeps its own rule that a
// zero or negative amount is "no price"; the card keeps rendering a declared 0 as "$0". That split is
// deliberate -- it is the one difference between the lanes that is a decision rather than an accident.

// A string that is entirely a number, allowing grouped/decimal separators in either convention.
const PRICE_SEPARATOR_TEXT_RE = /^[+-]?(?:\d+(?:[.,]\d+)*[.,]?|[.,]\d+)$/;

// Which separator is the DECIMAL point, for a string that already matched the pattern above.
//
// `Number(text.replace(/,/g, ''))` -- the rule this replaces -- treats every comma as a thousands
// separator, so `35,30` came back as 3530. Serving €35.30 as €3530 is a 100x inflation of a price a
// buyer is shown, and roughly half the world writes prices that way.
//
// The rules, in order:
//   * BOTH separators present -- the LAST one is the decimal point and the other is grouping. This is
//     what distinguishes `1,299.00` from `1.234.567,89` without knowing the locale.
//   * Commas only -- a trailing run of 1 or 2 digits is a decimal comma (`35,30`, `1,2`); a run of 3
//     is grouping (`1,299`). Three digits after the final comma is the one genuinely ambiguous case,
//     and grouping is both the commoner convention and the reading this code already had.
//   * Dots only -- more than one dot can only be grouping (`1.234.567`); a single dot is decimal.
function resolvePriceSeparators(text) {
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  let decimalAt = -1;
  if (lastComma >= 0 && lastDot >= 0) decimalAt = Math.max(lastComma, lastDot);
  else if (lastComma >= 0) decimalAt = /,\d{1,2}$/.test(text) ? lastComma : -1;
  else if (lastDot >= 0) decimalAt = (text.match(/\./g) || []).length > 1 ? -1 : lastDot;
  // A TRAILING separator is still the decimal point -- it simply has no cents after it. Trimming it
  // instead would throw away the very signal that resolves the rest: the comma in `1.299,` is what
  // says the dot is grouping, so `1.299,` is 1299 and a bare `1.299` is 1.30.
  const whole = (decimalAt >= 0 ? text.slice(0, decimalAt) : text).replace(/[.,]/g, '');
  const fraction = decimalAt >= 0 ? text.slice(decimalAt + 1).replace(/[.,]/g, '') : '';
  return fraction ? `${whole}.${fraction}` : whole;
}

// The amount a value states, with NO opinion about whether it is a usable price. Returns a finite
// number or null; 0 and negatives come back as themselves, for the caller to accept or refuse.
function parsePriceAmount(value) {
  if (value == null) return null;
  // `true` is not a dollar. Number(true) is 1 -- finite and positive -- so a boolean priced a product
  // at $1 on every path that resolves a price through here.
  if (typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const compact = text.replace(/\s+/g, '');
    // With no comma there is nothing to misread, so parse it as written. This runs FIRST because an
    // overflow must NOT reach the salvage below -- Number('1e999') is Infinity, and salvaging its
    // digits reads it back as 1999.
    if (!compact.includes(',')) {
      const direct = Number(compact);
      if (!Number.isNaN(direct)) return Number.isFinite(direct) ? direct : null;
    }
    // Everything else: strip whatever is not part of a number ('$12.30', '12,5 EUR', 'From
    // $1,299.00') and resolve the separators by convention. ONE rule for symbol and no-symbol alike --
    // the two used to disagree, so `1,299` was 1299 and `$1,299` was 1.30.
    const numericOnly = compact.replace(/[^0-9.,+-]/g, '');
    if (!PRICE_SEPARATOR_TEXT_RE.test(numericOnly)) return null;
    const resolved = Number(resolvePriceSeparators(numericOnly));
    return Number.isFinite(resolved) ? resolved : null;
  }
  // NOT rejected: an array. Number([5]) is 5 while Number([5, 6]) is NaN, which is arbitrary -- but a
  // list arrives legitimately one level inside an offer or carrier object (`offers: [{ price:
  // ['19.99'] }]`, `{ amount: ['19.99'] }`), and rejecting arrays was measured to drop every one of
  // those to "no price".
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// The currency a price TEXT states, if it states one. A symbol or code written into the price string
// is the most specific evidence available and outranks any sibling field, which is why this has to
// travel with parsePriceAmount rather than being left to the caller's fallback.
function inferCurrencyFromPriceText(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (/[$]|usd|us\$/i.test(text)) return 'USD';
  if (/[€]|eur/i.test(text)) return 'EUR';
  if (/[£]|gbp/i.test(text)) return 'GBP';
  if (/[¥]|cny|rmb/i.test(text)) return 'CNY';
  if (/jpy|円/i.test(text)) return 'JPY';
  return '';
}

module.exports = {
  PRICE_SEPARATOR_TEXT_RE,
  resolvePriceSeparators,
  parsePriceAmount,
  inferCurrencyFromPriceText,
};
