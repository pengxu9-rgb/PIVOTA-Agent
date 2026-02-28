const nock = require('nock');
const request = require('supertest');

describe('submit_payment response contract normalization', () => {
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
            currency: 'EUR',
            payment_method_hint: 'card',
          },
        },
      });
  }

  it('marks processing status as backend-owned even when client_secret is present', async () => {
    nock(API_BASE)
      .post('/agent/v1/payments')
      .reply(200, {
        status: 'processing',
        psp: 'stripe',
        client_secret: 'pi_test_secret',
        payment_intent_id: 'pi_test_123',
      });

    const res = await invokeSubmitPayment();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'processing',
      payment_status: 'processing',
      confirmation_owner: 'backend',
      requires_client_confirmation: false,
      client_secret: 'pi_test_secret',
      payment: {
        payment_status: 'processing',
        confirmation_owner: 'backend',
        requires_client_confirmation: false,
        client_secret: 'pi_test_secret',
        payment_intent_id: 'pi_test_123',
      },
    });
  });

  it('marks requires_action status as client-owned confirmation', async () => {
    nock(API_BASE)
      .post('/agent/v1/payments')
      .reply(200, {
        payment_status: 'requires_action',
        psp: 'stripe',
        payment_action: {
          type: 'redirect_url',
          url: 'https://example.com/3ds',
        },
      });

    const res = await invokeSubmitPayment();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      payment_status: 'requires_action',
      confirmation_owner: 'client',
      requires_client_confirmation: true,
      payment: {
        payment_status: 'requires_action',
        confirmation_owner: 'client',
        requires_client_confirmation: true,
      },
    });
  });

  it('maps unknown statuses to payment_status=unknown and preserves raw status', async () => {
    nock(API_BASE)
      .post('/agent/v1/payments')
      .reply(200, {
        status: 'queued_for_review',
        psp: 'stripe',
      });

    const res = await invokeSubmitPayment();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'queued_for_review',
      payment_status: 'unknown',
      payment_status_raw: 'queued_for_review',
      confirmation_owner: 'backend',
      requires_client_confirmation: false,
      payment: {
        payment_status: 'unknown',
        payment_status_raw: 'queued_for_review',
        confirmation_owner: 'backend',
        requires_client_confirmation: false,
      },
    });
  });
});
