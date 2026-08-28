// A catalog image URL cached before a host migration keeps the origin that was current when it
// was written. Prod recommendation rows still name the decommissioned Railway host and 404, while
// the identical object answers 200 at the configured base (verified live 2026-08-28: the same
// /catalog-image-cache/<key> path is 404 on pivota-agent-production.up.railway.app and
// 200 image/webp on gateway.pivota.cc). The key is a content digest, so only the origin is wrong.
//
// These tests pin the re-homing itself AND the boundary that keeps it safe: a value that is not
// one of our cache keys must come back byte-identical, so we can never rewrite an image we do not
// host onto our own origin.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCatalogImageCacheUrlHost,
} = require('../src/services/catalogImageCacheStorage');

const KEY = 'catalog-image-cache/24/24393a70120c64dd946af8971252d97c796050a390b7ef5cb67ccfb29626eb4e.webp';
const DEAD = `https://pivota-agent-production.up.railway.app/${KEY}`;

function withEnv(vars, run) {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return run();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Prod's ACTUAL shape, read off the serving Cloud Run revision. CATALOG_IMAGE_CACHE_PUBLIC_BASE_URL
// matters and must not be omitted: it ends in .r2.dev, which makes shouldUseCatalogImageCacheRuntimeProxy
// return true, which changes what buildCatalogImageCacheVisibleUrl does. A fixture missing it can
// make a composed call site look load-bearing when in prod it is already a no-op.
const PROD_ENV = {
  CATALOG_IMAGE_CACHE_PROXY_PUBLIC_BASE_URL: 'https://gateway.pivota.cc',
  CATALOG_IMAGE_CACHE_RUNTIME_PUBLIC_BASE_URL: undefined,
  PIVOTA_AGENT_PUBLIC_BASE_URL: undefined,
  CATALOG_IMAGE_CACHE_PUBLIC_BASE_URL: 'https://pub-bf93709fb9444fcf803a6606a48e2682.r2.dev',
  CATALOG_IMAGE_CACHE_DISABLE_RUNTIME_PROXY: undefined,
};

test('re-homes a stale-host catalog image URL onto the configured base', () => {
  withEnv(PROD_ENV, () => {
    assert.equal(
      normalizeCatalogImageCacheUrlHost(DEAD),
      `https://gateway.pivota.cc/${KEY}`,
      'a dead-host cache URL must be re-homed onto the configured base',
    );
  });
});

test('leaves a URL already on the configured base byte-identical', () => {
  withEnv(PROD_ENV, () => {
    const good = `https://gateway.pivota.cc/${KEY}`;
    assert.equal(normalizeCatalogImageCacheUrlHost(good), good);
  });
});

test('never rewrites an image we do not host', () => {
  withEnv(PROD_ENV, () => {
    // A merchant CDN image: same file extension, but its path is not a cache key. Rewriting this
    // would point a real product photo at an origin that has never stored it.
    const merchant =
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-SP-LIQUID-BLUSH-MATTE-BLISS.jpg?v=1';
    assert.equal(normalizeCatalogImageCacheUrlHost(merchant), merchant);

    // Digest-shaped but NOT under the cache prefix — still not ours.
    const lookalike = `https://evil.example/uploads/24/24393a70120c64dd946af8971252d97c796050a390b7ef5cb67ccfb29626eb4e.webp`;
    assert.equal(normalizeCatalogImageCacheUrlHost(lookalike), lookalike);
  });
});

test('passes through empty and non-string values unchanged', () => {
  withEnv(PROD_ENV, () => {
    assert.equal(normalizeCatalogImageCacheUrlHost(''), '');
    assert.equal(normalizeCatalogImageCacheUrlHost(null), '');
    assert.equal(normalizeCatalogImageCacheUrlHost(undefined), '');
  });
});

test('a malformed configured base must not mangle a URL that is currently serving', () => {
  withEnv({ ...PROD_ENV, CATALOG_IMAGE_CACHE_PROXY_PUBLIC_BASE_URL: 'not-a-url' }, () => {
    assert.equal(
      normalizeCatalogImageCacheUrlHost(DEAD),
      DEAD,
      'with an unusable base, return the input rather than minting a broken origin',
    );
  });
});

test('falls back through the documented base precedence', () => {
  withEnv(
    {
      CATALOG_IMAGE_CACHE_PROXY_PUBLIC_BASE_URL: undefined,
      CATALOG_IMAGE_CACHE_RUNTIME_PUBLIC_BASE_URL: undefined,
      PIVOTA_AGENT_PUBLIC_BASE_URL: 'https://agent.example.test',
    },
    () => {
      assert.equal(
        normalizeCatalogImageCacheUrlHost(DEAD),
        `https://agent.example.test/${KEY}`,
      );
    },
  );
});

test('trailing slashes on the base do not produce a doubled slash', () => {
  withEnv({ ...PROD_ENV, CATALOG_IMAGE_CACHE_PROXY_PUBLIC_BASE_URL: 'https://gateway.pivota.cc///' }, () => {
    assert.equal(normalizeCatalogImageCacheUrlHost(DEAD), `https://gateway.pivota.cc/${KEY}`);
  });
});

// THE DELIVERING PATH. The helper being correct proves nothing if the recommendation lane never
// calls it — reverting the call site is the single edit that makes this whole change a no-op, so
// it has to be what fails here. firstImageUrl is the one helper every recommendation image
// resolves through, exercised via the module's own `_internals` test seam rather than a
// re-implementation of it.
const { _internals } = require('../src/services/RecommendationEngine');

test('the recommendation lane re-homes a stale-host image (delivery path)', () => {
  withEnv(PROD_ENV, () => {
    assert.equal(
      typeof _internals.firstImageUrl,
      'function',
      'firstImageUrl must stay exposed for this pin',
    );
    // As a bare string, the shape stored in row.image_url.
    assert.equal(
      _internals.firstImageUrl(DEAD),
      `https://gateway.pivota.cc/${KEY}`,
    );
    // And through the object branch (snapshot/seed objects carry {url|image_url|src}).
    assert.equal(
      _internals.firstImageUrl(null, '', { image_url: DEAD }),
      `https://gateway.pivota.cc/${KEY}`,
    );
    // Fallback order is preserved: the first non-empty value still wins, re-homed.
    assert.equal(
      _internals.firstImageUrl(undefined, DEAD, 'https://cdn.shopify.com/s/files/other.jpg'),
      `https://gateway.pivota.cc/${KEY}`,
    );
  });
});

// The external-seed lane is what actually serves the home feed ("Today's Picks") and the search
// cards — measured 2026-08-28: 3 of 5 home images were dead Railway URLs. Its cache-map lookup
// falls back to the RAW stored value on a miss, which is how a retired host reaches the first
// screen, so the re-homing has to be pinned here too and not only on the recommendation lane.
const seedLane = require('../src/services/externalSeedProducts');

test('the external-seed lane re-homes a stale-host image (home feed + search cards)', () => {
  withEnv(PROD_ENV, () => {
    assert.equal(
      seedLane.normalizeCatalogImageCacheVisibleUrl(DEAD),
      `https://gateway.pivota.cc/${KEY}`,
    );
    // Cache-map MISS: an empty map is the path that previously returned the raw stored URL.
    assert.equal(
      seedLane.rewriteSeedImageUrlThroughCache(DEAD, new Map(), ''),
      `https://gateway.pivota.cc/${KEY}`,
    );
  });
});

// The cache-map-HIT branch: a non-empty map, a cache-URL fallback and a non-cache candidate. This
// is the branch normalizeVariantVisualFields actually drives, and an earlier cut of this suite
// only ever passed an empty Map, so reverting that return survived silently.
test('the external-seed lane re-homes the cache-map fallback branch', () => {
  withEnv(PROD_ENV, () => {
    const map = new Map([['https://example.test/original.jpg', DEAD]]);
    assert.equal(
      seedLane.rewriteSeedImageUrlThroughCache(
        'https://cdn.shopify.com/s/files/direct.jpg',
        map,
        DEAD,
      ),
      `https://gateway.pivota.cc/${KEY}`,
    );
  });
});

// The documented rollback lever. Re-homing onto the proxy while it is disabled would silently
// defeat the one env var that takes traffic off the gateway proxy during an outage.
test('the disable-runtime-proxy kill switch suppresses re-homing', () => {
  withEnv({ ...PROD_ENV, CATALOG_IMAGE_CACHE_DISABLE_RUNTIME_PROXY: 'true' }, () => {
    assert.equal(normalizeCatalogImageCacheUrlHost(DEAD), DEAD);
    assert.equal(seedLane.rewriteSeedImageUrlThroughCache(DEAD, new Map(), ''), DEAD);
  });
});

// R2 keys are case-sensitive and we only ever mint lower-case, so an upper-case variant of our
// path shape belongs to somebody else and must not be re-homed onto our origin.
test('an upper-case key variant is not ours and is left alone', () => {
  withEnv(PROD_ENV, () => {
    const upper = `https://other.example/catalog-image-cache/24/${'24393A70120C64DD946AF8971252D97C796050A390B7EF5CB67CCFB29626EB4E'}.WEBP`;
    assert.equal(normalizeCatalogImageCacheUrlHost(upper), upper);
  });
});

// Makes the origin short-circuit non-vacuous: without it, a same-origin URL would be re-minted
// from the key and silently lose its query string.
test('a query string on an already-correct URL survives', () => {
  withEnv(PROD_ENV, () => {
    const withQuery = `https://gateway.pivota.cc/${KEY}?w=200`;
    assert.equal(normalizeCatalogImageCacheUrlHost(withQuery), withQuery);
  });
});

test('the external-seed lane leaves merchant CDN images untouched', () => {
  withEnv(PROD_ENV, () => {
    const merchant = 'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/BOX.jpg?v=1762289029';
    assert.equal(seedLane.normalizeCatalogImageCacheVisibleUrl(merchant), merchant);
    assert.equal(seedLane.rewriteSeedImageUrlThroughCache(merchant, new Map(), ''), merchant);
  });
});

test('the recommendation lane leaves merchant CDN images untouched', () => {
  withEnv(PROD_ENV, () => {
    const merchant = 'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/BLUSH.jpg?v=1';
    assert.equal(_internals.firstImageUrl(merchant), merchant);
    assert.equal(_internals.firstImageUrl({ url: merchant }), merchant);
    assert.equal(_internals.firstImageUrl(), '');
  });
});
