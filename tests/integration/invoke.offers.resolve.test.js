process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.OFFERS_RESOLVE_SUBJECT_RETRY_MAX = '0';
process.env.OFFERS_RESOLVE_CACHE_SEARCH_RETRY_MAX = '0';
process.env.OFFERS_RESOLVE_SUBJECT_TIMEOUT_MS = '1200';
process.env.OFFERS_RESOLVE_CACHE_SEARCH_TIMEOUT_MS = '1200';
process.env.OFFERS_RESOLVE_CIRCUIT_FAILURE_THRESHOLD = '99';
process.env.AURORA_PRODUCT_GROUNDING_STABLE_ALIAS_PATH = require('path').join(
  __dirname,
  '../fixtures/product_grounding_stable_aliases.test.json',
);

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

  it('raw merchant+product id short-circuits to internal ref without upstream calls', async () => {
    const subjectScope = nock(process.env.PIVOTA_API_BASE)
      .post('/v1/subject/resolve')
      .reply(200, {
        status: 'success',
      });
    const cacheScope = nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body?.operation === 'offers.resolve')
      .reply(200, {
        status: 'success',
        offers: [],
        offers_count: 0,
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        payload: {
          offers: {
            product: {
              merchant_id: 'merch_efbc46b4619cfbdf',
              product_id: '9886500749640',
            },
            market: 'US',
          },
        },
      })
      .expect(200);

    expect(subjectScope.isDone()).toBe(false);
    expect(cacheScope.isDone()).toBe(false);
    expect(res.body.status).toBe('success');
    expect(res.body.reason_code).toBe('canonical_ref_direct');
    expect(res.body.pdp_target?.v1?.path).toBe('ref');
    expect(res.body.pdp_target?.v1?.product_ref).toEqual({
      merchant_id: 'merch_efbc46b4619cfbdf',
      product_id: '9886500749640',
    });
  });

  it('UUID-only input short-circuits via stable_alias_ref without upstream dependency', async () => {
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        payload: {
          offers: {
            product: {
              product_id: 'c231aaaa-8b00-4145-a704-684931049303',
            },
            market: 'US',
          },
        },
      })
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.reason_code).toBe('stable_alias_ref');
    expect(res.body.pdp_target?.v1?.path).toBe('ref');
    expect(res.body.pdp_target?.v1?.product_ref).toEqual({
      merchant_id: 'merch_efbc46b4619cfbdf',
      product_id: '9886499864904',
    });
    expect(res.body.metadata?.pdp_open_path).toBe('ref');
    expect(Array.isArray(res.body.offers)).toBe(true);
    expect(res.body.offers.length).toBe(0);
  });

  it('The Ordinary UUID input: stable alias ref opens internal PDP directly', async () => {
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

    expect(res.body.reason_code).toBe('stable_alias_ref');
    expect(res.body.pdp_target?.v1?.path).toBe('ref');
    expect(res.body.pdp_target?.v1?.product_ref).toEqual({
      merchant_id: 'merch_efbc46b4619cfbdf',
      product_id: '9886499864904',
    });
    expect(res.body.metadata?.pdp_open_path).toBe('ref');
    expect(Array.isArray(res.body.offers)).toBe(true);
    expect(res.body.offers.length).toBe(0);
  });

  it('Winona UUID input: stable alias ref opens internal PDP directly', async () => {
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

    expect(res.body.reason_code).toBe('stable_alias_ref');
    expect(res.body.pdp_target?.v1?.path).toBe('ref');
    expect(res.body.pdp_target?.v1?.product_ref).toEqual({
      merchant_id: 'merch_efbc46b4619cfbdf',
      product_id: '9886500749640',
    });
    expect(res.body.metadata?.pdp_open_path).toBe('ref');
  });

  it('no candidates returns failure without an external pdp target', async () => {
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
    expect(res.body.status).toBe('failure');
    expect(res.body.reason).toBe('no_offer_available');
    expect(res.body.reason_code).toBe('no_offer_available');
    expect(res.body.query).toBe('Unknown Product');
    expect(Array.isArray(res.body.offers)).toBe(true);
    expect(res.body.offers.length).toBe(0);
    expect(res.body.pdp_target?.v1 || null).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('google.com');
    expect(res.body.metadata?.resolve_fail_reason).toBe('no_offer_available');
    expect(res.body.metadata?.upstream_reason_code).toBe('no_candidates');
  });

  it('subject no_candidates with weak UUID-only identifier short-circuits without cache search', async () => {
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
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        payload: {
          offers: {
            product: {
              product_id: '11111111-2222-4333-8444-555555555555',
              name: 'Unknown UUID Product',
            },
            market: 'US',
          },
        },
      })
      .expect(200);

    expect(subjectScope.isDone()).toBe(true);
    expect(cacheScope.isDone()).toBe(false);
    expect(res.body.status).toBe('failure');
    expect(res.body.reason).toBe('no_offer_available');
    expect(res.body.reason_code).toBe('no_offer_available');
    expect(res.body.pdp_target?.v1 || null).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('google.com');
    expect(res.body.metadata?.resolve_fail_reason).toBe('no_offer_available');
    expect(res.body.metadata?.upstream_reason_code).toBe('no_candidates');
  });

  it('db timeout returns failure without an external pdp target', async () => {
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
    expect(res.body.status).toBe('failure');
    expect(res.body.reason).toBe('no_offer_available');
    expect(res.body.reason_code).toBe('no_offer_available');
    expect(res.body.pdp_target?.v1 || null).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('google.com');
    expect(res.body.metadata?.resolve_fail_reason).toBe('no_offer_available');
    expect(res.body.metadata?.upstream_reason_code).toBe('db_timeout');
    expect(Array.isArray(res.body.metadata?.sources)).toBe(true);
    expect(res.body.metadata.sources.length).toBeGreaterThanOrEqual(2);
  });

  it('subject timeout short-circuits to failure without waiting cache search', async () => {
    const subjectScope = nock(process.env.PIVOTA_API_BASE)
      .post('/v1/subject/resolve')
      .reply(503, {
        reason_code: 'upstream_timeout',
        reason: 'upstream_timeout',
      });
    const cacheScope = nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body?.operation === 'offers.resolve')
      .reply(200, {
        status: 'success',
        offers: [],
        offers_count: 0,
        reason_code: 'no_candidates',
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        payload: {
          offers: {
            product: {
              product_id: 'prod_timeout_case_skip_cache_1',
              name: 'Timeout Product',
            },
            market: 'US',
          },
        },
      })
      .expect(200);

    expect(subjectScope.isDone()).toBe(true);
    expect(cacheScope.isDone()).toBe(false);
    expect(res.body.status).toBe('failure');
    expect(res.body.reason).toBe('no_offer_available');
    expect(res.body.reason_code).toBe('no_offer_available');
    expect(res.body.pdp_target?.v1 || null).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('google.com');
    expect(res.body.metadata?.resolve_fail_reason).toBe('no_offer_available');
    expect(res.body.metadata?.upstream_reason_code).toBe('upstream_timeout');
    expect(Array.isArray(res.body.metadata?.sources)).toBe(true);
    expect(res.body.metadata.sources.length).toBeGreaterThanOrEqual(1);
  });

  it('cache search canonical_product still returns internal pdp target even when upstream reason_code=no_candidates', async () => {
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
        mapping: {
          canonical_ref: 'pc:merch_efbc46b4619cfbdf:shopify:9886499864904',
          canonical_product: {
            merchant_id: 'merch_efbc46b4619cfbdf',
            platform: 'shopify',
            product_id: '9886499864904',
          },
          candidates: [],
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        payload: {
          offers: {
            product: {
              product_id: '9886499864904',
            },
            market: 'US',
          },
        },
      })
      .expect(200);

    expect(subjectScope.isDone()).toBe(false);
    expect(cacheScope.isDone()).toBe(true);
    expect(res.body.status).toBe('success');
    expect(res.body.reason_code).toBe('mapped_hit');
    expect(res.body.pdp_target?.v1?.path).toBe('ref');
    expect(res.body.pdp_target?.v1?.product_ref).toEqual({
      merchant_id: 'merch_efbc46b4619cfbdf',
      product_id: '9886499864904',
    });
    expect(res.body.metadata?.pdp_open_path).toBe('ref');
    expect(res.body.metadata?.resolve_reason_code).toBeUndefined();
  });

  it('direct product id without descriptor text skips subject resolve and uses cache search only', async () => {
    const subjectScope = nock(process.env.PIVOTA_API_BASE)
      .post('/v1/subject/resolve')
      .reply(200, {
        status: 'success',
      });
    const cacheScope = nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body?.operation === 'offers.resolve')
      .reply(200, {
        status: 'success',
        offers: [
          {
            offer_id: 'of:internal_checkout:merch_efbc46b4619cfbdf:9886500749640:52327430029640',
            purchase_route: 'internal_checkout',
          },
          {
            offer_id: 'of:external_seed:eps_7050c7d0c2d844c199b1e45a:52327430029640',
            purchase_route: 'affiliate_outbound',
          },
        ],
        offers_count: 2,
        mapping: {
          canonical_ref: 'pc:merch_efbc46b4619cfbdf:shopify:9886500749640',
          canonical_product: {
            merchant_id: 'merch_efbc46b4619cfbdf',
            platform: 'shopify',
            product_id: '9886500749640',
          },
        },
        metadata: {
          has_external: true,
          has_internal: true,
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        payload: {
          offers: {
            product: {
              product_id: '9886500749640',
            },
            // A two-letter code: a market sent that is not one is refused (see the market cases at the end).
            market: 'FR',
            tool: '*',
          },
        },
      })
      .expect(200);

    expect(subjectScope.isDone()).toBe(false);
    expect(cacheScope.isDone()).toBe(true);
    expect(res.body.status).toBe('success');
    expect(res.body.offers_count).toBe(2);
    expect(res.body.metadata?.has_external).toBe(true);
    expect(Array.isArray(res.body.metadata?.sources)).toBe(true);
    expect(res.body.metadata.sources[0]).toMatchObject({
      source: 'subject_resolve',
      ok: false,
      reason: 'skipped_direct_lookup',
    });
    expect(res.body.metadata.sources[1]).toMatchObject({
      source: 'cache_search',
      ok: true,
    });
  });

  it('explicit commerce surface fails closed instead of returning external fallback', async () => {
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
        reason_code: 'not_servable',
        reason: 'not_servable',
        resolution_mode: 'not_servable',
        resolved_target: null,
        metadata: {
          reason_code: 'NOT_SERVABLE',
          reason: 'not_servable',
          servable_reason_codes: ['out_of_stock'],
          commerce_surface: 'agent_api',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        payload: {
          offers: {
            product: {
              sku_id: 'unknown_sku_123',
              name: 'Unknown Product',
            },
            market: 'US',
            commerce_surface: 'agent_api',
          },
        },
      })
      .expect(200);

    expect(subjectScope.isDone()).toBe(true);
    expect(cacheScope.isDone()).toBe(true);
    expect(res.body.status).toBe('failure');
    expect(res.body.reason).toBe('no_offer_available');
    expect(res.body.reason_code).toBe('no_offer_available');
    expect(res.body.pdp_target?.v1 || null).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('google.com');
    expect(res.body.metadata?.resolve_fail_reason).toBe('no_offer_available');
  });

  // THE MARKET THE LANES ARE ASKED FOR: this door's carriers (`offers.market`, then `payload.market`) by the rule its
  // purchasability gate applies to them (selectBuyerMarket, §5): the first carrier that yields one ISO-2 market wins,
  // upper-cased; an unreadable one is skipped; none sends no market. Forwarded raw, 'USA' matched nothing upstream.
  it.each([
    [{ offers: { market: 'us ' } }, 'US'], [{ offers: { market: 'sg' } }, 'SG'], [{ offers: { market: 'GB' } }, 'GB'],
    [{ offers: { market: 'USA' }, market: 'SG' }, 'SG'], [{ offers: { market: 'US,SG' }, market: 'jp' }, 'JP'],
    [{ offers: { market: null }, market: 'gb' }, 'GB'], [{ offers: { market: 'USA' }, market: '' }, 'REFUSED'],
    [{ offers: { market: 'DE' } }, 'REFUSED'],
    [{ offers: {} }, undefined], [{ offers: { market: null } }, undefined], [{ offers: { market: '' } }, undefined], [{ offers: { market: '  ' } }, undefined],
  ])('carriers %j reach both lanes as market %j, never a default', async (carriers, forwarded) => {
    const seen = [];
    nock(process.env.PIVOTA_API_BASE)
      .post('/v1/subject/resolve', (body) => { seen.push(['subject', body]); return true; })
      .reply(404, { reason_code: 'no_candidates', reason: 'no_candidates' });
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => { if (body?.operation === 'offers.resolve') { seen.push(['cache', body]); return true; } return false; })
      .reply(200, { status: 'success', offers: [], offers_count: 0, reason_code: 'no_candidates' });
    const payload = { ...carriers, offers: { product: { sku_id: 'sku_market_probe', name: 'Probe Product' }, ...carriers.offers } };
    const res = await request(app).post('/agent/shop/v1/invoke').send({ operation: 'offers.resolve', payload });
    if (forwarded === 'REFUSED') {
      // Refused by name before either lane: a carrier was sent and none is a market this door prices.
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('error');
      expect(['market_invalid', 'market_not_priced']).toContain(res.body.error.reason);
      expect(seen).toEqual([]);
      return;
    }
    expect(seen.map(([lane]) => lane).sort()).toEqual(['cache', 'subject']);
    for (const [lane, body] of seen) {
      const market = lane === 'subject' ? body.market : body.payload?.market;
      expect([lane, market]).toEqual([lane, forwarded]);
      if (typeof carriers.offers.market === 'string' && forwarded === undefined && carriers.offers.market.trim()) {
        expect(JSON.stringify(body)).not.toContain(carriers.offers.market);
      }
    }
  });

  // EVERY CARRIER SENT, NONE READABLE: refused by name before either lane runs, in the backend's offers.resolve
  // envelope for the same input. Dropped, it was answered with no market, i.e. in every currency at once.
  it.each([
    [{ offers: { market: 'USA' } }], [{ offers: { market: 'en-US' } }], [{ offers: { market: 'US,SG' } }],
    [{ offers: { market: 123 } }], [{ offers: { market: { code: 'US' } } }], [{ offers: { market: true } }],
    [{ offers: {}, market: 'USA' }], [{ offers: { market: 'USA' }, market: 'en-US' }], [{ offers: { market: 'USA' }, market: '' }],
  ])('carriers %j, all unreadable: refused as market_invalid, no lane asked, not echoed', async (carriers) => {
    const subjectScope = nock(process.env.PIVOTA_API_BASE).post('/v1/subject/resolve').reply(200, { status: 'success' });
    const cacheScope = nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body?.operation === 'offers.resolve')
      .reply(200, { status: 'success', offers: [] });
    const payload = { ...carriers, offers: { product: { sku_id: 'sku_market_probe', name: 'Probe Product' }, ...carriers.offers } };
    const res = await request(app).post('/agent/shop/v1/invoke').send({ operation: 'offers.resolve', payload }).expect(200);
    expect(res.body.status).toBe('error');
    expect(res.body.error).toMatchObject({ code: 'MARKET_INVALID', reason: 'market_invalid' });
    expect(res.body.offers).toEqual([]);
    expect(res.body.offers_count).toBe(0);
    expect(subjectScope.isDone()).toBe(false);
    expect(cacheScope.isDone()).toBe(false);
    for (const sent of [carriers.offers.market, carriers.market]) {
      if (typeof sent === 'string' && sent.trim()) expect(JSON.stringify(res.body)).not.toContain(sent);
    }
  });

  // The gate's third carrier, `metadata.market`, counts too: the lanes ask for the market the gate keys on.
  it.each([
    [{ offers: { market: 'USA' } }, { market: 'us' }, 'US'],
    [{ offers: {} }, { market: 'sg' }, 'SG'],
    [{ offers: { market: 'GB' } }, { market: 'SG' }, 'GB'],
  ])('carriers %j with metadata %j reach both lanes as %j', async (carriers, metadata, forwarded) => {
    const seen = [];
    nock(process.env.PIVOTA_API_BASE)
      .post('/v1/subject/resolve', (body) => { seen.push(['subject', body]); return true; })
      .reply(404, { reason_code: 'no_candidates', reason: 'no_candidates' });
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => { if (body?.operation === 'offers.resolve') { seen.push(['cache', body]); return true; } return false; })
      .reply(200, { status: 'success', offers: [], offers_count: 0, reason_code: 'no_candidates' });
    const payload = { ...carriers, offers: { product: { sku_id: 'sku_market_probe', name: 'Probe Product' }, ...carriers.offers } };
    await request(app).post('/agent/shop/v1/invoke').send({ operation: 'offers.resolve', payload, metadata });
    expect(seen.map(([lane]) => lane).sort()).toEqual(['cache', 'subject']);
    for (const [lane, body] of seen) expect([lane, lane === 'subject' ? body.market : body.payload?.market]).toEqual([lane, forwarded]);
  });

  it('a metadata market that is unreadable, with nothing else sent, is refused too', async () => {
    const cacheScope = nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body?.operation === 'offers.resolve')
      .reply(200, { status: 'success', offers: [] });
    const res = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'offers.resolve',
      payload: { offers: { product: { sku_id: 'sku_market_probe', name: 'Probe Product' } } },
      metadata: { market: 'USA' },
    }).expect(200);
    expect(res.body.error).toMatchObject({ reason: 'market_invalid' });
    expect(cacheScope.isDone()).toBe(false);
  });

  // A WELL-FORMED MARKET THIS GATEWAY DOES NOT PRICE (DE, ZZ: no currency) is refused by name before either lane, in
  // be#2843's envelope, the code echoed. Forwarded, it was answered in every currency (before be#2843) or re-labelled
  // no_offer_available (after). US, SG and GB are served; nothing sent stays no market.
  it.each([
    [{ offers: { market: 'DE' } }, 'DE'], [{ offers: { market: 'de' } }, 'DE'], [{ offers: { market: 'ZZ' } }, 'ZZ'],
    [{ offers: {}, market: 'zz ' }, 'ZZ'], [{ offers: { market: 'USA' }, market: 'DE' }, 'DE'],
  ])('carriers %j: refused as market_not_priced for %s, no lane asked', async (carriers, code) => {
    const subjectScope = nock(process.env.PIVOTA_API_BASE).post('/v1/subject/resolve').reply(200, { status: 'success' });
    const cacheScope = nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body?.operation === 'offers.resolve')
      .reply(200, { status: 'success', offers: [] });
    const payload = { ...carriers, offers: { product: { sku_id: 'sku_market_probe', name: 'Probe Product' }, ...carriers.offers } };
    const res = await request(app).post('/agent/shop/v1/invoke').send({ operation: 'offers.resolve', payload }).expect(200);
    expect(res.body).toEqual({
      status: 'error', offers: [], offers_count: 0, market: code,
      error: {
        code: 'MARKET_NOT_PRICED', reason: 'market_not_priced',
        message: `No offer is priced for a buyer in ${code}; nothing was looked up, and a request for ${code} is never answered as another market.`,
      },
    });
    expect(subjectScope.isDone()).toBe(false);
    expect(cacheScope.isDone()).toBe(false);
  });

  it('metadata DE alone is refused too; metadata DE behind a priced carrier is not', async () => {
    const cacheScope = nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body?.operation === 'offers.resolve')
      .reply(200, { status: 'success', offers: [] });
    const refused = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'offers.resolve',
      payload: { offers: { product: { sku_id: 'sku_market_probe', name: 'Probe Product' } } },
      metadata: { market: 'DE' },
    }).expect(200);
    expect(refused.body.error).toMatchObject({ reason: 'market_not_priced' });
    expect(cacheScope.isDone()).toBe(false);
    nock.cleanAll();
    const seen = [];
    nock(process.env.PIVOTA_API_BASE)
      .post('/v1/subject/resolve', (body) => { seen.push(body.market); return true; })
      .reply(404, { reason_code: 'no_candidates', reason: 'no_candidates' });
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => { if (body?.operation === 'offers.resolve') { seen.push(body.payload?.market); return true; } return false; })
      .reply(200, { status: 'success', offers: [], offers_count: 0, reason_code: 'no_candidates' });
    await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'offers.resolve',
      payload: { offers: { product: { sku_id: 'sku_market_probe', name: 'Probe Product' }, market: 'SG' } },
      metadata: { market: 'DE' },
    });
    expect(seen).toEqual(['SG', 'SG']);
  });

  // THE REFUSAL COMES FIRST: before the identifier check and before every identity short-circuit.
  it('a group id with an unreadable market is refused (not the subject_direct answer); no identifier with one is 200 market_invalid, not 400', async () => {
    const withGroup = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'offers.resolve',
      payload: { offers: { subject: { product_group_id: 'pg_market_probe_group' }, market: 'USA' } },
    }).expect(200);
    expect(withGroup.body.error).toMatchObject({ code: 'MARKET_INVALID', reason: 'market_invalid' });
    expect(withGroup.body.pdp_target).toBeUndefined();
    const groupUnpriced = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'offers.resolve',
      payload: { offers: { subject: { product_group_id: 'pg_market_probe_group' }, market: 'DE' } },
    }).expect(200);
    expect(groupUnpriced.body.error).toMatchObject({ reason: 'market_not_priced' });
    const noIdentifier = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'offers.resolve',
      payload: { offers: { market: 'USA' } },
    }).expect(200);
    expect(noIdentifier.body.error).toMatchObject({ code: 'MARKET_INVALID', reason: 'market_invalid' });
    // Control: the same group id with a priced market keeps its identity answer.
    const control = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'offers.resolve',
      payload: { offers: { subject: { product_group_id: 'pg_market_probe_group' }, market: 'US' } },
    }).expect(200);
    expect(control.body.status).toBe('success');
  });

  it('the refusal is logged by reason only, never the value', async () => {
    const logger = require('../../src/logger');
    const spy = jest.spyOn(logger, 'warn');
    try {
      await request(app).post('/agent/shop/v1/invoke').send({
        operation: 'offers.resolve',
        payload: { offers: { product: { sku_id: 'sku_market_probe' }, market: 'en-US' } },
      }).expect(200);
      const calls = spy.mock.calls.filter(([fields]) => fields && fields.event === 'offers_resolve_market_refused');
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toEqual({ event: 'offers_resolve_market_refused', reason: 'market_invalid' });
      expect(JSON.stringify(calls[0])).not.toContain('en-US');
    } finally {
      spy.mockRestore();
    }
  });
});
