const {
  collectNormalizedProductImageUrls,
  normalizeAgentProductsListResponse,
  normalizeProductImages,
} = require('../../src/commerce/catalog/agentProductsListResponse');

describe('agentProductsListResponse', () => {
  test('collects and prioritizes normalized image urls', () => {
    expect(
      collectNormalizedProductImageUrls({
        image_url: 'http://cdn.example/primary.jpg',
        images: [
          { url: 'https://cdn.example/hero.jpg' },
          { src: 'http://cdn.example/secondary.jpg' },
        ],
        variants: ['https://cdn.example/variant.jpg'],
      }),
    ).toEqual([
      'https://cdn.example/hero.jpg',
      'https://cdn.example/variant.jpg',
      'http://cdn.example/primary.jpg',
      'http://cdn.example/secondary.jpg',
    ]);
  });

  test('normalizes product image envelope', () => {
    expect(
      normalizeProductImages({
        image_urls: ['https://cdn.example/a.jpg', 'http://cdn.example/b.jpg'],
      }),
    ).toEqual({
      primaryImageUrl: 'https://cdn.example/a.jpg',
      normalizedImages: ['https://cdn.example/a.jpg', 'http://cdn.example/b.jpg'],
    });
  });

  test('normalizes agent product list responses and metadata defaults', () => {
    const out = normalizeAgentProductsListResponse(
      {
        items: [
          {
            merchant_id: 'm1',
            product_id: 'p1',
            image_url: 'http://cdn.example/old.jpg',
            images: [{ url: 'https://cdn.example/new.jpg' }],
          },
        ],
      },
      { limit: 20, offset: 20 },
    );

    expect(out.status).toBe('success');
    expect(out.success).toBe(true);
    expect(out.total).toBe(1);
    expect(out.page).toBe(2);
    expect(out.page_size).toBe(1);
    expect(out.metadata.query_source).toBe('agent_products_search');
    expect(typeof out.metadata.fetched_at).toBe('string');
    expect(out.products[0]).toMatchObject({
      image_url: 'https://cdn.example/new.jpg',
      images: ['https://cdn.example/new.jpg', 'http://cdn.example/old.jpg'],
    });
  });
});
