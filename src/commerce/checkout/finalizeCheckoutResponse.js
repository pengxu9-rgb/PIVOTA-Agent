const {
  buildOrderLineSnapshots: buildOrderLineSnapshotsBase,
} = require('../shared/orderLineSnapshots');

const BACKEND_OWNED_PAYMENT_STATUSES = new Set([
  'processing',
  'paid',
  'completed',
  'succeeded',
]);
const CLIENT_OWNED_PAYMENT_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
]);

function normalizeSubmitPaymentStatus(rawStatus) {
  const statusString =
    typeof rawStatus === 'string'
      ? rawStatus.trim()
      : rawStatus != null
        ? String(rawStatus).trim()
        : '';
  if (!statusString) {
    return {
      payment_status: 'unknown',
      payment_status_raw: null,
    };
  }
  const normalized = statusString.toLowerCase();
  if (
    BACKEND_OWNED_PAYMENT_STATUSES.has(normalized) ||
    CLIENT_OWNED_PAYMENT_STATUSES.has(normalized)
  ) {
    return {
      payment_status: normalized,
      payment_status_raw: null,
    };
  }
  return {
    payment_status: 'unknown',
    payment_status_raw: statusString,
  };
}

function resolveSubmitPaymentContract(upstreamPayload = {}) {
  const topLevelStatus =
    upstreamPayload.payment_status != null
      ? upstreamPayload.payment_status
      : upstreamPayload.status;
  const nestedStatus =
    upstreamPayload?.payment?.payment_status != null
      ? upstreamPayload.payment.payment_status
      : upstreamPayload?.payment?.status;
  const statusCandidate = topLevelStatus != null ? topLevelStatus : nestedStatus;
  const normalizedStatus = normalizeSubmitPaymentStatus(statusCandidate);
  const isClientOwned = CLIENT_OWNED_PAYMENT_STATUSES.has(normalizedStatus.payment_status);
  return {
    payment_status: normalizedStatus.payment_status,
    payment_status_raw: normalizedStatus.payment_status_raw,
    confirmation_owner: isClientOwned ? 'client' : 'backend',
    requires_client_confirmation: isClientOwned,
  };
}

function finalizeCheckoutInvokeResponse({
  operation,
  upstreamData,
  requestBody,
  resolvedOfferId,
  resolvedMerchantId,
  gatewayRequestId,
  buildOrderLineSnapshots = buildOrderLineSnapshotsBase,
  logger,
} = {}) {
  let finalized = upstreamData;

  if (
    (operation === 'preview_quote' || operation === 'create_order') &&
    resolvedOfferId &&
    finalized &&
    typeof finalized === 'object' &&
    !Array.isArray(finalized)
  ) {
    finalized = {
      ...finalized,
      resolved_offer_id: resolvedOfferId,
      ...(resolvedMerchantId ? { resolved_merchant_id: resolvedMerchantId } : {}),
    };
  }

  if (
    operation === 'create_order' &&
    finalized &&
    typeof finalized === 'object' &&
    !Array.isArray(finalized)
  ) {
    const normalizedOrderRequest =
      requestBody && requestBody.order_request ? requestBody.order_request : requestBody;
    if (normalizedOrderRequest && !finalized.order_lines) {
      const orderLines = buildOrderLineSnapshots(normalizedOrderRequest, {
        orderId: finalized.order_id || finalized.orderId || null,
        resolvedOfferId,
        resolvedMerchantId,
      });
      if (orderLines.length) {
        finalized = {
          ...finalized,
          order_lines: orderLines,
        };
      }
    }
  }

  if (operation !== 'submit_payment') {
    return {
      handled: false,
      upstreamData: finalized,
      checkoutRuntime: null,
    };
  }

  const paymentPayload =
    finalized && typeof finalized === 'object' && !Array.isArray(finalized) ? finalized : {};
  const paymentObj =
    paymentPayload.payment &&
    typeof paymentPayload.payment === 'object' &&
    !Array.isArray(paymentPayload.payment)
      ? paymentPayload.payment
      : {};
  const psp =
    paymentPayload.psp ||
    paymentPayload.psp_used ||
    paymentObj.psp ||
    paymentObj.psp_used ||
    null;

  let paymentAction =
    paymentPayload.payment_action ||
    paymentObj.payment_action ||
    null;

  if (!paymentAction) {
    if (psp === 'adyen' && paymentPayload.client_secret) {
      paymentAction = {
        type: 'adyen_session',
        client_secret: paymentPayload.client_secret,
        url: null,
        raw: null,
      };
    } else if (psp === 'stripe' && paymentPayload.client_secret) {
      paymentAction = {
        type: 'stripe_client_secret',
        client_secret: paymentPayload.client_secret,
        url: null,
        raw: null,
      };
    } else if (paymentPayload.next_action && paymentPayload.next_action.redirect_url) {
      paymentAction = {
        type: 'redirect_url',
        client_secret: paymentPayload.client_secret || null,
        url: paymentPayload.next_action.redirect_url,
        raw: null,
      };
    }
  }

  const paymentContract = resolveSubmitPaymentContract(paymentPayload);
  const wrapped = {
    ...paymentPayload,
    payment_status: paymentContract.payment_status,
    confirmation_owner: paymentContract.confirmation_owner,
    requires_client_confirmation: paymentContract.requires_client_confirmation,
    ...(paymentContract.payment_status_raw
      ? { payment_status_raw: paymentContract.payment_status_raw }
      : {}),
    psp: psp || null,
    payment_action: paymentAction || null,
    payment: {
      ...paymentObj,
      psp: psp || null,
      client_secret: paymentPayload.client_secret || paymentObj.client_secret || null,
      payment_intent_id:
        paymentPayload.payment_intent_id || paymentObj.payment_intent_id || null,
      payment_action: paymentAction || null,
      payment_status: paymentContract.payment_status,
      confirmation_owner: paymentContract.confirmation_owner,
      requires_client_confirmation: paymentContract.requires_client_confirmation,
      ...(paymentContract.payment_status_raw
        ? { payment_status_raw: paymentContract.payment_status_raw }
        : {}),
    },
  };

  if (logger && typeof logger.info === 'function') {
    logger.info(
      {
        gateway_request_id: gatewayRequestId,
        checkout_trace_id: gatewayRequestId,
        payment_status: paymentContract.payment_status,
        confirmation_owner: paymentContract.confirmation_owner,
        requires_client_confirmation: paymentContract.requires_client_confirmation,
      },
      'submit_payment contract normalized',
    );
  }

  return {
    handled: true,
    body: wrapped,
    upstreamData: finalized,
    checkoutRuntime: {
      checkoutTraceId: gatewayRequestId,
      paymentStatus: paymentContract.payment_status,
      confirmationOwner: paymentContract.confirmation_owner,
      requiresClientConfirmation: paymentContract.requires_client_confirmation,
    },
  };
}

module.exports = {
  normalizeSubmitPaymentStatus,
  resolveSubmitPaymentContract,
  finalizeCheckoutInvokeResponse,
};
