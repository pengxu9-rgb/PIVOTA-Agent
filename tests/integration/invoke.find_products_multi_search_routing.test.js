// Loopback-only: nothing in this file (or a mutant of the code it tests) can reach a real host.
const netGuard = require('../search_routing_net_guard.cjs');

/**
 * find_products_multi routing for bare ingredients and non-English beauty terms, on the real invoke
 * route with a mocked database (a fixed fixture catalog answers every canonical-catalog statement, so
 * which rows come back is decided by the lanes' own gates, not by SQL text matching).
 *
 * Flags (each off | observe | on, default off; see src/findProductsMulti/queryRoutingNormalizer.js):
 *   FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING  a query that is only a known ingredient reaches the
 *     ingredient lane; negated / stand-in mentions are not intents but exclusions; the lane admits only
 *     rows that NAME the ingredient; a bare negation is a safe-empty clarify.
 *   FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING  known non-English beauty terms route like their English
 *     equivalents; English queries are never changed.
 *
 * Also pinned (flags or no flags): the ingredient lane resolves its market exactly as the mainline does.
 */

const nock = require('nock');
const request = require('supertest');

const CANONICAL_MARKER = 'WITH candidate_products';

// Several tests replay a query set through two boots of the route.
jest.setTimeout(60000);

function row(key, title, categoryPath, { actives = [], productType = 'Skincare', description = null, inci = null } = {}) {
  return {
    merchant_id: 'external_seed',
    product_key: `prod::external_seed::external_seed::ext_${key}`,
    platform: 'external_seed',
    source_product_id: `ext_${key}`,
    pivota_signature_id: `sig_${key}`,
    pivota_canonical_url: `https://agent.pivota.cc/products/sig_${key}`,
    product_title: title,
    product_description: description || `${title}. A test product.`,
    brand: 'Test Brand',
    product_type: productType,
    category: productType,
    category_path: categoryPath,
    canonical_url: `https://brand.example/products/${key}`,
    product_image_url: `https://cdn.example.com/${key}.jpg`,
    catalog_track: 'external_referral',
    truth_tier: 'observed',
    readiness_tier: 'referral_only',
    pdp_scope: 'unverified',
    merchant_effective_price: '24.00',
    currency: 'USD',
    product_payload: {
      seed_data: {
        price_amount: '24.00',
        price_currency: 'USD',
        availability: 'in stock',
        active_ingredients: actives,
        ...(inci ? { ingredients_inci: inci } : {}),
      },
    },
    rank_score: 90,
  };
}

const SERUM = 'beauty/skincare/treat/serum';
const CREAM = 'beauty/skincare/moisturize/cream';
const CATALOG = [
  row('retinol_serum', 'Retinol 0.3% Night Serum', SERUM, { actives: ['retinol'], productType: 'Serum' }),
  row('retinol_cream', 'Retinol Renewal Night Cream', CREAM, { actives: ['retinol'], productType: 'Moisturizer' }),
  // Rows whose titles say "retinol" but are not retinol (the reviewed fooled-title shapes).
  row('retinol_free_moist', 'Retinol-Free Barrier Moisturizer', CREAM, { actives: ['ceramide'], productType: 'Moisturizer' }),
  row('retinol_free_serum', 'Retinol-Free Gentle Night Serum', SERUM, { actives: ['peptides'], productType: 'Serum' }),
  row('bakuchiol', 'Bakuchiol Retinol Alternative Serum', SERUM, { actives: ['bakuchiol'], productType: 'Serum' }),
  row('phyto', 'Phyto-Retinol Bakuchiol Serum', SERUM, { actives: ['bakuchiol'], productType: 'Serum' }),
  row('retlike', 'Retinol-Like Bakuchiol Night Serum', SERUM, { actives: ['bakuchiol'], productType: 'Serum' }),
  row('zero_ret', '0% Retinol Gentle Night Cream', CREAM, { actives: ['squalane'], productType: 'Moisturizer' }),
  row('noadded', 'No Added Retinol Barrier Cream', CREAM, { actives: ['ceramide'], productType: 'Moisturizer' }),
  row('better', 'Better Than Retinol Serum', SERUM, { actives: ['bakuchiol'], productType: 'Serum' }),
  row('desc_only', 'Gentle Night Serum', SERUM, { actives: ['squalane'], productType: 'Serum', description: 'Free of retinol. Pairs well with retinol.' }),
  row('ha_serum', 'Hyaluronic Acid 2% Hydrating Serum', SERUM, { actives: ['hyaluronic acid'], productType: 'Serum' }),
  row('niacinamide_serum', 'Niacinamide 10% Serum', SERUM, { actives: ['niacinamide'], productType: 'Serum' }),
  row('vit_c', 'Vitamin C 15% Serum', SERUM, { actives: ['ascorbic acid'], productType: 'Serum' }),
  row('vitce', 'Vitamin C+E Ferulic Serum', SERUM, { actives: ['ascorbic acid', 'tocopherol'], productType: 'Serum' }),
  row('vit_e', 'Vitamin E Serum', SERUM, { actives: ['tocopherol'], productType: 'Serum' }),
  row('plain_serum', 'Daily Hydrating Serum', SERUM, { actives: ['glycerin'], productType: 'Serum' }),
  row('plain_moist', 'Daily Moisturizing Cream', CREAM, { actives: ['glycerin'], productType: 'Moisturizer' }),
  row('sunscreen', 'Daily Sunscreen SPF 50', 'beauty/skincare/sun/sunscreen', { actives: ['zinc oxide'], productType: 'Sunscreen' }),
  row('cleanser', 'Gentle Foaming Face Cleanser', 'beauty/skincare/cleanse/cleanser', { actives: ['glycerin'], productType: 'Cleanser' }),
  row('lipstick', 'Velvet Matte Lipstick', 'beauty/makeup/lip/lipstick', { productType: 'Lipstick' }),
  row('shampoo', 'Repair Shampoo', 'beauty/haircare/shampoo', { productType: 'Shampoo' }),
  // Rows that DO contain the ingredient under a positive marketing word, or in another script.
  row('vegan_retinol', 'Vegan Retinol Night Cream', CREAM, { actives: ['retinol'], productType: 'Moisturizer' }),
  row('pro_retinol', 'Revive Pro-Retinol Night Cream', CREAM, { actives: ['retinol'], productType: 'Moisturizer' }),
  row('vegan_niacinamide', 'Vegan Niacinamide 10% + Zinc Serum', SERUM, { actives: ['niacinamide', 'zinc pca'], productType: 'Serum' }),
  row('natural_vit_c', 'Natural Vitamin C Brightening Serum', SERUM, { actives: ['ascorbic acid'], productType: 'Serum' }),
  row('ko_retinol', '레티놀 세럼', SERUM, { productType: 'Serum' }),
  row('ru_retinol', 'Ретинол сыворотка', SERUM, { productType: 'Serum' }),
  // r4 review shapes
  row('decimal_retinol', '1.0% Retinol Night Serum', SERUM, { actives: ['retinol'], productType: 'Serum' }),
  row('decimal_niacinamide', '10.0% Niacinamide Booster', SERUM, { actives: ['niacinamide'], productType: 'Serum' }),
  row('decimal_bha', '2.0% Salicylic Acid Cleanser', 'beauty/skincare/cleanse/cleanser', { actives: ['salicylic acid'], productType: 'Cleanser' }),
  row('free_radical', 'Vitamin C Free Radical Defense Serum', SERUM, { actives: ['ascorbic acid'], productType: 'Serum' }),
  row('ko_premium', '레티놀 프리미엄 세럼', SERUM, { productType: 'Serum' }),
  row('ru_cream', 'Крем с ретинолом', CREAM, { productType: 'Moisturizer' }),
  row('faux', 'Faux Retinol Night Oil', SERUM, { actives: ['squalane'], productType: 'Serum' }),
  row('pseudo', 'Pseudo-Retinol Serum', SERUM, { actives: ['bakuchiol'], productType: 'Serum' }),
  row('bio_inci', 'Bio-Retinol Bakuchiol Serum', SERUM, { productType: 'Serum', inci: ['Aqua', 'Bakuchiol', 'Squalane'] }),
];
const REAL_RETINOL = ['Retinol 0.3% Night Serum', 'Retinol Renewal Night Cream', 'Vegan Retinol Night Cream',
  'Revive Pro-Retinol Night Cream', '레티놀 세럼', 'Ретинол сыворотка', '1.0% Retinol Night Serum', '레티놀 프리미엄 세럼',
  'Крем с ретинолом'];
