const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = require('../../src/server');

describe('look-replicator event ingestion', () => {
  test('OPTIONS /v1/events/look-replicator returns credentialed CORS for look-replicator UI', async () => {
    const res = await request(app)
      .options('/v1/events/look-replicator')
      .set('Origin', 'https://look-replicator.pivota.cc')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect([200, 204]).toContain(res.status);
    expect(res.headers['access-control-allow-origin']).toBe('https://look-replicator.pivota.cc');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('POST /v1/events/look-replicator accepts valid payload and returns 204', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-events-'));
    process.env.LR_EVENTS_JSONL_SINK_DIR = tmpDir;

    const res = await request(app).post('/v1/events/look-replicator').send({
      event: 'lr_more_opened',
      properties: {
        market: 'US',
        locale: 'en-US',
        moreIds: ['more:prep'],
        exposureId: 'exp_test_1',
        experiment: { variantId: 'lr_more_v1', explorationBucket: 0, explorationRate: 0.1 },
      },
    });
    expect([200, 204]).toContain(res.status);

    await new Promise((r) => setTimeout(r, 25));
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    const jsonlPath = path.join(tmpDir, files[0]);
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const row = JSON.parse(lines[lines.length - 1]);
    expect(row.event).toBe('lr_more_opened');
    expect(row.properties.exposureId).toBe('exp_test_1');
    expect(row.properties.missingExperiment).toBeUndefined();
    expect(typeof row.properties.serverReceivedAt).toBe('string');
    expect(typeof row.properties.requestId).toBe('string');
  });

  test('POST /v1/events/look-replicator rejects invalid payload', async () => {
    const res = await request(app).post('/v1/events/look-replicator').send({ properties: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  test('missing exposureId is accepted but flagged', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-events-'));
    process.env.LR_EVENTS_JSONL_SINK_DIR = tmpDir;

    const res = await request(app).post('/v1/events/look-replicator').send({
      event: 'lr_candidate_clicked',
      properties: {
        market: 'US',
        locale: 'en-US',
        candidateId: 'more:prep',
        rank: 4,
        isDefault: false,
        experiment: { variantId: 'lr_more_v1', explorationBucket: 0 },
      },
    });
    expect([200, 204]).toContain(res.status);

    await new Promise((r) => setTimeout(r, 25));
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    const jsonlPath = path.join(tmpDir, files[0]);
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const row = JSON.parse(lines[lines.length - 1]);
    expect(row.event).toBe('lr_candidate_clicked');
    expect(row.properties.missingExposureId).toBe(true);
  });

  test('missing experiment is accepted but flagged', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-events-'));
    process.env.LR_EVENTS_JSONL_SINK_DIR = tmpDir;

    const res = await request(app).post('/v1/events/look-replicator').send({
      event: 'lr_steps_viewed',
      properties: { market: 'US', locale: 'en-US', exposureId: 'exp_test_2', candidateId: 'default:base', rank: 1 },
    });
    expect([200, 204]).toContain(res.status);

    await new Promise((r) => setTimeout(r, 25));
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    const jsonlPath = path.join(tmpDir, files[0]);
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const row = JSON.parse(lines[lines.length - 1]);
    expect(row.event).toBe('lr_steps_viewed');
    expect(row.properties.missingExperiment).toBe(true);
  });

  test('posthog forwarding failures do not block ingestion', async () => {
    process.env.POSTHOG_API_KEY = 'test_key';
    process.env.POSTHOG_HOST = 'https://example.com';

    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => {
      throw new Error('posthog down');
    });

    const res = await request(app).post('/v1/events/look-replicator').send({
      event: 'lr_adjustments_exposed',
      properties: {
        market: 'US',
        locale: 'en-US',
        exposureId: 'exp_test_3',
        experiment: { variantId: 'lr_more_v1', explorationBucket: 1, explorationRate: 0.1 },
        candidates: [{ candidateId: 'default:eye', impressionId: 'imp_1' }],
      },
    });
    expect([200, 204]).toContain(res.status);

    await new Promise((r) => setTimeout(r, 25));
    expect(global.fetch).toHaveBeenCalled();
    const fetchArgs = global.fetch.mock.calls[0];
    const body = JSON.parse(fetchArgs[1].body);
    expect(body.event).toBe('lr_adjustments_exposed');
    expect(body.properties.serverReceivedAt).toBeTruthy();
    expect(body.properties.requestId).toBeTruthy();

    global.fetch = originalFetch;
    delete process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_HOST;
  });
});
