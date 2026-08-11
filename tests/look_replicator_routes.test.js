const request = require('supertest');

const app = require('../src/server');

// The legacy /look-jobs lane serves a canned demo fixture (no real pipeline), so it
// is dark by default (501) and only opens with LOOK_REPLICATOR_ALLOW_MOCK_JOBS=true
// in a non-production environment. Auth fails closed (503) when no key is configured.
describe('look replicator routes', () => {
  const KEY = 'test_look_key';
  const AUTH_ENV_KEYS = [
    'LOOK_REPLICATOR_API_KEY',
    'LOOK_REPLICATOR_BACKEND_API_KEY',
    'PIVOTA_API_KEY',
    'PIVOTA_AGENT_API_KEY',
  ];
  const MANAGED_ENV_KEYS = [...AUTH_ENV_KEYS, 'LOOK_REPLICATOR_ALLOW_MOCK_JOBS', 'RAILWAY_ENVIRONMENT'];
  const savedEnv = {};

  beforeAll(() => {
    for (const k of MANAGED_ENV_KEYS) savedEnv[k] = process.env[k];
  });

  beforeEach(() => {
    for (const k of MANAGED_ENV_KEYS) delete process.env[k];
    process.env.LOOK_REPLICATOR_API_KEY = KEY;
    process.env.LOOK_REPLICATOR_ALLOW_MOCK_JOBS = 'true';
  });

  afterAll(() => {
    for (const k of MANAGED_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const authed = (req) => req.set('Authorization', `Bearer ${KEY}`);

  test('fails closed (503) when no look-replicator API key is configured', async () => {
    for (const k of AUTH_ENV_KEYS) delete process.env[k];
    const res = await request(app)
      .post('/look-jobs')
      .send({ market: 'NA', locale: 'en', referenceImageUrl: 'https://example.com/a.jpg' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('LOOK_REPLICATOR_AUTH_UNCONFIGURED');
  });

  test('rejects a missing/wrong token (401) when a key is configured', async () => {
    const res = await request(app)
      .post('/look-jobs')
      .send({ market: 'NA', locale: 'en', referenceImageUrl: 'https://example.com/a.jpg' });
    expect(res.status).toBe(401);
  });

  test('POST /look-jobs is 501 LOOK_JOBS_DISABLED without the mock opt-in flag', async () => {
    delete process.env.LOOK_REPLICATOR_ALLOW_MOCK_JOBS;
    const res = await authed(request(app).post('/look-jobs')).send({
      market: 'NA',
      locale: 'en',
      referenceImageUrl: 'https://example.com/a.jpg',
    });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('LOOK_JOBS_DISABLED');
  });

  test('the mock opt-in flag is refused in a production-like environment', async () => {
    process.env.RAILWAY_ENVIRONMENT = 'production';
    const res = await authed(request(app).post('/look-jobs')).send({
      market: 'NA',
      locale: 'en',
      referenceImageUrl: 'https://example.com/a.jpg',
    });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('LOOK_JOBS_DISABLED');
  });

  test('POST /look-jobs rejects missing referenceImageUrl', async () => {
    const res = await authed(request(app).post('/look-jobs')).send({ market: 'NA', locale: 'en' });
    expect(res.status).toBe(400);
  });

  test('POST /look-jobs creates a job and GET returns it (mock lane, dev opt-in)', async () => {
    const create = await authed(request(app).post('/look-jobs')).send({
      market: 'NA',
      locale: 'en',
      referenceImageUrl: 'https://example.com/a.jpg',
    });
    expect(create.status).toBe(200);
    expect(create.body.jobId).toBeTruthy();

    const jobId = create.body.jobId;
    const get = await authed(request(app).get(`/look-jobs/${jobId}`));
    expect(get.status).toBe(200);
    expect(get.body.jobId).toBe(jobId);
    expect(['pending', 'processing', 'completed', 'failed']).toContain(get.body.status);
  });
});
