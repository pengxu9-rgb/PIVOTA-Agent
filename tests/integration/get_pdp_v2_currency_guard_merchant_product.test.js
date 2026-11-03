process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';
delete process.env.DATABASE_URL;

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

// get_pdp_v2's serving-currency guard on a merchant product whose currency is stated at PRODUCT level
// (src/services/servingCurrencyGuard.js withholdOffMarketMoney). The builder labels every variant that states no
// currency of its own with the product's (pdpBuilder), so such a variant is priced in the product's currency and
// is judged by it: a CAD product's currency-less variants are withheld with it for a US (or market-less) buyer.
// A variant that states the serving currency itself keeps its money, and is labelled with that currency.

const MERCHANT = 'merch_curguard_solo';

function mockProduct(product) {
  nock(process.env.PIVOTA_API_BASE)
    .post('/agent/shop/v1/invoke', (b) => b?.operation === 'get_product_detail' && b?.payload?.product?.product_id === product.product_id)
    .times(3)
    .reply(200, { product });
  nock(process.env.PIVOTA_API_BASE)
    .get('/agent/v1/product-groups/resolve')
    .query(true)
    .times(3)
    .reply(200, { status: 'success', product_group_id: null, members: [] });
}

let seq = 0;
function productOf(shape) {
  const pid = `solo_${shape}_${seq++}`;
  const base = { merchant_id: MERCHANT, product_id: pid, title: 'Solo', in_stock: true };
  switch (shape) {
    case 'cad_variants_without_currency':
      return { ...base, currency: 'CAD', price: { amount: 42, currency: 'CAD' },
        variants: [{ variant_id: `${pid}_v1`, title: 'Small', price: 42, in_stock: true },
          { variant_id: `${pid}_v2`, title: 'Large', price: '55.00', in_stock: true }] };
    case 'cad_headline_usd_variant':
      return { ...base, currency: 'CAD', price: { amount: 42, currency: 'CAD' }, default_variant_id: `${pid}_v1`,
        variants: [{ variant_id: `${pid}_v1`, title: 'Small', price: 42, currency: 'CAD', in_stock: true },
          { variant_id: `${pid}_v2`, title: 'Large', price: 30, currency: 'USD', in_stock: true }] };
    case 'usd_control':
      return { ...base, currency: 'usd', price: { amount: 42, currency: ' USD' },
        variants: [{ variant_id: `${pid}_v1`, title: 'Small', price: 42, in_stock: true }] };
    default:
      throw new Error(shape);
  }
}

async function pdpFor(product, extra = {}) {
  mockProduct(product);
  const res = await request(app).post('/agent/shop/v1/invoke').send({
    operation: 'get_pdp_v2',
    payload: { include: ['offers', 'variant_selector'], product_ref: { merchant_id: MERCHANT, product_id: product.product_id }, ...extra },
  });
  expect(res.status).toBe(200);
  const pdp = (res.body.modules || []).find((m) => m.type === 'canonical')?.data?.pdp_payload || {};
  const offers = (res.body.modules || []).find((m) => m.type === 'offers')?.data?.offers || [];
  return {
    body: res.body,
    card: pdp.product?.price,
    variants: (pdp.product?.variants || []).map((v) => v.price || null),
    actions: (pdp.actions || []).map((a) => a.action_type),
    offerPrices: offers.map((o) => [o.price || null, (o.variants || []).map((v) => v.price || null)]),
    guard: res.body?.metadata?.serving_currency_guard,
  };
}

describe('get_pdp_v2 currency guard: product-level currency', () => {
  afterEach(() => nock.cleanAll());

  test('a CAD product\'s currency-less variants are priced in CAD and are withheld with it', async () => {
    const page = await pdpFor(productOf('cad_variants_without_currency'));
    expect(page.guard).toEqual({ withheld_currencies: ['CAD'] });
    expect(page.card).toBeUndefined();
    expect(page.variants).toEqual([null, null]);
    expect(page.actions).toEqual([]);
    expect(page.offerPrices).toEqual([[null, [null, null]]]);
  });

  test('a CAD headline beside a USD variant: the USD variant keeps its money, labelled USD', async () => {
    const page = await pdpFor(productOf('cad_headline_usd_variant'));
    expect(page.guard).toEqual({ withheld_currencies: ['CAD'] });
    expect(page.card).toBeUndefined();
    expect(page.variants).toEqual([null, { current: { amount: 30, currency: 'USD' } }]);
    // No money in the withheld currency is left anywhere a price is read.
    expect(JSON.stringify(page.offerPrices)).not.toContain('CAD');
  });

  test('a buyer in the product\'s own market gets it priced, with no guard', async () => {
    const page = await pdpFor(productOf('cad_variants_without_currency'), { market: 'CA' });
    expect(page.guard).toBeUndefined();
    expect(page.card).toEqual(expect.objectContaining({ current: { amount: 42, currency: 'CAD' } }));
  });

  test('a USD product is untouched', async () => {
    const page = await pdpFor(productOf('usd_control'));
    expect(page.guard).toBeUndefined();
    expect(page.card).toEqual(expect.objectContaining({ current: { amount: 42, currency: 'USD' } }));
    expect(page.actions).toEqual(expect.arrayContaining(['add_to_cart']));
  });
});
