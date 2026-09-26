// ADR-009 — discoveryFeed's seed-supply readers follow the seller LANE.
//
// Three readers asked "is this seller external-seed supply?" as an equality
// against the retired sentinel. The A9-4 re-key moved that supply onto
// per-brand observed sellers (merch_obs_…), so all three silently flipped:
// brand-scoped feeds stopped collapsing crawl duplicates, taxonomy
// re-inference stopped being forced, and the cold-start scorer stopped
// recognising seed supply — including a 4x brand cap on the live home feed.
//
// Each test below fails if its site reverts to the sentinel-only equality.

const { _internals } = require('../../src/services/discoveryFeed');

const SENTINEL = 'external_seed';
const OBSERVED = 'merch_obs_022b65d47a58b87a';
const CONNECTED = 'merch_live_acme';

describe('discoveryFeed seed-supply readers', () => {
  describe('isExternalSeedMerchantCandidate', () => {
    test('admits the observed seller the re-key created', () => {
      expect(_internals.isExternalSeedMerchantCandidate({ merchantId: OBSERVED })).toBe(true);
    });
    test('PRESERVATION: still admits the retired sentinel', () => {
      expect(_internals.isExternalSeedMerchantCandidate({ merchantId: SENTINEL })).toBe(true);
    });
    test('a connected merchant is NOT seed supply', () => {
      expect(_internals.isExternalSeedMerchantCandidate({ merchantId: CONNECTED })).toBe(false);
    });
  });

  describe('cold-start home brand cap (8 for beauty seed supply, else 2)', () => {
    // The highest-risk consumer: a 4x difference in how many cards one brand
    // may occupy on the home feed.
    test('an observed-seller beauty candidate gets the widened cap', () => {
      expect(_internals.getColdStartHomeBrandCap({ merchantId: OBSERVED, domain: 'beauty' })).toBe(8);
    });
    test('PRESERVATION: the sentinel still gets it', () => {
      expect(_internals.getColdStartHomeBrandCap({ merchantId: SENTINEL, domain: 'beauty' })).toBe(8);
    });
    test('a connected merchant keeps the default cap', () => {
      expect(_internals.getColdStartHomeBrandCap({ merchantId: CONNECTED, domain: 'beauty' })).toBe(2);
    });
    test('non-beauty seed supply keeps the default cap', () => {
      expect(_internals.getColdStartHomeBrandCap({ merchantId: OBSERVED, domain: 'home' })).toBe(2);
    });
  });

  describe('brand-scoped dedupe key', () => {
    const product = {
      merchant_id: OBSERVED,
      product_id: 'ext_abc123',
      external_url: 'https://brand.example/products/serum',
      brand: 'Aurora',
      title: 'Glow Serum',
    };

    test('brand-scoped feeds use the semantic key for an observed seller', () => {
      // CONTROL first: the plain key is what a non-brand-scoped call returns,
      // so a "differs" assertion cannot pass by both being undefined.
      const plain = _internals.buildDiscoveryDedupKey(product, { brandScoped: false });
      const scoped = _internals.buildDiscoveryDedupKey(product, { brandScoped: true });
      expect(plain).toBeTruthy();
      expect(scoped).toBeTruthy();
      expect(scoped).not.toBe(plain);
    });

    test('PRESERVATION: the sentinel still gets the semantic key', () => {
      const p = { ...product, merchant_id: SENTINEL };
      expect(_internals.buildDiscoveryDedupKey(p, { brandScoped: true })).not.toBe(
        _internals.buildDiscoveryDedupKey(p, { brandScoped: false }),
      );
    });

    test('a connected merchant keeps the plain product key even brand-scoped', () => {
      const p = { ...product, merchant_id: CONNECTED };
      expect(_internals.buildDiscoveryDedupKey(p, { brandScoped: true })).toBe(
        _internals.buildDiscoveryDedupKey(p, { brandScoped: false }),
      );
    });
  });
});
