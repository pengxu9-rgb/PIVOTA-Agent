const TEST_API_BASE = 'http://invoke-basic.test';

process.env.PIVOTA_API_BASE = TEST_API_BASE;
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');

jest.setTimeout(15000);

const ENV_PREFIXES_TO_RESTORE = [
  'PROXY_SEARCH_',
  'SEARCH_',
  'UPSTREAM_RETRY_',
  'UPSTREAM_TIMEOUT_',
  'AURORA_BFF_',
];

const EXPLICIT_ENV_KEYS_TO_RESTORE = [
  'API_MODE',
  'DATABASE_URL',
  'PIVOTA_API_BASE',
  'PIVOTA_API_KEY',
  'PIVOTA_BACKEND_BASE_URL',
  'PROMOTIONS_BACKEND_BASE_URL',
  'PROXY_SEARCH_AURORA_API_BASE',
];

function loadServerApp() {
  let app;
  jest.isolateModules(() => {
    app = require('../../src/server');
  });
  return app;
}

function captureRelevantEnv() {
  const snapshot = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      EXPLICIT_ENV_KEYS_TO_RESTORE.includes(key) ||
      ENV_PREFIXES_TO_RESTORE.some((prefix) => key.startsWith(prefix))
    ) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function restoreRelevantEnv(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (
      EXPLICIT_ENV_KEYS_TO_RESTORE.includes(key) ||
      ENV_PREFIXES_TO_RESTORE.some((prefix) => key.startsWith(prefix))
    ) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function clearRelevantEnv() {
  for (const key of Object.keys(process.env)) {
    if (
      EXPLICIT_ENV_KEYS_TO_RESTORE.includes(key) ||
      ENV_PREFIXES_TO_RESTORE.some((prefix) => key.startsWith(prefix))
    ) {
      delete process.env[key];
    }
  }
}

describe('/agent/shop/v1/invoke gateway', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.dontMock('../../src/auroraBff/routes');
    jest.dontMock('../../src/db');
    jest.dontMock('axios');
    if (typeof nock.isActive === 'function' && !nock.isActive()) {
      nock.activate();
    }
    if (typeof nock.abortPendingRequests === 'function') {
      nock.abortPendingRequests();
    }
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => {
      const normalizedHost = String(host || '');
      return (
        normalizedHost.includes('127.0.0.1') ||
        normalizedHost.includes('localhost') ||
        normalizedHost === '::1'
      );
    });

    prevEnv = captureRelevantEnv();
    clearRelevantEnv();

    process.env.PIVOTA_API_BASE = TEST_API_BASE;
    process.env.PIVOTA_API_KEY = 'test-token';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.dontMock('../../src/auroraBff/routes');
    jest.dontMock('../../src/db');
    jest.dontMock('axios');
    if (typeof nock.isActive === 'function' && !nock.isActive()) {
      nock.activate();
    }
    if (typeof nock.abortPendingRequests === 'function') {
      nock.abortPendingRequests();
    }
    nock.cleanAll();
    nock.enableNetConnect();
    jest.resetModules();

    if (!prevEnv) return;
    restoreRelevantEnv(prevEnv);
  });

  it('forwards allowed operation and returns upstream response', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          q &&
          q.query === 'shoes' &&
          // Defaults added by the gateway.
          q.in_stock_only === 'true' &&
          q.limit === '20' &&
          q.offset === '0'
        );
      })
      .reply(200, {
        products: [{ id: 'p1' }],
      });

    const app = loadServerApp();
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products',
        payload: {
          search: { query: 'shoes' },
        },
      })
      .expect(200);

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products[0].id).toBe('p1');
  });

  it('rejects invalid operation via schema', async () => {
    const app = loadServerApp();
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'hack_me',
        payload: {},
      })
      .expect(400);

    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('fails open on upstream timeout-like failures without secondary ReferenceError', async () => {
    const upstreamSearch = nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query(true)
      .reply(504, { error: 'UPSTREAM_TIMEOUT' });

    const app = loadServerApp();
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products',
        payload: {
          search: { query: 'shoes' },
        },
      })
      .expect(200);

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.error).toBeUndefined();
    expect(upstreamSearch.isDone()).toBe(true);
  });

  it('fails open on transport errors without secondary ReferenceError', async () => {
    const upstreamSearch = nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/search')
      .query(true)
      .replyWithError('socket hang up');

    const app = loadServerApp();
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products',
        payload: {
          search: { query: 'shoes' },
        },
      })
      .expect(200);

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.error).toBeUndefined();
    expect(upstreamSearch.isDone()).toBe(true);
  });
});
