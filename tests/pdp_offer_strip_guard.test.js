delete process.env.DATABASE_URL;

// get_pdp_v2's offer strip (src/server.js withholdOffMarketOfferMoney): an offer quoting money in another currency
// than the buyer's loses it AND its savings copy, which quotes the same money in words; an offer in the buyer's
// currency is untouched. And a shipping cost the guard withheld is an unknown total in server.js's computeOfferTotal,
// never free shipping that would rank the offer cheapest.

const app = require('../src/server');

const { withholdOffMarketOfferMoney, computeOfferTotal } = app._debug;

const SAVINGS_COPY = {
  payment_offer_summary: { headline: 'Save SGD 20 with a partner card' },
  promotion_lines: ['SGD 20 off orders over SGD 200'],
};

describe('the PDP offer strip', () => {
  test('an off-market offer loses its money and its savings copy; the currency is reported', () => {
    const sgd = { offer_id: 'of_sgd', merchant_id: 'merch_a', price: { amount: 229.99, currency: 'SGD' }, ...SAVINGS_COPY };
    const usd = { offer_id: 'of_usd', merchant_id: 'merch_b', price: { amount: 170, currency: 'USD' }, ...SAVINGS_COPY };
    const out = withholdOffMarketOfferMoney([sgd, usd], 'USD');
    expect(out.withheld).toEqual(['SGD']);
    expect(out.offers[0].offer_id).toBe('of_sgd');
    expect(out.offers[0].price).toBeUndefined();
    expect(out.offers[0].payment_offer_summary).toBeUndefined();
    expect(out.offers[0].promotion_lines).toBeUndefined();
    expect(out.offers[1]).toBe(usd);
  });

  test('nothing off-market: the same offers, nothing reported', () => {
    const usd = { offer_id: 'of_usd', price: { amount: 170, currency: 'USD' } };
    expect(withholdOffMarketOfferMoney([usd], 'USD')).toEqual({ offers: [usd], withheld: [] });
  });

  test("server.js's offer total: a withheld shipping cost is unknown, an absent one is free", () => {
    const withheld = withholdOffMarketOfferMoney(
      [{ offer_id: 'w', price: { amount: 10, currency: 'USD' }, shipping: { cost: { amount: 5, currency: 'SGD' } } }], 'USD',
    );
    expect(withheld.withheld).toEqual(['SGD']);
    expect(withheld.offers[0].shipping).toEqual({ cost_withheld: true });
    expect(computeOfferTotal(withheld.offers[0])).toBe(Number.POSITIVE_INFINITY);
    expect(computeOfferTotal({ price: { amount: 10, currency: 'USD' }, shipping: {} })).toBe(10);
    expect(computeOfferTotal({ price: { amount: 10, currency: 'USD' }, shipping: { cost: { amount: 2, currency: 'USD' } } })).toBe(12);
  });
});
