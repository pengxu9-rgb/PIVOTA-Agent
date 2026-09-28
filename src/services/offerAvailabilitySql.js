'use strict';

// THE ONE SPELLING of "this seller has said it cannot sell it". Mirrors pivota-backend
// services/offer_buyability.OFFER_UNAVAILABLE_AVAILABILITIES verbatim, compared trimmed and
// lowercased. Everything else — unknown, NULL, empty, any unrecognised word — is NOT
// unavailability and ranks WITH the in-stock offers. Both the SQL tier below and the JS
// best_offer pick (src/agentSignals/offerToSignal.js) read this list, so the two can no
// longer drift; tests pin it to the backend literal.
const OFFER_UNAVAILABLE_AVAILABILITIES = Object.freeze([
  'out_of_stock', 'outofstock', 'sold_out', 'soldout', 'unavailable',
]);

for (const value of OFFER_UNAVAILABLE_AVAILABILITIES) {
  // Interpolated into SQL below, so it must stay a bare lowercase token.
  if (!/^[a-z_]+$/.test(value)) throw new Error(`offerAvailabilitySql: unsafe availability token ${value}`);
}

const OFFER_UNAVAILABLE_AVAILABILITY_SET = new Set(OFFER_UNAVAILABLE_AVAILABILITIES);

// JS side of the same comparison. String.prototype.trim() is the reference trim.
function isUnavailableAvailabilityText(value) {
  if (typeof value !== 'string') return false;
  return OFFER_UNAVAILABLE_AVAILABILITY_SET.has(value.trim().toLowerCase());
}

// String.prototype.trim() removes these ECMAScript whitespace and line-terminator
// code points. PostgreSQL's one-argument btrim() removes only U+0020; in
// particular it leaves tabs/newlines around a known-unavailable status.
// U& keeps the non-ASCII characters visible in source and avoids depending on
// the database locale's interpretation of POSIX [[:space:]].
const JS_TRIM_CHARS_SQL = String.raw`U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'`;

// Unknown availability shares the sellable tier; price decides within it.
// The alias o is used by both canonical search LATERALs and the index feed.
const OFFER_AVAILABILITY_TIER_SQL = `CASE WHEN lower(btrim(coalesce(o.availability, ''), ${JS_TRIM_CHARS_SQL})) IN
  (${OFFER_UNAVAILABLE_AVAILABILITIES.map((value) => `'${value}'`).join(', ')}) THEN 1 ELSE 0 END`;

module.exports = {
  OFFER_AVAILABILITY_TIER_SQL,
  OFFER_UNAVAILABLE_AVAILABILITIES,
  isUnavailableAvailabilityText,
};
