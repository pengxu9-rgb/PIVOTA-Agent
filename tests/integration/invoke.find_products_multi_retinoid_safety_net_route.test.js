// The loopback-only network guard goes first, so nothing below can reach a real host.
require('../agent_readiness_eval/_net_guard.cjs');

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const nock = require('nock');
const request = require('supertest');

// The response-level retinoid safety net (applyRetinoidSafetyNetForInvokeResponse in src/server.js),
// proven WIRED through the real /agent/shop/v1/invoke route.
//
// THE SEAM. The beauty discovery lane (metadata.source "search") takes its rows from
// src/services/discoveryFeed and does not run the beauty gate on them, so the net is the only thing
// between those rows and the response. This file replaces that module's getDiscoveryFeed with a
// jest module mock that returns one retinoid row and one plain row. The seam is jest.doMock in THIS
// file and nothing else: src/ carries no seam branch, hook or flag (the last describe block proves
// it, including against the production entrypoint `node src/server.js`).

const REPO = path.resolve(__dirname, '..', '..');
const UPSTREAM = 'http://pivota-upstream.invalid';
const SEAM_RETINOID_ID = 'seam_lane_retinoid_row';
const SEAM_PLAIN_ID = 'seam_lane_plain_row';
const SEAM_ROWS = [
  {
    id: SEAM_RETINOID_ID, product_id: SEAM_RETINOID_ID, merchant_id: 'merch_seam_fixture', title: 'Retinol Night Serum',
    description: 'Night serum with retinol.', product_type: 'Serum', status: 'published', inventory_quantity: 5,
    price: 30, currency: 'USD', image_url: 'https://fixture-cdn.invalid/seam1.jpg',
  },
  {
    id: SEAM_PLAIN_ID, product_id: SEAM_PLAIN_ID, merchant_id: 'merch_seam_fixture', title: 'Hyaluronic Hydrating Serum',
    description: 'Hydrating serum.', product_type: 'Serum', status: 'published', inventory_quantity: 5,
    price: 20, currency: 'USD', image_url: 'https://fixture-cdn.invalid/seam2.jpg',
  },
];
const ENV_KEYS = [
  'PIVOTA_API_BASE', 'PIVOTA_API_KEY', 'API_MODE', 'DATABASE_URL', 'FIND_PRODUCTS_MULTI_VECTOR_ENABLED',
  'AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED', 'GATEWAY_RATE_LIMIT_ENABLED', 'BEAUTY_RETINOID_SOFT_SAFETY_TIER',
];

jest.setTimeout(180000);

// Every product id in every product list of a body.
function productIdsIn(body) {
  const ids = [];
  const walk = (value, depth) => {
    if (depth > 8 || value == null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && !Array.isArray(item) && (item.product_id != null || item.id != null)) {
          ids.push(String(item.product_id ?? item.id));
        }
        walk(item, depth + 1);
      }
      return;
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(body, 0);
  return ids;
}

function loadApp({ seam = true, detectorDown = false } = {}) {
  jest.resetModules();
  jest.doMock('../../src/db', () => ({
    query: async (sql) => (String(sql).includes('COUNT(*)::int AS total') ? { rows: [{ total: 0 }] } : { rows: [] }),
  }));
  if (seam) {
    jest.doMock('../../src/services/discoveryFeed', () => {
      const actual = jest.requireActual('../../src/services/discoveryFeed');
      return {
        ...actual,
        getDiscoveryFeed: jest.fn(async () => ({
          products: SEAM_ROWS.map((row) => ({ ...row })),
          total: SEAM_ROWS.length,
          metadata: { candidate_source: 'seam_lane' },
        })),
      };
    });
  }
  if (detectorDown) {
    // Only the net reads the empty text (for the request context alone), so this throws inside the
    // net and nowhere else.
    jest.doMock('../../src/services/retinoidSafetySignal', () => {
      const actual = jest.requireActual('../../src/services/retinoidSafetySignal');
      return {
        ...actual,
        retinoidSafetyClassesForText: (text, options) => {
          if (text === '') throw new Error('retinoid detector unavailable');
          return actual.retinoidSafetyClassesForText(text, options);
        },
      };
    });
  }
  return require('../../src/server');
}

