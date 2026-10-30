// Loopback-only: nothing in this file (or a mutant of the code it tests) can reach a real host.
const netGuard = require('../search_routing_net_guard.cjs');

/**
 * find_products_multi on the real invoke route: follow-ups to the caller-contract rules in
 * src/findProductsMulti/callerEcho.js.
 *
 *  (1) query_understanding is the gateway's own. The beauty mainline adopted one sent by the caller (in
 *      payload.search, in the payload itself, or in the request metadata) and echoed the caller's whole
 *      object back as metadata.query_understanding. A caller's is dropped from all three, from both copies
 *      of the payload, before anything reads them; the gateway's own (understandShoppingQuery, written into
 *      the search block and the handler's metadata by the context build) still reaches every reader.
 *  (2) A rejected caller market clears query_understanding.market and hard_constraints.market only when it
 *      is the market the request USED (the search block's market -- the payload's own when there is no
 *      search block -- else metadata.market; a market beside a search block is not used by any lane). A
 *      rejected market sent beside a clean one that was used no longer clears the clean one.
 */

const nock = require('nock');
const request = require('supertest');

const CANONICAL_MARKER = 'WITH candidate_products';
const UPSTREAM = 'http://upstream.invalid';

jest.setTimeout(120000);

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
  row('lipstick_a', 'Velvet Matte Lipstick', 'beauty/makeup/lip/lipstick', { productType: 'Lipstick' }),
];

const OWNER = 'invoke.find_products_multi_caller_query_understanding';
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
  SAFE_EMPTY: 'search_quality_contract_v1_safe_empty',
  BACKEND: 'agent_products_search',
};

const lane = (resp) => resp.body?.metadata?.query_source || null;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

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

// A forged understanding: a real gateway understanding of ANOTHER query, plus markers that must never
// come back (its decision, a market and a source it was never given).
const FORGED = 'zz_forged_by_caller';
function forgedUnderstanding(query = 'lipstick') {
  const { understandShoppingQuery } = require('../../src/findProductsMulti/queryUnderstanding');
  return {
    ...understandShoppingQuery({ rawQuery: query, allowContextBinding: false }),
    decision: FORGED,
    market: 'ZQ',
    source: FORGED,
    forged_marker: FORGED,
  };
}

