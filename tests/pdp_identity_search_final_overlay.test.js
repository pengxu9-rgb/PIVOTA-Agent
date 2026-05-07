const nock = require('nock');

describe('PDP identity search final overlay', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      PIVOTA_API_BASE: 'http://localhost:8080',
      PIVOTA_API_KEY: 'test-token',
    };
  });

  afterEach(() => {
    nock.cleanAll();
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
            name: 'KraveBeauty Great Barrier Relief',
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

  test('hydrates savings evidence for grouped search products and selected offers', async () => {
    const app = require('../src/server');
    const { hydrateSearchSavingsPresentationFromUpstream } = app._debug;

    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (payload) => {
        const ref = payload?.payload?.product || {};
        return (
          payload?.operation === 'get_product_detail' &&
          ref.merchant_id === 'merch_efbc46b4619cfbdf' &&
          ref.product_id === '10064558096681'
        );
      })
      .reply(200, {
        product: {
          merchant_id: 'merch_efbc46b4619cfbdf',
          product_id: '10064558096681',
          store_discount_evidence: {
            pricing_confidence: 'metadata_available',
            offers: [{ label: 'PIVOTA_TEST_AMOUNT10', status: 'available' }],
          },
          payment_offer_evidence: {
            pricing_confidence: 'display_estimate',
            offers: [{ payment_offer_id: 'pay_1', label: 'Card offer available' }],
          },
          store_discount_badges: ['Code PIVOTA_TEST_AMOUNT10'],
          payment_offer_badges: ['Card offer available'],
        },
      });

    const response = await hydrateSearchSavingsPresentationFromUpstream({
      operation: 'find_products_multi',
      responseBody: {
        products: [
          {
            merchant_id: 'merch_efbc46b4619cfbdf',
            product_id: '10064558096681',
            title: 'KraveBeauty Great Barrier Relief',
            offer_source: 'group_fused',
            offers_count: 2,
            offers: [
              {
                merchant_id: 'merch_efbc46b4619cfbdf',
                product_id: '10064558096681',
                product_ref: {
                  merchant_id: 'merch_efbc46b4619cfbdf',
                  product_id: '10064558096681',
                },
              },
              {
                merchant_id: 'external_seed',
                product_id: 'ext_krave_gbr_45',
              },
            ],
          },
        ],
        metadata: {},
      },
    });

    expect(response.metadata).toEqual(
      expect.objectContaining({
        savings_presentation_hydrated: true,
      }),
    );
    expect(response.products[0].store_discount_evidence).toBeUndefined();
    expect(response.products[0].payment_offer_evidence).toBeUndefined();
    expect(response.products[0].offers[0]).toEqual(
      expect.objectContaining({
        store_discount_evidence: expect.objectContaining({
          pricing_confidence: 'metadata_available',
        }),
        payment_offer_evidence: expect.objectContaining({
          pricing_confidence: 'display_estimate',
        }),
      }),
    );
    expect(response.products[0].offers[1].store_discount_evidence).toBeUndefined();
  });

  test('projects find_products_multi transport payload to search-card fields', () => {
    const app = require('../src/server');
    const { projectFindProductsMultiTransportResponse } = app._debug;
    const heavySavings = { sections: Array.from({ length: 20 }, (_, index) => ({ index, text: 'x'.repeat(500) })) };

    const response = projectFindProductsMultiTransportResponse(
      {
        products: [
          {
            merchant_id: 'merch_pet',
            product_id: 'prod_1',
            title: 'Warm Dog Jacket',
            description: 'd'.repeat(1400),
            price: 12,
            currency: 'USD',
            image_url: 'https://example.test/1.jpg',
            details: { should_not_ship_on_search: true },
            pdp: { should_not_ship_on_search: true },
            offers: Array.from({ length: 8 }, (_, index) => ({
              offer_id: `offer_${index}`,
              merchant_id: 'merch_pet',
              variant_id: `variant_${index}`,
              price: 12 + index,
              currency: 'USD',
              savings_presentation: heavySavings,
              payment_offer_summary: { available: true },
            })),
            variants: Array.from({ length: 12 }, (_, index) => ({
              id: `variant_${index}`,
              title: `Size ${index}`,
              price: 12 + index,
              inventory_quantity: 5,
              admin_graphql_api_id: `gid://shopify/ProductVariant/${index}`,
            })),
          },
        ],
        metadata: {},
      },
      { operation: 'find_products_multi' },
    );

    expect(response.products[0].details).toBeUndefined();
    expect(response.products[0].pdp).toBeUndefined();
    expect(response.products[0].description.length).toBeLessThanOrEqual(900);
    expect(response.products[0].offers).toHaveLength(3);
    expect(response.products[0].offers[0].savings_presentation).toBeUndefined();
    expect(response.products[0].variants).toHaveLength(8);
    expect(response.products[0].variants[0].admin_graphql_api_id).toBeUndefined();
    expect(response.products[0].offers_count).toBe(8);
    expect(response.products[0].variants_count).toBe(12);
    expect(response.metadata.search_transport_projection).toEqual(
      expect.objectContaining({
        applied: true,
        trimmed_offers: 5,
        trimmed_variants: 4,
      }),
    );
  });
});