async function invoke(app, query, { payload = {}, metadata = { source: 'search' }, headers = {} } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      let req = request(app).post('/agent/shop/v1/invoke');
      for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
      const resp = await req.send({
        operation: 'find_products_multi',
        payload: { ...payload, search: { query, page: 1, limit: 10, in_stock_only: true } },
        metadata,
      });
      return resp;
    } catch (err) {
      const reset = err && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || /socket hang up|ETIMEDOUT/.test(String(err.message)));
      if (!reset || attempt >= 2) throw err;
    }
  }
}

let prevEnv;
beforeAll(() => {
  nock.disableNetConnect();
  nock.enableNetConnect((host) => /^(127\.0\.0\.1|\[?::1\]?)(:\d+)?$/.test(String(host || '')));
  prevEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    PIVOTA_API_BASE: UPSTREAM, PIVOTA_API_KEY: 'test_key', API_MODE: 'REAL', DATABASE_URL: 'postgres://fixture-db.invalid/test',
    FIND_PRODUCTS_MULTI_VECTOR_ENABLED: 'false', AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false', GATEWAY_RATE_LIMIT_ENABLED: 'false',
  });
  delete process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER;
  nock(UPSTREAM).persist().get(/.*/).reply(200, { status: 'success', success: true, products: [], total: 0 });
  nock(UPSTREAM).persist().post(/.*/).reply(200, { status: 'success', success: true, products: [], total: 0 });
});
afterAll(() => {
  jest.dontMock('../../src/db');
  jest.dontMock('../../src/services/discoveryFeed');
  jest.dontMock('../../src/services/retinoidSafetySignal');
  jest.resetModules();
  nock.cleanAll();
  nock.enableNetConnect();
  for (const key of ENV_KEYS) {
    if (prevEnv[key] === undefined) delete process.env[key];
    else process.env[key] = prevEnv[key];
  }
});

const HARD_SIGNAL_CASES = [
  { name: 'child word in the query', query: 'serum for kids' },
  { name: 'pregnancy emoji in the query', query: 'serum \u{1F930}' },
  { name: 'pregnancy profile only', query: 'serum', payload: { user_profile: { pregnancy_status: 'pregnant' } } },
  { name: 'earlier turn only', query: 'serum', payload: { messages: [{ role: 'user', content: 'I am breastfeeding' }, { role: 'user', content: 'serum' }] } },
  { name: 'safety flag only', query: 'serum', metadata: { source: 'search', safety_flags: ['pregnancy'] } },
];

describe('the safety net on a lane that never calls the beauty gate (seam on)', () => {
  let app;
  beforeAll(() => {
    app = loadApp({ seam: true });
  });

  test('control: with no signal the seam lane serves both rows, retinoid included', async () => {
    const resp = await invoke(app, 'serum');
    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_source).toBe('beauty_discovery_mainline');
    expect(resp.body.products.map((p) => p.product_id)).toEqual([SEAM_RETINOID_ID, SEAM_PLAIN_ID]);
    expect(resp.body.metadata?.retinoid_safety_net).toBeUndefined();
  });

  test.each(HARD_SIGNAL_CASES)('HARD signal ($name): no retinoid row in any product list; the plain row is still served', async ({ query, payload, metadata }) => {
    const resp = await invoke(app, query, { payload, metadata });
    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_source).toBe('beauty_discovery_mainline');
    const ids = productIdsIn(resp.body);
    expect(ids).not.toContain(SEAM_RETINOID_ID);
    expect(resp.body.products.map((p) => p.product_id)).toEqual([SEAM_PLAIN_ID]);
    expect(resp.body.metadata?.retinoid_safety_net?.removed_count).toBeGreaterThan(0);
    if (typeof resp.body.total === 'number') expect(resp.body.total).toBe(resp.body.products.length);
    // no id list or generated text still points at it
    expect(JSON.stringify(resp.body)).not.toContain(SEAM_RETINOID_ID);
    expect(JSON.stringify(resp.body)).not.toMatch(/Retinol Night Serum/);
  });
});

