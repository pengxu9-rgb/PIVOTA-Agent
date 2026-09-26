const { backfillCatalogServingIndex } = require('../../src/services/catalogServingIndex');

describe('catalog serving publication memberships', () => {
  test('returns stable source-ref membership pointers without returning full documents', async () => {
    const result = await backfillCatalogServingIndex(
      { dryRun: true, includeNonPublic: true },
      {
        fetchBackfillProductsFn: async () => ([{
          merchant_id: 'merchant_1',
          product_id: 'product_1',
          source_kind: 'internal',
          product: { id: 'product_1', title: 'Cleanser', price: 20 },
        }]),
        identityRowsResolverFn: async () => ([{
          source_listing_ref: 'merchant_1:product_1',
          identity_status: 'approved',
          live_read_enabled: true,
          sellable_item_group_id: 'group_1',
        }]),
      },
    );

    expect(result.document_memberships).toEqual([{
      doc_id: 'sellable:group_1', source_refs: ['merchant_1:product_1'],
    }]);
    expect(result.document_memberships[0]).not.toHaveProperty('title');
  });
});
