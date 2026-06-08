#!/usr/bin/env node
/*
 * Validate the no-cost operator release-gate evidence packet.
 *
 * This replaces paid GitHub Actions as a release-gate proof only. It does not
 * authorize production submit_payment. The packet must prove clean, SHA-pinned
 * local backend payment-safety tests, closed production flags, no paid charge,
 * and redacted operator evidence.
 */

import { readFileSync } from 'node:fs';

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
  const flags = { json: false, input: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
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
    throw new UsageError('Missing evidence file. Usage: node scripts/validate_operator_release_evidence.mjs --input evidence.json');
  }
  return flags;
}

function usageText() {
  return [
    'Usage: node scripts/validate_operator_release_evidence.mjs --input evidence.json [--json]',
    '',
    'Required evidence:',
    '- operator.approver',
    '- environment gateway/backend SHAs and deployment ids',
    '- production flags proving submit_payment/test identity are closed',
    '- backend clean worktree and SHA-pinned local payment-safety test results',
    '- exact local commands run and pass counts',
    '- GitHub Actions not used as the gate, with billing block acknowledged when relevant',
    '- no paid charge attempted and production_pay_authorized=false',
    '- redaction scan and credential hygiene proof',
  ].join('\n');
}

function readEvidence(path) {
  const raw = readFileSync(path, 'utf8');
  const sensitiveHits = scanSensitive(raw);
  if (sensitiveHits.length) {
    throw new EvidenceError('Evidence file contains sensitive-looking values', { sensitive_hits: sensitiveHits });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new EvidenceError('Evidence file is not valid JSON', { parse_error: error?.message || String(error) });
  }
}

