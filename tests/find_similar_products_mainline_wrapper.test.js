const request = require('supertest');
const nock = require('nock');

describe('find_similar_products mainline wrapper', () => {
  const apiBase = 'http://localhost:8080';

  beforeEach(() => {
    nock.cleanAll();
    jest.resetModules();
    process.env.API_MODE = 'REAL';
    process.env.PIVOTA_API_BASE = apiBase;
    process.env.PIVOTA_API_KEY = 'test-token';
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('returns RecommendationEngine results and does not fall back upstream', async () => {
    const recommendMock = jest.fn().mockResolvedValue({
      items: [
        {
          product_id: 'sim_1',
          merchant_id: 'external_seed',
          title: 'Similar Product 1',
        },
      ],
      metadata: {
        low_confidence: false,
        retrieval_mix: { internal: 0, external: 1 },
      },
    });

    jest.doMock('../src/services/RecommendationEngine', () => ({
      ...jest.requireActual('../src/services/RecommendationEngine'),
      recommend: recommendMock,
      getCacheStats: jest.fn(() => ({})),
    }));

    const upstreamScope = nock(apiBase)
      .post('/agent/shop/v1/invoke')
      .reply(200, { products: [{ product_id: 'upstream_should_not_run' }] });

    const app = require('../src/server');

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_similar_products',
        payload: {
          product_id: 'ext_demo_1',
          limit: 4,
        },
      })
      .expect(200);

    expect(recommendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pdp_product: expect.objectContaining({
          product_id: 'ext_demo_1',
        }),
        k: 4,
      }),
    );
    expect(res.body.products).toEqual([
      expect.objectContaining({
        product_id: 'sim_1',
      }),
    ]);
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        route: 'find_similar_products_mainline_wrapper',
      }),
    );
    expect(upstreamScope.isDone()).toBe(false);
  });

  it('returns 503 when mainline recommendations fail instead of falling back upstream', async () => {
    const recommendMock = jest.fn().mockRejectedValue(new Error('engine unavailable'));

    jest.doMock('../src/services/RecommendationEngine', () => ({
      ...jest.requireActual('../src/services/RecommendationEngine'),
      recommend: recommendMock,
      getCacheStats: jest.fn(() => ({})),
    }));

    const upstreamScope = nock(apiBase)
      .post('/agent/shop/v1/invoke')
      .reply(200, { products: [{ product_id: 'upstream_should_not_run' }] });

    const app = require('../src/server');

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_similar_products',
        payload: {
          product_id: 'ext_demo_2',
          limit: 4,
        },
      })
      .expect(503);

    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'SIMILAR_MAINLINE_UNAVAILABLE',
      }),
    );
    expect(upstreamScope.isDone()).toBe(false);
  });
});
