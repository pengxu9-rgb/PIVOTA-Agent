const nock = require('nock');
const request = require('supertest');

const TEST_API_BASE = 'http://server-recommendations.test';

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
    app = require('../src/server');
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

describe('products.recommendations routing', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.dontMock('../src/auroraBff/routes');
    jest.dontMock('../src/db');
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

    process.env.API_MODE = 'REAL';
    process.env.PIVOTA_API_KEY = 'test_key_for_jest';
    process.env.PIVOTA_API_BASE = TEST_API_BASE;
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.dontMock('../src/auroraBff/routes');
    jest.dontMock('../src/db');
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

  it('forwards products.recommendations to GET /agent/v1/products/recommendations with query params', async () => {
    const merchantId = 'merch_test';
    const platformProductId = 'p123';

    const upstreamScope = nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/recommendations')
      .query((qs) => qs.merchant_id === merchantId && qs.platform_product_id === platformProductId)
      .reply(200, {
        status: 'success',
        merchant_id: merchantId,
        platform_product_id: platformProductId,
        recommendations: [],
      });

    const payload = {
      operation: 'products.recommendations',
      payload: {
        search: {
          merchant_id: merchantId,
          platform_product_id: platformProductId,
        },
      },
    };

    const app = loadServerApp();

    await request(app)
      .post('/agent/shop/v1/invoke')
      .send(payload)
      .expect(200);

    expect(upstreamScope.isDone()).toBe(true);
  });
});
