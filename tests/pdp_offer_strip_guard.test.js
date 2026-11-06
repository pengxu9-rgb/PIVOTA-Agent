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

  test('a USD price with GBP shipping is never summed: the two compare on price, USD 95 before USD 100', async () => {
    const out = await buildOffersFromGroupMembers({
      productGroupId: 'pg_1', members: [member('merch_a', 'p1'), member('merch_b', 'p2')],
      servingCurrency: 'USD', buyerMarket: 'US',
      prefetchedProducts: [listing('merch_a', 'p1', 100), listing('merch_b', 'p2', 95, { cost: { amount: 4, currency: 'GBP' } })],
    });
    // Never 95 + 4 = 99 (a GBP amount added to a USD one): B's total is unknown, so A and B compare on price.
    expect(computeOfferTotal(offerOf(out, 'merch_b'))).toBe(Number.POSITIVE_INFINITY);
    expect(offersPriority.computeOfferTotal(offerOf(out, 'merch_b'))).toBe(Number.POSITIVE_INFINITY);
    expect(out.best_price_offer_id).toBe(offerOf(out, 'merch_b').offer_id);
  });

  test('an SG buyer: SGD 50 + USD 5 shipping is best over SGD 80 + SGD 5 (the unknown total compares on price)', async () => {
    const sgd = (merchant, product, amount, shipping) => ({ ...listing(merchant, product, amount, shipping),
      price: { amount, currency: 'SGD' }, currency: 'SGD' });
    const build = (products, members) => buildOffersFromGroupMembers({
      productGroupId: 'pg_1', members, servingCurrency: 'SGD', buyerMarket: 'SG', prefetchedProducts: products,
    });
    const a = sgd('merch_a', 'p1', 50, { cost: { amount: 5, currency: 'USD' } });
    const b = sgd('merch_b', 'p2', 80, { cost: { amount: 5, currency: 'SGD' } });
    let out = await build([a, b], [member('merch_a', 'p1'), member('merch_b', 'p2')]);
    expect(out.best_price_offer_id).toBe(offerOf(out, 'merch_a').offer_id);
    // Every total unknown: still the cheaper price, whatever the member order.
    const b2 = sgd('merch_b', 'p2', 80, { cost: { amount: 1, currency: 'USD' } });
    out = await build([b2, a], [member('merch_b', 'p2'), member('merch_a', 'p1')]);
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

  test('equal offers: the best price is the same whatever the member order (lowest offer id, never list order)', async () => {
    const pick = async (order) => {
      const products = { a: listing('merch_a', 'p1', 50), b: listing('merch_b', 'p2', 50) };
      const out = await buildOffersFromGroupMembers({
        productGroupId: 'pg_1', members: order.map((k) => member(`merch_${k}`, k === 'a' ? 'p1' : 'p2')),
        servingCurrency: 'USD', buyerMarket: 'US', prefetchedProducts: order.map((k) => products[k]),
      });
      return out.best_price_offer_id;
    };
    const forward = await pick(['a', 'b']);
    expect(await pick(['b', 'a'])).toBe(forward);
    expect(forward).toMatch(/merch_a/);
  });

  test('shipping in the price currency still adds up, and an unlabelled cost is the price currency', () => {
    expect(computeOfferTotal({ price: { amount: 95, currency: 'USD' }, shipping: { cost: { amount: 10, currency: 'usd' } } })).toBe(105);
    expect(computeOfferTotal({ price: { amount: 95, currency: 'USD' }, shipping: { cost: { amount: 10 } } })).toBe(105);
    expect(offersPriority.computeOfferTotal({ price: { amount: 95, currency: 'USD' }, shipping: { cost: { amount: 10 } } })).toBe(105);
  });
});

describe('offer totals (offersPriority.offerTotalParts via computeOfferTotal / compareOfferTotals)', () => {
  const { compareOfferTotals, compareOfferTotalsThenId, offerTotalChanged } = offersPriority;
  const total = offersPriority.computeOfferTotal;

  test('currency codes compare case- and space-insensitively; the price currency falls back to price.current, then the offer', () => {
    expect(total({ price: { amount: 10, currency: 'usd' }, shipping: { cost: { amount: 2, currency: ' USD ' } } })).toBe(12);
    expect(total({ price: { current: { amount: 10, currency: 'USD' } }, shipping: { cost: { amount: 2, currency: 'USD' } } })).toBe(12);
    expect(total({ price: { current: { amount: 10, currency: 'USD' } }, shipping: { cost: { amount: 2, currency: 'SGD' } } }))
      .toBe(Number.POSITIVE_INFINITY);
    expect(total({ price: { amount: 10 }, currency: 'USD', shipping: { cost: { amount: 2, currency: 'USD' } } })).toBe(12);
    expect(total({ price: { amount: 10, currency: '' }, currency: 'USD', shipping: { cost: { amount: 2, currency: 'USD' } } })).toBe(12);
    expect(total({ price: { amount: 10, currency: '' }, currency: 'USD', shipping: { cost: { amount: 2, currency: 'SGD' } } }))
      .toBe(Number.POSITIVE_INFINITY);
  });

  test('a price stating no currency with a labelled shipping cost is unknown; a zero cost is zero whatever its label', () => {
    expect(total({ price: { amount: 10 }, shipping: { cost: { amount: 2, currency: 'SGD' } } })).toBe(Number.POSITIVE_INFINITY);
    expect(total({ price: { amount: 10 }, shipping: { cost: { amount: 2 } } })).toBe(12);
    expect(total({ price: { amount: 10, currency: 'USD' }, shipping: { cost: { amount: 0, currency: 'SGD' } } })).toBe(10);
  });

  test('known totals compare as totals; with either unknown they compare on price; ties go to the lower price, then the id', () => {
    const known = (id, price, ship) => ({ offer_id: id, price: { amount: price, currency: 'USD' }, shipping: { cost: { amount: ship, currency: 'USD' } } });
    const foreign = (id, price) => ({ offer_id: id, price: { amount: price, currency: 'USD' }, shipping: { cost: { amount: 1, currency: 'GBP' } } });
    expect(compareOfferTotals(known('a', 10, 5), known('b', 12, 1))).toBe(1);
    expect(compareOfferTotals(foreign('a', 10), known('b', 11, 0))).toBe(-1);
    expect(compareOfferTotals(foreign('a', 12), known('b', 11, 5))).toBe(1);
    expect(compareOfferTotals(known('a', 9, 3), known('b', 11, 1))).toBe(-1);
    expect(compareOfferTotals(known('a', 11, 1), known('b', 9, 3))).toBe(1);
    expect(compareOfferTotals({ offer_id: 'u', price: {} }, known('b', 11, 1))).toBe(1);
    expect(compareOfferTotalsThenId(foreign('b', 10), foreign('a', 10))).toBe(1);
    expect([foreign('b', 10), foreign('a', 10)].sort(compareOfferTotalsThenId).map((o) => o.offer_id)).toEqual(['a', 'b']);
  });

  test('a price move on an offer whose total is unknown is still a change', () => {
    const offer = (price) => ({ price: { amount: price, currency: 'USD' }, shipping: { cost: { amount: 1, currency: 'GBP' } } });
    expect(offerTotalChanged(offer(10), offer(9))).toBe(true);
    expect(offerTotalChanged(offer(10), offer(10))).toBe(false);
  });
});
