// The loopback-only network guard goes first, so nothing below can reach a real host.
require('../agent_readiness_eval/_net_guard.cjs');

const http = require('node:http');
const net = require('node:net');
const v8 = require('node:v8');
const vm = require('node:vm');
const nock = require('nock');
const request = require('supertest');

// The retinoid safety context reader is bounded (src/services/retinoidSafetySignal.js) and runs
// only for the product-search operations that use it (RETINOID_SAFETY_CONTEXT_OPERATIONS in
// src/server.js). This suite drives the real /agent/shop/v1/invoke route with large bodies: the
// reader never runs for other operations, stays within a time budget, keeps no long text in its
// cache, and treats an over-limit context as a safety signal (retinoids out), never as silence.

const UPSTREAM = 'http://pivota-upstream.invalid';
const RETINOID_ID = 'budget_lane_retinoid_row';
const PLAIN_ID = 'budget_lane_plain_row';
const ROWS = [
  { id: RETINOID_ID, product_id: RETINOID_ID, merchant_id: 'merch_budget_fixture', title: 'Retinol Night Serum', description: 'Night serum with retinol.', product_type: 'Serum', status: 'published', inventory_quantity: 5, price: 30, currency: 'USD', image_url: 'https://fixture-cdn.invalid/b1.jpg' },
  { id: PLAIN_ID, product_id: PLAIN_ID, merchant_id: 'merch_budget_fixture', title: 'Hyaluronic Hydrating Serum', description: 'Hydrating serum.', product_type: 'Serum', status: 'published', inventory_quantity: 5, price: 20, currency: 'USD', image_url: 'https://fixture-cdn.invalid/b2.jpg' },
];
const ENV_KEYS = ['PIVOTA_API_BASE', 'PIVOTA_API_KEY', 'API_MODE', 'DATABASE_URL', 'FIND_PRODUCTS_MULTI_VECTOR_ENABLED', 'AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED', 'GATEWAY_RATE_LIMIT_ENABLED', 'BEAUTY_RETINOID_SOFT_SAFETY_TIER'];

jest.setTimeout(180000);

