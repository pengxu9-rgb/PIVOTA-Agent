// The strict ingredient lane owns pagination before the send-boundary trim.
// Keep its exact page, total and contract stamps; the op wrapper must not
// append a second result source or re-slice the already paged product list.
const {
  buildIngredientIntentDirectBaseMetadata,
  buildIngredientIntentDirectHitResponse,
} = require('../src/findProductsIngredientIntentDirectResponse');

describe('ingredient-direct primary lane preserves requested pages', () => {
  let enforcePageSize;
  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../src/auroraBff/routes', () => ({ mountAuroraBffRoutes: () => {}, __internal: {} }));
    enforcePageSize = require('../src/server')._debug.enforceFindProductsMultiRequestedPageSize;
  });
  const buildProducts = count => Array.from({ length: count }, (_, i) => ({
    product_id: `seed_${i + 1}`, content_key: `ck_seed_${i + 1}`,
    title: `Niacinamide Serum ${i + 1}`, buyable: true,
  }));
  function buildPage({ merged = 19, limit = 10, page = 1, rewrittenBridge = false } = {}) {
    const products = buildProducts(merged);
    const offset = (page - 1) * limit;
    const baseMetadata = buildIngredientIntentDirectBaseMetadata({
      ingredientIntentDetected: true, ingredientIntentIds: ['niacinamide'],
      strictConstraintReason: 'ingredient_intent', mergedRecalledProducts: products,
      directServiceProducts: products,
    });
    const response = buildIngredientIntentDirectHitResponse({
      responseProducts: products.slice(offset, offset + limit), mergedRecalledProducts: products,
      safePage: page, baseMetadata, ingredientIntentIds: ['niacinamide'], ingredientIntentDetected: true,
    });
    if (rewrittenBridge) response.metadata.contract_bridge = {
      ...response.metadata.contract_bridge, attempted_contract: 'pivot.agent.v1', resolved_contract: 'pivot.agent.v1',
    };
    return enforcePageSize({ responseBody: response, searchParams: { query: 'niacinamide serum', limit, page }, queryText: 'niacinamide serum' });
  }
  test.each([false, true])('preserves disjoint complete and short pages, bridge rewritten=%s', rewrittenBridge => {
    const first = buildPage({ page: 1, rewrittenBridge });
    const second = buildPage({ page: 2, rewrittenBridge });
    expect(first.products.map(p => p.product_id)).toEqual(buildProducts(10).map(p => p.product_id));
    expect(second.products.map(p => p.product_id)).toEqual(buildProducts(19).slice(10).map(p => p.product_id));
    expect(first).toMatchObject({ page: 1, page_size: 10, total: 19 });
    expect(second).toMatchObject({ page: 2, page_size: 9, total: 19 });
    expect(second.metadata).toMatchObject({ strict_constraint_query: true, resolved_contract: 'shop_invoke_strict' });
    expect(new Set([...first.products, ...second.products].map(p => p.product_id)).size).toBe(19);
  });
  test.each([1, 3, 10])('limit=%s retains the lane page without inflation', limit => {
    const body = buildPage({ merged: 19, limit });
    expect(body.products).toHaveLength(limit);
    expect(body.page_size).toBe(limit);
    expect(body.total).toBe(19);
  });
  test('out-of-range page stays empty and retains the primary total', () => {
    expect(buildPage({ page: 3 })).toMatchObject({ products: [], page: 3, page_size: 0, total: 19 });
  });
  test('non-strict mainline list is trimmed to the explicit limit without changing total', () => {
    const body = enforcePageSize({ responseBody: {
      status: 'success', products: buildProducts(52), total: 52, page_size: 52,
      metadata: { query_source: 'beauty_discovery_mainline' },
    }, searchParams: { query: 'brightening serum', limit: 10 }, queryText: 'brightening serum' });
    expect(body.products).toHaveLength(10);
    expect(body.total).toBe(52);
    expect(body.metadata.page_size_enforcement.applied).toBe(true);
  });
});
