process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.API_MODE = 'REAL';

const request = require('supertest');
const nock = require('nock');

describe('/agent/shop/v1/invoke find_products_multi eligible-only serving', () => {
  afterEach(() => {
    nock.cleanAll();
    jest.resetModules();
  });

  it('filters to eligible internal products and attaches top offers', async () => {
    const capturedQueries = [];
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .times(4)
      .query((q) => {
        capturedQueries.push(q || {});
        return true;
      })
      .reply(200, {
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
            description: 'Missing price should be filtered',
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
    expect(capturedQueries.length).toBeGreaterThanOrEqual(1);
    for (const q of capturedQueries) {
      expect(q).toEqual(
        expect.objectContaining({
          search_all_merchants: 'true',
          in_stock_only: 'true',
          allow_external_seed: 'false',
          commerce_surface: 'agent_api',
          catalog_surface: 'agent_api',
        }),
      );
    }
    expect(
      capturedQueries.some((q) => String(q.query || '').toLowerCase().includes('serum')),
    ).toBe(true);
    expect(resp.body.total).toBe(1);
    expect(resp.body.page_size).toBe(1);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        commerce_surface: 'agent_api',
        serving_mode: 'eligible_only',
      }),
    );
    expect(resp.body.products).toHaveLength(1);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'prod_eligible_1',
        merchant_id: 'merch_1',
        commerce_surface: 'agent_api',
        top_offer_summary: expect.objectContaining({
          purchase_route: 'internal_checkout',
          product_id: 'prod_eligible_1',
          variant_id: 'var_eligible_1',
          sku_id: 'sku_eligible_1',
          commerce_surface: 'agent_api',
        }),
        exact_resolution_identifiers: expect.objectContaining({
          merchant_id: 'merch_1',
          product_id: 'prod_eligible_1',
          variant_id: 'var_eligible_1',
          sku_id: 'sku_eligible_1',
        }),
      }),
    );
  });
});
