const { buildPdpPayload } = require('../src/pdpBuilder');

function buildPreviewItem(index) {
  return {
    review_id: `r_${index}`,
    rating: 5,
    author_label: `buyer_${index}`,
    text_snippet: `review text ${index}`,
    media: [
      {
        type: 'image',
        url: `https://cdn.example.com/review-${index}.jpg`,
        thumbnail_url: `https://cdn.example.com/review-${index}-thumb.jpg`,
      },
    ],
  };
}

describe('pdpBuilder reviews preview media', () => {
  test('keeps review media and caps preview_items at 6', () => {
    const summaryItems = Array.from({ length: 8 }, (_, idx) => buildPreviewItem(idx + 1));
    const payload = buildPdpPayload({
      product: {
        product_id: 'p_1',
        merchant_id: 'm_1',
        title: 'Test Product',
        image_url: 'https://cdn.example.com/hero.jpg',
        price: { amount: 99, currency: 'USD' },
        review_summary: {
          scale: 5,
          rating: 4.7,
          review_count: 128,
          preview_items: summaryItems,
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const reviewsModule = Array.isArray(payload.modules)
      ? payload.modules.find((m) => m && m.type === 'reviews_preview')
      : null;

    expect(reviewsModule).toBeTruthy();
    const previewItems = reviewsModule.data.preview_items || [];
    expect(previewItems).toHaveLength(6);
    expect(previewItems[0].review_id).toBe('r_1');
    expect(previewItems[0].media).toEqual([
      {
        type: 'image',
        url: 'https://cdn.example.com/review-1.jpg',
        thumbnail_url: 'https://cdn.example.com/review-1-thumb.jpg',
      },
    ]);
    expect(previewItems[5].review_id).toBe('r_6');
  });
});
