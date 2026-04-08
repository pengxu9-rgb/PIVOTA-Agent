const { inferMerchantIdFromProductId } = require('../src/productIntelResolve');

describe('product intel resolve helpers', () => {
  test('infers external seed merchant id from ext_ product ids', () => {
    expect(inferMerchantIdFromProductId('ext_f326aabff0f8a4a698aa192c')).toBe('external_seed');
    expect(inferMerchantIdFromProductId('EXT_SAMPLE_1')).toBe('external_seed');
  });

  test('returns empty string for non-external product ids', () => {
    expect(inferMerchantIdFromProductId('9886500749640')).toBe('');
    expect(inferMerchantIdFromProductId('')).toBe('');
    expect(inferMerchantIdFromProductId(null)).toBe('');
  });
});
