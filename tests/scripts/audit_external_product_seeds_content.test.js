jest.mock('../../src/db', () => ({
  query: jest.fn(),
}));

const { query } = require('../../src/db');
const { fetchRows } = require('../../scripts/audit-external-product-seeds-content');

describe('audit-external-product-seeds-content', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  test('queries only columns that exist on external_product_seeds', async () => {
    await fetchRows({
      market: 'US',
      seedId: null,
      externalProductId: null,
      domain: 'patyka.com',
      brand: null,
      limit: 10,
      offset: 0,
      includeInactive: false,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('SELECT');
    expect(sql).not.toMatch(/\bdescription\b/);
    expect(sql).toContain('seed_data');
    expect(sql).toContain('availability');
  });
});
