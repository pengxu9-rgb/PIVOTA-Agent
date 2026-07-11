// Brand-query guards for find_products_multi (wrong-brand recall incident,
// 2026-07-11: "acropass" → category expansion invented "women clothing dress
// top skirt outfit", junk filled the page, and the page-size trim dropped the
// brand-exact citable-supplement items).
//
// Guard 1 (policy.js): a bare brand-name query is NOT category-expanded — the
//   raw query reaches upstream verbatim.
// Guard 2 (server.js): the explicit-page-size trim never drops brand-matching
//   items in favor of items that don't match the queried brand at all.

const brandDictionaryCache = require('../src/findProductsMulti/brandDictionaryCache');

describe('brand-query expansion bypass (policy.js)', () => {
  let buildFindProductsMultiContext;
  const prevFlag = process.env.GATEWAY_DYNAMIC_BRAND_DETECT;

  beforeAll(() => {
    process.env.GATEWAY_DYNAMIC_BRAND_DETECT = 'true';
    ({ buildFindProductsMultiContext } = require('../src/findProductsMulti/policy'));
    brandDictionaryCache.__setBrandSetForTest(['acropass']);
  });

  afterAll(() => {
    if (prevFlag === undefined) delete process.env.GATEWAY_DYNAMIC_BRAND_DETECT;
    else process.env.GATEWAY_DYNAMIC_BRAND_DETECT = prevFlag;
    brandDictionaryCache.__setBrandSetForTest([]);
  });

  test('bare catalog-brand query reaches upstream verbatim (no invented category terms)', async () => {
    const { adjustedPayload, expansion_meta: expansionMeta } = await buildFindProductsMultiContext({
      payload: {
        search: { query: 'acropass' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'acropass' }],
      },
      metadata: {},
    });
    expect(String(adjustedPayload.search.query)).toBe('acropass');
    expect(expansionMeta.brand_query_detected).toBe(true);
    // NOTE: brand_query_without_category may be false here — the NLU invents
    // intent.category for proper-noun queries, which is exactly why the guard
    // uses token remainder instead of that field.
    expect(expansionMeta.brand_query_expansion_bypassed).toBe(true);
    expect(expansionMeta.applied).toBe(false);
  });

  test('brand + user-typed non-English category word is NOT treated as bare brand', async () => {
    // Review finding: an English-only category regex would suppress expansion
    // for "uniqlo 连衣裙"-shaped queries. The token-remainder rule keeps any
    // non-brand token — in any script — as real user evidence.
    const { expansion_meta: expansionMeta } = await buildFindProductsMultiContext({
      payload: {
        search: { query: 'acropass 面膜' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'acropass 面膜' }],
      },
      metadata: {},
    });
    expect(expansionMeta.brand_query_expansion_bypassed).toBe(false);
  });

  test('non-brand apparel query still expands (guard does not disable expansion generally)', async () => {
    const query = '当天晚上要给女朋友一个惊喜，准备一套性感的衣服送给她，推荐一些';
    const { adjustedPayload, expansion_meta: expansionMeta } = await buildFindProductsMultiContext({
      payload: {
        search: { query },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: query }],
      },
      metadata: {},
    });
    expect(String(adjustedPayload.search.query)).not.toBe(query);
  });
});

describe('brand page guard in enforceFindProductsMultiRequestedPageSize (server.js)', () => {
  let enforceFindProductsMultiRequestedPageSize;
  const prevFlag = process.env.GATEWAY_DYNAMIC_BRAND_DETECT;

  beforeAll(() => {
    process.env.GATEWAY_DYNAMIC_BRAND_DETECT = 'true';
    jest.doMock('../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
    const app = require('../src/server');
    enforceFindProductsMultiRequestedPageSize =
      app._debug.enforceFindProductsMultiRequestedPageSize;
    brandDictionaryCache.__setBrandSetForTest(['acropass']);
  });

  afterAll(() => {
    if (prevFlag === undefined) delete process.env.GATEWAY_DYNAMIC_BRAND_DETECT;
    else process.env.GATEWAY_DYNAMIC_BRAND_DETECT = prevFlag;
    brandDictionaryCache.__setBrandSetForTest([]);
  });

  const junk = (n) =>
    Array.from({ length: n }, (_, i) => ({
      product_id: `junk${i + 1}`,
      brand: 'GR',
      title: `Velvet lingerie set ${i + 1}`,
    }));
  const brandItems = (n) =>
    Array.from({ length: n }, (_, i) => ({
      product_id: `acro${i + 1}`,
      brand: 'ACROPASS',
      title: `Microcone Patch ${i + 1}`,
    }));

  test('brand-matching supplement items survive the trim ahead of zero-match junk', () => {
    const out = enforceFindProductsMultiRequestedPageSize({
      responseBody: { products: [...junk(8), ...brandItems(4)], metadata: {} },
      searchParams: { page_size: 8 },
      queryText: 'acropass',
    });
    expect(out.products).toHaveLength(8);
    expect(out.products.slice(0, 4).map((p) => p.brand)).toEqual(
      Array(4).fill('ACROPASS'),
    );
    expect(out.metadata.page_size_enforcement.brand_guard).toEqual({
      brands: ['acropass'],
      brand_matched_count: 4,
      promoted_count: 4,
    });
  });

  test('no reorder when brand items already fit the page', () => {
    const out = enforceFindProductsMultiRequestedPageSize({
      responseBody: { products: [...brandItems(4), ...junk(8)], metadata: {} },
      searchParams: { page_size: 8 },
      queryText: 'acropass',
    });
    expect(out.products).toHaveLength(8);
    expect(out.products[0].product_id).toBe('acro1');
    expect(out.metadata.page_size_enforcement.brand_guard).toBeUndefined();
  });

  test('non-brand query trims plainly (no guard)', () => {
    const out = enforceFindProductsMultiRequestedPageSize({
      responseBody: { products: [...junk(8), ...brandItems(4)], metadata: {} },
      searchParams: { page_size: 8 },
      queryText: 'lipstick',
    });
    expect(out.products.map((p) => p.product_id)).toEqual(
      junk(8).map((p) => p.product_id),
    );
    expect(out.metadata.page_size_enforcement.brand_guard).toBeUndefined();
  });

  test('short brand compacts do not collide with unrelated title substrings', () => {
    // Review finding: "nars" ⊂ compact("Lunar Spell"). Short compacts (<6)
    // may only match via the product's own brand field, not title text.
    brandDictionaryCache.__setBrandSetForTest(['nars']);
    const products = [
      ...junk(8),
      { product_id: 'collider', brand: 'Moonlight Co', title: 'Lunar Spell Serum' },
      { product_id: 'realbrand', brand: 'NARS', title: 'Blush' },
    ];
    const out = enforceFindProductsMultiRequestedPageSize({
      responseBody: { products, metadata: {} },
      searchParams: { page_size: 8 },
      queryText: 'nars',
    });
    const ids = out.products.map((p) => p.product_id);
    expect(ids).toContain('realbrand');
    expect(ids).not.toContain('collider');
    brandDictionaryCache.__setBrandSetForTest(['acropass']);
  });

  test('brand match via title text also counts', () => {
    const products = [
      ...junk(8),
      { product_id: 'titled', brand: '', title: 'AcroPass Trouble Cure' },
    ];
    const out = enforceFindProductsMultiRequestedPageSize({
      responseBody: { products, metadata: {} },
      searchParams: { page_size: 8 },
      queryText: 'acropass',
    });
    expect(out.products.map((p) => p.product_id)).toContain('titled');
  });
});
