const fs = require('node:fs');
const path = require('node:path');

const { inferMerchantIdFromProductId } = require('../src/productIntelResolve');

// ADR-009. This function was the LAST surviving sentinel MINTER: it took
// PRODUCT info (an id prefix) and returned MERCHANT info. It is now retired,
// and the reason retiring it took a route change is worth keeping written
// down, because "just return empty" was tried first and was a live regression:
//
//   the id it returned was not decoration — it was a ROUTING TOKEN.
//   resolveProductIntelInvokeContext built a canonical ref from it and passed
//   that ref to fetchProductDetailForOffers, whose seed branch routes to
//   fetchExternalSeedProductDetailFromDb — a lookup keyed on productId ALONE.
//   With the mint gone and nothing replacing it, a {product_id:'ext_...'}-only
//   caller lost its ref entirely and got 400 MISSING_PARAMETERS instead of the
//   200 it had always had.
//
// What replaced it (src/server.js): fetchProductDetailForOffers admits a
// seller-less call for a seed-shaped id, resolveProductIntelInvokeContext
// builds a ref with no merchant_id for one, the 400 guard exempts exactly that
// shape, and the seller is filled in afterwards from the RESOLVED ROW. The
// route behaviour is pinned end to end in
// tests/integration/invoke.product_intel_seed_routed_seller_less.test.js and
// tests/external_seed_seller_less_detail_route.test.js; this file pins that the
// derivation itself is gone and stays gone.
describe('product intel resolve helpers', () => {
  test('the sentinel-literal ratchet cannot see this file — it matches comparisons, not returns', () => {
    // The ratchet's patterns are all `=== EXTERNAL_SEED_MERCHANT_ID`,
    // `merchant_id = 'external_seed'`, `merchantId: EXTERNAL_SEED_MERCHANT_ID`
    // and friends. A bare `return <the sentinel constant>` matched none of
    // them, so neither minter ever appeared in the baseline and the ratchet
    // going to zero would NOT mean the sentinel had stopped being produced.
    // Pinned here so that gap stays a documented fact rather than a surprise —
    // it is why the writer side needs the assertions below and not the ratchet.
    const baseline = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, 'fixtures/external_seed_merchant_literal_baseline.json'),
        'utf8',
      ),
    );
    expect(baseline['src/productIntelResolve.js']).toBeUndefined();
    expect(baseline['src/pdpConfig.js']).toBeUndefined();
  });

  test('no seller is derived from any product id, seed-shaped or not', () => {
    // The two seed shapes the retired branch matched…
    expect(inferMerchantIdFromProductId('ext_f326aabff0f8a4a698aa192c')).toBe('');
    expect(inferMerchantIdFromProductId('EXT_SAMPLE_1')).toBe('');
    // …and the shapes it never matched, unchanged.
    expect(inferMerchantIdFromProductId('9886500749640')).toBe('');
    expect(inferMerchantIdFromProductId('')).toBe('');
    expect(inferMerchantIdFromProductId(null)).toBe('');
  });

  test('the module cannot produce a seller at all: it holds no merchant vocabulary', () => {
    // The assertion above is satisfied by a function that still KNOWS the
    // sentinel and merely stopped returning it on those five inputs. This one
    // is not: the source no longer imports or names any merchant id, so there
    // is nothing left for a future edit to re-enable behind an input this test
    // does not happen to try.
    const src = fs.readFileSync(path.join(__dirname, '../src/productIntelResolve.js'), 'utf8');
    expect(src).not.toMatch(/EXTERNAL_SEED_MERCHANT_ID/);
    expect(src).not.toMatch(/require\(/);
    // …and it no longer reads the product id it is handed.
    expect(inferMerchantIdFromProductId.length).toBe(0);
  });
});
