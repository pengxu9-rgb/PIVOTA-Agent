jest.mock('../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
}));

const { query } = require('../src/db');
const {
  vectorSearchCreatorProductsFromCache,
  pickVectorColumn,
} = require('../src/services/productsCacheVectorSearch');

describe('products_cache vector recall SQL', () => {
  beforeEach(() => {
    query.mockClear();
  });

  test('pickVectorColumn supports 768 and 1536', () => {
    expect(pickVectorColumn(768)).toBe('embedding_768');
    expect(pickVectorColumn(1536)).toBe('embedding_1536');
    expect(() => pickVectorColumn(1024)).toThrow(/Unsupported embedding dim/);
  });

  test('vector recall uses embedding_768 and includes provider/model/dim filters', async () => {
    await vectorSearchCreatorProductsFromCache({
      merchantIds: ['merch_x'],
      queryVector: [0.1, 0.2],
      dim: 768,
      provider: 'gemini',
      model: 'text-embedding-004',
      limit: 25,
      intentTarget: 'pet',
      excludeUnderwear: true,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];

    expect(sql).toContain('products_cache_embeddings');
    expect(sql).toContain('embedding_768');
    expect(sql).toContain('provider = $3');
    expect(sql).toContain('model = $4');
    expect(sql).toContain('dim = $5');

    expect(params[0]).toEqual(['merch_x']); // merchantIds
    expect(typeof params[1]).toBe('string'); // vector literal
    expect(params[2]).toBe('gemini');
    expect(params[3]).toBe('text-embedding-004');
    expect(params[4]).toBe(768);
  });
});

