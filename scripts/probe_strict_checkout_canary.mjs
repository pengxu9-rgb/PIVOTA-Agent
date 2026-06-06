#!/usr/bin/env node
/*
 * Strict checkout manual canary.
 *
 * This is an operator script, not a model-facing API:
 * - quote/create/pay calls go through POST /agent/shop/v1/invoke.
 * - confirmation_token is minted in-process through the Safety Kernel mount after a trusted
 *   operator/user confirmation step. No public confirmation-mint route is exposed.
 * - --charge is refused unless the operator explicitly declares TEST PSP mode and acknowledges that
 *   remote submit_payment has been enabled for the canary window.
 *
 * Required for real runs:
 *   PROBE_BASE, PROBE_KEY, PROBE_MERCHANT_ID, PROBE_PRODUCT_ID
 *   STRICT_CANARY_USER_REF, STRICT_CANARY_ACP_SESSION_ID
 *   STRICT_CANARY_ALLOW_CREATE_ORDER=1 for --create-order
 *   STRICT_CANARY_ALLOW_CHARGE=1 STRICT_CANARY_PSP_MODE=test
 *   STRICT_CANARY_CHARGE_CONFIRM=yes STRICT_CANARY_REMOTE_PAY_ENABLED_ACK=1 for --charge
 *
 * For controlled test-identity windows, set STRICT_CANARY_SEND_TEST_IDENTITY=1 and enable
 * AGENT_CHECKOUT_ALLOW_TEST_IDENTITY=1 on the target gateway only for the window.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const INVOKE_PATH = '/agent/shop/v1/invoke';
const REDACTED = '[REDACTED]';

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

class CanaryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CanaryError';
    this.details = details;
  }
}

function parseArgs(argv) {
  const flags = {
    createOrder: false,
    charge: false,
    dryRun: false,
    json: false,
    noReplay: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--create-order') flags.createOrder = true;
    else if (arg === '--charge') flags.charge = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--no-replay') flags.noReplay = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else throw new UsageError(`Unknown flag: ${arg}`);
  }

  return flags;
}

function usageText() {
  return [
    'Usage: node scripts/probe_strict_checkout_canary.mjs [--create-order] [--charge] [--dry-run] [--json] [--no-replay]',
    '',
    'Default: strict preview_quote only.',
    '--create-order: also create one unpaid backend order artifact.',
    '--charge: also mint a host confirmation token and submit payment. TEST PSP mode only.',
    '--dry-run: print redacted request bodies and exit without network or token minting.',
    '--no-replay: skip same-key submit_payment replay after --charge.',
  ].join('\n');
}

function env(name) {
  const value = process.env[name];
  return value && String(value).trim() ? String(value).trim() : undefined;
}

function boolEnv(name) {
  return /^(1|true|yes|on)$/i.test(env(name) || '');
}

function must(name, { dryRunFallback } = {}) {
  const value = env(name);
  if (value) return value;
  if (dryRunFallback !== undefined) return dryRunFallback;
  throw new UsageError(`Missing required env var: ${name}`);
}

function loadConfig(flags) {
  const dry = flags.dryRun;
  const runId = env('STRICT_CANARY_RUN_ID') || `strict_canary_${Date.now()}_${randomUUID().slice(0, 8)}`;
  return {
    runId,
    base: must('PROBE_BASE', { dryRunFallback: 'https://gateway.example' }),
    key: must('PROBE_KEY', { dryRunFallback: 'ak_live_redacted' }),
    authHeader: env('PROBE_AUTH_HEADER') || 'Authorization',
    merchantId: must('PROBE_MERCHANT_ID', { dryRunFallback: 'merch_probe' }),
    productId: must('PROBE_PRODUCT_ID', { dryRunFallback: 'prod_probe' }),
    variantId: env('PROBE_VARIANT_ID') || (dry ? 'variant_probe' : undefined),
    currency: (env('PROBE_CURRENCY') || 'USD').toUpperCase(),
    quantity: Math.max(1, Number(env('PROBE_QUANTITY') || 1) || 1),
    userRef: must('STRICT_CANARY_USER_REF', { dryRunFallback: 'usr_strict_canary' }),
    acpSessionId: must('STRICT_CANARY_ACP_SESSION_ID', { dryRunFallback: 'acp_strict_canary' }),
    agentId: env('STRICT_CANARY_AGENT_ID'),
    sendTestIdentity: boolEnv('STRICT_CANARY_SEND_TEST_IDENTITY'),
    customerEmail: env('STRICT_CANARY_CUSTOMER_EMAIL') || 'probe@pivota.test',
    customerName: env('STRICT_CANARY_CUSTOMER_NAME') || 'Strict Canary',
    preferredPsp: env('PROBE_PSP'),
    allowTestPsp: boolEnv('PROBE_ALLOW_TEST_PSP'),
    returnUrl: env('PROBE_RETURN_URL') || 'https://pivota.cc/probe/return',
    paymentHandlerType: env('PROBE_PAYMENT_HANDLER_TYPE'),
    paymentHandlerId: env('PROBE_PAYMENT_HANDLER_ID'),
    shipping: {
      recipient_name: env('PROBE_SHIP_NAME') || 'Strict Canary',
      address_line1: env('PROBE_SHIP_ADDRESS1') || '1 Market St',
      address_line2: env('PROBE_SHIP_ADDRESS2'),
      city: env('PROBE_SHIP_CITY') || 'San Francisco',
      state: env('PROBE_SHIP_STATE') || 'CA',
      postal_code: env('PROBE_SHIP_POSTAL') || '94105',
      country: env('PROBE_SHIP_COUNTRY') || 'US',
      phone: env('PROBE_SHIP_PHONE'),
    },
  };
}

function validateSafety(flags) {
  if (flags.charge && !flags.createOrder) {
    throw new UsageError('Refusing --charge without --create-order.');
  }
  if (!flags.dryRun && flags.createOrder && process.env.STRICT_CANARY_ALLOW_CREATE_ORDER !== '1') {
    throw new UsageError('Refusing --create-order unless STRICT_CANARY_ALLOW_CREATE_ORDER=1 is set.');
  }
  if (!flags.dryRun && flags.charge) {
    if (process.env.STRICT_CANARY_ALLOW_CHARGE !== '1') {
      throw new UsageError('Refusing --charge unless STRICT_CANARY_ALLOW_CHARGE=1 is set.');
    }
    if ((env('STRICT_CANARY_PSP_MODE') || '').toLowerCase() !== 'test') {
      throw new UsageError('Refusing --charge unless STRICT_CANARY_PSP_MODE=test is set.');
    }
    if (env('STRICT_CANARY_CHARGE_CONFIRM') !== 'yes') {
      throw new UsageError('Refusing --charge unless STRICT_CANARY_CHARGE_CONFIRM=yes is set.');
    }
    if (process.env.STRICT_CANARY_REMOTE_PAY_ENABLED_ACK !== '1') {
      throw new UsageError('Refusing --charge unless STRICT_CANARY_REMOTE_PAY_ENABLED_ACK=1 is set.');
    }
    if (!process.env.DATABASE_URL || !process.env.CONFIRMATION_SECRET) {
      throw new UsageError('Refusing --charge unless DATABASE_URL and CONFIRMATION_SECRET are available for host-only confirmation minting.');
    }
  }
}

function invokeUrl(base) {
  return `${base.replace(/\/+$/, '')}${INVOKE_PATH}`;
}

function authHeaders(config) {
  if (config.authHeader.toLowerCase() === 'authorization') {
    const value = /^(Bearer|ApiKey|Basic)\s+/i.test(config.key) ? config.key : `Bearer ${config.key}`;
    return { Authorization: value };
  }
  return { [config.authHeader]: config.key };
}

function identityHeaders(config) {
  if (!config.sendTestIdentity) return {};
  return {
    'X-Test-User-Ref': config.userRef,
    'X-Test-Acp-Session-Id': config.acpSessionId,
  };
}

function requestBody(operation, payload) {
  return { operation, payload };
}

function quoteRequest(config) {
  return requestBody('preview_quote', {
    quote: {
      merchant_id: config.merchantId,
      items: [{
        product_id: config.productId,
        ...(config.variantId ? { variant_id: config.variantId } : {}),
        quantity: config.quantity,
      }],
      currency: config.currency,
      customer_email: config.customerEmail,
      shipping_address: shipForQuote(config.shipping),
    },
    metadata: { source: 'strict_checkout_canary', run_id: config.runId },
    context: { channel: 'strict_checkout_canary', request_id: config.runId },
  });
}

function createOrderRequest(config, quoteId, idempotencyKey) {
  return requestBody('create_order', {
    idempotency_key: idempotencyKey,
    order: {
      quote_id: quoteId,
      customer_email: config.customerEmail,
      customer_name: config.customerName,
      shipping_address: shipForOrder(config.shipping),
      ...(config.preferredPsp ? { preferred_psp: config.preferredPsp } : {}),
      metadata: {
        source: 'strict_checkout_canary',
        run_id: config.runId,
        ...(config.allowTestPsp ? { allow_test_psp_surfaces: true } : {}),
      },
    },
    context: { channel: 'strict_checkout_canary', request_id: `${config.runId}:create` },
  });
}

function submitPaymentRequest(config, orderId, expectedAmount, currency, confirmationToken, idempotencyKey) {
  return requestBody('submit_payment', {
    idempotency_key: idempotencyKey,
    confirmation_token: confirmationToken,
    payment: {
      order_id: orderId,
      expected_amount: expectedAmount,
      currency,
      payment_method_hint: 'card',
      return_url: config.returnUrl,
      ...(config.paymentHandlerType ? { payment_handler_type: config.paymentHandlerType } : {}),
      ...(config.paymentHandlerId ? { payment_handler_id: config.paymentHandlerId } : {}),
    },
  });
}

function shipForQuote(shipping) {
  return prune({
    country: shipping.country,
    state: shipping.state,
    city: shipping.city,
    postal_code: shipping.postal_code,
    address1: shipping.address_line1,
    address_line1: shipping.address_line1,
  });
}

function shipForOrder(shipping) {
  return prune({ ...shipping, name: shipping.recipient_name });
}

function prune(value) {
  const out = {};
  for (const [key, child] of Object.entries(value || {})) {
    if (child === undefined || child === null) continue;
    if (typeof child === 'string' && !child.trim()) continue;
    out[key] = child;
  }
  return out;
}

async function invoke(body, config) {
  const response = await fetch(invokeUrl(config.base), {
    method: 'POST',
    headers: {
      ...authHeaders(config),
      ...identityHeaders(config),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }).catch((error) => {
    throw new CanaryError('Network error', {
      operation: body.operation,
      message: redactString(error?.message || String(error)),
    });
  });

  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new CanaryError('Response was not JSON', {
      operation: body.operation,
      status: response.status,
      body: redactValue(text),
      parse_error: redactString(error?.message || String(error)),
    });
  }

  if (!response.ok) {
    throw new CanaryError('HTTP non-2xx response', {
      operation: body.operation,
      status: response.status,
      body: redactValue(parsed),
    });
  }
  return parsed;
}

async function mintConfirmationToken(config, orderId) {
  const app = require('../src/server');
  const mountGetter = app?._debug?.__agentCheckoutStrict?.getCommerceMount;
  if (typeof mountGetter !== 'function') {
    throw new CanaryError('Safety Kernel mount debug hook is not available');
  }
  const commerce = await mountGetter();
  return commerce.mintConfirmation(
    { order_id: orderId },
    {
      user_ref: config.userRef,
      acp_session_id: config.acpSessionId,
      ...(config.agentId ? { agent_id: config.agentId } : {}),
    },
  );
}

function quoteInfo(body) {
  return {
    quote_id: first(body?.quote_id, body?.quote?.quote_id, body?.data?.quote_id),
    currency: first(body?.currency, body?.quote?.currency, body?.data?.currency),
    total: first(
      body?.locked_totals?.total,
      body?.quote?.locked_totals?.total,
      body?.data?.locked_totals?.total,
      body?.amount_total,
    ),
    merchant_of_record: first(body?.merchant_of_record, body?.quote?.merchant_of_record),
  };
}

function orderInfo(body) {
  return {
    order_id: first(body?.order_id, body?.order?.order_id, body?.data?.order_id),
    amount_total: first(body?.amount_total, body?.order?.amount_total, body?.data?.amount_total),
    currency: first(body?.currency, body?.order?.currency, body?.data?.currency),
  };
}

function paymentInfo(body) {
  return {
    payment_id: first(body?.payment_id, body?.payment_intent_id, body?.payment?.payment_id, body?.payment?.payment_intent_id),
    payment_status: first(body?.payment_status, body?.payment?.payment_status, body?.status),
    order_status: first(body?.order_status, body?.order?.status),
    confirmation_owner: first(body?.confirmation_owner, body?.payment?.confirmation_owner),
    requires_client_confirmation: first(body?.requires_client_confirmation, body?.payment?.requires_client_confirmation),
  };
}

function first(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
}

function requireField(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new CanaryError(`Missing ${name} in prior canary response`);
  }
  return value;
}

function redactValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : redactValue(child, seen);
  }
  return out;
}

function isSecretKey(key) {
  return /(authorization|api[-_]?key|client[-_]?secret|secret|ap2[-_]?state|acp[-_]?state|confirmation[-_]?token|checkout[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|(^|[-_])token($|[-_])|password|credential)/i.test(key);
}

function redactString(value) {
  let out = String(value);
  for (const secret of [process.env.PROBE_KEY, process.env.CONFIRMATION_SECRET, process.env.DATABASE_URL]) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  out = out.replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]+/g, REDACTED);
  out = out.replace(/\b[A-Za-z0-9_-]+_secret_[A-Za-z0-9_-]+\b/g, REDACTED);
  out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED);
  out = out.replace(/([?&](?:client_secret|api_key|key|token|secret)=)[^&\s"']+/gi, `$1${REDACTED}`);
  return out;
}

function printJson(value) {
  console.log(JSON.stringify(redactValue(value), null, 2));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usageText());
    return;
  }
  validateSafety(flags);
  const config = loadConfig(flags);

  const createKey = env('STRICT_CANARY_CREATE_IDEMPOTENCY_KEY') || `idem_create_${config.runId}`;
  const payKey = env('STRICT_CANARY_PAY_IDEMPOTENCY_KEY') || `idem_pay_${config.runId}`;
  const previewBody = quoteRequest(config);
  const createBody = createOrderRequest(config, '__QUOTE_ID__', createKey);
  const payBody = submitPaymentRequest(config, '__ORDER_ID__', 1, config.currency, '__HOST_MINTED_CONFIRMATION_TOKEN__', payKey);

  if (flags.dryRun) {
    printJson({
      mode: 'dry_run',
      attempted: {
        preview_quote: true,
        create_order: flags.createOrder,
        submit_payment: flags.charge,
        submit_payment_replay: flags.charge && !flags.noReplay,
      },
      requests: {
        preview_quote: previewBody,
        ...(flags.createOrder ? { create_order: createBody } : {}),
        ...(flags.charge ? { submit_payment: payBody } : {}),
      },
      host_only_confirmation: flags.charge
        ? 'minted in-process via Safety Kernel mount; never exposed as an HTTP route'
        : undefined,
    });
    return;
  }

  const summary = {
    run_id: config.runId,
    base: config.base,
    attempted: {
      preview_quote: true,
      create_order: flags.createOrder,
      submit_payment: flags.charge,
      submit_payment_replay: flags.charge && !flags.noReplay,
    },
    steps: {},
  };

  const preview = await invoke(previewBody, config);
  const q = quoteInfo(preview);
  summary.steps.preview_quote = q;

  if (flags.createOrder) {
    const quoteId = requireField(q.quote_id, 'quote_id');
    const create = await invoke(createOrderRequest(config, quoteId, createKey), config);
    const order = orderInfo(create);
    summary.steps.create_order = order;

    if (flags.charge) {
      const orderId = requireField(order.order_id, 'order_id');
      const amount = Number(requireField(order.amount_total ?? q.total, 'amount_total'));
      const currency = String(requireField(order.currency || q.currency, 'currency')).toUpperCase();
      if (!Number.isSafeInteger(amount)) {
        throw new CanaryError('Expected amount is not a safe integer minor-unit value', { amount });
      }
      const confirmationToken = await mintConfirmationToken(config, orderId);
      const submitBody = submitPaymentRequest(config, orderId, amount, currency, confirmationToken, payKey);
      const payment = await invoke(submitBody, config);
      summary.steps.submit_payment = paymentInfo(payment);

      if (!flags.noReplay) {
        const replay = await invoke(submitBody, config);
        summary.steps.submit_payment_replay = paymentInfo(replay);
      }
    }
  }

  if (flags.json) {
    printJson(summary);
    return;
  }

  console.log(`Strict checkout canary ${config.runId}`);
  console.log(`  preview_quote: quote_id=${summary.steps.preview_quote?.quote_id || '<missing>'} total=${summary.steps.preview_quote?.total ?? '<missing>'} ${summary.steps.preview_quote?.currency || ''}`);
  if (summary.steps.create_order) {
    console.log(`  create_order: order_id=${summary.steps.create_order.order_id || '<missing>'} total=${summary.steps.create_order.amount_total ?? '<missing>'} ${summary.steps.create_order.currency || ''}`);
  }
  if (summary.steps.submit_payment) {
    console.log(`  submit_payment: payment_id=${summary.steps.submit_payment.payment_id || '<missing>'} status=${summary.steps.submit_payment.payment_status || '<missing>'} order_status=${summary.steps.submit_payment.order_status || '<missing>'}`);
  }
  if (summary.steps.submit_payment_replay) {
    console.log(`  replay: payment_id=${summary.steps.submit_payment_replay.payment_id || '<missing>'} status=${summary.steps.submit_payment_replay.payment_status || '<missing>'}`);
  }
}

main().catch((error) => {
  const detail = error instanceof CanaryError ? error.details : {};
  console.error(`${error.name || 'Error'}: ${error.message || String(error)}`);
  if (Object.keys(detail || {}).length) console.error(JSON.stringify(redactValue(detail), null, 2));
  process.exit(error instanceof UsageError ? 2 : 1);
});
