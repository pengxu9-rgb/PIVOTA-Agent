'use strict';

const {
  toVariantGid,
  resolveVariantFromSeed,
  resolveVariantViaProductsJson,
  resolveShopifyVariant,
  extractProductHandle,
  normalizeBrandOrigin,
  pickVariantFromProductNode,
  normalizeAvailability,
} = require('../src/services/shopifyVariantResolver');

// A trimmed real-shape crawled seed_data (merch_obs_ cohort, prod 2026-07-13): the Shopify variant id lives
// NESTED at seed_data.variants[i].variant_id and seed_data.snapshot.variants[i].variant_id as a bare numeric.
function seedFixture(overrides = {}) {
  return {
    brand: 'Palm of Feronia',
    title: 'The Cross Stitch Journal - Spiral',
    canonical_url: 'https://palmofferonia.com/products/the-cross-stitch-journal-spiral',
    variants: [
      {
        sku: 'SHOPIFY-56707045261692',
        variant_id: '56707045261692',
        stock: 'Out of Stock',
        option_value: 'Default Title',
      },
    ],
    snapshot: {
      title: 'The Cross Stitch Journal - Spiral',
      variants: [
        { sku: 'SHOPIFY-56707045261692', variant_id: '56707045261692', stock: 'Out of Stock' },
      ],
    },
    ...overrides,
  };
}

// A fake fetch that serves a fixed products.json map: url -> { ok, json }.
function fakeFetch(map) {
  return async (url) => {
    const entry = map[url];
    if (!entry) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => entry };
  };
}

// Same, but records the URL order so a test can assert WHICH surface was consulted first.
function recordingFetch(map) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const entry = map[url];
    if (!entry) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => entry };
  };
  impl.calls = calls;
  return impl;
}

/*
 * REAL third-party response shapes, MEASURED 2026-08-25 against all six OUTBOUND_WARM_HANDOFF_BRANDS
 * (cosrx.com, beautyofjoseon.com, skin1004.com, anua.us, medicube.us, mixsoon.us).
 *
 * The per-handle `.json` endpoint OMITS `available` on every variant on 6/6 brands. Its real variant key
 * set is reproduced below verbatim — do NOT add `available` to it to make a test pass. An earlier fixture
 * here invented that field, which is precisely why `preferAvailable: true` could ship INERT on this path:
 * the test asserted against a response Shopify does not send.
 */
function realPerHandleJsonVariant({ id, sku = null, title = 'Default Title' }) {
  return {
    barcode: '', compare_at_price: null, compare_at_price_currency: 'USD', created_at: '2024-01-01T00:00:00-05:00',
    fulfillment_service: 'manual', grams: 100, id, image_id: null, inventory_management: 'shopify',
    option1: title, option2: null, option3: null, position: 1, price: '25.00', price_currency: 'USD',
    quantity_price_breaks: [], quantity_rule: { increment: 1, min: 1, max: null }, requires_shipping: true,
    sku, taxable: true, title, updated_at: '2025-01-01T00:00:00-05:00', weight: 100, weight_unit: 'g',
    // NOTE: no `available` key. This is the whole point of the fixture.
  };
}

// The per-handle `.js` endpoint returns the product object DIRECTLY (no `product` wrapper) and DOES
// carry `available` — confirmed on 6/6 brands.
function realPerHandleJsVariant({ id, sku = null, available, title = 'Default Title' }) {
  return { id, sku, title, price: 2500, available, option1: title, requires_shipping: true };
}

describe('toVariantGid', () => {
  test('wraps a bare numeric variant id', () => {
    expect(toVariantGid('56707045261692')).toBe('gid://shopify/ProductVariant/56707045261692');
  });
  test('accepts a pre-formed GID verbatim', () => {
    expect(toVariantGid('gid://shopify/ProductVariant/999')).toBe('gid://shopify/ProductVariant/999');
  });
  test('extracts the id from a SHOPIFY-<n> sku', () => {
    expect(toVariantGid('SHOPIFY-56707045261692')).toBe('gid://shopify/ProductVariant/56707045261692');
  });
  test('rejects non-variant strings and short numerics', () => {
    expect(toVariantGid('sku_1')).toBeNull();
    expect(toVariantGid('123')).toBeNull();
    expect(toVariantGid('')).toBeNull();
    expect(toVariantGid(null)).toBeNull();
  });
});

