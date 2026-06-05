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

  async function invokeSubmitPayment(paymentOverrides = {}) {
    return request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'submit_payment',
        payload: {
          payment: {
            order_id: 'ord_001',
            quote_id: 'quote_001',
            expected_amount: 2900,
            currency: 'EUR',
            payment_method_hint: 'card',
            ...paymentOverrides,
          },
        },
      });
  }

  it('requires quote-bound expected_amount before submitting payment', async () => {
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'submit_payment',
        payload: {
          payment: {
            order_id: 'ord_missing_quote',
            currency: 'EUR',
          },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      status: 'failure',
      code: 'expected_amount_required',
      reason: 'expected_amount_required',
    });
  });

  it('marks processing status as backend-owned even when client_secret is present', async () => {
    nock(API_BASE)
      .post('/agent/v1/payments', (body) => {
        return (
          body?.order_id === 'ord_001' &&
          body?.payment_method?.type === 'card' &&
          body?.quote_id === undefined &&
          body?.expected_amount === undefined &&
          body?.return_url === undefined
        );
      })
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

  it('forwards Shop Pay handler selection and preserves delegated redirect contract', async () => {
    nock(API_BASE)
      .post('/agent/v2/payments/checkout-sessions', (body) => {
        return (
          body?.payment_method_hint === 'shop_pay' &&
          body?.payment_handler_id === 'shop_pay' &&
          body?.payment_handler_type === 'dev.shopify.shop_pay' &&
          body?.return_url === 'https://agent.pivota.cc/pay/return'
        );
      })
      .reply(200, {
        payment_status: 'requires_action',
        confirmation_owner: 'client',
        requires_client_confirmation: true,
        psp: 'shop_pay',
        payment_action: {
          type: 'redirect_url',
          url: 'https://merchant.example/checkouts/shop-pay-session',
          submit_owner: 'redirect',
          component_kind: 'shop_pay_checkout',
          supported_in_shopping_ui: true,
        },
        checkout_session: {
          checkout_session_id: 'shop_pay_sess_123',
          provider: 'shop_pay',
          hosted_url: 'https://merchant.example/checkouts/shop-pay-session',
        },
      });

    const res = await invokeSubmitPayment({
      payment_method_hint: 'shop_pay',
      payment_handler_id: 'shop_pay',
      payment_handler_type: 'dev.shopify.shop_pay',
      return_url: 'https://agent.pivota.cc/pay/return',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      payment_status: 'requires_action',
      confirmation_owner: 'client',
      requires_client_confirmation: true,
      psp: 'shop_pay',
      submit_owner: 'redirect',
      component_kind: 'shop_pay_checkout',
      supported_in_shopping_ui: true,
      checkout_session_id: 'shop_pay_sess_123',
      checkout_url: 'https://merchant.example/checkouts/shop-pay-session',
      payment_action: {
        type: 'redirect_url',
        submit_owner: 'redirect',
        component_kind: 'shop_pay_checkout',
        supported_in_shopping_ui: true,
      },
      payment: {
        psp: 'shop_pay',
        checkout_session_id: 'shop_pay_sess_123',
        hosted_url: 'https://merchant.example/checkouts/shop-pay-session',
        submit_owner: 'redirect',
        component_kind: 'shop_pay_checkout',
        supported_in_shopping_ui: true,
      },
    });
  });

  it.each(['shop_pay', 'paypal'])(
    'routes hint-only %s submit_payment through delegated checkout sessions',
    async (paymentMethodHint) => {
      nock(API_BASE)
        .post('/agent/v2/payments/checkout-sessions', (body) => {
          return (
            body?.order_id === 'ord_001' &&
            body?.quote_id === 'quote_001' &&
            body?.expected_amount === 2900 &&
            body?.currency === 'EUR' &&
            body?.payment_method_hint === paymentMethodHint &&
            body?.payment_handler_id === undefined &&
            body?.payment_handler_type === undefined
          );
        })
        .reply(200, {
          payment_status: 'requires_action',
          confirmation_owner: 'client',
          requires_client_confirmation: true,
          psp: paymentMethodHint,
          payment_action: {
            type: 'redirect_url',
            url: `https://merchant.example/checkouts/${paymentMethodHint}`,
            submit_owner: 'redirect',
            component_kind: `${paymentMethodHint}_checkout`,
            supported_in_shopping_ui: true,
          },
          checkout_session: {
            checkout_session_id: `${paymentMethodHint}_sess_hint_only`,
            provider: paymentMethodHint,
            hosted_url: `https://merchant.example/checkouts/${paymentMethodHint}`,
          },
        });

      const res = await invokeSubmitPayment({
        payment_method_hint: paymentMethodHint,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        payment_status: 'requires_action',
        confirmation_owner: 'client',
        requires_client_confirmation: true,
        psp: paymentMethodHint,
        submit_owner: 'redirect',
        checkout_session_id: `${paymentMethodHint}_sess_hint_only`,
        checkout_url: `https://merchant.example/checkouts/${paymentMethodHint}`,
        payment_action: {
          type: 'redirect_url',
          submit_owner: 'redirect',
          supported_in_shopping_ui: true,
        },
      });
      expect(nock.isDone()).toBe(true);
    },
  );

  it.each(['shop_pay', 'paypal'])(
    'routes payment_method.type-only %s submit_payment through delegated checkout sessions',
    async (paymentMethodType) => {
      nock(API_BASE)
        .post('/agent/v2/payments/checkout-sessions', (body) => {
          return (
            body?.order_id === 'ord_001' &&
            body?.quote_id === 'quote_001' &&
            body?.expected_amount === 2900 &&
            body?.currency === 'EUR' &&
            body?.payment_method_hint === undefined &&
            body?.payment_handler_id === undefined &&
            body?.payment_handler_type === undefined
          );
        })
        .reply(200, {
          payment_status: 'requires_action',
          confirmation_owner: 'client',
          requires_client_confirmation: true,
          psp: paymentMethodType,
          payment_action: {
            type: 'redirect_url',
            url: `https://merchant.example/checkouts/${paymentMethodType}-typed`,
            submit_owner: 'redirect',
            component_kind: `${paymentMethodType}_checkout`,
            supported_in_shopping_ui: true,
          },
          checkout_session: {
            checkout_session_id: `${paymentMethodType}_sess_type_only`,
            provider: paymentMethodType,
            hosted_url: `https://merchant.example/checkouts/${paymentMethodType}-typed`,
          },
        });

      const res = await invokeSubmitPayment({
        payment_method_hint: undefined,
        payment_method: {
          type: paymentMethodType,
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        payment_status: 'requires_action',
        confirmation_owner: 'client',
        requires_client_confirmation: true,
        psp: paymentMethodType,
        submit_owner: 'redirect',
        checkout_session_id: `${paymentMethodType}_sess_type_only`,
        checkout_url: `https://merchant.example/checkouts/${paymentMethodType}-typed`,
        payment_action: {
          type: 'redirect_url',
          submit_owner: 'redirect',
          supported_in_shopping_ui: true,
        },
      });
      expect(nock.isDone()).toBe(true);
    },
  );

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

  it('accepts and normalizes an Adyen direct PSP surface with pspReference action data', async () => {
    nock(API_BASE)
      .post('/agent/v1/payments', (body) => {
        return (
          body?.order_id === 'ord_001' &&
          body?.payment_method?.type === 'card' &&
          body?.quote_id === undefined &&
          body?.expected_amount === undefined
        );
      })
      .reply(200, {
        status: 'requires_action',
        payment_id: 'pay_adyen_001',
        psp: 'adyen',
        psp_used: 'adyen',
        pspReference: 'ADYEN_PSP_REF_001',
        resultCode: 'IdentifyShopper',
        action: {
          type: 'threeDS2',
          paymentData: 'adyen_payment_data_001',
        },
      });

    const res = await invokeSubmitPayment();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'requires_action',
      payment_status: 'requires_action',
      confirmation_owner: 'client',
      requires_client_confirmation: true,
      submit_owner: 'component',
      component_kind: 'adyen_dropin',
      supported_in_shopping_ui: true,
      psp: 'adyen',
      pspReference: 'ADYEN_PSP_REF_001',
      payment_action: {
        type: 'adyen_session',
        pspReference: 'ADYEN_PSP_REF_001',
        resultCode: 'IdentifyShopper',
        action: {
          type: 'threeDS2',
          paymentData: 'adyen_payment_data_001',
        },
      },
      payment: {
        psp: 'adyen',
        payment_intent_id: 'ADYEN_PSP_REF_001',
        pspReference: 'ADYEN_PSP_REF_001',
        resultCode: 'IdentifyShopper',
        action: {
          type: 'threeDS2',
          paymentData: 'adyen_payment_data_001',
        },
        payment_status: 'requires_action',
        confirmation_owner: 'client',
        requires_client_confirmation: true,
        submit_owner: 'component',
        component_kind: 'adyen_dropin',
        supported_in_shopping_ui: true,
      },
    });
  });

  it('maps Adyen resultCode=Refused to payment_failed even when upstream status is success', async () => {
    nock(API_BASE)
      .post('/agent/v1/payments')
      .reply(200, {
        status: 'success',
        payment_id: 'pay_adyen_refused',
        psp: 'adyen',
        pspReference: 'ADYEN_PSP_REF_REFUSED',
        resultCode: 'Refused',
      });

    const res = await invokeSubmitPayment();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      payment_status: 'payment_failed',
      confirmation_owner: 'backend',
      requires_client_confirmation: false,
      psp: 'adyen',
      pspReference: 'ADYEN_PSP_REF_REFUSED',
      payment_action: {
        type: 'adyen_session',
        pspReference: 'ADYEN_PSP_REF_REFUSED',
        resultCode: 'Refused',
      },
      payment: {
        payment_status: 'payment_failed',
        confirmation_owner: 'backend',
        requires_client_confirmation: false,
        resultCode: 'Refused',
      },
    });
  });

  it('maps Adyen resultCode=Authorised to paid', async () => {
    nock(API_BASE)
      .post('/agent/v1/payments')
      .reply(200, {
        status: 'success',
        payment_id: 'pay_adyen_authorised',
        psp: 'adyen',
        pspReference: 'ADYEN_PSP_REF_AUTHORISED',
        resultCode: 'Authorised',
      });

    const res = await invokeSubmitPayment();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      payment_status: 'paid',
      confirmation_owner: 'backend',
      requires_client_confirmation: false,
      psp: 'adyen',
      pspReference: 'ADYEN_PSP_REF_AUTHORISED',
      payment_action: {
        type: 'adyen_session',
        pspReference: 'ADYEN_PSP_REF_AUTHORISED',
        resultCode: 'Authorised',
      },
      payment: {
        payment_status: 'paid',
        confirmation_owner: 'backend',
        requires_client_confirmation: false,
        resultCode: 'Authorised',
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

  it('drops prototype-pollution keys from payment_method before direct v1 submit', async () => {
    const maliciousPaymentMethod = JSON.parse(
      '{"type":"card","payment_method_id":"pm_safe_123","__proto__":{"polluted":"yes"},"prototype":{"polluted":"yes"},"constructor":{"polluted":"yes"}}',
    );
    let capturedBody = null;
    expect({}.polluted).toBeUndefined();

    nock(API_BASE)
      .post('/agent/v1/payments', (body) => {
        capturedBody = body;
        return (
          body?.order_id === 'ord_001' &&
          body?.payment_method?.type === 'card' &&
          body?.payment_method?.payment_method_id === 'pm_safe_123' &&
          !Object.prototype.hasOwnProperty.call(body.payment_method, '__proto__') &&
          !Object.prototype.hasOwnProperty.call(body.payment_method, 'prototype') &&
          !Object.prototype.hasOwnProperty.call(body.payment_method, 'constructor')
        );
      })
      .reply(200, {
        status: 'processing',
        psp: 'stripe',
        payment_intent_id: 'pi_proto_safe',
      });

    const res = await invokeSubmitPayment({
      payment_method: maliciousPaymentMethod,
    });

    expect(res.status).toBe(200);
    expect(capturedBody).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(capturedBody.payment_method, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(capturedBody.payment_method, 'prototype')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(capturedBody.payment_method, 'constructor')).toBe(false);
    expect({}.polluted).toBeUndefined();
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
