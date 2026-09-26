const {
  SAFE_ORIGINAL_IMAGE_HOSTS,
  shouldCacheOriginalImageUrl,
} = require('../../src/services/externalSeedImageCache');

// This list is an ADD-ONLY allowlist during the Railway -> Cloud Run migration. Both the Railway
// hosts and the Pivota-owned names are live, and image URLs already persisted carry whichever host
// was current when the row was written. Dropping an entry does not raise - the URL is simply treated
// as a third-party original and re-fetched, so the failure is a silently blank image.
//
// Every entry is pinned individually on purpose: before this test, deleting any of the four
// host entries passed the entire suite, so the "keep the old hosts" property was enforced by a
// code comment and nothing else.
describe('SAFE_ORIGINAL_IMAGE_HOSTS is add-only', () => {
  const REQUIRED = [
    'cdn.shopify.com',
    'shopifycdn.com',
    'images.unsplash.com',
    // Railway hosts: still serving, and still present in persisted rows.
    'web-production-fedb.up.railway.app',
    'pivota-agent-production.up.railway.app',
    // Pivota-owned names: what new rows carry.
    'api.pivota.cc',
    'gateway.pivota.cc',
    'agent.pivota.cc',
  ];

  for (const host of REQUIRED) {
    it(`still lists ${host}`, () => {
      expect(SAFE_ORIGINAL_IMAGE_HOSTS).toContain(host);
    });
  }

  it('treats an already-proxied Pivota URL as not-to-be-recached', () => {
    for (const host of ['gateway.pivota.cc', 'api.pivota.cc', 'agent.pivota.cc',
                        'pivota-agent-production.up.railway.app']) {
      expect(shouldCacheOriginalImageUrl(`https://${host}/catalog-image-cache/abc123`)).toBe(false);
    }
  });

  // Note the polarity: a host ON this list is one we can serve directly, so it is NOT re-cached.
  // A genuine third-party original is one absent from the list.
  it('still caches a genuine third-party original', () => {
    expect(shouldCacheOriginalImageUrl('https://www.guerlain.com/media/img.jpg')).toBe(true);
  });
});
