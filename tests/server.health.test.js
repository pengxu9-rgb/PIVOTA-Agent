const request = require('supertest');

async function withEnv(patch, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(patch || {})) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('health endpoints', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('serves /health as an alias of /healthz', async () => {
    const app = require('../src/server');

    const [healthz, health] = await Promise.all([
      request(app).get('/healthz').expect(200),
      request(app).get('/health').expect(200),
    ]);

    expect(healthz.body.ok).toBe(true);
    expect(health.body.ok).toBe(true);
    expect(typeof health.body.api_mode).toBe('string');
    expect(health.body.version?.service).toBe(healthz.body.version?.service);
    expect(health.body.version?.commit).toBe(healthz.body.version?.commit);
  });

  it('returns 404 for deprecated lite health endpoints', async () => {
    const app = require('../src/server');

    await Promise.all([
      request(app).get('/healthz/lite').expect(404),
      request(app).get('/health/lite').expect(404),
    ]);
  });

  it('/healthz/gemini returns strict readiness false when no Gemini keys exist', async () => {
    await withEnv(
      {
        GEMINI_API_KEY: undefined,
        GEMINI_API_KEY_1: undefined,
        GEMINI_API_KEY_2: undefined,
        GEMINI_API_KEY_3: undefined,
        AURORA_SKIN_GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
      },
      async () => {
        jest.resetModules();
        const app = require('../src/server');
        const resp = await request(app).get('/healthz/gemini').expect(200);
        expect(resp.body.ok).toBe(false);
        expect(resp.body.ready).toBe(false);
        expect(Array.isArray(resp.body.reasons)).toBe(true);
        expect(resp.body.reasons.includes('missing_keys')).toBe(true);
      },
    );
  });

  it('/healthz/gemini returns strict readiness true when key exists and circuit is closed', async () => {
    await withEnv(
      {
        GEMINI_API_KEY: 'test_gemini_health_key',
        GOOGLE_API_KEY: undefined,
      },
      async () => {
        jest.resetModules();
        const app = require('../src/server');
        const resp = await request(app).get('/healthz/gemini').expect(200);
        expect(resp.body.ok).toBe(true);
        expect(resp.body.ready).toBe(true);
        expect(Array.isArray(resp.body.reasons)).toBe(true);
        expect(resp.body.reasons.length).toBe(0);
        expect(resp.body.circuit_open).toBe(false);
      },
    );
  });
});
