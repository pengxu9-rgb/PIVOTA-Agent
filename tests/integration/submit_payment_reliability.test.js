const nock = require('nock');
const request = require('supertest');

describe('submit_payment reliability', () => {
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
    };
    app = require('../../src/server');
  });

  afterEach(() => {
    nock.cleanAll();
    process.env = { ...ORIGINAL_ENV };
  });

  async function invokeSubmitPayment() {
    return request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'submit_payment',
        payload: {
          payment: {
            order_id: 'ord_001',
            expected_amount: 29,
            currency: 'USD',
            payment_method_hint: 'card',
          },
        },
      });
  }

  it('retries temporary unavailable responses for submit_payment', async () => {
    const scope = nock(API_BASE)
      .post('/agent/v1/payments')
      .reply(503, {
        error: {
          message: 'TEMPORARY_UNAVAILABLE',
        },
      })
      .post('/agent/v1/payments')
      .reply(200, {
        payment_status: 'processing',
        psp: 'stripe',
      });

    const res = await invokeSubmitPayment();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      payment_status: 'processing',
      confirmation_owner: 'backend',
      requires_client_confirmation: false,
      payment: {
        payment_status: 'processing',
        confirmation_owner: 'backend',
        requires_client_confirmation: false,
      },
    });
    expect(scope.isDone()).toBe(true);
  });
});
