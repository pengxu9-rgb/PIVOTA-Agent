#!/usr/bin/env node
/*
 * Validate the manual paid-canary evidence packet before submit_payment can be
 * treated as production-ready.
 *
 * This script does not call the gateway, PSP, or merchant APIs. It checks the
 * signed-off evidence produced by the manual Stripe TEST-mode canary:
 * strict quote/order/pay, same-key replay, PSP dashboard amount, webhook/status,
 * refund cap, and redaction/credential hygiene.
 */

import { readFileSync } from 'node:fs';

const REDACTED = '[REDACTED]';
const PAID_STATUSES = new Set(['paid', 'succeeded', 'success', 'completed', 'settled']);
const PSP_SUCCESS_STATUSES = new Set(['succeeded', 'paid', 'complete', 'completed']);

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

class EvidenceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EvidenceError';
    this.details = details;
  }
}

function parseArgs(argv) {
  const flags = {
    json: false,
    allowLiveRefundEvidence: false,
    input: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--allow-live-refund-evidence') flags.allowLiveRefundEvidence = true;
    else if (arg === '--input') {
      i += 1;
      flags.input = argv[i];
    } else if (!flags.input && !arg.startsWith('--')) {
      flags.input = arg;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usageText());
      process.exit(0);
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }

  if (!flags.input) {
    throw new UsageError('Missing evidence file. Usage: node scripts/validate_paid_canary_evidence.mjs --input evidence.json');
  }
  return flags;
}

function usageText() {
  return [
    'Usage: node scripts/validate_paid_canary_evidence.mjs --input evidence.json [--json]',
    '',
    'Required evidence:',
    '- operator.approver',
    '- environment.psp_mode="test" and deployment ids/shas',
    '- strict_canary quote/order/payment/replay fields',
    '- psp_dashboard amount_minor/currency/status/livemode=false',
    '- replay same-key, original-result, no-extra-charge proof',
    '- webhook/status signed-webhook and paid canonical status',
    '- refund cap and idempotent refund replay proof',
    '- redaction scan and credential hygiene proof',
  ].join('\n');
}

function readEvidence(path) {
  const raw = readFileSync(path, 'utf8');
  const sensitiveHits = scanSensitive(raw);
  if (sensitiveHits.length) {
    throw new EvidenceError('Evidence file contains sensitive-looking values', { sensitive_hits: sensitiveHits });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    throw new EvidenceError('Evidence file is not valid JSON', { parse_error: error?.message || String(error) });
  }
  return body;
}

function scanSensitive(raw) {
  const hits = [];
  const patterns = [
    { name: 'stripe_secret_key', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]+\b/g },
    { name: 'bearer_token', regex: /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
    { name: 'client_secret', regex: /\b[A-Za-z0-9_-]+_secret_[A-Za-z0-9_-]+\b/g },
    { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  ];

  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern.regex)) {
      const token = match[0];
      if (token === REDACTED || token.includes(REDACTED)) continue;
      hits.push({ type: pattern.name, sample: redactSample(token) });
      if (hits.length >= 10) return hits;
    }
  }

  for (const digits of raw.match(/\b(?:\d[ -]?){13,19}\b/g) || []) {
    const normalized = digits.replace(/\D/g, '');
    if (isLikelyCardNumber(normalized)) {
      hits.push({ type: 'pan_like', sample: redactSample(digits) });
      if (hits.length >= 10) return hits;
    }
  }

  return hits;
}

