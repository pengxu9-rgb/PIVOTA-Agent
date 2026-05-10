const app = require('../src/server');

describe('visible similar product ids', () => {
  test('promotes sellable sig ids to product_id and preserves ext source ids', () => {
    const product = app._debug.promoteVisibleSimilarProductSigId({
      product_id: 'ext_7202e72bf7892c9ca5b6a80a',
      id: 'ext_7202e72bf7892c9ca5b6a80a',
      sellable_item_group_id: 'sig_5ff9c1f1657886217e5ae75f',
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

  test('leaves non-canonical similar items unchanged', () => {
    const product = {
      product_id: 'ext_without_sig',
      title: 'Legacy item',
    };

    expect(app._debug.promoteVisibleSimilarProductSigId(product)).toBe(product);
  });
});
