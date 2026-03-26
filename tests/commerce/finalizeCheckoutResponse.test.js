const {
  normalizeSubmitPaymentStatus,
  resolveSubmitPaymentContract,
  finalizeCheckoutInvokeResponse,
} = require('../../src/commerce/checkout/finalizeCheckoutResponse');

describe('finalizeCheckoutResponse', () => {
  test('normalizes unknown submit_payment statuses and preserves raw status', () => {
    expect(normalizeSubmitPaymentStatus('queued_for_review')).toEqual({
      payment_status: 'unknown',
      payment_status_raw: 'queued_for_review',
    });
    expect(resolveSubmitPaymentContract({ status: 'queued_for_review' })).toEqual({
      payment_status: 'unknown',
      payment_status_raw: 'queued_for_review',
      confirmation_owner: 'backend',
      requires_client_confirmation: false,
    });
  });

  test('adds resolved offer and merchant ids to preview_quote payloads', () => {
    const result = finalizeCheckoutInvokeResponse({
      operation: 'preview_quote',
      upstreamData: { quote_id: 'quote_1' },
      resolvedOfferId: 'offer_1',
      resolvedMerchantId: 'merchant_1',
    });

    expect(result).toEqual({
      handled: false,
      upstreamData: {
        quote_id: 'quote_1',
        resolved_offer_id: 'offer_1',
        resolved_merchant_id: 'merchant_1',
      },
      checkoutRuntime: null,
    });
  });

  test('adds order_lines to create_order responses when missing', () => {
    const buildOrderLineSnapshots = jest.fn(() => [
      {
        order_id: 'ord_1',
        offer_id: 'offer_1',
        merchant_id: 'merchant_1',
        quantity: 1,
      },
    ]);

    const result = finalizeCheckoutInvokeResponse({
      operation: 'create_order',
      upstreamData: { order_id: 'ord_1' },
      requestBody: {
        order_request: {
          items: [{ offer_id: 'offer_1', quantity: 1 }],
        },
      },
      resolvedOfferId: 'offer_1',
      resolvedMerchantId: 'merchant_1',
      buildOrderLineSnapshots,
    });

    expect(buildOrderLineSnapshots).toHaveBeenCalledWith(
      { items: [{ offer_id: 'offer_1', quantity: 1 }] },
      {
        orderId: 'ord_1',
        resolvedOfferId: 'offer_1',
        resolvedMerchantId: 'merchant_1',
      },
    );
    expect(result.upstreamData).toMatchObject({
      order_id: 'ord_1',
      resolved_offer_id: 'offer_1',
      resolved_merchant_id: 'merchant_1',
      order_lines: [
        {
          order_id: 'ord_1',
          offer_id: 'offer_1',
          merchant_id: 'merchant_1',
          quantity: 1,
        },
      ],
    });
    expect(result.handled).toBe(false);
  });

  test('wraps submit_payment into normalized contract and updates runtime', () => {
    const logger = { info: jest.fn() };

    const result = finalizeCheckoutInvokeResponse({
      operation: 'submit_payment',
      upstreamData: {
        status: 'processing',
        psp: 'stripe',
        client_secret: 'cs_test',
        payment_intent_id: 'pi_123',
      },
      gatewayRequestId: 'req_123',
      logger,
    });

    expect(result.handled).toBe(true);
    expect(result.body).toMatchObject({
      status: 'processing',
      payment_status: 'processing',
      confirmation_owner: 'backend',
      requires_client_confirmation: false,
      psp: 'stripe',
      payment_action: {
        type: 'stripe_client_secret',
        client_secret: 'cs_test',
        url: null,
        raw: null,
      },
      payment: {
        psp: 'stripe',
        client_secret: 'cs_test',
        payment_intent_id: 'pi_123',
        payment_status: 'processing',
        confirmation_owner: 'backend',
        requires_client_confirmation: false,
      },
    });
    expect(result.checkoutRuntime).toEqual({
      checkoutTraceId: 'req_123',
      paymentStatus: 'processing',
      confirmationOwner: 'backend',
      requiresClientConfirmation: false,
    });
    expect(logger.info).toHaveBeenCalledWith(
      {
        gateway_request_id: 'req_123',
        checkout_trace_id: 'req_123',
        payment_status: 'processing',
        confirmation_owner: 'backend',
        requires_client_confirmation: false,
      },
      'submit_payment contract normalized',
    );
  });
});
