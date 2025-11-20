process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('/agent/shop/v1/invoke gateway', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('forwards allowed operation and returns upstream response', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/find_products', {
        search: { query: 'shoes' },
      })
      .reply(200, {
        products: [{ id: 'p1' }],
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products',
        payload: {
          search: { query: 'shoes' },
        },
      })
      .expect(200);

    expect(res.body).toEqual({ products: [{ id: 'p1' }] });
  });

  it('rejects invalid operation via schema', async () => {
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'hack_me',
        payload: {},
      })
      .expect(400);

    expect(res.body.error).toBe('INVALID_REQUEST');
  });
});
