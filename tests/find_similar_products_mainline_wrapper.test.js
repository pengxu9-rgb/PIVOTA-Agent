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
          description: 'A verified similar product highlight for PDP card presentation.',
          card_highlight_status: 'ready',
          card_highlight: 'Same routine fit with a stronger finish.',
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
          merchant_id: 'external_seed',
          limit: 4,
        },
      })
      .expect(200);

    expect(recommendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pdp_product: expect.objectContaining({
          merchant_id: 'external_seed',
          product_id: 'ext_demo_1',
          source: 'external_seed',
        }),
        k: 8,
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
        direct_base_detail_mode: 'external_seed_minimal',
        card_enrichment_budget_ms: expect.any(Number),
      }),
    );
    expect(upstreamScope.isDone()).toBe(false);
  });

  it('does not spend card detail budget on highlight-only gaps', async () => {
    const app = require('../src/server');

    const items = await app._debug.enrichSimilarProductsForPdpCards({
      items: [
        {
          product_id: 'sim_highlight_gap',
          merchant_id: 'external_seed',
          image_url: 'https://cdn.example.test/sim.jpg',
        },
      ],
      maxItems: 1,
      budgetMs: 100,
      detailBudgetMs: 50,
    });
    const metadata = app._debug.getSimilarCardEnrichmentMetadata(items);

    expect(app._debug.shouldEnrichSimilarCard(items[0])).toBe(false);
    expect(items[0]).toEqual(
      expect.objectContaining({
        card_highlight_status: 'highlight_missing',
        card_image_status: 'ready',
      }),
    );
    expect(metadata).toEqual(
      expect.objectContaining({
        card_enrichment_status: 'ready',
        card_enrichment_attempted_count: 0,
        card_enrichment_budget_ms: 100,
        card_enrichment_detail_budget_ms: 50,
      }),
    );
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