describe('resolveVariantFromSeed (offline seed_data path)', () => {
  test('resolves the nested variant_id from seed_data.variants[0]', () => {
    const r = resolveVariantFromSeed(seedFixture());
    expect(r).not.toBeNull();
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/56707045261692');
    expect(r.source).toBe('seed_data.variants[0].variant_id');
    expect(r.sku).toBe('SHOPIFY-56707045261692');
  });

  test('falls through to seed_data.snapshot.variants when top-level variants absent', () => {
    const seed = seedFixture();
    delete seed.variants;
    const r = resolveVariantFromSeed(seed);
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/56707045261692');
    expect(r.source).toBe('seed_data.snapshot.variants[0].variant_id');
  });

  test('derives the GID from the SHOPIFY- sku when no explicit variant_id', () => {
    const seed = { variants: [{ sku: 'SHOPIFY-4242424242' }] };
    const r = resolveVariantFromSeed(seed);
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/4242424242');
  });

  test('preferAvailable picks an in-stock variant over an out-of-stock earlier one', () => {
    const seed = {
      variants: [
        { variant_id: '111111111', stock: 'Out of Stock' },
        { variant_id: '222222222', stock: 'In Stock' },
      ],
    };
    const r = resolveVariantFromSeed(seed, { preferAvailable: true });
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/222222222');
  });

  test('returns null when seed_data carries no usable variant id', () => {
    expect(resolveVariantFromSeed({ variants: [{ option_value: 'x' }] })).toBeNull();
    expect(resolveVariantFromSeed({})).toBeNull();
    expect(resolveVariantFromSeed(null)).toBeNull();
  });
});

describe('extractProductHandle / normalizeBrandOrigin', () => {
  test('extracts a handle from a storefront product URL', () => {
    expect(extractProductHandle('https://cosrx.com/products/advanced-snail-96?variant=1')).toBe('advanced-snail-96');
  });
  test('normalizes a bare host into an https origin', () => {
    expect(normalizeBrandOrigin('cosrx.com')).toBe('https://cosrx.com');
    expect(normalizeBrandOrigin('http://cosrx.com/x')).toBe('https://cosrx.com');
    expect(normalizeBrandOrigin('')).toBeNull();
  });
});

describe('resolveVariantViaProductsJson (public products.json fallback)', () => {
  test('maps a handle to a variant GID via the per-handle products.json endpoint', async () => {
    const fetchImpl = fakeFetch({
      'https://cosrx.com/products/advanced-snail-96.json': {
        product: {
          handle: 'advanced-snail-96',
          title: 'Advanced Snail 96',
          variants: [realPerHandleJsonVariant({ id: 777777777, sku: 'A1' })],
        },
      },
    });
    const r = await resolveVariantViaProductsJson(
      { brandDomain: 'cosrx.com', handle: 'advanced-snail-96' },
      { fetchImpl },
    );
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/777777777');
    expect(r.handle).toBe('advanced-snail-96');
  });

  test('maps by title through the paged listing when the per-handle endpoint misses', async () => {
    const fetchImpl = fakeFetch({
      'https://cosrx.com/products.json?limit=250&page=1': {
        products: [
          { handle: 'other', title: 'Other', variants: [{ id: 1, available: true }] },
          { handle: 'snail', title: 'Advanced Snail 96', variants: [{ id: 888888888, available: false }, { id: 999999999, available: true }] },
        ],
      },
    });
    const r = await resolveVariantViaProductsJson(
      { brandDomain: 'cosrx.com', title: 'Advanced Snail 96' },
      { fetchImpl },
    );
    // prefers the available variant
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/999999999');
  });

  test('returns null on non-200 / no match', async () => {
    const fetchImpl = fakeFetch({});
    const r = await resolveVariantViaProductsJson({ brandDomain: 'cosrx.com', handle: 'nope' }, { fetchImpl });
    expect(r).toBeNull();
  });
});

