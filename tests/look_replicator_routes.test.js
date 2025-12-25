const request = require('supertest');

const app = require('../src/server');

describe('look replicator routes', () => {
  test('POST /look-jobs rejects missing referenceImageUrl', async () => {
    const res = await request(app).post('/look-jobs').send({ market: 'NA', locale: 'en' });
    expect(res.status).toBe(400);
  });

  test('POST /look-jobs creates a job and GET returns it', async () => {
    const create = await request(app)
      .post('/look-jobs')
      .send({ market: 'NA', locale: 'en', referenceImageUrl: 'https://example.com/a.jpg' });
    expect(create.status).toBe(200);
    expect(create.body.jobId).toBeTruthy();

    const jobId = create.body.jobId;
    const get = await request(app).get(`/look-jobs/${jobId}`);
    expect(get.status).toBe(200);
    expect(get.body.jobId).toBe(jobId);
    expect(['pending', 'processing', 'completed', 'failed']).toContain(get.body.status);
  });
});

