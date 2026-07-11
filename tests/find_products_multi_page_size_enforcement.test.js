describe('enforceFindProductsMultiRequestedPageSize', () => {
  let enforceFindProductsMultiRequestedPageSize;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
    const app = require('../src/server');
    enforceFindProductsMultiRequestedPageSize =
      app._debug.enforceFindProductsMultiRequestedPageSize;
  });

  const buildProducts = (count) =>
    Array.from({ length: count }, (_, i) => ({ product_id: `p${i + 1}`, title: `Product ${i + 1}` }));

  test('trims products to explicit page_size and stamps enforcement metadata', () => {
    const responseBody = {
      status: 'success',
      products: buildProducts(52),
      total: 52,
      page_size: 52,
      metadata: { query_source: 'agent_products_search' },
    };
    const out = enforceFindProductsMultiRequestedPageSize({
      responseBody,
      searchParams: { query: 'lipstick', page_size: 10 },
    });
    expect(out.products).toHaveLength(10);
    expect(out.products[0].product_id).toBe('p1');
    expect(out.page_size).toBe(10);
    // total reflects the recall pool, not the trimmed page
    expect(out.total).toBe(52);
    expect(out.metadata.page_size_enforcement).toEqual({
      applied: true,
      requested_page_size: 10,
      pre_trim_count: 52,
    });
  });

  test('honors explicit limit when page_size is absent', () => {
    const out = enforceFindProductsMultiRequestedPageSize({
      responseBody: { products: buildProducts(30) },
      searchParams: { query: 'lipstick', limit: 5 },
    });
    expect(out.products).toHaveLength(5);
  });

  test('no-op when the client did not send an explicit page_size/limit', () => {
    const responseBody = { products: buildProducts(52), total: 52 };
    const out = enforceFindProductsMultiRequestedPageSize({
      responseBody,
      searchParams: { query: 'lipstick' },
    });
    expect(out).toBe(responseBody);
    expect(out.products).toHaveLength(52);
    expect(out.metadata).toBeUndefined();
  });

  test('no-op when the pool is already within the requested page_size', () => {
    const responseBody = { products: buildProducts(8), total: 8 };
    const out = enforceFindProductsMultiRequestedPageSize({
      responseBody,
      searchParams: { page_size: 20 },
    });
    expect(out).toBe(responseBody);
  });

  test('leaves strict-contract responses untouched (parity-locked shape)', () => {
    const responseBody = {
      products: buildProducts(52),
      metadata: { contract_bridge: { resolved_contract: 'shop_invoke_strict' } },
    };
    const out = enforceFindProductsMultiRequestedPageSize({
      responseBody,
      searchParams: { page_size: 10 },
    });
    expect(out).toBe(responseBody);
    expect(out.products).toHaveLength(52);
  });

  test('ignores non-numeric and non-positive explicit values (treated as not requested)', () => {
    const responseBody = { products: buildProducts(30) };
    for (const bad of ['abc', 0, -5, NaN]) {
      const out = enforceFindProductsMultiRequestedPageSize({
        responseBody,
        searchParams: { page_size: bad },
      });
      expect(out).toBe(responseBody);
      expect(out.products).toHaveLength(30);
    }
  });

  test('passes through non-object and productless bodies', () => {
    expect(enforceFindProductsMultiRequestedPageSize({ responseBody: null, searchParams: { page_size: 5 } })).toBeNull();
    const clarify = { status: 'success', clarify: { question: 'which shade?' } };
    expect(
      enforceFindProductsMultiRequestedPageSize({ responseBody: clarify, searchParams: { page_size: 5 } }),
    ).toBe(clarify);
  });
});