const REAL_NIACINAMIDE = ['Niacinamide 10% Serum', 'Vegan Niacinamide 10% + Zinc Serum', '10.0% Niacinamide Booster'];
const REAL_VITAMIN_C = ['Vitamin C 15% Serum', 'Vitamin C+E Ferulic Serum', 'Natural Vitamin C Brightening Serum',
  'Vitamin C Free Radical Defense Serum'];
const SKINCARE_PATH = /^beauty\/skincare(\/|$)/;

const OWNER = 'invoke.find_products_multi_search_routing';
const owned = (fn) => netGuard.attribution.run({ owner: OWNER }, fn);
// One listening server per boot (instead of one per request): the app's own request handling then runs
// in the attribution context the server was created in, and no request races a server teardown.
const openServers = [];
const listen = (app) =>
  owned(() => {
    const server = app.listen(0, '127.0.0.1');
    openServers.push(server);
    return server;
  });

const LANES = {
  INGREDIENT: 'agent_products_ingredient_recall_direct',
  MAINLINE: 'agent_products_beauty_external_seed_mainline',
  SAFE_EMPTY: 'search_quality_contract_v1_safe_empty',
  BACKEND: 'agent_products_search',
};

const FLAG_KEYS = ['FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING', 'FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING'];
const BOTH_ON = { FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on', FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'on' };
const BOTH_OBSERVE = {
  FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'observe',
  FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'observe',
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Drops fields that differ between two runs of the same request (timings, ids, process start stamps).
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (/fetched_at|generated_at|started_at|build_id|timestamp|trace_id|request_id|latency|duration|_ms$|elapsed/i.test(key)) continue;
    out[key] = normalize(inner);
  }
  return out;
}

const titles = (resp) => (Array.isArray(resp.body.products) ? resp.body.products.map((p) => p.title) : []);
const ids = (resp) => (Array.isArray(resp.body.products) ? resp.body.products.map((p) => p.product_id).sort() : []);
const lane = (resp) => resp.body?.metadata?.query_source || null;

