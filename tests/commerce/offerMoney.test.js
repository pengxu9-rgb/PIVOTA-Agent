const { normalizeOfferMoney } = require('../../src/commerce/pdp/offerMoney');

describe('normalizeOfferMoney', () => {
  test('normalizes numeric and string money inputs', () => {
    expect(normalizeOfferMoney(12.5, 'usd')).toEqual({
      amount: 12.5,
      currency: 'USD',
    });
    expect(normalizeOfferMoney('19.99', 'eur')).toEqual({
      amount: 19.99,
      currency: 'EUR',
    });
  });

  test('normalizes nested money object inputs', () => {
    expect(
      normalizeOfferMoney(
        {
          current: {
            amount: '25.4',
            currency: 'gbp',
          },
        },
        'usd',
      ),
    ).toEqual({
      amount: 25.4,
      currency: 'GBP',
    });
  });
});
