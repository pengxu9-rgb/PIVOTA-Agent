const request = require('supertest');

const app = require('../../src/server');

describe('look-replicator event ingestion', () => {
  test('POST /v1/events/look-replicator accepts valid payload and returns 204', async () => {
    const res = await request(app).post('/v1/events/look-replicator').send({
      event: 'lr_more_opened',
      properties: { market: 'US', locale: 'en-US', moreIds: ['more:prep'] },
    });
    expect([200, 204]).toContain(res.status);
  });

  test('POST /v1/events/look-replicator rejects invalid payload', async () => {
    const res = await request(app).post('/v1/events/look-replicator').send({ properties: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });
});

