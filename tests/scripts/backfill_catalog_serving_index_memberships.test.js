const {
  seedDocumentMemberships,
} = require('../../scripts/backfill-catalog-serving-index');

describe('backfill-catalog-serving-index membership seed', () => {
  test('upserts one source-ref pointer per published document member', async () => {
    const calls = [];
    const written = await seedDocumentMemberships([
      { doc_id: 'doc-a', source_refs: ['merchant_a:100', 'merchant_a:101', 'merchant_a:100'] },
      { doc_id: 'doc-b', source_refs: ['merchant_b:200'] },
    ], {
      queryFn: async (sql, values) => {
        calls.push({ sql, values });
        return { rowCount: 3 };
      },
    });

    expect(written).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('commerce_index_search_memberships');
    expect(calls[0].sql).toContain('ON CONFLICT (source_ref) DO UPDATE');
    expect(calls[0].values).toEqual([
      ['merchant_a:100', 'merchant_a:101', 'merchant_b:200'],
      ['doc-a', 'doc-a', 'doc-b'],
    ]);
  });

  test('does not write when the backfill produced no published memberships', async () => {
    const queryFn = jest.fn();
    await expect(seedDocumentMemberships([], { queryFn })).resolves.toBe(0);
    expect(queryFn).not.toHaveBeenCalled();
  });
});
