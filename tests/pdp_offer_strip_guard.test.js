delete process.env.DATABASE_URL;

// get_pdp_v2's offer strip (src/server.js withholdOffMarketOfferMoney): an offer quoting money in another currency
// than the buyer's loses it AND its savings copy, which quotes the same money in words; an offer in the buyer's
// currency is untouched. And a shipping cost the guard withheld is an unknown total in server.js's computeOfferTotal,
// never free shipping that would rank the offer cheapest.

process.env.NODE_ENV = 'test';
process.env.PIVOTA_API_BASE = 'http://127.0.0.1:9';

const app = require('../src/server');
const { withholdOffMarketMoney } = require('../src/services/servingCurrencyGuard');
const offersPriority = require('../src/offers/offersPriority');

const { withholdOffMarketOfferMoney, computeOfferTotal, buildOffersFromGroupMembers } = app._debug;

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

// The group page ranks its member offers (buildOffersFromGroupMembers) BEFORE get_pdp_v2's offer strip runs, and the
// best price it picks is not recomputed after. So an offer whose total the buyer's currency cannot state must not
// win there either (PR controller review of #2543).
describe('group offers: a total the buyer currency cannot state never wins best price', () => {
  const member = (merchant, product) => ({ merchant_id: merchant, product_id: product, platform: 'shopify' });
  const listing = (merchant, product, amount, shipping) => ({
    merchant_id: merchant, product_id: product, platform: 'shopify', platform_product_id: product, title: 'T',
    in_stock: true, price: { amount, currency: 'USD' }, currency: 'USD', ...(shipping ? { shipping } : {}),
  });
  const offerOf = (out, merchant) => out.offers.find((o) => o.merchant_id === merchant);

  test('a USD price with a GBP shipping cost is an unknown total: the USD 100 offer is best, not USD 95 + 4 GBP', async () => {
    const out = await buildOffersFromGroupMembers({
      productGroupId: 'pg_1', members: [member('merch_a', 'p1'), member('merch_b', 'p2')],
      servingCurrency: 'USD', buyerMarket: 'US',
      prefetchedProducts: [listing('merch_a', 'p1', 100), listing('merch_b', 'p2', 95, { cost: { amount: 4, currency: 'GBP' } })],
    });
    expect(computeOfferTotal(offerOf(out, 'merch_b'))).toBe(Number.POSITIVE_INFINITY);
    expect(offersPriority.computeOfferTotal(offerOf(out, 'merch_b'))).toBe(Number.POSITIVE_INFINITY);
    expect(out.best_price_offer_id).toBe(offerOf(out, 'merch_a').offer_id);
  });

  test("the opened member whose shipping the card's guard withheld keeps the marker, and does not win on free shipping", async () => {
    const card = withholdOffMarketMoney(
      listing('merch_a', 'p1', 100, { method_label: 'Std', cost: { amount: 30, currency: 'SGD' } }), 'USD',
    ).product;
    expect(card.shipping).toEqual({ method_label: 'Std', cost_withheld: true });
    const out = await buildOffersFromGroupMembers({
      productGroupId: 'pg_1', members: [member('merch_a', 'p1'), member('merch_b', 'p2')],
      servingCurrency: 'USD', buyerMarket: 'US', preferredMerchantId: 'merch_a', preferredProductId: 'p1',
      prefetchedProducts: [card, listing('merch_b', 'p2', 95, { cost: { amount: 10, currency: 'USD' } })],
    });
    expect(offerOf(out, 'merch_a').shipping).toEqual(expect.objectContaining({ cost_withheld: true }));
    expect(computeOfferTotal(offerOf(out, 'merch_a'))).toBe(Number.POSITIVE_INFINITY);
    expect(computeOfferTotal(offerOf(out, 'merch_b'))).toBe(105);
    expect(out.best_price_offer_id).toBe(offerOf(out, 'merch_b').offer_id);
  });

  test('shipping in the price currency still adds up, and an unlabelled cost is the price currency', () => {
    expect(computeOfferTotal({ price: { amount: 95, currency: 'USD' }, shipping: { cost: { amount: 10, currency: 'usd' } } })).toBe(105);
    expect(computeOfferTotal({ price: { amount: 95, currency: 'USD' }, shipping: { cost: { amount: 10 } } })).toBe(105);
    expect(offersPriority.computeOfferTotal({ price: { amount: 95, currency: 'USD' }, shipping: { cost: { amount: 10 } } })).toBe(105);
  });
});
