const { buildPdpPayload } = require('../src/pdpBuilder');

function buildPreviewItem(index) {
  return {
    review_id: `r_${index}`,
    rating: 5,
    author_label: `buyer_${index}`,
    title: `review title ${index}`,
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
        vendor: 'Winona',
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

    expect(payload.product.brand).toEqual({ name: 'Winona' });
    expect(reviewsModule).toBeTruthy();
    expect(reviewsModule.data.brand_card).toEqual({ name: 'Winona' });
    const previewItems = reviewsModule.data.preview_items || [];
    expect(previewItems).toHaveLength(6);
    expect(previewItems[0].review_id).toBe('r_1');
    expect(previewItems[0].title).toBe('review title 1');
    expect(previewItems[0].media).toEqual([
      {
        type: 'image',
        url: 'https://cdn.example.com/review-1.jpg',
        thumbnail_url: 'https://cdn.example.com/review-1-thumb.jpg',
      },
    ]);
    expect(previewItems[5].review_id).toBe('r_6');
  });

  test('preserves review scope metadata and product-line preview media', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'p_scope_1',
        merchant_id: 'external_seed',
        title: 'Scope Product',
        vendor: 'KraveBeauty',
        image_url: 'https://cdn.example.com/hero.jpg',
        images: [
          {
            url: 'https://cdn.example.com/exact-main.jpg',
            source_scope: 'exact_item',
            source_tier: 'brand',
            source_kind: 'external_seed',
          },
        ],
        line_preview_images: [
          {
            url: 'https://cdn.example.com/line-preview.jpg',
            source_scope: 'product_line_preview',
            source_tier: 'brand',
            source_kind: 'external_seed',
          },
        ],
        gallery_scope: 'exact_item',
        preview_scope: 'product_line',
        price: { amount: 28, currency: 'EUR' },
        review_summary: {
          scale: 5,
          rating: 4.7,
          review_count: 42,
          aggregation_scope: 'product_line',
          exact_item_review_count: 12,
          product_line_review_count: 42,
          scope_label: 'Based on product-line reviews (42)',
          scoped_summaries: {
            product_line: {
              scale: 5,
              rating: 4.7,
              review_count: 42,
              scope_label: 'Based on product-line reviews (42)',
              preview_items: [],
            },
            exact_item: {
              scale: 5,
              rating: 4.4,
              review_count: 12,
              scope_label: 'Based on exact-item reviews (12)',
              preview_items: [],
            },
          },
          tabs: [
            { id: 'product_line', label: 'Product line', count: 42, default: true },
            { id: 'exact_item', label: 'Exact item', count: 12 },
          ],
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const mediaModule = payload.modules.find((m) => m?.type === 'media_gallery');
    const reviewsModule = payload.modules.find((m) => m?.type === 'reviews_preview');

    expect(mediaModule?.data).toEqual(
      expect.objectContaining({
        gallery_scope: 'exact_item',
        preview_scope: 'product_line',
        preview_items: [
          expect.objectContaining({
            url: 'https://cdn.example.com/line-preview.jpg',
            source_scope: 'product_line_preview',
            source_tier: 'brand',
            source_kind: 'external_seed',
          }),
        ],
      }),
    );
    expect(reviewsModule?.data).toEqual(
      expect.objectContaining({
        aggregation_scope: 'product_line',
        exact_item_review_count: 12,
        product_line_review_count: 42,
        scope_label: 'Based on product-line reviews (42)',
        scoped_summaries: expect.objectContaining({
          product_line: expect.objectContaining({
            review_count: 42,
            scope_label: 'Based on product-line reviews (42)',
          }),
          exact_item: expect.objectContaining({
            review_count: 12,
            scope_label: 'Based on exact-item reviews (12)',
          }),
        }),
        tabs: [
          expect.objectContaining({ id: 'product_line', label: 'Product line', count: 42, default: true }),
          expect.objectContaining({ id: 'exact_item', label: 'Exact item', count: 12 }),
        ],
      }),
    );
  });

  test('filters pending user contributions but keeps approved ones and exposes contribution gates', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'p_contrib_1',
        merchant_id: 'external_seed',
        title: 'Contribution Product',
        vendor: 'Anua',
        images: [
          {
            url: 'https://cdn.example.com/merchant-main.jpg',
            source_kind: 'external_seed',
          },
          {
            url: 'https://cdn.example.com/pending-user-photo.jpg',
            source_kind: 'pivota_user_gallery',
            content_review_state: 'pending',
          },
          {
            url: 'https://cdn.example.com/approved-user-photo.jpg',
            source_kind: 'pivota_user_gallery',
            content_review_state: 'approved',
          },
        ],
        review_summary: {
          scale: 5,
          rating: 4.8,
          review_count: 18,
          preview_items: [
            {
              review_id: 'merchant_1',
              rating: 5,
              title: 'Merchant review',
              text_snippet: 'Public merchant review.',
              source_kind: 'merchant_public_review',
            },
            {
              review_id: 'pending_user_1',
              rating: 5,
              title: 'Pending user review',
              text_snippet: 'Should stay hidden.',
              source_kind: 'pivota_user_review',
              content_review_state: 'pending',
            },
            {
              review_id: 'approved_user_1',
              rating: 5,
              title: 'Approved user review',
              text_snippet: 'Approved for public display.',
              source_kind: 'pivota_user_review',
              content_review_state: 'approved',
            },
          ],
          questions: [
            {
              question: 'Can I use this every day?',
              answer: 'Yes.',
              source: 'community',
              content_review_state: 'approved',
            },
            {
              question: 'Pending question?',
              answer: 'This should be hidden.',
              source: 'community',
              content_review_state: 'pending',
            },
          ],
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
      includeEmptyReviews: true,
    });

    const mediaModule = payload.modules.find((m) => m?.type === 'media_gallery');
    const reviewsModule = payload.modules.find((m) => m?.type === 'reviews_preview');

    expect((mediaModule?.data?.items || []).map((item) => item.url)).toEqual([
      'https://cdn.example.com/merchant-main.jpg',
      'https://cdn.example.com/approved-user-photo.jpg',
    ]);
    expect((reviewsModule?.data?.preview_items || []).map((item) => item.review_id)).toEqual([
      'merchant_1',
      'approved_user_1',
    ]);
    expect((reviewsModule?.data?.questions || []).map((item) => item.question)).toEqual([
      'Can I use this every day?',
    ]);
    expect(mediaModule?.data?.contribution_policy).toEqual(
      expect.objectContaining({
        employee_review_required: true,
        publish_visibility: 'employee_approved_only',
      }),
    );
    expect(reviewsModule?.data?.contribution_policy).toEqual(
      expect.objectContaining({
        employee_review_required: true,
        publish_visibility: 'employee_approved_only',
      }),
    );
    expect(reviewsModule?.data?.entry_points?.ask_question).toEqual(
      expect.objectContaining({
        action_type: 'open_embed',
        label: 'Ask a question',
      }),
    );
    expect(mediaModule?.data?.entry_points?.submit_photo).toEqual(
      expect.objectContaining({
        action_type: 'open_embed',
        label: 'Add a photo',
      }),
    );
  });
});
