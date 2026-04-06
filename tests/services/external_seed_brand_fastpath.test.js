const {
  runExternalSeedBrandMainlineFastpath,
} = require('../../src/findProductsExternalSeedBrandFastpath');

function buildDeps(overrides = {}) {
  return {
    detectBrandEntities: () => ({ brands: ['fenty'] }),
    normalizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase(),
    buildBrandQueryVariants: (query, brands) => [query, ...(brands || [])],
    normalizeBrandText: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ''),
    buildExternalSeedBrandSearchProduct: (row) => ({
      id: row.external_product_id || row.id,
      product_id: row.external_product_id || row.id,
      merchant_id: 'external_seed',
      title: row.title,
    }),
    buildSearchProductKey: (product) => product.product_id,
    logger: { warn: jest.fn() },
    ...overrides,
  };
}

describe('runExternalSeedBrandMainlineFastpath', () => {
  test('uses a single windowed exact-brand query for covered pages', async () => {
    const queries = [];
    const deps = buildDeps({
      query: jest.fn(async (sql, params) => {
        queries.push({ sql: String(sql), params });
        return {
          rows: [
            {
              id: 'seed_1',
              external_product_id: 'fenty_1',
              title: 'Fenty Product',
              total_rows: 299,
            },
          ],
        };
      }),
    });

    const response = await runExternalSeedBrandMainlineFastpath({
      relevanceQueryText: 'fenty',
      market: 'US',
      tool: '*',
      inStockOnly: true,
      safePage: 1,
      safeLimit: 24,
      safeOffset: 0,
      deps,
    });

    expect(response?.status).toBe('success');
    expect(response?.total).toBe(299);
    expect(response?.products).toHaveLength(1);
    expect(deps.query).toHaveBeenCalledTimes(1);
    expect(queries[0].sql).toContain('COUNT(*) OVER()::int AS total_rows');
    expect(queries[0].sql).not.toContain('SELECT COUNT(*)::int AS total');
  });
});
