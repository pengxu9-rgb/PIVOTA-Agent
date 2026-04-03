process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('/agent/shop/v1/invoke gateway', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('forwards allowed operation and returns upstream response', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/products/search')
      .query((q) => {
        return (
          q &&
          q.query === 'shoes' &&
          // Defaults added by the gateway.
          q.in_stock_only === 'true' &&
          q.limit === '20' &&
          q.offset === '0'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ id: 'p1', product_id: 'p1', merchant_id: 'm1', title: 'Shoes' }],
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products',
        payload: {
          search: { query: 'shoes' },
        },
      })
      .expect(200);

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0].id).toBe('p1');
  });

  it('rejects invalid operation via schema', async () => {
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'hack_me',
        payload: {},
      })
      .expect(400);

    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('fails open on upstream timeout-like failures without secondary ReferenceError', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/products/search')
      .query(true)
      .reply(504, { error: 'UPSTREAM_TIMEOUT' });
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke')
      .reply(200, { products: [] });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products',
        payload: {
          search: { query: 'shoes' },
        },
      })
      .expect(200);

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.error).toBeUndefined();
  });

  it('fails open on transport errors without secondary ReferenceError', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/products/search')
      .query(true)
      .replyWithError('socket hang up');
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke')
      .reply(200, { products: [] });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products',
        payload: {
          search: { query: 'shoes' },
        },
      })
      .expect(200);

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.error).toBeUndefined();
  });

  it('does not let API_MODE=MOCK take over product search', async () => {
    const prevEnv = {
      API_MODE: process.env.API_MODE,
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
    };
    jest.resetModules();
    process.env.API_MODE = 'MOCK';
    process.env.PIVOTA_API_BASE = 'http://localhost:8080';
    process.env.PIVOTA_API_KEY = 'test-token';

    try {
      const mockModeApp = require('../../src/server');

      const strictMainScope = nock(process.env.PIVOTA_API_BASE)
        .post('/agent/v2/products/search')
        .query((q) => q && q.query === 'strict serum')
        .reply(200, {
          status: 'success',
          success: true,
          products: [
            {
              id: 'strict_1',
              product_id: 'strict_1',
              merchant_id: 'm1',
              title: 'Strict Serum',
            },
          ],
        });

      const res = await request(mockModeApp)
        .post('/agent/shop/v1/invoke')
        .send({
          operation: 'find_products',
          payload: {
            search: { query: 'strict serum' },
          },
        })
        .expect(200);

      expect(strictMainScope.isDone()).toBe(true);
      expect(Array.isArray(res.body.products)).toBe(true);
      expect(res.body.products[0]?.product_id || res.body.products[0]?.id).toBe('strict_1');
    } finally {
      if (prevEnv.API_MODE === undefined) delete process.env.API_MODE;
      else process.env.API_MODE = prevEnv.API_MODE;
      if (prevEnv.PIVOTA_API_BASE === undefined) delete process.env.PIVOTA_API_BASE;
      else process.env.PIVOTA_API_BASE = prevEnv.PIVOTA_API_BASE;
      if (prevEnv.PIVOTA_API_KEY === undefined) delete process.env.PIVOTA_API_KEY;
      else process.env.PIVOTA_API_KEY = prevEnv.PIVOTA_API_KEY;
    }
  });

  it('semantic-contract discovery keeps shopping-agent semantic owner and emits stage ledger metadata', async () => {
    let capturedQuery = null;
    let capturedBody = null;
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/products/search', (body) => {
        capturedBody = body;
        return true;
      })
      .query((query) => {
        capturedQuery = query;
        return true;
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'spf_1',
            product_id: 'spf_1',
            merchant_id: 'merchant_spf',
            title: 'Oil Control Daily Sunscreen for Oily Skin SPF 50',
            name: 'Oil Control Daily Sunscreen for Oily Skin SPF 50',
            display_name: 'Oil Control Daily Sunscreen for Oily Skin SPF 50',
            category: 'sunscreen',
            product_type: 'sunscreen',
          },
        ],
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'best sunscreen for oily skin',
            catalog_surface: 'beauty',
            semantic_contract: {
              version: 'beauty_semantic_contract_v1',
              owner: 'aurora_reco_planner',
              planner_mode: 'step_aware',
              request_class: 'sunscreen',
              target_step_family: 'sunscreen',
              primary_role_id: 'daily_sunscreen',
              support_role_ids: [],
              semantic_family: 'sunscreen',
              allowed_step_families: ['sunscreen'],
              blocked_step_families: [],
              ingredient_hypotheses: [],
              source_surface: 'aurora_beauty_strict',
            },
          },
        },
        metadata: {
          source: 'aurora-bff',
          catalog_surface: 'beauty',
        },
      })
      .expect(200);

    expect(String(capturedQuery?.query || '').toLowerCase()).toBe('daily sunscreen');
    expect(String(capturedBody?.query || '').toLowerCase()).toBe('daily sunscreen');
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        semantic_owner: 'shopping_agent_beauty_mainline',
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner_query_attempts: expect.arrayContaining([
          expect.objectContaining({
            query: 'daily sunscreen',
            query_index: 0,
            query_total: 3,
          }),
        ]),
        search_stage_ledger: expect.objectContaining({
          semantic_rewrite: expect.objectContaining({
            owner_locked: true,
            owner: 'shopping_agent_beauty_mainline',
            mode: 'deterministic_contract',
            single_provider_locked: true,
            timeout_ms: 0,
            llm_enrichment_attempted: false,
            llm_enrichment_applied: false,
            llm_enrichment_status: 'skipped_strict_contract_owner',
          }),
          primary_search: expect.objectContaining({
            query_pack_attempts: expect.arrayContaining([
              expect.objectContaining({
                query: 'daily sunscreen',
                query_index: 0,
                query_total: 3,
              }),
            ]),
          }),
          final_decision: expect.objectContaining({
            owner: 'shopping_agent_beauty_mainline',
          }),
        }),
        effective_timeout_ms: expect.objectContaining({
          gateway_total_budget_ms: 9000,
        }),
      }),
    );
  });

  it('semantic-contract discovery retries the next deterministic query when primary contract query is empty', async () => {
    const attemptedQueries = [];
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/products/search', (body) => {
        attemptedQueries.push(String(body?.query || ''));
        return true;
      })
      .query((query) => {
        return true;
      })
      .times(2)
      .reply(function reply(_uri, body) {
        const query = String(body?.query || '').trim().toLowerCase();
        if (query === 'daily sunscreen') {
          return [
            200,
            {
              status: 'success',
              success: true,
              products: [],
              metadata: {
                query_source: 'agent_products_recall_clarify',
              },
            },
          ];
        }
        return [
          200,
          {
            status: 'success',
            success: true,
            products: [
              {
                id: 'spf_2',
                product_id: 'spf_2',
                merchant_id: 'merchant_spf',
                title: 'Face Sunscreen for Oily Skin SPF 50',
                name: 'Face Sunscreen for Oily Skin SPF 50',
                display_name: 'Face Sunscreen for Oily Skin SPF 50',
                category: 'sunscreen',
                product_type: 'sunscreen',
              },
            ],
            metadata: {
              query_source: 'agent_products_search',
            },
          },
        ];
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'best sunscreen for oily skin',
            catalog_surface: 'beauty',
            semantic_contract: {
              version: 'beauty_semantic_contract_v1',
              owner: 'aurora_reco_planner',
              planner_mode: 'step_aware',
              request_class: 'sunscreen',
              target_step_family: 'sunscreen',
              primary_role_id: 'daily_sunscreen',
              support_role_ids: [],
              semantic_family: 'sunscreen',
              allowed_step_families: ['sunscreen'],
              blocked_step_families: [],
              ingredient_hypotheses: [],
              source_surface: 'aurora_beauty_strict',
            },
          },
        },
        metadata: {
          source: 'aurora-bff',
          catalog_surface: 'beauty',
        },
      })
      .expect(200);

    expect(attemptedQueries).toEqual(['daily sunscreen', 'face sunscreen']);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0]?.product_id || res.body.products[0]?.id).toBe('spf_2');
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        semantic_owner: 'shopping_agent_beauty_mainline',
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner_query_attempts: [
          expect.objectContaining({
            query: 'daily sunscreen',
            query_index: 0,
            query_total: 3,
            result_count: 0,
            adopted: false,
          }),
          expect.objectContaining({
            query: 'face sunscreen',
            query_index: 1,
            query_total: 3,
            result_count: 1,
            adopted: true,
          }),
        ],
      }),
    );
  });

  it('public beauty search derives the same beauty mainline contract without requiring upstream semantic_contract input', async () => {
    let capturedQuery = null;
    let capturedBody = null;
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/products/search', (body) => {
        capturedBody = body;
        return true;
      })
      .query((query) => {
        capturedQuery = query;
        return true;
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'spf_public_1',
            product_id: 'spf_public_1',
            merchant_id: 'merchant_spf',
            title: 'Daily Face Sunscreen SPF 50',
            name: 'Daily Face Sunscreen SPF 50',
            display_name: 'Daily Face Sunscreen SPF 50',
            category: 'sunscreen',
            product_type: 'sunscreen',
          },
        ],
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const res = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'best sunscreen for oily skin',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      })
      .expect(200);

    expect(String(capturedQuery?.query || '').toLowerCase()).toBe('daily sunscreen');
    expect(String(capturedBody?.query || '').toLowerCase()).toBe('daily sunscreen');
    expect(capturedBody?.semantic_contract).toEqual(
      expect.objectContaining({
        owner: 'shopping_agent_beauty_contract_builder',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        source_surface: 'shopping_agent_public_beauty',
      }),
    );
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        semantic_owner: 'shopping_agent_beauty_mainline',
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_contract: expect.objectContaining({
          owner: 'shopping_agent_beauty_contract_builder',
        }),
        search_stage_ledger: expect.objectContaining({
          semantic_rewrite: expect.objectContaining({
            owner: 'shopping_agent_beauty_mainline',
            owner_locked: true,
            mode: 'deterministic_contract',
          }),
          primary_search: expect.objectContaining({
            query_pack_attempts: [
              expect.objectContaining({
                query: 'daily sunscreen',
                query_index: 0,
                query_total: 3,
              }),
            ],
          }),
          final_decision: expect.objectContaining({
            owner: 'shopping_agent_beauty_mainline',
          }),
        }),
      }),
    );
  });

  it('marks brush-only skincare results as invalid_hit instead of strict_empty', async () => {
    const upstreamBody = {
      status: 'success',
      success: true,
      total: 2,
      page: 1,
      page_size: 2,
      products: [
        {
          id: 'brush_1',
          product_id: 'brush_1',
          title: 'Small Eyeshadow Brush',
          name: 'Small Eyeshadow Brush',
          display_name: 'Small Eyeshadow Brush',
          category: 'makeup brush',
          product_type: 'tool',
        },
        {
          id: 'brush_2',
          product_id: 'brush_2',
          title: 'Blending Brush',
          name: 'Blending Brush',
          display_name: 'Blending Brush',
          category: 'beauty tool',
          product_type: 'tool',
        },
      ],
      metadata: {
        query_source: 'agent_products_search',
      },
    };

    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, upstreamBody);
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, upstreamBody);

    const res = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'moisturizer barrier repair Ceramide NP barrier repair',
        catalog_surface: 'beauty',
        source: 'aurora-bff',
      })
      .expect(200);

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(0);
    expect(res.body.metadata?.search_decision?.hit_quality).toBe('invalid_hit');
    expect(res.body.metadata?.search_decision?.contract_version).toBe('beauty_search_decision_v4');
    expect(res.body.metadata?.search_decision?.invalid_hit_reason).toBe('invalid_hit_tools_dominant');
    expect(res.body.metadata?.search_decision?.final_decision).toBe('invalid_hit');
    expect(res.body.metadata?.search_decision?.products_returned_count).toBe(0);
    expect(res.body.metadata?.search_decision?.raw_result_count).toBe(2);
  });

  it('does not count body cream as valid face-moisturizer hit', async () => {
    const upstreamBody = {
      status: 'success',
      success: true,
      total: 2,
      page: 1,
      page_size: 2,
      products: [
        {
          id: 'body_1',
          product_id: 'body_1',
          title: 'Lil Butta Dropz Body Cream Trio',
          name: 'Lil Butta Dropz Body Cream Trio',
          display_name: 'Lil Butta Dropz Body Cream Trio',
          category: 'body cream',
          product_type: 'cream',
        },
        {
          id: 'body_2',
          product_id: 'body_2',
          title: 'Shimmering Body Butter',
          name: 'Shimmering Body Butter',
          display_name: 'Shimmering Body Butter',
          category: 'bodycare',
          product_type: 'cream',
        },
      ],
      metadata: {
        query_source: 'agent_products_search',
      },
    };

    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, upstreamBody);
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, upstreamBody);

    const res = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'Barrier Cream',
        catalog_surface: 'beauty',
        source: 'aurora-bff',
      })
      .expect(200);

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(0);
    expect(res.body.metadata?.search_decision?.hit_quality).toBe('invalid_hit');
    expect(res.body.metadata?.search_decision?.invalid_hit_reason).toBe('invalid_hit_all_non_skincare');
    expect(res.body.metadata?.search_decision?.products_returned_count).toBe(0);
    expect(res.body.metadata?.search_decision?.raw_result_count).toBe(2);
  });

  it('reranks moisturizer-family skincare hits ahead of cleanser, spf, and bodycare noise', async () => {
    const upstreamBody = {
      status: 'success',
      success: true,
      total: 4,
      page: 1,
      page_size: 4,
      products: [
        {
          id: 'cleanser_1',
          product_id: 'cleanser_1',
          title: 'Rose Cream Cleanser',
          name: 'Rose Cream Cleanser',
          display_name: 'Rose Cream Cleanser',
          category: 'skincare',
          product_type: 'cleanser',
        },
        {
          id: 'spf_1',
          product_id: 'spf_1',
          title: 'Hydra Vizor SPF 30 Sunscreen Moisturizer',
          name: 'Hydra Vizor SPF 30 Sunscreen Moisturizer',
          display_name: 'Hydra Vizor SPF 30 Sunscreen Moisturizer',
          category: 'skincare',
          product_type: 'sunscreen',
        },
        {
          id: 'body_1',
          product_id: 'body_1',
          title: 'Lil Butta Dropz Body Cream Trio',
          name: 'Lil Butta Dropz Body Cream Trio',
          display_name: 'Lil Butta Dropz Body Cream Trio',
          category: 'body cream',
          product_type: 'cream',
        },
        {
          id: 'cream_1',
          product_id: 'cream_1',
          title: 'Rose Ceramide Cream',
          name: 'Rose Ceramide Cream',
          display_name: 'Rose Ceramide Cream',
          category: 'skincare',
          product_type: 'cream',
        },
      ],
      metadata: {
        query_source: 'agent_products_search',
      },
    };

    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, upstreamBody);
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, upstreamBody);

    const res = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'barrier repair moisturizer',
        catalog_surface: 'beauty',
        source: 'aurora-bff',
      })
      .expect(200);

    expect(res.body.metadata?.search_decision?.hit_quality).toBe('valid_hit');
    expect(res.body.metadata?.search_decision?.same_family_topk_count).toBeGreaterThan(0);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0]?.product_id).toBe('cream_1');
    expect(res.body.products.some((row) => String(row?.product_id || '').includes('cleanser_1'))).toBe(false);
    expect(res.body.products.some((row) => String(row?.product_id || '').includes('body_1'))).toBe(false);
    expect(res.body.products.some((row) => String(row?.product_id || '').includes('spf_1'))).toBe(false);
  });

  it('applies product-only guidance discovery filtering and reports service rows removed', async () => {
    const upstreamBody = {
      status: 'success',
      success: true,
      total: 2,
      page: 1,
      page_size: 2,
      products: [
        {
          id: 'service_1',
          product_id: 'service_1',
          title: 'Barrier Repair Facial 60 Minutes Soin Cabine',
          name: 'Barrier Repair Facial 60 Minutes Soin Cabine',
          display_name: 'Barrier Repair Facial 60 Minutes Soin Cabine',
          category: 'spa service',
          product_type: 'treatment',
        },
        {
          id: 'serum_1',
          product_id: 'serum_1',
          title: 'Soothing Barrier Repair Serum',
          name: 'Soothing Barrier Repair Serum',
          display_name: 'Soothing Barrier Repair Serum',
          category: 'skincare',
          product_type: 'serum',
          source: 'catalog',
        },
      ],
      metadata: {
        query_source: 'agent_products_search',
      },
    };

    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, upstreamBody);
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, upstreamBody);

    const res = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'barrier repair serum',
        catalog_surface: 'beauty',
        source: 'aurora_chatbox',
        ui_surface: 'ingredient_plan_guidance_only',
        product_only: 'true',
        query_index: '0',
        query_total: '2',
        target_step_family: 'serum',
      })
      .expect(200);

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0]?.product_id).toBe('serum_1');
    expect(res.body.metadata?.product_only_applied).toBe(true);
    expect(res.body.metadata?.service_rows_filtered_count).toBe(1);
    expect(res.body.metadata?.query_index).toBe(0);
    expect(res.body.metadata?.query_exhausted).toBe(false);
    expect(res.body.metadata?.search_decision?.product_only_applied).toBe(true);
    expect(res.body.metadata?.search_decision?.service_rows_filtered_count).toBe(1);
    expect(res.body.metadata?.search_decision?.discovery_source_used).toBe('internal');
  });
});
