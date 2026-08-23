const {
  buildSourceRows,
} = require('../../scripts/drain-commerce-index-search-index');

describe('drain-commerce-index-search-index', () => {
  test('builds serving input from canonical products and offers without exposing source credentials', () => {
    const rows = buildSourceRows([{
      product_key: 'prod::merchant_1::shopify::100',
      merchant_id: 'merchant_1',
      source_product_id: '100',
      title: 'Cleanser',
      description: 'Gentle daily cleanser',
      brand: 'Pivota',
      product_payload: { tags: ['cleanser'] },
      offers: [{
        offer_id: 'offer_1',
        sku_key: 'sku_1',
        availability: 'in_stock',
        inventory_quantity: 3,
        currency: 'USD',
        merchant_effective_price: '24.50',
        offer_payload: { source_ref: 'shopify:event:1' },
      }],
    }]);

    expect(rows).toHaveLength(1);
    expect(rows[0].product.product_id).toBe('100');
    expect(rows[0].product.offers[0]).toMatchObject({
      offer_id: 'offer_1', price: 24.5, availability: 'in_stock', inventory_quantity: 3,
    });
    expect(rows[0].source_meta).toMatchObject({ product_key: 'prod::merchant_1::shopify::100' });
    expect(JSON.stringify(rows)).not.toContain('api_key');
  });
});
