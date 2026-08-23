const { buildManifest } = require('../../scripts/drain-commerce-index-relgraph');

describe('drain-commerce-index-relgraph', () => {
  test('turns canonical product keys into graph-compatible affected refs', () => {
    const manifest = buildManifest([{
      product_key: 'merchant_1|shopify|123',
      source_product_id: '123',
      pivota_signature_id: 'sig_abc',
      content_key: 'ck_abc',
      merchant_id: 'merchant_1',
      platform: 'shopify',
      title: 'Barrier Serum',
    }], { generatedAt: '2026-08-22T00:00:00.000Z' });

    expect(manifest.affected_count).toBe(1);
    expect(manifest.product_keys).toEqual(['merchant_1|shopify|123']);
    expect(manifest.affected_refs).toEqual(expect.arrayContaining([
      'product:sig_abc',
      'merchant_1|shopify|123',
      'product:123',
      'ck_abc',
    ]));
    expect(manifest.rows[0].product_ref).toBe('product:sig_abc');
  });
});
