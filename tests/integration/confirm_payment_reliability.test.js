const nock = require('nock');
const request = require('supertest');

describe('confirm_payment reliability', () => {
  const ORIGINAL_ENV = { ...process.env };
  const API_BASE = 'http://localhost:8080';
  let app;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      PIVOTA_API_BASE: API_BASE,
      PIVOTA_API_KEY: 'test-token',
      CHECKOUT_RETRY_BASE_MS: '1',
      CHECKOUT_RETRY_MAX_MS: '1',
      CHECKOUT_RETRY_MAX_ATTEMPTS: '2',
    };
    app = require('../../src/server');
  });

  afterEach(() => {
    nock.cleanAll();
    process.env = { ...ORIGINAL_ENV };
  });

  async function invokeConfirmPayment() {
    return request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'confirm_payment',
        payload: {
          order: {
            order_id: 'ord_001',
          },
        },
      });
  }

  it('retries temporary unavailable responses for confirm_payment', async () => {
    const scope = nock(API_BASE)
      .post('/agent/v1/orders/ord_001/confirm-payment')
      .reply(503, {
        error: {
          message: 'TEMPORARY_UNAVAILABLE',
        },
      })
      .post('/agent/v1/orders/ord_001/confirm-payment')
      .reply(200, {
        order_id: 'ord_001',
        payment_status: 'paid',
      });

    const res = await invokeConfirmPayment();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      order_id: 'ord_001',
      payment_status: 'paid',
    });
    expect(scope.isDone()).toBe(true);
  });

  it('keeps the confirm_payment upstream route unchanged', async () => {
    const scope = nock(API_BASE)
      .post('/agent/v1/orders/ord_001/confirm-payment')
      .reply(200, {
        order_id: 'ord_001',
        status: 'completed',
      });

    const res = await invokeConfirmPayment();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      order_id: 'ord_001',
      status: 'completed',
    });
    expect(scope.isDone()).toBe(true);
  });
});
