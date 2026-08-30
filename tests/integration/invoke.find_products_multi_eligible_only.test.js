process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.API_MODE = 'REAL';

const request = require('supertest');
const nock = require('nock');

// CONTRACT UPDATE 2026-07-11: the invoke lane forwards upstream via
// POST /agent/v2/products/search (ROUTE_MAP find_products_multi, src/server.js
// ~24634; body shaped by buildSearchProductsV2Body, src/server.js ~2282), not
// the old GET /agent/v1/products/search query contract this test used to mock.
// Eligible-only serving (eligible_only filtering, top_offer_summary,
// exact_resolution_identifiers, serving_mode/commerce_surface metadata) no
// longer exists in the gateway — no such code remains under src/ — the v2
// upstream is now the eligibility authority and the gateway serves its result
// through the transport projection whitelist. Shopping Agent responses then
// enforce the display contract: every returned card has a paired positive
// price and currency, so upstream cards without that pair are excluded.
describe('/agent/shop/v1/invoke find_products_multi eligible-only serving', () => {
  afterEach(() => {
    nock.cleanAll();
    jest.resetModules();
  });

  it('forwards the eligible-surface search on the v2 body contract and serves upstream products authoritatively', async () => {
    const capturedBodies = [];
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/products/search')
      .query(true)
      .times(4)
      .reply(200, function reply(_uri, body) {
        capturedBodies.push(body && typeof body === 'object' ? body : {});
        return {
          status: 'success',
          success: true,
          total: 3,
          metadata: {
            query_source: 'test_upstream',
          },
          products: [
            {
              id: 'ext_seed_1',
              product_id: 'ext_seed_1',
              merchant_id: 'external_seed',
              source: 'external_seed',
              title: 'External Seed Serum',
              price: 19,
              currency: 'USD',
              in_stock: true,
            },
            {
              id: 'prod_eligible_1',
              product_id: 'prod_eligible_1',
              merchant_id: 'merch_1',
              title: 'Barrier Repair Serum',
              description: 'Internal eligible serum',
              price: 29,
              currency: 'USD',
              in_stock: true,
              variants: [
                {
                  id: 'var_eligible_1',
                  variant_id: 'var_eligible_1',
                  sku: 'sku_eligible_1',
                  price: 29,
                  inventory_quantity: 8,
                },
              ],
            },
            {
              id: 'prod_blocked_1',
              product_id: 'prod_blocked_1',
              merchant_id: 'merch_2',
              title: 'Broken Serum',
              description: 'Missing price is now the upstream authority to filter',
              currency: 'USD',
              in_stock: true,
              variants: [
                {
                  id: 'var_blocked_1',
                  variant_id: 'var_blocked_1',
                  sku: 'sku_blocked_1',
                  price: 0,
                  inventory_quantity: 8,
                },
              ],
            },
          ],
        };
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'serum',
            page: 1,
            limit: 10,
            in_stock_only: true,
            commerce_surface: 'agent_api',
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
    for (const body of capturedBodies) {
      // buildSearchProductsV2Body (src/server.js ~2282): booleans are real
      // booleans in the JSON body (the old test asserted stringified query
      // params), and request_context carries the invoke channel.
      expect(body).toEqual(
        expect.objectContaining({
          search_all_merchants: true,
          in_stock_only: true,
          request_context: expect.objectContaining({
            channel: 'shopping_agent',
          }),
        }),
      );
    }
    expect(
      capturedBodies.some((body) => String(body.query || '').toLowerCase().includes('serum')),
    ).toBe(true);

    // The upstream remains authoritative for eligibility, while the Shopping
    // Agent edge excludes cards that cannot display a canonical price.
    expect(resp.body.total).toBe(2);
    expect(resp.body.page_size).toBe(2);
    expect(resp.body.products).toHaveLength(2);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'authoritative_shopping',
        legacy_contract: false,
        query_source: 'test_upstream',
        price_contract: {
          canonical_price_or_offer_required: true,
          dropped_unpriced: 1,
        },
      }),
    );

    const eligible = resp.body.products.find((p) => p.product_id === 'prod_eligible_1');
    expect(eligible).toEqual(
      expect.objectContaining({
        product_id: 'prod_eligible_1',
        merchant_id: 'merch_1',
        variants: [
          expect.objectContaining({
            variant_id: 'var_eligible_1',
            sku: 'sku_eligible_1',
          }),
        ],
      }),
    );
    // top_offer_summary / exact_resolution_identifiers are no longer part of
    // the invoke product contract: projectSearchTransportProduct
    // (src/server.js ~11380) whitelists transport fields and drops them even
    // when the upstream supplies them (verified empirically 2026-07-11).
    expect(eligible.top_offer_summary).toBeUndefined();
    expect(eligible.exact_resolution_identifiers).toBeUndefined();
  });
});
