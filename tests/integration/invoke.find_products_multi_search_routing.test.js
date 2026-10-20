/**
 * find_products_multi routing for bare ingredients and non-English beauty terms, on the real invoke
 * route with a mocked database (a fixed fixture catalog answers every canonical-catalog statement, so
 * which rows come back is decided by the lanes' own gates, not by SQL text matching).
 *
 * Flags (both default off; see src/findProductsMulti/queryRoutingNormalizer.js):
 *   FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING  a query that is only a known ingredient reaches the
 *     ingredient lane; negated mentions are not ingredient intents; the lane admits only rows that NAME
 *     the ingredient (title / structured ingredient fields, whole words, not negated).
 *   FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING  known non-English beauty terms route like their English
 *     equivalents.
 *
 * Pinned here:
 *   - off: the measured misroutes (retinol -> clarify, hyaluronic acid -> backend lane, 선크림 -> backend
 *     lane, crème hydratante / 洗面奶 -> clarify), and unset == explicit off, byte for byte;
 *   - on: bare ingredients return only rows that name the ingredient (no "Retinol-Free", no
 *     "Retinol Alternative", no "Vitamin E" for vitamin c), in every language;
 *   - on: non-English category queries return exactly the rows their English equivalent returns;
 *   - on: negations route away from the ingredient lane and never return the negated ingredient;
 *   - on: non-beauty and ambiguous queries route exactly as before.
 */

const nock = require('nock');
const request = require('supertest');

const CANONICAL_MARKER = 'WITH candidate_products';

function row(key, title, categoryPath, { actives = [], productType = 'Skincare', description = null } = {}) {
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
      seed_data: { price_amount: '24.00', price_currency: 'USD', availability: 'in stock', active_ingredients: actives },
    },
    rank_score: 90,
  };
}

const CATALOG = [
  row('retinol_serum', 'Retinol 0.3% Night Serum', 'beauty/skincare/treat/serum', { actives: ['retinol'], productType: 'Serum' }),
  row('retinol_cream', 'Retinol Renewal Night Cream', 'beauty/skincare/moisturize/cream', { actives: ['retinol'], productType: 'Moisturizer' }),
  row('retinol_free_moist', 'Retinol-Free Barrier Moisturizer', 'beauty/skincare/moisturize/cream', { actives: ['ceramide'], productType: 'Moisturizer' }),
  row('retinol_free_serum', 'Retinol-Free Gentle Night Serum', 'beauty/skincare/treat/serum', { actives: ['peptides'], productType: 'Serum' }),
  row('bakuchiol', 'Bakuchiol Retinol Alternative Serum', 'beauty/skincare/treat/serum', { actives: ['bakuchiol'], productType: 'Serum' }),
  row('desc_only', 'Gentle Night Serum', 'beauty/skincare/treat/serum', { actives: ['squalane'], productType: 'Serum', description: 'Free of retinol. Pairs well with retinol.' }),
  row('ha_serum', 'Hyaluronic Acid 2% Hydrating Serum', 'beauty/skincare/treat/serum', { actives: ['hyaluronic acid'], productType: 'Serum' }),
  row('niacinamide_serum', 'Niacinamide 10% Serum', 'beauty/skincare/treat/serum', { actives: ['niacinamide'], productType: 'Serum' }),
  row('vit_c', 'Vitamin C 15% Serum', 'beauty/skincare/treat/serum', { actives: ['ascorbic acid'], productType: 'Serum' }),
  row('vit_e', 'Vitamin E Serum', 'beauty/skincare/treat/serum', { actives: ['tocopherol'], productType: 'Serum' }),
  row('plain_moist', 'Daily Moisturizing Cream', 'beauty/skincare/moisturize/cream', { actives: ['glycerin'], productType: 'Moisturizer' }),
  row('sunscreen', 'Daily Sunscreen SPF 50', 'beauty/skincare/sun/sunscreen', { actives: ['zinc oxide'], productType: 'Sunscreen' }),
  row('cleanser', 'Gentle Foaming Face Cleanser', 'beauty/skincare/cleanse/cleanser', { actives: ['glycerin'], productType: 'Cleanser' }),
  row('lipstick', 'Velvet Matte Lipstick', 'beauty/makeup/lip/lipstick', { productType: 'Lipstick' }),
  row('shampoo', 'Repair Shampoo', 'beauty/haircare/shampoo', { productType: 'Shampoo' }),
];

