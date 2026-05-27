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

describe('sync-external-seeds-to-catalog source domain capture', () => {
  test('mirrors external seed domain into catalog row values', () => {
    const mirror = buildMirror({
      id: 'eps_source_domain',
      external_product_id: 'ext_source_domain_serum',
      market: 'US',
      domain: 'seresilk.com',
      title: 'Barrier Repair Serum',
      image_url: 'https://cdn.example.com/serum.jpg',
      price_amount: 48,
      price_currency: 'USD',
      availability: 'in_stock',
      canonical_url: 'https://seresilk.com/products/barrier-repair-serum',
      status: 'active',
      identity_listing: {
        identity_status: 'approved',
        live_read_enabled: true,
        review_required: false,
        source_tier: 'brand',
      },
      seed_data: {
        brand: 'Seresilk',
        description: 'A lightweight daily serum with complete commerce details.',
        variants: [
          {
            variant_id: 'default',
            sku: 'SERUM-01',
            title: 'Default Title',
            price: '48.00',
            currency: 'USD',
          },
        ],
      },
    });

    expect(mirror.product.source_domain).toBe('seresilk.com');
    expect(mirror.skus[0].sku.source_domain).toBe('seresilk.com');
    expect(mirror.skus[0].offer.source_domain).toBe('seresilk.com');
  });

  test('leaves source_domain null when seed domain is empty', () => {
    const mirror = buildMirror({
      id: 'eps_source_domain_null',
      external_product_id: 'ext_source_domain_null_serum',
      market: 'US',
      domain: '',
      title: 'Barrier Repair Serum',
      image_url: 'https://cdn.example.com/serum.jpg',
      price_amount: 48,
      price_currency: 'USD',
      availability: 'in_stock',
      canonical_url: 'https://seresilk.com/products/barrier-repair-serum',
      status: 'active',
      identity_listing: {
        identity_status: 'approved',
        live_read_enabled: true,
        review_required: false,
        source_tier: 'brand',
      },
      seed_data: {
        brand: 'Seresilk',
        description: 'A lightweight daily serum with complete commerce details.',
      },
    });

    expect(mirror.product.source_domain).toBeNull();
    expect(mirror.skus[0].sku.source_domain).toBeNull();
    expect(mirror.skus[0].offer.source_domain).toBeNull();
  });
});

describe('sync-external-seeds-to-catalog barcode capture', () => {
  function buildSeed(seedData) {
    return buildMirror({
      id: 'eps_barcode',
      external_product_id: 'ext_barcode_serum',
      market: 'US',
      domain: 'seresilk.com',
      title: 'Barrier Repair Serum',
      image_url: 'https://cdn.example.com/serum.jpg',
      price_amount: 48,
      price_currency: 'USD',
      availability: 'in_stock',
      canonical_url: 'https://seresilk.com/products/barrier-repair-serum',
      status: 'active',
      identity_listing: {
        identity_status: 'approved',
        live_read_enabled: true,
        review_required: false,
        source_tier: 'brand',
      },
      seed_data: {
        brand: 'Seresilk',
        description: 'A lightweight daily serum with complete commerce details.',
        ...seedData,
      },
    });
  }

  test.each([
    [{ gtin: '1234567890123' }, '1234567890123'],
    [{ upc: '123456789012' }, '123456789012'],
    [{ variants: [{ variant_id: 'mini', gtin: '12345678', price: '48.00' }] }, '12345678'],
    [{ barcode: '0-12345-67890-5' }, '012345678905'],
  ])('normalizes supported digit identifiers into catalog SKU barcode', (seedData, expected) => {
    const mirror = buildSeed(seedData);
    expect(mirror.skus[0].sku.barcode).toBe(expected);
    expect(mirror.auditReasons.no_strong_identifier).toBeUndefined();
  });

  test('skips missing and garbage identifiers without rejecting the SKU', () => {
    const missing = buildSeed({});
    expect(missing.skus[0].sku.barcode).toBeNull();
    expect(missing.auditReasons.no_strong_identifier).toBe(1);

    const garbage = buildSeed({ variants: [{ variant_id: 'bad', gtin: 'N/A', barcode: '0', price: '48.00' }] });
    expect(garbage.skus[0].sku.barcode).toBeNull();
    expect(garbage.auditReasons.no_strong_identifier).toBe(1);
  });

  test('captures MPN only as the last fallback and marks it in audit reasons', () => {
    const mirror = buildSeed({ mpn: ' MPN-ABC-123 ' });
    expect(mirror.skus[0].sku.barcode).toBe('MPN-ABC-123');
    expect(mirror.skus[0].sku.sku_payload.strong_identifier_kind).toBe('mpn');
    expect(mirror.auditReasons.mpn_captured_as_barcode).toBe(1);
  });
});

describe('sync-external-seeds-to-catalog variant prices', () => {
  test('maps reviewed formula variants into visible catalog option labels', () => {
    const mirror = buildMirror({
      id: 'eps_lime_eye_patch',
      external_product_id: 'ext_lime_eye_patch',
      market: 'US',
      domain: 'en.limecosmetic.com',
      title: 'LIME OIL GEL EYE PATCH',
      image_url: 'https://cdn.example.com/eye-patch.jpg',
      price_amount: 18.37,
      price_currency: 'USD',
      availability: 'in_stock',
      canonical_url: 'https://en.limecosmetic.com/product/detail.html?product_no=72&item_code=P00000CU000A',
      status: 'active',
      identity_listing: {
        identity_status: 'approved',
        live_read_enabled: false,
        review_required: false,
        sellable_item_group_id: 'sig_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        source_tier: 'brand',
      },
      seed_data: {
        brand: 'LIME COSMETIC',
        description: 'A reviewed eye patch with source-backed directions and full ingredient tables.',
        variants: [
          {
            variant_id: 'P00000CU000A',
            sku: 'P00000CU000A',
            option_name: 'Select',
            option_value: '20 TWENTY',
            axis_kind: 'formula_variant',
            price: '18.37',
            currency: 'USD',
            image_url: 'https://cdn.example.com/eye-patch.jpg',
          },
        ],
      },
    });

    expect(mirror.skus[0].sku.visible_attributes).toEqual({ Formula: '20 TWENTY' });
    expect(mirror.skus[0].sku.visible_option_labels).toEqual({ Formula: '20 TWENTY' });
    expect(mirror.skus[0].sku.sku_payload.options).toEqual({ Formula: '20 TWENTY' });
  });

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
