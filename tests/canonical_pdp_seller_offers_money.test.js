// Other sellers on a verified canonical PDP: every displayed seller's money is checked by the same
// current-read rules as the selected listing, or that seller is shown without money and cannot be
// bought. Peng 2026-10-05: "keep those sellers buyable, and verify their prices".
const {
  readCanonicalSellerOffersMoney, projectSellerOffersMoney, withoutCanonicalPurchaseActions,
  MAX_VERIFIED_SELLER_LISTINGS,
} = require('../src/services/canonicalPdpOwnMoney');
const { bindVerifiedSellerOffers } = require('../src/services/pdpReadOnlyEvidence');

const REF = { merchant_id: 'merch_obs_selected', product_id: 'brand:selected', product_key: 'ext:brand::selected' };

function row(listing, { productKey = `pk::${listing}`, variant = 'v1', amount = '12.50', currency = 'USD', sku } = {}) {
  const [merchant, product] = listing.split('|');
  return { listing_merchant_id: merchant, listing_product_id: product, product_key: productKey,
    offer_id: `o_${listing}_${variant}`, sku_key: sku || `${productKey}::${variant}`, source_variant_id: variant, currency, amount };
}

function queryReturning(rows) {
  const calls = [];
  const query = async (sql, params) => { calls.push({ sql, params }); return { rows }; };
  return { query, calls };
}