describe('the debug bundle describes what was served, after the net (seam on)', () => {
  let app;
  let prevAllow;
  beforeAll(() => {
    prevAllow = process.env.SEARCH_DEBUG_BUNDLE_ALLOW_PRIVATE_IP;
    process.env.SEARCH_DEBUG_BUNDLE_ALLOW_PRIVATE_IP = 'true';
    app = loadApp({ seam: true });
  });
  afterAll(() => {
    if (prevAllow === undefined) delete process.env.SEARCH_DEBUG_BUNDLE_ALLOW_PRIVATE_IP;
    else process.env.SEARCH_DEBUG_BUNDLE_ALLOW_PRIVATE_IP = prevAllow;
  });

  test('with a signal: the bundle never lists the removed retinoid row', async () => {
    const resp = await invoke(app, 'serum', { payload: { user_profile: { pregnancy_status: 'pregnant' } }, headers: { 'x-debug': '1' } });
    expect(resp.status).toBe(200);
    expect(resp.body.products.map((p) => p.product_id)).toEqual([SEAM_PLAIN_ID]);
    expect(resp.body.debug_bundle).toBeTruthy();
    expect(JSON.stringify(resp.body.debug_bundle)).not.toContain(SEAM_RETINOID_ID);
    expect(JSON.stringify(resp.body.debug_bundle)).toContain(SEAM_PLAIN_ID);
  });

  test('without a signal: the bundle lists both rows, as before', async () => {
    const resp = await invoke(app, 'serum', { headers: { 'x-debug': '1' } });
    expect(resp.body.products.map((p) => p.product_id)).toEqual([SEAM_RETINOID_ID, SEAM_PLAIN_ID]);
    expect(JSON.stringify(resp.body.debug_bundle)).toContain(SEAM_RETINOID_ID);
  });
});

describe('the net fails closed when its detector throws (seam on, detector down)', () => {
  let app;
  beforeAll(() => {
    app = loadApp({ seam: true, detectorDown: true });
  });

  test.each([...HARD_SIGNAL_CASES, { name: 'no signal', query: 'serum' }])('$name: no product at all, and the body says why', async ({ query, payload, metadata }) => {
    const resp = await invoke(app, query, { payload, metadata });
    expect(resp.status).toBe(200);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.total).toBe(0);
    expect(productIdsIn({ products: resp.body.products })).toEqual([]);
    expect(resp.body.metadata?.retinoid_safety_net).toEqual({ error: true });
  });
});

