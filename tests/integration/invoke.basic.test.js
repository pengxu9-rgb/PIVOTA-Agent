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
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
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

    expect(String(capturedQuery?.query || '').toLowerCase()).toBe('lightweight sunscreen oily skin');
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        semantic_owner: 'shopping_agent_beauty_mainline',
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner_query_attempts: expect.arrayContaining([
          expect.objectContaining({
            query: 'lightweight sunscreen oily skin',
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
                query: 'lightweight sunscreen oily skin',
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
      .get('/agent/v1/products/search')
      .query((query) => {
        return true;
      })
      .times(2)
      .reply(function reply(uri) {
        const url = new URL(`${process.env.PIVOTA_API_BASE}${uri}`);
        const query = String(url.searchParams.get('query') || '').trim().toLowerCase();
        attemptedQueries.push(query);
        if (query === 'lightweight sunscreen oily skin') {
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

    expect(attemptedQueries).toEqual(['lightweight sunscreen oily skin', 'oil control sunscreen']);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0]?.product_id || res.body.products[0]?.id).toBe('spf_2');
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        semantic_owner: 'shopping_agent_beauty_mainline',
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner_query_attempts: [
          expect.objectContaining({
            query: 'lightweight sunscreen oily skin',
            query_index: 0,
            query_total: 3,
            result_count: 0,
            adopted: false,
          }),
          expect.objectContaining({
            query: 'oil control sunscreen',
            query_index: 1,
            query_total: 3,
            result_count: 1,
            adopted: true,
          }),
        ],
      }),
    );
  });

  it('semantic-contract sunscreen query pack can reach a third deterministic retry before budget guard cuts off the mainline', async () => {
    const attemptedQueries = [];
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query(true)
      .times(3)
      .reply(function reply(uri) {
        const url = new URL(`${process.env.PIVOTA_API_BASE}${uri}`);
        const query = String(url.searchParams.get('query') || '').trim().toLowerCase();
        attemptedQueries.push(query);
        if (query === 'daily sunscreen') {
          return [
            200,
            {
              status: 'success',
              success: true,
              products: [
                {
                  id: 'spf_3',
                  product_id: 'spf_3',
                  merchant_id: 'merchant_spf',
                  title: 'Daily Sunscreen SPF 50',
                  name: 'Daily Sunscreen SPF 50',
                  display_name: 'Daily Sunscreen SPF 50',
                  category: 'sunscreen',
                  product_type: 'sunscreen',
                },
              ],
              metadata: {
                query_source: 'agent_products_search',
              },
            },
          ];
        }
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
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'sunscreen spf50',
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

    expect(attemptedQueries).toEqual(['sunscreen spf50', 'broad spectrum sunscreen', 'daily sunscreen']);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0]?.product_id || res.body.products[0]?.id).toBe('spf_3');
    expect(res.body.metadata?.semantic_owner_query_attempts).toEqual([
      expect.objectContaining({
        query: 'sunscreen spf50',
        query_index: 0,
        query_total: 3,
        adopted: false,
      }),
      expect.objectContaining({
        query: 'broad spectrum sunscreen',
        query_index: 1,
        query_total: 3,
        adopted: false,
      }),
      expect.objectContaining({
        query: 'daily sunscreen',
        query_index: 2,
        query_total: 3,
        adopted: true,
      }),
    ]);
  });

  it('public beauty search derives the same beauty mainline contract without requiring upstream semantic_contract input', async () => {
    let capturedQuery = null;
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
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

    expect(String(capturedQuery?.query || '').toLowerCase()).toBe('lightweight sunscreen oily skin');
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
                query: 'lightweight sunscreen oily skin',
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

  it('public beauty search keeps non-empty broad-query candidates when beauty hit quality is observation-only', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query(true)
      .times(3)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'noise_1',
            product_id: 'noise_1',
            merchant_id: 'merchant_noise',
            title: 'Cooling Body Lotion',
            name: 'Cooling Body Lotion',
            display_name: 'Cooling Body Lotion',
            category: 'bodycare',
            product_type: 'lotion',
          },
          {
            id: 'noise_2',
            product_id: 'noise_2',
            merchant_id: 'merchant_noise',
            title: 'Spa Facial Service',
            name: 'Spa Facial Service',
            display_name: 'Spa Facial Service',
            category: 'beauty service',
            product_type: 'service',
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

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.metadata?.decision_owner).toBe('shopping_agent_beauty_mainline');
    expect(res.body.metadata?.search_decision?.quality_gate_mode).toBe('observe_only');
    expect(res.body.metadata?.search_decision?.hit_quality_observation).toEqual(
      expect.objectContaining({
        hit_quality: 'invalid_hit',
        invalid_hit_reason: 'invalid_hit_all_non_skincare',
        raw_result_count: 2,
        products_returned_count: 0,
      }),
    );
    expect(res.body.metadata?.blocking_gate_id).toBeUndefined();
    expect(res.body.metadata?.blocking_reason).toBeUndefined();
  });

  it('public beauty search applies source priors and exposes provenance on broad beauty results', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'dog_noise_1',
            product_id: 'dog_noise_1',
            merchant_id: 'external_seed',
            title: 'Reflective Dog Harness for Small Dogs',
            name: 'Reflective Dog Harness for Small Dogs',
            display_name: 'Reflective Dog Harness for Small Dogs',
            category: 'pet accessories',
            product_type: 'harness',
            source: 'external_seed',
            pivota: { domain: 'other' },
            target_object: 'unknown',
            reason_codes: ['OBJ_UNCERTAIN', 'CAT_PARENT'],
          },
          {
            id: 'cache_spf_1',
            product_id: 'cache_spf_1',
            merchant_id: 'merchant_cache',
            title: 'Daily Face Sunscreen SPF 46',
            name: 'Daily Face Sunscreen SPF 46',
            display_name: 'Daily Face Sunscreen SPF 46',
            category: 'sunscreen',
            product_type: 'sunscreen',
            query_source: 'cache_all_platforms',
          },
          {
            id: 'internal_spf_1',
            product_id: 'internal_spf_1',
            merchant_id: 'merchant_internal',
            title: 'Oil Control Sunscreen SPF 50',
            name: 'Oil Control Sunscreen SPF 50',
            display_name: 'Oil Control Sunscreen SPF 50',
            category: 'sunscreen',
            product_type: 'sunscreen',
            source: 'upstream',
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

    expect(res.body.metadata?.decision_owner).toBe('shopping_agent_beauty_mainline');
    expect(res.body.metadata?.contract_bridge).toEqual(
      expect.objectContaining({
        resolved_contract: 'agent_v1_search_beauty_mainline',
      }),
    );
    expect(res.body.metadata?.semantic_contract).toEqual(
      expect.objectContaining({
        concern_class: 'sunscreen',
      }),
    );
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0]?.product_id || res.body.products[0]?.id).toBe('internal_spf_1');
    expect(res.body.metadata?.source_breakdown).toEqual(
      expect.objectContaining({
        internal_count: 2,
        external_seed_count: 0,
        stable_prior_count: 0,
        source_tier_counts: expect.objectContaining({
          fresh_internal: 1,
          cache_fresh: 1,
        }),
        source_quality_counts: expect.objectContaining({
          trusted: 1,
          mixed: 1,
        }),
        cache_owner_paths: expect.arrayContaining(['cache_all_platforms']),
        top_candidate_provenance: expect.objectContaining({
          source_channel: 'internal_search',
          source_tier: 'fresh_internal',
          source_quality_class: 'trusted',
        }),
      }),
    );
    expect(res.body.metadata?.search_stage_ledger?.primary_search).toEqual(
      expect.objectContaining({
        source_tier_counts: expect.objectContaining({
          fresh_internal: 1,
          cache_fresh: 1,
        }),
        top_candidate_provenance: expect.objectContaining({
          source_tier: 'fresh_internal',
        }),
      }),
    );
    expect(res.body.metadata?.search_decision).toEqual(
      expect.objectContaining({
        source_tier_counts: expect.objectContaining({
          fresh_internal: 1,
          cache_fresh: 1,
        }),
        top_candidate_provenance: expect.objectContaining({
          source_channel: 'internal_search',
        }),
      }),
    );
  });

  it('invoke beauty search derives the same beauty mainline contract without requiring semantic_contract input', async () => {
    let capturedQuery = null;
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => {
        capturedQuery = query;
        return true;
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'spf_invoke_1',
            product_id: 'spf_invoke_1',
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
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          query: 'best sunscreen for oily skin',
          messages: [{ role: 'user', content: 'best sunscreen for oily skin' }],
        },
        metadata: {},
      })
      .expect(200);

    expect(String(capturedQuery?.query || '').toLowerCase()).toBe('lightweight sunscreen oily skin');
    expect(capturedQuery).toEqual(
      expect.objectContaining({
        query: 'lightweight sunscreen oily skin',
        in_stock_only: 'true',
        limit: '20',
        offset: '0',
      }),
    );
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        semantic_owner: 'shopping_agent_beauty_mainline',
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_contract: expect.objectContaining({
          owner: 'shopping_agent_beauty_contract_builder',
          request_class: 'sunscreen',
          target_step_family: 'sunscreen',
          concern_class: 'sunscreen',
        }),
        search_stage_ledger: expect.objectContaining({
          final_decision: expect.objectContaining({
            owner: 'shopping_agent_beauty_mainline',
          }),
          primary_search: expect.objectContaining({
            query_pack_attempts: [
              expect.objectContaining({
                query: 'lightweight sunscreen oily skin',
                query_index: 0,
                query_total: 3,
              }),
            ],
          }),
        }),
      }),
    );
  });

  it('direct public beauty search and invoke gateway surface the same adopted oil-control ranking when upstream candidates match', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query(true)
      .times(2)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'deep_relief',
            product_id: 'deep_relief',
            merchant_id: 'external_seed',
            title: 'Deep Relief Acne Treatment',
            category: 'skincare',
            product_type: 'treatment',
            source: 'external_seed',
          },
          {
            id: 'niacinamide_zinc',
            product_id: 'niacinamide_zinc',
            merchant_id: 'external_seed',
            title: 'Niacinamide Serum 12% Plus Zinc 2%',
            category: 'skincare',
            product_type: 'serum',
            source: 'external_seed',
          },
          {
            id: 'vitamin_c',
            product_id: 'vitamin_c',
            merchant_id: 'external_seed',
            title: 'Vitamin C Super Serum Plus',
            category: 'skincare',
            product_type: 'serum',
            source: 'external_seed',
            description: 'Brightening serum for dark spots.',
            active_ingredients: ['Vitamin C', 'Niacinamide', 'Tranexamic acid'],
          },
        ],
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const direct = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'oil control treatment',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      })
      .expect(200);

    const invoke = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'oil control treatment',
            catalog_surface: 'beauty',
            commerce_surface: 'beauty',
          },
        },
        metadata: {
          source: 'aurora-bff',
          catalog_surface: 'beauty',
          commerce_surface: 'beauty',
        },
      })
      .expect(200);

    const directIds = (direct.body.products || []).slice(0, 3).map((item) => item.product_id || item.id);
    const invokeIds = (invoke.body.products || []).slice(0, 3).map((item) => item.product_id || item.id);

    expect(directIds).toEqual(invokeIds);
    expect(directIds[0]).toBe('niacinamide_zinc');
    expect(direct.body.metadata?.contract_bridge).toEqual(
      expect.objectContaining({
        resolved_contract: 'agent_v1_search_beauty_mainline',
      }),
    );
    expect(invoke.body.metadata?.contract_bridge).toEqual(
      expect.objectContaining({
        resolved_contract: 'agent_v1_search_beauty_mainline',
      }),
    );
  });

  it('direct public beauty search and invoke gateway keep real sunscreen formats ahead of sunscreen serums', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query(true)
      .times(2)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'uv_serum',
            product_id: 'uv_serum',
            merchant_id: 'external_seed',
            title: 'UV Filters SPF 45 Serum',
            category: 'serum',
            product_type: 'serum',
            source: 'external_seed',
            description: 'Daily lightweight SPF 45 serum for oily skin with broad spectrum UV filters.',
          },
          {
            id: 'mineral_spf',
            product_id: 'mineral_spf',
            merchant_id: 'external_seed',
            title: 'Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30',
            category: 'sunscreen',
            product_type: 'sunscreen',
            source: 'external_seed',
            description: 'Lightweight face sunscreen for oily skin with zinc oxide.',
          },
          {
            id: 'milk_spf',
            product_id: 'milk_spf',
            merchant_id: 'external_seed',
            title: 'Hydrating Sunscreen Milk Broad Spectrum SPF 45',
            category: 'sunscreen',
            product_type: 'sunscreen',
            source: 'external_seed',
            description: 'Daily face sunscreen milk with broad spectrum SPF 45.',
          },
        ],
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const direct = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'best sunscreen for oily skin',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      })
      .expect(200);

    const invoke = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'best sunscreen for oily skin',
            catalog_surface: 'beauty',
            commerce_surface: 'beauty',
          },
        },
        metadata: {
          source: 'aurora-bff',
          catalog_surface: 'beauty',
          commerce_surface: 'beauty',
        },
      })
      .expect(200);

    const directIds = (direct.body.products || []).slice(0, 3).map((item) => item.product_id || item.id);
    const invokeIds = (invoke.body.products || []).slice(0, 3).map((item) => item.product_id || item.id);

    expect(directIds).toEqual(invokeIds);
    expect(directIds[0]).toBe('mineral_spf');
    expect(directIds[1]).toBe('milk_spf');
    expect(directIds[2]).toBe('uv_serum');
    expect(direct.body.metadata?.contract_bridge).toEqual(
      expect.objectContaining({
        resolved_contract: 'agent_v1_search_beauty_mainline',
      }),
    );
    expect(invoke.body.metadata?.contract_bridge).toEqual(
      expect.objectContaining({
        resolved_contract: 'agent_v1_search_beauty_mainline',
      }),
    );
  });

  it('beauty mainline keeps treatment products when ambiguity only requires non-blocking clarify', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'treat_1',
            product_id: 'treat_1',
            merchant_id: 'merchant_treat',
            title: 'Oil Control Treatment Serum',
            name: 'Oil Control Treatment Serum',
            display_name: 'Oil Control Treatment Serum',
            category: 'skincare',
            product_type: 'serum',
          },
          {
            id: 'treat_2',
            product_id: 'treat_2',
            merchant_id: 'merchant_treat',
            title: 'Salicylic Acid Oil Control Treatment',
            name: 'Salicylic Acid Oil Control Treatment',
            display_name: 'Salicylic Acid Oil Control Treatment',
            category: 'skincare',
            product_type: 'treatment',
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
          query: 'oil control treatment',
          messages: [{ role: 'user', content: 'oil control treatment' }],
        },
        metadata: {},
      })
      .expect(200);

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        semantic_owner: 'shopping_agent_beauty_mainline',
        decision_owner: 'shopping_agent_beauty_mainline',
        query_source: 'agent_products_search',
      }),
    );
    expect(res.body.metadata?.search_stage_ledger?.final_decision).toEqual(
      expect.objectContaining({
        owner: 'shopping_agent_beauty_mainline',
      }),
    );
    expect(String(res.body.metadata?.search_decision?.final_decision || '')).toBe(
      'products_returned_with_clarification',
    );
    expect(Array.isArray(res.body.reason_codes)).toBe(true);
    expect(res.body.reason_codes).toContain('AMBIGUITY_CLARIFY');
    expect(res.body.reason_codes).not.toContain('FILTERED_TO_EMPTY');
  });

  it('beauty semantic-owner query pack retries after a non-empty invalid_hit first treatment query', async () => {
    const attemptedQueries = [];
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => {
        attemptedQueries.push(String(query?.query || ''));
        return true;
      })
      .times(2)
      .reply(function replyVariant() {
        const latestQuery = attemptedQueries[attemptedQueries.length - 1];
        if (latestQuery === 'oil control treatment') {
          return [200, {
            status: 'success',
            success: true,
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
                id: 'lip_1',
                product_id: 'lip_1',
                title: 'Peptide Lip Treatment Strawberry Glaze',
                name: 'Peptide Lip Treatment Strawberry Glaze',
                display_name: 'Peptide Lip Treatment Strawberry Glaze',
                category: 'lip treatment',
                product_type: 'treatment',
              },
            ],
            metadata: {
              query_source: 'agent_products_search',
            },
          }];
        }
        return [200, {
          status: 'success',
          success: true,
          products: [
            {
              id: 'treat_valid_1',
              product_id: 'treat_valid_1',
              merchant_id: 'merchant_treat',
              title: 'Salicylic Acid Oil Control Treatment',
              name: 'Salicylic Acid Oil Control Treatment',
              display_name: 'Salicylic Acid Oil Control Treatment',
              category: 'skincare',
              product_type: 'treatment',
            },
          ],
          metadata: {
            query_source: 'agent_products_search',
          },
        }];
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'oil control treatment',
            catalog_surface: 'beauty',
            semantic_contract: {
              version: 'beauty_semantic_contract_v1',
              owner: 'aurora_reco_planner',
              planner_mode: 'framework_generic',
              request_class: 'generic_concern',
              target_step_family: 'treatment',
              primary_role_id: 'oil_control_treatment',
              support_role_ids: ['lightweight_moisturizer', 'daily_sunscreen'],
              semantic_family: 'oil_control',
              allowed_step_families: ['treatment', 'serum', 'moisturizer', 'sunscreen'],
              blocked_step_families: [],
              ingredient_hypotheses: ['salicylic acid'],
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

    expect(attemptedQueries).toEqual(['oil control treatment', 'salicylic acid treatment']);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0]?.product_id || res.body.products[0]?.id).toBe('treat_valid_1');
    expect(res.body.metadata?.search_decision?.quality_gate_mode || null).toBe(null);
    expect(res.body.metadata?.search_decision?.hit_quality).toBe('valid_hit');
    expect(res.body.metadata?.semantic_owner_query_attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          query: 'oil control treatment',
          query_index: 0,
          adopted: false,
          hit_quality: 'invalid_hit',
        }),
        expect.objectContaining({
          query: 'salicylic acid treatment',
          query_index: 1,
          adopted: true,
          hit_quality: 'valid_hit',
        }),
      ]),
    );
  });

  it('beauty semantic-owner treatment uses ingredient-led external rescue after pure cache invalid queries', async () => {
    const attemptedPrimaryQueries = [];
    const attemptedExternalQueries = [];
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => {
        if (String(query?.external_seed_only || '').trim() === 'true') return false;
        attemptedPrimaryQueries.push(String(query?.query || ''));
        return true;
      })
      .times(3)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'dog_noise_treat_1',
            product_id: 'dog_noise_treat_1',
            merchant_id: 'merchant_cache',
            title: 'Reflective Dog Harness',
            name: 'Reflective Dog Harness',
            display_name: 'Reflective Dog Harness',
            category: null,
            product_type: null,
            query_source: 'cache_all_platforms',
          },
        ],
        metadata: {
          query_source: 'cache_all_platforms',
        },
      });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => {
        if (String(query?.external_seed_only || '').trim() !== 'true') return false;
        attemptedExternalQueries.push(String(query?.query || ''));
        return true;
      })
      .times(4)
      .reply(function replyExternalTreatment(uri) {
        const url = new URL(`${process.env.PIVOTA_API_BASE}${uri}`);
        const rescueQuery = String(url.searchParams.get('query') || '');
        if (rescueQuery === 'salicylic acid treatment') {
          return [200, {
            status: 'success',
            success: true,
            products: [
              {
                id: 'external_treat_1',
                product_id: 'external_treat_1',
                merchant_id: 'external_seed',
                title: 'Salicylic Acid Oil Control Treatment',
                name: 'Salicylic Acid Oil Control Treatment',
                display_name: 'Salicylic Acid Oil Control Treatment',
                category: 'external',
                product_type: 'external',
                source: 'external_seed',
                description: 'Face treatment with salicylic acid for oily skin and blemish control.',
                how_to_use: 'Apply to oily areas after cleansing.',
              },
            ],
            metadata: {
              query_source: 'agent_products_external_seed_direct',
            },
          }];
        }
        return [200, {
          status: 'success',
          success: true,
          products: [],
          metadata: {
            query_source: 'agent_products_external_seed_direct',
          },
        }];
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'oil control treatment',
            catalog_surface: 'beauty',
            semantic_contract: {
              version: 'beauty_semantic_contract_v1',
              owner: 'aurora_reco_planner',
              planner_mode: 'framework_generic',
              request_class: 'generic_concern',
              target_step_family: 'treatment',
              primary_role_id: 'oil_control_treatment',
              support_role_ids: ['lightweight_moisturizer', 'daily_sunscreen'],
              semantic_family: 'oil_control',
              allowed_step_families: ['treatment', 'serum', 'moisturizer', 'sunscreen'],
              blocked_step_families: [],
              ingredient_hypotheses: ['salicylic acid'],
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

    expect(attemptedPrimaryQueries).toEqual([
      'oil control treatment',
      'salicylic acid treatment',
      'oil control serum',
    ]);
    expect(attemptedExternalQueries).toEqual([
      'salicylic acid treatment',
    ]);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0]?.product_id || res.body.products[0]?.id).toBe('external_treat_1');
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        semantic_owner_external_rescue_applied: true,
        semantic_owner_external_rescue_query: 'salicylic acid treatment',
        semantic_owner_external_rescue_queries_attempted: expect.arrayContaining([
          'salicylic acid treatment',
          'oil control treatment',
          'oil control serum',
        ]),
      }),
    );
  });

  it('beauty semantic-owner defers cache_all_platforms valid treatment hits before deciding whether rescue is stronger', async () => {
    const attemptedPrimaryQueries = [];
    const attemptedExternalQueries = [];
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => {
        if (String(query?.external_seed_only || '').trim() === 'true') return false;
        attemptedPrimaryQueries.push(String(query?.query || ''));
        return true;
      })
      .times(3)
      .reply(function replyPrimaryTreatment(uri) {
        const url = new URL(`${process.env.PIVOTA_API_BASE}${uri}`);
        const primaryQuery = String(url.searchParams.get('query') || '');
        if (primaryQuery === 'oil control treatment') {
          return [200, {
            status: 'success',
            success: true,
            products: [
              {
                id: 'cache_treat_valid_1',
                product_id: 'cache_treat_valid_1',
                merchant_id: 'merchant_cache',
                title: 'The Ordinary Niacinamide 10% + Zinc 1%',
                name: 'The Ordinary Niacinamide 10% + Zinc 1%',
                display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
                category: 'skincare',
                product_type: 'serum',
                query_source: 'cache_all_platforms',
              },
            ],
            metadata: {
              query_source: 'cache_all_platforms',
            },
          }];
        }
        return [200, {
          status: 'success',
          success: true,
          products: [],
          metadata: {
            query_source: 'agent_products_search',
          },
        }];
      });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => {
        if (String(query?.external_seed_only || '').trim() !== 'true') return false;
        attemptedExternalQueries.push(String(query?.query || ''));
        return true;
      })
      .times(6)
      .reply(function replyExternalTreatment(uri) {
        const url = new URL(`${process.env.PIVOTA_API_BASE}${uri}`);
        const rescueQuery = String(url.searchParams.get('query') || '');
        if (rescueQuery === 'salicylic acid treatment') {
          return [200, {
            status: 'success',
            success: true,
            products: [
              {
                id: 'external_treat_2',
                product_id: 'external_treat_2',
                merchant_id: 'external_seed',
                title: 'Salicylic Acid Oil Control Treatment',
                name: 'Salicylic Acid Oil Control Treatment',
                display_name: 'Salicylic Acid Oil Control Treatment',
                category: 'external',
                product_type: 'external',
                source: 'external_seed',
                description: 'Face treatment with salicylic acid for oily skin and blemish control.',
                how_to_use: 'Apply to oily areas after cleansing.',
              },
            ],
            metadata: {
              query_source: 'agent_products_external_seed_direct',
            },
          }];
        }
        return [200, {
          status: 'success',
          success: true,
          products: [],
          metadata: {
            query_source: 'agent_products_external_seed_direct',
          },
        }];
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'oil control treatment',
            catalog_surface: 'beauty',
            semantic_contract: {
              version: 'beauty_semantic_contract_v1',
              owner: 'aurora_reco_planner',
              planner_mode: 'framework_generic',
              request_class: 'generic_concern',
              target_step_family: 'treatment',
              primary_role_id: 'oil_control_treatment',
              support_role_ids: ['lightweight_moisturizer', 'daily_sunscreen'],
              semantic_family: 'oil_control',
              allowed_step_families: ['treatment', 'serum', 'moisturizer', 'sunscreen'],
              blocked_step_families: [],
              ingredient_hypotheses: ['salicylic acid'],
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

    expect(attemptedPrimaryQueries).toEqual([
      'oil control treatment',
      'salicylic acid treatment',
      'oil control serum',
    ]);
    expect(attemptedExternalQueries[0]).toBe('salicylic acid treatment');
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0]?.product_id || res.body.products[0]?.id).toBe('cache_treat_valid_1');
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        semantic_owner_last_resort_cache_applied: true,
        semantic_owner_last_resort_cache_query: 'oil control treatment',
      }),
    );
    expect(res.body.metadata?.semantic_owner_query_attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          query: 'oil control treatment',
          query_index: 0,
          adopted: true,
          adoption_mode: 'last_resort_cache',
          hit_quality: 'valid_hit',
          last_resort_cache_candidate: true,
        }),
        expect.objectContaining({
          query: 'salicylic acid treatment',
          query_index: 1,
          adopted: false,
        }),
      ]),
    );
  });

  it('beauty semantic-owner falls back to last-resort cache only after fresh rescue misses', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => String(query?.external_seed_only || '').trim() !== 'true')
      .times(3)
      .reply(function replyPrimaryTreatment(uri) {
        const url = new URL(`${process.env.PIVOTA_API_BASE}${uri}`);
        const primaryQuery = String(url.searchParams.get('query') || '');
        if (primaryQuery === 'oil control treatment') {
          return [200, {
            status: 'success',
            success: true,
            products: [
              {
                id: 'cache_treat_valid_2',
                product_id: 'cache_treat_valid_2',
                merchant_id: 'merchant_cache',
                title: 'The Ordinary Niacinamide 10% + Zinc 1%',
                name: 'The Ordinary Niacinamide 10% + Zinc 1%',
                display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
                category: 'skincare',
                product_type: 'serum',
                query_source: 'cache_all_platforms',
              },
            ],
            metadata: {
              query_source: 'cache_all_platforms',
            },
          }];
        }
        return [200, {
          status: 'success',
          success: true,
          products: [],
          metadata: {
            query_source: 'agent_products_search',
          },
        }];
      });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => String(query?.external_seed_only || '').trim() === 'true')
      .times(6)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        metadata: {
          query_source: 'agent_products_external_seed_direct',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'oil control treatment',
            catalog_surface: 'beauty',
            semantic_contract: {
              version: 'beauty_semantic_contract_v1',
              owner: 'aurora_reco_planner',
              planner_mode: 'framework_generic',
              request_class: 'generic_concern',
              target_step_family: 'treatment',
              primary_role_id: 'oil_control_treatment',
              support_role_ids: ['lightweight_moisturizer', 'daily_sunscreen'],
              semantic_family: 'oil_control',
              allowed_step_families: ['treatment', 'serum', 'moisturizer', 'sunscreen'],
              blocked_step_families: [],
              ingredient_hypotheses: ['salicylic acid'],
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

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0]?.product_id || res.body.products[0]?.id).toBe('cache_treat_valid_2');
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        semantic_owner_last_resort_cache_applied: true,
        semantic_owner_last_resort_cache_query: 'oil control treatment',
      }),
    );
    expect(res.body.metadata?.source_breakdown?.strategy_applied).toBe(
      'semantic_owner_last_resort_cache',
    );
    expect(res.body.metadata?.semantic_owner_query_attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          query: 'oil control treatment',
          query_index: 0,
          adopted: true,
          adoption_mode: 'last_resort_cache',
          hit_quality: 'valid_hit',
          last_resort_cache_candidate: true,
        }),
      ]),
    );
  });

  it('beauty semantic-owner keeps stronger deferred cache when external rescue is weaker', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => String(query?.external_seed_only || '').trim() !== 'true')
      .times(3)
      .reply(function replyPrimaryTreatment(uri) {
        const url = new URL(`${process.env.PIVOTA_API_BASE}${uri}`);
        const primaryQuery = String(url.searchParams.get('query') || '');
        if (primaryQuery === 'oil control treatment') {
          return [200, {
            status: 'success',
            success: true,
            products: [
              {
                id: 'cache_treat_valid_3',
                product_id: 'cache_treat_valid_3',
                merchant_id: 'merchant_cache',
                title: 'The Ordinary Niacinamide 10% + Zinc 1%',
                name: 'The Ordinary Niacinamide 10% + Zinc 1%',
                display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
                category: 'skincare',
                product_type: 'serum',
                query_source: 'cache_all_platforms',
              },
            ],
            metadata: {
              query_source: 'cache_all_platforms',
            },
          }];
        }
        return [200, {
          status: 'success',
          success: true,
          products: [],
          metadata: {
            query_source: 'agent_products_search',
          },
        }];
      });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => String(query?.external_seed_only || '').trim() === 'true')
      .times(6)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'external_treat_weak_1',
            product_id: 'external_treat_weak_1',
            merchant_id: 'external_seed',
            title: 'Vitamin C Super Serum Plus - Jumbo',
            name: 'Vitamin C Super Serum Plus - Jumbo',
            display_name: 'Vitamin C Super Serum Plus - Jumbo',
            category: 'external',
            product_type: 'external',
            source: 'external_seed',
            description: 'Brightening serum with vitamin C.',
            how_to_use: 'Apply daily.',
          },
        ],
        metadata: {
          query_source: 'agent_products_external_seed_direct',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'oil control treatment',
            catalog_surface: 'beauty',
            semantic_contract: {
              version: 'beauty_semantic_contract_v1',
              owner: 'aurora_reco_planner',
              planner_mode: 'framework_generic',
              request_class: 'generic_concern',
              target_step_family: 'treatment',
              primary_role_id: 'oil_control_treatment',
              support_role_ids: ['lightweight_moisturizer', 'daily_sunscreen'],
              semantic_family: 'oil_control',
              allowed_step_families: ['treatment', 'serum', 'moisturizer', 'sunscreen'],
              blocked_step_families: [],
              ingredient_hypotheses: ['salicylic acid'],
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

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0]?.product_id || res.body.products[0]?.id).toBe('cache_treat_valid_3');
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        semantic_owner_last_resort_cache_applied: true,
        semantic_owner_last_resort_cache_query: 'oil control treatment',
      }),
    );
    expect(res.body.metadata?.semantic_owner_external_rescue_applied || null).toBe(null);
  });

  it('beauty semantic-owner isolates pure cache invalid treatment noise when rescue also fails', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => String(query?.external_seed_only || '').trim() !== 'true')
      .times(3)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'dog_noise_treat_2',
            product_id: 'dog_noise_treat_2',
            merchant_id: 'merchant_cache',
            title: 'Dog Leash for Running',
            name: 'Dog Leash for Running',
            display_name: 'Dog Leash for Running',
            category: null,
            product_type: null,
            query_source: 'cache_all_platforms',
          },
        ],
        metadata: {
          query_source: 'cache_all_platforms',
        },
      });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => String(query?.external_seed_only || '').trim() === 'true')
      .times(4)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        metadata: {
          query_source: 'agent_products_external_seed_direct',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'oil control treatment',
            catalog_surface: 'beauty',
            semantic_contract: {
              version: 'beauty_semantic_contract_v1',
              owner: 'aurora_reco_planner',
              planner_mode: 'framework_generic',
              request_class: 'generic_concern',
              target_step_family: 'treatment',
              primary_role_id: 'oil_control_treatment',
              support_role_ids: ['lightweight_moisturizer', 'daily_sunscreen'],
              semantic_family: 'oil_control',
              allowed_step_families: ['treatment', 'serum', 'moisturizer', 'sunscreen'],
              blocked_step_families: [],
              ingredient_hypotheses: ['salicylic acid'],
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

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(0);
    expect(res.body.metadata?.semantic_owner_cache_source_isolated).toBe(true);
    expect(res.body.metadata?.semantic_owner_cache_source_isolation_reason).toBe('pure_cache_invalid_hit');
    expect(res.body.metadata?.semantic_owner_external_rescue_queries_attempted).toEqual(
      expect.arrayContaining([
        'salicylic acid treatment',
      ]),
    );
    expect(res.body.metadata?.source_breakdown?.strategy_applied).toBe(
      'semantic_owner_cache_source_isolated',
    );
  });

  it('beauty semantic-owner sunscreen retries past cache noise and adopts external sunscreen candidate', async () => {
    const attemptedQueries = [];
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => {
        attemptedQueries.push(String(query?.query || ''));
        return true;
      })
      .times(2)
      .reply(function replyVariant() {
        const latestQuery = attemptedQueries[attemptedQueries.length - 1];
        if (latestQuery === 'lightweight sunscreen oily skin') {
          return [200, {
            status: 'success',
            success: true,
            products: [
              {
                id: 'dog_noise_1',
                product_id: 'dog_noise_1',
                merchant_id: 'merchant_cache',
                title: 'Reflective Dog Harness for Small Dogs',
                name: 'Reflective Dog Harness for Small Dogs',
                display_name: 'Reflective Dog Harness for Small Dogs',
                category: null,
                product_type: null,
                query_source: 'cache_all_platforms',
              },
            ],
            metadata: {
              query_source: 'cache_all_platforms',
            },
          }];
        }
        return [200, {
          status: 'success',
          success: true,
          products: [
            {
              id: 'external_spf_1',
              product_id: 'external_spf_1',
              merchant_id: 'external_seed',
              title: 'UV Filters SPF 45 Serum',
              name: 'UV Filters SPF 45 Serum',
              display_name: 'UV Filters SPF 45 Serum',
              category: 'external',
              product_type: 'external',
              source: 'external_seed',
              description: 'Daily lightweight SPF 45 serum for oily skin with broad spectrum UV filters. Apply liberally 15 minutes before sun exposure and reapply every 2 hours.',
              how_to_use: 'Apply to face every morning as the final skincare step before sun exposure.',
            },
          ],
          metadata: {
            query_source: 'agent_products_search',
          },
        }];
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

    expect(attemptedQueries).toEqual(['lightweight sunscreen oily skin', 'oil control sunscreen']);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0]?.product_id || res.body.products[0]?.id).toBe('external_spf_1');
    expect(res.body.metadata?.semantic_owner_query_attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          query: 'lightweight sunscreen oily skin',
          query_index: 0,
          adopted: false,
          hit_quality: 'invalid_hit',
          invalid_hit_reason: 'invalid_hit_all_non_skincare',
          observation_candidate_ignored: true,
          observation_ignore_reason: 'pure_cache_invalid_hit',
        }),
        expect.objectContaining({
          query: 'oil control sunscreen',
          query_index: 1,
          adopted: true,
          hit_quality: 'valid_hit',
        }),
      ]),
    );
  });

  it('beauty semantic-owner keeps retrying past pure cache invalid sunscreen candidates until a later external sunscreen query wins', async () => {
    const attemptedQueries = [];
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => {
        attemptedQueries.push(String(query?.query || ''));
        return true;
      })
      .times(3)
      .reply(function replyVariant() {
        const latestQuery = attemptedQueries[attemptedQueries.length - 1];
        if (latestQuery === 'face sunscreen spf') {
          return [200, {
            status: 'success',
            success: true,
            products: [
              {
                id: 'external_spf_2',
                product_id: 'external_spf_2',
                merchant_id: 'external_seed',
                title: 'UV Filters SPF 45 Serum',
                name: 'UV Filters SPF 45 Serum',
                display_name: 'UV Filters SPF 45 Serum',
                category: 'external',
                product_type: 'external',
                source: 'external_seed',
                description: 'Daily lightweight SPF 45 serum for oily skin with broad spectrum UV filters. Apply liberally 15 minutes before sun exposure and reapply every 2 hours.',
                how_to_use: 'Apply to face every morning as the final skincare step before sun exposure.',
              },
            ],
            metadata: {
              query_source: 'agent_products_search',
            },
          }];
        }
        return [200, {
          status: 'success',
          success: true,
          products: [
            {
              id: latestQuery === 'lightweight sunscreen oily skin' ? 'dog_noise_2' : 'sleepwear_noise_1',
              product_id: latestQuery === 'lightweight sunscreen oily skin' ? 'dog_noise_2' : 'sleepwear_noise_1',
              merchant_id: 'merchant_cache',
              title:
                latestQuery === 'lightweight sunscreen oily skin'
                  ? 'Reflective Dog Harness for Small Dogs'
                  : "Velvet Padded Deep V women's sleepwear set 6271",
              name:
                latestQuery === 'lightweight sunscreen oily skin'
                  ? 'Reflective Dog Harness for Small Dogs'
                  : "Velvet Padded Deep V women's sleepwear set 6271",
              display_name:
                latestQuery === 'lightweight sunscreen oily skin'
                  ? 'Reflective Dog Harness for Small Dogs'
                  : "Velvet Padded Deep V women's sleepwear set 6271",
              category: null,
              product_type: null,
              query_source: 'cache_all_platforms',
            },
          ],
          metadata: {
            query_source: 'cache_all_platforms',
          },
        }];
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

    expect(attemptedQueries).toEqual([
      'lightweight sunscreen oily skin',
      'oil control sunscreen',
      'face sunscreen spf',
    ]);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0]?.product_id || res.body.products[0]?.id).toBe('external_spf_2');
    expect(res.body.metadata?.semantic_owner_query_attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          query: 'lightweight sunscreen oily skin',
          query_index: 0,
          adopted: false,
          hit_quality: 'invalid_hit',
          observation_candidate_ignored: true,
        }),
        expect.objectContaining({
          query: 'oil control sunscreen',
          query_index: 1,
          adopted: false,
          hit_quality: 'invalid_hit',
          observation_candidate_ignored: true,
        }),
        expect.objectContaining({
          query: 'face sunscreen spf',
          query_index: 2,
          adopted: true,
          hit_quality: 'valid_hit',
        }),
      ]),
    );
  });

  it('beauty semantic-owner uses external rescue when every primary sunscreen query is pure cache invalid', async () => {
    const attemptedPrimaryQueries = [];
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => {
        if (String(query?.external_seed_only || '').trim() === 'true') return false;
        attemptedPrimaryQueries.push(String(query?.query || ''));
        return true;
      })
      .times(3)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'tool_noise_1',
            product_id: 'tool_noise_1',
            merchant_id: 'merchant_cache',
            title: 'Foundation Brush',
            name: 'Foundation Brush',
            display_name: 'Foundation Brush',
            category: null,
            product_type: null,
            query_source: 'cache_all_platforms',
          },
        ],
        metadata: {
          query_source: 'cache_all_platforms',
        },
      });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((query) => {
        if (String(query?.external_seed_only || '').trim() !== 'true') return false;
        return (
          String(query?.query || '').trim() === 'face sunscreen spf' &&
          String(query?.target_step_family || '').trim() === 'sunscreen' &&
          String(query?.semantic_family || '').trim() === 'sunscreen'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'external_spf_rescue_1',
            product_id: 'external_spf_rescue_1',
            merchant_id: 'external_seed',
            title: 'UV Filters SPF 45 Serum',
            name: 'UV Filters SPF 45 Serum',
            display_name: 'UV Filters SPF 45 Serum',
            category: 'external',
            product_type: 'external',
            source: 'external_seed',
            description: 'Daily lightweight SPF 45 serum for oily skin with broad spectrum UV filters.',
            how_to_use: 'Apply to face every morning as the final skincare step before sun exposure.',
          },
        ],
        metadata: {
          query_source: 'agent_products_external_seed_direct',
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

    expect(attemptedPrimaryQueries).toEqual([
      'lightweight sunscreen oily skin',
      'oil control sunscreen',
      'face sunscreen spf',
    ]);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0]?.product_id || res.body.products[0]?.id).toBe('external_spf_rescue_1');
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        semantic_owner_external_rescue_applied: true,
        semantic_owner_external_rescue_query: 'face sunscreen spf',
      }),
    );
    expect(res.body.metadata?.semantic_owner_query_attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          query: 'face sunscreen spf',
          query_index: 2,
          adopted: true,
          adoption_mode: 'external_seed_rescue',
        }),
      ]),
    );
  });

  it('marks brush-only skincare results as invalid_hit observation instead of strict_empty', async () => {
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
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, upstreamBody);

    const res = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'barrier repair moisturizer',
        catalog_surface: 'beauty',
        source: 'aurora-bff',
      })
      .expect(200);

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products).toHaveLength(2);
    expect(res.body.metadata?.decision_owner).toBe('shopping_agent_beauty_mainline');
    expect(res.body.metadata?.search_decision?.quality_gate_mode).toBe('observe_only');
    expect(res.body.metadata?.search_decision?.final_decision).toBe('products_returned');
    expect(res.body.metadata?.search_decision?.hit_quality_observation).toEqual(
      expect.objectContaining({
        contract_version: 'beauty_search_decision_v4',
        hit_quality: 'invalid_hit',
        invalid_hit_reason: 'invalid_hit_tools_dominant',
        raw_result_count: 2,
        products_returned_count: 0,
      }),
    );
    expect(res.body.metadata?.blocking_gate_id).toBeUndefined();
    expect(res.body.metadata?.pre_gate_count).toBeUndefined();
    expect(res.body.metadata?.post_gate_count).toBeUndefined();
    expect(res.body.metadata?.blocking_reason).toBeUndefined();
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
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, upstreamBody);
    nock('http://localhost:8080')
      .post('/agent/shop/v1/invoke')
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
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(
      res.body.products.some((product) =>
        ['body_1', 'body_2'].includes(String(product?.product_id || product?.id || '')),
      ),
    ).toBe(true);
    expect(res.body.metadata?.decision_owner).toBe('shopping_agent_beauty_mainline');
    expect(res.body.metadata?.search_decision?.quality_gate_mode).toBe('observe_only');
    expect(res.body.metadata?.search_decision?.hit_quality_observation).toEqual(
      expect.objectContaining({
        hit_quality: 'invalid_hit',
        invalid_hit_reason: 'invalid_hit_all_non_skincare',
        raw_result_count: 2,
        products_returned_count: 0,
      }),
    );
    expect(res.body.metadata?.blocking_gate_id).toBeUndefined();
    expect(res.body.metadata?.pre_gate_count).toBeUndefined();
    expect(res.body.metadata?.post_gate_count).toBeUndefined();
    expect(res.body.metadata?.blocking_reason).toBeUndefined();
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
      .get('/agent/v1/products/search')
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

    expect(res.body.metadata?.decision_owner).toBe('shopping_agent_beauty_mainline');
    expect(res.body.metadata?.search_decision?.quality_gate_mode).toBe('observe_only');
    expect(res.body.metadata?.search_decision?.hit_quality_observation).toEqual(
      expect.objectContaining({
        hit_quality: 'valid_hit',
        same_family_topk_count: expect.any(Number),
      }),
    );
    expect(res.body.metadata?.search_decision?.hit_quality_observation?.same_family_topk_count).toBeGreaterThan(0);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0]?.product_id).toBe('cream_1');
    expect(res.body.products.map((row) => String(row?.product_id || ''))).toEqual([
      'cream_1',
      'spf_1',
      'cleanser_1',
      'body_1',
    ]);
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
      .get('/agent/v1/products/search')
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
