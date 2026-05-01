const { auditMismatch } = require('../../scripts/audit-live-offer-currency-mismatch.cjs');

describe('audit-live-offer-currency-mismatch', () => {
  test('flags merchant offers whose currency differs from the expected market currency', () => {
    const result = auditMismatch(
      {
        current_build_id: 'build_1',
        targets: [
          {
            key: 'dynasty',
            product_id: 'ext_1',
            page: 'https://agent.pivota.cc/products/ext_1',
            offers: [
              { merchant_name: 'Beauty of Joseon', price_amount: 15, currency: 'USD' },
            ],
          },
          {
            key: 'glow_deep',
            product_id: 'ext_2',
            page: 'https://agent.pivota.cc/products/ext_2',
            offers: [
              { merchant_name: 'Beauty of Joseon', price_amount: 17, currency: 'EUR' },
              { merchant_name: 'Ohlolly', price_amount: 12.99, currency: 'USD' },
            ],
          },
        ],
      },
      { expectedCurrency: 'USD', merchantName: 'Beauty of Joseon' },
    );

    expect(result.target_count).toBe(2);
    expect(result.mismatch_count).toBe(1);
    expect(result.mismatches[0].product_id).toBe('ext_2');
    expect(result.mismatches[0].offending_offers[0].currency).toBe('EUR');
  });
});