function scanSensitive(raw) {
  const hits = [];
  const patterns = [
    { type: 'stripe_secret_key', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]+\b/g },
    { type: 'agent_api_key', regex: /\bak_(?:live|test)_[A-Za-z0-9_]+\b/g },
    { type: 'bearer_token', regex: /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
    { type: 'client_secret', regex: /\b[A-Za-z0-9_-]+_secret_[A-Za-z0-9_-]+\b/g },
    { type: 'jwt', regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
    { type: 'email', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern.regex)) {
      hits.push({ type: pattern.type, sample: redactSample(match[0]) });
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
  if (text.length <= 8) return '[REDACTED]';
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

function requireSha(value, path) {
  const text = requireString(value, path);
  if (!/^[a-f0-9]{12,40}$/i.test(text)) {
    throw new EvidenceError(`${path} must be a git SHA or SHA prefix`);
  }
  return text;
}

function requireBoolTrue(value, path) {
  if (value !== true) {
    throw new EvidenceError(`Expected ${path}=true`);
  }
}

function requireBoolFalse(value, path) {
  if (value !== false) {
    throw new EvidenceError(`Expected ${path}=false`);
  }
}

function requirePassCount(value, path, minimum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new EvidenceError(`${path} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function requireArray(value, path, minimum) {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new EvidenceError(`${path} must contain at least ${minimum} entries`);
  }
  return value;
}

function requireClosedFlag(value, path) {
  const text = String(value ?? '').trim();
  if (text !== '0' && text.toLowerCase() !== 'false') {
    throw new EvidenceError(`${path} must be closed/off`);
  }
  return text;
}

function validateEvidence(evidence) {
  const checks = [];

  requireString(evidence.operator?.approver, 'operator.approver');
  requireBoolFalse(evidence.production_pay_authorized, 'production_pay_authorized');
  checks.push('operator_authorization');

  const gatewaySha = requireSha(evidence.environment?.gateway_full_sha, 'environment.gateway_full_sha');
  const backendSha = requireSha(evidence.environment?.backend_full_sha, 'environment.backend_full_sha');
  requireString(evidence.environment?.gateway_deployment_id, 'environment.gateway_deployment_id');
  requireString(evidence.environment?.backend_deployment_id, 'environment.backend_deployment_id');
  checks.push('environment');

  requireClosedFlag(evidence.production_flags?.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED, 'production_flags.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED');
  requireClosedFlag(evidence.production_flags?.AGENT_CHECKOUT_ALLOW_TEST_IDENTITY, 'production_flags.AGENT_CHECKOUT_ALLOW_TEST_IDENTITY');
  requireClosedFlag(evidence.production_flags?.AGENT_CHECKOUT_TEST_IDENTITY_WINDOW, 'production_flags.AGENT_CHECKOUT_TEST_IDENTITY_WINDOW');
  checks.push('closed_flags');

  requireBoolTrue(evidence.gateway_gate?.clean_worktree, 'gateway_gate.clean_worktree');
  const gatewayReleaseSha = requireSha(evidence.gateway_gate?.release_source_sha, 'gateway_gate.release_source_sha');
  if (gatewayReleaseSha !== gatewaySha) {
    throw new EvidenceError('gateway_gate.release_source_sha must match environment.gateway_full_sha');
  }
  requireBoolTrue(evidence.gateway_gate?.rollout_guard_passed, 'gateway_gate.rollout_guard_passed');
  requireBoolTrue(evidence.gateway_gate?.money_path_local_passed, 'gateway_gate.money_path_local_passed');
  checks.push('gateway_local_gate');

  requireBoolTrue(evidence.backend_gate?.clean_worktree, 'backend_gate.clean_worktree');
  const releaseSourceSha = requireSha(evidence.backend_gate?.release_source_sha, 'backend_gate.release_source_sha');
  if (releaseSourceSha !== backendSha) {
    throw new EvidenceError('backend_gate.release_source_sha must match environment.backend_full_sha');
  }
  const commands = requireArray(evidence.backend_gate?.commands, 'backend_gate.commands', 2).map(String);
  if (!commands.some((cmd) => /pytest\b/.test(cmd) && /test_stripe_webhook_contract\.py/.test(cmd))) {
    throw new EvidenceError('backend_gate.commands must include the checkout-payment-safety pytest lane');
  }
  if (!commands.some((cmd) => /run_payment_aftercare_gate\.sh/.test(cmd))) {
    throw new EvidenceError('backend_gate.commands must include scripts/run_payment_aftercare_gate.sh');
  }
  requireBoolTrue(evidence.backend_gate?.checkout_payment_safety?.passed, 'backend_gate.checkout_payment_safety.passed');
  const checkoutPassCount = requirePassCount(evidence.backend_gate?.checkout_payment_safety?.pass_count, 'backend_gate.checkout_payment_safety.pass_count', 1);
  requireBoolTrue(evidence.backend_gate?.payment_aftercare?.passed, 'backend_gate.payment_aftercare.passed');
  const aftercarePassCount = requirePassCount(evidence.backend_gate?.payment_aftercare?.pass_count, 'backend_gate.payment_aftercare.pass_count', 1);
  checks.push('backend_local_gate');

  requireBoolFalse(evidence.github_actions?.used_as_release_gate, 'github_actions.used_as_release_gate');
  if (evidence.github_actions?.billing_blocked === true) {
    requireString(evidence.github_actions?.blocked_run_id, 'github_actions.blocked_run_id');
  }
  checks.push('github_actions_bypass');

  requireBoolFalse(evidence.no_money_ops?.submit_payment_enabled, 'no_money_ops.submit_payment_enabled');
  requireBoolFalse(evidence.no_money_ops?.paid_charge_attempted, 'no_money_ops.paid_charge_attempted');
  checks.push('no_money_ops');

  requireBoolTrue(evidence.redaction?.scan_passed, 'redaction.scan_passed');
  if (evidence.credential_hygiene?.rotation_needed === true) {
    requireBoolTrue(evidence.credential_hygiene?.rotation_completed, 'credential_hygiene.rotation_completed');
  } else {
    requireBoolFalse(evidence.credential_hygiene?.rotation_needed, 'credential_hygiene.rotation_needed');
  }
  checks.push('hygiene');

  return {
    ok: true,
    gateway_sha: gatewaySha,
    backend_sha: backendSha,
    checkout_payment_safety_pass_count: checkoutPassCount,
    payment_aftercare_pass_count: aftercarePassCount,
    checks,
  };
}

function printResult(result, flags) {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Operator release evidence PASS backend=${result.backend_sha}`);
  console.log(`Checks: ${result.checks.join(', ')}`);
}

function fail(error) {
  const payload = {
    ok: false,
    error: error?.name || 'Error',
    message: error?.message || String(error),
    details: error?.details || undefined,
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

try {
  const flags = parseArgs(process.argv.slice(2));
  const evidence = readEvidence(flags.input);
  const result = validateEvidence(evidence);
  printResult(result, flags);
} catch (error) {
  fail(error);
}
