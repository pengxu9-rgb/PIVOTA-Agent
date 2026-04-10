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
});
