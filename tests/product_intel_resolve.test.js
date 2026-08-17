const fs = require('node:fs');
const path = require('node:path');

const { inferMerchantIdFromProductId } = require('../src/productIntelResolve');

// ADR-009. This function is the LAST surviving sentinel MINTER: it takes
// PRODUCT info (an id prefix) and returns MERCHANT info. Its twin,
// pdpConfig.inferCanonicalPdpMerchantId, was deleted as dead code — this one is
// NOT dead, and the reason is subtle enough to write down:
//
//   resolveProductIntelInvokeContext (server.js ~36974) mints the sentinel here,
//   builds a canonical ref from it (~37099), and passes it to
//   fetchProductDetailForOffers, whose isExternalSeedListingMerchantId branch
//   (~9041) routes to fetchExternalSeedProductDetailFromDb — a lookup keyed on
//   productId ALONE. So the sentinel is a ROUTING TOKEN, not a seller. Making
//   this return '' turns a working 200 into 400 MISSING_PARAMETERS for a
//   {product_id:'ext_...'}-only caller (the ref is never built).
//
// Retiring it therefore means replacing the MECHANISM — letting that route
// reach the seed store without a merchant — not editing this function.
describe('product intel resolve helpers', () => {
  test('the sentinel-literal ratchet cannot see this minter — it matches comparisons, not returns', () => {
    // The ratchet's patterns are all `=== EXTERNAL_SEED_MERCHANT_ID`,
    // `merchant_id = 'external_seed'`, `merchantId: EXTERNAL_SEED_MERCHANT_ID`
    // and friends. A bare `return EXTERNAL_SEED_MERCHANT_ID` matches none of
    // them, so neither minter has ever appeared in the baseline and the ratchet
    // going to zero would NOT mean the sentinel had stopped being produced.
    // Pinned here so that gap is a documented fact rather than a surprise.
    const baseline = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, 'fixtures/external_seed_merchant_literal_baseline.json'),
        'utf8',
      ),
    );
    expect(baseline['src/productIntelResolve.js']).toBeUndefined();
    expect(baseline['src/pdpConfig.js']).toBeUndefined();
    // ...and this file really does still mint it.
    const src = fs.readFileSync(
      path.join(__dirname, '../src/productIntelResolve.js'),
      'utf8',
    );
    expect(src).toMatch(/return EXTERNAL_SEED_MERCHANT_ID;/);
  });

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
