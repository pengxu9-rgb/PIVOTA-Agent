// Loopback-only: nothing in this file (or a mutant of the code it tests) can reach a real host.
const netGuard = require('../search_routing_net_guard.cjs');

/**
 * find_products_multi on the real invoke route: what the CALLER may decide, and what of the caller's own
 * values the answer may carry back (src/findProductsMulti/callerEcho.js).
 *
 *  - The search request contract (and primary_lane / primary_retrieval_contract / supplement_lanes) is
 *    the gateway's own. One sent in the request metadata never picks the lane and is never echoed; the
 *    public GET search route, which builds its own contract in-process, keeps it.
 *  - creator_name / creator_id / trace_id / source / market (top-level metadata) and
 *    query_understanding.source / .market are echoed only when the caller's value passes the allowlist.
 *    Clean values are echoed exactly as before.
 */

const nock = require('nock');
const request = require('supertest');

const CANONICAL_MARKER = 'WITH candidate_products';
const UPSTREAM = 'http://upstream.invalid';

jest.setTimeout(60000);

function row(key, title, categoryPath, { actives = [], productType = 'Skincare' } = {}) {
  return {
    merchant_id: 'external_seed',
    product_key: `prod::external_seed::external_seed::ext_${key}`,
    platform: 'external_seed',
    source_product_id: `ext_${key}`,
    pivota_signature_id: `sig_${key}`,
    pivota_canonical_url: `https://catalog.invalid/products/sig_${key}`,
    product_title: title,
    product_description: `${title}. A test product.`,
    brand: 'Test Brand',
    product_type: productType,
    category: productType,
    category_path: categoryPath,
    canonical_url: `https://brand.invalid/products/${key}`,
    product_image_url: `https://cdn.invalid/${key}.jpg`,
    catalog_track: 'external_referral',
    truth_tier: 'observed',
    readiness_tier: 'referral_only',
    pdp_scope: 'unverified',
    merchant_effective_price: '24.00',
    currency: 'USD',
    product_payload: {
      seed_data: { price_amount: '24.00', price_currency: 'USD', availability: 'in stock', active_ingredients: actives },
    },
    rank_score: 90,
  };
}

const CATALOG = [
  row('retinol_serum', 'Retinol 0.3% Night Serum', 'beauty/skincare/treat/serum', { actives: ['retinol'], productType: 'Serum' }),
  row('sunscreen', 'Daily Sunscreen SPF 50', 'beauty/skincare/sun/sunscreen', { actives: ['zinc oxide'], productType: 'Sunscreen' }),
  row('cream', 'Daily Moisturizing Cream', 'beauty/skincare/moisturize/cream', { actives: ['glycerin'], productType: 'Moisturizer' }),
];

const OWNER = 'invoke.find_products_multi_caller_contract';
const owned = (fn) => netGuard.attribution.run({ owner: OWNER }, fn);
const openServers = [];
const listen = (app) =>
  owned(() => {
    const server = app.listen(0, '127.0.0.1');
    openServers.push(server);
    return server;
  });

const LANES = {
  MAINLINE: 'agent_products_beauty_external_seed_mainline',
  INGREDIENT: 'agent_products_ingredient_recall_direct',
  SAFE_EMPTY: 'search_quality_contract_v1_safe_empty',
  BACKEND: 'agent_products_search',
};
// one query per lane: the mainline answers before the handler builds its contract; the others after
const LANE_QUERIES = { sunscreen: LANES.MAINLINE, 'retinol serum': LANES.INGREDIENT, laptop: LANES.BACKEND, Lidschatten: LANES.SAFE_EMPTY };

const lane = (resp) => resp.body?.metadata?.query_source || null;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Drops fields that differ between two runs of the same request (timings, ids, process start stamps).
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (/fetched_at|generated_at|started_at|build_id|timestamp|trace_id|traceId|request_id|latency|duration|_ms$|elapsed/i.test(key)) continue;
    out[key] = normalize(inner);
  }
  return out;
}

