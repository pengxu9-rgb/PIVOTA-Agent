const {
  uniqueStrings,
  createCreatorCacheDiagnostics,
} = require('../../src/commerce/catalog/creatorCacheDiagnostics');

describe('creatorCacheDiagnostics', () => {
  test('uniqueStrings trims, dedupes, and removes empty values', () => {
    expect(uniqueStrings(['  a ', 'b', 'a', '', null, ' b '])).toEqual(['a', 'b']);
  });

  test('probeCreatorCacheDbStats returns null when route debug is disabled and force is false', async () => {
    const { probeCreatorCacheDbStats } = createCreatorCacheDiagnostics({
      queryDb: jest.fn(),
      buildSellableStatusPredicate: jest.fn(() => 'TRUE'),
      buildPetSignalSql: jest.fn(() => ({ sql: 'TRUE', params: [] })),
      routeDebugEnabled: false,
      databaseUrl: 'postgres://example',
    });

    await expect(probeCreatorCacheDbStats(['m1'], 'pet')).resolves.toBeNull();
  });

  test('probeCreatorCacheDbStats returns count diagnostics when query succeeds', async () => {
    const queryDb = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ c: 9 }] })
      .mockResolvedValueOnce({ rows: [{ c: 7 }] })
      .mockResolvedValueOnce({ rows: [{ c: 4 }] })
      .mockResolvedValueOnce({ rows: [{ c: 2 }] });
    const { probeCreatorCacheDbStats } = createCreatorCacheDiagnostics({
      queryDb,
      buildSellableStatusPredicate: jest.fn(() => 'TRUE'),
      buildPetSignalSql: jest.fn(() => ({ sql: 'TRUE', params: [] })),
      routeDebugEnabled: false,
      databaseUrl: 'postgres://example',
    });

    await expect(
      probeCreatorCacheDbStats(['m1', 'm2'], 'pet', { force: true }),
    ).resolves.toEqual({
      db_configured: true,
      merchant_ids_count: 2,
      products_cache_total: 9,
      products_cache_sellable_total: 7,
      products_cache_pet_signal_sellable_total: 4,
      embeddings_fallback_total: 2,
    });
    expect(queryDb).toHaveBeenCalledTimes(4);
  });

  test('probeCreatorCacheDbStats returns error envelope when query fails', async () => {
    const { probeCreatorCacheDbStats } = createCreatorCacheDiagnostics({
      queryDb: jest.fn().mockRejectedValue(new Error('db down')),
      buildSellableStatusPredicate: jest.fn(() => 'TRUE'),
      buildPetSignalSql: jest.fn(() => ({ sql: 'TRUE', params: [] })),
      routeDebugEnabled: true,
      databaseUrl: 'postgres://example',
    });

    await expect(probeCreatorCacheDbStats(['m1'], 'unknown')).resolves.toEqual({
      db_configured: true,
      merchant_ids_count: 1,
      error: 'db down',
    });
  });
});
