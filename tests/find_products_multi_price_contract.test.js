'use strict';

const SERVER_PATH = require.resolve('../src/server.js');

function loadDebug() {
  let mod;
  jest.isolateModules(() => {
    jest.doMock('../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
    mod = require(SERVER_PATH);
  });
  return mod._debug;
}

describe('find_products_multi canonical price contract', () => {
  const {
    finalizeCitableSupplementItem,
    isShoppingAgentFindProductsMultiRequest,
    enforceFindProductsMultiPriceContract,
    enforceFindProductsMultiAvailabilityContract,
    dedupeFindProductsMultiProductGroups,
  } = loadDebug();

  test('keeps a citation only when its source snapshot contains an amount/currency pair', () => {
    const priced = finalizeCitableSupplementItem({
      product_id: 'ordinary-serum',
      title: 'The Ordinary Serum',
      price_absent_reason: 'no_offer_derived_price',
      seed_data: { snapshot: { price_amount: '12.50', price_currency: 'USD' } },
    });

    expect(priced).toMatchObject({
      product_id: 'ordinary-serum',
      price: 12.5,
      currency: 'USD',
      catalog_track: 'citation',
      buyable: false,
    });
    expect(priced.seed_data).toBeUndefined();
    expect(priced.price_absent_reason).toBeUndefined();
    expect(
      finalizeCitableSupplementItem({
        product_id: 'missing-price',
        seed_data: { snapshot: { price_amount: '12.50' } },
      }),
    ).toBeNull();
  });

  test('drops products that the PDP has already declared unavailable while retaining unknown inventory', () => {
    const response = {
      products: [
        { product_id: 'servable', price: 20, currency: 'USD', in_stock: true },
        {
          product_id: 'no-us-offer',
          price: 20,
          currency: 'USD',
          serving_eligible: false,
          blocker_code: 'no_us_offer',
        },
        { product_id: 'out-of-stock', price: 20, currency: 'USD', in_stock: false },
        { product_id: 'unknown-stock', price: 20, currency: 'USD' },
        {
          product_id: 'citation',
          price: 20,
          currency: 'USD',
          in_stock: false,
          catalog_track: 'citation',
          source: 'canonical_citation',
        },
        {
          product_id: 'retired-source',
          price: 20,
          currency: 'USD',
          seed_data: { snapshot: { source_unavailable_v1: { status: 'source_unavailable' } } },
        },
      ],
      total: 5,
      metadata: {},
    };

    enforceFindProductsMultiAvailabilityContract(response);

    expect(response.products.map((product) => product.product_id)).toEqual([
      'servable',
      'unknown-stock',
      'citation',
    ]);
    expect(response.total).toBe(3);
    expect(response.metadata.availability_contract).toEqual({
      known_unavailable_excluded: true,
      dropped_known_unavailable: 3,
    });
  });

  test('materializes a seller offer, rejects an unpriced card, and collapses mirrored product groups', () => {
    const response = {
      products: [
        {
          product_id: 'knight-unicorn-a',
          dedupe_group_id: '9854988910809',
          offers: [{ price: { current: { amount: '23', currency: 'USD' } } }],
        },
        {
          product_id: 'knight-unicorn-b',
          dedupe_group_id: '9854988910809',
          price: 23,
          currency: 'USD',
        },
        { product_id: 'unpriced', price: 0, currency: 'USD' },
      ],
      total: 3,
      metadata: {},
    };

    dedupeFindProductsMultiProductGroups(enforceFindProductsMultiPriceContract(response));

    expect(response.products).toEqual([
      expect.objectContaining({ product_id: 'knight-unicorn-a', price: 23, currency: 'USD' }),
    ]);
    expect(response.total).toBe(1);
    expect(response.metadata.price_contract).toEqual({
      canonical_price_or_offer_required: true,
      dropped_unpriced: 1,
    });
    expect(response.metadata.search_dedupe).toEqual({
      dedupe_group_id_applied: true,
      dropped_duplicate_groups: 1,
    });
  });

  test('applies the price contract to Shopping Agent searches without changing other invoke surfaces', () => {
    expect(
      isShoppingAgentFindProductsMultiRequest(
        { body: { metadata: { source: 'shopping_agent' } } },
        'find_products_multi',
      ),
    ).toBe(true);
    expect(
      isShoppingAgentFindProductsMultiRequest(
        { body: { metadata: { source: 'creator_agent' } } },
        'find_products_multi',
      ),
    ).toBe(false);
    expect(
      isShoppingAgentFindProductsMultiRequest(
        { body: { metadata: { source: 'shopping_agent' } } },
        'get_discovery_feed',
      ),
    ).toBe(false);
  });
});
