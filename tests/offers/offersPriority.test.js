const {
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
  });
});

