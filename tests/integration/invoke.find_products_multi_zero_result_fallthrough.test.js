/**
 * Zero-result fallthrough on the invoke route (FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH).
 *
 * The ingredient-direct lane answers its own request, and before this flag an empty answer stayed
 * empty. These tests drive the real route with a mocked database and pin:
 *   - off: the lane answers exactly as before, and the completion log gains nothing;
 *   - observe: the same answer, no extra lane, and the decision on the completion log;
 *   - on: a healthy lane that found nothing answers empty (no retry);
 *   - on: a lane that timed out or errored is retried on the beauty mainline inside the remaining
 *     budget, and retry rows that do not pass the ingredient lane's own relevance rules are dropped;
 *   - refusals, merchant scope and strict surfaces are never widened;
 *   - the deadline is never extended (budget skip, capped leg, slow next lane);
 *   - lanes with no next lane answer unchanged.
 *
 * The decision logic itself is unit-tested in
 * tests/find_products_multi_zero_result_fallthrough.node.test.cjs.
 */

const nock = require('nock');
const request = require('supertest');

const CANONICAL_MARKER = 'WITH candidate_products';

function serumRows(count = 8, prefix = 'serum', title = 'Niacinamide 10% Brightening Serum') {
  return Array.from({ length: count }, (_, index) => ({
    merchant_id: 'external_seed',
    product_key: `prod::external_seed::external_seed::ext_${prefix}_${index}`,
    platform: 'external_seed',
    source_product_id: `ext_${prefix}_${index}`,
    pivota_signature_id: `sig_${prefix}_${index}`,
    pivota_canonical_url: `https://agent.pivota.cc/products/sig_${prefix}_${index}`,
    product_title: `${title} ${index}`,
    product_description: `Lightweight ${title.toLowerCase()}.`,
    brand: index % 2 ? 'Test Brand A' : 'Test Brand B',
    product_type: 'Serum',
    category: 'Serum',
    category_path: 'beauty/skincare/treat/serum',
    canonical_url: `https://brand.example/products/${prefix}-${index}`,
    product_image_url: `https://cdn.example.com/${prefix}-${index}.jpg`,
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
        active_ingredients: /niacinamide/i.test(title) ? ['niacinamide'] : ['glycerin'],
      },
    },
    rank_score: 90,
  }));
}

