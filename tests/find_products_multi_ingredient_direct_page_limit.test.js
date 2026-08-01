// Strict ingredient-direct lane page-limit contract.
//
// The lane (query_source agent_products_ingredient_recall_direct) slices its
// own page (safeOffset/safeLimit) before building the hit response, and the
// op-level page-size trim (enforceFindProductsMultiRequestedPageSize) leaves
// strict-contract bodies untouched — the shape is parity-locked. That exemption
// is only sound if nothing re-inflates the body afterwards: the ADR-007
// citable supplement appended at the same res.json choke point used to push
// every cached citation item onto the strict body, shipping 48-52 products on
// limit=10 requests whenever its per-query cache was warm at send time (and 10
// when cold — the count flapped run to run). These tests pin the contract:
// products.length never exceeds the requested limit for the strict lane, with
// the supplement skipped there and still applied + trimmed on mainline bodies.

const {
  buildIngredientIntentDirectBaseMetadata,
  buildIngredientIntentDirectHitResponse,
} = require('../src/findProductsIngredientIntentDirectResponse');

describe('ingredient-direct strict lane honors requested limit at the res.json choke point', () => {
  let appendCitableSupplementItems;
  let enforceFindProductsMultiRequestedPageSize;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
    const app = require('../src/server');
    appendCitableSupplementItems = app._debug.appendCitableSupplementItems;
    enforceFindProductsMultiRequestedPageSize =
      app._debug.enforceFindProductsMultiRequestedPageSize;
  });

  const buildLaneProducts = (count) =>
    Array.from({ length: count }, (_, i) => ({
      product_id: `seed_${i + 1}`,
      content_key: `ck_seed_${i + 1}`,
      title: `Niacinamide Serum ${i + 1}`,
      buyable: true,
    }));

  const buildCitableItems = (count) =>
    Array.from({ length: count }, (_, i) => ({
      product_id: `cit_${i + 1}`,
      content_key: `ck_cit_${i + 1}`,
      title: `Citable Item ${i + 1}`,
      buyable: false,
      source: 'canonical_citation',
      search_recall_source: 'canonical_citation',
    }));

  const buildStrictLaneResponse = ({ merged = 19, limit = 10, page = 1 } = {}) => {
    const mergedRecalledProducts = buildLaneProducts(merged);
    const pagedProducts = mergedRecalledProducts.slice(0, limit);
    const baseMetadata = buildIngredientIntentDirectBaseMetadata({
      ingredientIntentDetected: true,
      ingredientIntentIds: ['niacinamide'],
      strictConstraintReason: 'ingredient_intent',
      mergedRecalledProducts,
      directServiceProducts: mergedRecalledProducts,
    });
    return buildIngredientIntentDirectHitResponse({
      responseProducts: pagedProducts,
      mergedRecalledProducts,
      safePage: page,
      baseMetadata,
      ingredientIntentIds: ['niacinamide'],
      ingredientIntentDetected: true,
    });
  };

  test('citable supplement is skipped for strict-contract bodies (products stay at the lane page)', () => {
    const limit = 10;
    const response = buildStrictLaneResponse({ merged: 19, limit });
    expect(response.metadata.contract_bridge.resolved_contract).toBe('shop_invoke_strict');
    expect(response.products).toHaveLength(limit);

    const out = appendCitableSupplementItems(response, buildCitableItems(42));

    expect(out.products).toHaveLength(limit);
    expect(out.products.every((p) => p.search_recall_source !== 'canonical_citation')).toBe(true);
    expect(out.metadata.citable_supplement_count).toBe(0);
    expect(out.metadata.citable_supplement_skip_reason).toBe('strict_contract');
  });

  test('strict lane response never exceeds the requested limit through the full choke-point sequence', () => {
    const limit = 10;
    const response = buildStrictLaneResponse({ merged: 19, limit });

    let finalBody = appendCitableSupplementItems(response, buildCitableItems(42));
    finalBody = enforceFindProductsMultiRequestedPageSize({
      responseBody: finalBody,
      searchParams: { query: 'niacinamide serum', limit },
      queryText: 'niacinamide serum',
    });

    expect(finalBody.products.length).toBeLessThanOrEqual(limit);
    expect(finalBody.page_size).toBe(limit);
    // total keeps reporting the full merged recall pool
    expect(finalBody.total).toBe(19);
  });

  test('non-strict bodies still receive the supplement and get trimmed back to the explicit limit', () => {
    const limit = 10;
    const responseBody = {
      status: 'success',
      products: buildLaneProducts(limit),
      total: limit,
      page_size: limit,
      metadata: { query_source: 'beauty_discovery_mainline' },
    };

    const appended = appendCitableSupplementItems(responseBody, buildCitableItems(42));
    expect(appended.products).toHaveLength(52);
    expect(appended.metadata.citable_supplement_count).toBe(42);

    const out = enforceFindProductsMultiRequestedPageSize({
      responseBody: appended,
      searchParams: { query: 'brightening serum', limit },
      queryText: 'brightening serum',
    });
    expect(out.products).toHaveLength(limit);
    expect(out.metadata.page_size_enforcement.applied).toBe(true);
  });
});
