const request = require('supertest');

describe('creator categories', () => {
  function getAppWithEnv(env) {
    jest.resetModules();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = String(v);
      }
    }
    // eslint-disable-next-line global-require
    return require('../../src/server');
  }

  test('returns legacy source when DB not configured', async () => {
    const app = getAppWithEnv({
      DATABASE_URL: undefined,
      TAXONOMY_ENABLED: 'true',
      API_MODE: 'MOCK',
      PIVOTA_API_KEY: undefined,
    });
    const res = await request(app).get('/creator/nina-studio/categories?includeCounts=true');
    expect(res.status).toBe(200);
    expect(res.body.creatorId).toBe('nina-studio');
    expect(res.body.source).toBe('legacy');
    expect(Array.isArray(res.body.roots)).toBe(true);
  });

  test('returns 404 for unknown creator', async () => {
    const app = getAppWithEnv({
      DATABASE_URL: undefined,
      TAXONOMY_ENABLED: 'true',
      API_MODE: 'MOCK',
      PIVOTA_API_KEY: undefined,
    });
    const res = await request(app).get('/creator/unknown-creator/categories');
    expect(res.status).toBe(404);
  });
});