describe('the seam cannot be reached outside this file', () => {
  const SEAM_STRINGS = [SEAM_RETINOID_ID, SEAM_PLAIN_ID, 'seam_lane'];
  const hostileInputs = [
    { headers: { 'x-test-seam': '1', 'x-jest-mock': 'discoveryFeed', 'x-debug': '1', 'x-test-mode': 'true' } },
    { metadata: { source: 'search', seam: true, test_lane: 'discovery', mock: 'discoveryFeed', debug: true, products: SEAM_ROWS } },
    { payload: { products: SEAM_ROWS, inject_products: SEAM_ROWS, test_products: SEAM_ROWS, mock_products: SEAM_ROWS, seam: true } },
    { payload: { discovery_response: { products: SEAM_ROWS }, discoveryFeed: { products: SEAM_ROWS } } },
  ];

  test('src/ carries no seam: no seam identifier and no mock or test hook anywhere in it', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          expect(entry.name).not.toBe('__mocks__');
          walk(full);
        } else if (/\.(c?js|mjs|ts)$/.test(entry.name)) files.push(full);
      }
    };
    walk(path.join(REPO, 'src'));
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const s of [...SEAM_STRINGS, 'retinoid_safety_net_route', 'jest.doMock', 'jest.mock(']) {
        if (text.includes(s)) throw new Error(`${path.relative(REPO, file)} mentions ${s}`);
      }
    }
  });

  test('in process, without the jest mock, no env, header, metadata or payload field brings the seam rows in', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      for (const nodeEnv of ['test', 'production', 'development', '']) {
        process.env.NODE_ENV = nodeEnv;
        jest.dontMock('../../src/services/discoveryFeed');
        jest.dontMock('../../src/services/retinoidSafetySignal');
        const app = loadApp({ seam: false });
        for (const input of hostileInputs) {
          for (const query of ['serum', 'serum for kids']) {
            const resp = await invoke(app, query, input);
            const ids = productIdsIn(resp.body);
            for (const s of SEAM_STRINGS) expect({ nodeEnv, input: Object.keys(input), query, seam: ids.filter((id) => id.includes(s)) }).toEqual({ nodeEnv, input: Object.keys(input), query, seam: [] });
          }
        }
      }
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });

  // The production entrypoint, the way the Dockerfile CMD and `npm start` run it: `node src/server.js`
  // in its own process, with no jest anywhere. The loopback guard is preloaded into it as well.
  function bootEntrypoint(nodeEnv, port) {
    const env = {
      ...process.env,
      PORT: String(port),
      NODE_OPTIONS: `--require ${path.join(REPO, 'tests/agent_readiness_eval/_net_guard.cjs')}`,
      PIVOTA_API_BASE: UPSTREAM,
      PIVOTA_ENV: 'test',
      GATEWAY_RATE_LIMIT_ENABLED: 'false',
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
    };
    delete env.DATABASE_URL;
    delete env.JEST_WORKER_ID;
    if (nodeEnv) env.NODE_ENV = nodeEnv;
    else delete env.NODE_ENV;
    const child = spawn(process.execPath, [path.join(REPO, 'src/server.js')], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`entrypoint did not start:\n${log.slice(-2000)}`)), 60000);
      const poll = () => {
        if (/listening on http/.test(log)) {
          clearTimeout(timer);
          resolve();
        } else if (child.exitCode != null) {
          clearTimeout(timer);
          reject(new Error(`entrypoint exited ${child.exitCode}:\n${log.slice(-2000)}`));
        } else setTimeout(poll, 100);
      };
      poll();
    });
    return { child, ready, log: () => log };
  }

  function post(port, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, path: '/agent/shop/v1/invoke', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } },
        (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => resolve({ status: res.statusCode, text }));
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  }

  test.each(['production', 'test', ''])('the production entrypoint (NODE_ENV=%s) never serves the seam rows, whatever the request says', async (nodeEnv) => {
    const port = 39000 + Math.floor(Math.random() * 2000);
    const booted = bootEntrypoint(nodeEnv, port);
    try {
      await booted.ready;
      let answered = 0;
      const statuses = new Set();
      for (const input of hostileInputs) {
        for (const query of ['serum', 'serum for kids']) {
          const resp = await post(port, {
            operation: 'find_products_multi',
            payload: { ...(input.payload || {}), search: { query, page: 1, limit: 10, in_stock_only: true } },
            metadata: input.metadata || { source: 'search' },
          }, input.headers || {});
          answered += 1;
          statuses.add(resp.status);
          let body = null;
          try { body = JSON.parse(resp.text); } catch (_) { body = null; }
          const ids = body ? productIdsIn(body) : [];
          for (const s of SEAM_STRINGS) expect({ nodeEnv, status: resp.status, query, seam: ids.filter((id) => id.includes(s)) }).toEqual({ nodeEnv, status: resp.status, query, seam: [] });
        }
      }
      expect(answered).toBe(hostileInputs.length * 2);
      // The entrypoint really answered the invoke route (not a boot error page).
      for (const status of statuses) expect([200, 401, 403]).toContain(status);
      process.stdout.write(`entrypoint NODE_ENV=${nodeEnv || '(unset)'} invoke statuses: ${[...statuses].join(',')}\n`);
    } finally {
      booted.child.kill('SIGKILL');
    }
  });
});