describe('find_products_multi search routing: bare ingredients and non-English beauty terms', () => {
  let prevEnv;

  // The guard REFUSES every non-loopback connection whatever happens. This file asserts that nothing IT
  // drives tried to leave, to any host: the app boot and every request run inside the guard's
  // attribution context (OWNER), so every refusal the routing code causes -- a connect, a DNS lookup, now
  // or in a later callback -- carries OWNER. Another suite's late async work in a shared Jest worker runs
  // in no such context and is not this file's. No host filter.
  afterAll(() => {
    expect(netGuard.state.blocked.filter((entry) => entry.owner === OWNER)).toEqual([]);
  });

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => String(host || '').includes('127.0.0.1'));
    prevEnv = { ...process.env };
    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://search-routing-test';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    process.env.GATEWAY_RATE_LIMIT_ENABLED = 'false';
    delete process.env.INDEX_ELIGIBLE_RECALL;
    delete process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET;
    delete process.env.FIND_PRODUCTS_BUYER_MARKET;
    for (const key of FLAG_KEYS) delete process.env[key];
    // The backend text lane answers empty; it is only ever the lane a misrouted query falls to.
    nock('http://pivota.test')
      .persist()
      .post(/.*/)
      .reply(200, { status: 'success', products: [], total: 0 })
      .get(/.*/)
      .reply(200, { status: 'success', products: [], total: 0 });
  });

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve()))));
    process.env = prevEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  function boot(env = {}) {
    Object.assign(process.env, env);
    const statements = [];
    jest.doMock('../../src/db', () => ({
      query: async (sql, params) => {
        statements.push({ sql: String(sql || ''), params: Array.isArray(params) ? params : [] });
        return String(sql || '').includes(CANONICAL_MARKER) ? { rows: CATALOG } : { rows: [] };
      },
    }));
    const logger = require('../../src/logger');
    const completionLines = [];
    const originalInfo = logger.info.bind(logger);
    logger.info = (obj, msg, ...rest) => {
      if (msg === 'invoke request complete') completionLines.push(obj);
      return originalInfo(obj, msg, ...rest);
    };
    const app = listen(owned(() => require('../../src/server')));
    const send = async (payload) => {
      statements.length = 0;
      const resp = await owned(async () => request(app).post('/agent/shop/v1/invoke').send({ operation: 'find_products_multi', payload }));
      await delay(10);
      return { resp, log: completionLines[completionLines.length - 1] || {}, sql: statements.slice() };
    };
    const invoke = (query, extra = {}) => send({ search: { query, page: 1, page_size: 20, ...extra } });
    return { invoke, send, app };
  }

  test('off: the measured misroutes', async () => {
    const { invoke } = boot();
    const expected = {
      retinol: LANES.SAFE_EMPTY,
      'vitamin c': LANES.SAFE_EMPTY,
      'hyaluronic acid': LANES.BACKEND,
      선크림: LANES.BACKEND,
      '자외선 차단제': LANES.BACKEND,
      'crème hydratante': LANES.SAFE_EMPTY,
      hydratant: LANES.SAFE_EMPTY,
      洗面奶: LANES.SAFE_EMPTY,
    };
    for (const [query, expectedLane] of Object.entries(expected)) {
      const { resp, log } = await invoke(query);
      expect(resp.status).toBe(200);
      expect([query, lane(resp)]).toEqual([query, expectedLane]);
      expect(log.fpm_routing_multilingual_mode).toBeUndefined();
    }
    // Flags off: no routing field and no would_* field on any completion line, whatever the query
    // (the exclusion, the admission and the bare-negation checks are not even computed).
    for (const query of ['niacinamide-free serum', 'retinol serum', 'retinol-free', 'retinol alternative', '선크림', 'laptop']) {
      const { log } = await invoke(query);
      expect([query, Object.keys(log).filter((key) => /^fpm_routing_|^fpm_excluded_|would_|admission|excluded_ingredient/.test(key))]).toEqual([query, []]);
    }
  });

  test('off: the ingredient lane admits rows that do not name the ingredient (the gap the flag closes)', async () => {
    const { invoke } = boot();
    const { resp } = await invoke('retinol serum');
    expect(lane(resp)).toBe(LANES.INGREDIENT);
    expect(titles(resp)).toEqual(expect.arrayContaining([
      'Retinol-Free Gentle Night Serum', 'Bakuchiol Retinol Alternative Serum', 'Phyto-Retinol Bakuchiol Serum',
    ]));
  });

  const PARITY_QUERIES = ['retinol', 'retinol serum', '선크림', 'crème hydratante', 'moisturizer without retinol',
    'retinol-free', 'without retinol', 'niacinamide-free serum', 'laptop', '레티놀 크림'];

  test('unset flags and explicit off answer byte-identically (volatile fields aside)', async () => {
    const unset = boot();
    const a = [];
    for (const query of PARITY_QUERIES) a.push((await unset.invoke(query)).resp.body);
    jest.resetModules();
    const off = boot({ FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'off', FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'off' });
    for (let i = 0; i < PARITY_QUERIES.length; i += 1) {
      expect(normalize((await off.invoke(PARITY_QUERIES[i])).resp.body)).toEqual(normalize(a[i]));
    }
  });

  test('observe: responses are byte-identical to off; the completion line says what on would do', async () => {
    const off = boot();
    const a = [];
    const offLogs = [];
    for (const query of PARITY_QUERIES) {
      const result = await off.invoke(query);
      a.push(result.resp.body);
      offLogs.push(result.log);
    }
    jest.resetModules();
    const observe = boot(BOTH_OBSERVE);
    const logs = {};
    const ROUTING_FIELD = /^fpm_routing_|^fpm_excluded_|would_/;
    const stable = (log) =>
      normalize(Object.fromEntries(Object.entries(log).filter(([key]) => !ROUTING_FIELD.test(key) && key !== 'fpm_stage_breakdown')));
    for (let i = 0; i < PARITY_QUERIES.length; i += 1) {
      const { resp, log } = await observe.invoke(PARITY_QUERIES[i]);
      expect([PARITY_QUERIES[i], normalize(resp.body)]).toEqual([PARITY_QUERIES[i], normalize(a[i])]);
      // The completion line is the same too, apart from the routing namespace.
      expect([PARITY_QUERIES[i], stable(log)]).toEqual([PARITY_QUERIES[i], stable(offLogs[i])]);
      logs[PARITY_QUERIES[i]] = log;
    }
    expect(logs['선크림']).toEqual(expect.objectContaining({
      fpm_routing_multilingual_mode: 'observe',
      fpm_routing_bare_ingredient_mode: 'observe',
      fpm_routing_query_normalized: false,
      fpm_routing_query_would_normalize: true,
    }));
    expect(logs.retinol.fpm_routing_would_bare_ingredient).toBe(true);
    expect(logs['retinol serum'].fpm_routing_ingredient_admission_would_drop_count).toBeGreaterThan(0);
    expect(logs['retinol serum'].fpm_routing_ingredient_admission_input_count).toBeGreaterThan(0);
    expect(logs['retinol serum'].fpm_routing_ingredient_admission_dropped_count).toBeUndefined();
    expect(logs['niacinamide-free serum'].fpm_excluded_ingredient_would_drop_count).toBeGreaterThan(0);
    expect(logs['retinol-free'].fpm_routing_bare_negation).toBe(true);
    for (const log of Object.values(logs)) expect(JSON.stringify(log)).not.toMatch(/선크림|sunscreen|retinol/i);
  });

  test('on: a bare ingredient reaches the ingredient lane and returns only rows that name it', async () => {
    const { invoke } = boot(BOTH_ON);
    const expected = {
      retinol: REAL_RETINOL,
      Retinol: REAL_RETINOL,
      'best retinol products': REAL_RETINOL,
      'hyaluronic acid': ['Hyaluronic Acid 2% Hydrating Serum'],
      niacinamide: REAL_NIACINAMIDE,
      'vitamin c': REAL_VITAMIN_C,
    };
    for (const [query, expectedTitles] of Object.entries(expected)) {
      const { resp } = await invoke(query);
      expect([query, lane(resp)]).toEqual([query, LANES.INGREDIENT]);
      // Every row names the ingredient. (The lane's own beauty-signal gate, unchanged, may still drop a
      // row whose only text is in another script, e.g. the Cyrillic one.)
      const got = titles(resp);
      expect([query, got.length > 0]).toEqual([query, true]);
      for (const title of got) expect([query, title, expectedTitles.includes(title)]).toEqual([query, title, true]);
      expect([query, got.filter((title) => /^[\x00-\x7f]+$/.test(title)).sort()]).toEqual([
        query,
        expectedTitles.filter((title) => /^[\x00-\x7f]+$/.test(title)).sort(),
      ]);
    }
  });

  test('on: no fooled "retinol" title ever answers a retinol query, in any language', async () => {
    const { invoke } = boot(BOTH_ON);
    for (const query of ['retinol', 'retinol serum', '레티놀', 'レチノール', '视黄醇', 'rétinol', 'Retinol']) {
      const { resp, log } = await invoke(query);
      expect([query, lane(resp)]).toEqual([query, LANES.INGREDIENT]);
      const got = titles(resp);
      expect(got.length).toBeGreaterThan(0);
      for (const title of got) expect([query, REAL_RETINOL.includes(title)]).toEqual([query, true]);
      expect(log.fpm_routing_ingredient_admission_dropped_count).toBeGreaterThan(0);
    }
    expect(titles((await invoke('vitamin c')).resp)).not.toContain('Vitamin E Serum');
  });

  test('on: a query that excludes an ingredient never gets a row naming it', async () => {
    const { invoke } = boot(BOTH_ON);
    const cases = {
      'niacinamide-free serum': REAL_NIACINAMIDE,
      'serum without niacinamide': REAL_NIACINAMIDE,
      'no niacinamide serum': REAL_NIACINAMIDE,
      'vitamin c free serum': REAL_VITAMIN_C,
      'retinol alternative serum': REAL_RETINOL,
      'free of retinol serum': REAL_RETINOL,
      'no added retinol serum': REAL_RETINOL,
      'moisturizer without retinol': REAL_RETINOL,
      'crème hydratante sans rétinol': REAL_RETINOL,
    };
    for (const [query, forbidden] of Object.entries(cases)) {
      const { resp } = await invoke(query);
      const got = titles(resp);
      expect([query, got.length > 0]).toEqual([query, true]);
      for (const title of got) expect([query, title, forbidden.includes(title)]).toEqual([query, title, false]);
      // The page's total drops what the exclusion dropped (as the serving-currency guard does).
      expect([query, Number(resp.body.total) <= CATALOG.length - forbidden.length]).toEqual([query, true]);
      expect([query, Number(resp.body.total) >= got.length]).toEqual([query, true]);
    }
  });

  test('on: positive marketing words ask FOR the ingredient; they are never exclusions', async () => {
    const { invoke } = boot(BOTH_ON);
    const cases = {
      'vegan retinol serum': REAL_RETINOL,
      'natural vitamin c serum': REAL_VITAMIN_C,
      'vegan niacinamide serum': REAL_NIACINAMIDE,
    };
    for (const [query, wanted] of Object.entries(cases)) {
      const { resp } = await invoke(query);
      const got = titles(resp);
      expect([query, got.length > 0]).toEqual([query, true]);
      for (const title of got) expect([query, title, wanted.includes(title)]).toEqual([query, title, true]);
    }
    for (const query of ['pro retinol cream', 'bio retinol', 'retinol dupe', 'products like retinol', 'vegan retinol serum']) {
      const { resp, log } = await invoke(query);
      expect([query, resp.body.metadata?.excluded_ingredient_dropped_count]).toEqual([query, undefined]);
      expect([query, log.fpm_excluded_ingredient_dropped_count]).toEqual([query, undefined]);
    }
  });

  test('on: a negation that names something to serve gets rows, never the clarify, and never the ingredient', async () => {
    const { invoke } = boot(BOTH_ON);
    for (const query of ['retinol-free balm', 'retinol-free suncream', 'retinol-free mist', 'cerave without retinol',
      'the ordinary retinol free', 'retinol free for sensitive skin', 'pregnancy safe no retinol', 'retinol-free anti aging',
      'retinol free skincare', 'retinol-free 크림', 'retinol-free crème', 'retinol-free crema', 'ohne Retinol creme']) {
      const { resp } = await invoke(query);
      expect([query, lane(resp)]).not.toEqual([query, LANES.SAFE_EMPTY]);
      for (const title of titles(resp)) expect([query, title, REAL_RETINOL.includes(title)]).toEqual([query, title, false]);
    }
  });

  test('on: decimals stay numbers -- "1.0%" asks for the ingredient and names it on a product', async () => {
    const { invoke } = boot(BOTH_ON);
    // The query keeps its ingredient intent and is never read as "0% retinol". (Its rows are then emptied
    // by the lane's budget filter, which reads the bare number "1.0" as a price cap -- the existing
    // number-as-price behaviour, the same with the flags off; not part of these flags.)
    for (const query of ['1.0% retinol serum', '2.0% salicylic acid', '10.0% niacinamide', '15.0% vitamin c']) {
      const { resp, log } = await invoke(query);
      expect([query, lane(resp)]).toEqual([query, LANES.INGREDIENT]);
      expect([query, log.fpm_excluded_ingredient_dropped_count]).toEqual([query, undefined]);
      expect([query, log.fpm_routing_query_negation]).toEqual([query, undefined]);
      expect([query, resp.body.metadata.ingredient_direct_budget_filtered_out_count > 0]).toEqual([query, true]);
    }
    for (const [query, forbidden] of [['retinol-free serum', '1.0% Retinol Night Serum'], ['niacinamide-free serum', '10.0% Niacinamide Booster'],
      ['salicylic acid free cleanser', '2.0% Salicylic Acid Cleanser']]) {
      expect([query, titles((await invoke(query)).resp)]).not.toContainEqual([query, forbidden]);
      expect([query, titles((await invoke(query)).resp).includes(forbidden)]).toEqual([query, false]);
    }
  });

  test('on: "free radical", Korean "premium", Russian inflections, faux / pseudo, INCI veto', async () => {
    const { invoke } = boot(BOTH_ON);
    const radical = await invoke('vitamin c free radical serum');
    expect(lane(radical.resp)).toBe(LANES.INGREDIENT);
    expect(titles(radical.resp)).toContain('Vitamin C 15% Serum');
    expect(titles((await invoke('vitamin c free serum')).resp)).not.toContain('Vitamin C Free Radical Defense Serum');
    const premium = await invoke('레티놀 프리미엄 세럼');
    expect(lane(premium.resp)).toBe(LANES.INGREDIENT);
    expect(titles((await invoke('retinol-free serum')).resp)).not.toContain('레티놀 프리미엄 세럼');
    expect(titles((await invoke('retinol-free cream')).resp)).not.toContain('Крем с ретинолом');
    const retinol = titles((await invoke('retinol')).resp);
    for (const fooled of ['Faux Retinol Night Oil', 'Pseudo-Retinol Serum', 'Bio-Retinol Bakuchiol Serum']) {
      expect([fooled, retinol.includes(fooled)]).toEqual([fooled, false]);
    }
  });

  test('on: "like", "dupe" and "phyto" in a query ask FOR the ingredient; stand-in queries browse without it', async () => {
    const { invoke } = boot(BOTH_ON);
    for (const query of ['retinol like the ordinary', 'serum with retinol like the ordinary', 'phyto ceramides']) {
      const { resp, log } = await invoke(query);
      expect([query, log.fpm_excluded_ingredient_dropped_count]).toEqual([query, undefined]);
      expect([query, resp.body.metadata?.excluded_ingredient_dropped_count]).toEqual([query, undefined]);
    }
    for (const query of ['retinol like results', 'retinol dupe', 'products like retinol']) {
      const { resp } = await invoke(query);
      expect([query, lane(resp)]).toEqual([query, LANES.INGREDIENT]);
      for (const title of titles(resp)) expect([query, title, REAL_RETINOL.includes(title)]).toEqual([query, title, true]);
    }
    expect((await invoke('retinol')).log.fpm_routing_query_negation).toBeUndefined();
    for (const query of ['retinol alternative', 'alternative to retinol', 'bakuchiol instead of retinol']) {
      const { resp, log } = await invoke(query);
      // the stand-in rewrite is logged as a negation rewrite
      expect([query, log.fpm_routing_query_negation]).toEqual([query, true]);
      expect([query, lane(resp)]).not.toEqual([query, LANES.SAFE_EMPTY]);
      expect([query, titles(resp).length > 0]).toEqual([query, true]);
      for (const product of resp.body.products) {
        expect([query, product.title, REAL_RETINOL.includes(product.title)]).toEqual([query, product.title, false]);
        const path = product.catalog_category_path || (Array.isArray(product.category_path) ? product.category_path.join('/') : product.category_path);
        expect([query, product.title, SKINCARE_PATH.test(String(path || ''))]).toEqual([query, product.title, true]);
      }
    }
  });

  test('on: an exclusion with no category stays in skincare; a German form keeps its form', async () => {
    const { invoke } = boot(BOTH_ON);
    for (const query of ['retinol-free mist', 'retinol-free balm', 'retinol free skincare', 'cerave without retinol']) {
      const { resp } = await invoke(query);
      for (const product of resp.body.products) {
        const path = product.catalog_category_path || (Array.isArray(product.category_path) ? product.category_path.join('/') : product.category_path);
        expect([query, product.title, SKINCARE_PATH.test(String(path || ''))]).toEqual([query, product.title, true]);
      }
    }
    const german = await invoke('Retinolfreie Creme');
    const english = await invoke('retinol-free cream');
    expect([lane(german.resp), ids(german.resp)]).toEqual([lane(english.resp), ids(english.resp)]);
  });

  test('bare-ingredient flag alone: a non-English negation never becomes a request FOR the ingredient', async () => {
    const { invoke } = boot({ FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on' });
    for (const query of ['retinolfrei', 'ohne Retinol creme', 'crema sin retinol', 'sans retinol', 'Retinolfreie Creme']) {
      const { resp } = await invoke(query);
      expect([query, lane(resp)]).not.toEqual([query, LANES.INGREDIENT]);
      for (const title of titles(resp)) expect([query, title, REAL_RETINOL.includes(title)]).toEqual([query, title, false]);
    }
    // ... and one that names a product type is served (minus the ingredient), not clarified.
    for (const query of ['ohne Retinol creme', 'crema sin retinol', 'Retinolfreie Creme']) {
      expect([query, lane((await invoke(query)).resp)]).not.toEqual([query, LANES.SAFE_EMPTY]);
    }
    expect(lane((await invoke('retinolfrei')).resp)).toBe(LANES.SAFE_EMPTY);
  });

  test('on: "formulated with" compounds keep the ingredient; a form noun next to an ingredient is a form', async () => {
    const { invoke } = boot(BOTH_ON);
    const retinolCream = await invoke('retinol cream');
    const retinolSerum = await invoke('retinol serum');
    for (const [query, english] of [['레티놀배합 크림', retinolCream], ['Retinol Creme', retinolCream], ['retinol creme', retinolCream],
      ['レチノール配合の美容液', retinolSerum]]) {
      const { resp } = await invoke(query);
      expect([query, lane(resp), ids(resp)]).toEqual([query, lane(english.resp), ids(english.resp)]);
      expect([query, titles(resp)]).not.toContainEqual([query, 'Retinol-Free Barrier Moisturizer']);
    }
    expect(lane((await invoke('レチノール配合の美容液')).resp)).toBe(LANES.INGREDIENT);
  });

  test('on: a bare negation never widens what is served', async () => {
    const queries = ['without retinol', 'no retinol', 'avoid retinol', 'zero retinol', '0% retinol', 'sin retinol',
      'ohne Retinol', 'sans rétinol', 'retinol-free', 'retinol free'];
    // (A bare STAND-IN -- "retinol alternative" -- is not an absence: it browses skincare without the
    // ingredient; see the stand-in test.)
    const off = boot();
    const before = {};
    for (const query of queries) before[query] = (await off.invoke(query)).resp;
    jest.resetModules();
    const on = boot(BOTH_ON);
    for (const query of queries) {
      const { resp } = await on.invoke(query);
      expect([query, titles(resp).length <= titles(before[query]).length]).toEqual([query, true]);
      expect([query, titles(resp)]).toEqual([query, []]);
    }
    // English "retinol-free" was a beauty-wide browse with the flags off; on, it is the clarify.
    const { resp } = await on.invoke('retinol-free');
    expect(lane(resp)).toBe(LANES.SAFE_EMPTY);
    expect(resp.body.reply).toMatch(/Please search for a product/);
  });

  test('on: an ingredient with a form noun in another language routes like the English query', async () => {
    const { invoke } = boot(BOTH_ON);
    const english = await invoke('retinol cream');
    for (const query of ['레티놀 크림', 'retinol 크림', 'レチノール クリーム', 'crème rétinol']) {
      const { resp } = await invoke(query);
      expect([query, lane(resp), ids(resp)]).toEqual([query, lane(english.resp), ids(english.resp)]);
    }
    // A form noun this table does not know is not dropped: the query is not the bare ingredient.
    const cyrillic = await invoke('retinol крем');
    expect(cyrillic.log.fpm_routing_would_bare_ingredient).toBe(false);
  });

  test('on (multilingual): English and loanword-identical queries answer byte-identically to off', async () => {
    const queries = ['ceramides moisturizer', 'deo spray', 'Dior Sauvage parfum', 'serum', 'moisturizer', 'sunscreen',
      'cleanser', 'lipstick', 'face mask', 'retinol serum', 'niacinamide serum', 'vitamin c serum', 'glycerine soap',
      'panthenol', 'deodorant', 'creme brulee', 'retinol free shipping', 'rodeo boots'];
    const off = boot();
    const before = [];
    for (const query of queries) before.push((await off.invoke(query)).resp.body);
    jest.resetModules();
    const on = boot({ FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'on' });
    for (let i = 0; i < queries.length; i += 1) {
      const { resp, log } = await on.invoke(queries[i]);
      expect([queries[i], normalize(resp.body)]).toEqual([queries[i], normalize(before[i])]);
      expect([queries[i], log.fpm_routing_query_normalized]).toEqual([queries[i], false]);
    }
  });

  test('on: non-English category queries route and answer like their English equivalent', async () => {
    const { invoke } = boot(BOTH_ON);
    const pairs = [
      ['선크림', 'sunscreen', ['Daily Sunscreen SPF 50']],
      ['자외선 차단제', 'sunscreen', ['Daily Sunscreen SPF 50']],
      ['日焼け止め', 'sunscreen', ['Daily Sunscreen SPF 50']],
      ['洗面奶', 'cleanser', ['Gentle Foaming Face Cleanser']],
      ['洗面乳', 'cleanser', ['Gentle Foaming Face Cleanser']],
      ['crème hydratante', 'moisturizer', null],
      ['hydratant', 'moisturizer', null],
      ['crema hidratante', 'moisturizer', null],
      ['Feuchtigkeitscreme', 'moisturizer', null],
      ['Lippenstift', 'lipstick', ['Velvet Matte Lipstick']],
      ['lápiz labial', 'lipstick', ['Velvet Matte Lipstick']],
    ];
    for (const [foreign, english, expectedTitles] of pairs) {
      const a = await invoke(foreign);
      const b = await invoke(english);
      expect([foreign, lane(a.resp)]).toEqual([foreign, lane(b.resp)]);
      expect([foreign, lane(a.resp)]).toEqual([foreign, LANES.MAINLINE]);
      expect([foreign, ids(a.resp)]).toEqual([foreign, ids(b.resp)]);
      if (expectedTitles) expect([foreign, titles(a.resp).sort()]).toEqual([foreign, [...expectedTitles].sort()]);
      for (const title of titles(a.resp)) expect([foreign, /Lipstick|Shampoo|Sunscreen|Cleanser/.test(title) && english === 'moisturizer']).toEqual([foreign, false]);
    }
  });

  test('on: non-beauty, ambiguous and unknown-compound queries route exactly as with the flags off', async () => {
    const queries = ['laptop', 'running shoes', 'kitchen cleaner', 'air conditioner', 'printer toner', '프린터 토너',
      'limpiador de cocina', 'acondicionador de aire', 'creme brulee', 'crème', 'máscara', '크림', '마스크', 'Sonnenschutz',
      'vitamin c supplement', 'mask', 'gift', '眼霜', '精华水', '아이크림'];
    const off = boot();
    const before = [];
    for (const query of queries) before.push((await off.invoke(query)).resp);
    jest.resetModules();
    const on = boot(BOTH_ON);
    for (let i = 0; i < queries.length; i += 1) {
      const { resp, log } = await on.invoke(queries[i]);
      expect([queries[i], lane(resp), ids(resp)]).toEqual([queries[i], lane(before[i]), ids(before[i])]);
      expect([queries[i], log.fpm_routing_query_normalized]).toEqual([queries[i], false]);
    }
  });

  test('on: a query that arrives only in messages, or as a top-level query, is normalised the same way', async () => {
    const { send, invoke } = boot(BOTH_ON);
    for (const [foreign, english] of [['선크림', 'sunscreen'], ['레티놀', 'retinol'], ['洗面奶', 'cleanser']]) {
      const english_ = await invoke(english);
      const viaMessages = await send({ search: { page: 1, page_size: 20 }, messages: [{ role: 'user', content: foreign }] });
      const viaTopLevel = await send({ query: foreign, page: 1, page_size: 20 });
      const englishMessages = await send({ search: { page: 1, page_size: 20 }, messages: [{ role: 'user', content: english }] });
      expect([foreign, lane(viaMessages.resp), ids(viaMessages.resp)]).toEqual([foreign, lane(englishMessages.resp), ids(englishMessages.resp)]);
      expect([foreign, lane(viaTopLevel.resp)]).toEqual([foreign, lane(english_.resp)]);
      expect([foreign, ids(viaTopLevel.resp)]).toEqual([foreign, ids(english_.resp)]);
    }
  });

  test('the caller\'s own text sets the reply language only through the gateway, never through request metadata', async () => {
    boot(BOTH_ON);
    const { buildFindProductsMultiContext } = require('../../src/findProductsMulti/policy');
    const sunscreen = { search: { query: 'sunscreen' } };
    // The gateway hands its own original in; that is honoured while a routing flag is on.
    const routed = await owned(() => buildFindProductsMultiContext({ payload: sunscreen, metadata: {}, routingOriginalQuery: '선크림' }));
    expect(routed.intent.language).toBe('ko');
    // A caller-supplied metadata.routing_original_query is ignored ...
    const hostile = await owned(() => buildFindProductsMultiContext({ payload: sunscreen, metadata: { routing_original_query: '洗面奶' } }));
    expect(hostile.intent.language).toBe('en');
    // ... and never wins over the gateway's own.
    const both = await owned(() =>
      buildFindProductsMultiContext({ payload: sunscreen, metadata: { routing_original_query: '洗面奶' }, routingOriginalQuery: '선크림' }),
    );
    expect(both.intent.language).toBe('ko');
    // Routing is unchanged by it: the same query reaches the lanes.
    expect(routed.adjustedPayload.search.query).toBe(hostile.adjustedPayload.search.query);
  });

  test('flags off: the gateway\'s original is not honoured either', async () => {
    boot();
    const { buildFindProductsMultiContext } = require('../../src/findProductsMulti/policy');
    const ctx = await owned(() => buildFindProductsMultiContext({ payload: { search: { query: 'sunscreen' } }, metadata: {}, routingOriginalQuery: '선크림' }));
    expect(ctx.intent.language).toBe('en');
  });

  // Drops the caller's own metadata echo so two bodies can be compared on everything else.
  const withoutEcho = (value) => {
    if (Array.isArray(value)) return value.map(withoutEcho);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, inner] of Object.entries(value)) if (key !== 'routing_original_query') out[key] = withoutEcho(inner);
    return out;
  };
  const HOSTILE = ['洗面奶', '선크림', '日焼け止め', 'crème hydratante'];
  const SHAPES = {
    search: (query) => ({ search: { query, page: 1, page_size: 20 } }),
    messages: (query) => ({ search: { page: 1, page_size: 20 }, messages: [{ role: 'user', content: query }] }),
  };
  test.each([
    ['flags off', {}],
    ['both flags on', BOTH_ON],
  ])('%s: a hostile metadata.routing_original_query changes nothing (reply, language, body)', async (_label, env) => {
    Object.assign(process.env, env);
    jest.doMock('../../src/db', () => ({
      query: async (sql) => (String(sql || '').includes(CANONICAL_MARKER) ? { rows: CATALOG } : { rows: [] }),
    }));
    const app = listen(owned(() => require('../../src/server')));
    const call = (payload, metadata) =>
      owned(async () => request(app).post('/agent/shop/v1/invoke').send({ operation: 'find_products_multi', payload, ...(metadata ? { metadata } : {}) }));
    for (const query of ['gift', 'sunscreen', '선크림']) {
      for (const [shape, build] of Object.entries(SHAPES)) {
        const baseline = await call(build(query));
        for (const hostile of HOSTILE) {
          const attacked = await call(build(query), { routing_original_query: hostile });
          expect([query, shape, hostile, attacked.body.reply]).toEqual([query, shape, hostile, baseline.body.reply]);
          expect([query, shape, hostile, normalize(withoutEcho(attacked.body))]).toEqual([query, shape, hostile, normalize(withoutEcho(baseline.body))]);
        }
      }
    }
  });

  // The routing flags never touch the ingredient lane's market: with the routing flags off -- and on --
  // the lane binds exactly what main binds, on a partitioned mock (US with an SGD seed filed under it,
  // SG empty, JP, KR with a USD and a currency-less row), buyer-market flag on and off. Values captured
  // from origin/main on the same mock. Market scoping is a separate change, not part of these flags.
  describe('ingredient lane market binds are main\'s, whatever the routing flags', () => {
    const PARTITIONED = [
      ['us_retinol', 'Retinol 0.3% Night Serum', 'US', 'USD'],
      ['us_sgd_retinol', 'Retinol Night Serum (SGD seed)', 'US', 'SGD'],
      ['jp_retinol', 'Tokyo Retinol Essence', 'JP', 'JPY'],
      ['kr_ampoule', 'Seoul Retinol Ampoule', 'KR', 'USD'],
      ['kr_toner', 'Busan Retinol Toner', 'KR', null],
    ].map(([key, title, market, currency]) => ({
      ...row(key, title, SERUM, { actives: ['retinol'], productType: 'Serum' }),
      currency,
      merchant_effective_price: currency ? '24.00' : null,
      recall_market: market,
      product_payload: { seed_data: { price_amount: currency ? '24.00' : null, price_currency: currency, availability: 'in stock', active_ingredients: ['retinol'] } },
      _market: market,
    }));
    const codesOf = (params) => params.flatMap((p) => (Array.isArray(p) ? p : [p])).filter((p) => typeof p === 'string' && /^[A-Z]{2,3}$/.test(p));

    function bootPartitioned(env) {
      Object.assign(process.env, env);
      const statements = [];
      jest.doMock('../../src/db', () => ({
        query: async (sql, params) => {
          const text = String(sql || '');
          const codes = codesOf(Array.isArray(params) ? params : []);
          const kind = text.includes(CANONICAL_MARKER) ? 'canonical' : /FROM external_product_seeds/.test(text) ? 'seed' : 'other';
          statements.push({ kind, codes });
          if (kind !== 'canonical') return { rows: [] };
          const markets = codes.filter((c) => c.length === 2);
          const currencies = codes.filter((c) => c.length === 3);
          return {
            rows: PARTITIONED.filter(
              (r) => (markets.length ? markets.includes(r._market) : true) && (currencies.length ? currencies.includes(r.currency) : true),
            ),
          };
        },
      }));
      const app = listen(owned(() => require('../../src/server')));
      return async (market) => {
        statements.length = 0;
        const search = { query: 'retinol serum', page: 1, page_size: 20, ...(market ? { market } : {}) };
        const resp = await owned(async () => request(app).post('/agent/shop/v1/invoke').send({ operation: 'find_products_multi', payload: { search } }));
        return {
          lane: lane(resp),
          rows: titles(resp),
          canonical: statements.filter((s) => s.kind === 'canonical').map((s) => s.codes),
          seed: Array.from(new Set(statements.filter((s) => s.kind === 'seed').map((s) => s.codes.join(',')))),
        };
      };
    }

    // [market, canonical binds, rows] -- origin/main, both buyer-flag states (identical there).
    const MAIN = [
      [null, [['US', 'US']], ['Retinol 0.3% Night Serum']],
      ['US', [['US', 'US']], ['Retinol 0.3% Night Serum']],
      ['SG', [['SG', 'SG']], []],
      ['JP', [['JP', 'JP']], ['Tokyo Retinol Essence']],
      ['KR', [['KR', 'KR']], ['Busan Retinol Toner']],
      ['en-US', [['US', 'US']], []],
    ];
    test.each([
      ['routing off, buyer flag off', { FIND_PRODUCTS_BUYER_MARKET: 'off' }],
      ['routing off, buyer flag on', { FIND_PRODUCTS_BUYER_MARKET: 'on' }],
      ['routing observe, buyer flag on', { FIND_PRODUCTS_BUYER_MARKET: 'on', ...BOTH_OBSERVE }],
      ['routing on, buyer flag on', { FIND_PRODUCTS_BUYER_MARKET: 'on', ...BOTH_ON }],
      ['routing on, buyer flag off', { FIND_PRODUCTS_BUYER_MARKET: 'off', ...BOTH_ON }],
    ])('%s', async (_label, env) => {
      const invokeMarket = bootPartitioned(env);
      for (const [market, canonical, rows] of MAIN) {
        const got = await invokeMarket(market);
        expect([market, got.lane]).toEqual([market, LANES.INGREDIENT]);
        expect([market, got.canonical]).toEqual([market, canonical]);
        expect([market, got.seed]).toEqual([market, ['US']]);
        expect([market, got.rows]).toEqual([market, rows]);
      }
    });
  });

  test('each flag alone does only its own part', async () => {
    const bare = boot({ FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on' });
    expect(lane((await bare.invoke('retinol')).resp)).toBe(LANES.INGREDIENT);
    expect(lane((await bare.invoke('선크림')).resp)).toBe(LANES.BACKEND);
    jest.resetModules();
    const multi = boot({ FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'on' });
    expect(lane((await multi.invoke('선크림')).resp)).toBe(LANES.MAINLINE);
    expect(lane((await multi.invoke('레티놀')).resp)).toBe(lane((await multi.invoke('retinol')).resp));
  });
});
