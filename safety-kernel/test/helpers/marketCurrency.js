// A STAND-IN for the gateway's market -> currency source, for tests of the ACP REST door that run without the
// gateway (the door takes the source as `marketCurrencyOf`; in the gateway it is the one every checkout door reads).
// Three priced markets and nothing else: any other code has no currency, as an unpriced market has none there.
const PRICED = Object.freeze({ US: 'USD', SG: 'SGD', GB: 'GBP' });

/** The currency a market (upper-case ISO 3166-1 alpha-2) is priced in, or null. Never a default. */
export function marketCurrencyOf(market) {
  return Object.prototype.hasOwnProperty.call(PRICED, market) ? PRICED[market] : null;
}