describe('readCanonicalSellerOffersMoney', () => {
  test('one batched statement, keyed by seller listing, using the own-money rules', async () => {
    const { query, calls } = queryReturning([
      row('m_a|p_a', { variant: 'v1', amount: '10.00' }), row('m_a|p_a', { variant: 'v2', amount: '11.00' }),
      row('m_b|p_b', { variant: 'v9', amount: '20.00' }),
    ]);
    const verified = await readCanonicalSellerOffersMoney({ query, listings: [
      { merchant_id: 'm_a', product_id: 'p_a' }, { merchant_id: 'm_b', product_id: 'p_b' }, { merchant_id: 'm_a', product_id: 'p_a' },
    ] });
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([['m_a', 'm_b'], ['p_a', 'p_b']]);
    // Same rules as the selected listing: trust, live, enrichment lane, own seller, US/USD, in stock.
    for (const clause of ["serving_decision = 'public'", "sync_status = 'live'", "co.market = 'US'",
      "co.currency = 'USD'", "co.availability = 'in_stock'", 'co.merchant_id = own_cp.merchant_id']) {
      expect(calls[0].sql).toContain(clause);
    }
    expect(verified.get('m_a\u0000p_a').get('v2').amount).toBe(11);
    expect(verified.get('m_b\u0000p_b').get('v9').amount).toBe(20);
  });

  test('no listings means no query', async () => {
    const { query, calls } = queryReturning([]);
    expect((await readCanonicalSellerOffersMoney({ query, listings: [{ merchant_id: '', product_id: 'x' }] })).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('a listing mapping to two catalog products, or with conflicting prices, stays unverified alone', async () => {
    const { query } = queryReturning([
      row('m_a|p_a', { productKey: 'pk1' }), row('m_a|p_a', { productKey: 'pk2' }),
      row('m_b|p_b', { variant: 'v1', amount: '5.00', sku: 's1' }), row('m_b|p_b', { variant: 'v1', amount: '6.00', sku: 's2' }),
      row('m_c|p_c', { amount: '7.00' }),
    ]);
    const verified = await readCanonicalSellerOffersMoney({ query, listings: [
      { merchant_id: 'm_a', product_id: 'p_a' }, { merchant_id: 'm_b', product_id: 'p_b' }, { merchant_id: 'm_c', product_id: 'p_c' },
    ] });
    expect(verified.has('m_a\u0000p_a')).toBe(false);
    expect(verified.has('m_b\u0000p_b')).toBe(false);
    expect(verified.get('m_c\u0000p_c').get('v1').amount).toBe(7);
  });

  test('bounded to a fixed number of listings', async () => {
    const { query, calls } = queryReturning([]);
    const listings = Array.from({ length: MAX_VERIFIED_SELLER_LISTINGS + 5 }, (_, i) => ({ merchant_id: `m${i}`, product_id: `p${i}` }));
    await readCanonicalSellerOffersMoney({ query, listings });
    expect(calls[0].params[0]).toHaveLength(MAX_VERIFIED_SELLER_LISTINGS);
  });
});

function money(entries) {
  return new Map(entries.map(([id, amount]) => [id, { amount, currency: 'USD', minor: Math.round(amount * 100) }]));
}

function offersData() {
  return {
    offers: [
      { offer_id: 'own', merchant_id: REF.merchant_id, product_id: REF.product_id, price: { amount: 19.95, currency: 'USD' } },
      { offer_id: 'seller_b', merchant_id: 'm_b', product_id: 'p_b', selected_variant_id: 'b1',
        price: { amount: 99, currency: 'USD' }, inventory: { in_stock: true, available_quantity: 4 },
        variants: [
          { variant_id: 'b1', options: [{ name: 'Size', value: '50ml' }], price: { current: { amount: 99, currency: 'USD' } } },
          { variant_id: 'b2', options: [{ name: 'Size', value: '100ml' }], price: { current: { amount: 120, currency: 'USD' } } },
        ] },
      { offer_id: 'seller_c', merchant_id: 'm_c', product_id: 'p_c', price: { amount: 8, currency: 'USD' },
        inventory: { in_stock: true } },
    ],
    default_offer_id: 'own',
  };
}

describe('projectSellerOffersMoney', () => {
  test('a verified seller is re-priced from the current read; the cached price never survives', () => {
    const verified = new Map([['m_b\u0000p_b', money([['b1', 21.5], ['b2', 30]])]]);
    const { data, verifiedOffers } = projectSellerOffersMoney(offersData(), REF, verified);
    const b = data.offers.find(o => o.offer_id === 'seller_b');
    expect(b.price).toEqual({ amount: 21.5, currency: 'USD' });
    expect(b.price_verification).toBe('verified');
    expect(b.variants.map(v => v.price.current.amount)).toEqual([21.5, 30]);
    expect(verifiedOffers).toEqual([
      { offer_id: 'seller_b', merchant_id: 'm_b', product_id: 'p_b', variant_id: 'b1', amount: 21.5, currency: 'USD' },
      { offer_id: 'seller_b', merchant_id: 'm_b', product_id: 'p_b', variant_id: 'b2', amount: 30, currency: 'USD' },
    ]);
  });

  test('an unverifiable seller keeps its listing but loses its money and cannot be bought', () => {
    const { data, verifiedOffers } = projectSellerOffersMoney(offersData(), REF, new Map());
    const c = data.offers.find(o => o.offer_id === 'seller_c');
    expect(c.price).toBeUndefined();
    expect(c.price_verification).toBe('unverified');
    expect(c.current_own_offer_status).toBe('unavailable');
    expect(c.inventory.in_stock).toBe(false);
    const b = data.offers.find(o => o.offer_id === 'seller_b');
    expect(b.variants.every(v => !v.price)).toBe(true);
    expect(verifiedOffers).toEqual([]);
    // Only the selected listing (already projected) keeps money, so it is the only best-price candidate.
    expect(data.best_price_offer_id).toBe('own');
  });

  test('a variant the read did not verify is withheld while its verified siblings stay buyable', () => {
    const verified = new Map([['m_b\u0000p_b', money([['b1', 21.5]])]]);
    const { data, verifiedOffers } = projectSellerOffersMoney(offersData(), REF, verified);
    const b = data.offers.find(o => o.offer_id === 'seller_b');
    expect(b.variants[0].price.current.amount).toBe(21.5);
    expect(b.variants[1].price).toBeUndefined();
    expect(b.variants[1].current_own_offer_status).toBe('unavailable');
    expect(verifiedOffers.map(entry => entry.variant_id)).toEqual(['b1']);
  });

  test('the selected listing is left to its own projection', () => {
    const { data } = projectSellerOffersMoney(offersData(), REF, new Map());
    expect(data.offers.find(o => o.offer_id === 'own').price).toEqual({ amount: 19.95, currency: 'USD' });
  });
});

describe('bindVerifiedSellerOffers', () => {
  function responseWith(offers) {
    return { modules: [{ type: 'offers', data: { offers } }] };
  }
  const entry = { offer_id: 'seller_c', merchant_id: 'm_c', product_id: 'p_c', variant_id: 'p_c', amount: 8, currency: 'USD' };
  const served = { offer_id: 'seller_c', merchant_id: 'm_c', product_id: 'p_c', price_verification: 'verified', price: { amount: 8, currency: 'USD' } };

  test('certifies an entry only when the served offer shows exactly that money', () => {
    expect(bindVerifiedSellerOffers(responseWith([served]), REF, [entry])).toEqual([entry]);
    expect(bindVerifiedSellerOffers(responseWith([{ ...served, price: { amount: 8.01, currency: 'USD' } }]), REF, [entry])).toEqual([]);
    expect(bindVerifiedSellerOffers(responseWith([{ ...served, price_verification: 'unverified' }]), REF, [entry])).toEqual([]);
    expect(bindVerifiedSellerOffers(responseWith([served, served]), REF, [entry])).toEqual([]);
    expect(bindVerifiedSellerOffers(responseWith([]), REF, [entry])).toEqual([]);
  });

  test('never certifies the selected listing (its proof is verified_variants)', () => {
    const own = { ...entry, merchant_id: REF.merchant_id, product_id: REF.product_id };
    expect(bindVerifiedSellerOffers(responseWith([{ ...served, merchant_id: REF.merchant_id, product_id: REF.product_id }]), REF, [own])).toEqual([]);
  });
});

describe('withoutCanonicalPurchaseActions', () => {
  test('removes only add_to_cart and buy_now from the canonical payload', () => {
    const response = { modules: [
      { type: 'canonical', data: { pdp_payload: { actions: [
        { action_type: 'add_to_cart', target: {} }, { action_type: 'buy_now', target: {} }, { action_type: 'share' },
      ], product: { title: 'Full Cream' } } } },
      { type: 'offers', data: { offers: [{ offer_id: 'x' }] } },
    ] };
    const next = withoutCanonicalPurchaseActions(response);
    expect(next.modules[0].data.pdp_payload.actions).toEqual([{ action_type: 'share' }]);
    expect(next.modules[0].data.pdp_payload.product.title).toBe('Full Cream');
    expect(next.modules[1]).toBe(response.modules[1]);
  });
});
