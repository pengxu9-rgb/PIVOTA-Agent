describe('productIntelKbStore memory cache', () => {
  const originalTtl = process.env.AURORA_PRODUCT_INTEL_KB_MEM_TTL_MS;

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    if (originalTtl === undefined) delete process.env.AURORA_PRODUCT_INTEL_KB_MEM_TTL_MS;
    else process.env.AURORA_PRODUCT_INTEL_KB_MEM_TTL_MS = originalTtl;
  });

  test('refreshes DB-backed KB entries after memory TTL expires', async () => {
    process.env.AURORA_PRODUCT_INTEL_KB_MEM_TTL_MS = '1';
    const dbRows = [
      {
        kb_key: 'product:ext_demo',
        analysis: { product_intel_v1: { marker: 'old' } },
        source: 'test',
        source_meta: {},
        last_success_at: '2026-04-10T00:00:00.000Z',
        last_error: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      },
      {
        kb_key: 'product:ext_demo',
        analysis: { product_intel_v1: { marker: 'fresh' } },
        source: 'test',
        source_meta: {},
        last_success_at: '2026-04-10T00:01:00.000Z',
        last_error: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:01:00.000Z',
      },
    ];
    const query = jest.fn(async () => ({ rows: [dbRows[Math.min(query.mock.calls.length - 1, 1)]] }));
    jest.doMock('../src/db', () => ({ query }));

    const store = require('../src/auroraBff/productIntelKbStore');
    const first = await store.getProductIntelKbEntry('product:ext_demo');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.getProductIntelKbEntry('product:ext_demo');

    expect(first.analysis.product_intel_v1.marker).toBe('old');
    expect(second.analysis.product_intel_v1.marker).toBe('fresh');
    expect(query).toHaveBeenCalledTimes(2);
  });

  test('uses memory cache before TTL expires', async () => {
    process.env.AURORA_PRODUCT_INTEL_KB_MEM_TTL_MS = '60000';
    const query = jest.fn(async () => ({
      rows: [
        {
          kb_key: 'product:ext_demo',
          analysis: { product_intel_v1: { marker: 'cached' } },
          source: 'test',
          source_meta: {},
          last_success_at: '2026-04-10T00:00:00.000Z',
          last_error: null,
          created_at: '2026-04-10T00:00:00.000Z',
          updated_at: '2026-04-10T00:00:00.000Z',
        },
      ],
    }));
    jest.doMock('../src/db', () => ({ query }));

    const store = require('../src/auroraBff/productIntelKbStore');
    await store.getProductIntelKbEntry('product:ext_demo');
    const second = await store.getProductIntelKbEntry('product:ext_demo');

    expect(second.analysis.product_intel_v1.marker).toBe('cached');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
