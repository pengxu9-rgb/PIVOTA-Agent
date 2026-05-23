const {
  _internals: { buildMirror, inferCatalogMirrorCategory },
} = require('../../scripts/sync-external-seeds-to-catalog.cjs');

describe('sync-external-seeds-to-catalog category inference', () => {
  test('classifies mineral highlighters as makeup instead of generic beauty', () => {
    const category = inferCatalogMirrorCategory({
      title: 'King Kylie Loose Powder Highlighter',
      domain: 'kyliecosmetics.com',
      seed_data: {
        description:
          'A loose powder highlighter with a warm champagne shade and pearlescent glow.',
        snapshot: {},
      },
    });

    expect(category).toEqual({
      productType: 'Highlighter',
      category: 'Highlighter',
      categoryPath: 'beauty/makeup/cheek/highlighter',
    });
  });

  test('keeps lipstick-style products in lip makeup for canonical recall', () => {
    const category = inferCatalogMirrorCategory({
      title: 'Matte Liquid Lipstick',
      domain: 'kyliecosmetics.com',
      seed_data: {
        snapshot: {
          description: 'A long-wearing liquid lip color.',
        },
      },
    });

    expect(category).toEqual({
      productType: 'Lip Color',
      category: 'Lip Color',
      categoryPath: 'beauty/makeup/lip',
    });
  });
});

describe('sync-external-seeds-to-catalog signature preservation', () => {
  test('uses the existing catalog signature for public PDP while keeping identity group separately', () => {
    const mirror = buildMirror({
      id: 'eps_test',
      external_product_id: 'ext_test_lip_liner',
      market: 'US',
      domain: 'fentybeauty.com',
      title: 'Trace Out Lip Liner - Rose Amber',
      image_url: 'https://cdn.example.com/lip-liner.jpg',
      price_amount: 22,
      price_currency: 'USD',
      availability: 'in_stock',
      canonical_url: 'https://fentybeauty.com/products/lip-liner-rose-amber',
      status: 'active',
      existing_pivota_signature_id: 'sig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      existing_content_key: 'ck_existing_content_key',
      identity_listing: {
        identity_status: 'approved',
        live_read_enabled: true,
        review_required: false,
        sellable_item_group_id: 'sig_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        source_tier: 'brand',
      },
      seed_data: {
        brand: 'Fenty Beauty',
        description: 'A longwear pencil lip liner for precise lip definition.',
        variants: [
          {
            variant_id: 'rose_amber',
            sku: '82510',
            title: 'Rose Amber',
            price: '22.00',
            currency: 'USD',
            image_url: 'https://cdn.example.com/lip-liner.jpg',
            options: [{ name: 'Shade', value: 'Rose Amber' }],
          },
        ],
      },
    });

    expect(mirror.product.pivota_signature_id).toBe('sig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(mirror.product.pivota_canonical_url).toBe(
      'https://agent.pivota.cc/products/sig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(mirror.product.content_key).toBe('ck_existing_content_key');
    expect(mirror.productGroupId).toBe('sig_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });
});
