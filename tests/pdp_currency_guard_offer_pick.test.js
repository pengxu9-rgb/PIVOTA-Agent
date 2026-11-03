delete process.env.DATABASE_URL;

// hydrateCanonicalPdpPayloadFromOffers' `onlyServingCurrency` (src/server.js): once get_pdp_v2's serving-currency
// guard withheld the page's own money, no offer in another currency re-prices the card. Without it the picker
// still falls back to every offer when none is in the serving currency (the page's behaviour before the guard).

const app = require('../src/server');

const { hydrateCanonicalPdpPayloadFromOffers } = app._debug;

const sgdOffers = () => ({
  offers: [{ offer_id: 'of_sgd', merchant_id: 'merch_a', price: { amount: 229.99, currency: 'SGD' }, inventory: { in_stock: true } }],
  default_offer_id: 'of_sgd',
  offer_source: 'group_fused',
});
const unpricedPayload = () => ({ product: { product_id: 'p1', merchant_id: 'merch_a', title: 'T' } });

describe('the card is priced only from an offer in the buyer\'s currency once the guard fired', () => {
  test('onlyServingCurrency: an SGD-only offer list prices nothing for a USD page', () => {
    const out = hydrateCanonicalPdpPayloadFromOffers(unpricedPayload(), sgdOffers(), {
      servingCurrency: 'USD', onlyServingCurrency: true,
    });
    expect(out.product.price).toBeUndefined();
    expect(out.product.price_amount).toBeUndefined();
  });

  test('without it, the picker still falls back to the SGD offer (unchanged behaviour)', () => {
    const out = hydrateCanonicalPdpPayloadFromOffers(unpricedPayload(), sgdOffers(), { servingCurrency: 'USD' });
    expect(out.product.price).toEqual(expect.objectContaining({ amount: 229.99, currency: 'SGD' }));
  });

  test('an offer in the serving currency still prices the card', () => {
    const data = sgdOffers();
    data.offers.push({ offer_id: 'of_usd', merchant_id: 'merch_b', price: { amount: 170, currency: 'USD' }, inventory: { in_stock: true } });
    const out = hydrateCanonicalPdpPayloadFromOffers(unpricedPayload(), data, { servingCurrency: 'USD', onlyServingCurrency: true });
    expect(out.product.price).toEqual(expect.objectContaining({ amount: 170, currency: 'USD' }));
  });

  test('get_pdp_v2 passes the guard\'s verdict to the hydrate step', () => {
    const source = require('node:fs').readFileSync(require.resolve('../src/server'), 'utf8');
    expect(source).toMatch(/onlyServingCurrency: Boolean\(pdpCurrencyGuard\),/);
  });
});
