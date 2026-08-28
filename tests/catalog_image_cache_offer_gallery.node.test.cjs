// preferReliableOfferImageUrls HOISTS catalog-image-cache URLs ahead of working merchant CDN URLs,
// so an image cached under a retired host is not merely present in the offer/PDP gallery — it is
// promoted into the hero slot, displacing a photo that loads. That makes this the highest-impact
// place for the stale host to survive, and the ordering is exactly what a route test cannot see:
// a re-homed hero and a dead one are both just an array of strings over the wire.
//
// server.js guards app.listen behind `require.main === module`, so requiring it here starts no
// listener; the function is reached through the module's existing `_debug` seam.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const KEY = 'catalog-image-cache/24/24393a70120c64dd946af8971252d97c796050a390b7ef5cb67ccfb29626eb4e.webp';
const DEAD = `https://pivota-agent-production.up.railway.app/${KEY}`;
const LIVE = `https://gateway.pivota.cc/${KEY}`;
const MERCHANT = 'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/HERO.jpg?v=1';

const saved = {
  CATALOG_IMAGE_CACHE_PROXY_PUBLIC_BASE_URL: process.env.CATALOG_IMAGE_CACHE_PROXY_PUBLIC_BASE_URL,
  CATALOG_IMAGE_CACHE_PUBLIC_BASE_URL: process.env.CATALOG_IMAGE_CACHE_PUBLIC_BASE_URL,
};
// Prod's actual shape, set BEFORE requiring server.js.
process.env.CATALOG_IMAGE_CACHE_PROXY_PUBLIC_BASE_URL = 'https://gateway.pivota.cc';
process.env.CATALOG_IMAGE_CACHE_PUBLIC_BASE_URL =
  'https://pub-bf93709fb9444fcf803a6606a48e2682.r2.dev';

const { _debug } = require('../src/server');

test.after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('the promoted hero image is re-homed, not the dead host', () => {
  const out = _debug.preferReliableOfferImageUrls([MERCHANT, DEAD]);
  // The cache URL is still hoisted first (behaviour preserved) — but it now serves.
  assert.equal(out[0], LIVE, 'hero slot must be the re-homed cache URL');
  assert.ok(!out.some((u) => u.includes('railway.app')), 'no dead host may survive in the gallery');
  assert.ok(out.includes(MERCHANT), 'the direct merchant image must still be present');
});

test('a gallery with no cache urls is returned untouched', () => {
  const direct = ['https://cdn.shopify.com/a.jpg', 'https://cdn.shopify.com/b.jpg'];
  assert.deepEqual(_debug.preferReliableOfferImageUrls(direct), direct);
});

test('an already-correct cache url keeps its place and its origin', () => {
  const out = _debug.preferReliableOfferImageUrls([MERCHANT, LIVE]);
  assert.equal(out[0], LIVE);
  assert.ok(out.includes(MERCHANT));
});
