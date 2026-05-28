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

  test('uses high-confidence eye treatment title over stale makeup metadata', () => {
    const category = inferCatalogMirrorCategory({
      title: 'Regenerating Eye Cream',
      domain: 'baiebotanique.com',
      seed_data: {
        product_type: 'Bronzer',
        category: 'Bronzer',
        category_path: 'beauty/makeup/face/bronzer',
        description: 'A skincare eye cream with source-backed use directions.',
        snapshot: {
          product_type: 'Bronzer',
          category_path: 'beauty/makeup/face/bronzer',
        },
      },
    });

    expect(category).toEqual({
      productType: 'Eye Treatment',
      category: 'Eye Treatment',
      categoryPath: 'beauty/skincare/eye-care',
    });
  });

  test('uses high-confidence eye treatment title over stale makeup product type', () => {
    const category = inferCatalogMirrorCategory({
      title: 'Regenerating Eye Cream',
      domain: 'baiebotanique.com',
      seed_data: {
        product_type: 'Bronzer',
        category: 'Bronzer',
        description: 'A skincare eye cream with source-backed use directions.',
        snapshot: {
          product_type: 'Bronzer',
        },
      },
    });

    expect(category).toEqual({
      productType: 'Eye Treatment',
      category: 'Eye Treatment',
      categoryPath: 'beauty/skincare/eye-care',
    });
  });

  test('keeps single makeup remover wipes out of generic set category', () => {
    const category = inferCatalogMirrorCategory({
      title: 'Makeup Remover | Ultimate Makeup Remover Wipe',
      domain: 'rmsbeauty.com',
      seed_data: {
        product_kind: 'set_or_collection',
        category: 'Beauty Set',
        description: 'Pure, clean, and simple make-up remover and cleansing wipes.',
        snapshot: {},
      },
    });

    expect(category).toEqual({
      productType: 'Makeup Remover Wipes',
      category: 'Makeup Remover Wipes',
      categoryPath: 'beauty/skincare/cleanser',
    });
  });

  test('overrides stale bundle product kind in mirror payload for single makeup remover wipes', () => {
    const mirror = buildMirror({
      id: 'eps_rms_wipe',
      external_product_id: 'ext_rms_wipe',
      market: 'US',
      domain: 'rmsbeauty.com',
      title: 'Makeup Remover | Ultimate Makeup Remover Wipe',
      image_url: 'https://cdn.example.com/wipe.jpg',
      price_amount: 6,
      price_currency: 'USD',
      availability: 'in_stock',
      canonical_url: 'https://www.rmsbeauty.com/products/ultimate-makeup-remover-wipe',
      status: 'active',
      identity_listing: {
        identity_status: 'approved',
        live_read_enabled: true,
        review_required: false,
        source_tier: 'brand',
      },
      seed_data: {
        brand: 'RMS Beauty',
        product_kind: 'bundle',
        category: 'Beauty Set',
        description: 'Pure, clean, and simple make-up remover and cleansing wipes.',
        snapshot: {
          product_kind: 'bundle',
          category: 'Beauty Set',
        },
      },
    });

    expect(mirror.product.product_payload.product_type).toBe('Makeup Remover Wipes');
    expect(mirror.product.product_payload.product_kind).toBe('single_formula');
    expect(mirror.product.product_payload.product_family).toBe('single_formula');
    expect(mirror.product.product_payload.external_seed_product_family).toBe('single_formula');
    expect(mirror.product.product_payload.snapshot.product_kind).toBe('single_formula');
    expect(mirror.product.product_payload.snapshot.product_family).toBe('single_formula');
  });

  test('keeps skincare bundles out of single-formula skincare categories', () => {
    const category = inferCatalogMirrorCategory({
      title: 'The Daily Duo: Foaming Face Wash + Moisturiser',
      domain: 'upcirclebeauty.com',
      seed_data: {
        product_kind: 'bundle',
        category: 'Skincare Set',
        description:
          'A daily bundle including Powder to Foam Face Wash and Face Moisturiser.',
        variants: [{ title: '60ml' }],
      },
    });

    expect(category).toEqual({
      productType: 'Skincare Set',
      category: 'Skincare Set',
      categoryPath: 'beauty/skincare/sets',
    });
  });

  test('keeps fragrance pairs in fragrance set category', () => {
    const category = inferCatalogMirrorCategory({
      title: 'Eau De Parfum Set - Flaura + Santelle',
      domain: 'upcirclebeauty.com',
      seed_data: {
        category: 'Beauty Product',
        description: 'A pair of eau de parfum scents in one set.',
        snapshot: {},
      },
    });

    expect(category).toEqual({
      productType: 'Fragrance Set',
      category: 'Fragrance Set',
      categoryPath: 'beauty/fragrance/sets',
    });
  });

  test('does not classify fragrance-free skincare set copy as fragrance', () => {
    const category = inferCatalogMirrorCategory({
      title: 'The Sensitive Skin Bundle',
      domain: 'upcirclebeauty.com',
      seed_data: {
        product_kind: 'bundle',
        category: 'Skincare Set',
        description:
          'A gentle skincare routine for sensitive skin. The formulas are fragrance-free.',
        snapshot: {},
      },
    });

    expect(category).toEqual({
      productType: 'Skincare Set',
      category: 'Skincare Set',
      categoryPath: 'beauty/skincare/sets',
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
  test('does not surface promo copy as a single-SKU option label', () => {
    const mirror = buildMirror({
      id: 'eps_upcircle_hydration',
      external_product_id: 'ext_upcircle_hydration',
      market: 'US',
      domain: 'upcirclebeauty.com',
      title: 'Hydration Skincare Set',
      image_url: 'https://cdn.example.com/hydration.jpg',
      price_amount: 53,
      price_currency: 'USD',
      availability: 'in_stock',
      canonical_url: 'https://upcirclebeauty.com/products/the-hydration-bundle',
      status: 'active',
      identity_listing: {
        identity_status: 'approved',
        live_read_enabled: false,
        review_required: false,
        sellable_item_group_id: 'sig_dddddddddddddddddddddddddddddddd',
        source_tier: 'brand',
      },
      seed_data: {
        brand: 'UpCircle Beauty',
        description:
          'A reviewed hydration skincare bundle with source-backed product content and current commerce details.',
        category: 'Skincare Set',
        product_kind: 'bundle',
        variants: [
          {
            variant_id: '39618230288550',
            sku: 'THB',
            title: 'Save 10% On Oil + Moisturiser Bundle',
            option_name: 'Title',
            option_value: 'Save 10% On Oil + Moisturiser Bundle',
            options: [
              {
                name: 'Title',
                value: 'Save 10% On Oil + Moisturiser Bundle',
              },
            ],
            price: '53.00',
            currency: 'USD',
            image_url: 'https://cdn.example.com/hydration.jpg',
          },
        ],
      },
    });

    expect(mirror.skus[0].sku.title).toBe('Hydration Skincare Set');
    expect(mirror.skus[0].sku.visible_attributes).toEqual({});
    expect(mirror.skus[0].sku.visible_option_labels).toEqual({});
    expect(mirror.skus[0].offer.offer_payload.variant_title).toBe('Hydration Skincare Set');
  });

  test('does not surface purchase-flow labels as shade options', () => {
    const mirror = buildMirror({
      id: 'eps_upcircle_repeat',
      external_product_id: 'ext_upcircle_repeat',
      market: 'US',
      domain: 'upcirclebeauty.com',
      title: 'Hydration Skincare Set',
      image_url: 'https://cdn.example.com/hydration.jpg',
      price_amount: 53,
      price_currency: 'USD',
      availability: 'in_stock',
      canonical_url: 'https://upcirclebeauty.com/products/the-hydration-bundle',
      status: 'active',
      identity_listing: {
        identity_status: 'approved',
        live_read_enabled: false,
        review_required: false,
        sellable_item_group_id: 'sig_dddddddddddddddddddddddddddddddd',
        source_tier: 'brand',
      },
      seed_data: {
        brand: 'UpCircle Beauty',
        description:
          'A reviewed hydration skincare bundle with source-backed product content and current commerce details.',
        category: 'Skincare Set',
        product_kind: 'bundle',
        variants: [
          {
            variant_id: '39618376269990',
            sku: 'THB-REFILL',
            title: 'Plastic Free Repeat Order',
            option_name: 'Title',
            option_value: 'Plastic Free Repeat Order',
            options: [
              {
                name: 'Title',
                value: 'Plastic Free Repeat Order',
              },
            ],
            price: '53.00',
            currency: 'USD',
            image_url: 'https://cdn.example.com/hydration.jpg',
          },
        ],
      },
    });

    expect(mirror.skus[0].sku.title).toBe('Hydration Skincare Set');
    expect(mirror.skus[0].sku.visible_attributes).toEqual({});
    expect(mirror.skus[0].sku.visible_option_labels).toEqual({});
    expect(mirror.skus[0].offer.offer_payload.variant_title).toBe('Hydration Skincare Set');
  });

  test('does not surface generic single item labels as SKU options', () => {
    const mirror = buildMirror({
      id: 'eps_single_item',
      external_product_id: 'ext_single_item_serum',
      market: 'US',
      domain: 'murad.com',
      title: 'Gentle Glycolic Acid Resurfacing Serum',
      image_url: 'https://cdn.example.com/serum.jpg',
      price_amount: 65,
      price_currency: 'USD',
      availability: 'in_stock',
      canonical_url: 'https://www.murad.com/products/heartleaf-gentle-resurfacing-serum',
      status: 'active',
      identity_listing: {
        identity_status: 'approved',
        live_read_enabled: true,
        review_required: false,
        sellable_item_group_id: 'sig_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        source_tier: 'brand',
      },
      seed_data: {
        brand: 'Murad',
        description:
          'A reviewed serum with source-backed product content and current commerce details.',
        variants: [
          {
            variant_id: '50559680610607',
            sku: '15014',
            title: 'Single item',
            option_name: 'Format',
            option_value: 'Single item',
            options: [
              {
                name: 'Format',
                value: 'Single item',
                axis_kind: 'format',
              },
            ],
            price: '65.00',
            currency: 'USD',
            image_url: 'https://cdn.example.com/serum.jpg',
          },
        ],
      },
    });

    expect(mirror.skus[0].sku.title).toBe('Gentle Glycolic Acid Resurfacing Serum');
    expect(mirror.skus[0].sku.visible_attributes).toEqual({});
    expect(mirror.skus[0].sku.visible_option_labels).toEqual({});
    expect(mirror.skus[0].offer.offer_payload.variant_title).toBe('Gentle Glycolic Acid Resurfacing Serum');
  });

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
