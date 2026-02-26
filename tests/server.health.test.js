const request = require('supertest');

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

  it('serves /health/lite as an alias of /healthz/lite', async () => {
    const app = require('../src/server');

    const [healthzLite, healthLite] = await Promise.all([
      request(app).get('/healthz/lite').expect(200),
      request(app).get('/health/lite').expect(200),
    ]);

    expect(healthzLite.body.ok).toBe(true);
    expect(healthLite.body.ok).toBe(true);
    expect(healthLite.body.service).toBe(healthzLite.body.service);
    expect(healthLite.body.commit).toBe(healthzLite.body.commit);
    expect(healthLite.body).not.toHaveProperty('catalog_sync');
  });
});