describe('find_products_multi: a caller query_understanding is never adopted; a rejected market is compared with the used market only', () => {
  let prevEnv;
  let seenBodies;

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
      'SEARCH_BUDGET_REQUIRE_MARKER',
      'PIVOTA_GATEWAY_GOVERNANCE_SHADOW_MODE',
      'FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING',
      'FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING',
      'SEARCH_QUALITY_CONTRACT_V1_ENABLED',
      'SEARCH_QUALITY_CONTRACT_V1_MODE',
    ]) {
      delete process.env[key];
    }
  });

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve()))));
    process.env = prevEnv;
    jest.dontMock('../../src/db');
    jest.dontMock('../../src/services/retinoidSafetySignal');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  // A fixed fixture catalog answers every canonical-catalog statement; the upstream text lane answers empty.
  // The retinoid request-context reader is the first reader of the whole request body after the handler's
  // drop: what it is handed (a copy) is recorded, so a test can see both payload copies and the metadata
  // the lanes go on to read.
  function bootCatalog() {
    process.env.DATABASE_URL = 'postgres://caller-query-understanding.invalid/db';
    const upstreamBody = { status: 'success', products: [], total: 0 };
    nock(UPSTREAM).persist().post(/.*/).reply(200, upstreamBody).get(/.*/).reply(200, upstreamBody);
    jest.doMock('../../src/db', () => ({
      query: async (sql) => (String(sql || '').includes(CANONICAL_MARKER) ? { rows: CATALOG } : { rows: [] }),
    }));
    seenBodies = [];
    const recorder = seenBodies;
    jest.doMock('../../src/services/retinoidSafetySignal', () => {
      const actual = jest.requireActual('../../src/services/retinoidSafetySignal');
      return {
        ...actual,
        retinoidSafetyClassesForRequestContext: (body, options) => {
          recorder.push(JSON.parse(JSON.stringify(body)));
          return actual.retinoidSafetyClassesForRequestContext(body, options);
        },
      };
    });
    const app = listen(owned(() => require('../../src/server')));
    const post = async (body) => {
      const resp = await owned(async () =>
        request(app).post('/agent/shop/v1/invoke').set('content-type', 'application/json').send(JSON.stringify(body)));
      await delay(5);
      return resp;
    };
    const send = (payload, metadata = undefined, operation = 'find_products_multi') =>
      post({ operation, payload, ...(metadata !== undefined ? { metadata } : {}) });
    return { post, send };
  }

  // ---------------------------------------------------------------------------------------------------
  // (1) query_understanding
  // ---------------------------------------------------------------------------------------------------

  // Clean request shapes: a search block, a search block that names the beauty domain (the early beauty
  // lane), and the query at the payload's top level (the lanes then read the payload itself).
  const SHAPES = Object.freeze({
    search: (query) => ({ search: { query, page: 1, page_size: 20 } }),
    beauty_domain: (query) => ({ search: { query, page: 1, page_size: 20, domain: 'beauty' } }),
    top: (query) => ({ query, page: 1, page_size: 20 }),
  });
  // Where a caller can put an understanding: [name, shapes it applies to, (payload, qu) -> [payload, metadata]]
  const PLACEMENTS = Object.freeze([
    ['payload.search', ['search', 'beauty_domain'], (payload, qu) => [{ ...payload, search: { ...payload.search, query_understanding: qu } }, undefined]],
    ['payload (beside a search block)', ['search', 'beauty_domain'], (payload, qu) => [{ ...payload, query_understanding: qu }, undefined]],
    ['payload (no search block)', ['top'], (payload, qu) => [{ ...payload, query_understanding: qu }, undefined]],
    ['metadata', ['search', 'beauty_domain', 'top'], (payload, qu) => [payload, { query_understanding: qu }]],
    ['all three', ['search', 'beauty_domain'], (payload, qu) => [
      { ...payload, query_understanding: qu, search: { ...payload.search, query_understanding: qu } },
      { query_understanding: qu },
    ]],
  ]);
  const QUERIES = ['sunscreen', 'cream', 'moisturizer', 'laptop', 'Lidschatten'];

  test('(1) a caller query_understanding in payload.search, the payload or the metadata is not adopted or echoed; the answer is the clean one', async () => {
    const { send } = bootCatalog();
    const qu = forgedUnderstanding();
    let earlyLaneSeen = 0;
    for (const operation of ['find_products_multi', 'find_products']) {
      for (const query of QUERIES) {
        for (const [shape, build] of Object.entries(SHAPES)) {
          const cleanPayload = build(query);
          const clean = await send(cleanPayload, undefined, operation);
          expect([operation, query, shape, clean.status]).toEqual([operation, query, shape, 200]);
          if (operation === 'find_products_multi' && lane(clean) === LANES.MAINLINE && !clean.body.metadata.query_understanding) {
            earlyLaneSeen += 1;
          }
          for (const [where, shapes, place] of PLACEMENTS) {
            if (!shapes.includes(shape)) continue;
            const label = [operation, query, shape, where];
            const attacked = await send(...place(cleanPayload, qu), operation);
            expect([...label, attacked.status, lane(attacked)]).toEqual([...label, clean.status, lane(clean)]);
            expect([...label, attacked.text.includes(FORGED), attacked.text.includes('"ZQ"')]).toEqual([...label, false, false]);
            expect([...label, normalize(attacked.body.metadata?.query_understanding)]).toEqual([
              ...label, normalize(clean.body.metadata?.query_understanding),
            ]);
            expect([...label, normalize(attacked.body)]).toEqual([...label, normalize(clean.body)]);
          }
        }
      }
    }
    // the matrix reached the early beauty lane, where the caller's understanding used to come back
    expect(earlyLaneSeen).toBeGreaterThan(0);
  }, 600000);

  test('(1) the answer\'s query_understanding is the gateway\'s own, built from the request\'s own query, or none where the lane builds none', async () => {
    const { send } = bootCatalog();
    const qu = forgedUnderstanding();
    for (const query of ['cream', 'moisturizer', 'laptop', 'Lidschatten']) {
      for (const [payload, metadata] of [
        [{ search: { query, page: 1, page_size: 20, query_understanding: qu } }, { query_understanding: qu }],
        [{ query, page: 1, page_size: 20, query_understanding: qu }, undefined],
      ]) {
        const resp = await send(payload, metadata);
        const got = resp.body.metadata?.query_understanding;
        const label = [query, JSON.stringify(Object.keys(payload))];
        expect([...label, resp.status, got?.version, got?.raw_query, got?.decision, got?.effective_query]).toEqual([
          ...label, 200, 'query_understanding_v1', query, 'apply_raw', query,
        ]);
        expect([...label, resp.body.metadata.query_understanding_decision, resp.body.metadata.query_understanding_executed]).toEqual([
          ...label, 'apply_raw', true,
        ]);
        // the gateway's default source, no market (the request named none), no caller key
        expect([...label, hasOwn(got, 'forged_marker'), hasOwn(got, 'market'), got.source]).toEqual([...label, false, false, 'shopping-agent-ui']);
      }
    }
    // The early beauty lane answers before the gateway understands the query: no understanding comes back,
    // as for a clean request, and never the caller's.
    for (const [query, payload, metadata] of [
      ['sunscreen', { search: { query: 'sunscreen', page: 1, page_size: 20, query_understanding: qu } }, undefined],
      ['sunscreen', { query: 'sunscreen', page: 1, page_size: 20, query_understanding: qu }, undefined],
      ['sunscreen', { search: { query: 'sunscreen', page: 1, page_size: 20 } }, { query_understanding: qu }],
      ['cream', { search: { query: 'cream', page: 1, page_size: 20, domain: 'beauty', query_understanding: qu } }, undefined],
      ['cream', { search: { query: 'cream', page: 1, page_size: 20, domain: 'beauty' } }, { query_understanding: qu }],
    ]) {
      const resp = await send(payload, metadata);
      const label = [query, JSON.stringify(payload), JSON.stringify(metadata || null)];
      expect([...label, resp.status, lane(resp)]).toEqual([...label, 200, LANES.MAINLINE]);
      expect([
        ...label,
        hasOwn(resp.body.metadata, 'query_understanding'),
        hasOwn(resp.body.metadata, 'query_understanding_decision'),
        hasOwn(resp.body.metadata?.route_health, 'query_understanding_decision'),
      ]).toEqual([...label, false, false, false]);
    }
  }, 300000);

  test('(1) the request the lanes read carries no caller query_understanding: not in the metadata, the parsed payload or the raw body copy', async () => {
    const { send } = bootCatalog();
    const qu = forgedUnderstanding();
    for (const query of ['sunscreen', 'cream', 'laptop']) {
      for (const [where, payload, metadata] of [
        ['payload.search', { search: { query, page: 1, page_size: 20, query_understanding: qu } }, undefined],
        ['payload beside search', { search: { query, page: 1, page_size: 20 }, query_understanding: qu }, undefined],
        ['payload, no search block', { query, page: 1, page_size: 20, query_understanding: qu }, undefined],
        ['metadata', { search: { query, page: 1, page_size: 20 } }, { source: 'shopping_agent', query_understanding: qu }],
      ]) {
        const label = [query, where];
        seenBodies.length = 0;
        const resp = await send(payload, metadata);
        expect([...label, resp.status, seenBodies.length]).toEqual([...label, 200, 1]);
        const [body] = seenBodies;
        expect([
          ...label,
          hasOwn(body.payload, 'query_understanding'),
          hasOwn(body.payload?.search, 'query_understanding'),
          hasOwn(body.metadata, 'query_understanding'),
          JSON.stringify(body).includes(FORGED),
        ]).toEqual([...label, false, false, false, false]);
        // nothing else in the request changed
        if (metadata) expect([...label, body.metadata]).toEqual([...label, { source: 'shopping_agent' }]);
        const { query_understanding: _drop, ...rest } = payload;
        const want = payload.search
          ? { ...rest, search: Object.fromEntries(Object.entries(payload.search).filter(([key]) => key !== 'query_understanding')) }
          : rest;
        expect([...label, body.payload]).toEqual([...label, want]);
      }
    }
  }, 300000);

  // ---------------------------------------------------------------------------------------------------
  // (2) the market a rejected caller value is compared with
  // ---------------------------------------------------------------------------------------------------

  const marketFields = (body) => ({
    understanding: body.metadata?.query_understanding?.market,
    constraint: body.metadata?.search_quality_contract?.hard_constraints?.market,
  });
  // [clean market that is used, a rejected value that records to the same form]
  const COLLIDING = [['US', 'us'], ['DE', 'de'], ['DE', ' DE'], ['SG', 'Sg '], ['US', ['US']]];
  // laptop: the backend lane (policy step); Lidschatten: the safe-empty answer; cream: the beauty mainline,
  // which serves (and records a market) only for a market it can price
  const MARKET_CASES = [
    ['laptop', COLLIDING],
    ['Lidschatten', COLLIDING],
    ['cream', COLLIDING.filter(([clean]) => clean === 'US' || clean === 'SG')],
  ];
  const searchBlock = (query, market) => ({ search: { query, page: 1, page_size: 20, ...(market !== undefined ? { market } : {}) } });

  test('(2) a rejected metadata market does not clear a clean search.market (or flat payload market) that was used; the same market, when used, is cleared', async () => {
    const { send } = bootCatalog();
    for (const [query, pairs] of MARKET_CASES) {
      for (const [cleanMarket, rejected] of pairs) {
        const label = [query, cleanMarket, JSON.stringify(rejected)];
        // used: search.market, rejected beside it in the metadata
        const baseline = await send(searchBlock(query, cleanMarket));
        expect([...label, baseline.status, marketFields(baseline.body)]).toEqual([
          ...label, 200, { understanding: cleanMarket, constraint: cleanMarket },
        ]);
        const beside = await send(searchBlock(query, cleanMarket), { market: rejected });
        expect([...label, 'search', beside.status, marketFields(beside.body)]).toEqual([
          ...label, 'search', 200, { understanding: cleanMarket, constraint: cleanMarket },
        ]);
        // used: a flat payload's market (no search block), rejected beside it in the metadata
        const payloadUsed = await send({ query, page: 1, page_size: 20, market: cleanMarket }, { market: rejected });
        expect([...label, 'payload', payloadUsed.status, marketFields(payloadUsed.body)]).toEqual([
          ...label, 'payload', 200, { understanding: cleanMarket, constraint: cleanMarket },
        ]);
        // the rejected metadata market itself is not echoed at the top level
        expect([...label, beside.body.metadata?.market === rejected, payloadUsed.body.metadata?.market === rejected]).toEqual([
          ...label, false, false,
        ]);
        // used: the rejected metadata market itself (nothing in the payload): cleared from both fields
        const used = await send(searchBlock(query), { market: rejected });
        expect([...label, 'used', used.status, hasOwn(used.body.metadata?.query_understanding, 'market'), marketFields(used.body).constraint ?? null]).toEqual([
          ...label, 'used', 200, false, null,
        ]);
        // a clean payload market BESIDE a search block is not used: the rejected metadata market is, and is cleared
        const besideBlock = await send({ ...searchBlock(query), market: cleanMarket }, { market: rejected });
        expect([
          ...label, 'beside block', besideBlock.status,
          hasOwn(besideBlock.body.metadata?.query_understanding, 'market'), marketFields(besideBlock.body).constraint ?? null,
        ]).toEqual([...label, 'beside block', 200, false, null]);
      }
    }
  }, 600000);

  test('(2) a rejected payload market does not clear a clean search.market that was used; a flat one, when used, is cleared; one beside a search block is never used', async () => {
    const { send } = bootCatalog();
    for (const [query, pairs] of MARKET_CASES) {
      for (const [cleanMarket, rejected] of pairs) {
        const label = [query, cleanMarket, JSON.stringify(rejected)];
        // used: search.market, rejected beside it as payload.market (and the metadata naming the clean one)
        for (const metadata of [undefined, { market: cleanMarket }]) {
          const beside = await send({ ...searchBlock(query, cleanMarket), market: rejected }, metadata);
          expect([...label, JSON.stringify(metadata || null), beside.status, marketFields(beside.body)]).toEqual([
            ...label, JSON.stringify(metadata || null), 200, { understanding: cleanMarket, constraint: cleanMarket },
          ]);
        }
        // used: the rejected flat payload market (the metadata's clean market comes after it): cleared from both
        for (const metadata of [undefined, { market: cleanMarket }]) {
          const used = await send({ query, page: 1, page_size: 20, market: rejected }, metadata);
          expect([
            ...label, 'used', JSON.stringify(metadata || null), used.status,
            hasOwn(used.body.metadata?.query_understanding, 'market'), marketFields(used.body).constraint ?? null,
          ]).toEqual([...label, 'used', JSON.stringify(metadata || null), 200, false, null]);
        }
        // not used: the rejected payload market beside a search block; the metadata's clean market is, and stays
        const notUsed = await send({ ...searchBlock(query), market: rejected }, { market: cleanMarket });
        expect([...label, 'beside block', notUsed.status, marketFields(notUsed.body)]).toEqual([
          ...label, 'beside block', 200, { understanding: cleanMarket, constraint: cleanMarket },
        ]);
        // ...and with no metadata market nothing was used, so nothing is recorded
        const nothing = await send({ ...searchBlock(query), market: rejected });
        expect([
          ...label, 'beside block, alone', nothing.status,
          hasOwn(nothing.body.metadata?.query_understanding, 'market'), marketFields(nothing.body).constraint ?? null,
        ]).toEqual([...label, 'beside block, alone', 200, false, null]);
        // used: a rejected search.market, with clean payload and metadata markets after it: cleared
        const usedSearch = await send({ ...searchBlock(query, rejected), market: cleanMarket }, { market: cleanMarket });
        expect([
          ...label, 'used search', usedSearch.status,
          hasOwn(usedSearch.body.metadata?.query_understanding, 'market'), marketFields(usedSearch.body).constraint ?? null,
        ]).toEqual([...label, 'used search', 200, false, null]);
      }
    }
  }, 600000);
});

