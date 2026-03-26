const {
  CANONICAL_TO_LEGACY_OPERATION,
  LEGACY_TO_CANONICAL_OPERATION,
} = require('./operationCatalog');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asPlainObject(value) {
  return isPlainObject(value) ? { ...value } : {};
}

function buildContractError(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function withNestedPayload(nestedKey, payload) {
  const root = asPlainObject(payload);
  if (isPlainObject(root[nestedKey])) return root;
  const nestedPayload = { ...root };
  delete nestedPayload.acp_state;
  delete nestedPayload.ap2_state;
  return {
    ...('acp_state' in root ? { acp_state: root.acp_state } : {}),
    ...('ap2_state' in root ? { ap2_state: root.ap2_state } : {}),
    [nestedKey]: nestedPayload,
  };
}

function mapCatalogDetailPayload(payload) {
  const root = asPlainObject(payload);
  if (isPlainObject(root.subject) || isPlainObject(root.product_ref)) return root;

  const product = isPlainObject(root.product) ? root.product : root;
  const merchantId = String(
    product.merchant_id || product.merchantId || root.merchant_id || root.merchantId || '',
  ).trim();
  const productId = String(
    product.product_id || product.productId || root.product_id || root.productId || '',
  ).trim();
  const skuId = String(product.sku_id || product.skuId || root.sku_id || root.skuId || '').trim();

  if (!merchantId || !productId) {
    return root;
  }

  return {
    ...('include' in root ? { include: root.include } : {}),
    ...('options' in root ? { options: root.options } : {}),
    product_ref: {
      merchant_id: merchantId,
      product_id: productId,
    },
    ...(skuId ? { product: { sku_id: skuId } } : {}),
  };
}

function normalizeCanonicalPayload(canonicalOperation, payload) {
  const root = asPlainObject(payload);
  switch (canonicalOperation) {
    case 'catalog.search':
      return isPlainObject(root.search) ? root : { search: root };
    case 'catalog.detail':
      return mapCatalogDetailPayload(root);
    case 'offers.resolve':
      return root;
    case 'quote.preview':
      return withNestedPayload('quote', root);
    case 'order.create':
      return withNestedPayload('order', root);
    case 'payment.submit':
      return withNestedPayload('payment', root);
    case 'payment.confirm':
      if (isPlainObject(root.order) || isPlainObject(root.payment) || isPlainObject(root.status)) return root;
      return {
        order: root,
      };
    case 'order.status':
      return withNestedPayload('status', root);
    case 'after_sales.create':
      return withNestedPayload('status', root);
    default:
      return root;
  }
}

function normalizeV2InvokeRequest(body, { defaultClientChannel = 'shop' } = {}) {
  const root = asPlainObject(body);
  const canonicalOperation = String(root.operation || '').trim();
  if (!canonicalOperation) {
    throw buildContractError('MISSING_OPERATION', 'operation is required');
  }

  const legacyOperation = CANONICAL_TO_LEGACY_OPERATION[canonicalOperation];
  if (!legacyOperation) {
    throw buildContractError(
      'UNSUPPORTED_OPERATION',
      `Unsupported v2 operation: ${canonicalOperation}`,
    );
  }

  const payload = asPlainObject(root.payload);
  const context = asPlainObject(root.context);
  const metadata = {
    ...asPlainObject(root.metadata),
    ...(context.source ? { source: String(context.source) } : {}),
    ...(context.trace_id ? { trace_id: String(context.trace_id) } : {}),
    ...(context.locale ? { locale: String(context.locale) } : {}),
    ...(context.market ? { market: String(context.market) } : {}),
    ...(context.agent_id ? { agent_id: String(context.agent_id) } : {}),
    client_channel: String(context.client_channel || defaultClientChannel || 'shop').trim() || 'shop',
  };

  return {
    canonicalOperation,
    legacyOperation,
    context,
    legacyRequest: {
      operation: legacyOperation,
      payload: normalizeCanonicalPayload(canonicalOperation, payload),
      metadata,
    },
  };
}

function stripErrorBody(body) {
  if (!isPlainObject(body)) return body ?? null;
  const clone = { ...body };
  delete clone.error;
  delete clone.message;
  return Object.keys(clone).length > 0 ? clone : null;
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const target = String(name || '').toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (String(headerName || '').toLowerCase() !== target) continue;
    return value;
  }
  return null;
}

function extractSession(body) {
  const obj = asPlainObject(body);
  const session = isPlainObject(obj.session) ? obj.session : {};
  return {
    commerce_session_id:
      String(
        session.commerce_session_id ||
          obj.commerce_session_id ||
          obj.session_id ||
          obj.quote_id ||
          obj.order_id ||
          '',
      ).trim() || null,
    acp_state: session.acp_state || obj.acp_state || null,
    ap2_state: session.ap2_state || obj.ap2_state || null,
  };
}

function adaptLegacyResponseToV2({
  canonicalOperation,
  legacyOperation,
  response,
  clientChannel = 'shop',
}) {
  const statusCode = Number(response?.statusCode || 0) || 500;
  const body = response?.body;
  const bodyObject = isPlainObject(body) ? body : null;
  const hasStructuredError = Boolean(bodyObject?.error || bodyObject?.code);
  const ok = statusCode < 400 && !hasStructuredError;

  return {
    status: ok ? 'success' : 'error',
    result: ok ? body : null,
    session: ok ? extractSession(bodyObject) : extractSession(bodyObject),
    meta: {
      contract_version: 'v2',
      canonical_operation:
        String(canonicalOperation || LEGACY_TO_CANONICAL_OPERATION[legacyOperation] || '').trim() || null,
      legacy_operation: String(legacyOperation || '').trim() || null,
      client_channel: String(clientChannel || 'shop').trim() || 'shop',
      gateway_request_id: getHeader(response?.headers, 'x-gateway-request-id') || null,
      upstream_request_id: getHeader(response?.headers, 'x-upstream-request-id') || null,
    },
    error: ok
      ? null
      : {
          code:
            String(bodyObject?.error || bodyObject?.code || 'INVOKE_FAILED').trim() || 'INVOKE_FAILED',
          message:
            String(bodyObject?.message || bodyObject?.detail || 'Invoke request failed').trim() ||
            'Invoke request failed',
          status: statusCode,
          details: stripErrorBody(bodyObject),
        },
  };
}

module.exports = {
  CANONICAL_TO_LEGACY_OPERATION,
  LEGACY_TO_CANONICAL_OPERATION,
  adaptLegacyResponseToV2,
  buildContractError,
  normalizeV2InvokeRequest,
};
