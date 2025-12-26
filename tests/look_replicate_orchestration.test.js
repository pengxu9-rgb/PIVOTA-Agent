const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const { LookReplicateResultV0Schema } = require('../src/schemas/lookReplicateResultV0');

function writeTempJpeg() {
  const p = path.join(os.tmpdir(), `pivota-lookrep-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`);
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // minimal JPEG markers
  return p;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForJobDone(app, jobId) {
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i += 1) {
    const res = await request(app).get(`/api/look-replicate/jobs/${jobId}`);
    if (res.status === 200 && (res.body.status === 'done' || res.body.status === 'error')) return res;
    await sleep(50);
  }
  throw new Error('Job did not reach done/error within timeout');
}

describe('look replicator orchestration (US-only)', () => {
  let app;
  const prevApiMode = process.env.API_MODE;

  beforeAll(() => {
    process.env.API_MODE = 'MOCK';
    app = require('../src/server');
  });

  afterAll(() => {
    if (prevApiMode === undefined) delete process.env.API_MODE;
    else process.env.API_MODE = prevApiMode;
  });

  test('POST /api/look-replicate/jobs rejects non-US market', async () => {
    const img = writeTempJpeg();
    try {
      const res = await request(app)
        .post('/api/look-replicate/jobs')
        .field('market', 'NA')
        .field('locale', 'en')
        .attach('referenceImage', img, { filename: 'ref.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('MARKET_NOT_SUPPORTED');
    } finally {
      fs.rmSync(img, { force: true });
    }
  });

  test('POST /api/look-replicate/jobs creates job and pipeline completes', async () => {
    const img = writeTempJpeg();
    try {
      const create = await request(app)
        .post('/api/look-replicate/jobs')
        .field('market', 'US')
        .field('locale', 'en')
        .field('preferenceMode', 'structure')
        .attach('referenceImage', img, { filename: 'ref.jpg', contentType: 'image/jpeg' });

      expect(create.status).toBe(200);
      expect(create.body.jobId).toBeTruthy();

      const jobId = create.body.jobId;
      const done = await waitForJobDone(app, jobId);
      expect(done.status).toBe(200);
      expect(['done', 'error']).toContain(done.body.status);

      if (done.body.status === 'error') {
        throw new Error(`Pipeline failed: ${done.body.error || 'unknown error'}`);
      }

      const parsed = LookReplicateResultV0Schema.parse(done.body.result);
      expect(parsed.market).toBe('US');
      expect(parsed.adjustments).toHaveLength(3);
      expect(parsed.steps.length).toBeGreaterThanOrEqual(8);
      expect(parsed.steps.length).toBeLessThanOrEqual(12);
      expect(parsed.kit).toBeTruthy();

      const shareCreate = await request(app).post('/api/look-replicate/shares').send({ jobId });
      expect(shareCreate.status).toBe(200);
      expect(shareCreate.body.shareId).toBeTruthy();

      const shareId = shareCreate.body.shareId;
      const shareGet = await request(app).get(`/api/look-replicate/shares/${shareId}`);
      expect(shareGet.status).toBe(200);
      expect(shareGet.body.shareId).toBe(shareId);
      expect(shareGet.body.jobId).toBe(jobId);
      LookReplicateResultV0Schema.parse(shareGet.body.result);
    } finally {
      fs.rmSync(img, { force: true });
    }
  });
});

