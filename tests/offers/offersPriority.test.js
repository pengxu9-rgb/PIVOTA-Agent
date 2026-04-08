const {
  annotateOffersWithCommerceMetadata,
  prioritizeOffers,
  prioritizeOffersResolveResponse,
} = require('../../src/offers/offersPriority');

describe('offers priority', () => {
  test('prioritizeOffers: internal > external > generic', () => {
    const offers = [
      { purchase_route: 'affiliate_outbound', affiliate_url: 'https://example.com/a' },
      { url: 'https://example.com/misc' },
      { purchase_route: 'internal_checkout', checkout_url: 'https://example.com/checkout' },
      { purchase_route: 'affiliate_outbound', affiliate_url: 'https://example.com/b' },
    ];

    const out = prioritizeOffers(offers);
    expect(out[0].purchase_route).toBe('internal_checkout');
    expect(out[1].purchase_route).toBe('affiliate_outbound');
    expect(out[2].purchase_route).toBe('affiliate_outbound');
    expect(out[3].url).toBe('https://example.com/misc');
  });

  test('prioritizeOffersResolveResponse: sorts top-level offers', () => {
    const input = {
      ok: true,
      offers: [
        { purchase_route: 'affiliate_outbound', affiliate_url: 'https://example.com/a' },
        { purchase_route: 'internal_checkout', checkout_url: 'https://example.com/checkout' },
      ],
    };
    const out = prioritizeOffersResolveResponse(input);
    expect(out).not.toBe(input);
    expect(out.offers[0].purchase_route).toBe('internal_checkout');
    expect(out.offers[0].commerce_mode).toBe('merchant_embedded_checkout');
    expect(out.offers[0].order_system_of_record).toBe('merchant_store_platform');
    expect(out.metadata.commerce_modes).toEqual(['merchant_embedded_checkout', 'links_out']);
  });

  test('prioritizeOffersResolveResponse: sorts nested data.offers', () => {
    const input = {
      status: 'success',
      data: {
        offers: [
          { purchase_route: 'affiliate_outbound', affiliate_url: 'https://example.com/a' },
          { purchase_route: 'internal_checkout', checkout_url: 'https://example.com/checkout' },
        ],
      },
    };
    const out = prioritizeOffersResolveResponse(input);
    expect(out).not.toBe(input);
    expect(out.data.offers[0].purchase_route).toBe('internal_checkout');
    expect(out.data.offers[0].checkout_handoff).toBe('embedded');
    expect(out.metadata.seller_of_record).toBe('merchant');
  });

  test('annotateOffersWithCommerceMetadata: keeps links-out and merchant-embedded semantics distinct', () => {
    const [embedded, outbound] = annotateOffersWithCommerceMetadata([
      {
        purchase_route: 'internal_checkout',
        internal_checkout: { session_id: 'sess_1' },
      },
      {
        purchase_route: 'affiliate_outbound',
        affiliate_url: 'https://merchant.example.com/p/1',
      },
    ]);

    expect(embedded.commerce_mode).toBe('merchant_embedded_checkout');
    expect(embedded.checkout_handoff).toBe('embedded');
    expect(embedded.payment_processor_owner).toBe('merchant');
    expect(embedded.order_writeback_mode).toBe('merchant_direct');
    expect(embedded.merchant_checkout_session).toEqual({ session_id: 'sess_1' });

    expect(outbound.commerce_mode).toBe('links_out');
    expect(outbound.checkout_handoff).toBe('redirect');
    expect(outbound.merchant_checkout_url).toBe('https://merchant.example.com/p/1');
  });
});
