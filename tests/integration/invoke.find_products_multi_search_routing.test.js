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

function row(key, title, categoryPath, { actives = [], productType = 'Skincare', description = null, inci = null, brand = 'Test Brand' } = {}) {
  return {
    merchant_id: 'external_seed',
    product_key: `prod::external_seed::external_seed::ext_${key}`,
    platform: 'external_seed',
    source_product_id: `ext_${key}`,
    pivota_signature_id: `sig_${key}`,
    pivota_canonical_url: `https://agent.pivota.cc/products/sig_${key}`,
    product_title: title,
    product_description: description || `${title}. A test product.`,
    brand,
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
  // r6: stand-ins, areas, "like", glued Korean "free", compounds that are other substances, a trailing 0%.
  row('bakuchiol_oil', 'Bakuchiol Night Oil', 'beauty/skincare/face-oil', { actives: ['bakuchiol'], productType: 'Face Oil' }),
  row('retinol_bakuchiol', 'Retinol + Bakuchiol Serum', SERUM, { actives: ['retinol', 'bakuchiol'], productType: 'Serum' }),
  row('hair_gel_gly', 'Glycerin Hold Hair Gel', 'beauty/haircare/styling', { actives: ['glycerin'], productType: 'Hair Gel' }),
  row('scalp_serum', 'Peptide Scalp Serum', 'beauty/haircare/scalp', { actives: ['peptides'], productType: 'Scalp Serum' }),
  row('retinol_scalp', 'Retinol Scalp Treatment', 'beauty/haircare/scalp', { actives: ['retinol'], productType: 'Scalp Treatment' }),
  row('lip_balm', 'Nourishing Lip Balm', 'beauty/makeup/lip/lip-balm', { actives: ['shea butter'], productType: 'Lip Balm' }),
  row('retinol_lip', 'Retinol Lip Treatment', 'beauty/makeup/lip/lip-treatment', { actives: ['retinol'], productType: 'Lip Treatment' }),
  row('retinol_body', 'Retinol Body Lotion', 'beauty/body-care/body-lotion', { actives: ['retinol'], productType: 'Body Lotion' }),
  row('phyto_ceramide', 'Phyto Ceramides Cream', CREAM, { productType: 'Moisturizer' }),
  row('retinol_like_balm', 'Retinol Like Butter Balm', 'beauty/skincare/moisturize/balm', { productType: 'Balm' }),
  row('retinol_like_serum', 'Retinol-Like Smoothing Serum', SERUM, { productType: 'Serum' }),
  row('ko_free_cream', '레티놀프리크림', CREAM, { productType: 'Moisturizer' }),
  row('ko_free_serum', '레티놀프리세럼', SERUM, { productType: 'Serum' }),
  row('zero_after', 'Retinol 0% Night Cream', CREAM, { productType: 'Moisturizer' }),
  row('zh_ehg', '乙基己基甘油 爽肤水', 'beauty/skincare/tone/toner', { productType: 'Toner' }),
  row('ja_ehg', 'エチルヘキシルグリセリン配合ローション', 'beauty/skincare/tone/toner', { productType: 'Toner' }),
  row('ko_ehg', '에틸헥실글리세린 토너', 'beauty/skincare/tone/toner', { productType: 'Toner' }),
  row('zh_octisalate', '水杨酸乙基己酯防晒霜', 'beauty/skincare/sun/sunscreen', { productType: 'Sunscreen' }),
  row('ja_octisalate', 'サリチル酸エチルヘキシル配合UV', 'beauty/skincare/sun/sunscreen', { productType: 'Sunscreen' }),
  row('zh_retinyl', '视黄醇棕榈酸酯面霜', CREAM, { productType: 'Moisturizer' }),
  row('ru_retinol_like', 'Ретинолоподобный крем', CREAM, { productType: 'Moisturizer' }),
  row('ru_hyaluronidase', 'Крем с гиалуронидазой', CREAM, { productType: 'Moisturizer' }),
  row('ru_vitamins_oil', 'Комплекс витаминов с маслом', SERUM, { productType: 'Serum' }),
  // follow-up: the retinoid family, a hyphen-glued "free", a spaced Korean retinyl ester, a plural
  // Russian vitamin list, a Chinese "does not contain".
  row('retinal', 'Retinal 0.1% Night Serum', SERUM, { actives: ['retinal'], productType: 'Serum' }),
  row('granactive', 'Granactive Retinoid 2% Emulsion', SERUM, { actives: ['hydroxypinacolone retinoate'], productType: 'Serum' }),
  row('adapalene', 'Adapalene Gel 0.1%', SERUM, { actives: ['adapalene'], productType: 'Serum' }),
  row('retinyl', 'Retinyl Palmitate Night Cream', CREAM, { actives: ['retinyl palmitate'], productType: 'Moisturizer' }),
  row('ko_retinal', '레티날 크림', CREAM, { productType: 'Moisturizer' }),
  row('free_sample', 'Retinol-Free Sample Cream', CREAM, { productType: 'Moisturizer' }),
  row('ko_palmitate', '레티놀 팔미테이트 크림', CREAM, { productType: 'Moisturizer' }),
  row('ru_vitamin_list', 'Витамины С и Е сыворотка', SERUM, { productType: 'Serum' }),
  row('zh_not_contains', '不含视黄醇面霜', CREAM, { productType: 'Moisturizer' }),
  // rows with NO category path (as backend-lane rows often arrive): judged by their own title
  row('nopath_hair_oil', 'Bakuchiol Hair Oil', null, { actives: ['bakuchiol'], productType: 'Hair Oil' }),
  row('nopath_drops', 'Bakuchiol Booster Drops', null, { actives: ['bakuchiol'], productType: 'Booster' }),
  // round 2: more of the retinoid family, and unfiled rows whose titles negate or name a category
  row('vitamin_a', 'Vitamin A Serum', SERUM, { productType: 'Serum' }),
  row('trifarotene', 'Trifarotene Cream', CREAM, { productType: 'Moisturizer' }),
  row('retin_a', 'Retin-A 0.05% Cream', CREAM, { productType: 'Moisturizer' }),
  row('zh_a_aldehyde', 'A醛精华', SERUM, { productType: 'Serum' }),
  row('fr_retinoide', 'Rétinoïde Crème de Nuit', CREAM, { productType: 'Moisturizer' }),
  row('nopath_shampoo_free', 'Shampoo-Free Bakuchiol Serum', null, { actives: ['bakuchiol'], productType: 'Serum' }),
  row('nopath_ko_shampoo', '바쿠치올 데일리 샴푸', null, { actives: ['bakuchiol'], productType: '' }),
  row('brand_retinol', 'Night Retinol Cream', CREAM, { actives: ['retinol'], productType: 'Moisturizer', brand: 'CeraVe' }),
  row('brand_niacinamide', 'Hydrating Niacinamide Lotion', CREAM, { actives: ['niacinamide'], productType: 'Moisturizer', brand: 'CeraVe' }),
];
const REAL_RETINOL = ['Retinol 0.3% Night Serum', 'Retinol Renewal Night Cream', 'Vegan Retinol Night Cream',
  'Revive Pro-Retinol Night Cream', '레티놀 세럼', 'Ретинол сыворотка', '1.0% Retinol Night Serum', '레티놀 프리미엄 세럼',
  'Крем с ретинолом', 'Retinol + Bakuchiol Serum', 'Retinol Scalp Treatment', 'Retinol Lip Treatment', 'Retinol Body Lotion',
  'Retinol Like Butter Balm', 'Night Retinol Cream'];
const REAL_NIACINAMIDE = ['Niacinamide 10% Serum', 'Vegan Niacinamide 10% + Zinc Serum', '10.0% Niacinamide Booster',
  'Hydrating Niacinamide Lotion'];
const REAL_VITAMIN_C = ['Vitamin C 15% Serum', 'Vitamin C+E Ferulic Serum', 'Natural Vitamin C Brightening Serum',
  'Vitamin C Free Radical Defense Serum', 'Витамины С и Е сыворотка'];
// Retinoids that are not retinol by name: a retinol exclusion excludes them too.
const RETINOID_FAMILY = ['Retinal 0.1% Night Serum', 'Granactive Retinoid 2% Emulsion', 'Adapalene Gel 0.1%',
  'Retinyl Palmitate Night Cream', '레티날 크림', '레티놀 팔미테이트 크림', '视黄醇棕榈酸酯面霜', 'Vitamin A Serum', 'Trifarotene Cream',
  'Retin-A 0.05% Cream', 'A醛精华', 'Rétinoïde Crème de Nuit'];
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
    // Pinned: the budget parser reads this flag on every call, and a shell that exports it must not
    // change these lanes. Tests that care set it themselves.
    delete process.env.SEARCH_BUDGET_REQUIRE_MARKER;
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
    const send = async (payload, metadata = null) => {
      statements.length = 0;
      const resp = await owned(async () =>
        request(app).post('/agent/shop/v1/invoke').send({ operation: 'find_products_multi', payload, ...(metadata ? { metadata } : {}) }));
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
    // The query keeps its ingredient intent and is never read as "0% retinol" -- and, since the budget
    // parser masks strengths (#2485), "1.0" is not a price cap either: no lane drops a row on a budget,
    // with SEARCH_BUDGET_REQUIRE_MARKER on or off. Before #2485 the unset flag capped all four at the
    // strength (ingredient lane, 0 rows); with the marker on (prod) they already answered as below, and
    // now both states answer the same. ("15.0% vitamin c" is a safe-empty contract answer in both
    // states, before and after -- not a budget.)
    const expected = {
      '1.0% retinol serum': [LANES.INGREDIENT, true],
      '2.0% salicylic acid': [LANES.MAINLINE, true],
      '10.0% niacinamide': [LANES.MAINLINE, true],
      '15.0% vitamin c': [LANES.SAFE_EMPTY, false],
    };
    for (const marker of ['1', undefined]) {
      if (marker === undefined) delete process.env.SEARCH_BUDGET_REQUIRE_MARKER;
      else process.env.SEARCH_BUDGET_REQUIRE_MARKER = marker;
      for (const [query, [expectedLane, served]] of Object.entries(expected)) {
        const { resp, log } = await invoke(query);
        const label = [query, marker || 'unset'];
        expect([label, lane(resp)]).toEqual([label, expectedLane]);
        expect([label, titles(resp).length > 0]).toEqual([label, served]);
        expect([label, log.fpm_excluded_ingredient_dropped_count]).toEqual([label, undefined]);
        expect([label, log.fpm_routing_query_negation]).toEqual([label, undefined]);
        const dropped = Object.entries(resp.body.metadata || {})
          .filter(([key, value]) => /budget_filtered_out_count$/.test(key) && value !== 0);
        expect([label, dropped]).toEqual([label, []]);
      }
    }
    delete process.env.SEARCH_BUDGET_REQUIRE_MARKER;
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

  const pathOf = (product) =>
    String(product.catalog_category_path || (Array.isArray(product.category_path) ? product.category_path.join('/') : product.category_path) || '');
  // Rows that name bakuchiol in the title or in their actives.
  const BAKUCHIOL_TITLES = CATALOG.filter((r) => /bakuchiol/i.test(r.product_title)
    || r.product_payload.seed_data.active_ingredients.includes('bakuchiol')).map((r) => r.product_title);
  const namesBakuchiol = (product) => BAKUCHIOL_TITLES.includes(product.title);

  test('on: "like", "dupe" and "phyto ceramides" ask FOR the ingredient', async () => {
    const { invoke } = boot(BOTH_ON);
    for (const query of ['serum with retinol like the ordinary', 'phyto ceramides']) {
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
    // S6: phyto-ceramides ARE ceramides
    for (const query of ['phyto ceramides', 'ceramides']) {
      const { resp } = await invoke(query);
      expect([query, lane(resp), titles(resp).includes('Phyto Ceramides Cream')]).toEqual([query, LANES.INGREDIENT, true]);
    }
  });

  test('on (S3/S5): a bare stand-in query asks for the known stand-in, or the stand-in it names, never the ingredient', async () => {
    const { invoke } = boot(BOTH_ON);
    for (const [query, kind] of [['retinol alternative', 'stand_in_known'], ['alternative to retinol', 'stand_in_known'],
      ['retinol substitute', 'stand_in_known'], ['faux retinol', 'stand_in_known'], ['phyto retinol', 'stand_in_known'],
      ['pseudo retinol', 'stand_in_known'], ['bakuchiol instead of retinol', 'stand_in_named'], ['retinol free bakuchiol', 'stand_in_named']]) {
      const { resp, log } = await invoke(query);
      // the stand-in rewrite is logged as a negation rewrite, with its kind
      expect([query, log.fpm_routing_query_negation, log.fpm_routing_query_rewrite]).toEqual([query, true, kind]);
      expect([query, lane(resp)]).toEqual([query, LANES.INGREDIENT]);
      expect([query, titles(resp).length > 0]).toEqual([query, true]);
      for (const product of resp.body.products) {
        expect([query, product.title, namesBakuchiol(product), REAL_RETINOL.includes(product.title)])
          .toEqual([query, product.title, true, false]);
        // (an unfiled row is kept when its own title names no other area: follow-up 4)
        expect([query, product.title, !pathOf(product) || SKINCARE_PATH.test(pathOf(product))]).toEqual([query, product.title, true]);
      }
      expect([query, titles(resp).includes('Retinol + Bakuchiol Serum')]).toEqual([query, false]);
      expect([query, titles(resp).includes('Bakuchiol Hair Oil')]).toEqual([query, false]);
    }
    // No known stand-in: the same answer for every ingredient -- a bare negation names nothing to serve.
    for (const query of ['vitamin c alternative', 'niacinamide alternative', 'hyaluronic acid alternative',
      'salicylic acid alternative', 'alternative to ceramides', 'faux niacinamide']) {
      const { resp, log } = await invoke(query);
      expect([query, lane(resp), log.fpm_routing_bare_negation]).toEqual([query, LANES.SAFE_EMPTY, true]);
    }
    // "<ingredient> like <brand>": the brand's rows that name the ingredient.
    const { resp, log } = await invoke('retinol like cerave');
    expect(log.fpm_routing_query_rewrite).toBe('ingredient_like_brand');
    expect(titles(resp)).toEqual(['Night Retinol Cream']);
    // typed the other way round, the brand browse serves every row of the brand (unchanged route)
    expect(titles((await invoke('cerave retinol')).resp).sort()).toEqual(['Hydrating Niacinamide Lotion', 'Night Retinol Cream']);
  });

  test('on (S2/S4): an exclusion keeps the area it names -- hair and lips get their own tree, never skincare', async () => {
    const { invoke } = boot(BOTH_ON);
    for (const [query, tree, excluded = 'retinol'] of [['retinol alternative for hair', /^beauty\/haircare(\/|$)/], ['retinol alternative for scalp', /^beauty\/haircare(\/|$)/],
      ['alternative to retinol for hair', /^beauty\/haircare(\/|$)/], ['without glycerin for hair', /^beauty\/haircare(\/|$)/, 'glycerin'],
      ['retinol alternative for lips', /^beauty\/makeup\/lip(\/|$)/]]) {
      const { resp, log } = await invoke(query);
      expect([query, log.fpm_routing_query_rewrite]).toEqual([query, 'area']);
      expect([query, lane(resp)]).toEqual([query, LANES.MAINLINE]);
      expect([query, titles(resp).length > 0]).toEqual([query, true]);
      for (const product of resp.body.products) {
        expect([query, product.title, !pathOf(product) || tree.test(pathOf(product))]).toEqual([query, product.title, true]);
        const named = excluded === 'retinol' ? REAL_RETINOL.includes(product.title) : /glycerin/i.test(product.title);
        expect([query, product.title, named]).toEqual([query, product.title, false]);
      }
    }
    // Another area is not rewritten and never scoped to skincare.
    for (const query of ['retinol alternative for body', 'glycerin-free soap', "glycerin-free men's"]) {
      const { resp, log } = await invoke(query);
      expect([query, log.fpm_routing_query_rewrite]).toEqual([query, undefined]);
      for (const product of resp.body.products) {
        expect([query, product.title, SKINCARE_PATH.test(pathOf(product))]).toEqual([query, product.title, false]);
      }
    }
  });

  test('on (S6-S9): what a product title names', async () => {
    const { invoke } = boot(BOTH_ON);
    const retinol = titles((await invoke('retinol')).resp);
    // "Retinol Like Butter Balm" is retinol; "Retinol-Like" (hyphen), glued Korean "free", a trailing 0%,
    // a retinyl ester and Russian "retinol-like" are not.
    expect(retinol).toContain('Retinol Like Butter Balm');
    for (const title of ['Retinol-Like Smoothing Serum', '레티놀프리크림', '레티놀프리세럼', 'Retinol 0% Night Cream', '视黄醇棕榈酸酯面霜',
      'Ретинолоподобный крем']) {
      expect([title, retinol.includes(title)]).toEqual([title, false]);
    }
    for (const [query, notThese] of [['glycerin', ['乙基己基甘油 爽肤水', 'エチルヘキシルグリセリン配合ローション', '에틸헥실글리세린 토너']],
      ['salicylic acid', ['水杨酸乙基己酯防晒霜', 'サリチル酸エチルヘキシル配合UV']], ['hyaluronic acid', ['Крем с гиалуронидазой']],
      ['vitamin c', ['Комплекс витаминов с маслом']]]) {
      const { resp } = await invoke(query);
      expect([query, lane(resp)]).toEqual([query, LANES.INGREDIENT]);
      for (const title of notThese) expect([query, title, titles(resp).includes(title)]).toEqual([query, title, false]);
    }
    expect(titles((await invoke('glycerin')).resp)).toContain('Glycerin Hold Hair Gel');
    // S7: glued Korean "free" is an absence on the query side too, like the English query; "premium" is not.
    const korean = await invoke('레티놀프리크림');
    const english = await invoke('retinol-free cream');
    expect([lane(korean.resp), ids(korean.resp)]).toEqual([lane(english.resp), ids(english.resp)]);
    expect(lane(korean.resp)).not.toBe(LANES.INGREDIENT);
    for (const title of titles(korean.resp)) expect([title, REAL_RETINOL.includes(title)]).toEqual([title, false]);
    expect(lane((await invoke('레티놀 프리미엄 크림')).resp)).toBe(LANES.INGREDIENT);
    // S9: a trailing 0% is an absence; any other trailing number asks for the ingredient.
    expect(lane((await invoke('retinol 0%')).resp)).toBe(LANES.SAFE_EMPTY);
    const zeroCream = await invoke('retinol 0% cream');
    expect(lane(zeroCream.resp)).not.toBe(LANES.INGREDIENT);
    expect([lane(zeroCream.resp), ids(zeroCream.resp)]).toEqual([lane(english.resp), ids(english.resp)]);
    for (const query of ['retinol 1.0% serum', 'retinol 0.3% serum', 'retinol 10% serum']) {
      expect([query, lane((await invoke(query)).resp)]).toEqual([query, LANES.INGREDIENT]);
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
      // (the r6 sunscreen rows -- other substances named in CJK -- are sunscreens too)
      if (expectedTitles) {
        expect([foreign, titles(a.resp).filter((title) => !/[\u3040-\u30ff\u3400-\u9fff]/.test(title)).sort()])
          .toEqual([foreign, [...expectedTitles].sort()]);
      }
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

  test('on: end to end, the debug bundle speaks the caller\'s language and the original never enters request metadata', async () => {
    Object.assign(process.env, BOTH_ON, { SEARCH_DEBUG_BUNDLE_ALLOW_PRIVATE_IP: 'true' });
    jest.doMock('../../src/db', () => ({
      query: async (sql) => (String(sql || '').includes(CANONICAL_MARKER) ? { rows: CATALOG } : { rows: [] }),
    }));
    const app = listen(owned(() => require('../../src/server')));
    const call = (query, metadata) =>
      owned(async () =>
        request(app)
          .post('/agent/shop/v1/invoke')
          .set('x-debug', '1')
          .send({ operation: 'find_products_multi', payload: { search: { query } }, ...(metadata ? { metadata } : {}) }),
      );
    // Queries whose lane runs after the context build (the early beauty lane answers before it and
    // records no intent at all).
    for (const [query, language] of [['레티놀', 'ko'], ['视黄醇', 'zh'], ['レチノール', 'ja'], ['crème hydratante', 'fr'], ['retinol', 'en']]) {
      for (const metadata of [null, { routing_original_query: query === '视黄醇' ? '레티놀' : '视黄醇' }]) {
        const resp = await call(query, metadata);
        const bundle = resp.body.debug_bundle || resp.body.metadata?.debug_bundle;
        expect([query, Boolean(bundle)]).toEqual([query, true]);
        expect([query, metadata, JSON.stringify(bundle).includes(`"locale":"${language}"`)]).toEqual([query, metadata, true]);
        // The gateway never writes the original into anything a response echoes.
        if (!metadata) expect([query, JSON.stringify(resp.body).includes('routing_original_query')]).toEqual([query, false]);
      }
    }
    // A rewritten query answered by a lane that echoes the request metadata (the safe-empty answer):
    // nothing about the original is in it.
    for (const query of ['선크림 return policy', '洗面奶 return policy']) {
      const resp = await call(query, null);
      expect([query, lane(resp)]).toEqual([query, LANES.SAFE_EMPTY]);
      expect([query, JSON.stringify(resp.body).includes('routing_original_query')]).toEqual([query, false]);
    }
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

  // Follow-up item 1: no response a routing flag can reach spreads the caller's request metadata.
  const CALLER = {
    routing_original_query: '洗面奶', routingOriginalQuery: 'レチノール', routingUserQuery: 'crème', zz_caller_sentinel: 'zz',
    // round 2: a spoofed service_version and nested keys
    service_version: { commit: 'HOSTILE_COMMIT', nested: { deep: 'HOSTILE_NESTED' } },
    zz_nested: { inner: { deeper: 'HOSTILE_DEEP' } },
  };
  const ECHO_MARKERS = ['routing_original_query', 'routingOriginalQuery', 'routingUserQuery', 'zz_caller_sentinel', 'HOSTILE_COMMIT',
    'HOSTILE_NESTED', 'zz_nested', 'HOSTILE_DEEP'];
  const echoed = (body) => ECHO_MARKERS.filter((marker) => JSON.stringify(body).includes(marker));
  const ECHO_QUERIES = ['retinol free', 'without retinol', 'retinolfrei', 'retinol 0%', 'niacinamide alternative',
    'retinol alternative for body', 'gift', 'return policy', '선크림 return policy', '洗面奶 return policy', 'retinol',
    'retinol alternative', 'crème hydratante', 'retinol-free cream', '레티놀 프리미엄', 'laptop', 'Lidschatten'];

  test('on: no answer echoes the caller\'s request metadata, the safe-empty included', async () => {
    const { send } = boot(BOTH_ON);
    for (const query of ECHO_QUERIES) {
      const { resp } = await send({ search: { query, page: 1, page_size: 20 } }, CALLER);
      expect([query, lane(resp), echoed(resp.body)]).toEqual([query, lane(resp), []]);
    }
    // each flag alone too -- including an agent-API surface query, which reaches the handler's
    // contract safe-empty with either flag
    for (const env of [{ FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on' }, { FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'on' }]) {
      jest.resetModules();
      for (const key of FLAG_KEYS) delete process.env[key];
      const one = boot(env);
      for (const query of ['retinol free', 'gift', '선크림 return policy', 'Lidschatten']) {
        const { resp } = await one.send({ search: { query, page: 1, page_size: 20 } }, CALLER);
        expect([env, query, echoed(resp.body)]).toEqual([env, query, []]);
      }
      const surface = await one.send({ search: { query: 'gift', page: 1, page_size: 20, catalog_surface: 'agent_api' } }, CALLER);
      expect([env, lane(surface.resp), echoed(surface.resp.body)]).toEqual([env, LANES.SAFE_EMPTY, []]);
    }
  }, 180000);

  test.each([
    ['flags off', {}],
    ['both observe', BOTH_OBSERVE],
  ])('%s: the safe-empty still echoes the caller metadata exactly as main does', async (_label, env) => {
    const { send } = boot(env);
    // the handler's contract safe-empty (the one answer on main that spreads request metadata)
    const { resp } = await send({ search: { query: 'Lidschatten', page: 1, page_size: 20 } }, CALLER);
    expect(lane(resp)).toBe(LANES.SAFE_EMPTY);
    expect(echoed(resp.body)).toEqual(ECHO_MARKERS);
    const surface = await send({ search: { query: 'gift', page: 1, page_size: 20, catalog_surface: 'agent_api' } }, CALLER);
    expect([lane(surface.resp), echoed(surface.resp.body)]).toEqual([LANES.SAFE_EMPTY, ECHO_MARKERS]);
  });

  test('on: the debug bundle\'s query is the caller\'s own text, never a metadata value (nb1_debug_raw)', async () => {
    Object.assign(process.env, BOTH_ON, { SEARCH_DEBUG_BUNDLE_ALLOW_PRIVATE_IP: 'true' });
    jest.doMock('../../src/db', () => ({
      query: async (sql) => (String(sql || '').includes(CANONICAL_MARKER) ? { rows: CATALOG } : { rows: [] }),
    }));
    const app = listen(owned(() => require('../../src/server')));
    const hostile = { routing_original_query: 'HOSTILE_ORIGINAL', routingOriginalQuery: 'HOSTILE_CAMEL', routingUserQuery: 'HOSTILE_USER' };
    for (const query of ['레티놀', 'retinol alternative', 'without retinol', 'crème hydratante', 'retinol']) {
      const resp = await owned(async () =>
        request(app).post('/agent/shop/v1/invoke').set('x-debug', '1')
          .send({ operation: 'find_products_multi', payload: { search: { query } }, metadata: hostile }));
      const bundle = resp.body.debug_bundle || resp.body.metadata?.debug_bundle;
      expect([query, Boolean(bundle)]).toEqual([query, true]);
      expect([query, JSON.stringify(bundle).includes(JSON.stringify(query).slice(1, -1))]).toEqual([query, true]);
      expect([query, /HOSTILE_/.test(JSON.stringify(resp.body))]).toEqual([query, false]);
    }
  }, 180000);

  test('mixed modes: the door applied is the ON flag\'s, the observed one only logs (door_shadow_on)', async () => {
    // bare on, multilingual observe: the Korean negation is not mapped, so its door has no exclusion,
    // and the answer is the bare-only one.
    // The English half uses a niacinamide exclusion: a retinol one ("retinol alternative serum") also
    // carries a retinoid safety signal, so the beauty gate removes the retinoid rows before the door
    // sees them and there is nothing left for the door to drop or count.
    const DOOR_QUERY = 'niacinamide-free serum';
    const bareOnly = boot({ FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on' });
    const bareOnlyKo = await bareOnly.invoke('레티놀 프리 크림');
    const bareOnlyEn = await bareOnly.invoke(DOOR_QUERY);
    jest.resetModules();
    for (const key of FLAG_KEYS) delete process.env[key];
    const mixed = boot({ FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on', FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'observe' });
    const mixedKo = await mixed.invoke('레티놀 프리 크림');
    expect(normalize(mixedKo.resp.body)).toEqual(normalize(bareOnlyKo.resp.body));
    expect(mixedKo.log.fpm_routing_query_would_normalize).toBe(true);
    expect(mixedKo.log.fpm_routing_query_normalized).toBe(false);
    const mixedEn = await mixed.invoke(DOOR_QUERY);
    expect(normalize(mixedEn.resp.body)).toEqual(normalize(bareOnlyEn.resp.body));
    expect(mixedEn.log.fpm_excluded_ingredient_dropped_count > 0).toBe(true);
    // bare observe, multilingual on: the door only counts (would_drop) and the body is the multilingual-only one.
    jest.resetModules();
    for (const key of FLAG_KEYS) delete process.env[key];
    const mlOnly = boot({ FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'on' });
    const mlOnlyEn = await mlOnly.invoke(DOOR_QUERY);
    jest.resetModules();
    for (const key of FLAG_KEYS) delete process.env[key];
    const shadow = boot({ FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'observe', FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'on' });
    const shadowEn = await shadow.invoke(DOOR_QUERY);
    expect(normalize(shadowEn.resp.body)).toEqual(normalize(mlOnlyEn.resp.body));
    expect(shadowEn.log.fpm_excluded_ingredient_would_drop_count > 0).toBe(true);
    expect(shadowEn.log.fpm_excluded_ingredient_dropped_count).toBeUndefined();
  }, 180000);

  test('on (round 2 / item 1): the safe-empty keeps the gateway\'s own fields and drops every caller value', async () => {
    const off = boot();
    const offAnswer = await off.send({ search: { query: 'gift', page: 1, page_size: 20, catalog_surface: 'agent_api' } }, CALLER);
    jest.resetModules();
    for (const key of FLAG_KEYS) delete process.env[key];
    const on = boot(BOTH_ON);
    const caller = { ...CALLER, source: 'agent-api-tests', market: 'US', creator_id: 'creator_123', query_understanding: { hostile: 'HOSTILE_QU' } };
    const onAnswer = await on.send({ search: { query: 'gift', page: 1, page_size: 20, catalog_surface: 'agent_api' } }, caller);
    const md = onAnswer.resp.body.metadata;
    expect(lane(onAnswer.resp)).toBe(LANES.SAFE_EMPTY);
    // the handler's own fields are all there ...
    for (const key of ['query_understanding', 'query_understanding_executed', 'query_understanding_decision', 'supplement_lanes',
      'search_request_contract', 'primary_lane', 'service_version', 'source']) {
      expect([key, Object.prototype.hasOwnProperty.call(md, key)]).toEqual([key, true]);
    }
    expect(Object.keys(md).filter((key) => !Object.prototype.hasOwnProperty.call(offAnswer.resp.body.metadata, key))
      .filter((key) => !['market', 'creator_id', 'creatorId'].includes(key))).toEqual([]);
    // ... with the gateway's values, never the caller's
    expect(md.service_version.commit).not.toBe('HOSTILE_COMMIT');
    expect(JSON.stringify(md.query_understanding)).not.toContain('HOSTILE_QU');
    expect(echoed(onAnswer.resp.body)).toEqual([]);
    // the attribution allowlist: short plain values only
    expect([md.source, md.market, md.creator_id]).toEqual(['agent-api-tests', 'US', 'creator_123']);
    const spoofed = await on.send({ search: { query: 'gift', page: 1, page_size: 20, catalog_surface: 'agent_api' } },
      { source: 'x'.repeat(65), market: 'NOT A MARKET', creator_id: { nested: 'HOSTILE_ID' } });
    // (the gateway's own query_understanding / search_request_contract record the source it used, on
    // every lane and with the flags off too; that is not an echo of the caller's metadata object)
    const spoofedMd = spoofed.resp.body.metadata;
    expect([spoofedMd.market, spoofedMd.source, spoofedMd.creator_id, spoofedMd.creatorId, JSON.stringify(spoofed.resp.body).includes('HOSTILE_ID')])
      .toEqual([undefined, undefined, undefined, undefined, false]);
  }, 180000);

  // Flip blockers B1-B3: the request metadata is not the only place the caller's attribution values come
  // from. normalizeMetadata also copies creator_id / creatorId / creator_name / creatorName / trace_id /
  // traceId / source from the payload, and creator_id from payload.search; those are the caller's too.
  const SURFACE_GIFT = { query: 'gift', page: 1, page_size: 20, catalog_surface: 'agent_api' };
  const ATTRIBUTION_KEYS = ['source', 'creator_id', 'creatorId', 'creator_name', 'creatorName', 'trace_id', 'traceId'];
  const attribution = (md) => Object.fromEntries(ATTRIBUTION_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(md, key)).map((key) => [key, md[key]]));

  test('on (flip B1): an attribution value the caller sent in the payload passes the same allowlist', async () => {
    const { send } = boot(BOTH_ON);
    const LONG_NAME = `HOSTILE_LONG_${'n'.repeat(5000)}`;
    const LONG_SOURCE = `HOSTILE_SOURCE_${'s'.repeat(298)}`;
    // [where the caller put it, payload]: each value is outside the allowlist and must not come back
    const cases = [
      ['payload.creator_name (object)', { search: SURFACE_GIFT, creator_name: { nested: 'HOSTILE_PAYLOAD_NAME' } }],
      ['payload.creatorName (5,000 chars)', { search: SURFACE_GIFT, creatorName: LONG_NAME }],
      ['payload.trace_id (object)', { search: SURFACE_GIFT, trace_id: { nested: 'HOSTILE_PAYLOAD_TRACE' } }],
      ['payload.traceId (markup)', { search: SURFACE_GIFT, traceId: 'HOSTILE<b>PTID' }],
      ['payload.creator_id (markup)', { search: SURFACE_GIFT, creator_id: 'HOSTILE<b>PCID' }],
      ['payload.creatorId (object)', { search: SURFACE_GIFT, creatorId: { nested: 'HOSTILE_PAYLOAD_CID' } }],
      ['payload.search.creator_id (markup)', { search: { ...SURFACE_GIFT, creator_id: 'HOSTILE<b>SCID' } }],
      ['payload.source (313 chars)', { search: SURFACE_GIFT, source: LONG_SOURCE }],
    ];
    for (const [where, payload] of cases) {
      const { resp } = await send(payload);
      const md = resp.body.metadata || {};
      expect([where, lane(resp)]).toEqual([where, LANES.SAFE_EMPTY]);
      expect([where, JSON.stringify(attribution(md)).includes('HOSTILE')]).toEqual([where, false]);
    }
    // a short plain payload value is on the allowlist and still comes back, under both spellings
    const plain = await send({ search: { ...SURFACE_GIFT, creator_id: 'creator_s1' }, creator_name: 'Plain Name', traceId: 'trace-p1', source: 'agent-api-tests' });
    expect(attribution(plain.resp.body.metadata)).toEqual({
      source: 'agent-api-tests', creator_id: 'creator_s1', creatorId: 'creator_s1', creator_name: 'Plain Name', creatorName: 'Plain Name',
      trace_id: 'trace-p1', traceId: 'trace-p1',
    });
    // the metadata still wins over the payload, as in normalizeMetadata, and both are the caller's
    const both = await send({ search: SURFACE_GIFT, creator_name: 'Payload Name' }, { creator_name: { nested: 'HOSTILE_META_NAME' } });
    expect(JSON.stringify(attribution(both.resp.body.metadata)).includes('HOSTILE')).toBe(false);
    // ... and an empty metadata value lets the payload's through: every value under a key is checked
    const emptyFirst = await send({ search: SURFACE_GIFT, creator_name: 'HOSTILE<b>AFTER_EMPTY' }, { creator_name: '' });
    expect(JSON.stringify(attribution(emptyFirst.resp.body.metadata)).includes('HOSTILE')).toBe(false);
  }, 180000);

  test('on (flip B2): metadata that is not an object echoes nothing of it', async () => {
    const { send } = boot(BOTH_ON);
    for (const metadata of [['HOSTILE_ARRAY_0', { x: 'HOSTILE_ARRAY_1' }], 'HOSTILE_STRING_METADATA_23']) {
      const { resp } = await send({ search: SURFACE_GIFT }, metadata);
      const md = resp.body.metadata || {};
      expect([metadata, lane(resp)]).toEqual([metadata, LANES.SAFE_EMPTY]);
      expect([metadata, Object.keys(md).filter((key) => /^\d+$/.test(key))]).toEqual([metadata, []]);
      expect([metadata, JSON.stringify(md).includes('HOSTILE_ARRAY')]).toEqual([metadata, false]);
    }
  }, 180000);

  test('off: metadata that is not an object is still spread exactly as main spreads it', async () => {
    const { send } = boot();
    const { resp } = await send({ search: SURFACE_GIFT }, ['ARRAY_0', { x: 'ARRAY_1' }]);
    expect([lane(resp), resp.body.metadata['0'], resp.body.metadata['1']]).toEqual([LANES.SAFE_EMPTY, 'ARRAY_0', { x: 'ARRAY_1' }]);
  });

  test('on (flip B3): query_understanding.source follows the top-level source allowlist decision', async () => {
    const { send } = boot(BOTH_ON);
    const rejected = [`HOSTILE_QU_${'s'.repeat(80)}`, 'HOSTILE<b>QU'];
    for (const source of rejected) {
      for (const [where, payload, metadata] of [
        ['metadata.source', { search: SURFACE_GIFT }, { source }],
        ['payload.source', { search: SURFACE_GIFT, source }, null],
      ]) {
        const { resp } = await send(payload, metadata);
        const md = resp.body.metadata || {};
        expect([where, lane(resp), md.source]).toEqual([where, LANES.SAFE_EMPTY, undefined]);
        expect([where, md.query_understanding && typeof md.query_understanding === 'object']).toEqual([where, true]);
        expect([where, Object.prototype.hasOwnProperty.call(md.query_understanding, 'source')]).toEqual([where, false]);
        expect([where, JSON.stringify(md).includes('HOSTILE')]).toEqual([where, false]);
      }
    }
    // an allowed source is kept in both places
    const ok = await send({ search: SURFACE_GIFT }, { source: 'agent-api-tests' });
    expect([ok.resp.body.metadata.source, ok.resp.body.metadata.query_understanding.source]).toEqual(['agent-api-tests', 'agent-api-tests']);
  }, 180000);

  test('on (flip X3): a market echoes only as a market code the gateway prices for, written as such', async () => {
    const { send } = boot(BOTH_ON);
    for (const market of ['us', 'usa', 'USA', 'Us', 'XX', 'ZZ', ' US', 'US\n']) {
      const { resp } = await send({ search: SURFACE_GIFT }, { market });
      const md = resp.body.metadata || {};
      expect([market, lane(resp), Object.prototype.hasOwnProperty.call(md, 'market')]).toEqual([market, LANES.SAFE_EMPTY, false]);
      // query_understanding records the market it read upcased; a rejected one goes there too
      expect([market, md.query_understanding?.market]).toEqual([market, undefined]);
    }
    for (const market of ['US', 'GB', 'JP']) {
      const { resp } = await send({ search: SURFACE_GIFT }, { market });
      expect([market, resp.body.metadata.market, resp.body.metadata.query_understanding.market]).toEqual([market, market, market]);
    }
    // only the recorded copy OF the rejected value goes: a market query_understanding read from the
    // search itself stays
    const fromSearch = await send({ search: { ...SURFACE_GIFT, market: 'GB' } }, { market: 'usa' });
    expect([lane(fromSearch.resp), fromSearch.resp.body.metadata.market, fromSearch.resp.body.metadata.query_understanding.market])
      .toEqual([LANES.SAFE_EMPTY, undefined, 'GB']);
  }, 180000);

  test('on (flip): a creator name with control, bidi or line-separator characters, or a script scheme, is not echoed', async () => {
    const { send } = boot(BOTH_ON);
    for (const name of ['Jane‮eoD', 'Jane Doe', 'Jane⁦Doe', 'Jane‏Doe', 'Jane\u0085Doe', 'javascript:alert(1)',
      ' JavaScript:alert(1)', 'data:text/html,x']) {
      for (const [where, payload, metadata] of [['metadata', { search: SURFACE_GIFT }, { creator_name: name }], ['payload', { search: SURFACE_GIFT, creatorName: name }, null]]) {
        const { resp } = await send(payload, metadata);
        const md = resp.body.metadata || {};
        expect([where, name, md.creator_name, md.creatorName]).toEqual([where, name, undefined, undefined]);
      }
    }
    const plain = await send({ search: SURFACE_GIFT }, { creator_name: 'Jane O\'Doe: Reviews' });
    expect([plain.resp.body.metadata.creator_name, plain.resp.body.metadata.creatorName]).toEqual(['Jane O\'Doe: Reviews', 'Jane O\'Doe: Reviews']);
  }, 180000);

  test.each([
    ['flags off', {}],
    ['both flags on', BOTH_ON],
  ])('%s: a null metadata reads as none (it was a 500)', async (_label, env) => {
    const { app } = boot(env);
    const resp = await owned(async () =>
      request(app).post('/agent/shop/v1/invoke').send({ operation: 'find_products_multi', payload: { search: SURFACE_GIFT }, metadata: null }));
    expect([resp.status, lane(resp)]).toEqual([200, LANES.SAFE_EMPTY]);
  });

  test('on (round 2 / items 2-5): explicit list joiners, the shared family, budgets and unfiled rows', async () => {
    const { invoke } = boot(BOTH_ON);
    // 2: two ingredients side by side are not a list
    for (const [query, mustContain] of [['niacinamide retinol-free serum', REAL_NIACINAMIDE], ['vitamin c retinol-free serum', REAL_VITAMIN_C]]) {
      const got = titles((await invoke(query)).resp);
      expect([query, got.some((title) => mustContain.includes(title))]).toEqual([query, true]);
      for (const title of got) expect([query, title, REAL_RETINOL.includes(title) || RETINOID_FAMILY.includes(title)]).toEqual([query, title, false]);
    }
    const standInSerum = await invoke('bakuchiol retinol alternative serum');
    expect(titles(standInSerum.resp).length > 0 && standInSerum.resp.body.products.every(namesBakuchiol)).toBe(true);
    // "bakuchiol, and retinol-free": bakuchiol is the ask (the ingredient lane), retinol the exclusion. (Its
    // one bakuchiol serum is then removed by main's retinoid safety gate, which reads "retinol-free" as
    // avoid-retinoids and the title's "Retinol Alternative" as a retinoid: not this change.)
    const listed = await invoke('bakuchiol and retinol free serum');
    expect(lane(listed.resp)).toBe(LANES.INGREDIENT);
    for (const product of listed.resp.body.products) expect([product.title, namesBakuchiol(product)]).toEqual([product.title, true]);
    // 3: the shared family, by a family word in the query too
    for (const query of ['retinoid free serum', 'retinol alternative serum', 'retinol-free cream', 'sans rétinoïde crème']) {
      for (const title of titles((await invoke(query)).resp)) {
        expect([query, title, RETINOID_FAMILY.includes(title) || REAL_RETINOL.includes(title)]).toEqual([query, title, false]);
      }
    }
    // 4: the budget travels (every fixture row costs 24.00)
    for (const [query, empty] of [['retinol alternative 20 dollars', true], ['retinol alternative under €20', true], ['retinol alternative $15', true],
      ['retinol alternative 30 dollars', false], ['low price retinol alternative', false]]) {
      const { resp, log } = await invoke(query);
      expect([query, lane(resp), log.fpm_routing_query_rewrite, titles(resp).length === 0]).toEqual([query, LANES.INGREDIENT, 'stand_in_known', empty]);
    }
    // 5: an unfiled row is judged by what its title names, never by a negated category word
    const ask = titles((await invoke('retinol alternative')).resp);
    expect(ask).toContain('Shampoo-Free Bakuchiol Serum');
    expect(ask).not.toContain('바쿠치올 데일리 샴푸');
  }, 180000);

  test('on (follow-up 2): a retinol stand-in or exclusion excludes the whole retinoid family', async () => {
    const { invoke } = boot(BOTH_ON);
    for (const query of ['retinol alternative serum', 'retinol alternative 크림', 'retinol-free serum', 'retinol-free cream',
      'serum without retinol', 'retinol alternative', 'bakuchiol instead of retinol']) {
      const { resp } = await invoke(query);
      for (const title of titles(resp)) {
        expect([query, title, RETINOID_FAMILY.includes(title) || REAL_RETINOL.includes(title)]).toEqual([query, title, false]);
      }
    }
    const serums = titles((await invoke('retinol alternative serum')).resp);
    expect(serums).toContain('Bakuchiol Retinol Alternative Serum');
    // follow-up 4: a row with no category path is judged by its own title -- a hair oil is not
    // skincare, an unfiled booster is kept (fail safe)
    const askTitles = titles((await invoke('retinol alternative')).resp);
    expect(askTitles).toContain('Bakuchiol Booster Drops');
    expect(askTitles).not.toContain('Bakuchiol Hair Oil');
    // ... while asking FOR retinol is unchanged: only rows that name retinol itself.
    const retinol = titles((await invoke('retinol')).resp);
    for (const title of RETINOID_FAMILY) expect([title, retinol.includes(title)]).toEqual([title, false]);
  });

  test('on (follow-up 3): face / skin, price words and "premium" no longer clarify', async () => {
    const { invoke } = boot(BOTH_ON);
    for (const query of ['retinol alternative for face', 'retinol alternative for skin', 'retinol alternative for my face']) {
      const { resp, log } = await invoke(query);
      expect([query, lane(resp), log.fpm_routing_query_rewrite]).toEqual([query, LANES.INGREDIENT, 'stand_in_known']);
      expect([query, titles(resp).length > 0 && resp.body.products.every(namesBakuchiol)]).toEqual([query, true]);
    }
    // the budget travels with the rewrite: every fixture row costs 24.00
    const under20 = await invoke('cheap retinol alternative under $20');
    expect([lane(under20.resp), under20.log.fpm_routing_query_rewrite, titles(under20.resp)]).toEqual([LANES.INGREDIENT, 'stand_in_known', []]);
    const under30 = await invoke('cheap retinol alternative under $30');
    expect(lane(under30.resp)).toBe(LANES.INGREDIENT);
    expect(titles(under30.resp).length > 0 && under30.resp.body.products.every(namesBakuchiol)).toBe(true);
    const premium = await invoke('레티놀 프리미엄');
    expect(lane(premium.resp)).toBe(LANES.INGREDIENT);
    for (const title of titles(premium.resp)) expect([title, REAL_RETINOL.includes(title)]).toEqual([title, true]);
  });

  test('on (follow-up 5/6): list qualifiers, glued "free", spaced esters, plural vitamins, 不含', async () => {
    const { invoke } = boot(BOTH_ON);
    // a qualifier on a list qualifies every member
    for (const query of ['alternative to retinol and niacinamide', 'retinol and niacinamide alternative']) {
      expect([query, lane((await invoke(query)).resp)]).toEqual([query, LANES.SAFE_EMPTY]);
    }
    const named = await invoke('bakuchiol instead of retinol and niacinamide');
    expect(lane(named.resp)).toBe(LANES.INGREDIENT);
    expect(titles(named.resp).length > 0 && named.resp.body.products.every(namesBakuchiol)).toBe(true);
    const both = await invoke('without retinol and niacinamide serum');
    expect(lane(both.resp)).not.toBe(LANES.INGREDIENT);
    for (const title of titles(both.resp)) {
      expect([title, REAL_RETINOL.includes(title) || REAL_NIACINAMIDE.includes(title)]).toEqual([title, false]);
    }
    const retinol = titles((await invoke('retinol')).resp);
    for (const title of ['Retinol-Free Sample Cream', '레티놀 팔미테이트 크림', '不含视黄醇面霜']) {
      expect([title, retinol.includes(title)]).toEqual([title, false]);
    }
    expect(titles((await invoke('vitamin c')).resp)).toContain('Витамины С и Е сыворотка');
  });

  test('bare flag alone: "retinol crème" routes like "retinol" (the form noun is the multilingual flag\'s)', async () => {
    const bareOnly = boot({ FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on' });
    const creme = await bareOnly.invoke('retinol crème');
    const plain = await bareOnly.invoke('retinol');
    expect([lane(creme.resp), ids(creme.resp)]).toEqual([LANES.INGREDIENT, ids(plain.resp)]);
    jest.resetModules();
    for (const key of FLAG_KEYS) delete process.env[key];
    const on = boot(BOTH_ON);
    const onCreme = await on.invoke('retinol crème');
    const onCream = await on.invoke('retinol cream');
    expect([lane(onCreme.resp), ids(onCreme.resp)]).toEqual([lane(onCream.resp), ids(onCream.resp)]);
  });

  test('off: the lane gate reads substrings, as on main (gate_intents_always)', async () => {
    const { invoke } = boot();
    for (const query of ['retinol free serum', 'retinolfrei', 'without retinol serum', 'retinol alternative serum']) {
      const { resp, log } = await invoke(query);
      expect([query, lane(resp)]).toEqual([query, LANES.INGREDIENT]);
      expect([query, Object.keys(log).filter((key) => /^fpm_routing|would_/.test(key))]).toEqual([query, []]);
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
