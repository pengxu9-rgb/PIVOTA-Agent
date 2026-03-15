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
      .get('/agent/v1/products/search')
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
        products: [{ id: 'p1' }],
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
      .get('/agent/v1/products/search')
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
      .get('/agent/v1/products/search')
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
      .get('/agent/v1/products/search')
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
    expect(res.body.metadata?.search_decision?.contract_version).toBe('beauty_search_decision_v3');
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
      .get('/agent/v1/products/search')
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

    expect(res.body.metadata?.search_decision?.hit_quality).toBe('valid_hit');
    expect(res.body.metadata?.search_decision?.same_family_topk_count).toBeGreaterThan(0);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0]?.product_id).toBe('cream_1');
    expect(res.body.products.some((row) => String(row?.product_id || '').includes('body_1'))).toBe(false);
    expect(res.body.products.some((row) => String(row?.product_id || '').includes('spf_1'))).toBe(false);
  });
});
