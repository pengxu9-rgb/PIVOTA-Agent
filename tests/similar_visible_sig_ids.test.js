const app = require('../src/server');

describe('visible similar product ids', () => {
  test('promotes catalog sig ids to product_id and preserves ext source ids', () => {
    const product = app._debug.promoteVisibleSimilarProductSigId({
      product_id: 'ext_7202e72bf7892c9ca5b6a80a',
      id: 'ext_7202e72bf7892c9ca5b6a80a',
      pivota_signature_id: 'sig_5ff9c1f1657886217e5ae75f',
      platform_product_id: 'ext_7202e72bf7892c9ca5b6a80a',
      title: 'Cherry Dub Pore Purifyr Gel Cleanser',
    });

    expect(product).toEqual(
      expect.objectContaining({
        product_id: 'sig_5ff9c1f1657886217e5ae75f',
        id: 'sig_5ff9c1f1657886217e5ae75f',
        pivota_signature_id: 'sig_5ff9c1f1657886217e5ae75f',
        source_product_id: 'ext_7202e72bf7892c9ca5b6a80a',
        external_product_id: 'ext_7202e72bf7892c9ca5b6a80a',
        platform_product_id: 'ext_7202e72bf7892c9ca5b6a80a',
      }),
    );
  });

  test('does not expose review-required sellable sig ids as public product ids', () => {
    const input = {
      product_id: 'ext_7202e72bf7892c9ca5b6a80a',
      id: 'ext_7202e72bf7892c9ca5b6a80a',
      sellable_item_group_id: 'sig_review_required',
      identity_status: 'review_required',
      live_read_enabled: false,
      review_required: true,
      title: 'Needs identity review',
    };

    expect(app._debug.promoteVisibleSimilarProductSigId(input)).toBe(input);
  });

  test('promotes approved live-read sellable sig ids when no catalog sig is present', () => {
    const product = app._debug.promoteVisibleSimilarProductSigId({
      product_id: 'ext_7202e72bf7892c9ca5b6a80a',
      id: 'ext_7202e72bf7892c9ca5b6a80a',
      sellable_item_group_id: 'sig_5ff9c1f1657886217e5ae75f',
      identity_status: 'approved',
      live_read_enabled: true,
      review_required: false,
      title: 'Approved grouped item',
    });

    expect(product).toEqual(
      expect.objectContaining({
        product_id: 'sig_5ff9c1f1657886217e5ae75f',
        id: 'sig_5ff9c1f1657886217e5ae75f',
        pivota_signature_id: 'sig_5ff9c1f1657886217e5ae75f',
        source_product_id: 'ext_7202e72bf7892c9ca5b6a80a',
        external_product_id: 'ext_7202e72bf7892c9ca5b6a80a',
      }),
    );
  });

  test('collects source ext ids even when the visible id is already sig', () => {
    expect(
      app._debug.collectExternalSeedIdCandidatesForVisibleCatalogHydration({
        product_id: 'sig_5ff9c1f1657886217e5ae75f',
        id: 'sig_5ff9c1f1657886217e5ae75f',
        source_product_id: 'ext_7202e72bf7892c9ca5b6a80a',
        platform_product_id: 'ext_7202e72bf7892c9ca5b6a80a',
      }),
    ).toEqual(['ext_7202e72bf7892c9ca5b6a80a']);
  });

  test('leaves non-canonical similar items unchanged', () => {
    const product = {
      product_id: 'ext_without_sig',
      title: 'Legacy item',
    };

    expect(app._debug.promoteVisibleSimilarProductSigId(product)).toBe(product);
  });

  test('find_products_multi transport projection prefers visible sig ids', () => {
    const response = app._debug.projectFindProductsMultiTransportResponse(
      {
        products: [
          {
            product_id: 'ext_7202e72bf7892c9ca5b6a80a',
            id: 'ext_7202e72bf7892c9ca5b6a80a',
            pivota_signature_id: 'sig_5ff9c1f1657886217e5ae75f',
            title: 'Cherry Dub Pore Purifyr Gel Cleanser',
          },
        ],
      },
      { operation: 'find_products_multi' },
    );

    expect(response.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'sig_5ff9c1f1657886217e5ae75f',
        id: 'sig_5ff9c1f1657886217e5ae75f',
        pivota_signature_id: 'sig_5ff9c1f1657886217e5ae75f',
        external_product_id: 'ext_7202e72bf7892c9ca5b6a80a',
      }),
    );
  });
});