const FORGED = 'zz_forged_by_caller';
function forgedContract(primaryLane) {
  return {
    contract_version: 'search_contract_v1',
    surface: 'direct',
    operation: 'find_products_multi',
    source: FORGED,
    request_class: FORGED,
    primary_lane: primaryLane,
    primary_retrieval_contract: primaryLane === 'beauty_discovery_mainline' ? 'agent_v1_search_beauty_mainline' : primaryLane,
    supplement_lanes: [FORGED],
    semantic_contract: { request_class: FORGED },
  };
}
const FORGED_METADATA = [
  ...['shop_invoke_strict', 'resolver_only', 'catalog_child_recall', 'beauty_discovery_mainline', FORGED].map((primaryLane) => ({
    search_request_contract: forgedContract(primaryLane),
  })),
  { primary_lane: 'shop_invoke_strict' },
  { primary_lane: FORGED, primary_retrieval_contract: FORGED, supplement_lanes: [FORGED] },
  {
    search_request_contract: forgedContract('resolver_only'),
    primary_lane: 'resolver_only',
    primary_retrieval_contract: FORGED,
    supplement_lanes: [FORGED],
  },
];

describe('find_products_multi: the caller cannot steer the search contract or echo hostile values', () => {
  let prevEnv;

  afterAll(() => {
    expect(netGuard.state.blocked.filter((entry) => entry.owner === OWNER)).toEqual([]);
  });

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => String(host || '').includes('127.0.0.1'));
    prevEnv = { ...process.env };
    process.env.PIVOTA_API_BASE = UPSTREAM;
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    process.env.GATEWAY_RATE_LIMIT_ENABLED = 'false';
    for (const key of [
      'INDEX_ELIGIBLE_RECALL',
      'CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET',
      'FIND_PRODUCTS_BUYER_MARKET',
      'FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING',
      'FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING',
      'SEARCH_BUDGET_REQUIRE_MARKER',
    ]) {
      delete process.env[key];
    }
  });

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve()))));
    process.env = prevEnv;
    jest.dontMock('../../src/db');
    jest.dontMock('../../src/auroraBff/routes');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  // A fixed fixture catalog answers every canonical-catalog statement; the upstream text lane answers empty
  // (with `upstreamMetadata` as its own metadata when given).
  function bootCatalog({ upstreamMetadata = null } = {}) {
    process.env.DATABASE_URL = 'postgres://caller-contract.invalid/db';
    const upstreamBody = { status: 'success', products: [], total: 0, ...(upstreamMetadata ? { metadata: upstreamMetadata } : {}) };
    nock(UPSTREAM)
      .persist()
      .post(/.*/)
      .reply(200, upstreamBody)
      .get(/.*/)
      .reply(200, upstreamBody);
    jest.doMock('../../src/db', () => ({
      query: async (sql) => (String(sql || '').includes(CANONICAL_MARKER) ? { rows: CATALOG } : { rows: [] }),
    }));
    const app = listen(owned(() => require('../../src/server')));
    const send = async (payload, metadata = null) => {
      const resp = await owned(async () =>
        request(app)
          .post('/agent/shop/v1/invoke')
          .send({ operation: 'find_products_multi', payload, ...(metadata ? { metadata } : {}) }));
      await delay(5);
      return resp;
    };
    const search = (query, metadata = null, extra = {}) =>
      send({ search: { query, page: 1, page_size: 20 }, ...extra }, metadata);
    return { app, send, search };
  }

  test('a forged search_request_contract / primary_lane is never adopted or echoed: each answer is the clean request\'s', async () => {
    const { search } = bootCatalog();
    for (const [query, expectedLane] of Object.entries(LANE_QUERIES)) {
      const baseline = await search(query);
      expect([query, baseline.status, lane(baseline)]).toEqual([query, 200, expectedLane]);
      for (const forged of FORGED_METADATA) {
        const attacked = await search(query, forged);
        const label = [query, Object.keys(forged).join('+'), forged.search_request_contract?.primary_lane || forged.primary_lane];
        expect([...label, attacked.status, lane(attacked)]).toEqual([...label, 200, expectedLane]);
        expect([...label, JSON.stringify(attacked.body).includes(FORGED)]).toEqual([...label, false]);
        const attackedMeta = attacked.body.metadata || {};
        const baselineMeta = baseline.body.metadata || {};
        // the echoed lane and contract are exactly the gateway's own (or absent, where the clean answer has none)
        expect([...label, attackedMeta.primary_lane, attackedMeta.primary_retrieval_contract]).toEqual([
          ...label, baselineMeta.primary_lane, baselineMeta.primary_retrieval_contract,
        ]);
        expect([...label, normalize(attackedMeta.search_request_contract)]).toEqual([
          ...label, normalize(baselineMeta.search_request_contract),
        ]);
        if (attackedMeta.search_request_contract) {
          expect([...label, attackedMeta.search_request_contract.surface]).toEqual([...label, 'gateway']);
        }
        expect([...label, normalize(attacked.body)]).toEqual([...label, normalize(baseline.body)]);
      }
    }
  });

  test('the public GET search route keeps the contract it built itself (the in-process hand-off)', async () => {
    const { app } = bootCatalog();
    for (const query of ['sunscreen', 'laptop']) {
      const resp = await owned(async () => request(app).get('/agent/v1/products/search').query({ query, limit: 5 }));
      expect([query, resp.status]).toEqual([query, 200]);
      const contract = resp.body?.metadata?.search_request_contract;
      expect([query, contract?.surface, contract?.contract_version]).toEqual([query, 'direct', 'search_contract_v1']);
      expect([query, resp.body.metadata.primary_lane]).toEqual([query, contract.primary_lane]);
    }
  });

  const HOSTILE_NAMES = [
    '<img src=x onerror=alert(1)>',
    'Jane<b>',
    { first: 'Jane' },
    ['Jane'],
    'Jane\u202eenaJ',
    'Ja\u200bne',
    'Ja\u2066ne',
    'Ja\ufeffne',
    'Ja\u2028ne',
    'Ja\u0007ne',
    'Ja\u0085ne',
    'Ja\u200fne',
    'Ja\u2060ne',
    'javascript:alert(1)',
    '  JavaScript:alert(1)',
    'vbscript:msgbox',
    'DATA:text/html,x',
    'x'.repeat(129),
  ];
  const CLEAN_NAME = 'Jane Doe - Beauty Picks';
  const CLEAN_ID = 'creator_123.a:b-c';

  test('creator_name / creator_id are echoed only when they pass the allowlist (metadata and payload)', async () => {
    const { search } = bootCatalog();
    for (const query of ['sunscreen', 'Lidschatten']) {
      // clean values: echoed exactly, under both spellings where the lane echoes both
      const clean = await search(query, { creator_name: CLEAN_NAME, creator_id: CLEAN_ID });
      expect([query, clean.body.metadata.creator_name, clean.body.metadata.creator_id]).toEqual([query, CLEAN_NAME, CLEAN_ID]);
      const cleanPayload = await search(query, null, { creator_name: CLEAN_NAME, creatorId: CLEAN_ID });
      expect([query, cleanPayload.body.metadata.creator_name, cleanPayload.body.metadata.creator_id]).toEqual([query, CLEAN_NAME, CLEAN_ID]);

      for (const hostile of HOSTILE_NAMES) {
        const label = [query, JSON.stringify(hostile)];
        const fromMetadata = await search(query, { creator_name: hostile, creatorName: hostile, creator_id: CLEAN_ID });
        const fromPayload = await search(query, null, { creatorName: hostile, creator_id: CLEAN_ID });
        // an empty metadata value falls through to the payload's: that one is checked too
        const behindEmpty = await search(query, { creator_name: '' }, { creator_name: hostile });
        for (const [where, resp] of [['metadata', fromMetadata], ['payload', fromPayload], ['behind_empty', behindEmpty]]) {
          const meta = resp.body.metadata || {};
          expect([...label, where, resp.status, lane(resp)]).toEqual([...label, where, 200, LANE_QUERIES[query]]);
          expect([...label, where, 'creator_name' in meta, 'creatorName' in meta]).toEqual([...label, where, false, false]);
          if (typeof hostile === 'string') {
            expect([...label, where, JSON.stringify(resp.body).includes(JSON.stringify(hostile).slice(1, -1))]).toEqual([...label, where, false]);
          }
        }
        // the clean id beside it still comes back
        expect([...label, fromMetadata.body.metadata.creator_id]).toEqual([...label, CLEAN_ID]);
      }

      for (const hostileId of ['c<1>', 'c 1', { id: 'c1' }, 'c'.repeat(129), 'c\u200b1']) {
        const label = [query, JSON.stringify(hostileId)];
        const resp = await search(query, { creator_id: hostileId, creator_name: CLEAN_NAME });
        const meta = resp.body.metadata || {};
        expect([...label, 'creator_id' in meta, 'creatorId' in meta, meta.creator_name]).toEqual([...label, false, false, CLEAN_NAME]);
      }
      // payload.search.creator_id is read too
      const inSearch = await search(query, null, { search: { query, page: 1, page_size: 20, creator_id: 'c<search>' } });
      expect([query, 'creator_id' in inSearch.body.metadata, 'creatorId' in inSearch.body.metadata]).toEqual([query, false, false]);
    }
  });

  test('source, market and trace_id: hostile values are not echoed at the top level; clean ones are unchanged', async () => {
    // values the upstream lane sets in its own answer: not the caller's, so never filtered, whatever they hold
    const upstreamMetadata = { source: 'Upstream Lane', creator_name: 'Lane <Name>', creator_id: 'lane id', market: 'us', trace_id: 'lane trace' };
    const { search } = bootCatalog({ upstreamMetadata });
    // the safe-empty spreads the handler metadata, so it carries every top-level value
    const clean = await search('Lidschatten', { source: 'shopping_agent', market: 'US', trace_id: 'trace-1.a:b' });
    expect([clean.body.metadata.source, clean.body.metadata.market, clean.body.metadata.trace_id]).toEqual([
      'shopping_agent', 'US', 'trace-1.a:b',
    ]);
    for (const [key, hostile] of [
      ['source', 'HOSTILE<SRC>'],
      ['source', 'shopping agent'],
      ['source', { s: 1 }],
      ['source', 's'.repeat(65)],
      ['market', 'HOSTILE<MK>'],
      ['market', 'us'],
      ['market', 'USA'],
      ['market', 'toString'],
      ['market', { m: 'US' }],
      ['trace_id', 't<1>'],
      ['trace_id', 't 1'],
    ]) {
      const label = [key, JSON.stringify(hostile)];
      const resp = await search('Lidschatten', { [key]: hostile });
      expect([...label, lane(resp)]).toEqual([...label, LANES.SAFE_EMPTY]);
      expect([...label, key in resp.body.metadata]).toEqual([...label, false]);
      if (key === 'trace_id') expect([...label, 'traceId' in resp.body.metadata]).toEqual([...label, false]);
    }
    // the payload's source is the caller's too
    const payloadSource = await search('Lidschatten', null, { source: 'HOSTILE<SRC>' });
    expect(['source' in payloadSource.body.metadata, JSON.stringify(payloadSource.body).includes('HOSTILE<SRC>')]).toEqual([false, false]);
    // the gateway's own default source stays
    const none = await search('Lidschatten');
    expect(none.body.metadata.source).toBe('shopping-agent-ui');
    // only the caller's values are checked: the upstream lane's own pass through untouched
    const upstream = await search('laptop', { source: 'HOSTILE<SRC>', creator_name: '<b>', trace_id: 't<1>' });
    expect(lane(upstream)).toBe(LANES.BACKEND);
    const keys = Object.keys(upstreamMetadata);
    expect(Object.fromEntries(keys.map((key) => [key, upstream.body.metadata[key]]))).toEqual(upstreamMetadata);
    expect(/HOSTILE|<b>|t<1>/.test(JSON.stringify(upstream.body))).toBe(false);
  });

  test('query_understanding.source / .market: a hostile caller value is not echoed; clean values are unchanged', async () => {
    const { search } = bootCatalog();
    for (const query of ['laptop', 'Lidschatten']) {
      const clean = await search(query, { source: 'shopping_agent', market: 'US' });
      expect([query, clean.body.metadata.query_understanding?.source, clean.body.metadata.query_understanding?.market]).toEqual([
        query, 'shopping_agent', 'US',
      ]);
      const none = await search(query);
      expect([query, none.body.metadata.query_understanding?.source]).toEqual([query, 'shopping-agent-ui']);

      for (const [where, metadata, extra] of [
        ['metadata', { source: 'HOSTILE<SRC>', market: 'HOSTILE<MK>' }, {}],
        ['metadata_object', { source: { s: 1 }, market: { m: 1 } }, {}],
        ['payload', null, { source: 'HOSTILE<SRC>', market: 'HOSTILE<MK>' }],
        ['search', null, { search: { query, page: 1, page_size: 20, market: 'HOSTILE<MK>' } }],
        ['metadata_lowercase', { source: 'hostile<src>', market: 'hostile<mk>' }, {}],
      ]) {
        const label = [query, where];
        const resp = await search(query, metadata, extra);
        const understanding = resp.body.metadata?.query_understanding;
        expect([...label, resp.status, Boolean(understanding)]).toEqual([...label, 200, true]);
        expect([...label, /HOSTILE|object Object/i.test(JSON.stringify(understanding))]).toEqual([...label, false]);
        if (where !== 'search') {
          expect([...label, 'source' in understanding]).toEqual([...label, false]);
        }
        if (where !== 'payload') {
          expect([...label, 'market' in understanding]).toEqual([...label, false]);
        }
      }
    }
  });
});

