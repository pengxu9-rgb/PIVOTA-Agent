describe('PDP identity search final overlay', () => {
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

  test('prefers the live exact product while preserving canonical grouped offers', () => {
    const app = require('../src/server');
    const { maybeOverlayFinalIdentityRecallSearchProducts } = app._debug;

    const response = maybeOverlayFinalIdentityRecallSearchProducts({
      operation: 'find_products_multi',
      queryText: 'KraveBeauty Great Barrier Relief',
      queryParams: { limit: 10 },
      responseBody: {
        products: [
          {
            merchant_id: 'merch_efbc46b4619cfbdf',
            product_id: '10008793153864',
            title: 'Great Barrier Relief',
            sellable_item_group_id: 'sig_krave_gbr',
            product_group_id: 'sig_krave_gbr',
            selected_commerce_ref: {
              merchant_id: 'merch_efbc46b4619cfbdf',
              product_id: '10008793153864',
            },
            canonical_product_ref: {
              merchant_id: 'external_seed',
              product_id: 'ext_krave_gbr_45',
            },
            offers: [
              {
                merchant_id: 'merch_efbc46b4619cfbdf',
                product_id: '10008793153864',
                product_ref: {
                  merchant_id: 'merch_efbc46b4619cfbdf',
                  product_id: '10008793153864',
                },
              },
              {
                merchant_id: 'external_seed',
                product_id: 'ext_krave_gbr_45',
                product_ref: {
                  merchant_id: 'external_seed',
                  product_id: 'ext_krave_gbr_45',
                },
              },
            ],
            offers_count: 2,
            offer_source: 'group_fused',
            pdp_content_source: 'canonical_inherited',
            search_recall_source: 'pdp_identity_graph',
          },
          {
            merchant_id: 'merch_other',
            product_id: 'unrelated',
            title: 'Unrelated Barrier Cream',
          },
          {
            merchant_id: 'merch_efbc46b4619cfbdf',
            product_id: '10064558096681',
            id: '10064558096681',
            title: 'KraveBeauty Great Barrier Relief',
            vendor: 'KraveBeauty',
            price: { amount: 28, currency: 'USD' },
          },
        ],
        metadata: {
          identity_graph_search_recall: {
            attempted: true,
            applied: true,
          },
        },
      },
    });

    expect(response.products[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'merch_efbc46b4619cfbdf',
        product_id: '10064558096681',
        sellable_item_group_id: 'sig_krave_gbr',
        offer_source: 'group_fused',
        pdp_content_source: 'canonical_inherited',
        commerce_source: 'selected_seller_store',
        offers_count: 2,
        grouped: true,
      }),
    );
    expect(response.products[0].selected_commerce_ref).toEqual({
      merchant_id: 'merch_efbc46b4619cfbdf',
      product_id: '10064558096681',
    });
    expect(response.products[0].offers.map((offer) => offer.product_id)).toEqual([
      '10064558096681',
      'ext_krave_gbr_45',
    ]);
    expect(response.products.map((product) => product.product_id)).not.toContain('10008793153864');
    expect(response.metadata.identity_graph_search_recall).toEqual(
      expect.objectContaining({
        final_live_overlay_applied: true,
        final_live_overlay_reason: 'exact_live_product_after_identity_recall',
      }),
    );
  });
});
