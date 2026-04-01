const nock = require('nock');
const request = require('supertest');

describe('/agent/shop/v1/invoke creator human apparel external seed main path', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.dontMock('../../src/findProductsMulti/policy');
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => {
      const h = String(host || '');
      return h.includes('127.0.0.1') || h.includes('localhost') || h === '::1';
    });

    prevEnv = {
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      API_MODE: process.env.API_MODE,
      DATABASE_URL: process.env.DATABASE_URL,
      FIND_PRODUCTS_MULTI_VECTOR_ENABLED: process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED,
      FIND_PRODUCTS_MULTI_ROUTE_DEBUG: process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = 'false';
    process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = '1';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.dontMock('../../src/db');
    jest.dontMock('../../src/findProductsMulti/policy');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();

    if (!prevEnv) return;
    if (prevEnv.PIVOTA_API_BASE === undefined) delete process.env.PIVOTA_API_BASE;
    else process.env.PIVOTA_API_BASE = prevEnv.PIVOTA_API_BASE;
    if (prevEnv.PIVOTA_API_KEY === undefined) delete process.env.PIVOTA_API_KEY;
    else process.env.PIVOTA_API_KEY = prevEnv.PIVOTA_API_KEY;
    if (prevEnv.API_MODE === undefined) delete process.env.API_MODE;
    else process.env.API_MODE = prevEnv.API_MODE;
    if (prevEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevEnv.DATABASE_URL;
    if (prevEnv.FIND_PRODUCTS_MULTI_VECTOR_ENABLED === undefined) {
      delete process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED;
    } else {
      process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = prevEnv.FIND_PRODUCTS_MULTI_VECTOR_ENABLED;
    }
    if (prevEnv.FIND_PRODUCTS_MULTI_ROUTE_DEBUG === undefined) {
      delete process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG;
    } else {
      process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = prevEnv.FIND_PRODUCTS_MULTI_ROUTE_DEBUG;
    }
    if (prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED === undefined) {
      delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    } else {
      process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    }
  });

  test('returns direct external seed results on creator cache miss without calling upstream search', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return { rows: [] };
        }
        if (text.includes('FROM external_product_seeds')) {
          return {
            rows: [
              {
                id: 'sleepwear-seed-1',
                external_product_id: 'ext_sleepwear_1',
                market: 'US',
                tool: 'creator_agents',
                destination_url: 'https://shop.example.com/products/plus-size-sleepwear-set',
                canonical_url: 'https://shop.example.com/products/plus-size-sleepwear-set',
                domain: 'shop.example.com',
                title: "Velvet Plus Size Padded Push-Up women's sleepwear set 4786",
                image_url: 'https://cdn.example.com/sleepwear.jpg',
                price_amount: '39.90',
                price_currency: 'USD',
                availability: 'in stock',
                seed_data: {
                  brand: 'Velvet',
                  category: 'sleepwear',
                  description: 'Figure-flattering plus size sleepwear lounge set with matching bottoms.',
                  snapshot: {
                    title: "Velvet Plus Size Padded Push-Up women's sleepwear set 4786",
                    brand: 'Velvet',
                    category: 'sleepwear',
                    description: 'Figure-flattering plus size sleepwear lounge set with matching bottoms.',
                    destination_url: 'https://shop.example.com/products/plus-size-sleepwear-set',
                    canonical_url: 'https://shop.example.com/products/plus-size-sleepwear-set',
                  },
                },
                updated_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
              {
                id: 'body-cream-seed-1',
                external_product_id: 'ext_body_cream_1',
                market: 'US',
                tool: 'creator_agents',
                destination_url: 'https://shop.example.com/products/ginger-cream-cookie-whipped-body-cream',
                canonical_url: 'https://shop.example.com/products/ginger-cream-cookie-whipped-body-cream',
                domain: 'shop.example.com',
                title: 'Ginger Cream Cookie Whipped Body Cream',
                image_url: 'https://cdn.example.com/body-cream.jpg',
                price_amount: '22.00',
                price_currency: 'USD',
                availability: 'in stock',
                seed_data: {
                  brand: 'Beekman 1802',
                  category: 'Moisturizer',
                  description:
                    "Made with our signature goat milk blend and scented with notes of sweet cream while making you feel warm and cozy on the inside. Ingredients include Mangifera Indica (Mango) Seed Butter.",
                },
                updated_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
              {
                id: 'anti-chafe-seed-1',
                external_product_id: 'ext_anti_chafe_1',
                market: 'US',
                tool: 'creator_agents',
                destination_url: 'https://shop.example.com/products/anti-chafe-stick',
                canonical_url: 'https://shop.example.com/products/anti-chafe-stick',
                domain: 'shop.example.com',
                title: 'Anti-Chafe Stick with Shea Butter + Colloidal Oatmeal',
                image_url: 'https://cdn.example.com/anti-chafe.jpg',
                price_amount: '16.00',
                price_currency: 'USD',
                availability: 'in stock',
                seed_data: {
                  brand: 'First Aid Beauty',
                  category: 'body care',
                  description:
                    'For running errands or running a race, take the day in stride and swap uncomfortable chafing for a smooth, non-greasy glide.',
                },
                updated_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'plus size sleepwear',
            page: 1,
            limit: 10,
            in_stock_only: true,
            allow_external_seed: true,
            external_seed_strategy: 'unified_relevance',
            search_all_merchants: true,
          },
        },
        metadata: {
          source: 'creator-agent-ui',
        },
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.products.map((product) => product.product_id)).toContain('ext_sleepwear_1');
    expect(resp.body.products.map((product) => product.product_id)).not.toContain('ext_body_cream_1');
    expect(resp.body.products.map((product) => product.product_id)).not.toContain('ext_anti_chafe_1');
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_sleepwear_1',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_creator_external_seed_direct',
        external_seed_returned_count: expect.any(Number),
      }),
    );
    expect(upstreamSearch.isDone()).toBe(false);
    expect(String(resp.body.reply || '')).not.toContain('Search is temporarily unavailable');
  });

  test('uses direct creator human apparel main path when creator cache has non-short-circuit brand hits', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total') && text.includes('FROM products_cache')) {
          return { rows: [{ total: 1 }] };
        }
        if (text.includes('SELECT product_data') && text.includes('FROM products_cache')) {
          return {
            rows: [
              {
                product_data: {
                  id: 'internal_1',
                  product_id: 'internal_1',
                  merchant_id: 'merch_1',
                  title: 'Hydrating Lip Balm',
                  description: 'Irrelevant internal cache hit to avoid cache short-circuiting.',
                  status: 'published',
                  inventory_quantity: 4,
                  price: 12,
                  currency: 'USD',
                },
              },
            ],
          };
        }
        if (text.includes('FROM external_product_seeds')) {
          return {
            rows: [
              {
                id: 'beauty-seed-1',
                external_product_id: 'ext_face_wipes_1',
                market: 'US',
                tool: 'creator_agents',
                destination_url: 'https://shop.example.com/products/lavender-face-wipes',
                canonical_url: 'https://shop.example.com/products/lavender-face-wipes',
                domain: 'shop.example.com',
                title: 'Lilac Dream Face Wipes',
                image_url: 'https://cdn.example.com/face-wipes.jpg',
                price_amount: '18.00',
                price_currency: 'USD',
                availability: 'in stock',
                seed_data: {
                  brand: 'Beekman 1802',
                  category: 'Cleanser',
                  description:
                    "With a pack of our Goat Milk Wipes in your purse, gym bag, car (or wherever), you can freshen up anytime. Directions: Lift seal & remove wipe. After use, dispose of wipe in trash. Scent Notes: Top: Jasmine, Lilac, Rose.",
                },
                updated_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
              {
                id: 'zara-seed-1',
                external_product_id: 'ext_zara_blazer_1',
                market: 'US',
                tool: 'creator_agents',
                destination_url: 'https://shop.example.com/products/zara-tailored-blazer',
                canonical_url: 'https://shop.example.com/products/zara-tailored-blazer',
                domain: 'shop.example.com',
                title: 'Zara Tailored Blazer',
                image_url: 'https://cdn.example.com/zara-blazer.jpg',
                price_amount: '89.90',
                price_currency: 'USD',
                availability: 'in stock',
                seed_data: {
                  brand: 'Zara',
                  category: 'blazer',
                  description: 'Single-breasted tailored blazer for women.',
                },
                updated_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'zara blazer',
            page: 1,
            limit: 10,
            in_stock_only: true,
            allow_external_seed: true,
            external_seed_strategy: 'unified_relevance',
            search_all_merchants: true,
          },
        },
        metadata: {
          source: 'creator-agent-ui',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_source).toBe('agent_products_creator_external_seed_direct');
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_zara_blazer_1',
      }),
    );
    expect(resp.body.products.map((product) => product.title)).not.toContain('Lilac Dream Face Wipes');
    expect(resp.body.metadata?.route_debug?.creator_external_seed_direct?.brand_terms).toEqual(['zara']);
    expect(resp.body.metadata?.route_debug?.creator_external_seed_direct).toEqual(
      expect.objectContaining({
        attempted: true,
        eligible: true,
        creator_brand_like_query: true,
        creator_cache_products_count: 1,
        creator_cache_can_short_circuit: false,
      }),
    );
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('keeps mango dress results on the direct creator path without beauty drift from outfit expansion', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM external_product_seeds')) {
          return {
            rows: [
              {
                id: 'mango-dress-seed-1',
                external_product_id: 'ext_mango_dress_1',
                market: 'US',
                tool: 'creator_agents',
                destination_url: 'https://shop.example.com/products/mango-pleated-midi-dress',
                canonical_url: 'https://shop.example.com/products/mango-pleated-midi-dress',
                domain: 'shop.example.com',
                title: 'Mango Pleated Midi Dress',
                image_url: 'https://cdn.example.com/mango-dress.jpg',
                price_amount: '79.90',
                price_currency: 'USD',
                availability: 'in stock',
                seed_data: {
                  brand: 'Mango',
                  category: 'dress',
                  description: 'Pleated midi dress with a fitted waist and flowy skirt.',
                },
                updated_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
              {
                id: 'tf-eye-seed-1',
                external_product_id: 'ext_tf_eye_1',
                market: 'US',
                tool: 'creator_agents',
                destination_url: 'https://shop.example.com/products/soleil-neige-eye-color-quad',
                canonical_url: 'https://shop.example.com/products/soleil-neige-eye-color-quad',
                domain: 'shop.example.com',
                title: 'Soleil Neige Eye Color Quad',
                image_url: 'https://cdn.example.com/tf-eye.jpg',
                price_amount: '92.00',
                price_currency: 'USD',
                availability: 'in stock',
                seed_data: {
                  brand: 'Tom Ford Beauty',
                  category: 'eyeshadow',
                  description: 'Eye color quad for a polished outfit finish.',
                },
                updated_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
              {
                id: 'blush-seed-1',
                external_product_id: 'ext_blush_1',
                market: 'US',
                tool: 'creator_agents',
                destination_url: 'https://shop.example.com/products/fenty-sundress-szn-blush',
                canonical_url: 'https://shop.example.com/products/fenty-sundress-szn-blush',
                domain: 'shop.example.com',
                title: 'Fenty Cheeks Suede Powder Blush — Sundress Szn',
                image_url: 'https://cdn.example.com/fenty-blush.jpg',
                price_amount: '28.00',
                price_currency: 'USD',
                availability: 'in stock',
                seed_data: {
                  brand: 'Fenty Beauty',
                  category: 'blush',
                  description: 'Soft powder blush shade for cheeks.',
                },
                updated_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
              {
                id: 'body-cream-seed-2',
                external_product_id: 'ext_body_cream_2',
                market: 'US',
                tool: 'creator_agents',
                destination_url: 'https://shop.example.com/products/ginger-cream-cookie-whipped-body-cream',
                canonical_url: 'https://shop.example.com/products/ginger-cream-cookie-whipped-body-cream',
                domain: 'shop.example.com',
                title: 'Ginger Cream Cookie Whipped Body Cream',
                image_url: 'https://cdn.example.com/body-cream-2.jpg',
                price_amount: '22.00',
                price_currency: 'USD',
                availability: 'in stock',
                seed_data: {
                  brand: 'Beekman 1802',
                  category: 'Moisturizer',
                  description:
                    "Made with our signature goat milk blend and scented with notes of sweet cream while making you feel warm and cozy on the inside. Ingredients include Mangifera Indica (Mango) Seed Butter.",
                },
                updated_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'mango dress',
            page: 1,
            limit: 10,
            in_stock_only: true,
            allow_external_seed: true,
            external_seed_strategy: 'unified_relevance',
            search_all_merchants: true,
          },
        },
        metadata: {
          source: 'creator-agent-ui',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_source).toBe('agent_products_creator_external_seed_direct');
    expect(resp.body.products.map((product) => product.product_id)).toEqual(['ext_mango_dress_1']);
    expect(resp.body.metadata?.route_debug?.creator_external_seed_direct?.brand_terms).toEqual(['mango']);
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('accepts canonical creator_agent source on the creator human apparel direct path', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM external_product_seeds')) {
          return {
            rows: [
              {
                id: 'zara-seed-2',
                external_product_id: 'ext_zara_blazer_2',
                market: 'US',
                tool: 'creator_agents',
                destination_url: 'https://shop.example.com/products/zara-structured-blazer',
                canonical_url: 'https://shop.example.com/products/zara-structured-blazer',
                domain: 'shop.example.com',
                title: 'Zara Structured Blazer',
                image_url: 'https://cdn.example.com/zara-structured-blazer.jpg',
                price_amount: '99.90',
                price_currency: 'USD',
                availability: 'in stock',
                seed_data: {
                  brand: 'Zara',
                  category: 'blazer',
                  description: 'Structured blazer for women.',
                },
                updated_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'zara blazer',
            page: 1,
            limit: 10,
            in_stock_only: true,
            allow_external_seed: true,
            external_seed_strategy: 'unified_relevance',
            search_all_merchants: true,
          },
        },
        metadata: {
          source: 'creator_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_source).toBe('agent_products_creator_external_seed_direct');
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_zara_blazer_2',
      }),
    );
    expect(resp.body.metadata?.route_debug?.creator_external_seed_direct).toEqual(
      expect.objectContaining({
        attempted: true,
        eligible: true,
        source: 'creator-agent',
      }),
    );
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('returns a direct empty contract on creator cache miss without falling back to upstream unavailable', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return { rows: [] };
        }
        if (text.includes('FROM external_product_seeds')) return { rows: [] };
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'zara blazer',
            page: 1,
            limit: 10,
            in_stock_only: true,
            allow_external_seed: true,
            external_seed_strategy: 'unified_relevance',
            search_all_merchants: true,
          },
        },
        metadata: {
          source: 'creator-agent-ui',
        },
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    expect(resp.body.metadata?.query_source).toBe('agent_products_creator_external_seed_direct');
    expect(resp.body.metadata?.query_source).not.toBe('agent_products_error_fallback');
    expect(String(resp.body.reply || '')).not.toContain('Search is temporarily unavailable');
    expect(upstreamSearch.isDone()).toBe(false);
  });
});
