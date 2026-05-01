const {
  parseExternalProductIds,
  imageFilenameFamilyKey,
  extractGalleryStats,
  classifyGalleryIssue,
} = require('../../scripts/audit-external-seed-gallery-bloat.cjs');

describe('audit-external-seed-gallery-bloat', () => {
  test('parses external_product_ids from comma and newline separated input', () => {
    expect(parseExternalProductIds('ext_a,\next_b\next_a')).toEqual(['ext_a', 'ext_b']);
  });

  test('derives a stable filename family key from shopify asset urls', () => {
    expect(
      imageFilenameFamilyKey(
        'https://cdn.shopify.com/s/files/1/0428/8498/9091/files/Omega50_Why_we_love_it_2000x2000_a04046bb-75f6-4bd5-888d-e17c82dd5583.jpg?v=1759262701',
      ),
    ).toBe('omega50');
  });

  test('extracts gallery stats and preserves exact duplicate detection separately from gallery volume', () => {
    const stats = extractGalleryStats({
      product: {
        gallery_scope: 'exact_item',
        preview_scope: 'product_line',
        image_urls: [
          'https://cdn.shopify.com/s/files/1/0428/8498/9091/files/Omega50_A.jpg?v=1',
          'https://cdn.shopify.com/s/files/1/0428/8498/9091/files/Omega50_B.jpg?v=1',
          'https://cdn.shopify.com/s/files/1/0428/8498/9091/files/Omega100_A.jpg?v=1',
        ],
      },
      modules: [
        {
          type: 'media_gallery',
          data: {
            items: [
              { url: 'https://cdn.shopify.com/s/files/1/0428/8498/9091/files/Omega50_A.jpg?v=1', source: 'exact_item', source_kind: 'external_seed' },
              { url: 'https://cdn.shopify.com/s/files/1/0428/8498/9091/files/Omega50_B.jpg?v=1', source: 'exact_item', source_kind: 'external_seed' },
              { url: 'https://cdn.shopify.com/s/files/1/0428/8498/9091/files/Omega100_A.jpg?v=1', source: 'exact_item', source_kind: 'external_seed' },
            ],
          },
        },
      ],
    });

    expect(stats.product_image_urls_count).toBe(3);
    expect(stats.media_gallery_count).toBe(3);
    expect(stats.media_gallery_unique_count).toBe(3);
    expect(stats.exact_duplicate_count).toBe(0);
    expect(stats.source_counts).toEqual([{ key: 'exact_item', count: 3 }]);
    expect(stats.source_kind_counts).toEqual([{ key: 'external_seed', count: 3 }]);
    expect(stats.filename_family_counts[0]).toEqual({ key: 'omega50', count: 2 });
  });

  test('classifies bloated galleries by count thresholds', () => {
    expect(classifyGalleryIssue({ media_gallery_count: 125, top_family_count: 50 })).toBe(
      'gallery_bloat_extreme',
    );
    expect(classifyGalleryIssue({ media_gallery_count: 52, top_family_count: 10 })).toBe('gallery_bloat');
    expect(classifyGalleryIssue({ media_gallery_count: 18, top_family_count: 13 })).toBe(
      'gallery_family_repetition',
    );
    expect(classifyGalleryIssue({ media_gallery_count: 12, top_family_count: 4 })).toBe('ok');
  });
});
