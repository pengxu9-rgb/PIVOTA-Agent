const { buildExternalSeedProduct } = require('../../src/services/externalSeedProducts');

describe('externalSeedProducts variant axes', () => {
  test('preserves reviewed skin undertone as a displayable shade axis', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_aetas_serum',
      external_product_id: 'ext_aetas_serum',
      market: 'US',
      tool: 'creator_agents',
      destination_url: 'https://aetasofficial.com/en/products/serum?country=US',
      canonical_url: 'https://aetasofficial.com/en/products/serum?country=US',
      domain: 'aetasofficial.com',
      title: 'The Serum',
      image_url: 'https://aetasofficial.com/cdn/shop/files/serum.jpg',
      price_amount: 60,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Aetas',
        title: 'The Serum',
        description: 'Booster serums for warm and cool skin undertones.',
        product_type: 'Face Serum',
        variants: [
          {
            variant_id: '46009531236507',
            sku: '400',
            option_name: 'Skin Undertone',
            option_value: 'beta cool',
            axis_kind: 'shade',
            price: '60',
            currency: 'USD',
            stock: 'In Stock',
            image_url: 'https://aetasofficial.com/cdn/shop/files/serum-beta.png',
          },
        ],
      },
    });

    expect(product.variants[0]).toEqual(
      expect.objectContaining({
        option_name: 'Shade',
        option_value: 'beta cool',
        axis_kind: 'shade',
        display_label: 'Shade: beta cool',
        source_quality_status: 'captured',
      }),
    );
  });
});