const never = () => new Promise(() => {});
// What a failed database read looks like to the lane (not its own stage-budget timeout).
const broken = () => Promise.reject(Object.assign(new Error('connection terminated unexpectedly'), { code: 'ECONNRESET' }));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Recursively drops the fields that differ between any two runs of the same request (timings, ids,
// and the process start stamp in service_version, which differs because each run boots the app).
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

const FALLTHROUGH_LOG_KEYS = [
  'fpm_lane_chain',
  'fpm_fallthrough',
  'fpm_fallthrough_used',
  'fpm_empty_reason',
  'fpm_empty_class',
  'fpm_fallthrough_relevance_dropped',
  'fpm_fallthrough_skip_reason',
  'fpm_fallthrough_outcome',
  'fpm_fallthrough_next_lane',
  'fpm_fallthrough_budget_ms',
  'fpm_fallthrough_ms',
];

describe('find_products_multi zero-result fallthrough', () => {
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
    process.env.DATABASE_URL = 'postgres://zero-result-test';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    delete process.env.INDEX_ELIGIBLE_RECALL;
    delete process.env.FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH;
    delete process.env.FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_DEADLINE_MS;
    delete process.env.FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_MIN_BUDGET_MS;
    // Any upstream search call answers empty; the lanes under test never need it.
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

  // `canonical` answers the N-th canonical-catalog statement (0 = the first one the request issues).
  // Every other statement (seed reads) answers no rows.
  function boot({ mode, env = {}, canonical = () => ({ rows: [] }) } = {}) {
    if (mode) process.env.FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH = mode;
    Object.assign(process.env, env);
    const calls = { canonical: 0 };
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes(CANONICAL_MARKER)) {
          const index = calls.canonical;
          calls.canonical += 1;
          return canonical(index);
        }
        return { rows: [] };
      },
    }));
    const logger = require('../../src/logger');
    const completionLines = [];
    const originalInfo = logger.info.bind(logger);
    logger.info = (obj, msg, ...rest) => {
      if (msg === 'invoke request complete') completionLines.push(obj);
      return originalInfo(obj, msg, ...rest);
    };
    const app = require('../../src/server');
    const invoke = async (search) => {
      const startedAt = Date.now();
      const resp = await request(app)
        .post('/agent/shop/v1/invoke')
        .send({ operation: 'find_products_multi', payload: { search: { page: 1, page_size: 10, ...search } } });
      const elapsedMs = Date.now() - startedAt;
      await delay(20);
      return { resp, elapsedMs, log: completionLines[completionLines.length - 1] || {} };
    };
    return { invoke, calls };
  }

  function fallthroughLogFields(log) {
    return Object.fromEntries(Object.entries(log).filter(([key]) => FALLTHROUGH_LOG_KEYS.includes(key)));
  }

  test('off: an empty ingredient lane answers exactly as before, with no new log fields', async () => {
    const { invoke, calls } = boot({ mode: 'off' });
    const { resp, log } = await invoke({ query: 'niacinamide serum' });
    expect(resp.status).toBe(200);
    expect(resp.body.metadata.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata.zero_result_fallthrough).toBeUndefined();
    // Only the ingredient lane's own canonical statement ran: no second lane.
    expect(calls.canonical).toBe(1);
    expect(fallthroughLogFields(log)).toEqual({});
  });

  test('unset flag and explicit off answer byte-identically (volatile fields aside)', async () => {
    const unset = boot({});
    const a = await unset.invoke({ query: 'niacinamide serum' });
    jest.resetModules();
    const off = boot({ mode: 'off' });
    const b = await off.invoke({ query: 'niacinamide serum' });
    expect(normalize(b.resp.body)).toEqual(normalize(a.resp.body));
  });

  test('observe: same answer as off, no extra lane, and the decision on the completion line', async () => {
    const env = { FPM_INGREDIENT_CANONICAL_STAGE_BUDGET_MS: '600' };
    const off = boot({ mode: 'off', env, canonical: () => never() });
    const baseline = await off.invoke({ query: 'niacinamide serum' });
    jest.resetModules();
    const { invoke, calls } = boot({ mode: 'observe', env, canonical: () => never() });
    const { resp, log } = await invoke({ query: 'niacinamide serum' });
    expect(normalize(resp.body)).toEqual(normalize(baseline.resp.body));
    expect(calls.canonical).toBe(1);
    expect(fallthroughLogFields(log)).toEqual(
      expect.objectContaining({
        fpm_lane_chain: 'ingredient_direct',
        fpm_fallthrough: 'observed',
        fpm_fallthrough_used: false,
        fpm_empty_reason: 'lane_timeout',
        fpm_empty_class: 'degraded',
        fpm_fallthrough_next_lane: 'beauty_mainline',
      }),
    );
    expect(log.fpm_fallthrough_budget_ms).toBeGreaterThan(0);
  });

  test('observe: a healthy empty lane is logged as genuinely empty', async () => {
    const { invoke, calls } = boot({ mode: 'observe' });
    const { log } = await invoke({ query: 'niacinamide serum' });
    expect(calls.canonical).toBe(1);
    expect(fallthroughLogFields(log)).toEqual({
      fpm_lane_chain: 'ingredient_direct',
      fpm_fallthrough: 'skipped',
      fpm_fallthrough_used: false,
      fpm_empty_reason: 'no_catalog_match',
      fpm_empty_class: 'genuine',
      fpm_fallthrough_skip_reason: 'genuinely_empty',
    });
  });

  test('on: a healthy ingredient lane that found nothing is NOT retried', async () => {
    const off = boot({ mode: 'off', canonical: (index) => ({ rows: index === 0 ? [] : serumRows(8) }) });
    const baseline = await off.invoke({ query: 'niacinamide serum' });
    jest.resetModules();
    const { invoke, calls } = boot({
      mode: 'on',
      canonical: (index) => ({ rows: index === 0 ? [] : serumRows(8) }),
    });
    const { resp, log } = await invoke({ query: 'niacinamide serum' });
    expect(calls.canonical).toBe(1);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(resp.body.metadata.zero_result_fallthrough).toEqual(
      expect.objectContaining({
        empty_reason: 'no_catalog_match',
        empty_class: 'genuine',
        attempted: false,
        skip_reason: 'genuinely_empty',
      }),
    );
    // Products and every field but the new metadata block are exactly the off answer.
    const { zero_result_fallthrough: _block, ...metadataWithoutBlock } = resp.body.metadata;
    expect(normalize({ ...resp.body, metadata: metadataWithoutBlock })).toEqual(normalize(baseline.resp.body));
    expect(log.fpm_fallthrough_skip_reason).toBe('genuinely_empty');
    expect(log.fpm_empty_class).toBe('genuine');
  });

  test('on: an errored ingredient lane is retried on the beauty mainline', async () => {
    const { invoke, calls } = boot({
      mode: 'on',
      canonical: (index) => (index === 0 ? broken() : { rows: serumRows(8) }),
    });
    const { resp, log } = await invoke({ query: 'niacinamide serum' });
    expect(resp.status).toBe(200);
    expect(calls.canonical).toBe(2);
    expect(resp.body.metadata.query_source).toBe('agent_products_beauty_external_seed_mainline');
    expect(resp.body.products.length).toBeGreaterThan(0);
    const ids = resp.body.products.map((product) => `${product.merchant_id}::${product.product_id}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(resp.body.metadata.zero_result_fallthrough).toEqual(
      expect.objectContaining({
        mode: 'on',
        from_lane: 'ingredient_direct',
        to_lane: 'beauty_mainline',
        empty_reason: 'lane_error',
        empty_class: 'degraded',
        attempted: true,
        adopted: true,
        outcome: 'adopted',
        relevance_dropped_count: 0,
      }),
    );
    expect(fallthroughLogFields(log)).toEqual(
      expect.objectContaining({
        fpm_lane_chain: 'ingredient_direct>beauty_mainline',
        fpm_fallthrough: 'used',
        fpm_fallthrough_used: true,
        fpm_empty_reason: 'lane_error',
        fpm_empty_class: 'degraded',
        fpm_fallthrough_outcome: 'adopted',
      }),
    );
  });

  test('on: retry rows that do not name the ingredient are dropped, never served', async () => {
    const { invoke, calls } = boot({
      mode: 'on',
      canonical: (index) =>
        index === 0
          ? broken()
          : { rows: [...serumRows(3, 'loose', 'Hydrating Barrier Serum'), ...serumRows(2, 'nia')] },
    });
    const { resp, log } = await invoke({ query: 'niacinamide serum' });
    expect(calls.canonical).toBe(2);
    expect(resp.body.products.length).toBeGreaterThan(0);
    for (const product of resp.body.products) {
      expect(String(product.title || '')).toMatch(/niacinamide/i);
    }
    expect(resp.body.metadata.zero_result_fallthrough.relevance_dropped_count).toBeGreaterThan(0);
    expect(log.fpm_fallthrough_relevance_dropped).toBeGreaterThan(0);
  });

  test('on: a retry whose rows are all irrelevant keeps the honest empty answer', async () => {
    const { invoke, calls } = boot({
      mode: 'on',
      canonical: (index) => (index === 0 ? broken() : { rows: serumRows(4, 'loose', 'Hydrating Barrier Serum') }),
    });
    const { resp, log } = await invoke({ query: 'niacinamide serum' });
    expect(calls.canonical).toBe(2);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(resp.body.metadata.zero_result_fallthrough).toEqual(
      expect.objectContaining({ attempted: true, adopted: false, outcome: 'next_lane_irrelevant' }),
    );
    expect(log.fpm_fallthrough_outcome).toBe('next_lane_irrelevant');
  });

  test('on: the next lane answering empty keeps the original empty answer', async () => {
    const { invoke, calls } = boot({ mode: 'on', canonical: (index) => (index === 0 ? broken() : { rows: [] }) });
    const { resp, log } = await invoke({ query: 'niacinamide serum' });
    expect(calls.canonical).toBe(2);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(resp.body.metadata.zero_result_fallthrough).toEqual(
      expect.objectContaining({ attempted: true, adopted: false, outcome: 'next_lane_empty' }),
    );
    expect(log.fpm_fallthrough).toBe('tried');
    expect(log.fpm_fallthrough_used).toBe(false);
  });

  test('on: a lane that answered rows on a later page is not "empty" and never retries', async () => {
    const { invoke, calls } = boot({ mode: 'on', canonical: () => ({ rows: serumRows(3) }) });
    const { resp } = await invoke({ query: 'niacinamide serum', page: 3, page_size: 10 });
    expect(resp.body.metadata.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(calls.canonical).toBe(1);
    expect(resp.body.metadata.zero_result_fallthrough).toBeUndefined();
  });

  test('on: a top-level safe-empty refusal is not overridden', async () => {
    const off = boot({ mode: 'off' });
    const baseline = await off.invoke({ query: 'retinol' });
    expect(baseline.resp.body.metadata.query_source).toBe('search_quality_contract_v1_safe_empty');
    jest.resetModules();
    const { invoke, calls } = boot({ mode: 'on', canonical: () => ({ rows: serumRows(8) }) });
    const { resp, log } = await invoke({ query: 'retinol' });
    expect(normalize(resp.body)).toEqual(normalize(baseline.resp.body));
    expect(calls.canonical).toBe(0);
    expect(log.fpm_empty_reason).toBe('policy_safe_empty');
    expect(log.fpm_fallthrough_used).toBe(false);
  });

  test('on: a merchant-scoped request is never widened to the cross-merchant mainline', async () => {
    const { invoke, calls } = boot({
      mode: 'on',
      canonical: (index) => (index === 0 ? broken() : { rows: serumRows(8) }),
    });
    const { resp, log } = await invoke({ query: 'niacinamide serum', merchant_id: 'merch_test_1' });
    expect(calls.canonical).toBe(1);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata.zero_result_fallthrough).toEqual(
      expect.objectContaining({ attempted: false, skip_reason: 'merchant_scoped' }),
    );
    expect(log.fpm_fallthrough_skip_reason).toBe('merchant_scoped');
  });

  test('on: a strict catalog surface is never widened', async () => {
    const { invoke, calls } = boot({
      mode: 'on',
      canonical: (index) => (index === 0 ? broken() : { rows: serumRows(8) }),
    });
    const { resp, log } = await invoke({ query: 'niacinamide serum', catalog_surface: 'acp' });
    expect(resp.body.products).toEqual([]);
    expect(calls.canonical).toBe(1);
    expect(log.fpm_fallthrough_skip_reason).toBe('strict_surface');
  });

  test('on: too little budget left skips the fallthrough and adds no latency', async () => {
    const { invoke, calls } = boot({
      mode: 'on',
      env: {
        FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_DEADLINE_MS: '1000',
        FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_MIN_BUDGET_MS: '1000',
      },
      canonical: (index) => (index === 0 ? never() : { rows: serumRows(8) }),
    });
    const { resp, log, elapsedMs } = await invoke({ query: 'niacinamide serum' });
    expect(resp.body.products).toEqual([]);
    expect(calls.canonical).toBe(1);
    expect(log.fpm_empty_reason).toBe('lane_timeout');
    expect(log.fpm_fallthrough_skip_reason).toBe('budget_exhausted');
    // The leg was capped at its floor (500 ms), not left to run its 6 s stage budget.
    expect(elapsedMs).toBeLessThan(1000 + 600);
  });

  test('on: a hung ingredient leg is capped so the mainline answers inside the deadline', async () => {
    const { invoke, calls } = boot({
      mode: 'on',
      env: {
        FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_DEADLINE_MS: '2500',
        FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_MIN_BUDGET_MS: '800',
      },
      canonical: (index) => (index === 0 ? never() : { rows: serumRows(8) }),
    });
    const { resp, log, elapsedMs } = await invoke({ query: 'niacinamide serum' });
    expect(calls.canonical).toBe(2);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.metadata.zero_result_fallthrough).toEqual(
      expect.objectContaining({ empty_reason: 'lane_timeout', adopted: true }),
    );
    expect(log.fpm_fallthrough_used).toBe(true);
    expect(elapsedMs).toBeLessThan(2500 + 600);
  });

  test('on: a slow next lane is cut at the remaining budget and the original answer stands', async () => {
    const { invoke, calls } = boot({
      mode: 'on',
      env: {
        FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_DEADLINE_MS: '2500',
        FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_MIN_BUDGET_MS: '800',
      },
      canonical: () => never(),
    });
    const { resp, log, elapsedMs } = await invoke({ query: 'niacinamide serum' });
    expect(calls.canonical).toBe(2);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(resp.body.metadata.zero_result_fallthrough).toEqual(
      expect.objectContaining({ attempted: true, adopted: false, outcome: 'next_lane_timeout' }),
    );
    expect(log.fpm_fallthrough_outcome).toBe('next_lane_timeout');
    expect(elapsedMs).toBeLessThan(2500 + 600);
  });

  test('on: an empty beauty mainline answer has no next lane and is unchanged', async () => {
    const off = boot({ mode: 'off' });
    const baseline = await off.invoke({ query: 'moisturizer' });
    expect(baseline.resp.body.metadata.query_source).toBe('agent_products_beauty_external_seed_mainline');
    expect(baseline.resp.body.products).toEqual([]);
    jest.resetModules();
    const { invoke, calls } = boot({ mode: 'on' });
    const { resp, log } = await invoke({ query: 'moisturizer' });
    expect(normalize(resp.body)).toEqual(normalize(baseline.resp.body));
    expect(calls.canonical).toBe(1);
    expect(fallthroughLogFields(log)).toEqual({
      fpm_lane_chain: 'beauty_mainline',
      fpm_fallthrough: 'skipped',
      fpm_fallthrough_used: false,
      fpm_empty_reason: 'no_catalog_match',
      fpm_empty_class: 'genuine',
      fpm_fallthrough_skip_reason: 'genuinely_empty',
    });
  });

  test('on: an empty upstream answer has no next lane and is unchanged', async () => {
    const off = boot({ mode: 'off' });
    const baseline = await off.invoke({ query: 'wireless earbuds' });
    expect(baseline.resp.body.metadata.query_source).toBe('agent_products_search');
    jest.resetModules();
    const { invoke } = boot({ mode: 'on' });
    const { resp, log } = await invoke({ query: 'wireless earbuds' });
    expect(normalize(resp.body)).toEqual(normalize(baseline.resp.body));
    expect(log.fpm_lane_chain).toBe('upstream_search');
    expect(['genuine', 'policy']).toContain(log.fpm_empty_class);
    expect(['genuinely_empty', 'refusal']).toContain(log.fpm_fallthrough_skip_reason);
    expect(log.fpm_fallthrough_used).toBe(false);
  });

  test('on: an ingredient lane that answered rows is untouched', async () => {
    const off = boot({ mode: 'off', canonical: () => ({ rows: serumRows(8) }) });
    const baseline = await off.invoke({ query: 'niacinamide serum' });
    expect(baseline.resp.body.products.length).toBeGreaterThan(0);
    jest.resetModules();
    const { invoke, calls } = boot({ mode: 'on', canonical: () => ({ rows: serumRows(8) }) });
    const { resp, log } = await invoke({ query: 'niacinamide serum' });
    expect(calls.canonical).toBe(1);
    expect(normalize(resp.body)).toEqual(normalize(baseline.resp.body));
    expect(fallthroughLogFields(log)).toEqual({});
  });
});
