const {
  _internals: { buildMirror, inferCatalogMirrorCategory, scoreMirrorServingQuality },
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

  test('honors reviewed leaf catalog category paths over broad haircare heuristic', () => {
    const category = inferCatalogMirrorCategory({
      title: 'Mekabu Hydrating Shampoo',
      domain: 'lovemasami.com',
      seed_data: {
        product_type: 'Shampoo',
        category: 'Haircare',
        catalog_category_path: 'beauty/haircare/shampoo',
        snapshot: {
          product_type: 'Shampoo',
          category_path: ['beauty', 'haircare', 'shampoo'],
        },
      },
    });

    expect(category).toEqual({
      productType: 'Shampoo',
      category: 'Shampoo',
      categoryPath: 'beauty/haircare/shampoo',
    });
  });

  test('keeps reviewed hair styling cream out of skincare moisturizer', () => {
    const category = inferCatalogMirrorCategory({
      title: 'Mekabu Hydrating Styling Cream',
      domain: 'lovemasami.com',
      seed_data: {
        product_type: 'Styling Cream',
        category: 'Haircare',
        catalog_category_path: 'beauty/haircare/styling-cream',
        description: 'A curl-defining styling cream for frizz control and flexible hold.',
        snapshot: {},
      },
    });

    expect(category).toEqual({
      productType: 'Styling Cream',
      category: 'Styling Cream',
      categoryPath: 'beauty/haircare/styling-cream',
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

describe('sync-external-seeds-to-catalog variant prices', () => {
  test('preserves reviewed multi-size variant prices when top-level price is the minimum price', () => {
    const mirror = buildMirror({
      id: 'eps_multisize',
      external_product_id: 'ext_multisize_mist',
      market: 'US',
      domain: 'abyssianhaircare.com',
      title: 'Youth Bloom Hair Mist',
      image_url: 'https://cdn.example.com/mist.jpg',
      price_amount: 10,
      price_currency: 'USD',
      availability: 'in_stock',
      canonical_url: 'https://www.abyssianhaircare.com/products/revitalizing-rinsing-mist',
      status: 'active',
      identity_listing: {
        identity_status: 'approved',
        live_read_enabled: true,
        review_required: false,
        sellable_item_group_id: 'sig_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        source_tier: 'brand',
      },
      seed_data: {
        brand: 'Abyssian',
        description:
          'A reviewed hair mist with official ingredients, use directions, image, price, and availability.',
        variants: [
          {
            variant_id: '225ml',
            sku: '50QY22',
            title: '225 ml / 7.61 fl oz',
            price: '31',
            currency: 'USD',
            image_url: 'https://cdn.example.com/mist-225.jpg',
          },
          {
            variant_id: '50ml',
            sku: '50QY5',
            title: '50ml / 1.69 fl oz',
            price: '10',
            currency: 'USD',
            image_url: 'https://cdn.example.com/mist-50.jpg',
          },
        ],
      },
    });

    expect(mirror.skus.map((item) => [item.sku.sku, item.offer.list_price])).toEqual([
      ['50QY22', 31],
      ['50QY5', 10],
    ]);
  });
});

describe('sync-external-seeds-to-catalog serving bootstrap', () => {
  function buildReadyMirror(identityListing) {
    return buildMirror({
      id: 'eps_bootstrap',
      external_product_id: 'ext_bootstrap_serum',
      market: 'US',
      domain: 'seresilk.com',
      title: 'Barrier Repair Serum',
      image_url: 'https://cdn.example.com/serum.jpg',
      price_amount: 48,
      price_currency: 'USD',
      availability: 'in_stock',
      canonical_url: 'https://seresilk.com/products/barrier-repair-serum',
      status: 'active',
      identity_listing: identityListing,
      seed_data: {
        brand: 'Seresilk',
        description:
          'A lightweight daily serum with a reviewed official product page and complete commerce details.',
        variants: [
          {
            variant_id: 'default',
            sku: 'SERUM-01',
            title: 'Default Title',
            price: '48.00',
            currency: 'USD',
            image_url: 'https://cdn.example.com/serum.jpg',
          },
        ],
      },
    });
  }

  test('keeps approved non-live identity blocked unless bootstrap is explicitly enabled', () => {
    const mirror = buildReadyMirror({
      identity_status: 'approved',
      live_read_enabled: false,
      review_required: false,
      sellable_item_group_id: 'sig_cccccccccccccccccccccccccccccccc',
      source_tier: 'brand',
    });

    expect(scoreMirrorServingQuality(mirror)).toMatchObject({
      servingEligible: false,
      blockerCode: 'identity_not_live_approved',
      identityResolved: false,
      identityBootstrapEligible: false,
    });

    expect(scoreMirrorServingQuality(mirror, { allowIdentityBootstrap: true })).toMatchObject({
      servingEligible: true,
      blockerCode: 'none',
      identityResolved: true,
      identityBootstrapEligible: true,
    });
  });

  test('does not bootstrap merchant-tier identity rows', () => {
    const mirror = buildReadyMirror({
      identity_status: 'approved',
      live_read_enabled: false,
      review_required: false,
      sellable_item_group_id: 'sig_dddddddddddddddddddddddddddddddd',
      source_tier: 'merchant',
    });

    expect(scoreMirrorServingQuality(mirror, { allowIdentityBootstrap: true })).toMatchObject({
      servingEligible: false,
      blockerCode: 'identity_not_live_approved',
      identityResolved: false,
      identityBootstrapEligible: false,
    });
  });
});
