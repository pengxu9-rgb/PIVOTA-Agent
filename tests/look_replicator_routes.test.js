const request = require('supertest');

// The spy must exist before the server is required: lookReplicator/store.js
// destructures `query` from src/db at require time, so a later spy would never
// be seen by the store. jest.spyOn calls through to the real query by default,
// so every other test in this file is unaffected.
const db = require('../src/db');
const realDbQuery = db.query;
const dbQuerySpy = jest.spyOn(db, 'query');

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

  // job_id is a UUID column (004_look_replicator.sql), so in DB mode Postgres
  // rejects a non-UUID id at bind time with 22P02 instead of returning 0 rows.
  // These tests drive that DB path (the suite otherwise runs the in-memory
  // store, where non-UUID ids already miss cleanly): a malformed id must be a
  // 404, not a 500.
  describe('non-UUID ids against the DB-backed store', () => {
    const DB_ENV_KEYS = ['DATABASE_URL', 'SKIP_DB_MIGRATIONS'];
    const savedDbEnv = {};
    const PG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    beforeEach(() => {
      for (const k of DB_ENV_KEYS) savedDbEnv[k] = process.env[k];
      process.env.DATABASE_URL = 'postgres://unused:unused@localhost:5432/unused';
      process.env.SKIP_DB_MIGRATIONS = 'true';
      dbQuerySpy.mockImplementation(async (sql, params) => {
        if (String(sql).includes('job_id = $1') && !PG_UUID_RE.test(String(params?.[0]))) {
          const err = new Error(`invalid input syntax for type uuid: "${params?.[0]}"`);
          err.code = '22P02';
          throw err;
        }
        return { rows: [] };
      });
    });

    afterEach(() => {
      dbQuerySpy.mockImplementation(realDbQuery);
      for (const k of DB_ENV_KEYS) {
        if (savedDbEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedDbEnv[k];
      }
    });

    test('GET /look-jobs/:jobId returns 404 (not 500) for a non-UUID id', async () => {
      const res = await authed(request(app).get('/look-jobs/nonexistent-verify-probe'));
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });

    test('GET /api/look-replicate/jobs/:jobId returns 404 (not 500) for a non-UUID id', async () => {
      const res = await authed(request(app).get('/api/look-replicate/jobs/nonexistent-verify-probe'));
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });

    test('POST /api/look-replicate/shares returns 404 (not 500) for a non-UUID body jobId', async () => {
      const res = await authed(request(app).post('/api/look-replicate/shares')).send({
        jobId: 'nonexistent-verify-probe',
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });

    test('a UUID-shaped miss still 404s through the 0-rows path', async () => {
      const res = await authed(
        request(app).get('/api/look-replicate/jobs/00000000-0000-4000-8000-000000000000'),
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });

    test('GET /api/look-replicate/shares/:shareId misses cleanly (share_id is TEXT, no uuid cast)', async () => {
      const res = await authed(request(app).get('/api/look-replicate/shares/nonexistent-verify-probe'));
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });
  });
});
