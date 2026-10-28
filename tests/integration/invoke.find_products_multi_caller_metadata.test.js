// Loopback-only: nothing in this file (or a mutant of the code it tests) can reach a real host.
const netGuard = require('../search_routing_net_guard.cjs');

/**
 * find_products_multi on the real invoke route: follow-ups to the caller-contract rules in
 * src/findProductsMulti/callerEcho.js.
 *
 *  (a) public_search_route / invoke_search_rail are the gateway's routing flags. Sent by a POST caller
 *      they are dropped before anything reads them; the public GET search route, which sets
 *      public_search_route itself and hands its own metadata object over in-process, keeps them.
 *  (b) The safe-empty answer echoes no caller key outside the attribution allowlist, with the routing
 *      flags off as well as on.
 *  (c) A caller source that fails its echo rule never comes back in a normalised form either
 *      (search_request_contract.source, guard_source_normalized, the beauty delegation trace,
 *      query_understanding.source, an array source's string form).
 *  (d) A market is echoed (top level, query_understanding, hard_constraints) when it is a priced market,
 *      an officially assigned ISO 3166-1 alpha-2 code, or EU, exactly as written; nothing else is.
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
];

const OWNER = 'invoke.find_products_multi_caller_metadata';
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
  DISCOVERY: 'beauty_discovery_mainline',
  INGREDIENT: 'agent_products_ingredient_recall_direct',
  SAFE_EMPTY: 'search_quality_contract_v1_safe_empty',
  BACKEND: 'agent_products_search',
};
const FLAG_KEYS = ['FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING', 'FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING'];
const BOTH_OBSERVE = { FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'observe', FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'observe' };
const BOTH_ON = { FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on', FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'on' };

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

describe('find_products_multi: caller metadata follow-ups (routing flags, safe-empty echo, rejected source, market)', () => {
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
      'SEARCH_BUDGET_REQUIRE_MARKER',
      'PIVOTA_GATEWAY_GOVERNANCE_SHADOW_MODE',
      ...FLAG_KEYS,
    ]) {
      delete process.env[key];
    }
  });

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve()))));
    process.env = prevEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  // A fixed fixture catalog answers every canonical-catalog statement; the upstream text lane answers empty.
  function bootCatalog(env = {}) {
    Object.assign(process.env, env);
    process.env.DATABASE_URL = 'postgres://caller-metadata.invalid/db';
    const upstreamBody = { status: 'success', products: [], total: 0 };
    nock(UPSTREAM).persist().post(/.*/).reply(200, upstreamBody).get(/.*/).reply(200, upstreamBody);
    jest.doMock('../../src/db', () => ({
      query: async (sql) => (String(sql || '').includes(CANONICAL_MARKER) ? { rows: CATALOG } : { rows: [] }),
    }));
    const app = listen(owned(() => require('../../src/server')));
    // `body` is sent as given: a string goes out as raw JSON, so it can carry keys an object literal
    // cannot (an own "__proto__").
    const post = async (body, headers = {}) => {
      const req = request(app).post('/agent/shop/v1/invoke').set('content-type', 'application/json');
      for (const [name, value] of Object.entries(headers)) req.set(name, value);
      const resp = await owned(async () => req.send(typeof body === 'string' ? body : JSON.stringify(body)));
      await delay(5);
      return resp;
    };
    const send = (payload, metadata = undefined) =>
      post({ operation: 'find_products_multi', payload, ...(metadata !== undefined ? { metadata } : {}) });
    const search = (query, metadata = undefined, extra = {}) =>
      send({ search: { query, page: 1, page_size: 20 }, ...extra }, metadata);
    const get = async (query) => {
      const resp = await owned(async () => request(app).get('/agent/v1/products/search').query({ ...query, limit: 5 }));
      await delay(5);
      return resp;
    };
    return { app, post, send, search, get };
  }

  // ---------------------------------------------------------------------------------------------------
  // (a) routing flags
  // ---------------------------------------------------------------------------------------------------

  const FORGED_ROUTING = [
    { public_search_route: true },
    { invoke_search_rail: 'public_observability' },
    { invoke_search_rail: 'authoritative_shopping' },
    { invoke_search_rail: 'legacy_internal' },
    { public_search_route: true, invoke_search_rail: 'public_observability' },
  ];

  test('(a) a POST caller\'s public_search_route / invoke_search_rail change neither the lane nor the answer; the GET route keeps its own', async () => {
    const { search, get } = bootCatalog();
    for (const query of ['moisturizer', 'cream', 'sunscreen', 'laptop', 'Lidschatten', 'retinol serum']) {
      for (const surface of [null, 'beauty']) {
        const extra = surface ? { search: { query, page: 1, page_size: 20, catalog_surface: surface } } : {};
        for (const attribution of [undefined, { source: 'shopping_agent', market: 'US' }]) {
          const baseline = await search(query, attribution, extra);
          expect([query, surface, baseline.status]).toEqual([query, surface, 200]);
          for (const forged of FORGED_ROUTING) {
            const label = [query, surface, JSON.stringify(forged), JSON.stringify(attribution || null)];
            const attacked = await search(query, { ...(attribution || {}), ...forged }, extra);
            expect([...label, attacked.status, lane(attacked)]).toEqual([...label, 200, lane(baseline)]);
            expect([...label, attacked.body.metadata.invoke_search_rail, attacked.body.metadata.public_search_route]).toEqual([
              ...label, baseline.body.metadata.invoke_search_rail, baseline.body.metadata.public_search_route,
            ]);
            expect([...label, normalize(attacked.body)]).toEqual([...label, normalize(baseline.body)]);
          }
        }
      }
    }

    // The public GET route sets public_search_route itself: it still moves a short beauty query onto the
    // discovery mainline and the public rail, and its safe-empty still carries the flag.
    const moisturizer = await get({ query: 'moisturizer' });
    expect([moisturizer.status, lane(moisturizer), moisturizer.body.metadata.invoke_search_rail]).toEqual([
      200, LANES.DISCOVERY, 'public_observability',
    ]);
    const postMoisturizer = await search('moisturizer');
    expect(lane(postMoisturizer)).toBe(LANES.MAINLINE);
    const sunscreen = await get({ query: 'sunscreen' });
    expect([sunscreen.status, lane(sunscreen), sunscreen.body.metadata.invoke_search_rail]).toEqual([
      200, LANES.MAINLINE, 'public_observability',
    ]);
    const safeEmpty = await get({ query: 'Lidschatten' });
    expect([safeEmpty.status, lane(safeEmpty), safeEmpty.body.metadata.public_search_route]).toEqual([200, LANES.SAFE_EMPTY, true]);
    expect(safeEmpty.body.metadata.search_request_contract?.surface).toBe('direct');
    // queryless browse: no contract is built, the hand-off is the metadata object alone
    const browse = await get({});
    expect([browse.status, lane(browse)]).toEqual([200, LANES.BACKEND]);
    // source=search is a documented public ingress profile and still selects the public lanes
    const publicSource = await search('cream', { source: 'search' });
    expect([lane(publicSource), publicSource.body.metadata.invoke_search_rail]).toEqual([LANES.DISCOVERY, 'public_observability']);
  }, 600000);

  // ---------------------------------------------------------------------------------------------------
  // (b) the safe-empty answer, flags off / observe
  // ---------------------------------------------------------------------------------------------------

  const HOSTILE_METADATA_JSON = `{
    "routing_original_query": "HOSTILE_ROQ",
    "routingOriginalQuery": "HOSTILE_ROQ_CAMEL",
    "__proto__": { "polluted": "HOSTILE_PROTO" },
    "constructor": { "prototype": { "polluted_ctor": "HOSTILE_CTOR" } },
    "service_version": { "commit": "HOSTILE_COMMIT", "nested": { "deep": "HOSTILE_SV_NESTED" } },
    "gateway_governance": { "x": "HOSTILE_GG" },
    "retinoid_safety_net": { "x": "HOSTILE_RSN" },
    "0": "HOSTILE_NUM_0",
    "1": { "a": "HOSTILE_NUM_1" },
    "zz_deep": { "a": { "b": { "c": "HOSTILE_DEEP" } } },
    "zz_caller_sentinel": "HOSTILE_SENTINEL",
    "source": "agent-api-tests",
    "market": "US",
    "creator_id": "creator_123",
    "creator_name": "Jane Doe",
    "trace_id": "trace-1.a:b"
  }`;
  const HOSTILE_KEYS = ['routing_original_query', 'routingOriginalQuery', '__proto__', 'constructor', 'gateway_governance',
    'retinoid_safety_net', '0', '1', 'zz_deep', 'zz_caller_sentinel'];

  test.each([
    ['flags off', {}],
    ['both observe', BOTH_OBSERVE],
    ['both on', BOTH_ON],
  ])('(b) %s: the safe-empty echoes no caller key outside the allowlist; clean attribution and gateway keys stay', async (_label, env) => {
    const { post } = bootCatalog(env);
    for (const search of [
      // (with multilingual routing on, the German query is routed as eyeshadow and is no safe-empty)
      ...(env === BOTH_ON ? [] : [{ query: 'Lidschatten', page: 1, page_size: 20 }]),
      { query: 'gift', page: 1, page_size: 20, catalog_surface: 'agent_api' },
    ]) {
      const raw = `{"operation":"find_products_multi","payload":{"search":${JSON.stringify(search)}},"metadata":${HOSTILE_METADATA_JSON}}`;
      const resp = await post(raw);
      const label = [search.query];
      expect([...label, resp.status, lane(resp)]).toEqual([...label, 200, LANES.SAFE_EMPTY]);
      const md = resp.body.metadata;
      expect([...label, /HOSTILE/.test(resp.text)]).toEqual([...label, false]);
      expect([...label, HOSTILE_KEYS.filter((key) => hasOwn(md, key))]).toEqual([...label, []]);
      expect([...label, resp.text.includes('"__proto__"'), resp.text.includes('"polluted"')]).toEqual([...label, false, false]);
      // nothing was polluted in this process either
      expect([...label, {}.polluted, {}.polluted_ctor, Object.prototype.polluted]).toEqual([...label, undefined, undefined, undefined]);
      // the gateway's own service_version, not the caller's
      expect([...label, typeof md.service_version, md.service_version.commit === 'HOSTILE_COMMIT']).toEqual([...label, 'object', false]);
      // clean attribution values still come back, under both spellings where the handler writes both
      expect([...label, md.source, md.market, md.creator_id, md.creatorId, md.creator_name, md.creatorName, md.trace_id, md.traceId]).toEqual([
        ...label, 'agent-api-tests', 'US', 'creator_123', 'creator_123', 'Jane Doe', 'Jane Doe', 'trace-1.a:b', 'trace-1.a:b',
      ]);
      // and the gateway's own keys stay
      for (const key of ['query_understanding', 'search_request_contract', 'primary_lane', 'supplement_lanes', 'invoke_search_rail',
        'search_quality_contract', 'route_health', 'search_decision']) {
        expect([...label, key, hasOwn(md, key)]).toEqual([...label, key, true]);
      }
    }
    // metadata that is not an object arrives as numbered keys: none of them comes back
    for (const metadata of ['HOSTILE_STR', ['HOSTILE_ARR_0', { a: 'HOSTILE_ARR_1' }]]) {
      const resp = await post({
        operation: 'find_products_multi',
        payload: { search: { query: 'gift', page: 1, page_size: 20, catalog_surface: 'agent_api' } },
        metadata,
      });
      const label = [JSON.stringify(metadata)];
      if (resp.status !== 200) continue; // a body the schema rejects echoes nothing either
      expect([...label, lane(resp), /HOSTILE/.test(resp.text), hasOwn(resp.body.metadata, '0')]).toEqual([...label, LANES.SAFE_EMPTY, false, false]);
    }
  }, 300000);

  test('(b) a caller value equal to the gateway\'s own under a contract or routing key does not remove the gateway\'s key', async () => {
    const SURFACE_GIFT = { query: 'gift', page: 1, page_size: 20, catalog_surface: 'agent_api' };
    for (const [mode, env] of [['off', {}], ['on', BOTH_ON]]) {
      jest.resetModules();
      for (const key of FLAG_KEYS) delete process.env[key];
      const { send } = bootCatalog(env);
      const baseline = await send({ search: SURFACE_GIFT });
      const md = baseline.body.metadata;
      expect([mode, lane(baseline), typeof md.primary_lane, Array.isArray(md.supplement_lanes)]).toEqual([mode, LANES.SAFE_EMPTY, 'string', true]);
      // the caller sends exactly what the gateway will compute: dropped on the way in, so what comes back
      // under those keys is the gateway's own, and stays
      const echoOfGateway = {
        search_request_contract: md.search_request_contract,
        primary_lane: md.primary_lane,
        primary_retrieval_contract: md.primary_retrieval_contract,
        supplement_lanes: md.supplement_lanes,
        invoke_search_rail: md.invoke_search_rail,
      };
      const attacked = await send({ search: SURFACE_GIFT }, echoOfGateway);
      expect([mode, normalize(attacked.body)]).toEqual([mode, normalize(baseline.body)]);
    }
  });

  // ---------------------------------------------------------------------------------------------------
  // (c) a rejected source, in every normalised form
  // ---------------------------------------------------------------------------------------------------

  const sourceFields = (body) => ({
    top: body.metadata?.source,
    understanding: body.metadata?.query_understanding?.source,
    contract: body.metadata?.search_request_contract?.source,
    guard: body.metadata?.guard_source_normalized,
    delegation: body.beauty_expert_v1?.delegation_trace?.source_profile,
  });
  // the lower-cased, hyphenated form of a marker, and its plain lower-case form
  const SOURCE_MARKERS = /hostile[\s_-]*src|arrsrc|objsrc|src[\s_-]*x\b/i;

  test('(c) a rejected source never comes back in a normalised form; clean sources are unchanged', async () => {
    const { search } = bootCatalog();
    // each query reaches a lane that records the source somewhere:
    //   retinol serum -> search_request_contract.source + beauty_expert_v1.delegation_trace.source_profile
    //   laptop        -> search_request_contract.source + guard_source_normalized + query_understanding.source
    //   Lidschatten   -> search_request_contract.source + query_understanding.source (+ top level)
    const QUERIES = ['retinol serum', 'laptop', 'Lidschatten'];
    for (const query of QUERIES) {
      const clean = await search(query, { source: 'shopping_agent' });
      const fields = sourceFields(clean.body);
      expect([query, fields.contract]).toEqual([query, 'shopping-agent']);
      if (query === 'retinol serum') expect([query, fields.delegation]).toEqual([query, 'shopping-agent']);
      if (query === 'laptop') expect([query, fields.guard, fields.understanding]).toEqual([query, 'shopping-agent', 'shopping_agent']);
      if (query === 'Lidschatten') expect([query, fields.top, fields.understanding]).toEqual([query, 'shopping_agent', 'shopping_agent']);
      // the gateway's default source is not the caller's: untouched
      const none = sourceFields((await search(query)).body);
      expect([query, none.contract]).toEqual([query, 'shopping-agent-ui']);

      for (const [where, metadata, extra] of [
        ['metadata', { source: 'HOSTILE Src_X' }, {}],
        ['metadata_array', { source: ['ArrSrcX'] }, {}],
        ['metadata_array_clean_token', { source: ['shopping_agent'] }, {}],
        ['metadata_object', { source: { s: 'ObjSrcX' } }, {}],
        ['metadata_markup', { source: 'Src<X>' }, {}],
        ['payload', undefined, { source: 'HOSTILE Src_X' }],
        ['payload_array', undefined, { source: ['ArrSrcX'] }],
        ['search', undefined, { search: { query, page: 1, page_size: 20, source: 'HOSTILE Src_X' } }],
      ]) {
        const label = [query, where];
        const resp = await search(query, metadata, extra);
        expect([...label, resp.status]).toEqual([...label, 200]);
        const got = sourceFields(resp.body);
        const sent = metadata?.source ?? extra.source ?? extra.search?.source;
        // the field holds no form of the rejected value: absent, null, or the gateway's own (another source)
        const formKey = (value) => String(value).trim().toLowerCase().replace(/[\s_-]+/g, '-');
        for (const [field, value] of Object.entries(got)) {
          if (value === undefined || value === null) continue;
          expect([...label, field, formKey(value) === formKey(sent)]).toEqual([...label, field, false]);
        }
        expect([...label, SOURCE_MARKERS.test(JSON.stringify(resp.body))]).toEqual([...label, false]);
        expect([...label, /object[\s_-]*object/i.test(JSON.stringify(got))]).toEqual([...label, false]);
      }
    }
  }, 300000);

  test('(c) find_products on the MCP surface (governance shadow audit on): a rejected source is not carried either', async () => {
    const { post } = bootCatalog({ PIVOTA_GATEWAY_GOVERNANCE_SHADOW_MODE: '1' });
    const call = (source) =>
      post(
        { operation: 'find_products', payload: { search: { query: 'serum' } }, metadata: { source, merchant_filters: ['m_a', 'm_b'] } },
        { 'X-Pivota-Invocation-Surface': 'mcp' },
      );
    const clean = await call('shopping_agent');
    expect([clean.status, clean.body.metadata?.gateway_governance?.would_enforce]).toEqual([200, true]);
    expect(sourceFields(clean.body)).toEqual(
      expect.objectContaining({ contract: 'shopping-agent', guard: 'shopping-agent', delegation: 'shopping-agent' }),
    );
    expect(clean.body.metadata.gateway_governance.source).toBe('shopping_agent');
    for (const source of ['HOSTILE Src_X', ['ArrSrcX']]) {
      const label = [JSON.stringify(source)];
      const resp = await call(source);
      expect([...label, resp.status]).toEqual([...label, 200]);
      const got = sourceFields(resp.body);
      expect([...label, got.contract ?? null, got.guard ?? null, got.delegation ?? null]).toEqual([...label, null, null, null]);
      expect([...label, SOURCE_MARKERS.test(JSON.stringify(resp.body))]).toEqual([...label, false]);
    }
  });

  // A rejected source the request did not run as (normalizeMetadata takes the metadata's source, else the
  // payload's, else the gateway's default) is not the request's: a field holding the same normalised form
  // holds the gateway's own source and stays. [name, metadata, clean payload extra, attacked payload extra]
  const searchBlock = (query, source) => ({ search: { query, page: 1, page_size: 20, source } });
  const NOT_CHOSEN = {
    // F1: the gateway's default ('shopping-agent-ui') vs a rejected payload.search.source of the same form
    F1: [
      ['default + search.source', undefined, () => ({}), (q) => searchBlock(q, 'shopping agent ui')],
      ['default + search.source (mixed)', undefined, () => ({}), (q) => searchBlock(q, 'Shopping_Agent UI')],
    ],
    // F2: a clean chosen source vs a rejected one of the same form elsewhere
    F2: [
      ['metadata + search.source', { source: 'agent-api' }, () => ({}), (q) => searchBlock(q, 'Agent API')],
      ['metadata + payload.source', { source: 'agent-api' }, () => ({}), () => ({ source: 'Agent API' })],
    ],
    // F3: a trailing space
    F3: [
      ['metadata + search.source', { source: 'search' }, () => ({}), (q) => searchBlock(q, 'search ')],
      ['payload.source + search.source', undefined, () => ({ source: 'search' }), (q) => ({ source: 'search', ...searchBlock(q, 'search ') })],
    ],
  };
  const NOT_CHOSEN_TITLES = {
    F1: 'a rejected payload.search.source does not clear the gateway\'s default source',
    F2: 'a rejected source sent beside a clean chosen one does not clear it; a rejected CHOSEN source still is',
    F3: 'a rejected source with a trailing space does not clear the clean source it normalises to',
  };

  for (const [finding, cases] of Object.entries(NOT_CHOSEN)) {
    test(`(c) ${finding}: ${NOT_CHOSEN_TITLES[finding]}`, async () => {
      const { search } = bootCatalog();
      for (const query of ['retinol serum', 'laptop', 'Lidschatten']) {
        for (const [name, metadata, cleanExtra, attackedExtra] of cases) {
          const label = [query, finding, name];
          const clean = await search(query, metadata, cleanExtra(query));
          const attacked = await search(query, metadata, attackedExtra(query));
          expect([...label, clean.status, attacked.status]).toEqual([...label, 200, 200]);
          const want = sourceFields(clean.body);
          // the clean answer records the gateway's own source in its contract, so there is something to keep
          expect([...label, typeof want.contract]).toEqual([...label, 'string']);
          expect([...label, sourceFields(attacked.body)]).toEqual([...label, want]);
        }
        if (finding !== 'F2') continue;
        // The same rejected string, when it IS the source the request ran as (the payload's, no metadata
        // source), is still cleared from every field.
        const label = [query, 'chosen payload.source'];
        const chosen = await search(query, undefined, { source: 'Agent API' });
        expect([...label, chosen.status]).toEqual([...label, 200]);
        const got = sourceFields(chosen.body);
        for (const [field, value] of Object.entries(got)) {
          if (value === undefined || value === null) continue;
          expect([...label, field, String(value).trim().toLowerCase().replace(/[\s_-]+/g, '-')]).not.toEqual([
            ...label, field, 'agent-api',
          ]);
        }
        expect([...label, got.contract ?? null]).toEqual([...label, null]);
      }
    }, 300000);
  }

  // ---------------------------------------------------------------------------------------------------
  // (d) market policy
  // ---------------------------------------------------------------------------------------------------

  const marketFields = (body) => ({
    top: body.metadata?.market,
    understanding: body.metadata?.query_understanding?.market,
    constraint: body.metadata?.search_quality_contract?.hard_constraints?.market,
  });

  test('(d) DE / NZ / CN / EU (and priced markets) echo exactly as sent; XX / ZZ / USA / us / markup do not, hard_constraints included', async () => {
    const { search } = bootCatalog();
    const ECHOED = ['DE', 'NZ', 'CN', 'EU', 'US', 'GB', 'SG'];
    const DROPPED = ['XX', 'ZZ', 'AA', 'QM', 'XK', 'USA', 'us', 'de', 'Eu', ' DE', '<b>US</b>', 'toString', '__proto__'];
    for (const query of ['laptop', 'Lidschatten']) {
      for (const where of ['metadata', 'payload', 'search']) {
        const build = (market) =>
          where === 'metadata'
            ? [market === undefined ? undefined : { market }, {}]
            : where === 'payload'
              ? [undefined, { market }]
              : [undefined, { search: { query, page: 1, page_size: 20, market } }];
        for (const market of ECHOED) {
          const label = [query, where, market];
          const resp = await search(query, ...build(market));
          expect([...label, resp.status]).toEqual([...label, 200]);
          const got = marketFields(resp.body);
          // top-level market is echoed only by the safe-empty answer, and only from the metadata
          if (query === 'Lidschatten' && where === 'metadata') expect([...label, got.top]).toEqual([...label, market]);
          expect([...label, got.understanding, got.constraint]).toEqual([...label, market, market]);
        }
        for (const market of DROPPED) {
          const label = [query, where, market];
          const resp = await search(query, ...build(market));
          expect([...label, resp.status]).toEqual([...label, 200]);
          const got = marketFields(resp.body);
          const upper = String(market).trim().toUpperCase();
          expect([...label, got.top === market, got.understanding === upper, got.constraint === upper]).toEqual([...label, false, false, false]);
          expect([...label, got.constraint ?? null, hasOwn(resp.body.metadata?.query_understanding, 'market')]).toEqual([...label, null, false]);
          if (/[<>]/.test(market)) expect([...label, resp.text.includes('<b>')]).toEqual([...label, false]);
        }
      }
    }
  }, 600000);
});

