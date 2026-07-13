'use strict';

const {
  toVariantGid,
  resolveVariantFromSeed,
  resolveVariantViaProductsJson,
  resolveShopifyVariant,
  extractProductHandle,
  normalizeBrandOrigin,
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
        product: { handle: 'advanced-snail-96', title: 'Advanced Snail 96', variants: [{ id: 777777777, sku: 'A1', available: true }] },
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
        product: { handle: 'advanced-snail-96', variants: [{ id: 555555555, available: true }] },
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
