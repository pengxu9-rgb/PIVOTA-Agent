const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = require('../../src/server');

describe('look-replicator event ingestion', () => {
  test('POST /v1/events/look-replicator accepts valid payload and returns 204', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-events-'));
    process.env.LR_EVENTS_JSONL_SINK_DIR = tmpDir;

    const res = await request(app).post('/v1/events/look-replicator').send({
      event: 'lr_more_opened',
      properties: { market: 'US', locale: 'en-US', moreIds: ['more:prep'], exposureId: 'exp_test_1' },
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
      properties: { market: 'US', locale: 'en-US', candidateId: 'more:prep', rank: 4, isDefault: false },
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
});
