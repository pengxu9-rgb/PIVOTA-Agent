const { buildSeedRow } = require('../../scripts/build_aurora_external_seed_creation_manifest.cjs');

describe('build_aurora_external_seed_creation_manifest', () => {
  test('preserves source-backed review summaries from catalog extraction', () => {
    const reviewSummary = {
      rating: 4.397572,
      scale: 5,
      review_count: 1318,
      source_origin: 'official_yotpo_reviews_api',
      source_url: 'https://api.yotpo.com/v1/widget/app/products/6686565204013/reviews.json?page=1&per_page=20',
      preview_items: [
        {
          review_id: 'yotpo_841090761',
          rating: 5,
          author_label: 'Maura L.',
          text_snippet: 'I keep repurchasing this because the color and feel are excellent.',
          source: 'merchant_public',
          public_visible: true,
        },
      ],
    };

    const seedRow = buildSeedRow(
      {
        target_brand: 'Fenty Beauty',
        target_url: 'https://fentybeauty.com/products/gloss-bomb-heat',
        market: 'US',
      },
      {
        products: [
          {
            title: 'Gloss Bomb Heat',
            url: 'https://fentybeauty.com/products/gloss-bomb-heat',
            description: 'A lip luminizer and plumper.',
            price: '$26.00',
            currency: 'USD',
            availability: 'in_stock',
            image_url: 'https://cdn.shopify.com/s/files/1/0341/3458/9485/products/gloss.jpg',
            review_summary: reviewSummary,
          },
        ],
      },
    );

    expect(seedRow.seed_data.review_summary).toEqual(reviewSummary);
    expect(seedRow.seed_data.snapshot.review_summary).toEqual(reviewSummary);
  });
});
