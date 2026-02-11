process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.OFFERS_RESOLVE_SUBJECT_RETRY_MAX = '0';
process.env.OFFERS_RESOLVE_CACHE_SEARCH_RETRY_MAX = '0';
process.env.OFFERS_RESOLVE_SUBJECT_TIMEOUT_MS = '1200';
process.env.OFFERS_RESOLVE_CACHE_SEARCH_TIMEOUT_MS = '1200';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('/agent/shop/v1/invoke offers.resolve hardening', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('uses canonical_product_ref directly and keeps legacy root payload compatible', async () => {
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        payload: {
          product: {
            canonical_product_ref: {
              merchant_id: 'mid_direct',
              product_id: 'prod_direct_1',
            },
            product_id: '22cd8f8d-3579-4b72-8f48-d29d8f07e8d4',
            name: 'Direct Product',
          },
          market: 'US',
        },
      })
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.reason_code).toBe('canonical_ref_direct');
    expect(res.body.pdp_target?.v1?.path).toBe('ref');
    expect(res.body.pdp_target?.v1?.product_ref).toEqual({
      merchant_id: 'mid_direct',
      product_id: 'prod_direct_1',
    });
    expect(Array.isArray(res.body.offers)).toBe(true);
    expect(res.body.offers.length).toBe(0);
  });

  it('The Ordinary UUID input: subject resolve hits internal group, no fallback', async () => {
    const scope = nock(process.env.PIVOTA_API_BASE)
      .post('/v1/subject/resolve')
      .reply(200, {
        subject: {
          type: 'product_group',
          id: 'pg_to_niacinamide',
        },
        canonical_product_ref: {
          merchant_id: 'merch_efbc46b4619cfbdf',
          product_id: 'prod_the_ordinary_niacinamide_10_zinc_1',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        payload: {
          offers: {
            product: {
              product_id: '8ff20f5f-60d8-4b35-aa96-a4df7c53ed52',
              name: 'Niacinamide 10% + Zinc 1%',
              brand: 'The Ordinary',
            },
            market: 'US',
          },
        },
      })
      .expect(200);

    expect(scope.isDone()).toBe(true);
    expect(res.body.reason_code).toBe('subject_direct');
    expect(res.body.pdp_target?.v1?.path).toBe('group');
    expect(res.body.pdp_target?.v1?.subject?.product_group_id).toBe('pg_to_niacinamide');
    expect(res.body.metadata?.pdp_open_path).toBe('group');
    expect(Array.isArray(res.body.offers)).toBe(true);
    expect(res.body.offers.length).toBe(0);
  });

  it('Winona UUID input: subject resolve hits internal ref, no fallback', async () => {
    const scope = nock(process.env.PIVOTA_API_BASE)
      .post('/v1/subject/resolve')
      .reply(200, {
        canonical_product_ref: {
          merchant_id: 'merch_efbc46b4619cfbdf',
          product_id: 'prod_winona_soothing_repair_serum',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        payload: {
          offers: {
            product: {
              sku_id: 'f16c11ec-ccfa-41d6-a43b-4fcfa4e706cb',
              name: 'Soothing Repair Serum',
              brand: 'Winona',
            },
            market: 'US',
          },
        },
      })
      .expect(200);

    expect(scope.isDone()).toBe(true);
    expect(res.body.reason_code).toBe('subject_direct');
    expect(res.body.pdp_target?.v1?.path).toBe('ref');
    expect(res.body.pdp_target?.v1?.product_ref).toEqual({
      merchant_id: 'merch_efbc46b4619cfbdf',
      product_id: 'prod_winona_soothing_repair_serum',
    });
    expect(res.body.metadata?.pdp_open_path).toBe('ref');
  });

  it('no candidates keeps explicit reason_code=no_candidates and external pdp target', async () => {
    const subjectScope = nock(process.env.PIVOTA_API_BASE)
      .post('/v1/subject/resolve')
      .reply(404, {
        reason_code: 'no_candidates',
        reason: 'no_candidates',
      });
    const cacheScope = nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body?.operation === 'offers.resolve')
      .reply(200, {
        status: 'success',
        offers: [],
        offers_count: 0,
        reason_code: 'no_candidates',
        reason: 'no_candidates',
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        payload: {
          offers: {
            product: {
              product_id: 'unknown_product_123',
              name: 'Unknown Product',
            },
            market: 'US',
          },
        },
      })
      .expect(200);

    expect(subjectScope.isDone()).toBe(true);
    expect(cacheScope.isDone()).toBe(true);
    expect(res.body.status).toBe('success');
    expect(res.body.reason_code).toBe('no_candidates');
    expect(Array.isArray(res.body.offers)).toBe(true);
    expect(res.body.offers.length).toBe(0);
    expect(res.body.pdp_target?.v1?.path).toBe('external');
    expect(res.body.metadata?.resolve_fail_reason).toBe('no_candidates');
  });

  it('db timeout keeps explicit reason_code=db_timeout and external pdp target', async () => {
    const subjectScope = nock(process.env.PIVOTA_API_BASE)
      .post('/v1/subject/resolve')
      .reply(503, {
        reason_code: 'db_timeout',
        reason: 'db_query_timeout',
      });
    const cacheScope = nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body?.operation === 'offers.resolve')
      .reply(503, {
        reason_code: 'db_timeout',
        reason: 'db_query_timeout',
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        payload: {
          offers: {
            product: {
              product_id: 'prod_timeout_case_1',
              name: 'Timeout Product',
            },
            market: 'US',
          },
        },
      })
      .expect(200);

    expect(subjectScope.isDone()).toBe(true);
    expect(cacheScope.isDone()).toBe(true);
    expect(res.body.status).toBe('success');
    expect(res.body.reason_code).toBe('db_timeout');
    expect(res.body.pdp_target?.v1?.path).toBe('external');
    expect(res.body.metadata?.resolve_fail_reason).toBe('db_timeout');
    expect(Array.isArray(res.body.metadata?.sources)).toBe(true);
    expect(res.body.metadata.sources.length).toBeGreaterThanOrEqual(2);
  });
});

