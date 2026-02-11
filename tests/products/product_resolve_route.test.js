const nock = require('nock');
const request = require('supertest');

describe('POST /agent/v1/products/resolve', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
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
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
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
  });

  test('returns grounded product_ref (prefers prefer_merchants)', async () => {
    const preferMerchant = 'merch_efbc46b4619cfbdf';
    const otherMerchant = 'merch_other';
    const queryText = 'The Ordinary Niacinamide 10% + Zinc 1%';

    nock('http://pivota.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        products: [
          {
            merchant_id: otherMerchant,
            product_id: 'prod_other_1',
            title: queryText,
            vendor: 'The Ordinary',
          },
          {
            merchant_id: preferMerchant,
            product_id: 'prod_pref_1',
            title: queryText,
            vendor: 'The Ordinary',
          },
        ],
      });

    const app = require('../../src/server');

    const resp = await request(app)
      .post('/agent/v1/products/resolve')
      .send({
        query: queryText,
        lang: 'en',
        options: {
          prefer_merchants: [preferMerchant],
          search_all_merchants: true,
          timeout_ms: 1500,
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual(
      expect.objectContaining({
        resolved: true,
        product_ref: { product_id: 'prod_pref_1', merchant_id: preferMerchant },
      }),
    );
    expect(Array.isArray(resp.body.candidates)).toBe(true);
    expect(resp.body.candidates.length).toBeGreaterThan(0);
  });

  test('retries upstream search on transient 5xx and resolves', async () => {
    const preferMerchant = 'merch_efbc46b4619cfbdf';
    const queryText = 'CeraVe Hydrating Cleanser';

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(502, { error: 'bad gateway' })
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        products: [
          {
            merchant_id: preferMerchant,
            product_id: 'prod_retry_ok_1',
            title: queryText,
            vendor: 'CeraVe',
          },
        ],
      });

    const app = require('../../src/server');

    const resp = await request(app)
      .post('/agent/v1/products/resolve')
      .send({
        query: queryText,
        lang: 'en',
        options: {
          prefer_merchants: [preferMerchant],
          search_all_merchants: false,
          timeout_ms: 2000,
          upstream_retries: 1,
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual(
      expect.objectContaining({
        resolved: true,
        product_ref: { product_id: 'prod_retry_ok_1', merchant_id: preferMerchant },
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        sources: expect.arrayContaining([
          expect.objectContaining({
            source: 'agent_search_scoped',
            ok: true,
            attempts: 2,
          }),
        ]),
      }),
    );
  });

  test('keeps budget for global fallback after scoped timeout', async () => {
    const preferMerchant = 'merch_efbc46b4619cfbdf';
    const queryText = 'Bioderma Sensibio H2O Micellar';

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        const mid = q && q.merchant_ids;
        return Boolean(mid) && String(mid).includes(preferMerchant);
      })
      .replyWithError({
        code: 'ECONNABORTED',
        message: 'timeout of 900ms exceeded',
      })
      .get('/agent/v1/products/search')
      .query((q) => {
        const hasMerchantScope = q && q.merchant_ids != null;
        const globalFlag = String((q && q.search_all_merchants) || '').toLowerCase();
        return !hasMerchantScope && globalFlag === 'true';
      })
      .reply(200, {
        status: 'success',
        products: [
          {
            merchant_id: 'merch_global_1',
            product_id: 'prod_global_1',
            title: queryText,
            vendor: 'Bioderma',
          },
        ],
      });

    const app = require('../../src/server');

    const resp = await request(app)
      .post('/agent/v1/products/resolve')
      .send({
        query: queryText,
        lang: 'en',
        options: {
          prefer_merchants: [preferMerchant],
          search_all_merchants: true,
          timeout_ms: 2200,
          upstream_retries: 0,
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.resolved).toBe(true);
    expect(resp.body.product_ref).toEqual({
      product_id: 'prod_global_1',
      merchant_id: 'merch_global_1',
    });
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        sources: expect.arrayContaining([
          expect.objectContaining({
            source: 'products_cache_global',
            ok: false,
          }),
          expect.objectContaining({
            source: 'agent_search_scoped',
            ok: false,
          }),
          expect.objectContaining({
            source: 'agent_search_global',
            ok: true,
            count: 1,
          }),
        ]),
      }),
    );
  });

  test('filters external_seed by default', async () => {
    const queryText = 'Unknown External Seed Product';

    nock('http://pivota.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        products: [
          {
            merchant_id: 'external_seed',
            product_id: 'ext_123',
            title: queryText,
            source_type: 'external_seed',
          },
        ],
      });

    const app = require('../../src/server');

    const resp = await request(app)
      .post('/agent/v1/products/resolve')
      .send({
        query: queryText,
        lang: 'en',
        options: {
          search_all_merchants: true,
          timeout_ms: 800,
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.resolved).toBe(false);
    expect(resp.body.product_ref).toBeNull();
    expect(resp.body.reason).toBe('no_candidates');
    expect(resp.body.candidates).toEqual([]);
  });

  test('resolves known stable products without hints (The Ordinary + Winona)', async () => {
    const app = require('../../src/server');

    const ordinaryResp = await request(app)
      .post('/agent/v1/products/resolve')
      .send({
        query: 'The Ordinary Niacinamide 10% + Zinc 1%',
        lang: 'en',
        options: {
          search_all_merchants: true,
          timeout_ms: 1200,
        },
      });

    expect(ordinaryResp.status).toBe(200);
    expect(ordinaryResp.body).toEqual(
      expect.objectContaining({
        resolved: true,
        reason: 'stable_alias_ref',
        product_ref: {
          product_id: 'prod_the_ordinary_niacinamide_10_zinc_1',
          merchant_id: 'merch_efbc46b4619cfbdf',
        },
      }),
    );
    expect(ordinaryResp.body.metadata).toEqual(
      expect.objectContaining({
        stable_alias_match_id: 'the_ordinary_niacinamide_10_zinc_1',
        sources: expect.arrayContaining([
          expect.objectContaining({
            source: 'stable_alias_ref',
            ok: true,
          }),
        ]),
      }),
    );

    const winonaResp = await request(app)
      .post('/agent/v1/products/resolve')
      .send({
        query: 'Winona Soothing Repair Serum',
        lang: 'en',
        options: {
          search_all_merchants: true,
          timeout_ms: 1200,
        },
      });

    expect(winonaResp.status).toBe(200);
    expect(winonaResp.body).toEqual(
      expect.objectContaining({
        resolved: true,
        reason: 'stable_alias_ref',
        product_ref: {
          product_id: 'prod_winona_soothing_repair_serum',
          merchant_id: 'merch_efbc46b4619cfbdf',
        },
      }),
    );
    expect(winonaResp.body.metadata).toEqual(
      expect.objectContaining({
        stable_alias_match_id: 'winona_soothing_repair_serum',
        sources: expect.arrayContaining([
          expect.objectContaining({
            source: 'stable_alias_ref',
            ok: true,
          }),
        ]),
      }),
    );
  });

  test('does not short-circuit opaque hints.product_ref for uuid query; returns no_candidates reason_code', async () => {
    const app = require('../../src/server');
    const hintedProductId = 'c231aaaa-8b00-4145-a704-684931049303';
    const hintedMerchantId = 'merch_efbc46b4619cfbdf';

    const resp = await request(app)
      .post('/agent/v1/products/resolve')
      .send({
        query: 'e7c90e06-8673-4c97-835d-074a26ab2162',
        lang: 'en',
        hints: {
          product_ref: {
            product_id: hintedProductId,
            merchant_id: hintedMerchantId,
          },
          aliases: ['The Ordinary Niacinamide 10% + Zinc 1%'],
          brand: 'The Ordinary',
          title: 'The Ordinary Niacinamide 10% + Zinc 1%',
        },
        options: {
          search_all_merchants: false,
          timeout_ms: 1200,
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual(
      expect.objectContaining({
        resolved: false,
        product_ref: null,
        reason: 'no_candidates',
        reason_code: 'no_candidates',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_from_hints: true,
        original_query: 'e7c90e06-8673-4c97-835d-074a26ab2162',
        resolve_reason_code: 'no_candidates',
        sources: expect.arrayContaining([
          expect.objectContaining({
            source: 'hints_product_ref',
            reason: 'opaque_hint_requires_lookup',
          }),
        ]),
      }),
    );
  });

  test('accepts hints.product_ref with non-opaque product_id only', async () => {
    const app = require('../../src/server');
    const hintedProductId = '9886499864904';
    const hintedAlias = 'Paula Choice 2 percent BHA Liquid';

    const resp = await request(app)
      .post('/agent/v1/products/resolve')
      .send({
        query: 'e7c90e06-8673-4c97-835d-074a26ab2162',
        lang: 'en',
        hints: {
          product_ref: {
            product_id: hintedProductId,
          },
          aliases: [hintedAlias],
          title: hintedAlias,
        },
        options: {
          search_all_merchants: false,
          timeout_ms: 1200,
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual(
      expect.objectContaining({
        resolved: true,
        product_ref: {
          product_id: hintedProductId,
        },
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_from_hints: true,
      }),
    );
  });

  test('does not resolve opaque hints.product_ref product_id without merchant_id', async () => {
    const app = require('../../src/server');
    const hintedProductId = 'c231aaaa-8b00-4145-a704-684931049303';

    const resp = await request(app)
      .post('/agent/v1/products/resolve')
      .send({
        query: hintedProductId,
        lang: 'en',
        hints: {
          product_ref: {
            product_id: hintedProductId,
          },
          aliases: ['The Ordinary Niacinamide 10% + Zinc 1%'],
        },
        options: {
          search_all_merchants: false,
          timeout_ms: 1200,
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual(
      expect.objectContaining({
        resolved: false,
        reason: 'no_candidates',
        product_ref: null,
      }),
    );
  });

  test('does not infer opaque hints.product_ref from prefer_merchant; returns no_candidates reason_code', async () => {
    const app = require('../../src/server');
    const hintedProductId = 'c231aaaa-8b00-4145-a704-684931049303';
    const preferMerchant = 'merch_efbc46b4619cfbdf';

    const resp = await request(app)
      .post('/agent/v1/products/resolve')
      .send({
        query: hintedProductId,
        lang: 'en',
        hints: {
          product_ref: {
            product_id: hintedProductId,
          },
          aliases: ['The Ordinary Niacinamide 10% + Zinc 1%'],
        },
        options: {
          prefer_merchants: [preferMerchant],
          search_all_merchants: false,
          timeout_ms: 1200,
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual(
      expect.objectContaining({
        resolved: false,
        product_ref: null,
        reason: 'no_candidates',
        reason_code: 'no_candidates',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_from_hints: true,
        resolve_reason_code: 'no_candidates',
        sources: expect.arrayContaining([
          expect.objectContaining({ source: 'hints_product_ref', reason: 'opaque_hint_requires_lookup' }),
        ]),
      }),
    );
  });

  test('normalizes uuid query from hint alias when provided', async () => {
    const hintedAlias = 'The Ordinary Niacinamide 10% + Zinc 1%';
    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/v1/products/resolve')
      .send({
        query: 'e7c90e06-8673-4c97-835d-074a26ab2162',
        lang: 'en',
        hints: {
          aliases: [hintedAlias],
          brand: 'The Ordinary',
          title: hintedAlias,
        },
        options: {
          search_all_merchants: false,
          timeout_ms: 1200,
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.resolved).toBe(false);
    expect(resp.body.reason).toBe('no_candidates');
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_from_hints: true,
        effective_query: hintedAlias,
      }),
    );
  });

  test('rejects missing query', async () => {
    const app = require('../../src/server');
    const resp = await request(app).post('/agent/v1/products/resolve').send({ lang: 'en' });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toBe('MISSING_PARAMETERS');
  });
});