describe('find_products_multi: a forged primary lane cannot move a creator beauty query off its lane', () => {
  let prevEnv;

  afterAll(() => {
    expect(netGuard.state.blocked.filter((entry) => entry.owner === OWNER)).toEqual([]);
  });

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../src/auroraBff/routes', () => ({ mountAuroraBffRoutes: () => {}, __internal: {} }));
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => String(host || '').includes('127.0.0.1'));
    prevEnv = { ...process.env };
    process.env.PIVOTA_API_BASE = UPSTREAM;
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE = 'off';
    process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE = 'off';
    process.env.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED = 'false';
    process.env.PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED = 'false';
    process.env.GATEWAY_RATE_LIMIT_ENABLED = 'false';
    delete process.env.DATABASE_URL;
    delete process.env.FIND_PRODUCTS_BUYER_MARKET;
  });

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve()))));
    process.env = prevEnv;
    jest.dontMock('../../src/auroraBff/routes');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  async function creatorConcernSearch(metadataExtra) {
    let primitiveBody = null;
    const legacy = nock(UPSTREAM)
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, { status: 'success', success: true, products: [{ merchant_id: 'm_legacy', product_id: 'p_legacy', title: 'Legacy' }], total: 1 });
    const primitive = nock(UPSTREAM)
      .post('/agent/internal/products/search')
      .reply(200, (_, body) => {
        primitiveBody = body;
        return {
          status: 'success',
          success: true,
          products: [{ merchant_id: 'm_1', product_id: 'p_1', title: 'Oil Control Cleanser' }],
          total: 1,
          metadata: { query_source: 'internal_products_search_primitive_cache', transport_owner: 'internal_products_search_primitive' },
        };
      });
    const strictInvoke = nock(UPSTREAM)
      .post('/agent/shop/v1/invoke')
      .reply(200, { status: 'success', success: true, products: [{ merchant_id: 'm_strict', product_id: 'p_strict', title: 'Strict' }], total: 1 });
    const app = listen(owned(() => require('../../src/server')));
    const resp = await owned(async () =>
      request(app)
        .post('/agent/shop/v1/invoke')
        .send({
          operation: 'find_products_multi',
          payload: {
            search: {
              query: 'i have oily skin, what products should i use',
              catalog_surface: 'beauty',
              commerce_surface: 'beauty',
              limit: 10,
              in_stock_only: true,
            },
          },
          metadata: { source: 'creator_agent', catalog_surface: 'beauty', commerce_surface: 'beauty', ...metadataExtra },
        }));
    const used = { legacy: legacy.isDone(), primitive: primitive.isDone(), strict: strictInvoke.isDone() };
    nock.cleanAll();
    return { resp, used, primitiveBody };
  }

  test.each([
    ['contract shop_invoke_strict', { search_request_contract: forgedContract('shop_invoke_strict') }],
    ['contract resolver_only', { search_request_contract: forgedContract('resolver_only') }],
    ['contract catalog_child_recall', { search_request_contract: forgedContract('catalog_child_recall') }],
    ['contract + primary_lane', { search_request_contract: forgedContract('shop_invoke_strict'), primary_lane: 'shop_invoke_strict' }],
  ])('%s: served by the gateway\'s own mainline lane, and the contract echoed is the gateway\'s', async (_label, forged) => {
    const baseline = await creatorConcernSearch({});
    expect(baseline.used).toEqual({ legacy: false, primitive: true, strict: false });
    jest.resetModules();
    jest.doMock('../../src/auroraBff/routes', () => ({ mountAuroraBffRoutes: () => {}, __internal: {} }));
    const attacked = await creatorConcernSearch(forged);
    expect(attacked.resp.status).toBe(200);
    expect(attacked.used).toEqual(baseline.used);
    expect(attacked.primitiveBody).toEqual({ ...baseline.primitiveBody, trace_id: attacked.primitiveBody?.trace_id });
    const meta = attacked.resp.body.metadata || {};
    expect([meta.primary_lane, meta.transport_owner]).toEqual(['beauty_discovery_mainline', 'internal_products_search_primitive']);
    expect(meta.search_request_contract).toEqual(baseline.resp.body.metadata.search_request_contract);
    expect(meta.search_request_contract.surface).toBe('gateway');
    expect(JSON.stringify(attacked.resp.body).includes(FORGED)).toBe(false);
  });
});
