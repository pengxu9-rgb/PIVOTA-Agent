const {
  getResolveProductCandidatesCacheEntry,
  setResolveProductCandidatesCache,
  snapshotResolveProductCandidatesCacheStats,
  getResolveProductGroupCacheEntry,
  setResolveProductGroupCache,
  snapshotResolveProductGroupCacheStats,
  resetPdpHotCachesForTest,
} = require('../../src/commerce/pdp/hotCaches');

describe('pdp hot caches', () => {
  beforeEach(() => {
    resetPdpHotCachesForTest();
  });

  test('stores and reads resolve_product_candidates cache entries', () => {
    expect(getResolveProductCandidatesCacheEntry('missing')).toBeNull();

    setResolveProductCandidatesCache('candidate-key', {
      status: 'success',
      offers_count: 1,
    });

    const entry = getResolveProductCandidatesCacheEntry('candidate-key');
    expect(entry?.value).toEqual({
      status: 'success',
      offers_count: 1,
    });
    expect(snapshotResolveProductCandidatesCacheStats()).toMatchObject({
      size: 1,
      hits: 1,
      misses: 1,
      sets: 1,
    });
  });

  test('stores cloned resolve_product_group cache entries', () => {
    const original = {
      status: 'success',
      members: [{ merchant_id: 'm1', product_id: 'p1' }],
    };
    setResolveProductGroupCache('group-key', original);
    original.members[0].product_id = 'mutated';

    const entry = getResolveProductGroupCacheEntry('group-key');
    expect(entry?.value).toEqual({
      status: 'success',
      members: [{ merchant_id: 'm1', product_id: 'p1' }],
    });
    expect(snapshotResolveProductGroupCacheStats()).toMatchObject({
      size: 1,
      hits: 1,
      sets: 1,
    });
  });
});