const LANES = {
  INGREDIENT: 'agent_products_ingredient_recall_direct',
  MAINLINE: 'agent_products_beauty_external_seed_mainline',
  SAFE_EMPTY: 'search_quality_contract_v1_safe_empty',
  BACKEND: 'agent_products_search',
};

const FLAG_KEYS = ['FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING', 'FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING'];
const BOTH_ON = {
  FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on',
  FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'on',
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

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => String(host || '').includes('127.0.0.1') || String(host || '').includes('localhost'));
    prevEnv = { ...process.env };
    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://search-routing-test';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    process.env.GATEWAY_RATE_LIMIT_ENABLED = 'false';
    delete process.env.INDEX_ELIGIBLE_RECALL;
    for (const key of FLAG_KEYS) delete process.env[key];
    // The backend text lane answers empty; it is only ever the lane a misrouted query falls to.
    nock('http://pivota.test')
      .persist()
      .post(/.*/)
      .reply(200, { status: 'success', products: [], total: 0 })
      .get(/.*/)
      .reply(200, { status: 'success', products: [], total: 0 });
  });

  afterEach(() => {
    process.env = prevEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  function boot(env = {}) {
    Object.assign(process.env, env);
    jest.doMock('../../src/db', () => ({
      query: async (sql) => (String(sql || '').includes(CANONICAL_MARKER) ? { rows: CATALOG } : { rows: [] }),
    }));
    const logger = require('../../src/logger');
    const completionLines = [];
    const originalInfo = logger.info.bind(logger);
    logger.info = (obj, msg, ...rest) => {
      if (msg === 'invoke request complete') completionLines.push(obj);
      return originalInfo(obj, msg, ...rest);
    };
    const app = require('../../src/server');
    const invoke = async (query) => {
      const resp = await request(app)
        .post('/agent/shop/v1/invoke')
        .send({ operation: 'find_products_multi', payload: { search: { query, page: 1, page_size: 20 } } });
      await delay(10);
      return { resp, log: completionLines[completionLines.length - 1] || {} };
    };
    return { invoke };
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
      expect(log.fpm_routing_query_normalized).toBeUndefined();
    }
  });

  test('off: the ingredient lane admits rows that do not name the ingredient (the gap the flag closes)', async () => {
    const { invoke } = boot();
    const { resp } = await invoke('retinol serum');
    expect(lane(resp)).toBe(LANES.INGREDIENT);
    expect(titles(resp)).toEqual(expect.arrayContaining(['Retinol-Free Gentle Night Serum', 'Bakuchiol Retinol Alternative Serum']));
  });

  test('unset flags and explicit off answer byte-identically (volatile fields aside)', async () => {
    const queries = ['retinol', 'retinol serum', '선크림', 'crème hydratante', 'moisturizer without retinol', 'laptop'];
    const unset = boot();
    const a = [];
    for (const query of queries) a.push((await unset.invoke(query)).resp.body);
    jest.resetModules();
    const off = boot({
      FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'off',
      FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'off',
    });
    for (let i = 0; i < queries.length; i += 1) {
      const b = (await off.invoke(queries[i])).resp.body;
      expect(normalize(b)).toEqual(normalize(a[i]));
    }
  });

  test('on: a bare ingredient reaches the ingredient lane and returns only rows that name it', async () => {
    const { invoke } = boot(BOTH_ON);
    const expected = {
      retinol: ['Retinol 0.3% Night Serum', 'Retinol Renewal Night Cream'],
      Retinol: ['Retinol 0.3% Night Serum', 'Retinol Renewal Night Cream'],
      'hyaluronic acid': ['Hyaluronic Acid 2% Hydrating Serum'],
      niacinamide: ['Niacinamide 10% Serum'],
      'vitamin c': ['Vitamin C 15% Serum'],
      'best retinol products': ['Retinol 0.3% Night Serum', 'Retinol Renewal Night Cream'],
    };
    for (const [query, expectedTitles] of Object.entries(expected)) {
      const { resp } = await invoke(query);
      expect([query, lane(resp)]).toEqual([query, LANES.INGREDIENT]);
      expect([query, titles(resp).sort()]).toEqual([query, [...expectedTitles].sort()]);
    }
  });

  test('on: retinol-free, retinol alternatives, description-only mentions and vitamin E never answer an ingredient query', async () => {
    const { invoke } = boot(BOTH_ON);
    for (const query of ['retinol', 'retinol serum', '레티놀', 'rétinol']) {
      const { resp } = await invoke(query);
      expect(lane(resp)).toBe(LANES.INGREDIENT);
      const got = titles(resp);
      expect(got.length).toBeGreaterThan(0);
      for (const title of got) expect([query, title]).toEqual([query, expect.stringMatching(/^Retinol (0\.3%|Renewal)/)]);
      expect(resp.body.metadata.ingredient_direct_admission_dropped_count).toBeGreaterThan(0);
    }
    const vitaminC = await invoke('vitamin c');
    expect(titles(vitaminC.resp)).not.toContain('Vitamin E Serum');
  });

  test('on: a bare ingredient in another language returns exactly what the English ingredient returns', async () => {
    const { invoke } = boot(BOTH_ON);
    const pairs = [
      ['레티놀', 'retinol'],
      ['レチノール', 'retinol'],
      ['视黄醇', 'retinol'],
      ['rétinol', 'retinol'],
      ['acide hyaluronique', 'hyaluronic acid'],
      ['ácido hialurónico', 'hyaluronic acid'],
      ['Hyaluronsäure', 'hyaluronic acid'],
      ['玻尿酸', 'hyaluronic acid'],
      ['ナイアシンアミド', 'niacinamide'],
      ['비타민C', 'vitamin c'],
    ];
    for (const [foreign, english] of pairs) {
      const a = await invoke(foreign);
      const b = await invoke(english);
      expect([foreign, lane(a.resp)]).toEqual([foreign, LANES.INGREDIENT]);
      expect([foreign, ids(a.resp)]).toEqual([foreign, ids(b.resp)]);
      expect(a.log).toEqual(expect.objectContaining({ fpm_routing_query_normalized: true }));
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
      ['crème hydratante', 'moisturizer', ['Daily Moisturizing Cream', 'Retinol-Free Barrier Moisturizer']],
      ['hydratant', 'moisturizer', ['Daily Moisturizing Cream', 'Retinol-Free Barrier Moisturizer']],
      ['crema hidratante', 'moisturizer', ['Daily Moisturizing Cream', 'Retinol-Free Barrier Moisturizer']],
      ['Feuchtigkeitscreme', 'moisturizer', ['Daily Moisturizing Cream', 'Retinol-Free Barrier Moisturizer']],
      ['Lippenstift', 'lipstick', ['Velvet Matte Lipstick']],
      ['labial', 'lipstick', ['Velvet Matte Lipstick']],
    ];
    for (const [foreign, english, expectedTitles] of pairs) {
      const a = await invoke(foreign);
      const b = await invoke(english);
      expect([foreign, lane(a.resp)]).toEqual([foreign, lane(b.resp)]);
      expect([foreign, lane(a.resp)]).toEqual([foreign, LANES.MAINLINE]);
      expect([foreign, ids(a.resp)]).toEqual([foreign, ids(b.resp)]);
      // Relevant rows only: the category's own rows, nothing from another category.
      expect([foreign, titles(a.resp).sort()]).toEqual([foreign, [...expectedTitles].sort()]);
    }
  });

  test('on: negations route away from the ingredient lane and never return the negated ingredient', async () => {
    const { invoke } = boot(BOTH_ON);
    for (const query of ['moisturizer without retinol', 'retinol-free moisturizer', 'no retinol moisturizer',
      'crème hydratante sans rétinol', '不含视黄醇 保湿霜', '레티놀 없는 수분크림']) {
      const { resp } = await invoke(query);
      expect([query, lane(resp)]).toEqual([query, LANES.MAINLINE]);
      const got = titles(resp);
      expect(got.length).toBeGreaterThan(0);
      for (const title of got) expect([query, /^Retinol (0\.3%|Renewal)/.test(title)]).toEqual([query, false]);
      expect(resp.body.metadata.search_quality_contract.hard_constraints.exclusions).toContain('retinoid_forward');
    }
  });

  test('on: non-beauty and ambiguous queries route exactly as with the flags off', async () => {
    const queries = ['laptop', 'running shoes', 'kitchen cleaner', 'air conditioner', 'printer toner', '프린터 토너',
      'limpiador de cocina', 'acondicionador de aire', 'creme brulee', 'crème', 'máscara', '크림', '마스크', 'Sonnenschutz',
      'vitamin c supplement', 'mask', 'gift'];
    const off = boot();
    const before = [];
    for (const query of queries) before.push((await off.invoke(query)).resp);
    jest.resetModules();
    const on = boot(BOTH_ON);
    for (let i = 0; i < queries.length; i += 1) {
      const { resp, log } = await on.invoke(queries[i]);
      expect([queries[i], lane(resp), ids(resp)]).toEqual([queries[i], lane(before[i]), ids(before[i])]);
      expect(log.fpm_routing_query_normalized).toBeUndefined();
    }
  });

  test('on: a top-level payload.query is normalised in both copies of the request, like search.query', async () => {
    const { invoke } = boot(BOTH_ON);
    const app = require('../../src/server');
    for (const [foreign, english] of [['선크림', 'sunscreen'], ['레티놀', 'retinol'], ['洗面奶', 'cleanser']]) {
      const topLevel = await request(app)
        .post('/agent/shop/v1/invoke')
        .send({ operation: 'find_products_multi', payload: { query: foreign, page: 1, page_size: 20 } });
      const english_ = await request(app)
        .post('/agent/shop/v1/invoke')
        .send({ operation: 'find_products_multi', payload: { query: english, page: 1, page_size: 20 } });
      expect([foreign, lane(topLevel)]).toEqual([foreign, lane(english_)]);
      expect([foreign, ids(topLevel)]).toEqual([foreign, ids(english_)]);
      expect([foreign, topLevel.body.metadata?.route_health?.primary_path_used]).toEqual([
        foreign,
        english_.body.metadata?.route_health?.primary_path_used,
      ]);
    }
    expect(typeof invoke).toBe('function');
  });

  test('each flag alone does only its own part', async () => {
    const bare = boot({ FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on' });
    expect(lane((await bare.invoke('retinol')).resp)).toBe(LANES.INGREDIENT);
    expect(lane((await bare.invoke('선크림')).resp)).toBe(LANES.BACKEND);
    jest.resetModules();
    const multi = boot({ FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'on' });
    expect(lane((await multi.invoke('선크림')).resp)).toBe(LANES.MAINLINE);
    // Multilingual alone maps 레티놀 -> retinol, which then routes exactly like English "retinol" with the
    // bare-ingredient flag off.
    expect(lane((await multi.invoke('레티놀')).resp)).toBe(lane((await multi.invoke('retinol')).resp));
  });
});
