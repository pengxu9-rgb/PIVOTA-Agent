jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
  withClient: jest.fn(),
}));

const { query } = require('../../src/db');
const { fetchRows } = require('../../scripts/backfill-external-product-seeds-catalog');

describe('backfill-external-product-seeds-catalog fetchRows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('supports stable seed-id-file ordering via seedIds', async () => {
    await fetchRows({
      market: 'US',
      seedIds: ['eps_beta', 'eps_alpha'],
      limit: 2,
      offset: 0,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('id::text = ANY($2::text[])');
    expect(sql).toContain('array_position($2::text[], id::text) ASC NULLS LAST');
    expect(params).toEqual(['US', ['eps_beta', 'eps_alpha'], 2, 0]);
  });
});
