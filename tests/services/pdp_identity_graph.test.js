describe('pdpIdentityGraph', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('buildIdentityListingFromProduct groups exact items by strong evidence and separates sibling sizes into product lines', () => {
    const { buildIdentityListingFromProduct } = require('../../src/services/pdpIdentityGraph');

    const baseProduct = {
      title: 'KraveBeauty Great Barrier Relief 45 mL',
      brand: 'KraveBeauty',
      source_url: 'https://kravebeauty.com/products/great-barrier-relief',
      gtin: '850000111222',
      price: { amount: 28, currency: 'EUR' },
      variants: [
        {
          variant_id: 'v_45',
          title: 'Standard - 45 mL',
          option1: '45 mL',
          price: { amount: 28, currency: 'EUR' },
        },
      ],
    };

    const externalListing = buildIdentityListingFromProduct({
      merchantId: 'external_seed',
      productId: 'ext_krave_gbr_45',
      product: baseProduct,
      sourceKind: 'external_seed',
    });
    const internalListing = buildIdentityListingFromProduct({
      merchantId: 'merch_krave',
      productId: '10008793153864',
      product: {
        ...baseProduct,
        vendor: 'KraveBeauty',
      },
      sourceKind: 'internal',
    });
    const jumboListing = buildIdentityListingFromProduct({
      merchantId: 'external_seed',
      productId: 'ext_krave_gbr_100',
      product: {
        ...baseProduct,
        title: 'KraveBeauty Great Barrier Relief 100 mL',
        gtin: '850000111333',
        variants: [
          {
            variant_id: 'v_100',
            title: 'Jumbo - 100 mL',
            option1: '100 mL',
            price: { amount: 50, currency: 'EUR' },
          },
        ],
      },
      sourceKind: 'external_seed',
    });

    expect(externalListing.identity_status).toBe('approved');
    expect(externalListing.matched_by_rule).toBe('strong_gtin');
    expect(externalListing.sellable_item_group_id).toBe(internalListing.sellable_item_group_id);
    expect(externalListing.product_line_id).toBe(internalListing.product_line_id);
    expect(jumboListing.sellable_item_group_id).not.toBe(externalListing.sellable_item_group_id);
    expect(jumboListing.product_line_id).toBe(externalListing.product_line_id);
  });

  test('clusterIdentityListings bridges official seed and Shopify product variant axes without mixing sibling variants', () => {
    const { buildIdentityListingFromProduct, _internals } = require('../../src/services/pdpIdentityGraph');

    const externalStandard = buildIdentityListingFromProduct({
      merchantId: 'external_seed',
      productId: 'ext_krave_gbr_45',
      sourceKind: 'external_seed',
      product: {
        title: 'Great Barrier Relief',
        brand: 'KraveBeauty',
        source_url: 'https://kravebeauty.com/products/great-barrier-relief',
        variants: [
          {
            variant_id: 'seed-standard',
            title: 'Standard 45 mL',
            options: [{ name: 'Size', value: 'Standard 45 mL' }],
          },
        ],
      },
    });
    const internalShopifyProduct = buildIdentityListingFromProduct({
      merchantId: 'merch_krave',
      productId: '10008793153864',
      sourceKind: 'internal',
      product: {
        title: 'KraveBeauty Great Barrier Relief',
        vendor: 'KraveBeauty',
        variants: [
          {
            id: '52876964495688',
            variant_id: '52876964495688',
            title: 'Standard - 45 mL',
            price: 28,
            options: { size: 'Standard - 45 mL' },
          },
          {
            id: '52876964528456',
            variant_id: '52876964528456',
            title: 'Jumbo - 100 mL',
            price: 50,
            options: { size: 'Jumbo - 100 mL' },
          },
        ],
      },
    });

    expect(internalShopifyProduct.variant_axes).toEqual({
      size: 'standard 45 ml',
      volume: '45ml',
      multi_variant: true,
    });

    const [clusteredExternal, clusteredInternal] = _internals.clusterIdentityListings([
      externalStandard,
      internalShopifyProduct,
    ]);

    expect(clusteredExternal.sellable_item_group_id).toBe(clusteredInternal.sellable_item_group_id);
    expect(clusteredExternal.product_line_id).toBe(clusteredInternal.product_line_id);
    expect(clusteredExternal.review_family_id).toBe(clusteredInternal.review_family_id);
    expect(clusteredExternal.matched_by_rule).toBe('official_url_soft_exact_cluster');
    expect(clusteredInternal.matched_by_rule).toBe('soft_exact_cluster');
    expect(clusteredExternal.match_basis).toContain(
      'soft_exact_cluster:kravebeauty|great barrier relief|size:standard 45 ml|volume:45ml',
    );
  });

  test('composeSyntheticCanonicalProduct keeps exact-item gallery separate from product-line preview and aggregates review scope', () => {
    const { composeSyntheticCanonicalProduct } = require('../../src/services/pdpIdentityGraph');

    const requestedListing = {
      merchant_id: 'external_seed',
      product_id: 'ext_krave_gbr_45',
      source_kind: 'external_seed',
      source_tier: 'brand',
      sellable_item_group_id: 'sig_exact_45',
      product_line_id: 'pl_krave_gbr',
      review_family_id: 'rf_krave_gbr',
      identity_confidence: 0.93,
      source_payload: {
        title: 'Great Barrier Relief',
        brand: 'KraveBeauty',
        description: 'Barrier support serum.',
        images: [{ url: 'https://cdn.example.com/gbr-45-main.jpg' }],
      },
      review_summary: {
        rating: 4.5,
        review_count: 12,
      },
    };
    const siblingListing = {
      merchant_id: 'external_seed',
      product_id: 'ext_krave_gbr_100',
      source_kind: 'external_seed',
      source_tier: 'brand',
      sellable_item_group_id: 'sig_exact_100',
      product_line_id: 'pl_krave_gbr',
      review_family_id: 'rf_krave_gbr',
      identity_confidence: 0.91,
      source_payload: {
        title: 'Great Barrier Relief Jumbo',
        brand: 'KraveBeauty',
        images: [{ url: 'https://cdn.example.com/gbr-100-main.jpg' }],
      },
      review_summary: {
        rating: 4.8,
        review_count: 30,
      },
    };

    const composed = composeSyntheticCanonicalProduct({
      requestedListing,
      exactListings: [requestedListing],
      lineListings: [requestedListing, siblingListing],
    });

    expect(composed.product.canonical_scope).toBe('synthetic');
    expect(composed.product.gallery_scope).toBe('exact_item');
    expect(composed.product.preview_scope).toBe('product_line');
    expect(composed.product.images).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example.com/gbr-45-main.jpg',
        source_kind: 'external_seed',
        source_scope: 'exact_item',
      }),
    ]);
    expect(composed.product.line_preview_images).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example.com/gbr-100-main.jpg',
        source_scope: 'product_line_preview',
      }),
    ]);
    expect(composed.product.review_summary).toEqual(
      expect.objectContaining({
        aggregation_scope: 'product_line',
        exact_item_review_count: 12,
        product_line_review_count: 42,
        scoped_summaries: expect.objectContaining({
          product_line: expect.objectContaining({
            review_count: 42,
          }),
          exact_item: expect.objectContaining({
            review_count: 12,
          }),
        }),
      }),
    );
  });

  test('backfill product fetch does not depend on products_cache created_at column', async () => {
    const { _internals } = require('../../src/services/pdpIdentityGraph');
    const queries = [];
    const queryFn = jest.fn(async (sql, params) => {
      queries.push(String(sql));
      if (String(sql).includes('FROM products_cache')) {
        expect(String(sql)).not.toContain('created_at');
        expect(String(sql)).not.toContain('updated_at');
        expect(String(sql)).toContain("product_data->>'vendor'");
        expect(String(sql)).toContain("product_data->>'title'");
        expect(params).toEqual(['external_seed', 'kravebeauty', '%kravebeauty%', 10]);
        return {
          rows: [
            {
              merchant_id: 'merch_krave',
              platform_product_id: '10008793153864',
              cached_at: '2026-04-10T00:00:00Z',
              product_data: {
                product_id: '10008793153864',
                title: 'KraveBeauty Great Barrier Relief',
                brand: { name: 'KraveBeauty' },
              },
            },
          ],
        };
      }
      if (String(sql).includes('FROM external_product_seeds')) {
        expect(String(sql)).toContain("seed_data->>'vendor'");
        expect(String(sql)).toContain('lower(coalesce(title');
        expect(params).toEqual(['kravebeauty', '%kravebeauty%', 10]);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const rows = await _internals.fetchBackfillProducts({
      limit: 10,
      brandFilter: 'KraveBeauty',
      queryFn,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'merch_krave',
        product_id: '10008793153864',
        source_kind: 'internal',
      }),
    );
    expect(queries).toHaveLength(2);
  });

  test('listLivePdpIdentityRowsForRefs does not depend on PDP live-read feature flag', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://example.test/pivota',
      PDP_IDENTITY_GRAPH_ENABLED: 'false',
    };
    jest.resetModules();
    const { listLivePdpIdentityRowsForRefs } = require('../../src/services/pdpIdentityGraph');
    const queryFn = jest.fn(async () => ({
      rows: [
        {
          source_listing_ref: 'external_seed:ext_1',
          merchant_id: 'external_seed',
          product_id: 'ext_1',
          source_kind: 'external_seed',
          source_tier: 'brand',
          live_read_enabled: true,
          sellable_item_group_id: 'sig_1',
          product_line_id: 'pl_1',
          review_family_id: 'rf_1',
          identity_status: 'approved',
          identity_confidence: 0.98,
          matched_by_rule: 'official_url_soft_exact_cluster',
          match_basis: ['official_url:https://brand.example/products/ext-1'],
          strong_identity: {},
          soft_identity: {},
          variant_axes: { volume: '45ml' },
          source_payload: { title: 'Example Product' },
          review_summary: {},
          official_url: 'https://brand.example/products/ext-1',
          official_domain: 'brand.example',
          brand_norm: 'example',
          title_norm: 'example product',
          title_core_norm: 'example product',
          review_required: false,
          review_reason_codes: [],
          created_at: '2026-04-10T00:00:00Z',
          updated_at: '2026-04-10T00:00:00Z',
        },
      ],
    }));

    const rows = await listLivePdpIdentityRowsForRefs({
      sourceListingRefs: ['external_seed:ext_1'],
      queryFn,
    });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        source_listing_ref: 'external_seed:ext_1',
        identity_status: 'approved',
        live_read_enabled: true,
        sellable_item_group_id: 'sig_1',
      }),
    );
  });

  test('promotePdpIdentityLiveRead dry-run enables whole exact-item groups backed by brand source', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://example.test/pivota',
      PDP_IDENTITY_GRAPH_ENABLED: 'false',
    };
    jest.resetModules();
    const { promotePdpIdentityLiveRead } = require('../../src/services/pdpIdentityGraph');
    const candidateRow = {
      source_listing_ref: 'external_seed:ext_1',
      merchant_id: 'external_seed',
      product_id: 'ext_1',
      source_kind: 'external_seed',
      source_tier: 'brand',
      live_read_enabled: false,
      sellable_item_group_id: 'sig_1',
      product_line_id: 'pl_1',
      review_family_id: 'rf_1',
      identity_status: 'approved',
      identity_confidence: 0.98,
      match_basis: [],
      strong_identity: {},
      soft_identity: {},
      variant_axes: { volume: '45ml' },
      source_payload: { title: 'Example Product' },
      review_summary: {},
      official_domain: 'brand.example',
      brand_norm: 'example',
      title_norm: 'example product',
      title_core_norm: 'example product',
      review_required: false,
      review_reason_codes: [],
    };
    const merchantRow = {
      ...candidateRow,
      source_listing_ref: 'merch_1:prod_1',
      merchant_id: 'merch_1',
      product_id: 'prod_1',
      source_kind: 'internal',
      source_tier: 'merchant',
    };
    const queryFn = jest
      .fn()
      .mockResolvedValueOnce({ rows: [candidateRow] })
      .mockResolvedValueOnce({ rows: [candidateRow, merchantRow] });

    const result = await promotePdpIdentityLiveRead({
      brand: 'Example',
      dryRun: true,
      limit: 50,
      queryFn,
    });

    expect(result).toEqual(
      expect.objectContaining({
        dry_run: true,
        candidate_rows_scanned: 1,
        groups_considered: 1,
        groups_eligible: 1,
        rows_to_enable: 2,
        overrides_to_write: 2,
        updated_rows: 0,
        brand_filter: 'example',
      }),
    );
    expect(result.sample_refs).toEqual(
      expect.arrayContaining(['external_seed:ext_1', 'merch_1:prod_1']),
    );
  });

  test('promotePdpIdentityLiveRead writes approve_live_read overrides and updates rows', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://example.test/pivota',
    };
    jest.resetModules();
    const { promotePdpIdentityLiveRead } = require('../../src/services/pdpIdentityGraph');
    const candidateRow = {
      source_listing_ref: 'external_seed:ext_1',
      merchant_id: 'external_seed',
      product_id: 'ext_1',
      source_kind: 'external_seed',
      source_tier: 'brand',
      live_read_enabled: false,
      sellable_item_group_id: 'sig_1',
      product_line_id: 'pl_1',
      review_family_id: 'rf_1',
      identity_status: 'approved',
      identity_confidence: 0.98,
      match_basis: [],
      strong_identity: {},
      soft_identity: {},
      variant_axes: { volume: '45ml' },
      source_payload: { title: 'Example Product' },
      review_summary: {},
      official_domain: 'brand.example',
      brand_norm: 'example',
      title_norm: 'example product',
      title_core_norm: 'example product',
      review_required: false,
      review_reason_codes: [],
    };
    const merchantRow = {
      ...candidateRow,
      source_listing_ref: 'merch_1:prod_1',
      merchant_id: 'merch_1',
      product_id: 'prod_1',
      source_kind: 'internal',
      source_tier: 'merchant',
    };
    const queryFn = jest
      .fn()
      .mockResolvedValueOnce({ rows: [candidateRow] })
      .mockResolvedValueOnce({ rows: [candidateRow, merchantRow] });
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rowCount: 2 })
        .mockResolvedValueOnce({}),
    };
    const withClientFn = jest.fn(async (work) => work(client));

    const result = await promotePdpIdentityLiveRead({
      brand: 'Example',
      dryRun: false,
      limit: 50,
      createdBy: 'codex',
      queryFn,
      withClientFn,
    });

    expect(withClientFn).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    const insertCalls = client.query.mock.calls.filter((call) =>
      String(call[0]).includes('INSERT INTO pdp_identity_override'),
    );
    expect(insertCalls).toHaveLength(2);
    const updateCall = client.query.mock.calls.find((call) =>
      String(call[0]).includes('UPDATE pdp_identity_listing'),
    );
    expect(updateCall).toBeTruthy();
    expect(result).toEqual(
      expect.objectContaining({
        dry_run: false,
        groups_eligible: 1,
        rows_to_enable: 2,
        overrides_to_write: 2,
        updated_rows: 2,
      }),
    );
  });
});
