const {
  findExternalSeedProductById,
  looksLikeStableExternalSeedId,
} = require('../../src/services/externalSeedDetail');
const { stableExternalProductId } = require('../../src/services/externalSeedProducts');

describe('externalSeedDetail', () => {
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

  test('falls back to scan recent rows for stable hashed ext ids', async () => {
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