describe('callerEcho: query_understanding is dropped from the request; the used market', () => {
  const callerEcho = require('../../src/findProductsMulti/callerEcho');
  const qu = { version: 'query_understanding_v1', decision: 'zz_forged_by_caller' };

  test('(1) withoutCallerSearchRequestContract drops a metadata query_understanding unless the metadata is the gateway\'s own', () => {
    const metadata = { source: 'shopping_agent', query_understanding: qu };
    expect(callerEcho.withoutCallerSearchRequestContract(metadata)).toEqual({ source: 'shopping_agent' });
    // the caller's object is not changed in place
    expect(metadata).toEqual({ source: 'shopping_agent', query_understanding: qu });
    const gatewayMetadata = { source: 'aurora-bff', query_understanding: qu };
    expect(callerEcho.withoutCallerSearchRequestContract(gatewayMetadata, { gatewayMetadata })).toBe(gatewayMetadata);
  });

  test('(1) withoutCallerSearchGatewayKeys drops query_understanding (and search_quality_contract) from each payload and its search block, sharing copies', () => {
    const contract = { contract_version: 'search_quality_contract_v1' };
    const search = { query: 'sunscreen', query_understanding: qu };
    const parsed = { search, query_understanding: qu };
    const raw = { search, query_understanding: qu, search_quality_contract: contract, extra: 1 };
    const [ownParsed, ownRaw] = callerEcho.withoutCallerSearchGatewayKeys(parsed, raw);
    expect(ownParsed).toEqual({ search: { query: 'sunscreen' } });
    expect(ownRaw).toEqual({ search: { query: 'sunscreen' }, extra: 1 });
    expect(ownParsed.search).toBe(ownRaw.search);
    // the caller's objects are not changed in place
    expect(parsed).toEqual({ search: { query: 'sunscreen', query_understanding: qu }, query_understanding: qu });
    expect(raw.search_quality_contract).toBe(contract);
    // only the search block, or only the top level
    expect(callerEcho.withoutCallerSearchGatewayKeys({ search: { query: 'a', query_understanding: qu } })).toEqual([{ search: { query: 'a' } }]);
    expect(callerEcho.withoutCallerSearchGatewayKeys({ query: 'a', query_understanding: qu })).toEqual([{ query: 'a' }]);
    // nothing to drop: the inputs themselves
    const clean = { search: { query: 'sunscreen' } };
    const [sameClean] = callerEcho.withoutCallerSearchGatewayKeys(clean);
    expect(sameClean).toBe(clean);
    // #2511's name is the same function
    expect(callerEcho.withoutCallerSearchQualityContract).toBe(callerEcho.withoutCallerSearchGatewayKeys);
  });

  test('(2) callerChosenMarket is the one reading every lane serves: the search block\'s market (a flat payload\'s own), else the metadata\'s', () => {
    expect(callerEcho.callerChosenMarket({ market: 'c' }, { market: 'b', search: { market: 'a' } })).toBe('a');
    // a market beside a search block is not read
    expect(callerEcho.callerChosenMarket({ market: 'c' }, { market: 'b', search: {} })).toBe('c');
    expect(callerEcho.callerChosenMarket({}, { market: 'b', search: {} })).toBe(undefined);
    expect(callerEcho.callerChosenMarket({ market: 'c' }, { search: { market: '' } })).toBe('c');
    expect(callerEcho.callerChosenMarket({ market: 'c' }, { market: '', search: { query: 'x' } })).toBe('c');
    expect(callerEcho.callerChosenMarket({ market: 'c' }, { market: 'b' })).toBe('b');
    expect(callerEcho.callerChosenMarket(undefined, { search: ['x'], market: 'b' })).toBe('b');
    expect(callerEcho.callerChosenMarket({}, {})).toBe(undefined);
    expect(callerEcho.callerChosenMarket(null, null)).toBe(undefined);
    expect(callerEcho.callerChosenMarket({ market: ['us'] }, {})).toEqual(['us']);
  });

  test('(2) withoutHostileCallerEcho clears the recorded market only when the used market is a rejected one', () => {
    const body = (market) => ({
      metadata: {
        query_understanding: { market, decision: 'apply_raw' },
        search_quality_contract: { hard_constraints: { market, brand: null } },
      },
    });
    const sent = (...values) => new Map([['market', values]]);
    // a clean used market, a rejected one of the same form sent elsewhere: untouched
    const clean = body('US');
    expect(callerEcho.withoutHostileCallerEcho(clean, sent('US', 'us'), { chosenMarket: 'US' })).toBe(clean);
    // nothing used from the caller: untouched
    expect(callerEcho.withoutHostileCallerEcho(clean, sent('us'), { chosenMarket: undefined })).toBe(clean);
    // the used market is the rejected one: cleared from both fields
    expect(callerEcho.withoutHostileCallerEcho(body('US'), sent('us', 'US'), { chosenMarket: 'us' })).toEqual({
      metadata: {
        query_understanding: { decision: 'apply_raw' },
        search_quality_contract: { hard_constraints: { market: null, brand: null } },
      },
    });
    expect(callerEcho.withoutHostileCallerEcho(body('US'), sent(['US']), { chosenMarket: ['US'] }).metadata.search_quality_contract.hard_constraints.market).toBe(null);
  });
});
