const {
  findExternalSeedProductById,
  looksLikeStableExternalSeedId,
  _internals,
} = require('../../src/services/externalSeedDetail');
const { stableExternalProductId } = require('../../src/services/externalSeedProducts');

describe('externalSeedDetail', () => {
  beforeEach(() => {
    _internals.resetExternalSeedDetailCache();
  });

  test('resolves an external seed product by direct stored product id fields', async () => {
    const calls = [];
    const row = {
      id: 'seed_row_1',
      external_product_id: 'ext_direct_seed_1',
      market: 'US',
      tool: 'creator_agents',
      destination_url: 'https://brand.example/p/direct-seed-serum',
      canonical_url: 'https://brand.example/p/direct-seed-serum',
      domain: 'brand.example',
      title: 'Direct Seed Serum',
      image_url: 'https://brand.example/direct-seed-serum.jpg',
      price_amount: 38,
      price_currency: 'USD',
      availability: 'in stock',
      seed_data: {
        merchant_display_name: 'Brand Example',
        snapshot: {
          title: 'Direct Seed Serum',
          canonical_url: 'https://brand.example/p/direct-seed-serum',
        },
      },
    };
    const queryFn = jest.fn(async (sql) => {
      calls.push(sql);
      return { rows: [row] };
    });

    const product = await findExternalSeedProductById({
      productId: 'ext_direct_seed_1',
      queryFn,
    });

    expect(product).toEqual(
      expect.objectContaining({
        product_id: 'ext_direct_seed_1',
        merchant_id: 'external_seed',
        market: 'US',
        tool: 'creator_agents',
        external_seed_id: 'seed_row_1',
        title: 'Direct Seed Serum',
      }),
    );
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatch(/external_product_id = \$1/i);
  });

  test('uses SQL-side stable hash lookup for stable hashed ext ids before broad scan', async () => {
    const canonicalUrl = 'https://brand.example/products/hash-only-serum';
    const productId = stableExternalProductId(canonicalUrl);
    const row = {
      id: 'seed_row_hash',
      external_product_id: null,
      market: 'US',
      tool: '*',
      destination_url: canonicalUrl,
      canonical_url: canonicalUrl,
      domain: 'brand.example',
      title: 'Hash Only Serum',
      image_url: 'https://brand.example/hash-only-serum.jpg',
      price_amount: 42,
      price_currency: 'USD',
      availability: 'in stock',
      seed_data: {
        merchant_display_name: 'Brand Example',
        snapshot: {
          title: 'Hash Only Serum',
          canonical_url: canonicalUrl,
        },
      },
    };
    const queryFn = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });

    const product = await findExternalSeedProductById({
      productId,
      queryFn,
      scanLimit: 200,
    });

    expect(product).toEqual(
      expect.objectContaining({
        product_id: productId,
        merchant_id: 'external_seed',
        external_seed_id: 'seed_row_hash',
        title: 'Hash Only Serum',
      }),
    );
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(queryFn.mock.calls[1][0]).toMatch(/sha256/i);
  });

  test('falls back to bounded scan when stable hash lookup misses', async () => {
    const canonicalUrl = 'https://brand.example/products/hash-scan-fallback-serum';
    const productId = stableExternalProductId(canonicalUrl);
    const row = {
      id: 'seed_row_hash_fallback',
      external_product_id: null,
      market: 'US',
      tool: '*',
      destination_url: canonicalUrl,
      canonical_url: canonicalUrl,
      domain: 'brand.example',
      title: 'Hash Scan Fallback Serum',
      image_url: 'https://brand.example/hash-scan-fallback-serum.jpg',
      price_amount: 42,
      price_currency: 'USD',
      availability: 'in stock',
      seed_data: {
        merchant_display_name: 'Brand Example',
        snapshot: {
          title: 'Hash Scan Fallback Serum',
          canonical_url: canonicalUrl,
        },
      },
    };
    const queryFn = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });

    const product = await findExternalSeedProductById({
      productId,
      queryFn,
      scanLimit: 200,
    });

    expect(product).toEqual(
      expect.objectContaining({
        product_id: productId,
        merchant_id: 'external_seed',
        external_seed_id: 'seed_row_hash_fallback',
        title: 'Hash Scan Fallback Serum',
      }),
    );
    expect(queryFn).toHaveBeenCalledTimes(3);
    expect(queryFn.mock.calls[2][0]).toMatch(/LIMIT \$1/i);
  });

  test('caches stable hashed external seed lookup results', async () => {
    const canonicalUrl = 'https://brand.example/products/hash-cache-serum';
    const productId = stableExternalProductId(canonicalUrl);
    const row = {
      id: 'seed_row_hash_cache',
      external_product_id: null,
      market: 'US',
      tool: '*',
      destination_url: canonicalUrl,
      canonical_url: canonicalUrl,
      domain: 'brand.example',
      title: 'Hash Cache Serum',
      image_url: 'https://brand.example/hash-cache-serum.jpg',
      price_amount: 42,
      price_currency: 'USD',
      availability: 'in stock',
      seed_data: {
        merchant_display_name: 'Brand Example',
        snapshot: {
          title: 'Hash Cache Serum',
          canonical_url: canonicalUrl,
        },
      },
    };
    const queryFn = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });

    const first = await findExternalSeedProductById({ productId, queryFn, scanLimit: 200 });
    const second = await findExternalSeedProductById({ productId, queryFn, scanLimit: 200 });

    expect(first).toEqual(expect.objectContaining({ product_id: productId }));
    expect(second).toEqual(expect.objectContaining({ product_id: productId }));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  test('does not perform a full scan for non hashed ids after a direct miss', async () => {
    const queryFn = jest.fn(async () => ({ rows: [] }));

    const product = await findExternalSeedProductById({
      productId: 'external_seed_plain_id',
      queryFn,
    });

    expect(product).toBeNull();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  test('recognizes stable external seed ids', () => {
    expect(looksLikeStableExternalSeedId('ext_e9366ce39ac8c46f82a45619')).toBe(true);
    expect(looksLikeStableExternalSeedId('ext_not_a_hash')).toBe(false);
  });
});