function redactSample(value) {
  const text = String(value);
  if (text.length <= 8) return REDACTED;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function isLikelyCardNumber(value) {
  if (!/^\d{13,19}$/.test(value)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    let digit = Number(value[i]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function requireString(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new EvidenceError(`Missing required string: ${path}`);
  }
  return value.trim();
}

function requireBoolTrue(value, path) {
  if (value !== true) {
    throw new EvidenceError(`Expected ${path}=true`);
  }
  return true;
}

function optionalBool(value) {
  return value === true;
}

function requireMinor(value, path) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  throw new EvidenceError(`Missing safe integer minor-unit amount: ${path}`);
}

function statusIn(value, allowed, path) {
  const status = requireString(value, path).toLowerCase();
  if (!allowed.has(status)) {
    throw new EvidenceError(`Unexpected status for ${path}`, { status, allowed: Array.from(allowed).sort() });
  }
  return status;
}

function validateMode(evidence, flags) {
  const mode = requireString(evidence.environment?.psp_mode, 'environment.psp_mode').toLowerCase();
  const livemode = evidence.psp_dashboard?.livemode;
  if (mode === 'test') {
    if (livemode !== false) {
      throw new EvidenceError('Stripe/PSP dashboard must prove livemode=false for test canary');
    }
    return mode;
  }

  if (!flags.allowLiveRefundEvidence) {
    throw new EvidenceError('Live PSP evidence is refused unless --allow-live-refund-evidence is explicit');
  }

  if (mode !== 'live' || livemode !== true) {
    throw new EvidenceError('Live evidence must set environment.psp_mode="live" and psp_dashboard.livemode=true');
  }
  requireBoolTrue(evidence.live_refund?.refunded, 'live_refund.refunded');
  requireString(evidence.live_refund?.refund_reference, 'live_refund.refund_reference');
  requireString(evidence.live_refund?.approved_by, 'live_refund.approved_by');
  return mode;
}

function validateEvidence(evidence, flags) {
  const checks = [];

  requireString(evidence.operator?.approver, 'operator.approver');
  checks.push('operator');

  const mode = validateMode(evidence, flags);
  requireString(evidence.environment?.gateway_full_sha, 'environment.gateway_full_sha');
  requireString(evidence.environment?.gateway_deployment_id, 'environment.gateway_deployment_id');
  requireString(evidence.environment?.backend_full_sha, 'environment.backend_full_sha');
  requireString(evidence.environment?.backend_deployment_id, 'environment.backend_deployment_id');
  checks.push('environment');

  const quoteId = requireString(evidence.strict_canary?.preview_quote?.quote_id, 'strict_canary.preview_quote.quote_id');
  const orderId = requireString(evidence.strict_canary?.create_order?.order_id, 'strict_canary.create_order.order_id');
  const orderAmount = requireMinor(evidence.strict_canary?.create_order?.amount_minor, 'strict_canary.create_order.amount_minor');
  const orderCurrency = requireString(evidence.strict_canary?.create_order?.currency, 'strict_canary.create_order.currency').toUpperCase();
  checks.push('quote_order');

  requireString(evidence.strict_canary?.submit_payment?.payment_reference, 'strict_canary.submit_payment.payment_reference');
  requireString(evidence.strict_canary?.submit_payment?.idempotency_key, 'strict_canary.submit_payment.idempotency_key');
  const replayRef = requireString(evidence.strict_canary?.submit_payment_replay?.payment_reference, 'strict_canary.submit_payment_replay.payment_reference');
  if (replayRef !== evidence.strict_canary.submit_payment.payment_reference) {
    throw new EvidenceError('submit_payment replay did not return the original payment reference');
  }
  checks.push('strict_pay_replay');

  const pspAmount = requireMinor(evidence.psp_dashboard?.amount_minor, 'psp_dashboard.amount_minor');
  const pspCurrency = requireString(evidence.psp_dashboard?.currency, 'psp_dashboard.currency').toUpperCase();
  statusIn(evidence.psp_dashboard?.status, PSP_SUCCESS_STATUSES, 'psp_dashboard.status');
  requireString(evidence.psp_dashboard?.payment_reference, 'psp_dashboard.payment_reference');
  if (pspAmount !== orderAmount || pspCurrency !== orderCurrency) {
    throw new EvidenceError('PSP dashboard amount/currency does not match locked order amount', {
      order: { amount_minor: orderAmount, currency: orderCurrency },
      psp: { amount_minor: pspAmount, currency: pspCurrency },
    });
  }
  checks.push('psp_dashboard');

  requireBoolTrue(evidence.replay?.same_idempotency_key, 'replay.same_idempotency_key');
  requireBoolTrue(evidence.replay?.returned_original_result, 'replay.returned_original_result');
  requireBoolTrue(evidence.replay?.extra_charge_created === false, 'replay.extra_charge_created=false');
  checks.push('idempotency_replay');

  requireBoolTrue(evidence.webhook_status?.signed_webhook_observed, 'webhook_status.signed_webhook_observed');
  requireString(evidence.webhook_status?.event, 'webhook_status.event');
  requireString(evidence.webhook_status?.signature_header, 'webhook_status.signature_header');
  requireString(evidence.webhook_status?.correlation_field, 'webhook_status.correlation_field');
  statusIn(evidence.webhook_status?.canonical_payment_status, PAID_STATUSES, 'webhook_status.canonical_payment_status');
  checks.push('webhook_status');

  requireBoolTrue(evidence.refund?.refund_cap_enforced, 'refund.refund_cap_enforced');
  requireBoolTrue(evidence.refund?.refund_replay_idempotent, 'refund.refund_replay_idempotent');
  checks.push('refund');

  requireBoolTrue(evidence.redaction?.scan_passed, 'redaction.scan_passed');
  const rotationNeeded = optionalBool(evidence.credential_hygiene?.rotation_needed);
  if (rotationNeeded) {
    requireBoolTrue(evidence.credential_hygiene?.rotation_completed, 'credential_hygiene.rotation_completed');
  } else if (evidence.credential_hygiene?.rotation_needed !== false) {
    throw new EvidenceError('credential_hygiene.rotation_needed must be false, or true with rotation_completed=true');
  }
  checks.push('hygiene');

  return {
    ok: true,
    mode,
    quote_id: quoteId,
    order_id: orderId,
    amount_minor: orderAmount,
    currency: orderCurrency,
    checks,
  };
}

function printResult(result, flags) {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Paid canary evidence PASS (${result.mode}) order=${result.order_id} amount=${result.amount_minor} ${result.currency}`);
  console.log(`Checks: ${result.checks.join(', ')}`);
}

function fail(error) {
  if (error instanceof UsageError) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (error instanceof EvidenceError) {
    console.error(`ERROR: ${error.message}`);
    if (Object.keys(error.details || {}).length) {
      console.error(JSON.stringify(error.details, null, 2));
    }
    process.exitCode = 1;
    return;
  }
  console.error(`ERROR: ${error?.message || String(error)}`);
  process.exitCode = 1;
}

try {
  const flags = parseArgs(process.argv.slice(2));
  const evidence = readEvidence(flags.input);
  printResult(validateEvidence(evidence, flags), flags);
} catch (error) {
  fail(error);
}
