/**
 * Zero-result classification on the invoke route (FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH).
 *
 * Measurement only. These tests drive the real route with a mocked database and pin:
 *   - off (default) and every unsupported value (on, true, 1): the answer and the completion log are
 *     exactly as before; an unsupported value logs one warning at startup;
 *   - observe: the same answer as off, no extra database work, and the completion log line names the
 *     lane, why it was empty and the class (degraded / genuine / policy / unclassified);
 *   - observe on an ingredient answer WITH rows: whether its canonical leg ran past the cap a future
 *     retry would need.
 *
 * The classifier itself is unit-tested in tests/find_products_multi_zero_result_fallthrough.node.test.cjs.
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

const LOG_KEYS = [
  'fpm_lane_chain',
  'fpm_empty_reason',
  'fpm_empty_class',
  'fpm_ingredient_leg_ms',
  'fpm_ingredient_leg_over_proposed_cap',
];

describe('find_products_multi zero-result classification', () => {
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
    delete process.env.FPM_INGREDIENT_CANONICAL_STAGE_BUDGET_MS;
    // Any upstream search call answers empty.
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
    const warnings = [];
    const originalInfo = logger.info.bind(logger);
    const originalWarn = logger.warn.bind(logger);
    logger.info = (obj, msg, ...rest) => {
      if (msg === 'invoke request complete') completionLines.push(obj);
      return originalInfo(obj, msg, ...rest);
    };
    logger.warn = (obj, msg, ...rest) => {
      warnings.push(String(msg || ''));
      return originalWarn(obj, msg, ...rest);
    };
    const app = require('../../src/server');
    const invoke = async (search) => {
      const resp = await request(app)
        .post('/agent/shop/v1/invoke')
        .send({ operation: 'find_products_multi', payload: { search: { page: 1, page_size: 10, ...search } } });
      await delay(20);
      return { resp, log: completionLines[completionLines.length - 1] || {} };
    };
    return { invoke, calls, warnings };
  }

  const logFields = (log) => Object.fromEntries(Object.entries(log).filter(([key]) => LOG_KEYS.includes(key)));

  // Same request under off and under `mode`: identical answers, identical database work.
  async function compareWithOff(mode, search, options = {}) {
    const off = boot({ mode: 'off', ...options });
    const baseline = await off.invoke(search);
    const offCalls = off.calls.canonical;
    jest.resetModules();
    const other = boot({ mode, ...options });
    const result = await other.invoke(search);
    expect(normalize(result.resp.body)).toEqual(normalize(baseline.resp.body));
    expect(other.calls.canonical).toBe(offCalls);
    expect(logFields(baseline.log)).toEqual({});
    return { ...result, warnings: other.warnings, offWarnings: off.warnings };
  }

  test('off: an empty ingredient answer is unchanged and the log gains nothing', async () => {
    const { invoke, calls } = boot({ mode: 'off' });
    const { resp, log } = await invoke({ query: 'niacinamide serum' });
    expect(resp.status).toBe(200);
    expect(resp.body.metadata.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata.zero_result_fallthrough).toBeUndefined();
    expect(calls.canonical).toBe(1);
    expect(logFields(log)).toEqual({});
  });

  test('unset and off answer byte-identically (volatile fields aside)', async () => {
    const unset = boot({});
    const a = await unset.invoke({ query: 'niacinamide serum' });
    jest.resetModules();
    const off = boot({ mode: 'off' });
    const b = await off.invoke({ query: 'niacinamide serum' });
    expect(normalize(b.resp.body)).toEqual(normalize(a.resp.body));
  });

  test.each(['on', 'true', '1'])('unsupported value %s runs as off and warns once at startup', async (value) => {
    const { log, warnings, offWarnings } = await compareWithOff(value, { query: 'niacinamide serum' });
    expect(logFields(log)).toEqual({});
    const message = 'FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH has an unsupported value; running as off';
    // Emitted once, when the gateway module loads (the spy is installed before it is required).
    expect(warnings.filter((w) => w === message)).toHaveLength(1);
    expect(offWarnings.filter((w) => w === message)).toHaveLength(0);
  });

  test('observe: a healthy ingredient lane that found nothing is genuine, the answer unchanged', async () => {
    const { log } = await compareWithOff('observe', { query: 'niacinamide serum' });
    expect(logFields(log)).toEqual({
      fpm_lane_chain: 'ingredient_direct',
      fpm_empty_reason: 'no_catalog_match',
      fpm_empty_class: 'genuine',
    });
  });

  test('observe: a timed-out ingredient lane is degraded, the answer unchanged', async () => {
    const { log } = await compareWithOff('observe', { query: 'niacinamide serum' }, {
      env: { FPM_INGREDIENT_CANONICAL_STAGE_BUDGET_MS: '600' },
      canonical: () => never(),
    });
    expect(logFields(log)).toEqual({
      fpm_lane_chain: 'ingredient_direct',
      fpm_empty_reason: 'lane_timeout',
      fpm_empty_class: 'degraded',
    });
  });

  test('observe: an errored ingredient lane is degraded, the answer unchanged', async () => {
    const { log } = await compareWithOff('observe', { query: 'niacinamide serum' }, { canonical: () => broken() });
    expect(logFields(log)).toEqual({
      fpm_lane_chain: 'ingredient_direct',
      fpm_empty_reason: 'lane_error',
      fpm_empty_class: 'degraded',
    });
  });

  test('observe: a safe-empty refusal is policy, the answer unchanged', async () => {
    const { resp, log } = await compareWithOff('observe', { query: 'retinol' });
    expect(resp.body.metadata.query_source).toBe('search_quality_contract_v1_safe_empty');
    expect(logFields(log)).toEqual({
      fpm_lane_chain: 'safe_empty',
      fpm_empty_reason: 'policy_safe_empty',
      fpm_empty_class: 'policy',
    });
  });

  test('observe: an empty beauty mainline answer is classified, the answer unchanged', async () => {
    const { resp, log } = await compareWithOff('observe', { query: 'moisturizer' });
    expect(resp.body.metadata.query_source).toBe('agent_products_beauty_external_seed_mainline');
    expect(logFields(log)).toEqual({
      fpm_lane_chain: 'beauty_mainline',
      fpm_empty_reason: 'no_catalog_match',
      fpm_empty_class: 'genuine',
    });
  });

  test('observe: an empty upstream answer is classified, the answer unchanged', async () => {
    const { resp, log } = await compareWithOff('observe', { query: 'wireless earbuds' });
    expect(resp.body.metadata.query_source).toBe('agent_products_search');
    expect(log.fpm_lane_chain).toBe('upstream_search');
    expect(['policy', 'genuine']).toContain(log.fpm_empty_class);
  });

  test('observe: an ingredient answer with rows reports a fast leg as under the proposed cap', async () => {
    const { resp, log } = await compareWithOff('observe', { query: 'niacinamide serum' }, {
      canonical: () => ({ rows: serumRows(8) }),
    });
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(log.fpm_lane_chain).toBe('ingredient_direct');
    expect(log.fpm_ingredient_leg_over_proposed_cap).toBe(false);
    expect(log.fpm_ingredient_leg_ms).toBeGreaterThanOrEqual(0);
    expect(log.fpm_empty_reason).toBeUndefined();
  });

  test('observe: an ingredient answer with rows reports a slow leg as over the proposed cap', async () => {
    const { resp, log } = await compareWithOff('observe', { query: 'niacinamide serum' }, {
      canonical: async () => {
        await delay(4400);
        return { rows: serumRows(8) };
      },
    });
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(log.fpm_ingredient_leg_over_proposed_cap).toBe(true);
    expect(log.fpm_ingredient_leg_ms).toBeGreaterThanOrEqual(4400);
  }, 30000);
});