describe('retinoid safety context reader: operations, budgets and fail-closed overflow', () => {
  let app;
  let prevEnv;
  const calls = [];
  let actualSignal;
  // When true, the wrapped reader answers without reading the body: the baseline arm of the memory test.
  let readerOff = false;
  // When true, the wrapped reader throws, as a reader bug would.
  let readerThrows = false;

  beforeAll(() => {
    jest.resetModules();
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
    jest.doMock('../../src/db', () => ({ query: async (sql) => (String(sql).includes('COUNT(*)::int AS total') ? { rows: [{ total: 0 }] } : { rows: [] }) }));
    // A lane that never runs the beauty gate (see the safety net route suite), so the response shows
    // what the context reader decided.
    jest.doMock('../../src/services/discoveryFeed', () => {
      const actual = jest.requireActual('../../src/services/discoveryFeed');
      return { ...actual, getDiscoveryFeed: jest.fn(async () => ({ products: ROWS.map((r) => ({ ...r })), total: 2, metadata: {} })) };
    });
    // Count and time every run of the context reader, delegating to the real one.
    jest.doMock('../../src/services/retinoidSafetySignal', () => {
      actualSignal = jest.requireActual('../../src/services/retinoidSafetySignal');
      return {
        ...actualSignal,
        retinoidSafetyClassesForRequestContext: (body, options) => {
          const t = process.hrtime.bigint();
          if (readerThrows) throw new Error('context reader failure (test)');
          const out = readerOff
            ? { classes: [actualSignal.OVER_LIMIT_CLASS], sources: ['over_limit'] }
            : actualSignal.retinoidSafetyClassesForRequestContext(body, options);
          calls.push({ ms: Number(process.hrtime.bigint() - t) / 1e6, classes: out.classes });
          return out;
        },
      };
    });
    app = require('../../src/server');
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

  const post = (operation, payload, metadata = { source: 'search' }) =>
    request(app).post('/agent/shop/v1/invoke').send({ operation, payload, metadata });
  // The same request over a plain loopback TCP socket, not http.request (see the memory test). Reads
  // the whole response until the server closes and resolves to { status, body }.
  const rawPost = (port, operation, payload) => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ operation, payload, metadata: { source: 'search' } }));
    const head = `POST /agent/shop/v1/invoke HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
    const chunks = [];
    const socket = net.connect({ host: '127.0.0.1', port });
    const fail = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(30000, () => fail(new Error('raw loopback request timed out')));
    socket.on('error', fail);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      socket.destroy();
      // The gateway answers with a Content-Length body and closes (Connection: close), so the body is
      // everything after the headers.
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf('\r\n\r\n');
      const status = Number((/^HTTP\/1\.1 (\d{3})/.exec(raw.toString('latin1', 0, split)) || [])[1]);
      const text = raw.subarray(split + 4).toString('utf8');
      try {
        resolve({ status, body: JSON.parse(text) });
      } catch (err) {
        reject(new Error(`raw loopback request: status ${status}, body is not JSON: ${text.slice(0, 200)}`));
      }
    });
    socket.write(head);
    socket.write(body);
  });
  const bigMessages = (mb) => [{ role: 'user', content: 'x'.repeat(mb * 1024 * 1024) }];

  test('operations other than product search never run the reader, whatever the body carries', async () => {
    const before = calls.length;
    for (const operation of ['resolve_product_group', 'find_similar_products', 'products.recommendations', 'resolve_product_candidates']) {
      await post(operation, { messages: bigMessages(5), user_profile: { pregnancy_status: 'pregnant' }, search: { query: 'serum' } });
    }
    expect(calls.length).toBe(before);
  });

  test('find_products_multi runs it once; a 5 MB turn is over the limit, so retinoids are kept out', async () => {
    const before = calls.length;
    const resp = await post('find_products_multi', { messages: bigMessages(5), search: { query: 'serum', page: 1, limit: 10, in_stock_only: true } });
    expect(resp.status).toBe(200);
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1].classes).toEqual([actualSignal.OVER_LIMIT_CLASS]);
    const ids = (resp.body.products || []).map((p) => p.product_id);
    expect(ids).not.toContain(RETINOID_ID);
    expect(ids).toContain(PLAIN_ID);
  });

  test('a wide, deep profile (a million values, under every per-list limit) stops at the node budget and gates', async () => {
    // 6 MB of JSON, under the body limit
    const tree = (width, depth, leaf) => (depth === 0 ? leaf : Array.from({ length: width }, () => tree(width, depth - 1, leaf)));
    const resp = await post('find_products_multi', { user_profile: { pregnancy_status: tree(100, 3, false) }, search: { query: 'serum', page: 1, limit: 10, in_stock_only: true } });
    expect(resp.status).toBe(200);
    const last = calls[calls.length - 1];
    expect(last.classes).toContain(actualSignal.OVER_LIMIT_CLASS);
    expect(last.ms).toBeLessThan(25);
    expect((resp.body.products || []).map((p) => p.product_id)).not.toContain(RETINOID_ID);
  });

  test('a reader that throws fails closed: the request is treated as carrying a signal', async () => {
    readerThrows = true;
    try {
      const resp = await post('find_products_multi', { messages: [{ role: 'user', content: 'I have oily skin' }], search: { query: 'serum', page: 1, limit: 10, in_stock_only: true } });
      expect(resp.status).toBe(200);
      const ids = (resp.body.products || []).map((p) => p.product_id);
      expect(ids).not.toContain(RETINOID_ID);
      expect(ids).toContain(PLAIN_ID);
    } finally {
      readerThrows = false;
    }
  });

  test('200k short turns: over the limit, gated, and read in well under the budget', async () => {
    const turns = Array.from({ length: 200000 }, (_, i) => ({ role: 'user', content: `turn ${i}` }));
    const resp = await post('find_products_multi', { messages: turns, search: { query: 'serum', page: 1, limit: 10, in_stock_only: true } });
    expect(resp.status).toBe(200);
    const last = calls[calls.length - 1];
    expect(last.classes).toEqual([actualSignal.OVER_LIMIT_CLASS]);
    expect(last.ms).toBeLessThan(50);
    expect((resp.body.products || []).map((p) => p.product_id)).not.toContain(RETINOID_ID);
  });

  test('a normal request with a neutral context still serves the retinoid (no false gate)', async () => {
    const resp = await post('find_products_multi', {
      messages: [{ role: 'user', content: 'I have oily skin' }],
      user_profile: { skin_type: 'oily' },
      search: { query: 'serum', page: 1, limit: 10, in_stock_only: true },
    });
    expect(calls[calls.length - 1].classes).toEqual([]);
    expect((resp.body.products || []).map((p) => p.product_id)).toEqual([RETINOID_ID, PLAIN_ID]);
  });

  test('time and memory: 30 distinct 1 MB turns grow what the reader retains by under 3 MB, and it stays within its time budget', async () => {
    let gc = global.gc;
    if (typeof gc !== 'function') {
      v8.setFlagsFromString('--expose-gc');
      gc = vm.runInNewContext('gc');
    }
    // These requests go over a plain TCP socket, not supertest. Through http.request, every request
    // runs over nock 14's MockHttpSocket (@mswjs/interceptors), whose response parser is a global
    // handle until the socket is destroyed, and that parser reaches the request's error listener, whose
    // closure holds supertest's Test._data, the whole payload. So each 1 MB body stayed reachable until
    // socket teardown, about 31 MB in BOTH arms, and the difference between the arms was teardown
    // timing (it reached 18.9 MB on CI shard 4). That was the test client, not the gateway.
    // nock.restore() is not enough: it removes only this file's layer, and any earlier test file in the
    // same jest worker that loaded nock leaves its own patch on the shared http module. The interceptor
    // does not patch net, and the loopback net guard (top of file) still applies to this socket.
    // The reader's share is still measured as the difference from the same 30 requests with the
    // reader answering blind.
    const server = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const batch = async (tag) => {
      for (let i = 0; i < 5; i += 1) expect((await rawPost(port, 'find_products_multi', { messages: [{ role: 'user', content: `warm ${tag} ${i}` }], search: { query: 'serum' } })).status).toBe(200);
      // Each arm also warms up on a 1 MB turn, so one-off growth from the first large body is not
      // counted against the blind arm alone.
      expect((await rawPost(port, 'find_products_multi', { messages: [{ role: 'user', content: `warm ${tag} ${'x'.repeat(1024 * 1024)}` }], search: { query: 'serum' } })).status).toBe(200);
      gc();
      const heapBefore = process.memoryUsage().heapUsed;
      const start = calls.length;
      for (let i = 0; i < 30; i += 1) {
        // A DIFFERENT 1 MB turn every time: a cache keyed by text would keep every one of them.
        const content = `${tag} ${i} ${'x'.repeat(1024 * 1024)}`;
        const resp = await rawPost(port, 'find_products_multi', { messages: [{ role: 'user', content }], search: { query: 'serum', page: 1, limit: 10, in_stock_only: true } });
        expect(resp.status).toBe(200);
        // Over the limit in both arms, so the retinoid is gated out either way.
        const ids = (resp.body.products || []).map((p) => p.product_id);
        expect(ids).not.toContain(RETINOID_ID);
        expect(ids).toContain(PLAIN_ID);
      }
      gc();
      return { retainedMb: (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024), runs: calls.slice(start) };
    };
    let blind;
    let reading;
    try {
      readerOff = true;
      blind = await batch('blind');
      readerOff = false;
      reading = await batch('reading');
    } finally {
      readerOff = false;
      await new Promise((resolve) => server.close(resolve));
    }
    // The blind arm keeps about 1 MB of the 30 MB that went through it (0.77-1.00 MB over 10 runs on
    // Node 20, alone and after a file that loaded nock). If it ever keeps tens of MB again, something
    // is pinning the request bodies, and the difference below means nothing until that is found.
    expect(blind.retainedMb).toBeLessThan(5);
    expect(reading.runs).toHaveLength(30);
    for (const run of reading.runs) {
      expect(run.classes).toEqual([actualSignal.OVER_LIMIT_CLASS]);
      expect(run.ms).toBeLessThan(25);
    }
    // 30 MB of distinct text went through the reader; what it keeps may grow by at most a few MB. The
    // difference was -1.5 to -1.2 MB over 10 runs; a reader that caches every turn makes it about
    // 29 MB, one that caches every fifth turn about 5 MB. A cache capped at a few entries that was
    // already full before the batch does not grow, and is not what this measures.
    expect(reading.retainedMb - blind.retainedMb).toBeLessThan(3);
    const keys = actualSignal._internal.classifyCacheKeys();
    expect(keys.every((k) => k.length <= 256)).toBe(true);
    expect(actualSignal._internal.classifyCacheSize()).toBeLessThanOrEqual(2000);
  });

});
