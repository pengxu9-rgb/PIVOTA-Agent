const request = require('supertest');

describe('server boot with optional modules missing', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.API_MODE = 'REAL';
    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.dontMock('../src/lookReplicator');
    jest.dontMock('../src/auroraBff/routes');
    jest.resetModules();
    delete process.env.API_MODE;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;
    delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
  });

  test('keeps shopping health routes up when aurora/look modules fail to load', async () => {
    jest.doMock('../src/lookReplicator', () => {
      throw new Error("Cannot find module './lookReplicatePipeline'");
    });
    jest.doMock('../src/auroraBff/routes', () => {
      throw new Error("Cannot find module './socialSummaryUserVisible'");
    });

    const app = require('../src/server');
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true }));
  });
});
