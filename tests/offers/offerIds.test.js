const {
  buildProductGroupId,
  buildOfferId,
  extractMerchantIdFromOfferId,
} = require('../../src/offers/offerIds');

describe('offer id helpers', () => {
  test('buildProductGroupId prefers platform refs', () => {
    expect(
      buildProductGroupId({ platform: 'mock', platform_product_id: 'BOTTLE_001' }),
    ).toBe('pg:mock:BOTTLE_001');
  });

  test('buildProductGroupId falls back to merchant:product', () => {
    expect(buildProductGroupId({ merchant_id: 'm1', product_id: 'p1' })).toBe('pg:m1:p1');
  });

  test('buildOfferId is deterministic and parseable', () => {
    const productGroupId = 'pg:mock:BOTTLE_001';
    const offerId = buildOfferId({
      merchant_id: 'merch_demo_fast_premium',
      product_group_id: productGroupId,
      fulfillment_type: 'merchant',
      tier: 'fast_premium',
    });
    expect(offerId).toBe(
      'of:v1:merch_demo_fast_premium:pg:mock:BOTTLE_001:merchant:fast_premium',
    );
    expect(extractMerchantIdFromOfferId(offerId)).toBe('merch_demo_fast_premium');
  });

  test('extractMerchantIdFromOfferId works when product_group_id contains colons', () => {
    const offerId = 'of:v1:mid:pg:foo:bar:baz:merchant:default';
    expect(extractMerchantIdFromOfferId(offerId)).toBe('mid');
  });
});