describe('callerEcho: the routing flags and the market code list', () => {
  const callerEcho = require('../../src/findProductsMulti/callerEcho');

  test('(a) withoutCallerSearchRequestContract drops public_search_route and invoke_search_rail unless the metadata is the gateway\'s own', () => {
    for (const forged of [
      { public_search_route: true },
      { public_search_route: 'true' },
      { invoke_search_rail: 'public_observability' },
      { invoke_search_rail: 'authoritative_shopping' },
    ]) {
      const metadata = { source: 'shopping_agent', ...forged };
      expect([JSON.stringify(forged), callerEcho.withoutCallerSearchRequestContract(metadata)]).toEqual([
        JSON.stringify(forged), { source: 'shopping_agent' },
      ]);
      // the caller's object is not changed in place
      expect(metadata).toEqual({ source: 'shopping_agent', ...forged });
      // a contract the gateway built does not vouch for routing flags beside it
      const contract = { primary_lane: 'beauty_discovery_mainline' };
      expect(callerEcho.withoutCallerSearchRequestContract({ ...metadata, search_request_contract: contract }, { gatewayContract: contract }))
        .toEqual({ source: 'shopping_agent', search_request_contract: contract });
    }
    // the in-process hand-off: the very object the GET route built comes through untouched
    const gatewayMetadata = { source: 'aurora-bff', public_search_route: true };
    expect(callerEcho.withoutCallerSearchRequestContract(gatewayMetadata, { gatewayMetadata })).toBe(gatewayMetadata);
    // an equal copy is not that object
    expect(callerEcho.withoutCallerSearchRequestContract({ ...gatewayMetadata }, { gatewayMetadata })).toEqual({ source: 'aurora-bff' });
    // nothing to drop: the input itself
    const clean = { source: 'shopping_agent', market: 'US' };
    expect(callerEcho.withoutCallerSearchRequestContract(clean)).toBe(clean);
  });

  test('(c) withoutHostileCallerEcho clears the source forms of the CHOSEN source only', () => {
    const body = (source, understanding = source) => ({
      metadata: {
        search_request_contract: { source },
        guard_source_normalized: source,
        query_understanding: { source: understanding },
      },
      beauty_expert_v1: { delegation_trace: { source_profile: source } },
    });
    const sent = (...values) => new Map([['source', values]]);
    // F1: the gateway's default, a rejected caller string of the same form, nothing chosen
    const f1 = body('shopping-agent-ui');
    expect(callerEcho.withoutHostileCallerEcho(f1, sent('shopping agent ui'), { chosenSource: undefined })).toBe(f1);
    // F2 / F3: a clean chosen source, a rejected one of the same form sent elsewhere
    const f2 = body('agent-api');
    expect(callerEcho.withoutHostileCallerEcho(f2, sent('agent-api', 'Agent API'), { chosenSource: 'agent-api' })).toBe(f2);
    const f3 = body('search');
    expect(callerEcho.withoutHostileCallerEcho(f3, sent('search', 'search '), { chosenSource: 'search' })).toBe(f3);
    // the chosen source failed its rule: every form of it is cleared
    expect(
      callerEcho.withoutHostileCallerEcho(body('agent-api', 'Agent API'), sent('Agent API'), { chosenSource: 'Agent API' }),
    ).toEqual({
      metadata: { search_request_contract: { source: null }, guard_source_normalized: null, query_understanding: {} },
      beauty_expert_v1: { delegation_trace: { source_profile: null } },
    });
  });

  test('(c) callerChosenSource is normalizeMetadata\'s choice: the metadata\'s source, else the payload\'s', () => {
    expect(callerEcho.callerChosenSource({ source: 'a' }, { source: 'b', search: { source: 'c' } })).toBe('a');
    expect(callerEcho.callerChosenSource({}, { source: 'b', search: { source: 'c' } })).toBe('b');
    expect(callerEcho.callerChosenSource({ source: '' }, { source: 'b' })).toBe('b');
    expect(callerEcho.callerChosenSource(undefined, { search: { source: 'c' } })).toBe(undefined);
    expect(callerEcho.callerChosenSource(null, {})).toBe(undefined);
    expect(callerEcho.callerChosenSource({ source: ['x'] }, {})).toEqual(['x']);
  });

  test('(d) the market code list is the 249 officially assigned codes, fixed', () => {
    const { ISO_3166_1_ALPHA_2_CODES, isIso3166Alpha2 } = require('../../src/findProductsMulti/iso3166Alpha2');
    expect(ISO_3166_1_ALPHA_2_CODES).toHaveLength(249);
    expect(new Set(ISO_3166_1_ALPHA_2_CODES).size).toBe(249);
    expect(Object.isFrozen(ISO_3166_1_ALPHA_2_CODES)).toBe(true);
    expect(ISO_3166_1_ALPHA_2_CODES.every((code) => /^[A-Z]{2}$/.test(code))).toBe(true);
    // user-assigned and reserved codes are not on it
    for (const code of ['AA', 'QM', 'QZ', 'XA', 'XK', 'XX', 'XZ', 'ZZ', 'EU', 'UK', 'EZ', 'UN']) {
      expect([code, isIso3166Alpha2(code)]).toEqual([code, false]);
    }
    for (const value of ['de', 'De', ' DE', 'DEU', 'USA', null, undefined, ['DE'], { DE: 1 }, 'toString', '__proto__']) {
      expect([JSON.stringify(value), isIso3166Alpha2(value)]).toEqual([JSON.stringify(value), false]);
    }
    for (const code of ['DE', 'NZ', 'CN', 'US', 'GB', 'SG', 'AX', 'BQ', 'SS', 'SX', 'CW']) {
      expect([code, isIso3166Alpha2(code)]).toEqual([code, true]);
    }
    for (const market of ['DE', 'NZ', 'CN', 'EU', 'US']) {
      expect([market, callerEcho.isEchoableCallerValue('market', market)]).toEqual([market, true]);
    }
    for (const market of ['XX', 'ZZ', 'USA', 'us', '<b>US</b>', 'eu']) {
      expect([market, callerEcho.isEchoableCallerValue('market', market)]).toEqual([market, false]);
    }
  });
});
