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