describe('resolveShopifyVariant (seed first, then optional network)', () => {
  test('uses seed_data without any network call', async () => {
    const fetchImpl = jest.fn();
    const r = await resolveShopifyVariant({ seedData: seedFixture() }, { fetchImpl, allowNetworkFallback: true });
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/56707045261692');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('falls back to products.json when seed_data has no variant and fallback allowed', async () => {
    const fetchImpl = fakeFetch({
      'https://cosrx.com/products/advanced-snail-96.json': {
        product: { handle: 'advanced-snail-96', variants: [realPerHandleJsonVariant({ id: 555555555 })] },
      },
    });
    const r = await resolveShopifyVariant(
      { seedData: {}, brandDomain: 'cosrx.com', canonicalUrl: 'https://cosrx.com/products/advanced-snail-96' },
      { fetchImpl, allowNetworkFallback: true },
    );
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/555555555');
  });

  test('does not touch the network when fallback is not allowed', async () => {
    const fetchImpl = jest.fn();
    const r = await resolveShopifyVariant({ seedData: {}, brandDomain: 'cosrx.com' }, { fetchImpl, allowNetworkFallback: false });
    expect(r).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/*
 * STOCK AWARENESS on the products.json paths.
 *
 * Regression cover for: `preferAvailable: true` was INERT on the per-handle fast path because that
 * endpoint omits `available`, so `find((v) => v.available === true)` never matched and the picker
 * always fell through to `variants[0]` — silently, and while reporting `availability: null` as if the
 * question had simply not been asked. MEASURED 2026-08-25: 6/6 warm-handoff brands omit it.
 */
describe('stock awareness (preferAvailable is honoured or honestly reported as unknown)', () => {
  const OOS_THEN_LIVE_JS = {
    handle: 'hydrium-watery-toner',
    title: 'Hydrium Watery Toner',
    variants: [
      realPerHandleJsVariant({ id: 111111111, sku: 'OOS', available: false, title: 'Sold out size' }),
      realPerHandleJsVariant({ id: 222222222, sku: 'LIVE', available: true, title: 'In stock size' }),
    ],
  };
  const OOS_THEN_LIVE_JSON = {
    product: {
      handle: 'hydrium-watery-toner',
      title: 'Hydrium Watery Toner',
      variants: [
        realPerHandleJsonVariant({ id: 111111111, sku: 'OOS', title: 'Sold out size' }),
        realPerHandleJsonVariant({ id: 222222222, sku: 'LIVE', title: 'In stock size' }),
      ],
    },
  };

  test('THE BUG: the per-handle .json fixture carries no `available`, so stock is not knowable from it', () => {
    const picked = pickVariantFromProductNode(OOS_THEN_LIVE_JSON.product, { preferAvailable: true });
    expect(picked.stockKnown).toBe(false);
    expect(picked.preferAvailableApplied).toBe(false);
    // `availability` must stay null — "we could not tell", never a fabricated "available".
    expect(picked.availability).toBeNull();
  });

  test('the .js surface DOES carry stock, so the preference actually reorders the pick', () => {
    const picked = pickVariantFromProductNode(OOS_THEN_LIVE_JS, { preferAvailable: true });
    expect(picked.variantGid).toBe('gid://shopify/ProductVariant/222222222');
    expect(picked.stockKnown).toBe(true);
    expect(picked.preferAvailableApplied).toBe(true);
    expect(picked.availability).toBe('available');
  });

  test('preferAvailableApplied is TRUE even when the in-stock variant was already first', () => {
    // The dial must not read false on a healthy product. Keying it on "the pick moved position"
    // made it report false for every single-variant SKU and every product whose first variant is
    // in stock — i.e. it read zero precisely when the lane was working.
    const firstIsLive = {
      variants: [
        realPerHandleJsVariant({ id: 222222222, sku: 'LIVE', available: true }),
        realPerHandleJsVariant({ id: 111111111, sku: 'OOS', available: false }),
      ],
    };
    const picked = pickVariantFromProductNode(firstIsLive, { preferAvailable: true });
    expect(picked.variantGid).toBe('gid://shopify/ProductVariant/222222222');
    expect(picked.preferAvailableApplied).toBe(true);

    const single = pickVariantFromProductNode(
      { variants: [realPerHandleJsVariant({ id: 222222222, available: true })] },
      { preferAvailable: true },
    );
    expect(single.preferAvailableApplied).toBe(true);
  });

  test('a variant that is in stock but yields NO gid is not a candidate', () => {
    // Otherwise the default flip to preferAvailable could turn a resolvable product into a miss.
    const picked = pickVariantFromProductNode({
      variants: [
        realPerHandleJsVariant({ id: 111111111, sku: 'OOS', available: false }),
        { id: 42, available: true }, // too short to be a Shopify variant id
      ],
    }, { preferAvailable: true });
    expect(picked.variantGid).toBe('gid://shopify/ProductVariant/111111111');
  });

  test('preferAvailable:false does NOT reorder — the flag is respected in BOTH directions', () => {
    const picked = pickVariantFromProductNode(OOS_THEN_LIVE_JS, { preferAvailable: false });
    expect(picked.variantGid).toBe('gid://shopify/ProductVariant/111111111');
    expect(picked.availability).toBe('out_of_stock');
    expect(picked.preferAvailableApplied).toBe(false);
  });

  test('the fast path consults .js BEFORE .json, and picks the in-stock variant', async () => {
    const fetchImpl = recordingFetch({
      'https://cosrx.com/products/hydrium-watery-toner.js': OOS_THEN_LIVE_JS,
      'https://cosrx.com/products/hydrium-watery-toner.json': OOS_THEN_LIVE_JSON,
    });
    const r = await resolveVariantViaProductsJson(
      { brandDomain: 'cosrx.com', handle: 'hydrium-watery-toner' },
      { fetchImpl, preferAvailable: true },
    );
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/222222222');
    expect(r.stockKnown).toBe(true);
    expect(fetchImpl.calls[0]).toBe('https://cosrx.com/products/hydrium-watery-toner.js');
    // .json was never needed, so the click lane still spends exactly ONE fetch.
    expect(fetchImpl.calls).toHaveLength(1);
    // `source` is the only forensic record of WHICH surface answered, and this change made that
    // distinction load-bearing — pin it, or a mislabelled pick is undetectable after the fact.
    expect(r.source).toBe('products.json:https://cosrx.com/products/hydrium-watery-toner.js');
  });

  test('a .js failure does not unleash a ten-page listing walk on the click path', async () => {
    // `fetchProductsJson` cannot tell a 429 from a 404, so escalating here would mean that being
    // rate-limited causes us to send MORE traffic. Bound it: 1 x .js + 1 x .json + 1 listing page.
    const fetchImpl = recordingFetch({
      'https://cosrx.com/products/hydrium-watery-toner.json': OOS_THEN_LIVE_JSON,
      // every listing page answers, full and non-matching, so nothing else stops the walk
      ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [
        `https://cosrx.com/products.json?limit=250&page=${i + 1}`,
        { products: Array.from({ length: 250 }, (_, j) => ({ handle: `other-${i}-${j}`, variants: [{ id: 900000000000 + j, available: true }] })) },
      ])),
    });
    const r = await resolveVariantViaProductsJson(
      { brandDomain: 'cosrx.com', handle: 'hydrium-watery-toner' },
      { fetchImpl, preferAvailable: true },
    );
    // Still answers — never worse than the pre-change behaviour...
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/111111111');
    expect(r.stockKnown).toBe(false);
    // ...but at a bounded cost. Unbounded, this scenario cost 12 fetches.
    expect(fetchImpl.calls).toHaveLength(3);
    expect(fetchImpl.calls.filter((u) => u.includes('products.json?limit=250'))).toHaveLength(1);
  });

  test('with NO usable pick at all the full listing walk still runs — the cap is not a blanket cut', async () => {
    const fetchImpl = recordingFetch({
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [
        `https://cosrx.com/products.json?limit=250&page=${i + 1}`,
        { products: Array.from({ length: 250 }, (_, j) => ({ handle: `other-${i}-${j}`, variants: [{ id: 900000000000 + j, available: true }] })) },
      ])),
      'https://cosrx.com/products.json?limit=250&page=10': {
        products: [{ handle: 'hydrium-watery-toner', variants: [{ id: 222222222, available: true }] }],
      },
    });
    const r = await resolveVariantViaProductsJson(
      { brandDomain: 'cosrx.com', handle: 'hydrium-watery-toner' },
      { fetchImpl, preferAvailable: true },
    );
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/222222222');
    expect(r.source).toBe('products.json:https://cosrx.com/products.json (page 10)');
  });

  test('when .js is absent, a stock-blind .json pick does not end the search — the listing is consulted', async () => {
    const fetchImpl = recordingFetch({
      'https://cosrx.com/products/hydrium-watery-toner.json': OOS_THEN_LIVE_JSON,
      'https://cosrx.com/products.json?limit=250&page=1': {
        products: [{
          handle: 'hydrium-watery-toner',
          title: 'Hydrium Watery Toner',
          variants: [
            { id: 111111111, sku: 'OOS', available: false },
            { id: 222222222, sku: 'LIVE', available: true },
          ],
        }],
      },
    });
    const r = await resolveVariantViaProductsJson(
      { brandDomain: 'cosrx.com', handle: 'hydrium-watery-toner' },
      { fetchImpl, preferAvailable: true },
    );
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/222222222');
    expect(r.stockKnown).toBe(true);
  });

  test('never WORSE than before: with no stock-bearing surface at all, the .json pick is still returned', async () => {
    const fetchImpl = recordingFetch({
      'https://cosrx.com/products/hydrium-watery-toner.json': OOS_THEN_LIVE_JSON,
    });
    const r = await resolveVariantViaProductsJson(
      { brandDomain: 'cosrx.com', handle: 'hydrium-watery-toner' },
      { fetchImpl, preferAvailable: true },
    );
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/111111111');
    expect(r.stockKnown).toBe(false); // reported honestly, not dressed up as a preference-honouring pick
  });

  test('requireAvailable declines a KNOWN sold-out product so the caller cold-redirects', async () => {
    const fetchImpl = fakeFetch({
      'https://cosrx.com/products/all-gone.js': {
        handle: 'all-gone',
        variants: [realPerHandleJsVariant({ id: 333333333, available: false })],
      },
    });
    const soldOut = await resolveShopifyVariant(
      { seedData: {}, brandDomain: 'cosrx.com', handle: 'all-gone' },
      { fetchImpl, allowNetworkFallback: true, preferAvailable: true, requireAvailable: true },
    );
    expect(soldOut).toBeNull();

    // ...and without the opt-in, the same product still resolves (coverage is not cut silently).
    const permissive = await resolveShopifyVariant(
      { seedData: {}, brandDomain: 'cosrx.com', handle: 'all-gone' },
      { fetchImpl, allowNetworkFallback: true, preferAvailable: true },
    );
    expect(permissive.variantGid).toBe('gid://shopify/ProductVariant/333333333');
    expect(permissive.availability).toBe('out_of_stock');
  });

  test('requireAvailable does NOT decline when stock is merely UNKNOWN (absent !== out of stock)', async () => {
    const fetchImpl = fakeFetch({
      'https://cosrx.com/products/unknown-stock.json': {
        product: { handle: 'unknown-stock', variants: [realPerHandleJsonVariant({ id: 444444444 })] },
      },
    });
    const r = await resolveShopifyVariant(
      { seedData: {}, brandDomain: 'cosrx.com', handle: 'unknown-stock' },
      { fetchImpl, allowNetworkFallback: true, preferAvailable: true, requireAvailable: true },
    );
    expect(r).not.toBeNull();
    expect(r.variantGid).toBe('gid://shopify/ProductVariant/444444444');
    expect(r.stockKnown).toBe(false);
  });

  test('the seed path reports the same stockKnown contract', () => {
    const known = resolveVariantFromSeed(seedFixture(), { preferAvailable: true });
    expect(known.stockKnown).toBe(true);       // seed carried stock: 'Out of Stock'
    // NORMALISED to the same token products.json emits — the raw crawler text is kept separately.
    // An earlier version of this test asserted the raw 'out of stock' and thereby PINNED a
    // vocabulary divergence that made the sold-out guard unable to fire on this path.
    expect(known.availability).toBe('out_of_stock');
    expect(known.rawAvailability).toBe('Out of Stock');
    expect(known.preferAvailableApplied).toBe(false);

    const silent = resolveVariantFromSeed(
      seedFixture({ variants: [{ sku: 'SHOPIFY-56707045261692', variant_id: '56707045261692' }], snapshot: undefined }),
      { preferAvailable: true },
    );
    expect(silent.stockKnown).toBe(false);
    expect(silent.availability).toBeNull();

    // An IN-STOCK seed row, so `preferAvailableApplied: true` is actually reachable. Without this
    // row the false-assertion above cannot fail, whatever the code does.
    const live = resolveVariantFromSeed(
      seedFixture({ variants: [{ sku: 'SHOPIFY-56707045261692', variant_id: '56707045261692', stock: 'In Stock' }], snapshot: undefined }),
      { preferAvailable: true },
    );
    expect(live.availability).toBe('available');
    expect(live.preferAvailableApplied).toBe(true);
  });

  /*
   * THE SOURCES DO NOT SPEAK THE SAME LANGUAGE. products.json says `available: false`; the crawled
   * seed says "Out of Stock" / "sold_out" / "Unavailable" / schema.org "OutOfStock". The sold-out
   * guard compares ONE canonical token, so every spelling must normalise onto it — otherwise the
   * guard silently covers only the one spelling someone happened to write it against.
   */
  describe('normalizeAvailability — one vocabulary across every source', () => {
    test.each([
      [true, 'available'], [false, 'out_of_stock'],
      ['out_of_stock', 'out_of_stock'], ['Out of Stock', 'out_of_stock'], ['out of stock', 'out_of_stock'],
      ['sold_out', 'out_of_stock'], ['Sold Out', 'out_of_stock'], ['SOLD OUT', 'out_of_stock'],
      ['unavailable', 'out_of_stock'], ['Unavailable', 'out_of_stock'], ['OutOfStock', 'out_of_stock'],
      ['discontinued', 'out_of_stock'], ['backorder', 'out_of_stock'],
      ['available', 'available'], ['In Stock', 'available'], ['in_stock', 'available'], ['instock', 'available'],
    ])('%p -> %p', (raw, expected) => {
      expect(normalizeAvailability(raw)).toBe(expected);
    });

    test('an unparseable or absent signal is UNKNOWN, never a false negative', () => {
      // A wrong "sold out" silently deletes a live product from the lane, so anything we cannot
      // read must land on null and let the caller decide — never on out_of_stock.
      for (const raw of ['', null, undefined, 'wibble', '???', 42]) {
        expect(normalizeAvailability(raw)).toBeNull();
      }
    });

    test('EVERY spelling the repo already documents as unavailable actually declines', async () => {
      // checkoutHandoffResolver.UNAVAILABLE_STATUSES is the existing catalogue of real seed values.
      const spellings = ['out_of_stock', 'out of stock', 'sold_out', 'sold out', 'unavailable', 'Out of Stock', 'OutOfStock'];
      for (const stock of spellings) {
        const seedData = { variants: [{ sku: 'SHOPIFY-56707045261692', variant_id: '56707045261692', stock }] };
        const declined = await resolveShopifyVariant(
          { seedData },
          { preferAvailable: true, requireAvailable: true, allowNetworkFallback: false },
        );
        expect([stock, declined]).toEqual([stock, null]);
      }
    });
  });
});
