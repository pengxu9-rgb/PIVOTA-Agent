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

  it('propagates explicit submit ownership fields from the backend contract', async () => {
    nock(API_BASE)
      .post('/agent/v1/payments')
      .reply(200, {
        payment_status: 'requires_action',
        confirmation_owner: 'client',
        requires_client_confirmation: true,
        psp: 'checkout',
        payment_action: {
          type: 'checkout_session',
          client_secret: 'cko_session_123',
          submit_owner: 'unsupported',
          component_kind: 'checkout_embedded',
          supported_in_shopping_ui: false,
        },
      });

    const res = await invokeSubmitPayment();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      payment_status: 'requires_action',
      confirmation_owner: 'client',
      requires_client_confirmation: true,
      submit_owner: 'unsupported',
      component_kind: 'checkout_embedded',
      supported_in_shopping_ui: false,
      payment_action: {
        type: 'checkout_session',
        submit_owner: 'unsupported',
        component_kind: 'checkout_embedded',
        supported_in_shopping_ui: false,
      },
      payment: {
        confirmation_owner: 'client',
        requires_client_confirmation: true,
        submit_owner: 'unsupported',
        component_kind: 'checkout_embedded',
        supported_in_shopping_ui: false,
      },
    });
  });

  it('fails closed when upstream sends only a partial explicit contract', async () => {
    nock(API_BASE)
      .post('/agent/v1/payments')
      .reply(200, {
        payment_status: 'requires_action',
        psp: 'stripe',
        payment_action: {
          type: 'stripe_client_secret',
          client_secret: 'pi_123_secret_partial',
          submit_owner: 'external_button',
        },
      });

    const res = await invokeSubmitPayment();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      payment_status: 'requires_action',
      confirmation_owner: 'backend',
      requires_client_confirmation: false,
      submit_owner: 'unsupported',
      supported_in_shopping_ui: false,
      payment: {
        payment_status: 'requires_action',
        confirmation_owner: 'backend',
        requires_client_confirmation: false,
        submit_owner: 'unsupported',
        supported_in_shopping_ui: false,
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

  it('normalizes failed statuses to payment_failed terminal state', async () => {
    nock(API_BASE)
      .post('/agent/v1/payments')
      .reply(200, {
        status: 'failed',
        psp: 'stripe',
      });

    const res = await invokeSubmitPayment();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'failed',
      payment_status: 'payment_failed',
      confirmation_owner: 'backend',
      requires_client_confirmation: false,
      payment: {
        payment_status: 'payment_failed',
        confirmation_owner: 'backend',
        requires_client_confirmation: false,
      },
    });
  });

  it('ignores explicit client ownership on terminal payment failure', async () => {
    nock(API_BASE)
      .post('/agent/v1/payments')
      .reply(200, {
        payment_status: 'payment_failed',
        confirmation_owner: 'client',
        requires_client_confirmation: true,
        psp: 'adyen',
        payment_action: {
          type: 'adyen_session',
          client_secret: 'session_123',
          submit_owner: 'component',
          component_kind: 'adyen_dropin',
          supported_in_shopping_ui: true,
        },
      });

    const res = await invokeSubmitPayment();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      payment_status: 'payment_failed',
      confirmation_owner: 'backend',
      requires_client_confirmation: false,
      submit_owner: null,
      component_kind: null,
      payment: {
        payment_status: 'payment_failed',
        confirmation_owner: 'backend',
        requires_client_confirmation: false,
      },
    });
  });

  it('rejects unsupported pivota hosted checkout responses', async () => {
    nock(API_BASE)
      .post('/agent/v1/payments')
      .reply(200, {
        status: 'success',
        checkout_session: {
          checkout_session_id: 'csess_bad_123',
          hosted_url: 'https://checkout.example.com/session/csess_bad_123',
          provider: 'pivota_hosted_checkout',
        },
      });

    const res = await invokeSubmitPayment();
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      error: 'UNSUPPORTED_PAYMENT_SURFACE',
      message:
        'Merchant checkout must return the merchant PSP payment surface. pivota_hosted_checkout is disabled.',
      detail: {
        psp: 'pivota_hosted_checkout',
        checkout_session_id: 'csess_bad_123',
      },
    });
  });
});
