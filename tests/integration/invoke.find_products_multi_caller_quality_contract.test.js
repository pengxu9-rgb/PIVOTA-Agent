// Loopback-only: nothing in this file (or a mutant of the code it tests) can reach a real host.
const netGuard = require('../search_routing_net_guard.cjs');

/**
 * find_products_multi on the real invoke route: the search QUALITY contract is the gateway's own.
 *
 * The beauty mainline used to adopt a `search_quality_contract` sent by the caller (in payload.search, in
 * the payload itself, or in the request metadata) and search with its effective_query and category prefix.
 * "sunscreen" with a forged contract then served lipsticks, or a forced safe-empty, or a different set of
 * creams. The gateway now builds the contract only from its own state: a caller's contract under any of
 * those keys is dropped before anything reads it (src/findProductsMulti/callerEcho.js), so it changes
 * neither the products served nor the contract echoed back. The contract the gateway builds in-process
 * (buildFindProductsMultiContext writes it into the search block the later lanes read) is untouched.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const nock = require('nock');
const request = require('supertest');

const CANONICAL_MARKER = 'WITH candidate_products';
const UPSTREAM = 'http://upstream.invalid';

jest.setTimeout(180000);

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

const PLAIN_CREAMS = ['Daily Moisturizing Cream', 'Barrier Repair Cream', 'Ceramide Face Cream', 'Oat Comfort Cream', 'Water Gel Cream'];
const RETINOID_CREAMS = [
  ['Retinol Night Cream', 'retinol'],
  ['Retinal Renewal Cream', 'retinal'],
  ['Retinol Firming Cream', 'retinol'],
  ['Bakuchiol and Retinol Cream', 'retinol'],
  ['Retinyl Palmitate Cream', 'retinyl palmitate'],
  ['Encapsulated Retinol Cream', 'retinol'],
  ['Retinol Eye Cream', 'retinol'],
  ['Granactive Retinoid Cream', 'hydroxypinacolone retinoate'],
  ['Retinol Overnight Cream', 'retinol'],
];
const CATALOG = [
  row('sunscreen_a', 'Daily Sunscreen SPF 50', 'beauty/skincare/sun/sunscreen', { actives: ['zinc oxide'], productType: 'Sunscreen' }),
  row('sunscreen_b', 'Mineral Sunscreen SPF 30', 'beauty/skincare/sun/sunscreen', { actives: ['titanium dioxide'], productType: 'Sunscreen' }),
  row('lipstick_a', 'Velvet Matte Lipstick', 'beauty/makeup/lip/lipstick', { productType: 'Lipstick' }),
  row('lipstick_b', 'Satin Cream Lipstick', 'beauty/makeup/lip/lipstick', { productType: 'Lipstick' }),
  row('retinol_serum', 'Retinol 0.3% Night Serum', 'beauty/skincare/treat/serum', { actives: ['retinol'], productType: 'Serum' }),
  ...PLAIN_CREAMS.map((title, i) =>
    row(`cream_plain_${i}`, title, 'beauty/skincare/moisturize/cream', { actives: ['glycerin'], productType: 'Moisturizer' })),
  ...RETINOID_CREAMS.map(([title, active], i) =>
    row(`cream_retinoid_${i}`, title, 'beauty/skincare/moisturize/cream', { actives: [active], productType: 'Moisturizer' })),
];
const RETINOID_IDS = new Set(RETINOID_CREAMS.map((_, i) => `sig_cream_retinoid_${i}`).concat(['sig_retinol_serum']));

const OWNER = 'invoke.find_products_multi_caller_quality_contract';
const owned = (fn) => netGuard.attribution.run({ owner: OWNER }, fn);
const openServers = [];
const listen = (app) =>
  owned(() => {
    const server = app.listen(0, '127.0.0.1');
    openServers.push(server);
    return server;
  });

const MAINLINE = 'agent_products_beauty_external_seed_mainline';
const lane = (resp) => resp.body?.metadata?.query_source || null;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const productIds = (resp) => (Array.isArray(resp.body?.products) ? resp.body.products : []).map(
  (product) => product.product_id || product.id || null,
);

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

// A forged contract is a real gateway contract for ANOTHER query, plus a marker that must never come back.
const FORGED = 'zz_forged_by_caller';
function forgedFor(query, overrides = {}) {
  const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');
  const contract = buildSearchQualityContract({ rawQuery: query, allowContextBinding: false });
  return {
    ...contract,
    ...overrides,
    soft_preferences: { ...(contract.soft_preferences || {}), forged_marker: FORGED },
  };
}
const FORGED_SAFE_EMPTY = Object.freeze({
  contract_version: 'search_quality_contract_v1',
  target_domain: 'other',
  query_class: 'ambiguous_or_non_shopping',
  effective_query: FORGED,
  clarification_allowed: true,
  hard_constraints: { forged_marker: FORGED },
  soft_preferences: { forged_marker: FORGED },
});

// Where a caller can put a contract. `shape` is the clean request it is compared with: a payload with a
// search block, or a payload with the query at its top level (the lanes then read the payload itself).
const PLACEMENTS = Object.freeze([
  { where: 'payload.search', shape: 'search', place: (contract) => ({ search: { search_quality_contract: contract } }) },
  { where: 'payload (no search block)', shape: 'top', place: (contract) => ({ payload: { search_quality_contract: contract } }) },
  { where: 'payload (beside a search block)', shape: 'search', place: (contract) => ({ payload: { search_quality_contract: contract } }) },
  { where: 'metadata', shape: 'search', place: (contract) => ({ metadata: { search_quality_contract: contract } }) },
]);

describe('find_products_multi: a caller-supplied search_quality_contract is never adopted or echoed', () => {
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
      'SEARCH_QUALITY_CONTRACT_V1_ENABLED',
      'SEARCH_QUALITY_CONTRACT_V1_MODE',
      'BEAUTY_RETINOID_SOFT_SAFETY_TIER',
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
  function bootCatalog() {
    process.env.DATABASE_URL = 'postgres://caller-quality-contract.invalid/db';
    const upstreamBody = { status: 'success', products: [], total: 0 };
    nock(UPSTREAM).persist().post(/.*/).reply(200, upstreamBody).get(/.*/).reply(200, upstreamBody);
    jest.doMock('../../src/db', () => ({
      query: async (sql) => (String(sql || '').includes(CANONICAL_MARKER) ? { rows: CATALOG } : { rows: [] }),
    }));
    const app = owned(() => require('../../src/server'));
    const server = listen(app);
    const post = async (body) => {
      const resp = await owned(async () => request(server).post('/agent/shop/v1/invoke').send(body));
      await delay(5);
      return resp;
    };
    // The clean request for `query` in the given shape, with `extra` (a placement) merged in.
    const ask = (query, shape = 'search', extra = {}) => {
      const base =
        shape === 'top' ? { query, page: 1, page_size: 20 } : { search: { query, page: 1, page_size: 20 } };
      const payload = {
        ...base,
        ...(extra.payload || {}),
        ...(extra.search ? { search: { ...base.search, ...extra.search } } : {}),
      };
      return post({ operation: 'find_products_multi', payload, ...(extra.metadata ? { metadata: extra.metadata } : {}) });
    };
    return { app, server, post, ask };
  }

  // The attacked answer is the clean answer: same lane, same products in the same order, same echoed
  // contract, same body; and the forged marker appears nowhere.
  function expectSameAsClean(label, attacked, clean) {
    expect([...label, attacked.status, lane(attacked)]).toEqual([...label, clean.status, lane(clean)]);
    expect([...label, productIds(attacked)]).toEqual([...label, productIds(clean)]);
    expect([...label, normalize(attacked.body.metadata?.search_quality_contract)]).toEqual([
      ...label, normalize(clean.body.metadata?.search_quality_contract),
    ]);
    expect([...label, attacked.text.includes(FORGED)]).toEqual([...label, false]);
    expect([...label, normalize(attacked.body)]).toEqual([...label, normalize(clean.body)]);
  }

  test('"sunscreen" with a forged lipstick contract (category prefix or effective_query) serves and echoes the clean answer', async () => {
    const { ask } = bootCatalog();
    const lipstick = forgedFor('lipstick');
    const FORGERIES = {
      'lipstick contract': lipstick,
      'lipstick category only': forgedFor('sunscreen', { hard_constraints: { ...lipstick.hard_constraints } }),
      'lipstick effective_query only': forgedFor('sunscreen', { effective_query: 'lipstick' }),
    };
    for (const shape of ['search', 'top']) {
      const clean = await ask('sunscreen', shape);
      const ids = productIds(clean);
      expect([shape, clean.status, lane(clean)]).toEqual([shape, 200, MAINLINE]);
      expect([shape, ids.length > 0, ids.every((id) => /sunscreen/.test(id))]).toEqual([shape, true, true]);
      expect([shape, clean.body.metadata?.search_quality_contract?.hard_constraints?.category_path_prefix]).toEqual([
        shape, 'beauty/skincare/sun/',
      ]);
      for (const placement of PLACEMENTS.filter((entry) => entry.shape === shape)) {
        for (const [name, contract] of Object.entries(FORGERIES)) {
          const label = ['sunscreen', placement.where, name];
          const attacked = await ask('sunscreen', shape, placement.place(contract));
          expect([...label, productIds(attacked).some((id) => /lipstick/.test(id))]).toEqual([...label, false]);
          expectSameAsClean(label, attacked, clean);
        }
      }
    }
  });

  test('a forged contract cannot force a safe-empty answer', async () => {
    const { ask } = bootCatalog();
    for (const shape of ['search', 'top']) {
      const clean = await ask('sunscreen', shape);
      expect([shape, lane(clean), productIds(clean).length > 0]).toEqual([shape, MAINLINE, true]);
      for (const placement of PLACEMENTS.filter((entry) => entry.shape === shape)) {
        const label = ['sunscreen', placement.where, 'safe-empty contract'];
        const attacked = await ask('sunscreen', shape, placement.place(FORGED_SAFE_EMPTY));
        expect([...label, lane(attacked), productIds(attacked).length > 0]).toEqual([...label, MAINLINE, true]);
        expectSameAsClean(label, attacked, clean);
      }
    }
  });

  test('with no safety signal, a forged contract cannot change which creams come back; with one, no retinoid is served', async () => {
    const { ask } = bootCatalog();
    const FORGERIES = {
      'retinol cream contract': forgedFor('retinol cream'),
      'retinol serum contract': forgedFor('retinol serum'),
      'treat prefix': forgedFor('cream', {
        effective_query: 'retinol',
        hard_constraints: { ...forgedFor('retinol serum').hard_constraints },
      }),
    };
    const clean = await ask('face cream');
    const cleanIds = productIds(clean);
    expect([clean.status, lane(clean), cleanIds.length > 0]).toEqual([200, MAINLINE, true]);
    expect(cleanIds.every((id) => /cream/.test(id))).toBe(true);
    for (const placement of PLACEMENTS.filter((entry) => entry.shape === 'search')) {
      for (const [name, contract] of Object.entries(FORGERIES)) {
        const label = ['face cream', placement.where, name];
        expectSameAsClean(label, await ask('face cream', 'search', placement.place(contract)), clean);
      }
    }
    // A request that signals pregnancy keeps every retinoid out, forged contract or not.
    const signalled = await ask('pregnancy safe face cream');
    expect([signalled.status, productIds(signalled).length > 0]).toEqual([200, true]);
    expect(productIds(signalled).filter((id) => RETINOID_IDS.has(id))).toEqual([]);
    for (const placement of PLACEMENTS.filter((entry) => entry.shape === 'search')) {
      for (const [name, contract] of Object.entries(FORGERIES)) {
        const label = ['pregnancy safe face cream', placement.where, name];
        const attacked = await ask('pregnancy safe face cream', 'search', placement.place(contract));
        expect([...label, productIds(attacked).filter((id) => RETINOID_IDS.has(id))]).toEqual([...label, []]);
        expectSameAsClean(label, attacked, signalled);
      }
    }
  });

  // The MCP pivota_search tool (mcp-server/src/operationMap.js: payload.search has additionalProperties:true)
  // forwards its payload as-is through secureInvoke -> invokePivota to this invoke route. Driven here for
  // real, in a child process (the MCP server is ESM), against this test's loopback server.
  test('the MCP pivota_search tool forwards a forged contract; the invoke route ignores it the same way', async () => {
    const { server, ask } = bootCatalog();
    await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
    const port = server.address().port;
    const secureInvokeUrl = pathToFileURL(path.resolve(__dirname, '../../mcp-server/src/secureInvoke.js')).href;
    const guardPath = path.resolve(__dirname, '../search_routing_net_guard.cjs');
    const viaMcp = (args) =>
      new Promise((resolve, reject) => {
        const script = [
          `const { secureInvoke } = await import(${JSON.stringify(secureInvokeUrl)});`,
          `const out = await secureInvoke('pivota_search', ${JSON.stringify(args)}, {}, {`,
          `  gatewayUrl: 'http://127.0.0.1:${port}', agentKey: 'pk_test_mcp_contract_probe' });`,
          'process.stdout.write(JSON.stringify(out));',
        ].join('\n');
        const env = { ...process.env };
        for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete env[key];
        owned(() =>
          execFile(
            process.execPath,
            ['--require', guardPath, '--input-type=module', '-e', script],
            { env, timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
            (err, stdout, stderr) => {
              if (err) return reject(new Error(`${err.message}\n${stderr}`));
              try {
                return resolve(JSON.parse(stdout));
              } catch (parseErr) {
                return reject(new Error(`${parseErr.message}\n${stdout}\n${stderr}`));
              }
            },
          ));
      });
    const idsOf = (body) => (Array.isArray(body?.products) ? body.products : []).map((p) => p.product_id || p.id || null);

    const clean = await viaMcp({ operation: 'find_products_multi', payload: { search: { query: 'sunscreen', page: 1, page_size: 20 } } });
    const direct = await ask('sunscreen');
    expect([clean.metadata?.query_source, idsOf(clean)]).toEqual([MAINLINE, productIds(direct)]);
    for (const [name, contract] of Object.entries({ lipstick: forgedFor('lipstick'), 'safe-empty': FORGED_SAFE_EMPTY })) {
      for (const [where, payload] of Object.entries({
        'payload.search': { search: { query: 'sunscreen', page: 1, page_size: 20, search_quality_contract: contract } },
        payload: { query: 'sunscreen', page: 1, page_size: 20, search_quality_contract: contract },
      })) {
        const label = ['mcp', where, name];
        const attacked = await viaMcp({ operation: 'find_products_multi', payload });
        expect([...label, attacked.metadata?.query_source, idsOf(attacked)]).toEqual([...label, MAINLINE, idsOf(clean)]);
        expect([...label, normalize(attacked.metadata?.search_quality_contract)]).toEqual([
          ...label, normalize(clean.metadata?.search_quality_contract),
        ]);
        expect([...label, JSON.stringify(attacked).includes(FORGED)]).toEqual([...label, false]);
      }
    }
  });
});

