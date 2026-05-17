jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

const ORIGINAL_ENV = process.env;

function loadServerWithDb(envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    ...envOverrides,
  };
  const db = require('../src/db');
  db.query.mockReset();
  const app = require('../src/server');
  return { db, debug: app._debug };
}

describe('find_products catalog identity hydration', () => {
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('adds signature and product group fields to merchant product cards', async () => {
    const { db, debug } = loadServerWithDb();
    db.query.mockResolvedValueOnce({
      rows: [
        {
          merchant_id: 'merch_1',
          source_product_id: '10064558129449',
          product_key: 'prod::merch_1::shopify::10064558129449',
          pivota_signature_id: 'sig_174dca24d4ffc297db0c3865d54b712b',
        },
      ],
    });

    const hydrated = await debug.hydrateFindProductsCatalogIdentityFields({
      products: [
        {
          product_id: '10064558129449',
          merchant_id: 'merch_1',
          title: 'Winona Soothing Repair Serum',
        },
      ],
      metadata: { query_source: 'agent_v2' },
    });

    expect(hydrated.products[0]).toEqual(
      expect.objectContaining({
        product_id: '10064558129449',
        merchant_id: 'merch_1',
        pivota_signature_id: 'sig_174dca24d4ffc297db0c3865d54b712b',
        signature_id: 'sig_174dca24d4ffc297db0c3865d54b712b',
        product_key: 'prod::merch_1::shopify::10064558129449',
      }),
    );
    expect(hydrated.metadata.catalog_identity_hydration).toEqual({
      attempted: true,
      hydrated_count: 1,
    });
  });

  test('hydrates PDP products with catalog signature without rewriting source product id', async () => {
    const { db, debug } = loadServerWithDb();
    db.query.mockResolvedValueOnce({
      rows: [
        {
          merchant_id: 'merch_1',
          platform: 'shopify',
          source_product_id: '10064558129449',
          product_key: 'prod::merch_1::shopify::10064558129449',
          pivota_signature_id: 'sig_174dca24d4ffc297db0c3865d54b712b',
        },
      ],
    });

    const identity = await debug.resolveCatalogIdentityForProductRef({
      merchantId: 'merch_1',
      productId: '10064558129449',
    });
    const hydrated = debug.applyCatalogIdentityToPdpProduct(
      {
        product_id: '10064558129449',
        merchant_id: 'merch_1',
        title: 'Winona Soothing Repair Serum',
      },
      identity,
    );

    expect(hydrated).toEqual(
      expect.objectContaining({
        product_id: '10064558129449',
        merchant_id: 'merch_1',
        source_product_id: '10064558129449',
        product_key: 'prod::merch_1::shopify::10064558129449',
        pivota_signature_id: 'sig_174dca24d4ffc297db0c3865d54b712b',
        signature_id: 'sig_174dca24d4ffc297db0c3865d54b712b',
        pivota_canonical_url: 'https://agent.pivota.cc/products/sig_174dca24d4ffc297db0c3865d54b712b',
      }),
    );
  });

  test('hydrates PDP products with catalog category path to correct stale source payload categories', async () => {
    const { db, debug } = loadServerWithDb();
    db.query.mockResolvedValueOnce({
      rows: [
        {
          merchant_id: 'external_seed',
          platform: 'external_seed',
          source_product_id: 'ext_eaze_drop_10',
          product_key: 'prod::external_seed::external_seed::ext_eaze_drop_10',
          pivota_signature_id: 'sig_eazedrop10',
          category: null,
          product_type: null,
          category_path: 'beauty/makeup/face/foundation',
          category_label_source: 'regex_backfill',
          category_confidence: 0.85,
          sellable_item_group_id: 'sig_eazedrop10',
          product_line_id: 'pl_eaze_drop',
          review_family_id: 'pl_eaze_drop',
          identity_confidence: 0.96,
          match_basis: ['official_dtc_exact_url'],
        },
      ],
    });

    const identity = await debug.resolveCatalogIdentityForProductRef({
      merchantId: 'external_seed',
      productId: 'ext_eaze_drop_10',
    });
    const hydrated = debug.applyCatalogIdentityToPdpProduct(
      {
        product_id: 'ext_eaze_drop_10',
        merchant_id: 'external_seed',
        title: 'Eaze Drop Blur + Smooth Tint Stick - 10',
        category: 'Brush',
        pdp_ingredients_raw: 'DIMETHICONE, OCTYLDODECANOL, SYNTHETIC WAX, SILICA.',
      },
      identity,
    );

    expect(hydrated).toEqual(
      expect.objectContaining({
        product_id: 'ext_eaze_drop_10',
        source_product_id: 'ext_eaze_drop_10',
        product_key: 'prod::external_seed::external_seed::ext_eaze_drop_10',
        catalog_category_path: 'beauty/makeup/face/foundation',
        category_path: ['beauty', 'makeup', 'face', 'foundation'],
        category: 'Brush',
        pdp_schema_profile: 'beauty_formula',
        category_label_source: 'regex_backfill',
        category_confidence: 0.85,
        sellable_item_group_id: 'sig_eazedrop10',
        product_group_id: 'sig_eazedrop10',
        product_line_id: 'pl_eaze_drop',
        review_family_id: 'pl_eaze_drop',
      }),
    );
  });

  test('hydrates direct external seed PDP products from approved identity listing when catalog row is missing', async () => {
    const { db, debug } = loadServerWithDb();
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            merchant_id: 'external_seed',
            platform: 'external_seed',
            source_product_id: 'ext_catkin_c06',
            pivota_signature_id: 'sig_catkinc06',
            sellable_item_group_id: 'sig_catkinc06',
            product_line_id: 'pl_catkin_glossy_lip_balm',
            review_family_id: 'pl_catkin_glossy_lip_balm',
            identity_confidence: 0.98,
            match_basis: ['official_dtc_variant'],
            identity_status: 'approved',
            live_read_enabled: true,
            review_required: false,
          },
        ],
      });

    const identity = await debug.resolveCatalogIdentityForProductRef({
      merchantId: 'external_seed',
      productId: 'ext_catkin_c06',
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(String(db.query.mock.calls[1][0])).toContain('FROM pdp_identity_listing pil');
    expect(identity).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        platform: 'external_seed',
        source_product_id: 'ext_catkin_c06',
        pivota_signature_id: 'sig_catkinc06',
        signature_id: 'sig_catkinc06',
        sellable_item_group_id: 'sig_catkinc06',
        product_group_id: 'sig_catkinc06',
        product_line_id: 'pl_catkin_glossy_lip_balm',
        review_family_id: 'pl_catkin_glossy_lip_balm',
        identity_confidence: 0.98,
        match_basis: ['official_dtc_variant'],
        identity_status: 'approved',
        live_read_enabled: true,
        review_required: false,
      }),
    );
  });
});
