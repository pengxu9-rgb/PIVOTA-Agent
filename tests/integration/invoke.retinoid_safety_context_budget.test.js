// The loopback-only network guard goes first, so nothing below can reach a real host.
require('../agent_readiness_eval/_net_guard.cjs');

const { execFile } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { promisify } = require('node:util');
const nock = require('nock');
const request = require('supertest');

// The retinoid safety context reader is bounded (src/services/retinoidSafetySignal.js) and runs
// only for the product-search operations that use it (RETINOID_SAFETY_CONTEXT_OPERATIONS in
// src/server.js). This suite drives the real /agent/shop/v1/invoke route with large bodies: the
// reader never runs for other operations, stays within a time budget, keeps no long text in its
// cache, and treats an over-limit context as a safety signal (retinoids out), never as silence.

const execFileAsync = promisify(execFile);
const RETENTION_CHILD = path.join(__dirname, '..', '_support', 'retinoidContextReaderRetentionChild.cjs');
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
          const out = actualSignal.retinoidSafetyClassesForRequestContext(body, options);
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
  // The same request over a plain loopback TCP socket, not http.request (see the time and memory test). Reads
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
    // Time and gating: 30 distinct 1 MB turns through the real route. These requests go over a plain TCP
    // socket, not supertest: through http.request every request runs over nock 14's MockHttpSocket
    // (@mswjs/interceptors), which keeps each 1 MB body reachable until socket teardown, and nock.restore()
    // cannot undo an earlier file's patch on the shared http module. The interceptor does not patch net, and
    // the loopback net guard (top of file) still applies to this socket.
    const server = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const start = calls.length;
    try {
      for (let i = 0; i < 30; i += 1) {
        const content = `reading ${i} ${'x'.repeat(1024 * 1024)}`;
        const resp = await rawPost(port, 'find_products_multi', { messages: [{ role: 'user', content }], search: { query: 'serum', page: 1, limit: 10, in_stock_only: true } });
        expect(resp.status).toBe(200);
        const ids = (resp.body.products || []).map((p) => p.product_id);
        expect(ids).not.toContain(RETINOID_ID);
        expect(ids).toContain(PLAIN_ID);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const runs = calls.slice(start);
    expect(runs).toHaveLength(30);
    for (const run of runs) {
      expect(run.classes).toEqual([actualSignal.OVER_LIMIT_CLASS]);
      expect(run.ms).toBeLessThan(25);
    }
    const keys = actualSignal._internal.classifyCacheKeys();
    expect(keys.every((k) => k.length <= 256)).toBe(true);
    expect(actualSignal._internal.classifyCacheSize()).toBeLessThanOrEqual(2000);

    // Memory: measured in a process of its own (tests/_support/retinoidContextReaderRetentionChild.cjs), as the
    // difference between 30 distinct 1 MB request bodies parsed and dropped with the reader off (blind) and the
    // same with the real reader reading each one. Not in this worker: there heapUsed after a forced GC also moves
    // with what earlier tests and files leave, which is released whenever it is released, and with compiled code.
    // On CI shard 4 (2026-11-03) that put the difference at 8.07 MB with the reader keeping nothing (reproduced
    // at 5.55 MB: the blind arm shrank by 5.46 MB). In its own process the difference is 0.03 MB, run after run.
    const { stdout } = await execFileAsync(process.execPath, ['--expose-gc', RETENTION_CHILD], { cwd: path.join(__dirname, '..', '..'), timeout: 60000 });
    const retention = JSON.parse(stdout.trim().split('\n').pop());
    expect(retention.readerRuns).toBe(30);
    expect(retention.overLimitRuns).toBe(30);
    // Each arm holds its last body on the stack, about 1 MB. If the blind arm ever keeps tens of MB, something
    // in the harness is pinning the bodies, and the difference below means nothing until that is found.
    expect(retention.blindMb).toBeLessThan(5);
    // 30 MB of distinct text went through the reader; what it keeps may grow by at most a few MB. A reader that
    // caches every turn makes the difference about 29 MB, one that caches every fifth turn about 5 MB. A cache
    // capped at a few entries that was already full before the batch does not grow, and is not what this measures.
    expect(retention.readingMb - retention.blindMb).toBeLessThan(3);
  });

});