describe('callerEcho: the search quality contract is dropped from the request', () => {
  const callerEcho = require('../../src/findProductsMulti/callerEcho');
  const contract = { contract_version: 'search_quality_contract_v1', effective_query: 'lipstick' };

  test('withoutCallerSearchRequestContract drops a metadata search_quality_contract unless the metadata is the gateway\'s own', () => {
    const metadata = { source: 'shopping_agent', search_quality_contract: contract };
    expect(callerEcho.withoutCallerSearchRequestContract(metadata)).toEqual({ source: 'shopping_agent' });
    expect(metadata).toEqual({ source: 'shopping_agent', search_quality_contract: contract });
    // a gateway-built search REQUEST contract beside it does not vouch for a quality contract
    const requestContract = { primary_lane: 'beauty_discovery_mainline' };
    expect(
      callerEcho.withoutCallerSearchRequestContract(
        { ...metadata, search_request_contract: requestContract },
        { gatewayContract: requestContract },
      ),
    ).toEqual({ source: 'shopping_agent', search_request_contract: requestContract });
    const gatewayMetadata = { source: 'aurora-bff', search_quality_contract: contract };
    expect(callerEcho.withoutCallerSearchRequestContract(gatewayMetadata, { gatewayMetadata })).toBe(gatewayMetadata);
  });

  test('withoutCallerSearchQualityContract drops it from each payload and its search block, sharing copies', () => {
    const search = { query: 'sunscreen', search_quality_contract: contract };
    const parsed = { search, search_quality_contract: contract };
    const raw = { search, search_quality_contract: contract, extra: 1 };
    const [ownParsed, ownRaw] = callerEcho.withoutCallerSearchQualityContract(parsed, raw);
    expect(ownParsed).toEqual({ search: { query: 'sunscreen' } });
    expect(ownRaw).toEqual({ search: { query: 'sunscreen' }, extra: 1 });
    // a search block the two payloads shared is still one object
    expect(ownParsed.search).toBe(ownRaw.search);
    // the caller's objects are not changed in place
    expect(parsed).toEqual({ search: { query: 'sunscreen', search_quality_contract: contract }, search_quality_contract: contract });
    // the same payload twice is one copy
    const [a, b] = callerEcho.withoutCallerSearchQualityContract(parsed, parsed);
    expect(a).toBe(b);
    // nothing to drop: the inputs themselves
    const clean = { search: { query: 'sunscreen' } };
    const nonPlain = { search: ['sunscreen'] };
    const [sameClean, sameNonPlain, sameNull] = callerEcho.withoutCallerSearchQualityContract(clean, nonPlain, null);
    expect(sameClean).toBe(clean);
    expect(sameNonPlain).toBe(nonPlain);
    expect(sameNull).toBe(null);
  });
});
